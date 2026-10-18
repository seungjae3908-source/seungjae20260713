// Long → confirmed-weakness → short flip backtest (research only, no orders).
//
// Owner goal (2026-10-18): catch a surge with a long, take profit, and when the
// move rolls over, switch to a short and take profit again. The existing research
// lanes simulate LONG and SHORT independently with stateless per-bar atoms, so a
// "short only after the long is finished and weakness is confirmed" rule cannot be
// expressed there. This module is a small state machine that can.
//
// Pre-registered rules (fixed before any result; 1h Bitget USDT perpetual candles):
//   LONG entry (signal on the closed bar, fill at the next bar's open)
//     volume >= 3 × mean of the previous 48 bars, close > previous 48-bar high,
//     close > rolling 24-bar VWAP, EMA20 > EMA50, RSI14 < 85,
//     latest known funding rate <= 0.05% (when funding is known),
//     BTC no more than 6% below its 24-bar peak close (regime filter).
//   LONG management
//     stop = close − 2 × ATR14; take half at +1.5R, then stop to entry and a
//     2.5 × ATR trail from the best close; exit at next open on close < EMA50.
//   WATCH (after the long closes, for at most 40 bars; no new long meanwhile)
//     count consecutive bars with close < EMA20 and close < VWAP;
//     SHORT when that count >= 2 and close < previous 10-bar low and
//     (funding >= 0.03% or EMA20 < EMA50).
//   SHORT management: mirror of the long; stop = max(close + 2 × ATR, bar high).
//   Losing trade → 4-bar cooldown.
// Open interest is not used: its history is still accumulating (research-data-factory).
// Intrabar: when stop and target are both touched in one bar, the stop wins.
// Gaps through a stop fill at the open. Data from 2026-01-01 (sealed holdout) is never read.
//
// Variants: LONG_ONLY (baseline), FLIP (the owner rule), FLIP_NO_REGIME.
// Verdict (validation segment = last 40% of the period, all symbols pooled):
//   SHORT_LEG_ADDS_VALUE when short trades >= 30, short ΣR > 0, short PF >= 1.1,
//   FLIP ΣR > LONG_ONLY ΣR, and >= 60% of symbols with shorts gain from the flip.
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const LONG_SHORT_FLIP_CONTRACT_V1 = 'long-short-flip-backtest/v1';
export const LONG_SHORT_FLIP_HOLDOUT_START = Date.UTC(2026, 0, 1);
export const LONG_SHORT_FLIP_DISCOVERY_FRACTION = 0.6;

export const LONG_SHORT_FLIP_RULES_V1 = Object.freeze({
  volumeLookback: 48,
  volumeSpike: 3,
  breakoutLookback: 48,
  vwapBars: 24,
  emaFast: 20,
  emaSlow: 50,
  atrBars: 14,
  rsiBars: 14,
  rsiMax: 85,
  maxLongFunding: 0.0005,
  regimePeakBars: 24,
  regimeMaxDrawdown: 0.06,
  stopAtr: 2,
  takeProfitR: 1.5,
  takeProfitFraction: 0.5,
  trailAtr: 2.5,
  watchBars: 40,
  confirmBars: 2,
  recentLowBars: 10,
  minShortFunding: 0.0003,
  cooldownBars: 4,
});

export const LONG_SHORT_FLIP_COST_V1 = Object.freeze({ feeRate: 0.0006, slippageRate: 0.0005, spreadRate: 0.0002 });
export const LONG_SHORT_FLIP_VARIANTS_V1 = Object.freeze([
  Object.freeze({ id: 'LONG_ONLY', flip: false, regime: true }),
  Object.freeze({ id: 'FLIP', flip: true, regime: true }),
  Object.freeze({ id: 'FLIP_NO_REGIME', flip: true, regime: false }),
]);
export const LONG_SHORT_FLIP_VERDICT_V1 = Object.freeze({
  minShortTrades: 30, minShortProfitFactor: 1.1, minSymbolBreadth: 0.6,
});

const SAFETY = Object.freeze({
  researchOnly: true,
  finalHoldoutUsed: false,
  paperRegistrationAllowed: false,
  liveTrading: false,
  autoTrading: false,
  realOrder: false,
  executionAuthority: 'NONE',
});

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Pure: per-bar indicators computed from the closed bar and earlier bars only. */
export function flipIndicatorsV1(candles, rules = LONG_SHORT_FLIP_RULES_V1) {
  const n = candles.length;
  const out = {
    emaFast: new Array(n).fill(null), emaSlow: new Array(n).fill(null), atr: new Array(n).fill(null),
    rsi: new Array(n).fill(null), vwap: new Array(n).fill(null), volumeRatio: new Array(n).fill(null),
    priorHigh: new Array(n).fill(null), priorLow: new Array(n).fill(null),
  };
  const kf = 2 / (rules.emaFast + 1);
  const ks = 2 / (rules.emaSlow + 1);
  let ef = null; let es = null; let atr = null; let up = null; let down = null;
  for (let i = 0; i < n; i += 1) {
    const c = candles[i];
    ef = ef === null ? c.close : (c.close * kf) + (ef * (1 - kf));
    es = es === null ? c.close : (c.close * ks) + (es * (1 - ks));
    out.emaFast[i] = ef;
    out.emaSlow[i] = es;
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    atr = atr === null ? tr : ((atr * (rules.atrBars - 1)) + tr) / rules.atrBars;
    if (i >= rules.atrBars) out.atr[i] = atr;
    if (i > 0) {
      const d = c.close - prevClose;
      const g = Math.max(d, 0); const l = Math.max(-d, 0);
      up = up === null ? g : ((up * (rules.rsiBars - 1)) + g) / rules.rsiBars;
      down = down === null ? l : ((down * (rules.rsiBars - 1)) + l) / rules.rsiBars;
      if (i >= rules.rsiBars) out.rsi[i] = down === 0 ? 100 : 100 - (100 / (1 + (up / down)));
    }
    if (i + 1 >= rules.vwapBars) {
      let pv = 0; let vol = 0;
      for (let j = i + 1 - rules.vwapBars; j <= i; j += 1) {
        const b = candles[j];
        pv += ((b.high + b.low + b.close) / 3) * (b.volume ?? 0);
        vol += b.volume ?? 0;
      }
      out.vwap[i] = vol > 0 ? pv / vol : null;
    }
    if (i >= rules.volumeLookback) {
      let sum = 0;
      for (let j = i - rules.volumeLookback; j < i; j += 1) sum += candles[j].volume ?? 0;
      const mean = sum / rules.volumeLookback;
      out.volumeRatio[i] = mean > 0 ? (c.volume ?? 0) / mean : null;
    }
    if (i >= rules.breakoutLookback) {
      let hi = -Infinity;
      for (let j = i - rules.breakoutLookback; j < i; j += 1) hi = Math.max(hi, candles[j].high);
      out.priorHigh[i] = hi;
    }
    if (i >= rules.recentLowBars) {
      let lo = Infinity;
      for (let j = i - rules.recentLowBars; j < i; j += 1) lo = Math.min(lo, candles[j].low);
      out.priorLow[i] = lo;
    }
  }
  return out;
}

/** Pure: latest funding rate known at each candle (rows with timestamp <= candle time). */
export function fundingAtBarsV1(candles, fundingRates = []) {
  const rows = [...fundingRates].filter((r) => finite(r?.timestamp) && finite(r?.rate)).sort((a, b) => a.timestamp - b.timestamp);
  const out = new Array(candles.length).fill(null);
  let k = -1;
  for (let i = 0; i < candles.length; i += 1) {
    while (k + 1 < rows.length && rows[k + 1].timestamp <= candles[i].timestamp) k += 1;
    out[i] = k >= 0 ? rows[k].rate : null;
  }
  return { perBar: out, rows };
}

/** Pure: true when new longs are allowed (benchmark within the drawdown limit), by timestamp. */
export function regimeAllowsLongV1(benchmarkCandles, rules = LONG_SHORT_FLIP_RULES_V1) {
  const allowed = new Map();
  for (let i = 0; i < benchmarkCandles.length; i += 1) {
    let peak = -Infinity;
    for (let j = Math.max(0, i + 1 - rules.regimePeakBars); j <= i; j += 1) peak = Math.max(peak, benchmarkCandles[j].close);
    allowed.set(benchmarkCandles[i].timestamp, (1 - (benchmarkCandles[i].close / peak)) < rules.regimeMaxDrawdown);
  }
  return allowed;
}

function fundingCost(rows, side, entryTime, exitTime) {
  let sum = 0;
  for (const r of rows) {
    if (r.timestamp > entryTime && r.timestamp <= exitTime) sum += r.rate;
  }
  // Positive funding: longs pay, shorts receive.
  return side === 'long' ? sum : -sum;
}

/**
 * Pure: run one variant over one symbol. Returns closed trades with the return on
 * notional (after fees, slippage, spread and funding) and the R multiple.
 */
export function simulateLongShortFlipV1({
  candles, fundingRates = [], regimeAllowed = null, variant = LONG_SHORT_FLIP_VARIANTS_V1[1],
  rules = LONG_SHORT_FLIP_RULES_V1, cost = LONG_SHORT_FLIP_COST_V1,
}) {
  const bars = candles.filter((c) => c.timestamp < LONG_SHORT_FLIP_HOLDOUT_START);
  const ind = flipIndicatorsV1(bars, rules);
  const funding = fundingAtBarsV1(bars, fundingRates);
  const slip = cost.slippageRate + (cost.spreadRate / 2);
  const trades = [];
  let state = 'FLAT';
  let pending = null;
  let pos = null;
  let cooldown = 0;
  let watch = 0;
  let confirm = 0;

  const fillPrice = (raw, buying) => raw * (buying ? 1 + slip : 1 - slip);
  const legReturn = (side, entry, exit) => (side === 'long' ? (exit - entry) / entry : (entry - exit) / entry);

  function closePart(fraction, rawPrice, time, reason) {
    const px = fillPrice(rawPrice, pos.side === 'short');
    pos.realized += fraction * (legReturn(pos.side, pos.entry, px) - cost.feeRate);
    pos.open -= fraction;
    if (pos.open > 1e-9) return;
    const ret = pos.realized - cost.feeRate - fundingCost(funding.rows, pos.side, pos.entryTime, time);
    trades.push({
      side: pos.side, entryTime: pos.entryTime, exitTime: time, entry: pos.entry, exit: px,
      returnOnNotional: ret, rMultiple: ret / pos.riskFraction, reason,
    });
    const lost = ret < 0;
    const wasLong = pos.side === 'long';
    pos = null;
    if (wasLong && variant.flip) { state = 'WATCH'; watch = 0; confirm = 0; }
    else if (lost) { state = 'COOLDOWN'; cooldown = rules.cooldownBars; }
    else state = 'FLAT';
  }

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    // 1) Fill the order decided on the previous closed bar at this bar's open.
    if (pending) {
      if (pending.action === 'exit' && pos) closePart(pos.open, bar.open, bar.timestamp, pending.reason);
      else if ((pending.action === 'long' || pending.action === 'short') && !pos) {
        const side = pending.action;
        const entry = fillPrice(bar.open, side === 'long');
        const valid = side === 'long' ? entry > pending.stop : entry < pending.stop;
        if (valid) {
          const risk = Math.abs(entry - pending.stop);
          pos = {
            side, entry, entryTime: bar.timestamp, stop: pending.stop, risk, riskFraction: risk / entry,
            target: side === 'long' ? entry + (rules.takeProfitR * risk) : entry - (rules.takeProfitR * risk),
            tpDone: false, best: entry, open: 1, realized: 0,
          };
          state = side === 'long' ? 'LONG' : 'SHORT';
        } else if (side === 'short') {
          state = 'FLAT';
        }
      }
      pending = null;
    }
    // 2) Intrabar: stop first, then the first target.
    if (pos) {
      if (pos.side === 'long') {
        if (bar.low <= pos.stop) closePart(pos.open, Math.min(pos.stop, bar.open), bar.timestamp, pos.tpDone ? 'TRAIL' : 'STOP');
        else if (!pos.tpDone && bar.high >= pos.target) {
          closePart(rules.takeProfitFraction, pos.target, bar.timestamp, 'TP1');
          if (pos) { pos.tpDone = true; pos.stop = Math.max(pos.stop, pos.entry); }
        }
      } else if (bar.high >= pos.stop) closePart(pos.open, Math.max(pos.stop, bar.open), bar.timestamp, pos.tpDone ? 'TRAIL' : 'STOP');
      else if (!pos.tpDone && bar.low <= pos.target) {
        closePart(rules.takeProfitFraction, pos.target, bar.timestamp, 'TP1');
        if (pos) { pos.tpDone = true; pos.stop = Math.min(pos.stop, pos.entry); }
      }
    }
    // 3) Decide on the closed bar.
    const atr = ind.atr[i];
    if (!finite(atr) || atr <= 0 || i === bars.length - 1) continue;
    const ef = ind.emaFast[i]; const es = ind.emaSlow[i]; const vwap = ind.vwap[i];
    const fr = funding.perBar[i];
    if (pos) {
      if (pos.side === 'long') {
        pos.best = Math.max(pos.best, bar.close);
        if (pos.tpDone) pos.stop = Math.max(pos.stop, pos.best - (rules.trailAtr * atr));
        if (bar.close < es) pending = { action: 'exit', reason: 'TREND_EXIT' };
      } else {
        pos.best = Math.min(pos.best, bar.close);
        if (pos.tpDone) pos.stop = Math.min(pos.stop, pos.best + (rules.trailAtr * atr));
        if (bar.close > es) pending = { action: 'exit', reason: 'TREND_EXIT' };
      }
      continue;
    }
    if (state === 'COOLDOWN') {
      cooldown -= 1;
      if (cooldown <= 0) state = 'FLAT';
      continue;
    }
    if (state === 'WATCH') {
      watch += 1;
      if (watch > rules.watchBars) { state = 'FLAT'; continue; }
      if (!finite(vwap)) continue;
      confirm = bar.close < ef && bar.close < vwap ? confirm + 1 : 0;
      const brokeLow = finite(ind.priorLow[i]) && bar.close < ind.priorLow[i];
      const extra = (finite(fr) && fr >= rules.minShortFunding) || ef < es;
      if (confirm >= rules.confirmBars && brokeLow && extra) {
        pending = { action: 'short', stop: Math.max(bar.close + (rules.stopAtr * atr), bar.high) };
      }
      continue;
    }
    if (state !== 'FLAT') continue;
    if (variant.regime && regimeAllowed && regimeAllowed.get(bar.timestamp) === false) continue;
    const longOk = finite(ind.volumeRatio[i]) && ind.volumeRatio[i] >= rules.volumeSpike
      && finite(ind.priorHigh[i]) && bar.close > ind.priorHigh[i]
      && finite(vwap) && bar.close > vwap
      && ef > es
      && finite(ind.rsi[i]) && ind.rsi[i] < rules.rsiMax
      && (!finite(fr) || fr <= rules.maxLongFunding);
    if (longOk) pending = { action: 'long', stop: bar.close - (rules.stopAtr * atr) };
  }
  if (pos && bars.length) closePart(pos.open, bars.at(-1).close, bars.at(-1).timestamp, 'END');
  return trades;
}

/** Pure: summary of a trade list (R and return on notional). */
export function summarizeFlipTradesV1(trades) {
  const r = trades.map((t) => t.rMultiple);
  const gains = r.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const losses = -r.filter((v) => v < 0).reduce((s, v) => s + v, 0);
  // Equity at a fixed 1% account risk per trade, compounded in exit order.
  let equity = 1; let peak = 1; let maxDrawdown = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    equity *= 1 + (0.01 * t.rMultiple);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - (equity / peak));
  }
  return {
    trades: trades.length,
    winRate: trades.length ? r.filter((v) => v > 0).length / trades.length : null,
    sumR: r.reduce((s, v) => s + v, 0),
    averageR: trades.length ? r.reduce((s, v) => s + v, 0) / trades.length : null,
    profitFactor: losses > 0 ? gains / losses : (gains > 0 ? Infinity : null),
    returnAtOnePercentRisk: equity - 1,
    maxDrawdownAtOnePercentRisk: maxDrawdown,
  };
}

/** Pure: time split boundary (discovery = first 60% of the pooled period). */
export function flipSplitTimeV1(datasets) {
  const times = datasets.flatMap((d) => d.candles.filter((c) => c.timestamp < LONG_SHORT_FLIP_HOLDOUT_START).map((c) => c.timestamp));
  if (!times.length) return null;
  const start = Math.min(...times); const end = Math.max(...times);
  return Math.floor(start + ((end - start) * LONG_SHORT_FLIP_DISCOVERY_FRACTION));
}

/** Pure: run every variant on every symbol and apply the pre-registered verdict. */
export function evaluateLongShortFlipV1({ datasets, benchmarkSymbol = 'BTCUSDT' }) {
  const usable = datasets.filter((d) => Array.isArray(d.candles) && d.candles.length >= 200);
  const bench = usable.find((d) => d.symbol === benchmarkSymbol);
  const regimeAllowed = bench ? regimeAllowsLongV1(bench.candles.filter((c) => c.timestamp < LONG_SHORT_FLIP_HOLDOUT_START)) : null;
  const splitTime = flipSplitTimeV1(usable);
  const perVariant = {};
  for (const variant of LONG_SHORT_FLIP_VARIANTS_V1) {
    const bySymbol = {};
    for (const d of usable) {
      bySymbol[d.symbol] = simulateLongShortFlipV1({ candles: d.candles, fundingRates: d.fundingRates ?? [], regimeAllowed, variant });
    }
    perVariant[variant.id] = bySymbol;
  }
  const segment = (trades, which) => trades.filter((t) => (which === 'discovery' ? t.entryTime < splitTime : t.entryTime >= splitTime));
  const pooled = (id, which, side = null) => Object.values(perVariant[id]).flatMap((ts) => segment(ts, which))
    .filter((t) => side === null || t.side === side);

  const results = {};
  for (const variant of LONG_SHORT_FLIP_VARIANTS_V1) {
    results[variant.id] = {};
    for (const which of ['discovery', 'validation']) {
      results[variant.id][which] = {
        all: summarizeFlipTradesV1(pooled(variant.id, which)),
        long: summarizeFlipTradesV1(pooled(variant.id, which, 'long')),
        short: summarizeFlipTradesV1(pooled(variant.id, which, 'short')),
      };
    }
  }
  // Per-symbol gain from adding the flip (validation segment), among symbols with shorts.
  const symbolDeltas = usable.map((d) => {
    const flip = segment(perVariant.FLIP[d.symbol], 'validation');
    const base = segment(perVariant.LONG_ONLY[d.symbol], 'validation');
    const sum = (ts) => ts.reduce((s, t) => s + t.rMultiple, 0);
    return { symbol: d.symbol, shorts: flip.filter((t) => t.side === 'short').length, deltaR: sum(flip) - sum(base) };
  });
  const withShorts = symbolDeltas.filter((s) => s.shorts > 0);
  const breadth = withShorts.length ? withShorts.filter((s) => s.deltaR > 0).length / withShorts.length : null;
  const v = results.FLIP.validation;
  const base = results.LONG_ONLY.validation;
  const rule = LONG_SHORT_FLIP_VERDICT_V1;
  const checks = {
    enoughShortTrades: v.short.trades >= rule.minShortTrades,
    shortSumPositive: v.short.sumR > 0,
    shortProfitFactor: finite(v.short.profitFactor) ? v.short.profitFactor >= rule.minShortProfitFactor : v.short.profitFactor === Infinity,
    beatsLongOnly: v.all.sumR > base.all.sumR,
    symbolBreadth: breadth !== null && breadth >= rule.minSymbolBreadth,
  };
  const verdict = Object.values(checks).every(Boolean) ? 'SHORT_LEG_ADDS_VALUE' : 'NOT_PROVEN';
  return {
    contract: LONG_SHORT_FLIP_CONTRACT_V1,
    symbols: usable.map((d) => d.symbol),
    benchmark: bench ? benchmarkSymbol : null,
    splitTime: splitTime === null ? null : new Date(splitTime).toISOString(),
    holdoutStart: new Date(LONG_SHORT_FLIP_HOLDOUT_START).toISOString(),
    rules: LONG_SHORT_FLIP_RULES_V1,
    cost: LONG_SHORT_FLIP_COST_V1,
    results,
    symbolDeltas,
    symbolBreadth: breadth,
    checks,
    verdict,
    safety: SAFETY,
  };
}

const pct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : `${(v * 100).toFixed(1)}%`);
const num = (v, d = 2) => (v === null || v === undefined ? '-' : v === Infinity ? '∞' : Number(v).toFixed(d));

/** Pure: Korean report. */
export function formatLongShortFlipReportKoV1(result) {
  const lines = [];
  lines.push('롱 → 하락 확인 → 숏 전환 백테스트 (연구 전용, 주문 없음)');
  lines.push(`종목 ${result.symbols.length}개 · 비트겟 1시간봉 · 2026년 데이터 미사용 · 검증 시작 ${result.splitTime?.slice(0, 10) ?? '-'}`);
  lines.push('');
  for (const which of ['discovery', 'validation']) {
    lines.push(which === 'discovery' ? '[탐색 구간 (앞 60%)]' : '[검증 구간 (뒤 40%) ← 이 숫자로 판정]');
    for (const variant of LONG_SHORT_FLIP_VARIANTS_V1) {
      const r = result.results[variant.id][which];
      lines.push(`  ${variant.id.padEnd(15)} 거래 ${String(r.all.trades).padStart(4)} · 승률 ${pct(r.all.winRate)} · ΣR ${num(r.all.sumR)} · PF ${num(r.all.profitFactor)}`
        + ` · 1%위험 수익 ${pct(r.all.returnAtOnePercentRisk)} · 최대낙폭 ${pct(r.all.maxDrawdownAtOnePercentRisk)}`);
      if (variant.flip) {
        lines.push(`  ${''.padEnd(15)}  └ 롱 ${r.long.trades}건 ΣR ${num(r.long.sumR)} / 숏 ${r.short.trades}건 ΣR ${num(r.short.sumR)} PF ${num(r.short.profitFactor)}`);
      }
    }
    lines.push('');
  }
  const c = result.checks;
  lines.push('[판정 조건 (검증 구간)]');
  lines.push(`  숏 거래 30건 이상: ${c.enoughShortTrades ? '통과' : '미달'}`);
  lines.push(`  숏 ΣR > 0: ${c.shortSumPositive ? '통과' : '미달'}`);
  lines.push(`  숏 PF ≥ 1.1: ${c.shortProfitFactor ? '통과' : '미달'}`);
  lines.push(`  전환 전략이 롱만 하는 것보다 나음: ${c.beatsLongOnly ? '통과' : '미달'}`);
  lines.push(`  숏이 있었던 종목의 60% 이상에서 개선: ${c.symbolBreadth ? '통과' : '미달'} (${pct(result.symbolBreadth)})`);
  lines.push('');
  lines.push(result.verdict === 'SHORT_LEG_ADDS_VALUE'
    ? '결론: 숏 전환이 검증 구간에서 실제로 수익을 더했습니다. (실거래 전 홀드아웃·모의장부 확인 필요)'
    : '결론: 숏 전환의 효과가 아직 증명되지 않았습니다.');
  return lines.join('\n');
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

/** Reads cached Bitget 1h datasets under stateRoot, evaluates and writes latest JSON. */
export async function runLongShortFlipBacktestV1({ stateRoot, now = new Date() }) {
  const dir = join(stateRoot, 'combination-research', 'datasets', 'BITGET_1H');
  const datasets = [];
  for (const name of (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json') && !n.endsWith('.failure.json')).sort()) {
    const cached = JSON.parse(await readFile(join(dir, name), 'utf8'));
    datasets.push({
      symbol: cached.symbol ?? name.replace(/\.json$/u, ''),
      candles: (cached.candles ?? []).filter((c) => c.timestamp < LONG_SHORT_FLIP_HOLDOUT_START),
      fundingRates: (cached.fundingRates ?? []).filter((r) => r.timestamp < LONG_SHORT_FLIP_HOLDOUT_START),
    });
  }
  const result = { ...evaluateLongShortFlipV1({ datasets }), observedAt: now.toISOString() };
  await atomicJson(join(stateRoot, 'latest', 'long-short-flip-backtest-v1.json'), result);
  return result;
}

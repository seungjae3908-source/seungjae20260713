// "Legend trader composite" portfolio backtest (research only, no orders).
// What consistently profitable discretionary traders share, written as rules:
//   1. buy strength only: volume-backed pumps / range breakouts, long side
//   2. cut losers fast (initial stop at the signal bar low, 2–8%), never a fixed take-profit:
//      a chandelier trail (3 × ATR from the highest high) lets the few big winners run
//   3. pyramid into winners: add half size at +1R and +2R, stops ratcheted to breakeven / +1R
//   4. press when the market is hot, sit out when it is cold (BTC trend + breadth regime)
//   5. concentrate: at most K positions, ranked by volume surge
//   6. cost aware: taker (market) vs maker (limit-at-signal-close, filled only if traded through)
// Portfolio-level simulation on one shared equity, hourly bars, funding charged on longs.
import { atr, ema, rollingMax, sma } from './strategy-zoo-v1.mjs';

export const LEGEND_COMPOSITE_CONTRACT_V1 = 'legend-composite/v1';
const HOUR = 3_600_000;
const DAY = 86_400_000;
const fin = (v) => v !== null && v !== undefined && Number.isFinite(v);

export const LEGEND_VENUES_V1 = Object.freeze({
  PERP_1H: Object.freeze({ label: '코인선물 1시간봉 (Bitget 대용: Binance 아카이브)', btc: 'BTCUSDT', maxGross: 5,
    taker: 0.0008, makerEntry: 0.0002, funding: true }),
  UPBIT_1H: Object.freeze({ label: '업비트 현물 1시간봉', btc: 'KRW-BTC', maxGross: 1,
    taker: 0.0015, makerEntry: 0.0005, funding: false }),
});

export const LEGEND_VARIANTS_V1 = Object.freeze([
  { id: 'V0_FIXED_TP', name: '기준: 급등 추격 + 고정 익절 12% (지난번 방식)', signals: ['PUMP'], fixedTargetPct: 0.12, trail: false, pyramid: false, regime: false, hotMult: 1 },
  { id: 'V1_TRAIL', name: '① 급등 추격 + 익절 없이 끝까지 (3ATR 트레일링)', signals: ['PUMP'], trail: true, pyramid: false, regime: false, hotMult: 1 },
  { id: 'V2_PYRAMID', name: '② + 피라미딩 (+1R·+2R에 절반씩 추가)', signals: ['PUMP'], trail: true, pyramid: true, regime: false, hotMult: 1 },
  { id: 'V3_REGIME', name: '③ + 장 나쁠 때 쉬기 (BTC 50일선·코인 절반 이상 상승 추세일 때만)', signals: ['PUMP'], trail: true, pyramid: true, regime: true, hotMult: 1 },
  { id: 'V4_PRESS_HOT', name: '④ + 장 뜨거울 때 2배 베팅', signals: ['PUMP'], trail: true, pyramid: true, regime: true, hotMult: 2 },
  { id: 'V5_PLUS_BREAKOUT', name: '⑤ + 5일 신고가 돌파 진입 추가 (종합판)', signals: ['PUMP', 'BREAKOUT'], trail: true, pyramid: true, regime: true, hotMult: 2 },
]);

export const LEGEND_DEFAULTS_V1 = Object.freeze({
  riskPct: 0.01, pumpRet: 0.05, pumpVolX: 5, breakoutBars: 120, breakoutVolX: 2, minStop: 0.02, maxStop: 0.08,
  atrBars: 24, atrMult: 3, timeStopBars: 24, maxHoldBars: 240, regimeEmaBars: 1200, hotBreadth: 0.6, coldBreadth: 0.4,
});

// ------------------------------------------------------------------ per-symbol series

function prepare(ds, p) {
  const bars = ds.candles; const close = bars.map((b) => b.close); const vol = bars.map((b) => b.volume ?? 0);
  const avgVol = sma(vol, 168); const hi = rollingMax(bars.map((b) => b.high), p.breakoutBars);
  const e200 = ema(close, 200); const eReg = ema(close, p.regimeEmaBars); const a = atr(bars, p.atrBars);
  const index = new Map(bars.map((b, i) => [b.timestamp, i]));
  // funding: 8-hourly rates keyed by the hour they settle
  const funding = new Map((ds.fundingRates ?? []).map((f) => [Math.floor(f.timestamp / HOUR) * HOUR, f.rate]));
  return { symbol: ds.symbol, bars, close, vol, avgVol, hi, e200, eReg, atr: a, index, funding };
}

function signalAt(s, i, variant, p) {
  if (i < 1) return null;
  const vx = fin(s.avgVol[i - 1]) && s.avgVol[i - 1] > 0 ? s.vol[i] / s.avgVol[i - 1] : null;
  if (!fin(vx)) return null;
  const r1 = s.close[i] / s.close[i - 1] - 1;
  if (variant.signals.includes('PUMP') && r1 >= p.pumpRet && vx >= p.pumpVolX) return { kind: 'PUMP', score: vx };
  if (variant.signals.includes('BREAKOUT') && fin(s.hi[i - 1]) && fin(s.e200[i]) && s.close[i] > s.hi[i - 1] && s.close[i] > s.e200[i] && vx >= p.breakoutVolX) return { kind: 'BREAKOUT', score: vx / 2 };
  return null;
}

// ------------------------------------------------------------------ portfolio simulation

/**
 * @param {{ venue, datasets: {symbol, candles, fundingRates?}[], variant, maxPositions, fill: 'TAKER'|'MAKER', params? }} cfg
 */
export function simulateLegendCompositeV1({ venue, datasets, variant, maxPositions, fill, params = {} }) {
  const spec = LEGEND_VENUES_V1[venue]; if (!spec) throw new Error(`LEGEND_VENUE_UNKNOWN:${venue}`);
  const p = { ...LEGEND_DEFAULTS_V1, ...params };
  const series = datasets.filter((d) => d.candles?.length > p.regimeEmaBars).map((d) => prepare(d, p));
  const btc = series.find((s) => s.symbol === spec.btc) ?? null;
  const timeline = [...new Set(series.flatMap((s) => s.bars.map((b) => b.timestamp)))].sort((x, y) => x - y);
  const entryFee = fill === 'MAKER' ? spec.makerEntry : spec.taker; const exitFee = spec.taker;

  let cash = 1; // realised equity (futures: margin account; spot: cash + cost basis handled via PnL)
  const open = new Map(); // symbol → position
  const pending = []; // entries decided at a close, filled at the next bar of that symbol
  const trades = []; const curve = []; let peak = 1; let mdd = 0; let exposureHours = 0; let regimeCold = 0; let regimeHot = 0;

  // atClose=false → value with last known closes (used for sizing during a bar: no intrabar lookahead)
  const markEquity = (t, atClose = true) => {
    let eq = cash;
    for (const pos of open.values()) { const i = atClose ? pos.s.index.get(t) : undefined; const px = fin(i) ? pos.s.close[i] : pos.lastPx; eq += pos.units * (px - pos.avgEntry); }
    return eq;
  };
  const grossNotional = () => { let g = 0; for (const pos of open.values()) g += pos.units * pos.lastPx; return g; };

  const closePos = (pos, px, t, reason) => {
    cash += pos.units * (px - pos.avgEntry) - (pos.units * px * exitFee);
    trades.push({ symbol: pos.s.symbol, kind: pos.kind, entryT: pos.entryT, exitT: t, entry: pos.entry0, exit: px, adds: pos.adds,
      ret: (px / pos.entry0) - 1, pnl: (pos.units * (px - pos.avgEntry)) - (pos.units * px * exitFee) - pos.feesPaid - pos.fundingPaid, equityAtEntry: pos.equityAtEntry, reason, bars: pos.held });
    open.delete(pos.s.symbol);
  };

  for (let k = 0; k < timeline.length; k += 1) {
    const t = timeline[k];
    // regime (from the previous close: decided before this bar trades)
    let regime = 'NORMAL';
    if (variant.regime && k > 0) {
      const tp = timeline[k - 1]; let above = 0; let counted = 0;
      for (const s of series) { const i = s.index.get(tp); if (fin(i) && fin(s.eReg[i])) { counted += 1; if (s.close[i] > s.eReg[i]) above += 1; } }
      const breadth = counted ? above / counted : 0; const bi = btc ? btc.index.get(tp) : undefined;
      const btcUp = btc && fin(bi) && fin(btc.eReg[bi]) && btc.close[bi] > btc.eReg[bi];
      const btc7 = btc && fin(bi) && bi >= 168 ? btc.close[bi] / btc.close[bi - 168] - 1 : 0;
      if (!btcUp || breadth < p.coldBreadth) regime = 'COLD';
      else if (breadth >= p.hotBreadth && btc7 > 0) regime = 'HOT';
    }
    if (regime === 'COLD') regimeCold += 1; if (regime === 'HOT') regimeHot += 1;

    // 1) fill pending entries at this bar's open
    for (let q = pending.length - 1; q >= 0; q -= 1) {
      const e = pending[q]; const i = e.s.index.get(t); if (!fin(i)) { if (t - e.t0 > 2 * HOUR) pending.splice(q, 1); continue; } pending.splice(q, 1);
      if (open.has(e.s.symbol) || open.size >= maxPositions) continue;
      const bar = e.s.bars[i];
      let px = bar.open;
      if (fill === 'MAKER') { if (bar.low > e.limit) continue; px = Math.min(bar.open, e.limit); }
      const stopDist = Math.min(p.maxStop, Math.max(p.minStop, (px - e.signalLow) / px));
      const stop = px * (1 - stopDist); const R = px - stop;
      const equity = markEquity(t, false);
      let units = (equity * p.riskPct * e.mult) / R;
      const room = Math.max(0, (spec.maxGross * equity) - grossNotional());
      units = Math.min(units, room / px); if (!(units > 0)) continue;
      const fee = units * px * entryFee; cash -= fee;
      open.set(e.s.symbol, { s: e.s, kind: e.kind, entryT: t, entry0: px, avgEntry: px, units, unit0: units, stop, R, adds: 0, highest: bar.open, held: 0, lastPx: px,
        feesPaid: fee, fundingPaid: 0, equityAtEntry: equity, mfeR: 0 });
    }

    // 2) manage open positions on this bar
    for (const pos of [...open.values()]) {
      const i = pos.s.index.get(t); if (!fin(i)) continue; const bar = pos.s.bars[i]; pos.held += 1;
      // pyramiding first (worst case: an add filled in a bar that also hits the old stop)
      if (variant.pyramid) {
        for (const lvl of [1, 2]) {
          if (pos.adds >= lvl) continue; const trigger = pos.entry0 + (lvl * pos.R);
          if (bar.high >= trigger) {
            const px = bar.open >= trigger ? bar.open : trigger; const equity = markEquity(t, false);
            const room = Math.max(0, (spec.maxGross * equity) - grossNotional()); const add = Math.min(pos.unit0 * 0.5, room / px);
            if (add > 0) { const fee = add * px * spec.taker; cash -= fee; pos.feesPaid += fee; pos.avgEntry = ((pos.avgEntry * pos.units) + (px * add)) / (pos.units + add); pos.units += add; }
            pos.adds = lvl; pos.pendingRatchet = Math.max(pos.pendingRatchet ?? -Infinity, lvl === 1 ? pos.entry0 : pos.entry0 + pos.R);
          }
        }
      }
      // stop (gap fills at the open)
      if (bar.open <= pos.stop) { closePos(pos, bar.open, t, 'STOP'); continue; }
      if (bar.low <= pos.stop) { closePos(pos, pos.stop, t, 'STOP'); continue; }
      if (fin(variant.fixedTargetPct)) { const tgt = pos.entry0 * (1 + variant.fixedTargetPct); if (bar.high >= tgt) { closePos(pos, Math.max(bar.open, tgt), t, 'TARGET'); continue; } }
      // funding on longs (positive rate = longs pay)
      if (spec.funding) { const r = pos.s.funding.get(t); if (fin(r)) { const f = pos.units * bar.close * r; cash -= f; pos.fundingPaid += f; } }
      pos.highest = Math.max(pos.highest, bar.high); pos.lastPx = bar.close; pos.mfeR = Math.max(pos.mfeR, (pos.highest - pos.entry0) / pos.R);
      // time stops at the close
      if (pos.held >= p.timeStopBars && pos.mfeR < 1) { closePos(pos, bar.close, t, 'NO_FOLLOW_THROUGH'); continue; }
      if (pos.held >= p.maxHoldBars) { closePos(pos, bar.close, t, 'MAX_HOLD'); continue; }
      // ratchet for the next bar only (no intrabar lookahead)
      if (fin(pos.pendingRatchet)) { pos.stop = Math.max(pos.stop, pos.pendingRatchet); pos.pendingRatchet = null; }
      if (variant.trail && fin(pos.s.atr[i])) pos.stop = Math.max(pos.stop, pos.highest - (p.atrMult * pos.s.atr[i]));
    }

    // 3) new signals at this close → next bar
    if (regime !== 'COLD') {
      const free = maxPositions - open.size - pending.length;
      if (free > 0) {
        const cands = [];
        for (const s of series) {
          if (open.has(s.symbol) || pending.some((e) => e.s === s)) continue;
          const i = s.index.get(t); if (!fin(i)) continue;
          const sig = signalAt(s, i, variant, p); if (sig) cands.push({ s, i, ...sig });
        }
        cands.sort((a, b) => b.score - a.score);
        for (const c of cands.slice(0, free)) pending.push({ t0: t, s: c.s, kind: c.kind, signalLow: c.s.bars[c.i].low, limit: c.s.close[c.i], mult: regime === 'HOT' ? variant.hotMult : 1 });
      }
    }

    const eq = markEquity(t); if (open.size) exposureHours += 1;
    peak = Math.max(peak, eq); mdd = Math.max(mdd, peak > 0 ? 1 - (eq / peak) : 1);
    if (k === timeline.length - 1 || Math.floor(timeline[k + 1] / DAY) !== Math.floor(t / DAY)) curve.push({ t, equity: eq });
    if (eq <= 0.01) { curve.push({ t, equity: Math.max(0, eq) }); break; } // ruined
  }
  for (const pos of [...open.values()]) closePos(pos, pos.lastPx, timeline.at(-1), 'END');
  return { trades, curve, maxDrawdown: mdd, exposure: timeline.length ? exposureHours / timeline.length : 0,
    coldShare: timeline.length ? regimeCold / timeline.length : 0, hotShare: timeline.length ? regimeHot / timeline.length : 0 };
}

// ------------------------------------------------------------------ statistics

export function curveStats(curve, from, to) {
  const pts = curve.filter((c) => c.t >= from && c.t < to); if (pts.length < 2) return { days: pts.length };
  const rets = []; for (let i = 1; i < pts.length; i += 1) rets.push(pts[i].equity / pts[i - 1].equity - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length; const sd = Math.sqrt(rets.reduce((a, b) => a + ((b - mean) ** 2), 0) / Math.max(1, rets.length - 1));
  let peak = pts[0].equity; let mdd = 0; for (const c of pts) { peak = Math.max(peak, c.equity); mdd = Math.max(mdd, peak > 0 ? 1 - (c.equity / peak) : 1); }
  const total = pts.at(-1).equity / pts[0].equity - 1; const years = (pts.at(-1).t - pts[0].t) / (365 * DAY);
  return { days: pts.length, totalReturn: total, cagr: total > -1 && years > 0 ? ((1 + total) ** (1 / years)) - 1 : -1, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0, maxDrawdown: mdd };
}

export function yearlyReturns(curve) {
  const last = new Map(); for (const c of curve) last.set(new Date(c.t).getUTCFullYear(), c.equity);
  const res = {}; let prev = curve[0]?.equity ?? 1;
  for (const [y, eq] of [...last.entries()].sort((x, z) => x[0] - z[0])) { res[y] = prev > 0 ? eq / prev - 1 : 0; prev = eq; }
  return res;
}

export function tradeSummary(trades) {
  const n = trades.length; if (!n) return { n: 0 };
  const rs = trades.map((t) => t.ret); const pnls = trades.map((t) => t.pnl); const wins = trades.filter((t) => t.pnl > 0);
  const gross = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0); const sortedPnl = [...pnls].sort((a, b) => b - a);
  const top = sortedPnl.slice(0, Math.max(1, Math.ceil(n * 0.1))).reduce((a, b) => a + b, 0); const net = pnls.reduce((a, b) => a + b, 0);
  return { n, winRate: wins.length / n, avgWinRet: wins.length ? wins.reduce((a, t) => a + t.ret, 0) / wins.length : 0,
    avgLossRet: n - wins.length ? trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.ret, 0) / (n - wins.length) : 0,
    bestRet: Math.max(...rs), share20: rs.filter((r) => r >= 0.2).length / n, share50: rs.filter((r) => r >= 0.5).length / n,
    topDecileProfitShare: net > 0 ? top / net : null, grossWin: gross, pyramided: trades.filter((t) => t.adds > 0).length / n,
    byKind: Object.fromEntries(['PUMP', 'BREAKOUT'].map((k) => [k, trades.filter((t) => t.kind === k).length])) };
}

export function compositeVerdictV1(discovery, validation, full) {
  if (!fin(validation?.cagr) || !fin(discovery?.cagr)) return 'NO_DATA';
  if (full.maxDrawdown >= 0.6) return 'TOO_RISKY';
  if (discovery.cagr > 0 && validation.cagr > 0 && discovery.sharpe >= 0.7 && validation.sharpe >= 0.7) return 'ROBUST';
  if (discovery.cagr > 0 && validation.cagr > 0) return 'POSITIVE_BOTH';
  return 'FAILS_ONE_HALF';
}

export function evaluateLegendCompositeV1({ venue, datasets, span, splitTime, maxPositionsList = [3, 5], fills = ['TAKER', 'MAKER'] }) {
  const rows = [];
  for (const variant of LEGEND_VARIANTS_V1) for (const K of maxPositionsList) for (const fill of fills) {
    const sim = simulateLegendCompositeV1({ venue, datasets, variant, maxPositions: K, fill });
    const full = curveStats(sim.curve, span.from, span.to); const discovery = curveStats(sim.curve, span.from, splitTime); const validation = curveStats(sim.curve, splitTime, span.to);
    rows.push({ id: `${variant.id}__K${K}__${fill}`, variant: variant.id, name: variant.name, maxPositions: K, fill, full, discovery, validation,
      yearly: yearlyReturns(sim.curve), trades: tradeSummary(sim.trades), exposure: sim.exposure, coldShare: sim.coldShare, hotShare: sim.hotShare,
      verdict: compositeVerdictV1(discovery, validation, full) });
  }
  // buy & hold BTC on the same span for reference
  const btcSet = datasets.find((d) => d.symbol === LEGEND_VENUES_V1[venue].btc);
  let btc = null;
  if (btcSet) { const curve = []; const b = btcSet.candles; const base = b[0].close; for (let i = 0; i < b.length; i += 1) if (i === b.length - 1 || Math.floor(b[i + 1].timestamp / DAY) !== Math.floor(b[i].timestamp / DAY)) curve.push({ t: b[i].timestamp, equity: b[i].close / base });
    btc = { full: curveStats(curve, span.from, span.to), discovery: curveStats(curve, span.from, splitTime), validation: curveStats(curve, splitTime, span.to), yearly: yearlyReturns(curve) }; }
  return { venue, label: LEGEND_VENUES_V1[venue].label, symbols: datasets.map((d) => d.symbol), span: { from: new Date(span.from).toISOString().slice(0, 10), to: new Date(span.to).toISOString().slice(0, 10) },
    splitDate: new Date(splitTime).toISOString().slice(0, 10), configsTried: rows.length, btc, rows };
}

// ------------------------------------------------------------------ report

const pct = (v, d = 1) => (fin(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '-');
const VERDICT_KO = { ROBUST: '✅ 앞뒤 모두 강함', POSITIVE_BOTH: '🟡 앞뒤 모두 플러스', FAILS_ONE_HALF: '❌ 한쪽 기간 손실', TOO_RISKY: '☠️ 낙폭 60%+', NO_DATA: '데이터 부족' };

export function formatLegendCompositeReportKoV1(venues) {
  const lines = ['유명 트레이더 방식 종합판 백테스트 (연구 전용, 주문 없음)',
    '1회 위험 = 자산의 1% (뜨거운 장 2%) · 손절 = 신호 봉 저가 (2~8%) · 고정 익절 없음(①부터) · 동시 보유 K개 · 선물 총노출 5배 / 현물 1배 한도',
    '체결: 다음 봉 시가(시장가) 또는 신호 종가 지정가(다음 봉이 그 가격을 찍어야 체결) · 손절은 시장가 · 펀딩비 포함(선물)',
    `주의: 같은 데이터로 여러 조합을 시험했으므로(다중 시험) 가장 좋은 줄은 실제보다 좋게 보입니다. 앞(60%)·뒤(40%) 기간을 모두 보세요.`, ''];
  for (const v of venues) {
    lines.push(`■ ${v.label} · ${v.symbols.length}종목 · ${v.span.from}~${v.span.to} (검증 시작 ${v.splitDate}) · 조합 ${v.configsTried}개`);
    if (v.btc) lines.push(`  비교: BTC 그냥 보유 연 ${pct(v.btc.full.cagr)} · 낙폭 ${pct(-v.btc.full.maxDrawdown)} · 앞 ${pct(v.btc.discovery.cagr)} / 뒤 ${pct(v.btc.validation.cagr)}`);
    for (const r of v.rows) {
      const yr = Object.entries(r.yearly).map(([y, x]) => `${String(y).slice(2)}년 ${pct(x, 0)}`).join(' ');
      lines.push(`  ${VERDICT_KO[r.verdict]} ${r.name} [최대 ${r.maxPositions}종목·${r.fill === 'MAKER' ? '지정가' : '시장가'}]`);
      lines.push(`     연 ${pct(r.full.cagr)} · 낙폭 ${pct(-r.full.maxDrawdown)} · 샤프 ${(r.full.sharpe ?? 0).toFixed(2)} · 앞 ${pct(r.discovery.cagr)}(${(r.discovery.sharpe ?? 0).toFixed(2)}) / 뒤 ${pct(r.validation.cagr)}(${(r.validation.sharpe ?? 0).toFixed(2)})`
        + ` · 거래 ${r.trades.n ?? 0}회 승률 ${pct(r.trades.winRate, 0)} · 평균 이익 ${pct(r.trades.avgWinRet)} / 손실 ${pct(r.trades.avgLossRet)} · 최고 ${pct(r.trades.bestRet, 0)} · +20% 이상 ${pct(r.trades.share20, 0)}`
        + `${fin(r.trades.topDecileProfitShare) ? ` · 상위 10% 거래가 순익의 ${pct(r.trades.topDecileProfitShare, 0)}` : ''} · 쉰 시간 ${pct(r.coldShare, 0)}`);
      lines.push(`     ${yr}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

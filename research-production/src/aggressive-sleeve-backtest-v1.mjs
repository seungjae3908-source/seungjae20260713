// Aggressive sleeve backtest (research only, no orders).
//
// Owner decision 2026-10-18: at most 10% of the account goes into an aggressive
// sleeve that may be lost entirely; the rest of the account is never touched.
// Pre-registered rules (before any result), on 1h coin-futures candles:
//   SURGE_LONG       surge start: contraction, then a 20-bar high break on ≥2.5× volume
//   SURGE_LONG_BTCUP same, only while BTC closes above its 1h EMA200
//   POST_SURGE_SHORT ≥15% run-up within 72 bars, then a break of the prior 6-bar low
// Exit: stop 2 × ATR14 capped at 8%, 3 × ATR trail, breakeven after +1R,
//       leave after 12 bars if never +0.5R, hard cap 72 bars.
// Sizing inside the sleeve: each trade risks 5% of the sleeve equity at entry,
// notional capped at 5 × sleeve equity (5x leverage), at most 3 positions open.
// Results are reported as the sleeve and as its effect on the whole account.
import { computeCombinationAtomsV1 } from './combination-atoms-v1.mjs';
import { runManagedExitBacktestV1 } from './managed-exit-backtest-v1.mjs';

export const AGGRESSIVE_SLEEVE_POLICY_V1 = Object.freeze({
  sleeveFractionOfAccount: 0.10,
  riskFractionOfSleeve: 0.05,
  maxLeverage: 5,
  maxConcurrent: 3,
});

const COST = Object.freeze({ entryFeeRate: 0.0006, exitFeeRate: 0.0006, slippageRate: 0.001, spreadRate: 0.0004 });
const EXIT = Object.freeze({ stopAtrMultiple: 2, maxStopFraction: 0.08, targetR: null, breakevenAfterR: 1,
  trailing: Object.freeze({ atrMultiple: 3 }), timeStop: Object.freeze({ bars: 12, minFavorableR: 0.5 }), maxHoldBars: 72 });

export const AGGRESSIVE_SLEEVE_VARIANTS_V1 = Object.freeze([
  Object.freeze({ id: 'SURGE_LONG', side: 'long', atom: 'P_SURGE_BREAKOUT_LONG', btcFilter: false }),
  Object.freeze({ id: 'SURGE_LONG_BTCUP', side: 'long', atom: 'P_SURGE_BREAKOUT_LONG', btcFilter: true }),
  Object.freeze({ id: 'POST_SURGE_SHORT', side: 'short', atom: 'P_POST_SURGE_BREAK_SHORT', btcFilter: false }),
]);

function emaAbove(candles, period = 200) {
  const k = 2 / (period + 1);
  let e = null;
  const out = new Map();
  for (const c of candles) {
    e = e === null ? c.close : (c.close * k) + (e * (1 - k));
    out.set(c.timestamp, c.close > e);
  }
  return out;
}

/** Pure: trades of one variant on one symbol, with stop distance for sizing. */
export function aggressiveTradesV1({ symbol, candles, fundingRates = [], variant, btcUp = null }) {
  if (candles.length < 400) return [];
  const atoms = computeCombinationAtomsV1(candles, { timeframe: '1h' });
  const flags = atoms.get(variant.atom);
  if (!flags) throw new Error(`AGGRESSIVE_ATOM_UNKNOWN:${variant.atom}`);
  const result = runManagedExitBacktestV1({
    backtestInput: { market: 'CRYPTO_FUTURES', side: variant.side, symbol, timeframe: '1h', candles, fundingRates,
      initialCapital: 10_000_000, costModel: COST, riskModel: { riskPerTrade: 0.5, maximumCapitalFraction: 1, leverage: 5 } },
    strategy: 'aggressive_sleeve_v1', strategyVersion: `AGGRESSIVE:${variant.id}`,
    plan: { exit: EXIT }, atrPeriod: 14,
    signalEvaluator: ({ index }) => {
      if (flags[index] !== 1) return null;
      if (variant.btcFilter && btcUp && btcUp.get(candles[index].timestamp) !== true) return null;
      return { variant: variant.id };
    },
  });
  return result.trades.map((t) => ({
    symbol, variantId: variant.id, side: variant.side, entryTime: t.entryTime, exitTime: t.exitTime,
    returnOnNotional: t.entryNotional > 0 ? t.netPnl / t.entryNotional : 0,
    stopFraction: t.entryPrice > 0 ? Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice : null,
  }));
}

/**
 * Pure: sleeve equity path. Risk a fixed fraction of the sleeve per trade,
 * notional ≤ maxLeverage × sleeve, at most maxConcurrent open; a signal that
 * arrives while full is skipped. A sleeve that reaches zero stops trading.
 */
export function simulateSleeveV1(trades, { startSleeveKrw, riskFractionOfSleeve, maxLeverage, maxConcurrent }) {
  const rows = trades.filter((t) => Number.isFinite(t.stopFraction) && t.stopFraction > 0).sort((a, b) => a.entryTime - b.entryTime);
  let equity = startSleeveKrw; let peak = equity; let maxDrawdown = 0; let taken = 0; let skipped = 0; let wins = 0;
  const open = [];
  const monthly = new Map();
  const settle = (until) => {
    open.sort((a, b) => a.exitTime - b.exitTime);
    while (open.length && open[0].exitTime <= until) {
      const t = open.shift();
      equity = Math.max(0, equity + t.pnl);
      if (t.pnl > 0) wins += 1;
      const month = new Date(t.exitTime).toISOString().slice(0, 7);
      monthly.set(month, (monthly.get(month) ?? 0) + t.pnl);
      peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 1);
    }
  };
  for (const t of rows) {
    settle(t.entryTime);
    if (equity <= 0) break;
    if (open.length >= maxConcurrent) { skipped += 1; continue; }
    const notional = Math.min(maxLeverage * equity, (equity * riskFractionOfSleeve) / t.stopFraction);
    open.push({ exitTime: t.exitTime, pnl: notional * t.returnOnNotional });
    taken += 1;
  }
  settle(Infinity);
  const months = [...monthly.entries()].sort();
  return {
    startSleeveKrw, endSleeveKrw: Math.round(equity), sleeveReturn: equity / startSleeveKrw - 1,
    maxDrawdownFraction: maxDrawdown, ruined: equity <= startSleeveKrw * 0.05,
    trades: taken, skippedWhileFull: skipped, winRate: taken ? wins / taken : null,
    bestMonthKrw: months.length ? Math.round(Math.max(...months.map((m) => m[1]))) : null,
    worstMonthKrw: months.length ? Math.round(Math.min(...months.map((m) => m[1]))) : null,
    positiveMonths: months.filter((m) => m[1] > 0).length, months: months.length,
  };
}

export function evaluateAggressiveSleeveV1({ datasets, accountKrw = 2_000_000, policy = AGGRESSIVE_SLEEVE_POLICY_V1 }) {
  const btc = datasets.find((d) => d.symbol === 'BTCUSDT');
  const btcUp = btc ? emaAbove(btc.candles) : null;
  const sleeve = accountKrw * policy.sleeveFractionOfAccount;
  return AGGRESSIVE_SLEEVE_VARIANTS_V1.map((variant) => {
    const trades = datasets.flatMap((d) => aggressiveTradesV1({ ...d, variant, btcUp }));
    const sim = simulateSleeveV1(trades, { startSleeveKrw: sleeve, ...policy });
    return {
      variantId: variant.id, symbols: datasets.length, signals: trades.length, ...sim,
      accountEffectKrw: Math.round(sim.endSleeveKrw - sleeve),
      accountEffectFraction: (sim.endSleeveKrw - sleeve) / accountKrw,
    };
  });
}

const won = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('ko-KR')}원` : '-');
const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '-');
const VARIANT_KO = { SURGE_LONG: '급등 시작 롱', SURGE_LONG_BTCUP: '급등 시작 롱 (BTC 상승장일 때만)', POST_SURGE_SHORT: '급등 후 꺾임 숏' };

export function formatAggressiveSleeveKoV1(rows, { accountKrw = 2_000_000 } = {}) {
  const sleeve = accountKrw * AGGRESSIVE_SLEEVE_POLICY_V1.sleeveFractionOfAccount;
  const lines = [`공격형 칸 과거 성적 · 계좌 ${won(accountKrw)} 중 최대 10% = ${won(sleeve)} · 1회 칸의 5% 감수 · 레버리지 최대 5배 · 동시 3개`, ''];
  for (const r of rows) {
    lines.push(`■ ${VARIANT_KO[r.variantId] ?? r.variantId}: 칸 ${won(r.startSleeveKrw)} → ${won(r.endSleeveKrw)} (${pct(r.sleeveReturn)}) · 계좌 영향 ${won(r.accountEffectKrw)} (${pct(r.accountEffectFraction)})`);
    lines.push(`   거래 ${r.trades}회(가득 차서 건너뜀 ${r.skippedWhileFull}) · 승률 ${pct(r.winRate)} · 칸 최대 낙폭 ${pct(-r.maxDrawdownFraction)} · 최고의 달 ${won(r.bestMonthKrw)} · 최악의 달 ${won(r.worstMonthKrw)} · 플러스 달 ${r.positiveMonths}/${r.months}${r.ruined ? ' · ⚠️ 칸 거의 소진' : ''}`);
  }
  lines.push('', '칸이 다 없어져도 계좌 손실은 최대 10%. 과거 성적일 뿐 미래 보장 아님. 주문 권한 없음.');
  return lines.join('\n');
}

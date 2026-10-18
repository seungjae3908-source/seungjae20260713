// BTC/ETH long-short trend-following pilot backtest (research only, no orders).
//
// Owner decision 2026-10-18: live pilot with a fixed 1,000,000 KRW notional per
// trade and a 30,000 KRW daily loss limit, so the stop is capped at 2.5%.
// Rules (pre-registered, before any result):
//   long  : close > previous 55-bar high and close > EMA200
//   short : close < previous 55-bar low  and close < EMA200
//   stop  : 2 × ATR14, capped at 2.5% of the entry price
//   exit  : 2.5 × ATR chandelier trail, stop to breakeven after +1R, no fixed target
// Variants: H4_CAP25 (4-hour bars, the pilot), D1_CAP25 (daily bars, same caps)
// and D1_CLASSIC (daily, 3 × ATR stop and trail without the cap, the textbook form).
// Data: the cached Bitget 1h perpetual candles (pre-2026) resampled to 4h/1d,
// with funding. Results are per 1,000,000 KRW notional after fees, slippage and funding.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { runManagedExitBacktestV1 } from './managed-exit-backtest-v1.mjs';

export const TREND_PILOT_CONTRACT_V1 = 'trend-pilot-backtest/v1';
const HOLDOUT_START = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const TREND_PILOT_NOTIONAL_KRW = 1_000_000;
export const TREND_PILOT_DAILY_LOSS_KRW = 30_000;
export const TREND_PILOT_PRIMARY_SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT']);
const COST = Object.freeze({ entryFeeRate: 0.0006, exitFeeRate: 0.0006, slippageRate: 0.0005, spreadRate: 0.0002 });

export const TREND_PILOT_VARIANTS_V1 = Object.freeze([
  Object.freeze({ id: 'H4_CAP25', barHours: 4, exit: Object.freeze({ stopAtrMultiple: 2, maxStopFraction: 0.025, targetR: null,
    breakevenAfterR: 1, trailing: Object.freeze({ atrMultiple: 2.5 }), maxHoldBars: 180 }) }),
  Object.freeze({ id: 'D1_CAP25', barHours: 24, exit: Object.freeze({ stopAtrMultiple: 2, maxStopFraction: 0.025, targetR: null,
    breakevenAfterR: 1, trailing: Object.freeze({ atrMultiple: 2.5 }), maxHoldBars: 60 }) }),
  Object.freeze({ id: 'D1_CLASSIC', barHours: 24, exit: Object.freeze({ stopAtrMultiple: 3, targetR: null,
    trailing: Object.freeze({ atrMultiple: 3 }), maxHoldBars: 120 }) }),
]);

/** Pure: aggregate hourly candles into N-hour bars aligned to UTC midnight; drops incomplete bars. */
export function resampleCandlesV1(candles, hours) {
  const size = hours * HOUR;
  const groups = new Map();
  for (const c of candles) {
    const key = Math.floor(c.timestamp / size) * size;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0])
    .filter(([, rows]) => rows.length === hours)
    .map(([timestamp, rows]) => ({
      timestamp,
      open: rows[0].open,
      high: Math.max(...rows.map((r) => r.high)),
      low: Math.min(...rows.map((r) => r.low)),
      close: rows.at(-1).close,
      volume: rows.reduce((s, r) => s + (r.volume ?? 0), 0),
    }));
}

/** Pure: entry flags per bar, using the closed bar and earlier bars only. */
export function trendSignalsV1(candles, { channel = 55, ema = 200 } = {}) {
  const long = new Array(candles.length).fill(false);
  const short = new Array(candles.length).fill(false);
  const k = 2 / (ema + 1);
  let e = null;
  for (let i = 0; i < candles.length; i += 1) {
    e = e === null ? candles[i].close : (candles[i].close * k) + (e * (1 - k));
    if (i < Math.max(channel, ema)) continue;
    const prior = candles.slice(i - channel, i);
    const hi = Math.max(...prior.map((c) => c.high));
    const lo = Math.min(...prior.map((c) => c.low));
    long[i] = candles[i].close > hi && candles[i].close > e;
    short[i] = candles[i].close < lo && candles[i].close < e;
  }
  return { long, short };
}

/** Pure: per-trade KRW results in time order → summary at a fixed notional. */
export function summarizeTradesKrwV1(trades, { notionalKrw = TREND_PILOT_NOTIONAL_KRW, dailyLossKrw = TREND_PILOT_DAILY_LOSS_KRW } = {}) {
  const rows = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const pnl = rows.map((t) => t.returnOnNotional * notionalKrw);
  let equity = 0; let peak = 0; let maxDrawdown = 0; let streak = 0; let maxStreak = 0;
  const byDay = new Map();
  rows.forEach((t, i) => {
    equity += pnl[i]; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
    streak = pnl[i] < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak);
    const day = Math.floor(t.exitTime / DAY);
    byDay.set(day, (byDay.get(day) ?? 0) + pnl[i]);
  });
  const span = rows.length ? Math.max(DAY, rows.at(-1).exitTime - rows[0].entryTime) : null;
  const wins = pnl.filter((v) => v > 0);
  return {
    trades: rows.length,
    winRate: rows.length ? wins.length / rows.length : null,
    totalKrw: Math.round(equity),
    perYearKrw: span ? Math.round(equity * (365 * DAY / span)) : null,
    averageKrw: rows.length ? Math.round(equity / rows.length) : null,
    averageWinKrw: wins.length ? Math.round(wins.reduce((s, v) => s + v, 0) / wins.length) : null,
    averageLossKrw: pnl.some((v) => v < 0) ? Math.round(pnl.filter((v) => v < 0).reduce((s, v) => s + v, 0) / pnl.filter((v) => v < 0).length) : null,
    worstTradeKrw: rows.length ? Math.round(Math.min(...pnl)) : null,
    maxDrawdownKrw: Math.round(maxDrawdown),
    longestLosingStreak: maxStreak,
    daysOverDailyLimit: [...byDay.values()].filter((v) => v <= -dailyLossKrw).length,
    longs: rows.filter((t) => t.side === 'long').length,
    shorts: rows.filter((t) => t.side === 'short').length,
  };
}

function runSide({ symbol, bars, signals, side, variant, fundingRates }) {
  const flags = side === 'long' ? signals.long : signals.short;
  const result = runManagedExitBacktestV1({
    backtestInput: {
      market: 'CRYPTO_FUTURES', side, symbol, timeframe: `${variant.barHours}h`, candles: bars, fundingRates,
      initialCapital: 10_000_000, costModel: COST, riskModel: { riskPerTrade: 0.5, maximumCapitalFraction: 1, leverage: 2 },
    },
    strategy: 'trend_pilot_v1', strategyVersion: `TREND_PILOT:${variant.id}:${side}`,
    plan: { exit: variant.exit }, atrPeriod: 14,
    signalEvaluator: ({ index }) => (flags[index] ? { side } : null),
  });
  return result.trades.map((t) => ({
    side, symbol, entryTime: t.entryTime, exitTime: t.exitTime, exitReason: t.exitReason,
    returnOnNotional: t.entryNotional > 0 ? t.netPnl / t.entryNotional : 0,
  }));
}

/**
 * Pure: one variant on one symbol. Long and short runs are merged; a trade that
 * would overlap an open trade of the other side is dropped (one position at a time).
 */
export function evaluateTrendPilotSymbolV1({ symbol, candles, fundingRates = [], variant }) {
  const bars = resampleCandlesV1(candles, variant.barHours);
  if (bars.length < 260) return { symbol, status: 'INSUFFICIENT_BARS', bars: bars.length, trades: [] };
  const signals = trendSignalsV1(bars);
  const merged = [...runSide({ symbol, bars, signals, side: 'long', variant, fundingRates }),
    ...runSide({ symbol, bars, signals, side: 'short', variant, fundingRates })].sort((a, b) => a.entryTime - b.entryTime);
  const accepted = [];
  for (const trade of merged) {
    if (accepted.length && trade.entryTime < accepted.at(-1).exitTime) continue;
    accepted.push(trade);
  }
  return { symbol, status: 'COMPLETE', bars: bars.length, trades: accepted };
}

export function evaluateTrendPilotV1({ datasets, splitFraction = 0.6 }) {
  let first = Infinity; let last = -Infinity;
  for (const d of datasets) for (const c of d.candles) { if (c.timestamp < first) first = c.timestamp; if (c.timestamp > last) last = c.timestamp; }
  const split = first + ((last - first) * splitFraction);
  return TREND_PILOT_VARIANTS_V1.map((variant) => {
    const perSymbol = datasets.map((d) => evaluateTrendPilotSymbolV1({ ...d, variant }));
    const primary = perSymbol.filter((s) => TREND_PILOT_PRIMARY_SYMBOLS.includes(s.symbol)).flatMap((s) => s.trades);
    const others = perSymbol.filter((s) => !TREND_PILOT_PRIMARY_SYMBOLS.includes(s.symbol)).flatMap((s) => s.trades);
    return {
      variantId: variant.id,
      primary: {
        all: summarizeTradesKrwV1(primary),
        discovery: summarizeTradesKrwV1(primary.filter((t) => t.entryTime < split)),
        validation: summarizeTradesKrwV1(primary.filter((t) => t.entryTime >= split)),
      },
      otherSymbols: { symbols: perSymbol.length - TREND_PILOT_PRIMARY_SYMBOLS.length, all: summarizeTradesKrwV1(others) },
      perSymbol: perSymbol.map((s) => ({ symbol: s.symbol, status: s.status, ...summarizeTradesKrwV1(s.trades) })),
      splitDate: new Date(split).toISOString().slice(0, 10),
    };
  });
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export async function runTrendPilotBacktestV1({ stateRoot, now = () => new Date().toISOString(), symbols = null } = {}) {
  if (!stateRoot) throw new Error('TREND_PILOT_STATE_ROOT_REQUIRED');
  const root = resolve(String(stateRoot));
  const dir = join(root, 'combination-research', 'datasets', 'BITGET_1H');
  const { readdir } = await import('node:fs/promises');
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.endsWith('.failure.json')).sort(); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const datasets = [];
  for (const name of names) {
    const cached = await readJson(join(dir, name));
    const symbol = cached?.symbol ?? name.replace(/\.json$/u, '');
    if (symbols && !symbols.includes(symbol)) continue;
    const candles = (cached?.candles ?? []).filter((c) => c.timestamp < HOLDOUT_START);
    if (candles.length >= 24 * 300) datasets.push({ symbol, candles, fundingRates: (cached.fundingRates ?? []).filter((r) => r.timestamp < HOLDOUT_START) });
  }
  const primaryReady = TREND_PILOT_PRIMARY_SYMBOLS.every((s) => datasets.some((d) => d.symbol === s));
  const result = {
    contract: TREND_PILOT_CONTRACT_V1, observedAt: now(),
    status: primaryReady ? 'COMPLETE' : 'WAITING_FOR_DATA',
    notionalKrw: TREND_PILOT_NOTIONAL_KRW, dailyLossLimitKrw: TREND_PILOT_DAILY_LOSS_KRW,
    symbols: datasets.map((d) => d.symbol),
    fundingPrints: Object.fromEntries(datasets.map((d) => [d.symbol, d.fundingRates.length])),
    variants: primaryReady ? evaluateTrendPilotV1({ datasets }) : [],
    holdoutRead: false, liveTrading: false, realOrder: false, executionAuthority: 'NONE',
  };
  const path = join(root, 'latest', 'trend-pilot-backtest-v1.json');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(result)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(tmp, path);
  return result;
}

const won = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('ko-KR')}원` : '-');
const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '-');
const VARIANT_KO = { H4_CAP25: '4시간봉 · 손절 최대 2.5% (파일럿안)', D1_CAP25: '일봉 · 손절 최대 2.5%', D1_CLASSIC: '일봉 · 손절 3ATR (교과서형, 비교용)' };

export function formatTrendPilotReportKoV1(result) {
  const lines = [`BTC·ETH 롱숏 추세 추종 과거 성적 · 1회 ${won(result.notionalKrw)} 고정 · 수수료·슬리피지·펀딩 반영 · 2025년까지`, ''];
  if (result.status !== 'COMPLETE') return `${lines.join('\n')}데이터 대기: BTCUSDT·ETHUSDT 캐시 필요`;
  for (const v of result.variants) {
    const a = v.primary.all; const val = v.primary.validation;
    lines.push(`■ ${VARIANT_KO[v.variantId] ?? v.variantId}`);
    lines.push(`  전체: 거래 ${a.trades}회(롱 ${a.longs}·숏 ${a.shorts}) · 승률 ${pct(a.winRate)} · 합계 ${won(a.totalKrw)} · 연 ${won(a.perYearKrw)}`);
    lines.push(`  평균 이익 ${won(a.averageWinKrw)} · 평균 손실 ${won(a.averageLossKrw)} · 최악 1회 ${won(a.worstTradeKrw)} · 최대 낙폭 ${won(-a.maxDrawdownKrw)} · 최장 연패 ${a.longestLosingStreak}회`);
    lines.push(`  하루 손실 3만 원 넘은 날 ${a.daysOverDailyLimit}일 · 검증 구간(${v.splitDate}~) 합계 ${won(val.totalKrw)} (${val.trades}회)`);
    lines.push(`  참고 · 다른 코인 ${v.otherSymbols.symbols}개 같은 규칙: 합계 ${won(v.otherSymbols.all.totalKrw)} · 승률 ${pct(v.otherSymbols.all.winRate)}`);
  }
  const noFunding = Object.entries(result.fundingPrints ?? {}).filter(([, n]) => n < 100).map(([s]) => s);
  if (noFunding.length) lines.push('', `주의: 펀딩비 기록 없이 계산한 종목 ${noFunding.join(', ')} (선물 보유 비용 미반영 → 실제보다 조금 낙관적일 수 있음)`);
  lines.push('', '과거 성적일 뿐 미래 수익 보장 아님. 주문 권한 없음.');
  return lines.join('\n');
}

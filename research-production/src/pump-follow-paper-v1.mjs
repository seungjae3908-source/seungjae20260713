// Pump-follow forward paper ledger (종이매매, research only, executionAuthority NONE).
//
// The robustness-tested variant ① of the legend composite, unchanged:
//   entry  : a closed 1h bar up ≥ 5% on ≥ 5× its 7-day average volume → long at the next open
//   stop   : the signal bar low, clamped to 2–8%; chandelier trail 3 × ATR(24) from the highest high
//   exits  : no fixed target; out after 24 h if never +1R; max 10 days
//   sizing : 2% of equity at risk per trade (owner decision), at most 5 positions, gross ≤ 5×
// Every tick recomputes the whole ledger from Bitget public candles and funding, starting
// at the activation time that the first tick records — deterministic and idempotent, so the
// ledger cannot drift, double count or be edited by hand. It never places or suggests orders.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';
import { collectBitgetCandles } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { collectFundingRateHistory } from '../../market-prediction-lab/src/derivatives-history.js';
import { LEGEND_VARIANTS_V1, curveStats, simulateLegendCompositeV1, tradeSummary } from './legend-composite-v1.mjs';
import { INTRADAY_PERP_SYMBOLS_V1 } from './public-kline-fetch-v1.mjs';

export const PUMP_FOLLOW_PAPER_CONTRACT_V1 = 'pump-follow-paper/v1';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const PUMP_FOLLOW_PAPER_V1 = Object.freeze({
  variantId: 'V1_TRAIL', maxPositions: 5, fill: 'TAKER', riskPct: 0.02, startEquityKrw: 100_000,
  warmupDays: 60, symbols: INTRADAY_PERP_SYMBOLS_V1,
  // what the 2021–2025 backtest says to expect at 2% risk — the paper result is judged against it
  expectation: Object.freeze({ winRate: 0.37, avgWinRet: 0.093, avgLossRet: -0.039, tradesPerMonth: 13, cagr: 0.32, maxDrawdown: 0.27 }),
  // minimum sample before any conclusion is drawn
  minimumTrades: 30,
});

const fin = (v) => v !== null && v !== undefined && Number.isFinite(v);

/** Pure: drop the still-forming bar and anything malformed. */
export function closedBarsV1(candles, nowMs) {
  return candles.filter((c) => Number.isSafeInteger(c.timestamp) && c.timestamp + HOUR <= nowMs && [c.open, c.high, c.low, c.close].every((x) => fin(x) && x > 0) && c.high >= c.low)
    .sort((a, b) => a.timestamp - b.timestamp).filter((c, i, all) => i === 0 || c.timestamp > all[i - 1].timestamp);
}

/** Pure: the ledger from candles. `activatedAt` = first hour that may open a paper trade. */
export function computePumpFollowLedgerV1({ datasets, activatedAt, nowMs, spec = PUMP_FOLLOW_PAPER_V1 }) {
  const variant = LEGEND_VARIANTS_V1.find((v) => v.id === spec.variantId);
  const sim = simulateLegendCompositeV1({ venue: 'PERP_1H', datasets, variant, maxPositions: spec.maxPositions, fill: spec.fill,
    params: { riskPct: spec.riskPct }, entryFrom: activatedAt, closeAtEnd: false });
  // equity is 1.0 at activation: rescale the curve (nothing can trade before activatedAt)
  const base = sim.curve.find((c) => c.t >= activatedAt)?.equity ?? 1;
  const curve = sim.curve.filter((c) => c.t >= activatedAt).map((c) => ({ t: c.t, equity: c.equity / base }));
  const lastEq = curve.at(-1)?.equity ?? 1;
  const trades = sim.trades.filter((t) => t.entryT >= activatedAt);
  const summary = tradeSummary(trades);
  const stats = curveStats(curve, activatedAt, nowMs + 1);
  const months = Math.max(1 / 30, (nowMs - activatedAt) / (30.4375 * DAY));
  const k = spec.startEquityKrw;
  return {
    activatedAt: new Date(activatedAt).toISOString(), asOf: new Date(nowMs).toISOString(), days: (nowMs - activatedAt) / DAY,
    equityKrw: k * lastEq, totalReturn: lastEq - 1, maxDrawdown: stats.maxDrawdown ?? 0,
    closedTrades: trades.map((t) => ({ symbol: t.symbol, entryAt: new Date(t.entryT).toISOString(), exitAt: new Date(t.exitT).toISOString(), entry: t.entry, exit: t.exit,
      ret: t.ret, pnlKrw: k * t.pnl / base, reason: t.reason, hours: t.bars })),
    openPositions: sim.openPositions.map((p) => ({ symbol: p.symbol, entryAt: new Date(p.entryT).toISOString(), entry: p.entry, stop: p.stop, last: p.lastPx,
      unrealizedRet: p.unrealizedRet, unrealizedKrw: k * p.unrealized / base, hours: p.held })),
    summary: { ...summary, tradesPerMonth: (summary.n ?? 0) / months },
    vsExpectation: verdictVsExpectationV1(summary, spec),
    executionAuthority: 'NONE', liveTrading: false, realOrder: false,
  };
}

/** Pure: is the forward sample consistent with the backtest? Only after the minimum sample. */
export function verdictVsExpectationV1(summary, spec = PUMP_FOLLOW_PAPER_V1) {
  const n = summary.n ?? 0;
  if (n < spec.minimumTrades) return { status: 'COLLECTING', trades: n, needed: spec.minimumTrades };
  const e = spec.expectation;
  const expectedPerTrade = (e.winRate * e.avgWinRet) + ((1 - e.winRate) * e.avgLossRet);
  const observedPerTrade = ((summary.winRate ?? 0) * (summary.avgWinRet ?? 0)) + ((1 - (summary.winRate ?? 0)) * (summary.avgLossRet ?? 0));
  // binomial band on the win rate (2 standard errors)
  const se = Math.sqrt((e.winRate * (1 - e.winRate)) / n);
  const winRateOk = Math.abs((summary.winRate ?? 0) - e.winRate) <= 2 * se;
  const status = observedPerTrade > 0 && winRateOk ? 'CONSISTENT' : observedPerTrade > 0 ? 'POSITIVE_BUT_DIFFERENT' : 'BELOW_EXPECTATION';
  return { status, trades: n, expectedPerTrade, observedPerTrade, winRateBand: [e.winRate - (2 * se), e.winRate + (2 * se)] };
}

async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
async function writeAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' }); await rename(tmp, path);
}

export async function runPumpFollowPaperV1({ stateRoot, now = () => Date.now(), fetchImpl = globalThis.fetch, spec = PUMP_FOLLOW_PAPER_V1 } = {}) {
  if (!stateRoot) throw new Error('PUMP_FOLLOW_STATE_ROOT_REQUIRED');
  const nowMs = now();
  const statePath = join(stateRoot, 'pump-follow-paper', 'activation.json');
  let activation = await readJson(statePath);
  if (!activation) {
    activation = { contract: PUMP_FOLLOW_PAPER_CONTRACT_V1, activatedAt: Math.ceil(nowMs / HOUR) * HOUR, spec: { ...spec, symbols: [...spec.symbols] } };
    await writeAtomic(statePath, activation);
  }
  const activatedAt = activation.activatedAt;
  const client = new BitgetPublicClient({ fetchImpl });
  const startTime = activatedAt - (spec.warmupDays * DAY);
  const datasets = []; const failures = [];
  for (const symbol of spec.symbols) {
    try {
      const raw = (await collectBitgetCandles({ client, market: 'CRYPTO_FUTURES', symbol, timeframe: '1h', startTime, endTime: nowMs, maxCandles: 20_000, productType: 'usdt-futures' })).candles;
      const candles = closedBarsV1(raw, nowMs);
      let fundingRates = [];
      try { fundingRates = (await collectFundingRateHistory({ client, symbol, startTime: activatedAt - DAY, endTime: nowMs, maxPages: 20 })).records.map((r) => ({ timestamp: r.timestamp, rate: r.rate })); }
      catch (error) { failures.push({ symbol, stage: 'FUNDING', error: String(error?.message ?? error).slice(0, 120) }); }
      if (candles.length < 24 * 51) { failures.push({ symbol, stage: 'CANDLES', error: `SHORT_HISTORY_${candles.length}` }); continue; }
      datasets.push({ symbol, candles, fundingRates });
    } catch (error) { failures.push({ symbol, stage: 'CANDLES', error: String(error?.message ?? error).slice(0, 120) }); }
  }
  const ledger = computePumpFollowLedgerV1({ datasets, activatedAt, nowMs, spec });
  const result = { contract: PUMP_FOLLOW_PAPER_CONTRACT_V1, observedAt: new Date(nowMs).toISOString(), symbolsWatched: datasets.map((d) => d.symbol), failures, ...ledger };
  await writeAtomic(join(stateRoot, 'latest', 'pump-follow-paper-v1.json'), result);
  return result;
}

const pct = (v, d = 1) => (fin(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '-');
const won = (v) => (fin(v) ? `${Math.round(v).toLocaleString('ko-KR')}원` : '-');
const STATUS_KO = { COLLECTING: '표본 모으는 중', CONSISTENT: '백테스트와 일치', POSITIVE_BUT_DIFFERENT: '수익은 나지만 승률이 백테스트와 다름', BELOW_EXPECTATION: '⚠️ 백테스트보다 나쁨' };

export function formatPumpFollowPaperKoV1(r) {
  const s = r.summary ?? {}; const v = r.vsExpectation ?? {};
  const lines = [
    `급등 따라타기 종이매매 (비트겟 선물 ${r.symbolsWatched?.length ?? 0}종목 감시 · 1회 위험 2% · 최대 5종목 · 실제 주문 없음)`,
    `시작 ${r.activatedAt?.slice(0, 16).replace('T', ' ')} UTC · ${(r.days ?? 0).toFixed(1)}일째 · 10만 원 → ${won(r.equityKrw)} (${pct(r.totalReturn)}) · 최대 낙폭 ${pct(-(r.maxDrawdown ?? 0))}`,
    `청산 ${s.n ?? 0}회 · 승률 ${pct(s.winRate, 0)} · 평균 이익 ${pct(s.avgWinRet)} / 손실 ${pct(s.avgLossRet)} · 최고 ${pct(s.bestRet, 0)} · 월 ${(s.tradesPerMonth ?? 0).toFixed(1)}회`,
    `판정: ${STATUS_KO[v.status] ?? '-'}${v.status === 'COLLECTING' ? ` (${v.trades}/${v.needed}회)` : ` · 1회 기대 ${pct(v.expectedPerTrade, 2)} vs 실제 ${pct(v.observedPerTrade, 2)}`}`,
  ];
  if (r.openPositions?.length) {
    lines.push('보유 중:');
    for (const p of r.openPositions) lines.push(`  ${p.symbol} ${p.entryAt.slice(5, 16).replace('T', ' ')} 진입 ${p.entry} → 현재 ${p.last} (${pct(p.unrealizedRet)}) · 손절선 ${p.stop.toPrecision(6)} · ${p.hours}시간`);
  }
  const recent = (r.closedTrades ?? []).slice(-5).reverse();
  if (recent.length) { lines.push('최근 청산:'); for (const t of recent) lines.push(`  ${t.symbol} ${pct(t.ret)} (${won(t.pnlKrw)}) · ${t.hours}시간 · ${t.reason}`); }
  if (r.failures?.length) lines.push(`데이터 실패 ${r.failures.length}건: ${r.failures.slice(0, 3).map((f) => `${f.symbol}:${f.stage}`).join(', ')}`);
  return lines.join('\n');
}

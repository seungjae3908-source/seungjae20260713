// Funding-rate carry backtest (research only, no orders).
//
// Position: buy spot and short the USDT perpetual for the same notional, so the
// price moves cancel and the short collects funding while the rate is positive.
// Uses the funding history already cached for the coin-futures research
// (Bitget, or the labelled Binance proxy where Bitget history is short).
//
// Pre-registered variants (decided before any result):
//   ALWAYS      hold the hedge the whole time (baseline)
//   AVG3D_1BP   enter when the last 9 funding prints (3 days) average ≥ 0.01%/8h,
//               exit when that average ≤ 0
//   AVG3D_2BP   same with entry ≥ 0.02%/8h
// Costs per round trip: 4 legs (spot buy/sell, perp sell/buy) of fee + slippage.
// Capital: spot notional + perp margin at 1x = 2 × notional (conservative).
// Limitation: spot-perp basis at entry/exit is not modelled (no spot series in
// the cache); it is usually small for liquid pairs but can matter in spikes.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const FUNDING_CARRY_CONTRACT_V1 = 'funding-carry-backtest/v1';
export const FUNDING_CARRY_VERSION_V1 = '1.0.0';
const HOLDOUT_START = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;
const YEAR = 365 * DAY;

export const FUNDING_CARRY_COSTS_V1 = Object.freeze({
  spotFeeRate: 0.001, perpFeeRate: 0.0006, slippageRate: 0.0005,
});

export const FUNDING_CARRY_VARIANTS_V1 = Object.freeze([
  Object.freeze({ id: 'ALWAYS', lookback: 9, entry: -Infinity, exit: -Infinity }),
  Object.freeze({ id: 'AVG3D_1BP', lookback: 9, entry: 0.0001, exit: 0 }),
  Object.freeze({ id: 'AVG3D_2BP', lookback: 9, entry: 0.0002, exit: 0 }),
]);

export const FUNDING_CARRY_POLICY_V1 = Object.freeze({
  discoveryFraction: 0.6,
  capitalPerNotional: 2,
  minimumFundingRows: 300,
  refreshDays: 7,
});

export function roundTripCostV1(costs = FUNDING_CARRY_COSTS_V1) {
  return (2 * costs.spotFeeRate) + (2 * costs.perpFeeRate) + (4 * costs.slippageRate);
}

/**
 * Pure simulation on one symbol's funding prints [{ timestamp, rate }] (sorted).
 * The decision at print i uses prints before i only; the position held into
 * print i collects (or pays) that print.
 */
export function simulateFundingCarryV1(rows, variant, { costs = FUNDING_CARRY_COSTS_V1 } = {}) {
  const cost = roundTripCostV1(costs) / 2; // half on entry, half on exit
  const events = [];
  let inPosition = false;
  let trades = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const window = rows.slice(Math.max(0, i - variant.lookback), i).map((r) => r.rate);
    const avg = window.length === variant.lookback ? window.reduce((s, v) => s + v, 0) / window.length : null;
    let pnl = 0;
    if (!inPosition && (variant.entry === -Infinity || (avg !== null && avg >= variant.entry))) {
      inPosition = true; trades += 1; pnl -= cost;
    } else if (inPosition && variant.exit !== -Infinity && avg !== null && avg <= variant.exit) {
      inPosition = false; pnl -= cost;
    }
    if (inPosition) pnl += rows[i].rate;
    events.push({ timestamp: rows[i].timestamp, pnl, inPosition });
  }
  if (inPosition && events.length) events[events.length - 1].pnl -= cost;
  return { events, trades };
}

function summarize(events, trades, capitalPerNotional) {
  if (!events.length) return { prints: 0, trades: 0, netReturnOnCapital: null, annualized: null, timeInPosition: null, worst30d: null };
  const span = Math.max(DAY, events.at(-1).timestamp - events[0].timestamp);
  const total = events.reduce((s, e) => s + e.pnl, 0) / capitalPerNotional;
  let worst = 0;
  for (let i = 0, j = 0, sum = 0; i < events.length; i += 1) {
    sum += events[i].pnl;
    while (events[i].timestamp - events[j].timestamp > 30 * DAY) { sum -= events[j].pnl; j += 1; }
    worst = Math.min(worst, sum / capitalPerNotional);
  }
  return {
    prints: events.length,
    trades,
    netReturnOnCapital: total,
    annualized: total * (YEAR / span),
    timeInPosition: events.filter((e) => e.inPosition).length / events.length,
    worst30d: worst,
  };
}

const round = (value, digits = 5) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const roundAll = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v]));

/** Pure: every variant on every symbol, split into discovery and validation by time. */
export function evaluateFundingCarryV1({ datasets, policy = FUNDING_CARRY_POLICY_V1, costs = FUNDING_CARRY_COSTS_V1 }) {
  const all = datasets.flatMap((d) => d.rows.map((r) => r.timestamp));
  const first = Math.min(...all); const last = Math.max(...all);
  const split = first + ((last - first) * policy.discoveryFraction);
  const variants = FUNDING_CARRY_VARIANTS_V1.map((variant) => {
    const perSymbol = datasets.map((d) => {
      const { events, trades } = simulateFundingCarryV1(d.rows, variant, { costs });
      const discovery = events.filter((e) => e.timestamp < split);
      const validation = events.filter((e) => e.timestamp >= split);
      return {
        symbol: d.symbol, source: d.source,
        discovery: roundAll(summarize(discovery, trades, policy.capitalPerNotional)),
        validation: roundAll(summarize(validation, trades, policy.capitalPerNotional)),
      };
    });
    const valid = perSymbol.filter((s) => Number.isFinite(s.validation.annualized));
    const mean = (rows, key) => (rows.length ? rows.reduce((s, r) => s + r[key], 0) / rows.length : null);
    return {
      variantId: variant.id,
      validationAnnualizedMean: round(mean(valid.map((s) => s.validation), 'annualized')),
      discoveryAnnualizedMean: round(mean(perSymbol.filter((s) => Number.isFinite(s.discovery.annualized)).map((s) => s.discovery), 'annualized')),
      positiveSymbols: valid.filter((s) => s.validation.annualized > 0).length,
      symbols: valid.length,
      worst30dWorstSymbol: round(Math.min(...valid.map((s) => s.validation.worst30d))),
      perSymbol: perSymbol.sort((a, b) => (b.validation.annualized ?? -9) - (a.validation.annualized ?? -9)),
    };
  });
  const viable = variants.filter((v) => v.variantId !== 'ALWAYS' && v.validationAnnualizedMean > 0 && v.discoveryAnnualizedMean > 0
    && v.positiveSymbols >= Math.ceil(v.symbols * 0.6));
  const best = viable.sort((a, b) => b.validationAnnualizedMean - a.validationAnnualizedMean)[0] ?? null;
  return {
    splitDate: new Date(split).toISOString().slice(0, 10),
    roundTripCost: round(roundTripCostV1(costs)),
    variants,
    verdict: best ? { status: 'VIABLE', variantId: best.variantId, validationAnnualizedMean: best.validationAnnualizedMean }
      : { status: 'NOT_VIABLE', variantId: null, validationAnnualizedMean: null },
  };
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

export async function runFundingCarryBacktestV1({ stateRoot, researchCodeSha = null, now = () => new Date().toISOString(), policy = FUNDING_CARRY_POLICY_V1, force = false } = {}) {
  if (!stateRoot) throw new Error('FUNDING_CARRY_STATE_ROOT_REQUIRED');
  const root = resolve(String(stateRoot));
  const observedAt = now();
  const dir = join(root, 'combination-research', 'datasets', 'BITGET_1H');
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.endsWith('.failure.json')).sort(); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const datasets = [];
  for (const name of names) {
    const cached = await readJson(join(dir, name));
    const rows = (cached?.fundingRates ?? []).filter((r) => r.timestamp < HOLDOUT_START && Number.isFinite(r.rate))
      .sort((a, b) => a.timestamp - b.timestamp);
    if (rows.length >= policy.minimumFundingRows) datasets.push({ symbol: cached.symbol ?? name.replace(/\.json$/u, ''), source: cached.fundingSource ?? null, rows });
  }
  const latestPath = join(root, 'latest', 'funding-carry-backtest-v1.json');
  const key = createHash('sha256').update([FUNDING_CARRY_VERSION_V1, researchCodeSha ?? '', ...datasets.map((d) => `${d.symbol}:${d.rows.length}:${d.rows.at(-1).timestamp}`)].join('|')).digest('hex').slice(0, 24);
  const prior = await readJson(latestPath);
  if (!force && prior?.key === key && Date.parse(observedAt) - Date.parse(prior.observedAt) < policy.refreshDays * DAY) return prior;
  const result = Object.freeze({
    contract: FUNDING_CARRY_CONTRACT_V1, version: FUNDING_CARRY_VERSION_V1, key, observedAt, researchCodeSha,
    status: datasets.length >= 3 ? 'COMPLETE' : 'WAITING_FOR_DATA',
    symbols: datasets.map((d) => ({ symbol: d.symbol, source: d.source, prints: d.rows.length })),
    ...(datasets.length >= 3 ? evaluateFundingCarryV1({ datasets, policy }) : {}),
    basisModelled: false, holdoutRead: false, liveTrading: false, realOrder: false, executionAuthority: 'NONE',
  });
  await atomicJson(latestPath, result);
  return result;
}

const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '-');
const VARIANT_KO = { ALWAYS: '항상 보유(기준선)', AVG3D_1BP: '3일 평균 0.01%/8h 이상일 때만', AVG3D_2BP: '3일 평균 0.02%/8h 이상일 때만' };

export function formatFundingCarryReportKoV1(result) {
  const lines = ['펀딩비 차익(현물 매수 + 선물 숏) 과거 수익 · 2025년까지 · 수수료·슬리피지 4번 반영 · 자본 = 명목 × 2', ''];
  if (result.status !== 'COMPLETE') return `${lines.join('\n')}데이터 대기: 펀딩 기록이 충분한 종목 ${result.symbols?.length ?? 0}개`;
  lines.push(`검증 구간 시작 ${result.splitDate} · 왕복 비용 ${pct(result.roundTripCost)}`);
  for (const v of result.variants) {
    lines.push(`■ ${VARIANT_KO[v.variantId] ?? v.variantId}: 검증 연환산 ${pct(v.validationAnnualizedMean)} (탐색 ${pct(v.discoveryAnnualizedMean)}) · 플러스 종목 ${v.positiveSymbols}/${v.symbols} · 최악 30일 ${pct(v.worst30dWorstSymbol)}`);
    for (const s of v.perSymbol.slice(0, 5)) lines.push(`   ${s.symbol}: ${pct(s.validation.annualized)} · 보유 비율 ${pct(s.validation.timeInPosition)} · 진입 ${s.validation.trades}회`);
  }
  lines.push('', result.verdict.status === 'VIABLE'
    ? `→ 실거래 후보: ${VARIANT_KO[result.verdict.variantId]} (검증 연환산 ${pct(result.verdict.validationAnnualizedMean)})`
    : '→ 실거래 후보 없음: 수수료를 빼면 꾸준한 플러스가 아님');
  lines.push('주의: 진입·청산 시 현물-선물 가격 차이(베이시스)는 반영 안 됨. 주문 권한 없음.');
  return lines.join('\n');
}

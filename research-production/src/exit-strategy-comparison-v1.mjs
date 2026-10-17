// Exit-strategy comparison for the coin lanes (research only, no orders).
//
// Question: for the same entry signals, which way of entering and leaving pays
// best after costs and funding?
//   entries  SINGLE   full risk-sized position at the signal
//            PYRAMID  half at the signal, the other half only at +1R
//   exits    FIXED_FULL     stop 2 ATR, all out at 2R
//            FIXED_SCALED   30% at 1R, 30% at 2R, rest at 3R, breakeven after 1R
//            TRAIL_FULL     no target, 3 ATR chandelier trail
//            TRAIL_SCALED   30% at 1R, 30% at 2R, rest on the 3 ATR trail
//   common   time stop: out after 12 bars if it never reached +0.5R
//
// The 8 variants, the signal sets and the winner rule are fixed here before any
// result is seen. Data: the combination-research cache (pre-2026 only), same
// 60/40 discovery/validation split and the same never-selected unseen symbols.
// The sealed 2026 holdout is not read.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { RESEARCH_LANES_V2 } from './autonomous-research-discovery-v2.mjs';
import { computeCombinationAtomsV1 } from './combination-atoms-v1.mjs';
import {
  COMBINATION_POLICY_V1,
  COMBINATION_UNIVERSE_V1,
  LANE_DATA_SOURCE_V1,
  combinationRiskModelV1,
} from './combination-search-lane-v1.mjs';
import { runManagedExitBacktestV1 } from './managed-exit-backtest-v1.mjs';

export const EXIT_COMPARISON_CONTRACT_V1 = 'exit-strategy-comparison/v1';
export const EXIT_COMPARISON_VERSION_V1 = '1.0.0';
const HOLDOUT_START = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;

const STOP_ATR = 2;
const TIME_STOP = Object.freeze({ bars: 12, minFavorableR: 0.5 });
const SCALE = Object.freeze([Object.freeze({ atR: 1, fraction: 0.3 }), Object.freeze({ atR: 2, fraction: 0.3 })]);

export const EXIT_PROFILES_V1 = Object.freeze({
  FIXED_FULL: Object.freeze({ stopAtrMultiple: STOP_ATR, targetR: 2, timeStop: TIME_STOP, maxHoldBars: 48 }),
  FIXED_SCALED: Object.freeze({ stopAtrMultiple: STOP_ATR, targetR: 3, partials: SCALE, breakevenAfterR: 1, timeStop: TIME_STOP, maxHoldBars: 48 }),
  TRAIL_FULL: Object.freeze({ stopAtrMultiple: STOP_ATR, targetR: null, trailing: Object.freeze({ atrMultiple: 3 }), timeStop: TIME_STOP, maxHoldBars: 240 }),
  TRAIL_SCALED: Object.freeze({ stopAtrMultiple: STOP_ATR, targetR: null, partials: SCALE, breakevenAfterR: 1, trailing: Object.freeze({ atrMultiple: 3 }), timeStop: TIME_STOP, maxHoldBars: 240 }),
});

export const ENTRY_PROFILES_V1 = Object.freeze({
  SINGLE: Object.freeze({ initialFraction: 1 }),
  PYRAMID: Object.freeze({ initialFraction: 0.5, adds: Object.freeze([Object.freeze({ atR: 1, fraction: 0.5 })]), moveStopToEntryOnAdd: true }),
});

export const EXIT_COMPARISON_VARIANTS_V1 = Object.freeze(Object.keys(ENTRY_PROFILES_V1).flatMap((entryId) => Object.keys(EXIT_PROFILES_V1)
  .map((exitId) => Object.freeze({ id: `${entryId}+${exitId}`, entryId, exitId }))));

export const EXIT_COMPARISON_BASELINE_VARIANT_V1 = 'SINGLE+FIXED_FULL';

// Entry signals per lane, chosen before results. ALWAYS (enter whenever flat)
// isolates the effect of the exit from the quality of the entry.
export const EXIT_COMPARISON_SIGNAL_SETS_V1 = Object.freeze({
  CRYPTO_FUTURES_LONG: Object.freeze([
    Object.freeze({ id: 'SURGE_BREAKOUT', atoms: Object.freeze(['P_SURGE_BREAKOUT_LONG']), label: '급등 시작(수축 뒤 거래량 동반 돌파)' }),
    Object.freeze({ id: 'TREND_BREAKOUT', atoms: Object.freeze(['P_DONCHIAN20_BREAKOUT', 'T_EMA50_ABOVE_EMA200']), label: '정배열 + 20봉 고가 돌파' }),
    Object.freeze({ id: 'ALWAYS', atoms: Object.freeze([]), label: '조건 없음(청산 효과만 비교)' }),
  ]),
  CRYPTO_FUTURES_SHORT: Object.freeze([
    Object.freeze({ id: 'POST_SURGE_BREAK', atoms: Object.freeze(['P_POST_SURGE_BREAK_SHORT']), label: '급등 후 하락 전환' }),
    Object.freeze({ id: 'DEADCROSS_DOUBLE_TOP', atoms: Object.freeze(['M_MACD_CROSS_DOWN', 'P_DOUBLE_TOP_BREAK']), label: 'MACD 데드크로스 + 쌍봉 넥라인 이탈' }),
    Object.freeze({ id: 'ALWAYS', atoms: Object.freeze([]), label: '조건 없음(청산 효과만 비교)' }),
  ]),
  CRYPTO_SPOT_LONG: Object.freeze([
    Object.freeze({ id: 'SURGE_BREAKOUT', atoms: Object.freeze(['P_SURGE_BREAKOUT_LONG']), label: '급등 시작(수축 뒤 거래량 동반 돌파)' }),
    Object.freeze({ id: 'TREND_BREAKOUT', atoms: Object.freeze(['P_DONCHIAN20_BREAKOUT', 'T_EMA50_ABOVE_EMA200']), label: '정배열 + 20봉 고가 돌파' }),
    Object.freeze({ id: 'ALWAYS', atoms: Object.freeze([]), label: '조건 없음(청산 효과만 비교)' }),
  ]),
});

export const EXIT_COMPARISON_POLICY_V1 = Object.freeze({
  minimumValidationTrades: 20,
  minimumUnseenTrades: 10,
  refreshDays: 7,
});

// ---------- small utilities ----------

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
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

const round = (value, digits = 4) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

/** Pure summary of per-trade R multiples in time order. */
export function summarizeRMultiplesV1(rows) {
  const r = rows.map((row) => row.r).filter(Number.isFinite);
  const n = r.length;
  if (n === 0) return Object.freeze({ trades: 0, meanR: null, ciLow95: null, tStat: null, winRate: null, profitFactor: null, averageWinR: null, averageLossR: null, maxConsecutiveLosses: 0, maxDrawdownR: 0, meanReturn: null });
  const meanR = r.reduce((sum, value) => sum + value, 0) / n;
  const variance = n > 1 ? r.reduce((sum, value) => sum + ((value - meanR) ** 2), 0) / (n - 1) : 0;
  const se = n > 1 ? Math.sqrt(variance / n) : null;
  const wins = r.filter((value) => value > 0);
  const losses = r.filter((value) => value < 0);
  const grossWin = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let streak = 0; let maxStreak = 0; let equity = 0; let peak = 0; let maxDrawdown = 0;
  for (const value of r) {
    streak = value < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const returns = rows.map((row) => row.ret).filter(Number.isFinite);
  return Object.freeze({
    trades: n,
    meanR: round(meanR),
    ciLow95: se === null ? null : round(meanR - (1.96 * se)),
    tStat: se === null || se === 0 ? null : round(meanR / se, 3),
    winRate: round(wins.length / n),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 3) : null,
    averageWinR: wins.length ? round(grossWin / wins.length) : null,
    averageLossR: losses.length ? round(grossLoss / losses.length) : null,
    maxConsecutiveLosses: maxStreak,
    maxDrawdownR: round(maxDrawdown, 2),
    meanReturn: returns.length ? round(returns.reduce((sum, value) => sum + value, 0) / returns.length, 6) : null,
  });
}

function splitTimeFor(candles, policy = COMBINATION_POLICY_V1) {
  const first = candles[0].timestamp;
  return first + Math.floor((candles.at(-1).timestamp - first) * policy.discoveryFraction);
}

// ---------- evaluation ----------

function runVariantOnDataset({ lane, data, signalSet, variant }) {
  const arrays = signalSet.atoms.map((id) => {
    const array = data.atoms.get(id);
    if (!array) throw new Error(`EXIT_COMPARISON_ATOM_UNKNOWN:${id}`);
    return array;
  });
  const result = runManagedExitBacktestV1({
    backtestInput: {
      market: lane.market, side: lane.direction === 'SHORT' ? 'short' : 'long', symbol: data.symbol, timeframe: lane.timeframe,
      candles: data.candles, fundingRates: data.fundingRates ?? [], initialCapital: lane.initialCapital,
      costModel: { ...lane.cost }, riskModel: combinationRiskModelV1(lane),
    },
    strategy: 'exit_comparison_v1',
    strategyVersion: `EXITCMP:${lane.id}:${signalSet.id}:${variant.id}`,
    plan: { exit: EXIT_PROFILES_V1[variant.exitId], entry: ENTRY_PROFILES_V1[variant.entryId] },
    signalEvaluator: ({ index }) => (arrays.every((array) => array[index] === 1) ? { signal: signalSet.id } : null),
  });
  return result.trades
    .filter((trade) => trade.equityBefore > 0)
    .map((trade) => ({ signalTime: trade.signalTime, r: trade.rMultiple, ret: trade.netPnl / trade.equityBefore, reason: trade.exitReason, bars: trade.barsHeld }));
}

function exitReasonMix(rows) {
  const counts = {};
  for (const row of rows) {
    const key = row.reason.startsWith('partial_') ? 'partial' : row.reason;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([key, count]) => [key, round(count / rows.length, 3)]));
}

/** Pre-registered winner rule. */
export function pickExitWinnerV1(variants, policy = EXIT_COMPARISON_POLICY_V1) {
  const eligible = variants.filter((row) => row.validation.trades >= policy.minimumValidationTrades
    && row.validation.meanR > 0
    && row.unseen.trades >= policy.minimumUnseenTrades
    && row.unseen.meanR > 0);
  if (!eligible.length) return Object.freeze({ status: 'NO_WINNER', variantId: null, reason: 'NO_VARIANT_POSITIVE_ON_VALIDATION_AND_UNSEEN' });
  const best = [...eligible].sort((a, b) => b.validation.meanR - a.validation.meanR || a.variantId.localeCompare(b.variantId))[0];
  const baseline = variants.find((row) => row.variantId === EXIT_COMPARISON_BASELINE_VARIANT_V1);
  return Object.freeze({
    status: 'WINNER',
    variantId: best.variantId,
    validationMeanR: best.validation.meanR,
    baselineValidationMeanR: baseline?.validation.meanR ?? null,
    // Not a significance test against the baseline; trades differ by variant.
    upliftVsBaselineR: baseline && Number.isFinite(baseline.validation.meanR) ? round(best.validation.meanR - baseline.validation.meanR) : null,
    validationCiLowAboveZero: Number.isFinite(best.validation.ciLow95) && best.validation.ciLow95 > 0,
  });
}

/** Evaluates all 8 variants for every signal set of one lane. Pure given datasets. */
export function evaluateExitComparisonLaneV1({ lane, seen, unseen, signalSets = EXIT_COMPARISON_SIGNAL_SETS_V1[lane.id] ?? [], policy = EXIT_COMPARISON_POLICY_V1 }) {
  return Object.freeze(signalSets.map((signalSet) => {
    const variants = EXIT_COMPARISON_VARIANTS_V1.map((variant) => {
      const discovery = []; const validation = []; const unseenRows = [];
      for (const data of seen) {
        for (const row of runVariantOnDataset({ lane, data, signalSet, variant })) (row.signalTime < data.splitTime ? discovery : validation).push(row);
      }
      for (const data of unseen) unseenRows.push(...runVariantOnDataset({ lane, data, signalSet, variant }));
      const byTime = (a, b) => a.signalTime - b.signalTime;
      const all = [...validation, ...unseenRows];
      return Object.freeze({
        variantId: variant.id, entryId: variant.entryId, exitId: variant.exitId,
        discovery: summarizeRMultiplesV1(discovery.sort(byTime)),
        validation: summarizeRMultiplesV1(validation.sort(byTime)),
        unseen: summarizeRMultiplesV1(unseenRows.sort(byTime)),
        exitReasons: all.length ? exitReasonMix(all) : {},
        averageBarsHeld: all.length ? round(all.reduce((sum, row) => sum + row.bars, 0) / all.length, 1) : null,
      });
    });
    return Object.freeze({ signalSetId: signalSet.id, label: signalSet.label, atoms: signalSet.atoms, variants: Object.freeze(variants), winner: pickExitWinnerV1(variants, policy) });
  }));
}

// ---------- runner over the combination-research cache ----------

async function loadCachedSource(root, source, universe) {
  const spec = universe[source];
  const out = [];
  for (const symbol of spec.symbols) {
    const cached = await readJson(join(root, 'combination-research', 'datasets', source, `${symbol}.json`));
    if (!cached?.candles?.length) continue;
    const candles = cached.candles.filter((row) => row.timestamp < HOLDOUT_START);
    if (candles.length < 300) continue;
    out.push({
      symbol, timeframe: cached.timeframe ?? spec.timeframe, candles,
      fundingRates: (cached.fundingRates ?? []).filter((row) => row.timestamp < HOLDOUT_START),
      atoms: computeCombinationAtomsV1(candles, { timeframe: cached.timeframe ?? spec.timeframe }),
      splitTime: splitTimeFor(candles),
    });
  }
  const stride = COMBINATION_POLICY_V1.unseenSymbolStride;
  const isUnseen = (symbol) => stride > 0 && spec.symbols.indexOf(symbol) % stride === stride - 1;
  return { seen: out.filter((row) => !isUnseen(row.symbol)), unseen: out.filter((row) => isUnseen(row.symbol)), expected: spec.symbols.length };
}

/**
 * One bounded tick. Each lane is recomputed only when its code or data key
 * changed or it is older than refreshDays; results stay readable in between.
 */
export async function runExitStrategyComparisonV1({
  stateRoot,
  researchCodeSha = null,
  now = () => new Date().toISOString(),
  clock = () => Date.now(),
  budgetMs = 90_000,
  lanes = RESEARCH_LANES_V2.filter((lane) => EXIT_COMPARISON_SIGNAL_SETS_V1[lane.id]),
  universe = COMBINATION_UNIVERSE_V1,
  policy = EXIT_COMPARISON_POLICY_V1,
} = {}) {
  if (!stateRoot) throw new Error('EXIT_COMPARISON_STATE_ROOT_REQUIRED');
  const root = resolve(String(stateRoot));
  const observedAt = now();
  const observedAtMs = Date.parse(observedAt);
  const deadline = clock() + budgetMs;
  const sources = new Map();
  const summaries = [];
  for (const lane of lanes) {
    const statePath = join(root, 'exit-comparison', 'lanes', `${lane.id}.json`);
    const prior = await readJson(statePath);
    const source = LANE_DATA_SOURCE_V1[lane.id];
    if (!source) continue;
    if (clock() > deadline) { summaries.push(prior ?? { laneId: lane.id, status: 'PENDING_NEXT_TICK' }); continue; }
    if (!sources.has(source)) sources.set(source, await loadCachedSource(root, source, universe));
    const { seen, unseen, expected } = sources.get(source);
    if (seen.length < COMBINATION_POLICY_V1.minimumSymbols || seen.length + unseen.length < expected) {
      summaries.push({ laneId: lane.id, status: 'WAITING_FOR_DATA', symbols: seen.length + unseen.length, expectedSymbols: expected });
      continue;
    }
    const key = sha256([EXIT_COMPARISON_VERSION_V1, researchCodeSha ?? '', lane.id,
      ...[...seen, ...unseen].map((row) => `${row.symbol}:${row.candles.length}:${row.candles.at(-1).timestamp}:${row.fundingRates.length}`)].join('|')).slice(0, 24);
    const fresh = prior?.key === key && Number.isFinite(Date.parse(prior?.computedAt)) && observedAtMs - Date.parse(prior.computedAt) < policy.refreshDays * DAY;
    if (fresh) { summaries.push(prior); continue; }
    const started = clock();
    const signalSets = evaluateExitComparisonLaneV1({ lane, seen, unseen, policy });
    const laneResult = {
      contract: EXIT_COMPARISON_CONTRACT_V1, version: EXIT_COMPARISON_VERSION_V1,
      laneId: lane.id, market: lane.market, direction: lane.direction, status: 'COMPLETE', key, computedAt: observedAt,
      elapsedMs: clock() - started, researchCodeSha,
      symbols: { seen: seen.map((row) => row.symbol), unseen: unseen.map((row) => row.symbol) },
      period: { start: new Date(Math.min(...seen.map((row) => row.candles[0].timestamp))).toISOString().slice(0, 10), end: '2025-12-31', holdoutRead: false },
      signalSets,
    };
    await atomicJson(statePath, laneResult);
    summaries.push(laneResult);
  }
  const result = Object.freeze({
    contract: EXIT_COMPARISON_CONTRACT_V1, version: EXIT_COMPARISON_VERSION_V1, observedAt, researchCodeSha,
    variants: EXIT_COMPARISON_VARIANTS_V1, baselineVariant: EXIT_COMPARISON_BASELINE_VARIANT_V1,
    rules: { stopAtr: STOP_ATR, timeStop: TIME_STOP, scale: SCALE, trailingAtr: 3, winner: 'validation meanR max among variants with validation ≥20 trades, meanR > 0, unseen ≥10 trades, meanR > 0' },
    lanes: summaries,
    holdoutRead: false, liveTrading: false, realOrder: false, executionAuthority: 'NONE',
  });
  await atomicJson(join(root, 'latest', 'exit-strategy-comparison-v1.json'), result);
  return result;
}

// ---------- Korean report ----------

const ENTRY_KO = { SINGLE: '한 번에 진입', PYRAMID: '위로 추가매수' };
const EXIT_KO = { FIXED_FULL: '고정 전량', FIXED_SCALED: '고정 분할', TRAIL_FULL: '추적 전량', TRAIL_SCALED: '추적 분할' };
const LANE_KO = { CRYPTO_FUTURES_LONG: '코인선물 롱', CRYPTO_FUTURES_SHORT: '코인선물 숏', CRYPTO_SPOT_LONG: '코인현물' };
const fmt = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '-');
const pct = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : '-');
export const variantLabelKoV1 = (id) => { const [entry, exit] = id.split('+'); return `${ENTRY_KO[entry] ?? entry} + ${EXIT_KO[exit] ?? exit}`; };

export function formatExitComparisonReportKoV1(result) {
  const lines = ['청산 방식 비교 (2025년까지 데이터, 2026 봉인 미사용, 수수료·펀딩 반영)', '단위 R = 거래당 감수한 손실폭. 평균 +0.20R이면 거래마다 위험액의 20%를 번 것.', ''];
  for (const lane of result.lanes ?? []) {
    lines.push(`■ ${LANE_KO[lane.laneId] ?? lane.laneId}`);
    if (lane.status !== 'COMPLETE') { lines.push(`  대기: ${lane.status}${lane.symbols != null ? ` (${lane.symbols}/${lane.expectedSymbols}종목)` : ''}`, ''); continue; }
    for (const set of lane.signalSets) {
      lines.push(`  ▶ 진입 신호: ${set.label}`);
      lines.push('    방식 | 검증 거래 | 평균R | 승률 | 최장연패 | 낙폭R | 처음보는종목 평균R');
      for (const row of set.variants) {
        lines.push(`    ${variantLabelKoV1(row.variantId)} | ${row.validation.trades} | ${fmt(row.validation.meanR)} | ${pct(row.validation.winRate)} | ${row.validation.maxConsecutiveLosses} | ${fmt(row.validation.maxDrawdownR, 1)} | ${fmt(row.unseen.meanR)} (${row.unseen.trades})`);
      }
      const w = set.winner;
      if (w.status === 'WINNER') {
        lines.push(`    → 채택 후보: ${variantLabelKoV1(w.variantId)} (평균 ${fmt(w.validationMeanR)}R, 기준선 대비 ${w.upliftVsBaselineR >= 0 ? '+' : ''}${fmt(w.upliftVsBaselineR)}R${w.validationCiLowAboveZero ? ', 신뢰구간 하한도 0 위' : ', 신뢰구간 하한은 아직 0 아래'})`);
      } else {
        lines.push('    → 채택 후보 없음: 검증 구간과 처음 보는 종목 모두에서 플러스인 방식이 없음');
      }
    }
    lines.push('');
  }
  lines.push('연구 결과일 뿐 주문 권한은 없습니다.');
  return lines.join('\n');
}

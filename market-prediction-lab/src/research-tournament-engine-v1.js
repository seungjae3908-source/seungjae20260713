import { performance } from "node:perf_hooks";

import {
  assertFormulaCandidateV1,
  generateBoundedFormulaCandidatesV1,
} from "./autonomous-strategy-formula-generator-v1.js";
import {
  runIndependentSignalBacktest,
  runIndependentSignalFinalHoldout,
} from "./independent-strategy-backtest.js";
import { researchDigest } from "./research-trial-registry.js";

export const RESEARCH_TOURNAMENT_STAGES = Object.freeze([
  "FORMULA_CANDIDATE",
  "SANITY_CHECK",
  "HISTORICAL_BACKTEST",
  "OOS",
  "PURGED_OOS",
  "WALK_FORWARD",
  "COST_STRESS",
  "REGIME_STRESS",
  "STATISTICAL_FIREWALL",
  "FINAL_HOLDOUT",
  "RESEARCH_SURVIVOR",
]);

export const RESEARCH_TOURNAMENT_STAGE_STATUSES = Object.freeze([
  "PASS",
  "FAIL",
  "MISSING_EVIDENCE",
  "NOT_EVALUABLE",
]);

export const RESEARCH_TOURNAMENT_FAILURE_CODES = Object.freeze([
  "FORMULA_INVALID", "DUPLICATE_FORMULA", "PARAMETER_OUT_OF_BOUNDS", "REQUIRED_DATA_MISSING",
  "DATASET_ROLE_INVALID", "TIMEFRAME_INCOMPATIBLE", "MARKET_INCOMPATIBLE", "DIRECTION_INCOMPATIBLE",
  "IMPOSSIBLE_CONDITION", "CONTRADICTORY_ENTRY_RULE", "INVALID_EXIT_CONFIGURATION", "INSUFFICIENT_DATA",
  "BACKTEST_CONTRACT_INVALID", "BACKTEST_FAILED", "INSUFFICIENT_SAMPLE", "OOS_OVERLAP", "PARAMETER_MUTATION",
  "STRATEGY_HASH_MUTATION", "OOS_FAILED", "PURGED_OOS_INVALID", "LEAKAGE_DETECTED", "PURGED_OOS_FAILED",
  "WALK_FORWARD_INSUFFICIENT", "WALK_FORWARD_INVALID", "WALK_FORWARD_FAILED", "COST_EVIDENCE_MISSING",
  "COST_FRAGILE", "REGIME_EVIDENCE_MISSING", "REGIME_COLLAPSE", "STATISTICAL_EVIDENCE_MISSING",
  "MULTIPLE_TESTING_FAIL", "DSR_FAIL", "PBO_FAIL", "PARAMETER_INSTABILITY", "HOLDOUT_PREACCESS_FORBIDDEN",
  "HOLDOUT_CONTRACT_INVALID", "HOLDOUT_FAIL", "NOT_EVALUABLE_RESOURCE_LIMIT", "MISSING_CANONICAL_CALLBACK",
  "NON_FINITE_EVIDENCE", "EVALUATION_RUNTIME_ERROR",
]);

export const RESEARCH_TOURNAMENT_COST_SCENARIOS = Object.freeze(["BASE_COST", "MODERATE_STRESS", "HIGH_STRESS"]);
export const RESEARCH_TOURNAMENT_REGIMES = Object.freeze([
  "BULL", "BEAR", "SIDEWAYS", "HIGH_VOLATILITY", "LOW_VOLATILITY", "HIGH_SPREAD", "LOW_LIQUIDITY",
]);

const STATUS_SET = new Set(RESEARCH_TOURNAMENT_STAGE_STATUSES);
const STAGE_INDEX = new Map(RESEARCH_TOURNAMENT_STAGES.map((stage, index) => [stage, index]));
const HASH64 = /^[0-9a-f]{64}$/u;
const COST_COMPONENTS = Object.freeze(["commission", "spread", "slippage", "tax", "funding", "latency", "liquidityImpact"]);

function safetyEnvelope() {
  return Object.freeze({
    LIVE_TRADING: false, AUTO_TRADING: false, REAL_ORDER_ENABLED: false, PRIVATE_TRADING_API_ALLOWED: false,
    executionAuthority: "NONE", generatedExecutableCodeAllowed: false, finalHoldoutPreAccessAllowed: false,
    shadowHindsightTuningAllowed: false, profitabilityClaimAllowed: false, championPromotionAllowed: false,
    orderSubmitted: false, orderCancelled: false, orderModified: false, transferSubmitted: false, withdrawalSubmitted: false,
  });
}
function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}
function timestamp(value, name = "timestamp") {
  const text = requiredText(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${name} must be an ISO timestamp`);
  return new Date(text).toISOString();
}
function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  return value;
}
function nonNegativeNumber(value, name, maximum = Number.MAX_VALUE) {
  if (!Number.isFinite(value) || value < 0 || value > maximum) throw new RangeError(`${name} must be finite and between 0 and ${maximum}`);
  return value;
}
function finiteOrNull(value, name) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite or null`);
  return value;
}
function canonical(value, path = "evidence") {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains NaN/Infinity`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item, index) => canonical(item, `${path}[${index}]`));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], `${path}.${key}`)]));
  }
  throw new TypeError(`${path} must contain JSON-compatible values only`);
}
function deepFreeze(value) {
  if (Array.isArray(value)) { value.forEach(deepFreeze); return Object.freeze(value); }
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); return Object.freeze(value); }
  return value;
}
function snapshot(value, path = "evidence") { return deepFreeze(canonical(value, path)); }
function status(value) { return typeof value === "string" && STATUS_SET.has(value) ? value : null; }
function clamp01(value) { return Math.max(0, Math.min(1, value)); }
function period(value, name) {
  if (!value || !Number.isInteger(value.startTime) || !Number.isInteger(value.endTime) || value.startTime >= value.endTime) throw new Error(`${name}_INVALID`);
  return Object.freeze({ startTime: value.startTime, endTime: value.endTime });
}
function periodsOverlap(left, right) { return left.startTime <= right.endTime && right.startTime <= left.endTime; }

function stageRecord({ stage, stageStatus, evidence, strategyHash, parameterIdentity, datasetIdentity, observedAt }) {
  if (!STAGE_INDEX.has(stage)) throw new Error(`TOURNAMENT_STAGE_INVALID:${stage}`);
  if (!STATUS_SET.has(stageStatus)) throw new Error(`TOURNAMENT_STAGE_STATUS_INVALID:${stageStatus}`);
  let body;
  try { body = snapshot(evidence ?? null); }
  catch (error) { body = snapshot({ evidenceState: "INVALID_NON_FINITE", error: error instanceof Error ? error.message : String(error) }); }
  return Object.freeze({
    stage, status: stageStatus,
    evidenceId: `tournament-evidence:sha256:${researchDigest({ stage, status: stageStatus, strategyHash, parameterIdentity, datasetIdentity, evidence: body })}`,
    strategyHash: strategyHash ?? null, parameterIdentity: parameterIdentity ?? null, datasetIdentity: datasetIdentity ?? null,
    timestamp: observedAt, evidence: body,
  });
}
function elimination({ stage, code, reason, record, strategyHash, parameterIdentity, datasetIdentity, observedAt }) {
  const failure = Object.freeze({ failedStage: stage, failureCode: code, failureReason: reason, evidenceId: record.evidenceId,
    strategyHash: strategyHash ?? null, parameterIdentity: parameterIdentity ?? null, datasetIdentity: datasetIdentity ?? null, timestamp: observedAt });
  const observation = Object.freeze({
    schemaVersion: 1, observationId: `research-failure:sha256:${researchDigest(failure)}`, type: "ResearchFailureObservation",
    strategyHash: failure.strategyHash, parameterIdentity: failure.parameterIdentity, failedStage: failure.failedStage,
    failureCode: failure.failureCode, datasetIdentity: failure.datasetIdentity, evidenceId: failure.evidenceId, timestamp: failure.timestamp,
    formulaMutationAllowed: false, performanceOverwriteAllowed: false, nextHypothesisRequiredForRetry: true,
  });
  return Object.freeze({ failure, observation });
}
function terminalCandidate({ formula, generated, records, failure = null, observation = null, survivor = false }) {
  return Object.freeze({
    formulaCandidateId: formula?.candidateId ?? generated?.formulaCandidateId ?? null,
    generatedCandidateId: generated?.generatedCandidateId ?? null,
    strategyHash: formula?.formulaHash ?? generated?.formulaHash ?? null,
    parameterIdentity: generated?.parameterIdentity ?? null,
    hypothesisId: formula?.hypothesisId ?? generated?.hypothesisId ?? null,
    strategyFamily: formula?.strategyFamily ?? generated?.strategyFamily ?? null,
    market: formula?.market ?? null, timeframe: formula?.timeframe ?? null, direction: formula?.direction ?? null,
    formula: formula ? Object.freeze({ entryDsl: formula.entryDsl, exitDsl: formula.exitDsl, selectedParameters: generated?.selectedParameters ?? null }) : null,
    hypothesis: formula ? Object.freeze({ hypothesisId: formula.hypothesisId, rationale: formula.rationale, falsificationCriteria: formula.falsificationCriteria }) : null,
    stageRecords: Object.freeze(records), terminalState: survivor ? "RESEARCH_SURVIVOR" : failure?.failedStage ?? records.at(-1)?.stage ?? "FORMULA_CANDIDATE",
    failure, researchFailureObservation: observation, researchSurvivor: survivor,
    profitable: false, provisionalChampion: false, validatedChampion: false, tradingAuthority: false, safety: safetyEnvelope(),
  });
}

export function normalizeResearchTournamentBudgetV1(raw = {}) {
  return Object.freeze({
    maxCandidatesPerRun: positiveInteger(raw.maxCandidatesPerRun ?? 32, "maxCandidatesPerRun", 128),
    maxConcurrentBacktests: positiveInteger(raw.maxConcurrentBacktests ?? 2, "maxConcurrentBacktests", 16),
    maxTotalCandles: positiveInteger(raw.maxTotalCandles ?? 5_000_000, "maxTotalCandles", 100_000_000),
    maxRuntimeMs: positiveInteger(raw.maxRuntimeMs ?? 1_800_000, "maxRuntimeMs", 86_400_000),
    maxCpuPercent: nonNegativeNumber(raw.maxCpuPercent ?? 80, "maxCpuPercent", 100),
    maxMemoryMb: positiveInteger(raw.maxMemoryMb ?? 4096, "maxMemoryMb", 1_048_576),
    maxWalkForwardWindows: positiveInteger(raw.maxWalkForwardWindows ?? 48, "maxWalkForwardWindows", 512),
    maxStressScenarios: positiveInteger(raw.maxStressScenarios ?? 8, "maxStressScenarios", 64),
  });
}
function normalizePolicy(raw = {}) {
  const minimumRegimeSamples = Object.freeze({ BULL: Math.max(0, Number(raw.minimumRegimeSamples?.BULL ?? 1)), BEAR: Math.max(0, Number(raw.minimumRegimeSamples?.BEAR ?? 1)), SIDEWAYS: Math.max(0, Number(raw.minimumRegimeSamples?.SIDEWAYS ?? 1)) });
  if (Object.values(minimumRegimeSamples).some((value) => !Number.isSafeInteger(value))) throw new RangeError("minimumRegimeSamples must be integers");
  return Object.freeze({
    minimumCandles: positiveInteger(raw.minimumCandles ?? 100, "minimumCandles"), minimumTrades: positiveInteger(raw.minimumTrades ?? 30, "minimumTrades"),
    minimumIndependentPeriods: positiveInteger(raw.minimumIndependentPeriods ?? 3, "minimumIndependentPeriods"), minimumRegimeSamples,
    minimumWalkForwardWindows: positiveInteger(raw.minimumWalkForwardWindows ?? 3, "minimumWalkForwardWindows"),
    minimumPositiveWalkForwardRatio: nonNegativeNumber(raw.minimumPositiveWalkForwardRatio ?? 0.5, "minimumPositiveWalkForwardRatio", 1),
    maximumFailureConcentration: nonNegativeNumber(raw.maximumFailureConcentration ?? 0.5, "maximumFailureConcentration", 1),
    minimumNeighborhoodWidth: positiveInteger(raw.minimumNeighborhoodWidth ?? 2, "minimumNeighborhoodWidth", 32),
    multipleTestingBaseAlpha: nonNegativeNumber(raw.multipleTestingBaseAlpha ?? 0.05, "multipleTestingBaseAlpha", 1),
    requiredCostScenarios: Object.freeze([...(raw.requiredCostScenarios ?? RESEARCH_TOURNAMENT_COST_SCENARIOS)]),
    requiredRegimes: Object.freeze([...(raw.requiredRegimes ?? RESEARCH_TOURNAMENT_REGIMES)]),
  });
}

export function createResearchTournamentFsmV1({ strategyHash, parameterIdentity = null, datasetIdentity = null, observedAt } = {}) {
  if (!HASH64.test(requiredText(strategyHash, "strategyHash"))) throw new TypeError("strategyHash must be SHA-256");
  return Object.freeze({ schemaVersion: 1, strategyHash, parameterIdentity, datasetIdentity, currentStage: null, terminal: false, records: Object.freeze([]), timestamp: timestamp(observedAt, "observedAt") });
}
export function advanceResearchTournamentFsmV1(fsm, { stage, status: nextStatus, evidence = null } = {}) {
  if (!fsm || fsm.terminal) throw new Error("TOURNAMENT_TERMINAL_REENTRY_FORBIDDEN");
  const nextIndex = STAGE_INDEX.get(stage);
  if (nextIndex === undefined) throw new Error("TOURNAMENT_STAGE_INVALID");
  const expectedIndex = fsm.currentStage === null ? 0 : STAGE_INDEX.get(fsm.currentStage) + 1;
  if (nextIndex !== expectedIndex) throw new Error("TOURNAMENT_STAGE_SKIP_FORBIDDEN");
  if (!STATUS_SET.has(nextStatus)) throw new Error("TOURNAMENT_STAGE_STATUS_INVALID");
  if (stage === "RESEARCH_SURVIVOR" && nextStatus !== "PASS") throw new Error("RESEARCH_SURVIVOR_MUST_PASS");
  const record = stageRecord({ stage, stageStatus: nextStatus, evidence, strategyHash: fsm.strategyHash, parameterIdentity: fsm.parameterIdentity, datasetIdentity: fsm.datasetIdentity, observedAt: fsm.timestamp });
  return Object.freeze({ ...fsm, currentStage: stage, terminal: nextStatus !== "PASS" || stage === "RESEARCH_SURVIVOR", records: Object.freeze([...fsm.records, record]) });
}

function validateSelectedParameters(formula, generated) {
  const selected = generated?.selectedParameters;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) return "selected parameters are missing";
  const schema = new Map(formula.parameterSpace.map((row) => [row.name, row]));
  if (Object.keys(selected).length !== schema.size) return "selected parameter set does not match formula parameter space";
  for (const [name, value] of Object.entries(selected)) {
    const spec = schema.get(name);
    if (!spec || !Number.isFinite(value) || value < spec.min || value > spec.max) return `parameter ${name} is outside preregistered bounds`;
    const steps = (value - spec.min) / spec.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-8) return `parameter ${name} is off the preregistered grid`;
    if (spec.valueType === "INTEGER" && !Number.isInteger(value)) return `parameter ${name} must be integer`;
  }
  return null;
}
function walk(value, visitor) {
  if (!value || typeof value !== "object") return; visitor(value);
  if (Array.isArray(value)) value.forEach((item) => walk(item, visitor)); else Object.values(value).forEach((item) => walk(item, visitor));
}
function contradictoryEntry(formula, generated) {
  let contradictory = false;
  walk(formula.entryDsl, (node) => {
    if (node?.kind !== "OPERATOR" || node.operator !== "BETWEEN" || !Array.isArray(node.operands)) return;
    const lower = node.operands[1]; const upper = node.operands[2];
    if (lower?.kind === "PARAMETER" && upper?.kind === "PARAMETER") {
      const lowValue = generated.selectedParameters[lower.name]; const highValue = generated.selectedParameters[upper.name];
      if (Number.isFinite(lowValue) && Number.isFinite(highValue) && lowValue >= highValue) contradictory = true;
    }
  });
  return contradictory;
}
function sanitizeMetadata(raw) {
  if (!raw || typeof raw !== "object") return null;
  return snapshot({ datasetIdentity: raw.datasetIdentity ?? null, datasetRole: raw.datasetRole ?? null, market: raw.market ?? null,
    timeframe: raw.timeframe ?? null, direction: raw.direction ?? null, candleCount: Number.isSafeInteger(raw.candleCount) ? raw.candleCount : null,
    independentPeriods: Number.isSafeInteger(raw.independentPeriods) ? raw.independentPeriods : null,
    availableFields: Array.isArray(raw.availableFields) ? [...raw.availableFields].sort() : null });
}
function sanityCheck(formula, generated, metadata, policy) {
  const parameterError = validateSelectedParameters(formula, generated);
  if (parameterError) return { status: "FAIL", code: "PARAMETER_OUT_OF_BOUNDS", reason: parameterError };
  if (generated.formulaHash !== formula.formulaHash) return { status: "FAIL", code: "STRATEGY_HASH_MUTATION", reason: "generated candidate formula hash differs from immutable FormulaCandidateV1" };
  if (!HASH64.test(generated.parameterIdentity)) return { status: "FAIL", code: "PARAMETER_OUT_OF_BOUNDS", reason: "parameter identity is invalid" };
  if (generated.searchProvenance?.finalHoldoutAccess !== false) return { status: "FAIL", code: "HOLDOUT_PREACCESS_FORBIDDEN", reason: "parameter search attempted Final Holdout access" };
  if (!metadata) return { status: "MISSING_EVIDENCE", code: "REQUIRED_DATA_MISSING", reason: "dataset metadata evidence is missing" };
  if (metadata.datasetRole === "FINAL_HOLDOUT") return { status: "FAIL", code: "HOLDOUT_PREACCESS_FORBIDDEN", reason: "Final Holdout cannot be used by sanity/search stages" };
  if (metadata.datasetIdentity !== generated.searchProvenance.datasetIdentity) return { status: "FAIL", code: "DATASET_ROLE_INVALID", reason: "search dataset identity does not match evaluated dataset identity" };
  if (metadata.market !== formula.market) return { status: "FAIL", code: "MARKET_INCOMPATIBLE", reason: "dataset market is incompatible with formula" };
  if (String(metadata.timeframe).toLowerCase() !== String(formula.timeframe).toLowerCase()) return { status: "FAIL", code: "TIMEFRAME_INCOMPATIBLE", reason: "dataset timeframe is incompatible with formula" };
  if (String(metadata.direction).toUpperCase() !== String(formula.direction).toUpperCase()) return { status: "FAIL", code: "DIRECTION_INCOMPATIBLE", reason: "dataset direction is incompatible with formula" };
  if (!Number.isSafeInteger(metadata.candleCount) || metadata.candleCount < policy.minimumCandles) return { status: "MISSING_EVIDENCE", code: "INSUFFICIENT_DATA", reason: "minimum candle evidence is insufficient" };
  if (!Array.isArray(metadata.availableFields)) return { status: "MISSING_EVIDENCE", code: "REQUIRED_DATA_MISSING", reason: "available field evidence is missing" };
  const available = new Set(metadata.availableFields); const required = new Set(formula.availableDataFields);
  for (const requiredData of formula.requiredData ?? []) for (const field of requiredData.fields ?? []) required.add(field);
  const missingFields = [...required].filter((field) => !available.has(field));
  if (missingFields.length) return { status: "MISSING_EVIDENCE", code: "REQUIRED_DATA_MISSING", reason: `required fields missing: ${missingFields.sort().join(",")}` };
  if (!formula.entryDsl?.rules?.length || formula.entryDsl.action === "NO_TRADE") return { status: "FAIL", code: "IMPOSSIBLE_CONDITION", reason: "entry configuration cannot produce a research trade" };
  if (contradictoryEntry(formula, generated)) return { status: "FAIL", code: "CONTRADICTORY_ENTRY_RULE", reason: "entry parameter constraints are contradictory" };
  if (!formula.exitDsl?.rules?.length) return { status: "FAIL", code: "INVALID_EXIT_CONFIGURATION", reason: "exit configuration is empty" };
  return { status: "PASS", code: null, reason: null };
}

function returnsFromTrades(trades, initialCapital) {
  return trades.map((trade) => Number.isFinite(trade.netReturnOnMargin) ? trade.netReturnOnMargin
    : Number.isFinite(trade.entryNotional) && trade.entryNotional > 0 ? trade.netPnl / trade.entryNotional
      : initialCapital > 0 && Number.isFinite(trade.netPnl) ? trade.netPnl / initialCapital : null).filter(Number.isFinite);
}
function sampleStd(values) {
  if (values.length < 2) return null; const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1));
}
function downsideDeviation(values) {
  const downside = values.filter((value) => value < 0); if (downside.length < 2) return null;
  return Math.sqrt(downside.reduce((sum, value) => sum + (value ** 2), 0) / downside.length);
}
function truthPreservingMetrics(raw = {}) {
  const trades = Array.isArray(raw.trades) ? raw.trades : [];
  const tradeCount = Number.isSafeInteger(raw.totalTrades) ? raw.totalTrades : Number.isSafeInteger(raw.metrics?.tradeCount) ? raw.metrics.tradeCount : Number.isSafeInteger(raw.performance?.overall?.sampleCount) ? raw.performance.overall.sampleCount : trades.length;
  if (tradeCount === 0) return Object.freeze({ trades: 0, capital: finiteOrNull(raw.initialCapital ?? raw.metrics?.capital, "capital"), finalCapital: finiteOrNull(raw.finalCapital ?? raw.metrics?.finalCapital, "finalCapital"), return: null, winRate: null, profitFactor: null, expectancy: null, maximumDrawdown: null, sharpe: null, sortino: null, calmar: null, mfe: null, mae: null, exposure: null, turnover: null, averageHoldingPeriodMs: null, longShortDistribution: null, equityCurve: Object.freeze([]), exitReasons: Object.freeze({}), sampleState: "NO_SAMPLE" });
  const initialCapital = finiteOrNull(raw.initialCapital ?? raw.metrics?.capital, "capital");
  const totalReturn = finiteOrNull(raw.performance?.overall?.totalReturn ?? raw.metrics?.totalReturn ?? (Number.isFinite(raw.totalReturnPercent) ? raw.totalReturnPercent / 100 : null), "return");
  const maximumDrawdown = finiteOrNull(raw.performance?.overall?.maximumDrawdownPercent ?? raw.metrics?.maximumDrawdown ?? (Number.isFinite(raw.maximumDrawdownPercent) ? raw.maximumDrawdownPercent / 100 : null), "maximumDrawdown");
  const tradeReturns = returnsFromTrades(trades, initialCapital ?? 1); const standardDeviation = sampleStd(tradeReturns);
  const meanReturn = tradeReturns.length ? tradeReturns.reduce((sum, value) => sum + value, 0) / tradeReturns.length : null; const downside = downsideDeviation(tradeReturns);
  const sharpe = finiteOrNull(raw.performance?.overall?.tradeSharpe ?? raw.metrics?.sharpe ?? (standardDeviation > 0 && meanReturn !== null ? meanReturn / standardDeviation * Math.sqrt(tradeReturns.length) : null), "sharpe");
  const sortino = finiteOrNull(raw.metrics?.sortino ?? (downside > 0 && meanReturn !== null ? meanReturn / downside * Math.sqrt(tradeReturns.length) : null), "sortino");
  const calmar = finiteOrNull(raw.metrics?.calmar ?? (maximumDrawdown > 0 && totalReturn !== null ? totalReturn / maximumDrawdown : null), "calmar");
  const mfeValues = trades.map((trade) => trade.maximumFavorableExcursion).filter(Number.isFinite); const maeValues = trades.map((trade) => trade.maximumAdverseExcursion).filter(Number.isFinite);
  const periods = raw.period && Number.isInteger(raw.period.startTime) && Number.isInteger(raw.period.endTime) ? raw.period : null;
  const holding = trades.map((trade) => Number.isInteger(trade.entryTime) && Number.isInteger(trade.exitTime) ? Math.max(0, trade.exitTime - trade.entryTime) : null).filter(Number.isFinite);
  const totalHolding = holding.reduce((sum, value) => sum + value, 0); const directions = { LONG: 0, SHORT: 0 }; const exitReasons = {};
  for (const trade of trades) { if (String(trade.side).toLowerCase() === "short" || trade.action === "SHORT") directions.SHORT += 1; else directions.LONG += 1; const reason = String(trade.exitReason ?? "UNKNOWN"); exitReasons[reason] = (exitReasons[reason] ?? 0) + 1; }
  const equityCurve = []; if (Number.isFinite(initialCapital)) equityCurve.push(Object.freeze({ timestamp: periods?.startTime ?? null, equity: initialCapital }));
  for (const trade of trades) if (Number.isFinite(trade.equityAfter)) equityCurve.push(Object.freeze({ timestamp: trade.exitTime ?? null, equity: trade.equityAfter }));
  return Object.freeze({
    trades: tradeCount, capital: initialCapital, finalCapital: finiteOrNull(raw.finalCapital ?? raw.performance?.overall?.finalCapital ?? raw.metrics?.finalCapital, "finalCapital"), return: totalReturn,
    winRate: finiteOrNull(raw.performance?.overall?.winRate ?? raw.metrics?.winRate ?? (Number.isFinite(raw.successRatePercent) ? raw.successRatePercent / 100 : null), "winRate"),
    profitFactor: finiteOrNull(raw.profitFactor ?? raw.performance?.overall?.profitFactor ?? raw.metrics?.profitFactor, "profitFactor"), expectancy: finiteOrNull(raw.expectancy ?? raw.performance?.overall?.expectancy ?? raw.metrics?.expectancy, "expectancy"),
    maximumDrawdown, sharpe, sortino, calmar,
    mfe: mfeValues.length ? mfeValues.reduce((sum, value) => sum + value, 0) / mfeValues.length : null, mae: maeValues.length ? maeValues.reduce((sum, value) => sum + value, 0) / maeValues.length : null,
    exposure: periods && periods.endTime > periods.startTime ? clamp01(totalHolding / (periods.endTime - periods.startTime)) : null,
    turnover: finiteOrNull(raw.performance?.overall?.turnover ?? raw.metrics?.turnover, "turnover"), averageHoldingPeriodMs: holding.length ? totalHolding / holding.length : null,
    longShortDistribution: Object.freeze({ long: directions.LONG, short: directions.SHORT, longRatio: directions.LONG / tradeCount, shortRatio: directions.SHORT / tradeCount }),
    equityCurve: Object.freeze(equityCurve), exitReasons: Object.freeze(exitReasons), sampleState: "MEASURED",
  });
}
function executionCostEvidence(raw, liquidityImpactEvidence) {
  const overall = raw.performance?.overall ?? {}; const trades = Array.isArray(raw.trades) ? raw.trades : [];
  const sumCost = (key) => { if (trades.length === 0 || trades.some((trade) => !Number.isFinite(trade.costs?.[key]))) return null; return trades.reduce((sum, trade) => sum + trade.costs[key], 0); };
  return Object.freeze({
    commission: { value: finiteOrNull(overall.feeCost, "commission"), evidenceId: "one-pass:trade-costs:fee" }, spread: { value: finiteOrNull(overall.spreadCost, "spread"), evidenceId: "one-pass:trade-costs:spread" },
    slippage: { value: finiteOrNull(overall.slippageCost, "slippage"), evidenceId: "one-pass:trade-costs:slippage" }, tax: { value: sumCost("tax"), evidenceId: "one-pass:trade-costs:tax" },
    funding: { value: sumCost("funding"), evidenceId: "one-pass:trade-costs:funding" }, latency: { value: finiteOrNull(overall.latencyCost, "latency"), evidenceId: "one-pass:trade-costs:latency" },
    liquidityImpact: liquidityImpactEvidence == null ? null : snapshot(liquidityImpactEvidence, "liquidityImpactEvidence"),
  });
}
export function runOnePassCandidateBacktestV1({ formulaCandidate, generatedCandidate, datasetIdentity, backtestInput, executionParameters, signalEvaluator, evaluatorContract, period: requestedPeriod, finalHoldout = false, liquidityImpactEvidence = null } = {}) {
  assertFormulaCandidateV1(formulaCandidate);
  if (generatedCandidate?.formulaHash !== formulaCandidate.formulaHash || !HASH64.test(generatedCandidate?.parameterIdentity ?? "")) throw new Error("GENERATED_CANDIDATE_IDENTITY_INVALID");
  if (typeof signalEvaluator !== "function") throw new TypeError("trusted signalEvaluator is required");
  if (evaluatorContract?.source !== "CANONICAL_SAFE_DSL_INTERPRETER" || evaluatorContract?.arbitraryExecutableCodeAllowed !== false || evaluatorContract?.formulaHash !== formulaCandidate.formulaHash) throw new Error("TRUSTED_SAFE_DSL_EVALUATOR_CONTRACT_REQUIRED");
  const raw = finalHoldout ? runIndependentSignalFinalHoldout({ backtestInput, strategy: formulaCandidate.strategyFamily, strategyVersion: "FORMULA_CANDIDATE_V1", parameters: executionParameters, signalEvaluator, period: requestedPeriod })
    : runIndependentSignalBacktest({ backtestInput, strategy: formulaCandidate.strategyFamily, strategyVersion: "FORMULA_CANDIDATE_V1", parameters: executionParameters, signalEvaluator, period: requestedPeriod });
  return Object.freeze({ status: "PASS", canonicalBacktestOwner: "#690", executionEngine: finalHoldout ? "runIndependentSignalFinalHoldout" : "runIndependentSignalBacktest", executionEquivalent: true,
    formulaCandidateId: formulaCandidate.candidateId, strategyHash: formulaCandidate.formulaHash, parameterIdentity: generatedCandidate.parameterIdentity,
    datasetIdentity: requiredText(datasetIdentity, "datasetIdentity"), metrics: truthPreservingMetrics(raw), trades: raw.trades, performance: raw.performance, period: raw.period,
    costEvidence: executionCostEvidence(raw, liquidityImpactEvidence), safeguards: raw.safeguards, safety: safetyEnvelope() });
}

function normalizeStageResult(raw, defaultCode, defaultReason) {
  if (!raw || typeof raw !== "object") return { status: "MISSING_EVIDENCE", code: defaultCode, reason: defaultReason, raw: null };
  const normalized = status(raw.status); if (!normalized) return { status: "MISSING_EVIDENCE", code: defaultCode, reason: "stage returned an unknown/invalid status", raw };
  return { status: normalized, code: raw.failureCode ?? defaultCode, reason: raw.failureReason ?? raw.reason ?? defaultReason, raw };
}
async function callback(dependencies, name, payload) {
  if (typeof dependencies?.[name] !== "function") return { status: "MISSING_EVIDENCE", failureCode: "MISSING_CANONICAL_CALLBACK", failureReason: `${name} callback is required` };
  try { return await dependencies[name](payload); }
  catch (error) { return { status: "NOT_EVALUABLE", failureCode: "EVALUATION_RUNTIME_ERROR", failureReason: `${name} failed: ${error instanceof Error ? error.message : String(error)}` }; }
}
function sampleSufficiency(raw, metrics, policy) {
  const sample = raw?.sample; if (!sample || typeof sample !== "object") return { status: "MISSING_EVIDENCE", code: "INSUFFICIENT_SAMPLE", reason: "sample sufficiency evidence is missing", score: 0 };
  const trades = Number.isSafeInteger(sample.tradeCount) ? sample.tradeCount : metrics.trades; const independentPeriods = sample.independentPeriods; const regimeCounts = sample.regimeCounts;
  if (!Number.isSafeInteger(trades) || !Number.isSafeInteger(independentPeriods) || !regimeCounts || typeof regimeCounts !== "object") return { status: "MISSING_EVIDENCE", code: "INSUFFICIENT_SAMPLE", reason: "sample counts are incomplete", score: 0 };
  const ratios = [trades / policy.minimumTrades, independentPeriods / policy.minimumIndependentPeriods];
  if (trades < policy.minimumTrades) return { status: "MISSING_EVIDENCE", code: "INSUFFICIENT_SAMPLE", reason: `trades ${trades} < ${policy.minimumTrades}`, score: clamp01(Math.min(...ratios)) };
  if (independentPeriods < policy.minimumIndependentPeriods) return { status: "MISSING_EVIDENCE", code: "INSUFFICIENT_SAMPLE", reason: `independent periods ${independentPeriods} < ${policy.minimumIndependentPeriods}`, score: clamp01(Math.min(...ratios)) };
  for (const regime of ["BULL", "BEAR", "SIDEWAYS"]) {
    const count = regimeCounts[regime]; if (!Number.isSafeInteger(count) || count < 0) return { status: "MISSING_EVIDENCE", code: "INSUFFICIENT_SAMPLE", reason: `${regime} sample evidence is missing`, score: 0 };
    const required = policy.minimumRegimeSamples[regime]; if (required > 0) ratios.push(count / required);
    if (count < required) return { status: "MISSING_EVIDENCE", code: "INSUFFICIENT_SAMPLE", reason: `${regime} sample ${count} < ${required}`, score: clamp01(Math.min(...ratios)) };
  }
  return { status: "PASS", code: null, reason: null, score: clamp01(Math.min(...ratios)) };
}
function assertFrozenIdentity(raw, formula, generated) {
  if (raw?.strategyHash !== formula.formulaHash) return { code: "STRATEGY_HASH_MUTATION", reason: "strategy hash changed after parameter freeze" };
  if (raw?.parameterIdentity !== generated.parameterIdentity) return { code: "PARAMETER_MUTATION", reason: "parameter identity changed after parameter freeze" };
  return null;
}
function validateOos(raw, formula, generated, metadata) {
  const identityError = assertFrozenIdentity(raw, formula, generated); if (identityError) return { status: "FAIL", ...identityError };
  if (!raw?.trainDatasetIdentity || !raw?.oosDatasetIdentity) return { status: "MISSING_EVIDENCE", code: "OOS_FAILED", reason: "train/OOS dataset identities are missing" };
  if (raw.trainDatasetIdentity !== metadata.datasetIdentity || raw.oosDatasetIdentity === raw.trainDatasetIdentity) return { status: "FAIL", code: "OOS_OVERLAP", reason: "train and OOS identities are not isolated" };
  try { const train = period(raw.trainPeriod, "OOS_TRAIN_PERIOD"); const oos = period(raw.oosPeriod, "OOS_PERIOD"); if (periodsOverlap(train, oos)) return { status: "FAIL", code: "OOS_OVERLAP", reason: "train and OOS periods overlap" }; }
  catch { return { status: "MISSING_EVIDENCE", code: "OOS_FAILED", reason: "OOS period evidence is invalid" }; }
  if (raw.parameterFrozen !== true || raw.strategyFrozen !== true) return { status: "FAIL", code: "PARAMETER_MUTATION", reason: "OOS did not preserve frozen strategy/parameters" };
  return { status: "PASS" };
}
function validatePurgedOos(raw, formula, generated, ordinaryOosIdentity) {
  const identityError = assertFrozenIdentity(raw, formula, generated); if (identityError) return { status: "FAIL", ...identityError };
  if (!raw?.purgedOosDatasetIdentity || raw.purgedOosDatasetIdentity === ordinaryOosIdentity) return { status: "FAIL", code: "PURGED_OOS_INVALID", reason: "Purged OOS must have a distinct canonical dataset identity" };
  for (const key of ["purgeWindowBars", "embargoWindowBars", "featureLookbackBars"]) if (!Number.isSafeInteger(raw[key]) || raw[key] <= 0) return { status: "MISSING_EVIDENCE", code: "PURGED_OOS_INVALID", reason: `${key} evidence is missing` };
  if (raw.purgeWindowBars < raw.featureLookbackBars) return { status: "FAIL", code: "LEAKAGE_DETECTED", reason: "purge window is shorter than feature lookback" };
  if (raw.overlappingLabelLeakage !== false || raw.timestampIntegrity !== true) return { status: "FAIL", code: "LEAKAGE_DETECTED", reason: "label/timestamp leakage guard failed" };
  if (raw.parameterFrozen !== true || raw.strategyFrozen !== true) return { status: "FAIL", code: "PARAMETER_MUTATION", reason: "Purged OOS changed frozen identity" };
  return { status: "PASS" };
}
function validateWalkForward(raw, formula, generated, policy, budget) {
  if (!["ROLLING", "EXPANDING"].includes(raw?.mode)) return { status: "MISSING_EVIDENCE", code: "WALK_FORWARD_INVALID", reason: "walk-forward mode must be ROLLING or EXPANDING" };
  if (!Array.isArray(raw.windows)) return { status: "MISSING_EVIDENCE", code: "WALK_FORWARD_INVALID", reason: "walk-forward windows are missing" };
  if (raw.windows.length < policy.minimumWalkForwardWindows) return { status: "MISSING_EVIDENCE", code: "WALK_FORWARD_INSUFFICIENT", reason: "insufficient walk-forward windows" };
  if (raw.windows.length > budget.maxWalkForwardWindows) return { status: "NOT_EVALUABLE", code: "NOT_EVALUABLE_RESOURCE_LIMIT", reason: "walk-forward window budget exceeded" };
  let positive = 0; let longestFailureRun = 0; let currentFailureRun = 0; const returns = [];
  for (const [index, window] of raw.windows.entries()) {
    if (window.strategyHash !== formula.formulaHash) return { status: "FAIL", code: "STRATEGY_HASH_MUTATION", reason: `window ${index} strategy identity changed` };
    if (window.parameterIdentity !== generated.parameterIdentity) return { status: "FAIL", code: "PARAMETER_MUTATION", reason: `window ${index} parameter identity changed` };
    try { const train = period(window.trainPeriod, `WF_${index}_TRAIN`); const validation = period(window.validationPeriod, `WF_${index}_VALIDATION`); const oos = period(window.oosPeriod, `WF_${index}_OOS`); if (periodsOverlap(train, validation) || periodsOverlap(train, oos) || periodsOverlap(validation, oos)) return { status: "FAIL", code: "WALK_FORWARD_INVALID", reason: `window ${index} periods overlap` }; }
    catch { return { status: "MISSING_EVIDENCE", code: "WALK_FORWARD_INVALID", reason: `window ${index} periods are invalid` }; }
    for (const key of ["trades", "return", "expectancy", "maximumDrawdown"]) if (!Number.isFinite(window[key])) return { status: "MISSING_EVIDENCE", code: "WALK_FORWARD_INVALID", reason: `window ${index} ${key} is missing/non-finite` };
    if (window.profitFactor !== null && !Number.isFinite(window.profitFactor)) return { status: "MISSING_EVIDENCE", code: "WALK_FORWARD_INVALID", reason: `window ${index} profitFactor is invalid` };
    returns.push(window.return); if (window.return > 0) { positive += 1; currentFailureRun = 0; } else { currentFailureRun += 1; longestFailureRun = Math.max(longestFailureRun, currentFailureRun); }
  }
  const positiveRatio = positive / raw.windows.length; const failureConcentration = longestFailureRun / raw.windows.length;
  if (positiveRatio < policy.minimumPositiveWalkForwardRatio || failureConcentration > policy.maximumFailureConcentration) return { status: "FAIL", code: "WALK_FORWARD_FAILED", reason: "walk-forward consistency/failure concentration gate failed", positiveRatio, failureConcentration };
  const firstHalf = returns.slice(0, Math.ceil(returns.length / 2)); const secondHalf = returns.slice(Math.floor(returns.length / 2)); const average = (rows) => rows.reduce((sum, value) => sum + value, 0) / rows.length;
  return { status: "PASS", positiveRatio, failureConcentration, degradation: average(secondHalf) - average(firstHalf), parameterStable: true };
}
function costComponent(cell) { if (!cell || typeof cell !== "object" || !Number.isFinite(cell.value) || cell.value < 0 || typeof cell.evidenceId !== "string" || !cell.evidenceId) return null; return Object.freeze({ value: cell.value, evidenceId: cell.evidenceId }); }
function validateCostStress(raw, policy, budget) {
  if (!Array.isArray(raw?.scenarios)) return { status: "MISSING_EVIDENCE", code: "COST_EVIDENCE_MISSING", reason: "cost stress scenarios are missing" };
  if (raw.scenarios.length > budget.maxStressScenarios) return { status: "NOT_EVALUABLE", code: "NOT_EVALUABLE_RESOURCE_LIMIT", reason: "stress scenario budget exceeded" };
  const byName = new Map(raw.scenarios.map((scenario) => [scenario.name, scenario])); const normalized = [];
  for (const name of policy.requiredCostScenarios) {
    const scenario = byName.get(name); if (!scenario) return { status: "MISSING_EVIDENCE", code: "COST_EVIDENCE_MISSING", reason: `${name} scenario is missing` };
    const costs = {}; for (const component of COST_COMPONENTS) { const cell = costComponent(scenario.costs?.[component]); if (!cell) return { status: "MISSING_EVIDENCE", code: "COST_EVIDENCE_MISSING", reason: `${name}.${component} cost evidence is missing` }; costs[component] = cell; }
    if (![scenario.grossEdge, scenario.explicitCosts, scenario.netEdge].every(Number.isFinite)) return { status: "MISSING_EVIDENCE", code: "COST_EVIDENCE_MISSING", reason: `${name} net-alpha evidence is non-finite` };
    const summed = Object.values(costs).reduce((sum, cell) => sum + cell.value, 0);
    if (Math.abs(summed - scenario.explicitCosts) > Math.max(1e-9, Math.abs(scenario.explicitCosts) * 1e-8) || Math.abs((scenario.grossEdge - scenario.explicitCosts) - scenario.netEdge) > Math.max(1e-9, Math.abs(scenario.netEdge) * 1e-8)) return { status: "FAIL", code: "COST_FRAGILE", reason: `${name} gross-cost-net identity is inconsistent` };
    const scenarioStatus = status(scenario.status); if (!scenarioStatus) return { status: "MISSING_EVIDENCE", code: "COST_EVIDENCE_MISSING", reason: `${name} status is invalid` };
    normalized.push({ name, status: scenarioStatus, netEdge: scenario.netEdge }); if (scenarioStatus !== "PASS" || !(scenario.netEdge > 0)) return { status: "FAIL", code: "COST_FRAGILE", reason: `${name} did not preserve positive net edge`, scenarios: normalized };
  }
  return { status: "PASS", scenarios: normalized, robustness: normalized.filter((row) => row.netEdge > 0).length / normalized.length };
}
function validateRegimeStress(raw, policy) {
  if (!raw?.regimes || typeof raw.regimes !== "object") return { status: "MISSING_EVIDENCE", code: "REGIME_EVIDENCE_MISSING", reason: "regime evidence is missing" };
  const normalized = {}; let evaluated = 0; let positive = 0;
  for (const regime of policy.requiredRegimes) {
    const evidence = raw.regimes[regime]; if (!evidence || typeof evidence !== "object") return { status: "MISSING_EVIDENCE", code: "REGIME_EVIDENCE_MISSING", reason: `${regime} regime evidence is missing` };
    if (evidence.availability === "N/A") { if (evidence.sampleCount !== null || evidence.metrics !== null) return { status: "FAIL", code: "REGIME_EVIDENCE_MISSING", reason: `${regime} N/A must preserve null truth` }; if ((policy.minimumRegimeSamples[regime] ?? 0) > 0) return { status: "MISSING_EVIDENCE", code: "REGIME_EVIDENCE_MISSING", reason: `${regime} required sample is unavailable` }; normalized[regime] = { availability: "N/A", sampleCount: null, metrics: null }; continue; }
    if (evidence.availability !== "AVAILABLE" || !Number.isSafeInteger(evidence.sampleCount) || evidence.sampleCount <= 0) return { status: "MISSING_EVIDENCE", code: "REGIME_EVIDENCE_MISSING", reason: `${regime} sample evidence is invalid` };
    for (const key of ["winRate", "expectancy", "maximumDrawdown", "return"]) if (!Number.isFinite(evidence.metrics?.[key])) return { status: "MISSING_EVIDENCE", code: "REGIME_EVIDENCE_MISSING", reason: `${regime}.${key} is missing` };
    if (evidence.metrics.profitFactor !== null && !Number.isFinite(evidence.metrics.profitFactor)) return { status: "MISSING_EVIDENCE", code: "REGIME_EVIDENCE_MISSING", reason: `${regime}.profitFactor is invalid` };
    evaluated += 1; if (evidence.metrics.expectancy > 0) positive += 1; normalized[regime] = snapshot(evidence); if (evidence.passed !== true) return { status: "FAIL", code: "REGIME_COLLAPSE", reason: `${regime} regime failed robustness gate`, regimes: normalized };
  }
  return { status: "PASS", regimes: normalized, robustness: evaluated > 0 ? positive / evaluated : null };
}
function validateNeighborhood(raw, policy) {
  if (!raw || typeof raw !== "object") return { status: "MISSING_EVIDENCE", code: "STATISTICAL_EVIDENCE_MISSING", reason: "parameter neighborhood evidence is missing" };
  if (!Number.isSafeInteger(raw.width) || raw.width < policy.minimumNeighborhoodWidth) return { status: "MISSING_EVIDENCE", code: "PARAMETER_INSTABILITY", reason: "parameter neighborhood width is insufficient" };
  if (!Array.isArray(raw.points) || raw.points.length < (raw.width * 2) + 1) return { status: "MISSING_EVIDENCE", code: "PARAMETER_INSTABILITY", reason: "parameter neighborhood points are insufficient" };
  for (const [index, point] of raw.points.entries()) for (const key of ["expectancy", "maximumDrawdown", "tradeCount"]) if (!Number.isFinite(point[key])) return { status: "MISSING_EVIDENCE", code: "PARAMETER_INSTABILITY", reason: `neighborhood point ${index} ${key} is missing` };
  if (!Number.isFinite(raw.performanceDecay)) return { status: "MISSING_EVIDENCE", code: "PARAMETER_INSTABILITY", reason: "neighborhood performance decay is missing" };
  if (raw.signConsistency !== true || raw.maximumDrawdownConsistency !== true || raw.tradeCountConsistency !== true || raw.needleOptimum === true || raw.passed !== true) return { status: "FAIL", code: "PARAMETER_INSTABILITY", reason: "parameter neighborhood indicates a needle optimum/instability" };
  return { status: "PASS", stability: 1 };
}
function validateStatisticalFirewall(raw, neighborhood, policy, familySize) {
  const normalized = normalizeStageResult(raw, "STATISTICAL_EVIDENCE_MISSING", "statistical firewall evidence is missing"); if (normalized.status !== "PASS") return { status: normalized.status, code: normalized.code, reason: normalized.reason };
  if (raw.canonicalOwner !== "#547") return { status: "MISSING_EVIDENCE", code: "STATISTICAL_EVIDENCE_MISSING", reason: "canonical #547 Statistical Firewall owner evidence is missing" };
  if (!Number.isSafeInteger(raw.candidateFamilySize) || raw.candidateFamilySize < familySize) return { status: "FAIL", code: "MULTIPLE_TESTING_FAIL", reason: "multiple-testing family size understates generated candidates" };
  const requiredAlpha = policy.multipleTestingBaseAlpha / Math.max(1, familySize);
  if (raw.multipleTesting?.passed !== true || !Number.isFinite(raw.multipleTesting.adjustedAlpha) || raw.multipleTesting.adjustedAlpha > requiredAlpha) return { status: "FAIL", code: "MULTIPLE_TESTING_FAIL", reason: "multiple-testing correction is not strict enough for candidate count" };
  if (raw.dsr?.passed !== true || !Number.isFinite(raw.dsr.value)) return { status: "FAIL", code: "DSR_FAIL", reason: "Deflated Sharpe Ratio failed/missing" };
  if (raw.pbo?.passed !== true || !Number.isFinite(raw.pbo.value)) return { status: "FAIL", code: "PBO_FAIL", reason: "PBO failed/missing" };
  if (raw.minimumN?.passed !== true || raw.parameterStability?.passed !== true || raw.walkForwardStability?.passed !== true || raw.regimeStability?.passed !== true) return { status: "FAIL", code: "PARAMETER_INSTABILITY", reason: "statistical stability/minimum-N gate failed" };
  const neighborhoodResult = validateNeighborhood(neighborhood, policy); if (neighborhoodResult.status !== "PASS") return neighborhoodResult;
  return { status: "PASS", requiredAdjustedAlpha: requiredAlpha, confidence: Number.isFinite(raw.confidenceScore) ? clamp01(raw.confidenceScore) : clamp01((clamp01(raw.dsr.value) + clamp01(1 - raw.pbo.value)) / 2), neighborhoodStability: neighborhoodResult.stability };
}
function resourceViolation({ budget, startedAt, totalCandles, resourceSnapshot }) {
  if (performance.now() - startedAt > budget.maxRuntimeMs) return "MAX_RUNTIME"; if (totalCandles > budget.maxTotalCandles) return "MAX_TOTAL_CANDLES";
  if (resourceSnapshot) { if (Number.isFinite(resourceSnapshot.cpuPercent) && resourceSnapshot.cpuPercent > budget.maxCpuPercent) return "MAX_CPU"; if (Number.isFinite(resourceSnapshot.memoryMb) && resourceSnapshot.memoryMb > budget.maxMemoryMb) return "MAX_MEMORY"; if (Number.isInteger(resourceSnapshot.activeBacktests) && resourceSnapshot.activeBacktests >= budget.maxConcurrentBacktests) return "MAX_CONCURRENT_BACKTESTS"; }
  return null;
}
function inputContainsForbiddenHoldoutAccess(input) {
  if (input?.search?.finalHoldoutAccess !== false) return true;
  for (const key of ["finalHoldoutResult", "holdoutEvidence", "holdoutMetrics", "llmPromptContext", "failureFeedback"]) if (input?.[key] !== undefined) return true;
  return false;
}
function failureFromRecord({ formula, generated, records, stage, code, reason, datasetIdentity, observedAt }) {
  const record = records.at(-1); const { failure, observation } = elimination({ stage, code, reason, record, strategyHash: formula?.formulaHash ?? generated?.formulaHash ?? null, parameterIdentity: generated?.parameterIdentity ?? null, datasetIdentity, observedAt });
  return terminalCandidate({ formula, generated, records, failure, observation });
}
function pushAndTerminal({ formula, generated, records, stage, stageStatus, evidence, code, reason, datasetIdentity, observedAt }) {
  const record = stageRecord({ stage, stageStatus, evidence, strategyHash: formula?.formulaHash ?? generated?.formulaHash ?? null, parameterIdentity: generated?.parameterIdentity ?? null, datasetIdentity, observedAt }); records.push(record);
  return stageStatus !== "PASS" ? failureFromRecord({ formula, generated, records, stage, code, reason, datasetIdentity, observedAt }) : null;
}
function formulaInvalidTerminal(formula, index, observedAt, error) {
  const strategyHash = HASH64.test(formula?.formulaHash ?? "") ? formula.formulaHash : null; const datasetIdentity = formula?.provenance?.datasetIdentity ?? null;
  const record = stageRecord({ stage: "FORMULA_CANDIDATE", stageStatus: "FAIL", evidence: { inputIndex: index, error: error instanceof Error ? error.message : String(error) }, strategyHash, parameterIdentity: null, datasetIdentity, observedAt });
  const { failure, observation } = elimination({ stage: "FORMULA_CANDIDATE", code: "FORMULA_INVALID", reason: "FormulaCandidateV1 validation failed", record, strategyHash, parameterIdentity: null, datasetIdentity, observedAt });
  return terminalCandidate({ formula, generated: null, records: [record], failure, observation });
}
function formulaDuplicateTerminal(formula, matched, observedAt) {
  const datasetIdentity = formula.provenance.datasetIdentity; const record = stageRecord({ stage: "FORMULA_CANDIDATE", stageStatus: "FAIL", evidence: { duplicateOf: matched.candidateId, formulaHash: formula.formulaHash }, strategyHash: formula.formulaHash, parameterIdentity: null, datasetIdentity, observedAt });
  const { failure, observation } = elimination({ stage: "FORMULA_CANDIDATE", code: "DUPLICATE_FORMULA", reason: "exact formula hash already exists in this tournament", record, strategyHash: formula.formulaHash, parameterIdentity: null, datasetIdentity, observedAt });
  return terminalCandidate({ formula, generated: null, records: [record], failure, observation });
}

function rankingFor(candidate) {
  const byStage = Object.fromEntries(candidate.stageRecords.map((record) => [record.stage, record.evidence])); const historical = byStage.HISTORICAL_BACKTEST; const oos = byStage.OOS; const wf = byStage.WALK_FORWARD; const costs = byStage.COST_STRESS; const regimes = byStage.REGIME_STRESS; const statistics = byStage.STATISTICAL_FIREWALL; const metrics = historical?.metrics ?? {};
  const expectancy = Number.isFinite(metrics.expectancy) ? clamp01(0.5 + (Math.atan(metrics.expectancy) / Math.PI)) : 0; const pf = metrics.profitFactor === null ? 1 : Number.isFinite(metrics.profitFactor) ? clamp01((metrics.profitFactor - 1) / 2) : 0; const mdd = Number.isFinite(metrics.maximumDrawdown) ? clamp01(1 - Math.abs(metrics.maximumDrawdown)) : 0;
  const components = Object.freeze({ netExpectancy: expectancy, profitFactor: pf, drawdownControl: mdd, stability: Number.isFinite(statistics?.analysis?.neighborhoodStability) ? clamp01(statistics.analysis.neighborhoodStability) : 0,
    oosConsistency: Number.isFinite(oos?.metrics?.expectancy) && Number.isFinite(oos?.metrics?.return) ? (Number(oos.metrics.expectancy > 0) + Number(oos.metrics.return > 0)) / 2 : 0,
    walkForwardConsistency: Number.isFinite(wf?.analysis?.positiveRatio) ? clamp01(wf.analysis.positiveRatio) : 0, costRobustness: Number.isFinite(costs?.analysis?.robustness) ? clamp01(costs.analysis.robustness) : 0,
    regimeRobustness: Number.isFinite(regimes?.analysis?.robustness) ? clamp01(regimes.analysis.robustness) : 0, statisticalConfidence: Number.isFinite(statistics?.analysis?.confidence) ? clamp01(statistics.analysis.confidence) : 0,
    sampleSufficiency: Number.isFinite(historical?.sampleGate?.score) ? clamp01(historical.sampleGate.score) : 0 });
  const score = Object.values(components).reduce((sum, value) => sum + value, 0) / Object.keys(components).length;
  return Object.freeze({ generatedCandidateId: candidate.generatedCandidateId, strategyHash: candidate.strategyHash, parameterIdentity: candidate.parameterIdentity, score, components });
}
export function rankResearchSurvivorsV1(candidates = []) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  return Object.freeze(candidates.filter((candidate) => candidate?.researchSurvivor === true && candidate?.failure === null).map(rankingFor).sort((left, right) => right.score - left.score || left.generatedCandidateId.localeCompare(right.generatedCandidateId)));
}
export function buildResearchTournamentReadModelV1(result) {
  if (!result || !Array.isArray(result.candidates)) throw new TypeError("tournament result is required");
  const stagePass = (stage) => result.candidates.filter((candidate) => candidate.stageRecords.some((record) => record.stage === stage && record.status === "PASS")).length;
  const eliminated = Object.fromEntries(RESEARCH_TOURNAMENT_STAGES.map((stage) => [stage, result.candidates.filter((candidate) => candidate.failure?.failedStage === stage).length]));
  return Object.freeze({
    labels: Object.freeze({ total: "전체 후보", sanity: "Sanity 생존", backtest: "Backtest 생존", oos: "OOS 생존", walkForward: "WF 생존", costs: "Costs 생존", statistics: "Statistics 생존", holdout: "Holdout 생존", survivor: "Research Survivor", hypothesis: "생성 가설", elimination: "탈락 이유" }),
    totals: Object.freeze({ totalCandidates: result.candidates.length, sanitySurvivors: stagePass("SANITY_CHECK"), backtestSurvivors: stagePass("HISTORICAL_BACKTEST"), oosSurvivors: stagePass("OOS"), walkForwardSurvivors: stagePass("WALK_FORWARD"), costStressSurvivors: stagePass("COST_STRESS"), statisticalFirewallSurvivors: stagePass("STATISTICAL_FIREWALL"), finalHoldoutSurvivors: stagePass("FINAL_HOLDOUT"), researchSurvivors: stagePass("RESEARCH_SURVIVOR") }),
    eliminatedByStage: Object.freeze(eliminated),
    strategies: Object.freeze(result.candidates.map((candidate) => Object.freeze({ strategyId: candidate.generatedCandidateId ?? candidate.formulaCandidateId, hypothesisId: candidate.hypothesisId, formula: candidate.formula, hypothesis: candidate.hypothesis,
      sanity: candidate.stageRecords.find((record) => record.stage === "SANITY_CHECK")?.evidence ?? null, backtest: candidate.stageRecords.find((record) => record.stage === "HISTORICAL_BACKTEST")?.evidence ?? null,
      oos: candidate.stageRecords.find((record) => record.stage === "OOS")?.evidence ?? null, purgedOos: candidate.stageRecords.find((record) => record.stage === "PURGED_OOS")?.evidence ?? null,
      walkForward: candidate.stageRecords.find((record) => record.stage === "WALK_FORWARD")?.evidence ?? null, costs: candidate.stageRecords.find((record) => record.stage === "COST_STRESS")?.evidence ?? null,
      regimes: candidate.stageRecords.find((record) => record.stage === "REGIME_STRESS")?.evidence ?? null, statistics: candidate.stageRecords.find((record) => record.stage === "STATISTICAL_FIREWALL")?.evidence ?? null,
      holdout: candidate.stageRecords.find((record) => record.stage === "FINAL_HOLDOUT")?.evidence ?? null, eliminationReason: candidate.failure }))),
  });
}

export async function runResearchTournamentV1(input = {}, dependencies = {}) {
  const observedAt = timestamp(input.observedAt, "observedAt"); if (!Array.isArray(input.formulaCandidates)) throw new TypeError("formulaCandidates must be an array");
  const budget = normalizeResearchTournamentBudgetV1(input.budget); const policy = normalizePolicy(input.policy); if (inputContainsForbiddenHoldoutAccess(input)) throw new Error("FINAL_HOLDOUT_PREACCESS_FORBIDDEN");
  const startedAt = performance.now(); const formulaTerminals = []; const validUnique = []; const seenFormula = new Map();
  for (const [index, formula] of input.formulaCandidates.entries()) {
    try { assertFormulaCandidateV1(formula); } catch (error) { formulaTerminals.push(formulaInvalidTerminal(formula, index, observedAt, error)); continue; }
    const prior = seenFormula.get(formula.formulaHash); if (prior) { formulaTerminals.push(formulaDuplicateTerminal(formula, prior, observedAt)); continue; }
    seenFormula.set(formula.formulaHash, formula); validUnique.push(formula);
  }
  if (validUnique.length === 0) {
    const result = Object.freeze({ schemaVersion: 1, tournamentId: `research-tournament:sha256:${researchDigest({ observedAt, formulas: input.formulaCandidates.map((row) => row?.candidateId ?? null) })}`, status: "COMPLETED", candidates: Object.freeze(formulaTerminals), ranking: Object.freeze([]), researchSurvivorCount: 0, profitable: false, champion: null, safety: safetyEnvelope() });
    return Object.freeze({ ...result, readModel: buildResearchTournamentReadModelV1(result) });
  }
  if (input.formulaCandidates.length > budget.maxCandidatesPerRun) throw new Error("TOURNAMENT_CANDIDATE_BUDGET_EXCEEDED");
  const generation = generateBoundedFormulaCandidatesV1({ formulaCandidates: validUnique, budget: input.generationBudget, search: input.search });
  if (generation.generatedCandidates.length > budget.maxCandidatesPerRun) throw new Error("TOURNAMENT_CANDIDATE_BUDGET_EXCEEDED");
  const formulaById = new Map(validUnique.map((formula) => [formula.candidateId, formula])); const terminals = [...formulaTerminals]; const seenParameters = new Set(); let totalCandles = 0;
  for (const generated of generation.generatedCandidates) {
    const formula = formulaById.get(generated.formulaCandidateId); const records = []; const datasetIdentity = generated.searchProvenance.datasetIdentity;
    records.push(stageRecord({ stage: "FORMULA_CANDIDATE", stageStatus: "PASS", evidence: { formulaCandidateId: formula.candidateId, generatedCandidateId: generated.generatedCandidateId, formulaHash: formula.formulaHash, parameterIdentity: generated.parameterIdentity }, strategyHash: formula.formulaHash, parameterIdentity: generated.parameterIdentity, datasetIdentity, observedAt }));
    if (seenParameters.has(generated.parameterIdentity)) { terminals.push(pushAndTerminal({ formula, generated, records, stage: "SANITY_CHECK", stageStatus: "FAIL", evidence: { duplicateParameterIdentity: generated.parameterIdentity }, code: "DUPLICATE_FORMULA", reason: "exact parameter identity already evaluated", datasetIdentity, observedAt })); continue; }
    seenParameters.add(generated.parameterIdentity);
    const metadataRaw = await callback(dependencies, "loadDatasetMetadata", { formulaCandidate: formula, generatedCandidate: generated, datasetIdentity }); const metadata = sanitizeMetadata(metadataRaw); const sanity = sanityCheck(formula, generated, metadata, policy);
    const sanityTerminal = pushAndTerminal({ formula, generated, records, stage: "SANITY_CHECK", stageStatus: sanity.status, evidence: { metadata, formulaHash: formula.formulaHash, parameterIdentity: generated.parameterIdentity, checks: sanity }, code: sanity.code, reason: sanity.reason, datasetIdentity, observedAt });
    if (sanityTerminal) { terminals.push(sanityTerminal); continue; }
    totalCandles += metadata.candleCount; const resourceReason = resourceViolation({ budget, startedAt, totalCandles, resourceSnapshot: input.resourceSnapshot });
    if (resourceReason) { terminals.push(pushAndTerminal({ formula, generated, records, stage: "HISTORICAL_BACKTEST", stageStatus: "NOT_EVALUABLE", evidence: { resourceLimit: resourceReason, totalCandles, budget }, code: "NOT_EVALUABLE_RESOURCE_LIMIT", reason: `resource budget exceeded: ${resourceReason}`, datasetIdentity, observedAt })); continue; }
    const historicalRaw = await callback(dependencies, "runHistoricalBacktest", { formulaCandidate: formula, generatedCandidate: generated, datasetIdentity, canonicalBacktestOwner: "#690" }); const historicalResult = normalizeStageResult(historicalRaw, "BACKTEST_FAILED", "historical backtest evidence is missing");
    if (historicalResult.status !== "PASS") { terminals.push(pushAndTerminal({ formula, generated, records, stage: "HISTORICAL_BACKTEST", stageStatus: historicalResult.status, evidence: { raw: historicalRaw }, code: historicalResult.code, reason: historicalResult.reason, datasetIdentity, observedAt })); continue; }
    if (historicalRaw.canonicalBacktestOwner !== "#690" || historicalRaw.executionEquivalent !== true) { terminals.push(pushAndTerminal({ formula, generated, records, stage: "HISTORICAL_BACKTEST", stageStatus: "FAIL", evidence: { raw: historicalRaw }, code: "BACKTEST_CONTRACT_INVALID", reason: "historical result did not use #690 one-pass execution-equivalent Backtester", datasetIdentity, observedAt })); continue; }
    const historicalIdentity = assertFrozenIdentity(historicalRaw, formula, generated); if (historicalIdentity) { terminals.push(pushAndTerminal({ formula, generated, records, stage: "HISTORICAL_BACKTEST", stageStatus: "FAIL", evidence: { raw: historicalRaw }, code: historicalIdentity.code, reason: historicalIdentity.reason, datasetIdentity, observedAt })); continue; }
    let historicalMetrics; try { historicalMetrics = truthPreservingMetrics(historicalRaw); } catch (error) { terminals.push(pushAndTerminal({ formula, generated, records, stage: "HISTORICAL_BACKTEST", stageStatus: "MISSING_EVIDENCE", evidence: { error: error instanceof Error ? error.message : String(error) }, code: "NON_FINITE_EVIDENCE", reason: "historical metrics contain non-finite values", datasetIdentity, observedAt })); continue; }
    const sampleGate = sampleSufficiency(historicalRaw, historicalMetrics, policy); const historicalTerminal = pushAndTerminal({ formula, generated, records, stage: "HISTORICAL_BACKTEST", stageStatus: sampleGate.status, evidence: { metrics: historicalMetrics, sampleGate, canonicalBacktestOwner: "#690", executionEquivalent: true }, code: sampleGate.code, reason: sampleGate.reason, datasetIdentity, observedAt });
    if (historicalTerminal) { terminals.push(historicalTerminal); continue; }
    const oosRaw = await callback(dependencies, "runOos", { formulaCandidate: formula, generatedCandidate: generated, trainDatasetIdentity: datasetIdentity }); const oosStage = normalizeStageResult(oosRaw, "OOS_FAILED", "OOS evidence is missing"); let oosValidation = oosStage.status === "PASS" ? validateOos(oosRaw, formula, generated, metadata) : { status: oosStage.status, code: oosStage.code, reason: oosStage.reason }; let oosMetrics = null;
    if (oosValidation.status === "PASS") { try { oosMetrics = truthPreservingMetrics(oosRaw); } catch { oosValidation = { status: "MISSING_EVIDENCE", code: "NON_FINITE_EVIDENCE", reason: "OOS metrics contain non-finite values" }; } }
    const oosTerminal = pushAndTerminal({ formula, generated, records, stage: "OOS", stageStatus: oosValidation.status, evidence: { metrics: oosMetrics, trainDatasetIdentity: oosRaw?.trainDatasetIdentity ?? null, oosDatasetIdentity: oosRaw?.oosDatasetIdentity ?? null }, code: oosValidation.code, reason: oosValidation.reason, datasetIdentity: oosRaw?.oosDatasetIdentity ?? datasetIdentity, observedAt });
    if (oosTerminal) { terminals.push(oosTerminal); continue; }
    const purgedRaw = await callback(dependencies, "runPurgedOos", { formulaCandidate: formula, generatedCandidate: generated, ordinaryOosDatasetIdentity: oosRaw.oosDatasetIdentity }); const purgedStage = normalizeStageResult(purgedRaw, "PURGED_OOS_FAILED", "Purged OOS evidence is missing"); const purgedValidation = purgedStage.status === "PASS" ? validatePurgedOos(purgedRaw, formula, generated, oosRaw.oosDatasetIdentity) : { status: purgedStage.status, code: purgedStage.code, reason: purgedStage.reason };
    const purgedTerminal = pushAndTerminal({ formula, generated, records, stage: "PURGED_OOS", stageStatus: purgedValidation.status, evidence: purgedRaw, code: purgedValidation.code, reason: purgedValidation.reason, datasetIdentity: purgedRaw?.purgedOosDatasetIdentity ?? datasetIdentity, observedAt }); if (purgedTerminal) { terminals.push(purgedTerminal); continue; }
    const wfRaw = await callback(dependencies, "runWalkForward", { formulaCandidate: formula, generatedCandidate: generated, purgedOosDatasetIdentity: purgedRaw.purgedOosDatasetIdentity, maxWindows: budget.maxWalkForwardWindows }); const wfStage = normalizeStageResult(wfRaw, "WALK_FORWARD_FAILED", "walk-forward evidence is missing"); const wfValidation = wfStage.status === "PASS" ? validateWalkForward(wfRaw, formula, generated, policy, budget) : { status: wfStage.status, code: wfStage.code, reason: wfStage.reason };
    const wfTerminal = pushAndTerminal({ formula, generated, records, stage: "WALK_FORWARD", stageStatus: wfValidation.status, evidence: { mode: wfRaw?.mode ?? null, windows: wfRaw?.windows ?? null, analysis: wfValidation }, code: wfValidation.code, reason: wfValidation.reason, datasetIdentity, observedAt }); if (wfTerminal) { terminals.push(wfTerminal); continue; }
    const costRaw = await callback(dependencies, "runCostStress", { formulaCandidate: formula, generatedCandidate: generated, scenarios: policy.requiredCostScenarios, maxScenarios: budget.maxStressScenarios }); const costStage = normalizeStageResult(costRaw, "COST_EVIDENCE_MISSING", "cost stress evidence is missing"); const costValidation = costStage.status === "PASS" ? validateCostStress(costRaw, policy, budget) : { status: costStage.status, code: costStage.code, reason: costStage.reason };
    const costTerminal = pushAndTerminal({ formula, generated, records, stage: "COST_STRESS", stageStatus: costValidation.status, evidence: { scenarios: costRaw?.scenarios ?? null, analysis: costValidation }, code: costValidation.code, reason: costValidation.reason, datasetIdentity, observedAt }); if (costTerminal) { terminals.push(costTerminal); continue; }
    const regimeRaw = await callback(dependencies, "runRegimeStress", { formulaCandidate: formula, generatedCandidate: generated, regimes: policy.requiredRegimes }); const regimeStage = normalizeStageResult(regimeRaw, "REGIME_EVIDENCE_MISSING", "regime stress evidence is missing"); const regimeValidation = regimeStage.status === "PASS" ? validateRegimeStress(regimeRaw, policy) : { status: regimeStage.status, code: regimeStage.code, reason: regimeStage.reason };
    const regimeTerminal = pushAndTerminal({ formula, generated, records, stage: "REGIME_STRESS", stageStatus: regimeValidation.status, evidence: { regimes: regimeRaw?.regimes ?? null, analysis: regimeValidation }, code: regimeValidation.code, reason: regimeValidation.reason, datasetIdentity, observedAt }); if (regimeTerminal) { terminals.push(regimeTerminal); continue; }
    const neighborhoodRaw = await callback(dependencies, "runParameterNeighborhood", { formulaCandidate: formula, generatedCandidate: generated, neighborhoodWidth: policy.minimumNeighborhoodWidth, finalHoldoutAccess: false });
    const statisticsRaw = await callback(dependencies, "runStatisticalFirewall", { formulaCandidate: formula, generatedCandidate: generated, canonicalOwner: "#547", candidateFamilySize: generation.generatedCandidates.length, requiredAdjustedAlpha: policy.multipleTestingBaseAlpha / Math.max(1, generation.generatedCandidates.length), finalHoldoutAccess: false });
    const statisticsValidation = validateStatisticalFirewall(statisticsRaw, neighborhoodRaw, policy, generation.generatedCandidates.length); const statisticsTerminal = pushAndTerminal({ formula, generated, records, stage: "STATISTICAL_FIREWALL", stageStatus: statisticsValidation.status, evidence: { firewall: statisticsRaw, neighborhood: neighborhoodRaw, analysis: statisticsValidation }, code: statisticsValidation.code, reason: statisticsValidation.reason, datasetIdentity, observedAt }); if (statisticsTerminal) { terminals.push(statisticsTerminal); continue; }
    const beforeHoldoutResource = resourceViolation({ budget, startedAt, totalCandles, resourceSnapshot: input.resourceSnapshot }); if (beforeHoldoutResource) { terminals.push(pushAndTerminal({ formula, generated, records, stage: "FINAL_HOLDOUT", stageStatus: "NOT_EVALUABLE", evidence: { resourceLimit: beforeHoldoutResource }, code: "NOT_EVALUABLE_RESOURCE_LIMIT", reason: `resource budget exceeded before Final Holdout: ${beforeHoldoutResource}`, datasetIdentity, observedAt })); continue; }
    const frozenStrategy = Object.freeze({ formulaCandidateId: formula.candidateId, strategyHash: formula.formulaHash, parameterIdentity: generated.parameterIdentity, market: formula.market, timeframe: formula.timeframe, direction: formula.direction, entryDsl: formula.entryDsl, exitDsl: formula.exitDsl, selectedParameters: generated.selectedParameters });
    const capabilityId = `final-holdout-capability:sha256:${researchDigest({ strategyHash: formula.formulaHash, parameterIdentity: generated.parameterIdentity, preHoldoutEvidenceIds: records.map((record) => record.evidenceId) })}`;
    const holdoutRaw = await callback(dependencies, "runFinalHoldout", { frozenStrategy, capabilityId, evaluationOrdinal: 1, selectionAllowed: false, parameterTuningAllowed: false, formulaCompilerAccess: false, candidateGeneratorAccess: false, failureFeedbackAccess: false, llmPromptContextAccess: false }); const holdoutStage = normalizeStageResult(holdoutRaw, "HOLDOUT_FAIL", "Final Holdout evidence is missing"); let holdoutValidation = { status: holdoutStage.status, code: holdoutStage.code, reason: holdoutStage.reason };
    if (holdoutStage.status === "PASS") { const identityError = assertFrozenIdentity(holdoutRaw, formula, generated); if (identityError) holdoutValidation = { status: "FAIL", ...identityError }; else if (holdoutRaw.evaluationCount !== 1 || holdoutRaw.capabilityId !== capabilityId || holdoutRaw.selectionAllowed !== false || holdoutRaw.parameterTuningAllowed !== false) holdoutValidation = { status: "FAIL", code: "HOLDOUT_CONTRACT_INVALID", reason: "Final Holdout was not a one-shot frozen evaluation" }; }
    const holdoutTerminal = pushAndTerminal({ formula, generated, records, stage: "FINAL_HOLDOUT", stageStatus: holdoutValidation.status, evidence: { evaluationCount: holdoutRaw?.evaluationCount ?? null, capabilityId: holdoutRaw?.capabilityId ?? null, datasetIdentity: holdoutRaw?.datasetIdentity ?? null, metrics: holdoutRaw?.metrics ?? null, selectionAllowed: holdoutRaw?.selectionAllowed ?? null, parameterTuningAllowed: holdoutRaw?.parameterTuningAllowed ?? null }, code: holdoutValidation.code, reason: holdoutValidation.reason, datasetIdentity: holdoutRaw?.datasetIdentity ?? datasetIdentity, observedAt }); if (holdoutTerminal) { terminals.push(holdoutTerminal); continue; }
    records.push(stageRecord({ stage: "RESEARCH_SURVIVOR", stageStatus: "PASS", evidence: { survivor: true, profitable: false, provisionalChampion: false, validatedChampion: false, tradingAuthority: false }, strategyHash: formula.formulaHash, parameterIdentity: generated.parameterIdentity, datasetIdentity: holdoutRaw.datasetIdentity, observedAt }));
    terminals.push(terminalCandidate({ formula, generated, records, survivor: true }));
  }
  const ranking = rankResearchSurvivorsV1(terminals); const core = { observedAt, formulaCandidateIds: input.formulaCandidates.map((formula) => formula?.candidateId ?? null), generatedCandidateIds: generation.generatedCandidates.map((candidate) => candidate.generatedCandidateId), evidenceIds: terminals.flatMap((candidate) => candidate.stageRecords.map((record) => record.evidenceId)) };
  const result = Object.freeze({ schemaVersion: 1, tournamentId: `research-tournament:sha256:${researchDigest(core)}`, status: "COMPLETED", generation: Object.freeze({ generatedCandidateCount: generation.generatedCandidates.length, budgetUsage: generation.budgetUsage, deduplicationDecisions: generation.deduplicationDecisions, finalHoldoutAccess: false }), candidates: Object.freeze(terminals), ranking, researchSurvivorCount: terminals.filter((candidate) => candidate.researchSurvivor).length, profitable: false, champion: null, safety: safetyEnvelope() });
  return Object.freeze({ ...result, readModel: buildResearchTournamentReadModelV1(result) });
}

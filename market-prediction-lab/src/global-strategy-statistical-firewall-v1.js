import { verifyGlobalStrategyResearchRecord } from "./global-alpha-literature-registry-v1.js";
import { researchDigest } from "./research-trial-registry.js";
import {
  computeCscvPbo,
  computeDeflatedSharpeRatio,
} from "./selection-bias-statistics.js";
import { evaluateRealityCheckAndSpa } from "./spa-reality-check.js";

export const GLOBAL_STRATEGY_STATISTICAL_FIREWALL_SCHEMA_VERSION = 1;

const REPLICATION_STATUSES = new Set([
  "REPLICATED",
  "PARTIALLY_REPLICATED",
  "NOT_REPLICATED",
  "INCONCLUSIVE",
  "BLOCKED_DATA",
]);

const MARKET_COST_REQUIREMENTS = Object.freeze({
  KR_STOCK: Object.freeze(["commission", "spread", "slippage", "tax", "liquidityImpact"]),
  US_STOCK: Object.freeze(["commission", "spread", "slippage", "tax", "fx", "liquidityImpact"]),
  DEVELOPED_STOCK: Object.freeze(["commission", "spread", "slippage", "tax", "fx", "liquidityImpact"]),
  CRYPTO_SPOT: Object.freeze(["commission", "spread", "slippage", "liquidityImpact"]),
  CRYPTO_FUTURES: Object.freeze(["commission", "spread", "slippage", "funding", "liquidityImpact"]),
});

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function canonicalJson(value, name = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return finiteNumber(value, name);
  if (Array.isArray(value)) return Object.freeze(value.map((item, index) => canonicalJson(item, `${name}[${index}]`)));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.freeze(Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key], `${name}.${key}`)])));
  }
  throw new TypeError(`${name} must contain only JSON values`);
}

function firewallSafety() {
  return Object.freeze({
    evidenceOnly: true,
    profitabilityAuthority: false,
    promotionAuthority: false,
    scannerAuthority: false,
    championAuthority: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
    actualOrders: 0,
    actualCancels: 0,
    actualAmends: 0,
    actualTransfers: 0,
    actualWithdrawals: 0,
  });
}

function normalizeReplicationMetrics(value, status) {
  if (value == null) return null;
  if (status === "BLOCKED_DATA") throw new Error("BLOCKED_DATA cannot carry replication metrics");
  return canonicalJson(value, "replication.metrics");
}

export function createPaperReplicationAssessment({ researchRecord, replication } = {}) {
  if (!verifyGlobalStrategyResearchRecord(researchRecord)) throw new Error("GLOBAL_STRATEGY_RESEARCH_RECORD_INVALID");
  const raw = replication ?? {};
  const status = requiredString(raw.status, "replication.status").toUpperCase();
  if (!REPLICATION_STATUSES.has(status)) throw new RangeError("replication.status is unsupported");
  const researchCodeSha = requiredString(raw.researchCodeSha, "replication.researchCodeSha").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(researchCodeSha)) throw new TypeError("replication.researchCodeSha must be an exact 40-character SHA");
  const sourceResearchId = requiredString(raw.sourceResearchId, "replication.sourceResearchId");
  if (sourceResearchId !== researchRecord.researchSourceId) throw new Error("REPLICATION_SOURCE_MISMATCH");
  const dataProvenance = canonicalJson(raw.dataProvenance, "replication.dataProvenance");
  if (!dataProvenance || typeof dataProvenance !== "object" || Array.isArray(dataProvenance)) {
    throw new TypeError("replication.dataProvenance is required");
  }
  const failureReason = raw.failureReason == null ? null : requiredString(raw.failureReason, "replication.failureReason");
  if (status !== "REPLICATED" && failureReason === null) throw new Error("non-replicated outcomes require failureReason");
  if (status === "REPLICATED" && failureReason !== null) throw new Error("REPLICATED cannot carry failureReason");
  const metrics = normalizeReplicationMetrics(raw.metrics, status);
  if (new Set(["REPLICATED", "PARTIALLY_REPLICATED"]).has(status) && metrics === null) {
    throw new Error(`${status} requires deterministic metrics`);
  }
  const core = Object.freeze({
    researchSourceId: researchRecord.researchSourceId,
    strategyFamilyId: researchRecord.strategyDna.strategyFamilyId,
    strategyDnaHash: researchRecord.strategyDna.strategyDnaHash,
    paperVariantId: researchRecord.strategyDna.paperVariantId,
    sourceFingerprint: researchRecord.sourceMetadata.sourceFingerprint,
    researchCodeSha,
    datasetFingerprint: requiredString(raw.datasetFingerprint, "replication.datasetFingerprint"),
    dataProvenance,
    parameterMappingStatus: requiredString(raw.parameterMappingStatus, "replication.parameterMappingStatus").toUpperCase(),
    metricDefinitionFingerprint: requiredString(raw.metricDefinitionFingerprint, "replication.metricDefinitionFingerprint"),
    status,
    failureReason,
    metrics,
    ourReplicationSampleN: raw.ourReplicationSampleN == null
      ? null
      : finiteNumber(raw.ourReplicationSampleN, "replication.ourReplicationSampleN"),
  });
  if (core.ourReplicationSampleN !== null && (!Number.isInteger(core.ourReplicationSampleN) || core.ourReplicationSampleN <= 0)) {
    throw new RangeError("replication.ourReplicationSampleN must be a positive integer");
  }
  return Object.freeze({
    schemaVersion: GLOBAL_STRATEGY_STATISTICAL_FIREWALL_SCHEMA_VERSION,
    ...core,
    replicationAssessmentId: `paper-replication:${researchDigest(core)}`,
    paperReportedMetricsKeptSeparate: true,
    failedReplicationPreserved: status !== "REPLICATED",
    safety: firewallSafety(),
  });
}

function validateReturnSeries(series, name) {
  if (!Array.isArray(series)) throw new TypeError(`${name} must be an array`);
  if (series.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError(`${name} must contain finite returns`);
  }
}

function insufficient(method, reason, required, observed) {
  return Object.freeze({
    method,
    status: "INSUFFICIENT_EVIDENCE",
    reason,
    required,
    observed,
    result: null,
  });
}

function assessDsr(selectedReturns, trialReturnSeries) {
  if (selectedReturns.length < 3 || trialReturnSeries.length < 1) {
    return insufficient("DEFLATED_SHARPE_RATIO", "minimum observations or trials not met", { selectedObservations: 3, trials: 1 }, { selectedObservations: selectedReturns.length, trials: trialReturnSeries.length });
  }
  if (trialReturnSeries.some((series) => series.length < 2)) {
    return insufficient("DEFLATED_SHARPE_RATIO", "trial return series is too short", { observationsPerTrial: 2 }, { minimumObservationsPerTrial: Math.min(...trialReturnSeries.map((series) => series.length)) });
  }
  return Object.freeze({ method: "DEFLATED_SHARPE_RATIO", status: "EVIDENCE_READY", reason: null, result: computeDeflatedSharpeRatio(selectedReturns, trialReturnSeries) });
}

function assessPbo(trials, blockCount, maxCombinations) {
  const aligned = new Set(trials.map((trial) => trial.returnSeries.length)).size <= 1;
  const minimumObservations = trials.length ? Math.min(...trials.map((trial) => trial.returnSeries.length)) : 0;
  if (trials.length < 3 || minimumObservations < blockCount || !aligned) {
    return insufficient("CSCV_PBO", aligned ? "minimum trials or aligned observations not met" : "trial observations are not aligned", { trials: 3, observationsPerTrial: blockCount, aligned: true }, { trials: trials.length, minimumObservationsPerTrial: minimumObservations, aligned });
  }
  return Object.freeze({ method: "CSCV_PBO", status: "EVIDENCE_READY", reason: null, result: computeCscvPbo(trials, { blockCount, maxCombinations }) });
}

function assessRealityCheck(trials, benchmarkReturns, realityCheckPolicy) {
  const n = trials[0]?.returnSeries.length ?? 0;
  if (trials.length < 2 || n < 2 || new Set(trials.map((trial) => trial.returnSeries.length)).size !== 1) {
    return insufficient("REALITY_CHECK_AND_SPA", "minimum aligned strategy evidence not met", { strategies: 2, observationsPerStrategy: 2, aligned: true }, { strategies: trials.length, observationsPerStrategy: n });
  }
  if (!realityCheckPolicy || realityCheckPolicy.status !== "empirically_calibrated") {
    return insufficient("REALITY_CHECK_AND_SPA", "empirically calibrated bootstrap policy is required", { calibratedPolicy: true }, { calibratedPolicy: false });
  }
  const result = evaluateRealityCheckAndSpa({
    strategyReturns: Object.fromEntries(trials.map((trial) => [trial.trialId, trial.returnSeries])),
    benchmarkReturns,
    policy: realityCheckPolicy,
  });
  return Object.freeze({ method: "REALITY_CHECK_AND_SPA", status: result.status === "EVIDENCE_READY" ? "EVIDENCE_READY" : "INSUFFICIENT_EVIDENCE", reason: result.reason ?? null, result });
}

export function evaluateGlobalStrategyStatisticalFirewall({
  trials = [],
  selectedTrialId,
  benchmarkReturns = null,
  blockCount = 8,
  maxCombinations = 5000,
  realityCheckPolicy = null,
  decisionPolicy = null,
} = {}) {
  if (!Array.isArray(trials)) throw new TypeError("trials must be an array");
  const normalizedTrials = trials.map((trial, index) => {
    const trialId = requiredString(trial?.trialId, `trials[${index}].trialId`);
    validateReturnSeries(trial?.returnSeries, `trials[${index}].returnSeries`);
    return Object.freeze({ trialId, returnSeries: Object.freeze([...trial.returnSeries]) });
  });
  if (new Set(normalizedTrials.map((trial) => trial.trialId)).size !== normalizedTrials.length) throw new Error("DUPLICATE_TRIAL_ID");
  const selected = normalizedTrials.find((trial) => trial.trialId === selectedTrialId) ?? null;
  if (benchmarkReturns !== null) validateReturnSeries(benchmarkReturns, "benchmarkReturns");

  const dsr = selected
    ? assessDsr(selected.returnSeries, normalizedTrials.map((trial) => trial.returnSeries))
    : insufficient("DEFLATED_SHARPE_RATIO", "selected trial is absent", { selectedTrial: true }, { selectedTrial: false });
  const pbo = assessPbo(normalizedTrials, blockCount, maxCombinations);
  const realityCheckAndSpa = assessRealityCheck(normalizedTrials, benchmarkReturns, realityCheckPolicy);
  const allReady = [dsr, pbo, realityCheckAndSpa].every((row) => row.status === "EVIDENCE_READY");

  let decision = Object.freeze({ status: "THRESHOLDS_NOT_APPLIED", reasons: Object.freeze(["empirically calibrated decision policy is required"]) });
  if (allReady && decisionPolicy?.status === "empirically_calibrated") {
    for (const key of ["maxPbo", "minDsrProbability", "alpha"]) finiteNumber(decisionPolicy[key], `decisionPolicy.${key}`);
    const reasons = [];
    if (pbo.result.pbo > decisionPolicy.maxPbo) reasons.push("PBO_EXCEEDS_POLICY");
    if (dsr.result.probability < decisionPolicy.minDsrProbability) reasons.push("DSR_BELOW_POLICY");
    if (realityCheckAndSpa.result.realityCheck.pValue > decisionPolicy.alpha) reasons.push("REALITY_CHECK_NULL_NOT_REJECTED");
    if (realityCheckAndSpa.result.spa.pValue > decisionPolicy.alpha) reasons.push("SPA_NULL_NOT_REJECTED");
    decision = Object.freeze({ status: reasons.length ? "RESEARCH_HOLD" : "STATISTICAL_REVIEW_READY", reasons: Object.freeze(reasons) });
  }

  return Object.freeze({
    schemaVersion: GLOBAL_STRATEGY_STATISTICAL_FIREWALL_SCHEMA_VERSION,
    status: allReady ? "EVIDENCE_READY" : "INSUFFICIENT_EVIDENCE",
    trialCount: normalizedTrials.length,
    selectedTrialId: selected?.trialId ?? null,
    dataSnoopingDisclosure: Object.freeze({
      allSelectionTrialsCounted: true,
      trialCountDerivedFromEvidence: true,
      userSuppliedTrialCountAccepted: false,
      finalHoldoutMayBeUsedForSelection: false,
    }),
    dsr,
    pbo,
    realityCheckAndSpa,
    decision,
    safety: firewallSafety(),
  });
}

function normalizeCostEvidence(raw, dimension) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const status = requiredString(raw.status, `costs.${dimension}.status`).toUpperCase();
  if (!new Set(["MEASURED", "MODELED"]).has(status)) throw new RangeError(`costs.${dimension}.status is unsupported`);
  const valueBps = finiteNumber(raw.valueBps, `costs.${dimension}.valueBps`);
  if (valueBps < 0) throw new RangeError(`costs.${dimension}.valueBps cannot be negative`);
  const sourceProvenance = canonicalJson(raw.sourceProvenance, `costs.${dimension}.sourceProvenance`);
  if (!sourceProvenance || typeof sourceProvenance !== "object" || Array.isArray(sourceProvenance)) {
    throw new TypeError(`costs.${dimension}.sourceProvenance is required`);
  }
  return Object.freeze({ status, valueBps, sourceProvenance });
}

export function evaluateStrategyEconomicReality({ market, direction, costPolicyVersion, costs = {} } = {}) {
  const normalizedMarket = requiredString(market, "market").toUpperCase();
  const requirements = MARKET_COST_REQUIREMENTS[normalizedMarket];
  if (!requirements) throw new RangeError("market is unsupported");
  const normalizedDirection = requiredString(direction, "direction").toUpperCase();
  const dimensions = new Set(["KR_STOCK", "US_STOCK", "DEVELOPED_STOCK"]).has(normalizedMarket)
    && new Set(["SHORT", "LONG_SHORT"]).has(normalizedDirection)
    ? Object.freeze([...requirements, "borrow"])
    : requirements;
  if (!costs || typeof costs !== "object" || Array.isArray(costs)) throw new TypeError("costs must be an object");
  const normalizedCosts = Object.freeze(Object.fromEntries(dimensions.map((dimension) => [dimension, normalizeCostEvidence(costs[dimension], dimension)])));
  const missingDimensions = Object.freeze(dimensions.filter((dimension) => normalizedCosts[dimension] === null));
  const totalExpectedCostBps = missingDimensions.length
    ? null
    : dimensions.reduce((sum, dimension) => sum + normalizedCosts[dimension].valueBps, 0);
  return Object.freeze({
    schemaVersion: GLOBAL_STRATEGY_STATISTICAL_FIREWALL_SCHEMA_VERSION,
    status: missingDimensions.length ? "BLOCKED_DATA" : "ECONOMIC_EVIDENCE_READY",
    market: normalizedMarket,
    direction: normalizedDirection,
    costPolicyVersion: requiredString(costPolicyVersion, "costPolicyVersion"),
    requiredDimensions: dimensions,
    costs: normalizedCosts,
    missingDimensions,
    totalExpectedCostBps,
    marketNormalization: Object.freeze({
      normalizedAway: false,
      crossMarketComparisonAllowed: false,
      marketSpecificEvidencePreserved: true,
    }),
    blockers: missingDimensions.length ? Object.freeze(missingDimensions.map((dimension) => `MISSING_${dimension.toUpperCase()}_EVIDENCE`)) : Object.freeze([]),
    safety: firewallSafety(),
  });
}

export function globalStrategyEconomicRealityRequirements() {
  return MARKET_COST_REQUIREMENTS;
}

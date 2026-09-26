import { resolveCanonicalStrategyIdentity } from "./canonical-strategy-identity-v1.js";
import { sha256Canonical } from "./research-cache-provenance.js";

export const AUTONOMOUS_ALPHA_FACTORY_PHASE3_SCHEMA_VERSION = "autonomous-alpha-factory-phase3-v1";

export const PHASE3_EVIDENCE_STATUSES = Object.freeze([
  "PASS",
  "FAIL",
  "MISSING_EVIDENCE",
  "NOT_EVALUABLE",
]);

export const PHASE3_HEALTH_STATES = Object.freeze([
  "HEALTHY",
  "DEGRADED",
  "UNSTABLE",
  "INSUFFICIENT_EVIDENCE",
  "BLOCKED",
  "INVALID",
]);

export const PHASE3_HEALTH_DIMENSIONS = Object.freeze([
  "historicalRobustness",
  "oosRobustness",
  "walkForwardStability",
  "costRobustness",
  "regimeRobustness",
  "statisticalConfidence",
  "shadowDirectionalQuality",
  "driftHealth",
  "naturalPaperMaturity",
  "settlementMaturity",
  "safetyIntegrity",
]);

export const PHASE3_NATURAL_PAPER_STAGE_ORDER = Object.freeze([
  "SIGNAL_CANDIDATE",
  "QUALITY_PASSED",
  "RISK_PASSED",
  "ENTRY_ELIGIBLE",
  "ENTRY",
  "POSITION",
  "EXIT_ELIGIBLE",
  "SETTLEMENT",
]);

export const PHASE3_SHADOW_DIRECTIONS = Object.freeze(["LONG", "NEUTRAL", "SHORT"]);
export const PHASE3_REGIMES = Object.freeze(["BULL", "BEAR", "SIDEWAYS"]);

export const PHASE3_SAFETY = Object.freeze({
  LIVE_TRADING: false,
  AUTO_TRADING: false,
  REAL_ORDER_ENABLED: false,
  PRIVATE_TRADING_API_ALLOWED: false,
  executionAuthority: "NONE",
  orderSubmitted: false,
  orderSubmitApiCalls: 0,
  brokerPrivateCalls: 0,
  exchangePrivateEndpointCalls: 0,
  cancels: 0,
  amends: 0,
  transfers: 0,
  withdrawals: 0,
});

export const PHASE3_DEFAULT_BUDGET = Object.freeze({
  maxActiveShadowStrategies: 8,
  maxNaturalPaperStrategies: 4,
  maxSignalsPerCycle: 2_000,
  maxSettlementsTracked: 10_000,
  maxResearchGenerations: 8,
  maxConcurrentCandidates: 16,
  maxEvidenceRetentionDays: 180,
});

export const PHASE3_DEFAULT_SHADOW_POLICY = Object.freeze({
  minimumTotalN: 30,
  minimumIndependentDays: 5,
  minimumLongSupport: 5,
  minimumShortSupport: 5,
  minimumNeutralSupport: 5,
  minimumBullRegimeN: 5,
  minimumBearRegimeN: 5,
  minimumSidewaysRegimeN: 5,
  minimumDirectionalRecall: 0.2,
  maximumNeutralShare: 0.8,
  maximumCalibrationError: 0.35,
});

export const PHASE3_DEFAULT_SETTLEMENT_POLICY = Object.freeze({
  minimumSettledN: 30,
  minimumIndependentDays: 10,
  minimumBullRegimeN: 5,
  minimumBearRegimeN: 5,
  minimumSidewaysRegimeN: 5,
  minimumLongN: 10,
  minimumShortN: 10,
  minimumProfitFactor: 1,
  minimumExpectancy: 0,
});

export const PHASE3_DEFAULT_NATURAL_PAPER_POLICY = Object.freeze({
  minimumNaturalCycles: 5,
  minimumIndependentDays: 3,
  minimumSettlementCycles: 1,
});

const TOURNAMENT_REQUIRED_PASS_STAGES = Object.freeze([
  "SANITY_CHECK",
  "HISTORICAL_BACKTEST",
  "OOS",
  "PURGED_OOS",
  "WALK_FORWARD",
  "COST_STRESS",
  "REGIME_STRESS",
  "STATISTICAL_FIREWALL",
  "FINAL_HOLDOUT",
]);
const COST_FIELDS = Object.freeze([
  "commission",
  "spread",
  "slippage",
  "funding",
  "tax",
  "latency",
  "liquidityImpact",
]);
const NATURAL_DISQUALIFYING_FLAGS = Object.freeze([
  "replay",
  "manualReplay",
  "historicalBackfill",
  "reconstructedHistoricalEvent",
  "fixture",
  "synthetic",
  "testSample",
  "qaSample",
]);
const HASH_64 = /^[0-9a-f]{64}$/u;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function iso(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function unique(values) {
  return [...new Set(values)].sort();
}

function normalizedStatus(value, fallback = "MISSING_EVIDENCE") {
  return PHASE3_EVIDENCE_STATUSES.includes(value) ? value : fallback;
}

function statusResult(schemaVersion, status, blockers, extra = {}) {
  return deepFreeze({
    schemaVersion,
    status: normalizedStatus(status),
    blockers: unique(blockers),
    ...extra,
    safety: PHASE3_SAFETY,
  });
}

function validateBudget(budget) {
  const source = record(budget);
  if (!source) throw new TypeError("Phase 3 budget is required");
  for (const field of Object.keys(PHASE3_DEFAULT_BUDGET)) {
    if (!Number.isInteger(source[field]) || source[field] <= 0) {
      throw new TypeError(`PHASE3_BUDGET_INVALID:${field}`);
    }
  }
  return source;
}

function validateShadowPolicy(policy) {
  const source = record(policy);
  if (!source) throw new TypeError("Shadow sufficiency policy is required");
  for (const field of [
    "minimumTotalN",
    "minimumIndependentDays",
    "minimumLongSupport",
    "minimumShortSupport",
    "minimumNeutralSupport",
    "minimumBullRegimeN",
    "minimumBearRegimeN",
    "minimumSidewaysRegimeN",
  ]) {
    if (!nonNegativeInteger(source[field])) throw new TypeError(`SHADOW_POLICY_INVALID:${field}`);
  }
  for (const field of ["minimumDirectionalRecall", "maximumNeutralShare", "maximumCalibrationError"]) {
    if (!finite(source[field]) || source[field] < 0 || source[field] > 1) {
      throw new TypeError(`SHADOW_POLICY_INVALID:${field}`);
    }
  }
  return source;
}

function validateSettlementPolicy(policy) {
  const source = record(policy);
  if (!source) throw new TypeError("Settlement sufficiency policy is required");
  for (const field of [
    "minimumSettledN",
    "minimumIndependentDays",
    "minimumBullRegimeN",
    "minimumBearRegimeN",
    "minimumSidewaysRegimeN",
    "minimumLongN",
    "minimumShortN",
  ]) {
    if (!nonNegativeInteger(source[field])) throw new TypeError(`SETTLEMENT_POLICY_INVALID:${field}`);
  }
  if (!finite(source.minimumProfitFactor) || !finite(source.minimumExpectancy)) {
    throw new TypeError("SETTLEMENT_POLICY_THRESHOLD_INVALID");
  }
  return source;
}

function validateNaturalPaperPolicy(policy) {
  const source = record(policy);
  if (!source) throw new TypeError("Natural Paper sufficiency policy is required");
  for (const field of ["minimumNaturalCycles", "minimumIndependentDays", "minimumSettlementCycles"]) {
    if (!nonNegativeInteger(source[field])) throw new TypeError(`NATURAL_PAPER_POLICY_INVALID:${field}`);
  }
  return source;
}

function resolveIdentity(input) {
  const resolved = resolveCanonicalStrategyIdentity(input);
  return resolved.status === "IDENTITY_COMPLETE" ? resolved : null;
}

function canonicalDatasetIdentity(value) {
  if (nonEmpty(value)) return { datasetId: value.trim(), datasetDigest: null };
  const source = record(value);
  if (!source || !nonEmpty(source.datasetId)) return null;
  return {
    datasetId: source.datasetId.trim(),
    datasetDigest: nonEmpty(source.datasetDigest) ? source.datasetDigest.toLowerCase() : null,
  };
}

function validDigest(value) {
  return nonEmpty(value) && HASH_64.test(value.toLowerCase());
}

function verifyCanonicalDigest(value, digestField = "evidenceDigest") {
  const source = record(value);
  if (!source || !validDigest(source[digestField])) return false;
  const body = structuredClone(source);
  delete body[digestField];
  return source[digestField].toLowerCase() === sha256Canonical(body);
}

function provenanceValid(value) {
  const source = record(value);
  return source?.status === "VALID" && validDigest(source.evidenceDigest);
}

function safetyValid(value) {
  const source = record(value);
  return source?.LIVE_TRADING === false
    && source?.AUTO_TRADING === false
    && source?.REAL_ORDER_ENABLED === false
    && source?.PRIVATE_TRADING_API_ALLOWED === false
    && source?.executionAuthority === "NONE";
}

export function admitResearchSurvivorToShadowV1({
  survivorEvidence,
  strategyIdentity,
  observedAt,
  resourceUsage = {},
  budget = PHASE3_DEFAULT_BUDGET,
} = {}) {
  const at = iso(observedAt);
  const limits = validateBudget(budget);
  const blockers = [];
  const evidence = record(survivorEvidence);
  const identity = resolveIdentity(strategyIdentity);
  if (!at) blockers.push("OBSERVED_AT_INVALID");
  if (!identity) blockers.push("STRATEGY_IDENTITY_INCOMPLETE");
  if (!evidence) blockers.push("RESEARCH_SURVIVOR_EVIDENCE_MISSING");
  if ((resourceUsage.activeShadowStrategies ?? 0) >= limits.maxActiveShadowStrategies) {
    return statusResult("shadow-admission-v1", "NOT_EVALUABLE", ["NOT_EVALUABLE_RESOURCE_LIMIT"], {
      admitted: false,
      shadowCandidate: null,
    });
  }
  if (evidence) {
    if (evidence.schemaVersion !== "research-survivor-evidence-v1") blockers.push("SURVIVOR_SCHEMA_INVALID");
    if (evidence.status !== "PASS" || evidence.researchSurvivor !== true) blockers.push("NOT_RESEARCH_SURVIVOR");
    if (!nonEmpty(evidence.hypothesisId)) blockers.push("HYPOTHESIS_ID_MISSING");
    if (!provenanceValid(evidence.provenance)) blockers.push("SURVIVOR_PROVENANCE_INVALID");
    const stages = record(evidence.tournamentStages);
    for (const stage of TOURNAMENT_REQUIRED_PASS_STAGES) {
      if (stages?.[stage]?.status !== "PASS") blockers.push(`TOURNAMENT_STAGE_NOT_PASS:${stage}`);
    }
    if (evidence.finalHoldout?.status !== "PASS" || !validDigest(evidence.finalHoldout?.evidenceDigest)) {
      blockers.push("FINAL_HOLDOUT_PASS_REQUIRED");
    }
    if (evidence.statisticalFirewall?.status !== "PASS" || !validDigest(evidence.statisticalFirewall?.evidenceDigest)) {
      blockers.push("STATISTICAL_FIREWALL_PASS_REQUIRED");
    }
  }
  if (identity && evidence) {
    const dataset = canonicalDatasetIdentity(evidence.datasetIdentity);
    if (evidence.strategyId !== identity.identity.strategyId) blockers.push("STRATEGY_IDENTITY_MISMATCH");
    if (evidence.formulaHash !== identity.identity.formulaHash) blockers.push("FORMULA_IDENTITY_MISMATCH");
    if (evidence.parameterIdentity !== identity.identity.parameterHash) blockers.push("PARAMETER_IDENTITY_MISMATCH");
    if (dataset?.datasetId !== identity.identity.datasetId
      || (dataset.datasetDigest != null && dataset.datasetDigest !== identity.identity.datasetDigest)) {
      blockers.push("DATASET_IDENTITY_MISMATCH");
    }
    if (evidence.costPolicyIdentity !== identity.identity.costPolicyVersion) blockers.push("COST_POLICY_IDENTITY_MISMATCH");
    if (evidence.riskPolicyIdentity !== identity.identity.riskPolicyVersion) blockers.push("RISK_POLICY_IDENTITY_MISMATCH");
  }
  if (blockers.length) {
    return statusResult("shadow-admission-v1", blockers.some((code) => code.includes("MISSING") || code.includes("NOT_PASS"))
      ? "MISSING_EVIDENCE" : "FAIL", blockers, { admitted: false, shadowCandidate: null });
  }
  const body = {
    schemaVersion: "shadow-candidate-v1",
    status: "PASS",
    admitted: true,
    strategyId: identity.identity.strategyId,
    strategyIdentity: identity.identity,
    strategyIdentityDigest: identity.strategyIdentityDigest,
    formulaHash: evidence.formulaHash,
    hypothesisId: evidence.hypothesisId,
    parameterIdentity: evidence.parameterIdentity,
    datasetIdentity: canonicalDatasetIdentity(evidence.datasetIdentity),
    costPolicyIdentity: evidence.costPolicyIdentity,
    riskPolicyIdentity: evidence.riskPolicyIdentity,
    tournamentEvidenceDigest: sha256Canonical({
      stages: evidence.tournamentStages,
      finalHoldout: evidence.finalHoldout,
      statisticalFirewall: evidence.statisticalFirewall,
      provenance: evidence.provenance,
    }),
    admittedAt: at,
    identityFrozen: true,
    formulaMutationAllowed: false,
    parameterMutationAllowed: false,
    executionAuthority: "NONE",
  };
  const shadowCandidate = deepFreeze({ ...body, candidateDigest: sha256Canonical(body) });
  return statusResult("shadow-admission-v1", "PASS", [], { admitted: true, shadowCandidate });
}

export function createShadowForwardObservationV1({ shadowCandidate, observation } = {}) {
  const candidate = record(shadowCandidate);
  const input = record(observation);
  const blockers = [];
  if (candidate?.schemaVersion !== "shadow-candidate-v1" || candidate.status !== "PASS" || candidate.identityFrozen !== true) {
    blockers.push("SHADOW_CANDIDATE_INVALID");
  }
  if (!input) blockers.push("SHADOW_OBSERVATION_MISSING");
  const timestamp = iso(input?.timestamp);
  const outcomeObservedAt = iso(input?.outcomeObservedAt);
  if (!timestamp) blockers.push("SHADOW_TIMESTAMP_INVALID");
  if (!outcomeObservedAt || (timestamp && Date.parse(outcomeObservedAt) <= Date.parse(timestamp))) {
    blockers.push("SHADOW_OUTCOME_TIME_INVALID");
  }
  for (const field of ["observationId", "symbol", "timeframe", "market", "expectedAction", "regime"]) {
    if (!nonEmpty(input?.[field])) blockers.push(`SHADOW_FIELD_MISSING:${field}`);
  }
  if (!PHASE3_SHADOW_DIRECTIONS.includes(input?.signal)) blockers.push("SHADOW_SIGNAL_INVALID");
  if (!PHASE3_SHADOW_DIRECTIONS.includes(input?.actualDirection)) blockers.push("SHADOW_OUTCOME_INVALID");
  if (!PHASE3_REGIMES.includes(input?.regime)) blockers.push("SHADOW_REGIME_INVALID");
  if (!finite(input?.confidence) || input.confidence < 0 || input.confidence > 1) blockers.push("SHADOW_CONFIDENCE_INVALID");
  if (input?.strategyIdentityDigest !== candidate?.strategyIdentityDigest) blockers.push("SHADOW_STRATEGY_IDENTITY_MISMATCH");
  if (input?.sourceKind !== "NATURAL_FORWARD") blockers.push("SHADOW_NOT_FORWARD_ONLY");
  if (input?.replay === true || input?.historical === true || input?.synthetic === true) blockers.push("SHADOW_NON_NATURAL_SOURCE");
  if (!provenanceValid(input?.featureProvenance)) blockers.push("SHADOW_FEATURE_PROVENANCE_INVALID");
  if (!provenanceValid(input?.modelRuleProvenance)) blockers.push("SHADOW_MODEL_RULE_PROVENANCE_INVALID");
  if (input?.featureProvenance?.boundStrategyIdentityDigest !== candidate?.strategyIdentityDigest) {
    blockers.push("SHADOW_FEATURE_PROVENANCE_IDENTITY_MISMATCH");
  }
  if (input?.modelRuleProvenance?.boundStrategyIdentityDigest !== candidate?.strategyIdentityDigest) {
    blockers.push("SHADOW_MODEL_RULE_PROVENANCE_IDENTITY_MISMATCH");
  }
  const freshness = record(input?.datasetFreshness);
  if (freshness?.status !== "FRESH" || !finite(freshness.ageMs) || !finite(freshness.maxAgeMs)
    || freshness.ageMs < 0 || freshness.maxAgeMs < 0 || freshness.ageMs > freshness.maxAgeMs) {
    blockers.push("SHADOW_DATA_FRESHNESS_FAILURE");
  }
  if (input?.executionAuthority !== "NONE" || input?.orderSubmitted === true) blockers.push("SHADOW_ORDER_AUTHORITY_FORBIDDEN");
  if (blockers.length) return statusResult("shadow-forward-observation-v1", "FAIL", blockers, { observation: null });
  const body = {
    schemaVersion: "shadow-forward-observation-v1",
    observationId: input.observationId,
    timestamp,
    outcomeObservedAt,
    symbol: input.symbol,
    timeframe: input.timeframe,
    market: input.market,
    strategyId: candidate.strategyId,
    strategyIdentityDigest: candidate.strategyIdentityDigest,
    signal: input.signal,
    confidence: input.confidence,
    expectedAction: input.expectedAction,
    actualDirection: input.actualDirection,
    regime: input.regime,
    chronologicalSlice: nonEmpty(input.chronologicalSlice) ? input.chronologicalSlice : timestamp.slice(0, 10),
    featureProvenance: input.featureProvenance,
    modelRuleProvenance: input.modelRuleProvenance,
    datasetFreshness: freshness,
    sourceKind: "NATURAL_FORWARD",
    replay: false,
    historical: false,
    synthetic: false,
    executionAuthority: "NONE",
    orderSubmitted: false,
  };
  return statusResult("shadow-forward-observation-v1", "PASS", [], {
    observation: deepFreeze({ ...body, evidenceDigest: sha256Canonical(body) }),
  });
}

function confusionMetrics(observations) {
  const confusion = Object.fromEntries(PHASE3_SHADOW_DIRECTIONS.map((actual) => [
    actual,
    Object.fromEntries(PHASE3_SHADOW_DIRECTIONS.map((predicted) => [predicted, 0])),
  ]));
  for (const row of observations) confusion[row.actualDirection][row.signal] += 1;
  const perClass = {};
  for (const direction of PHASE3_SHADOW_DIRECTIONS) {
    const support = PHASE3_SHADOW_DIRECTIONS.reduce((sum, predicted) => sum + confusion[direction][predicted], 0);
    const predictedSupport = PHASE3_SHADOW_DIRECTIONS.reduce((sum, actual) => sum + confusion[actual][direction], 0);
    const truePositive = confusion[direction][direction];
    const recall = support > 0 ? truePositive / support : null;
    const precision = predictedSupport > 0 ? truePositive / predictedSupport : null;
    const f1 = precision != null && recall != null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : precision === 0 && recall === 0 ? 0 : null;
    perClass[direction] = deepFreeze({ support, predictedSupport, precision, recall, f1 });
  }
  const supported = PHASE3_SHADOW_DIRECTIONS.filter((direction) => perClass[direction].support > 0);
  return deepFreeze({
    confusion,
    perClass,
    macroF1: mean(supported.map((direction) => perClass[direction].f1).filter(finite)),
    balancedAccuracy: mean(supported.map((direction) => perClass[direction].recall).filter(finite)),
  });
}

function groupedCounts(observations, field) {
  const counts = {};
  for (const row of observations) counts[row[field]] = (counts[row[field]] ?? 0) + 1;
  return Object.freeze(Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))));
}

function validateCanonicalShadowHandoff(handoff, strategyIdentityDigest, asOf) {
  const source = record(handoff);
  if (!source) return { valid: false, status: "MISSING_EVIDENCE", blockers: ["CANONICAL_SHADOW_HANDOFF_MISSING"] };
  const blockers = [];
  if (source.schemaVersion !== "prediction-lab-strategy-health-shadow-handoff-v1") blockers.push("CANONICAL_SHADOW_HANDOFF_SCHEMA_INVALID");
  if (source.strategyIdentityDigest !== strategyIdentityDigest) blockers.push("CANONICAL_SHADOW_HANDOFF_IDENTITY_MISMATCH");
  if (source.executionAuthority !== "NONE") blockers.push("CANONICAL_SHADOW_HANDOFF_AUTHORITY_INVALID");
  if (!verifyCanonicalDigest(source)) blockers.push("CANONICAL_SHADOW_HANDOFF_DIGEST_INVALID");
  const expiresAt = iso(source.freshness?.expiresAt);
  if (source.freshness?.status !== "FRESH" || !expiresAt || Date.parse(expiresAt) < Date.parse(asOf)) {
    blockers.push("CANONICAL_SHADOW_HANDOFF_STALE");
  }
  return {
    valid: blockers.length === 0,
    status: blockers.length ? "FAIL" : "PASS",
    blockers,
  };
}

export function createResearchFailureObservationV1({
  strategyIdentityDigest,
  stage,
  status,
  failureCodes,
  observedAt,
  evidence,
} = {}) {
  if (!validDigest(strategyIdentityDigest)) throw new TypeError("FAILURE_STRATEGY_IDENTITY_INVALID");
  if (!nonEmpty(stage)) throw new TypeError("FAILURE_STAGE_REQUIRED");
  if (!["FAIL", "MISSING_EVIDENCE", "NOT_EVALUABLE"].includes(status)) throw new TypeError("FAILURE_STATUS_INVALID");
  if (!Array.isArray(failureCodes) || !failureCodes.length || failureCodes.some((code) => !nonEmpty(code))) {
    throw new TypeError("FAILURE_CODES_REQUIRED");
  }
  const at = iso(observedAt);
  if (!at) throw new TypeError("FAILURE_OBSERVED_AT_INVALID");
  const body = {
    schemaVersion: "research-failure-observation-v1",
    strategyIdentityDigest,
    stage,
    status,
    failureCodes: unique(failureCodes),
    observedAt: at,
    evidenceDigest: sha256Canonical(evidence ?? null),
    sameStrategyMutationAllowed: false,
    sameParameterMutationAllowed: false,
    newHypothesisRequired: true,
    newFormulaCandidateRequired: true,
    newStrategyIdentityRequired: true,
    tournamentRestartRequired: true,
    priorEvidenceInheritanceAllowed: false,
    executionAuthority: "NONE",
  };
  return deepFreeze({ ...body, failureObservationDigest: sha256Canonical(body) });
}

export function evaluateShadowSufficiencyV1({
  shadowCandidate,
  observations = [],
  canonicalShadowHandoff,
  observedAt,
  policy = PHASE3_DEFAULT_SHADOW_POLICY,
  budget = PHASE3_DEFAULT_BUDGET,
} = {}) {
  const candidate = record(shadowCandidate);
  const at = iso(observedAt);
  const thresholds = validateShadowPolicy(policy);
  const limits = validateBudget(budget);
  if (!candidate || candidate.schemaVersion !== "shadow-candidate-v1" || candidate.status !== "PASS" || !at) {
    return statusResult("shadow-sufficiency-v1", "FAIL", ["SHADOW_CANDIDATE_OR_TIME_INVALID"], {
      sufficient: false,
      metrics: null,
      failureObservation: null,
    });
  }
  if (!Array.isArray(observations) || observations.length > limits.maxSignalsPerCycle) {
    const blockers = ["NOT_EVALUABLE_RESOURCE_LIMIT"];
    return statusResult("shadow-sufficiency-v1", "NOT_EVALUABLE", blockers, {
      sufficient: false,
      metrics: null,
      failureObservation: createResearchFailureObservationV1({
        strategyIdentityDigest: candidate.strategyIdentityDigest,
        stage: "SHADOW",
        status: "NOT_EVALUABLE",
        failureCodes: blockers,
        observedAt: at,
        evidence: { observationN: Array.isArray(observations) ? observations.length : null },
      }),
    });
  }
  const blockers = [];
  const ids = new Set();
  for (const row of observations) {
    if (row?.schemaVersion !== "shadow-forward-observation-v1" || !verifyCanonicalDigest(row)) blockers.push("SHADOW_OBSERVATION_INVALID");
    if (row?.strategyIdentityDigest !== candidate.strategyIdentityDigest) blockers.push("SHADOW_STRATEGY_IDENTITY_MISMATCH");
    if (ids.has(row?.observationId)) blockers.push("DUPLICATE_SHADOW_OBSERVATION");
    ids.add(row?.observationId);
    if (row?.sourceKind !== "NATURAL_FORWARD" || row?.replay || row?.historical || row?.synthetic) blockers.push("SHADOW_FORWARD_PROVENANCE_INVALID");
    if (!provenanceValid(row?.featureProvenance) || !provenanceValid(row?.modelRuleProvenance)) blockers.push("SHADOW_PROVENANCE_MISMATCH");
    if (row?.featureProvenance?.boundStrategyIdentityDigest !== candidate.strategyIdentityDigest
      || row?.modelRuleProvenance?.boundStrategyIdentityDigest !== candidate.strategyIdentityDigest) {
      blockers.push("SHADOW_PROVENANCE_MISMATCH");
    }
    if (row?.datasetFreshness?.status !== "FRESH" || row.datasetFreshness.ageMs > row.datasetFreshness.maxAgeMs) blockers.push("SHADOW_DATA_FRESHNESS_FAILURE");
    if (row?.executionAuthority !== "NONE" || row?.orderSubmitted === true) blockers.push("SHADOW_ORDER_AUTHORITY_FORBIDDEN");
  }
  const handoff = validateCanonicalShadowHandoff(canonicalShadowHandoff, candidate.strategyIdentityDigest, at);
  blockers.push(...handoff.blockers);
  if (blockers.length) {
    const uniqueBlockers = unique(blockers);
    return statusResult("shadow-sufficiency-v1", handoff.status === "MISSING_EVIDENCE" ? "MISSING_EVIDENCE" : "FAIL", uniqueBlockers, {
      sufficient: false,
      metrics: null,
      failureObservation: createResearchFailureObservationV1({
        strategyIdentityDigest: candidate.strategyIdentityDigest,
        stage: "SHADOW",
        status: handoff.status === "MISSING_EVIDENCE" ? "MISSING_EVIDENCE" : "FAIL",
        failureCodes: uniqueBlockers,
        observedAt: at,
        evidence: { observations, canonicalShadowHandoff },
      }),
    });
  }
  const quality = confusionMetrics(observations);
  const totalN = observations.length;
  const independentDays = new Set(observations.map((row) => row.timestamp.slice(0, 10))).size;
  const predictedCounts = groupedCounts(observations, "signal");
  const regimeCounts = groupedCounts(observations, "regime");
  const neutralShare = totalN ? (predictedCounts.NEUTRAL ?? 0) / totalN : null;
  const directionalHitRate = totalN
    ? observations.filter((row) => row.signal === row.actualDirection).length / totalN
    : null;
  const calibrationError = totalN
    ? mean(observations.map((row) => Math.abs(row.confidence - (row.signal === row.actualDirection ? 1 : 0))))
    : null;
  const distribution = PHASE3_SHADOW_DIRECTIONS.map((direction) => (predictedCounts[direction] ?? 0) / Math.max(totalN, 1));
  const entropy = totalN
    ? -distribution.filter((value) => value > 0).reduce((sum, value) => sum + (value * Math.log(value)), 0)
    : null;
  const insufficiency = [];
  if (totalN < thresholds.minimumTotalN) insufficiency.push("SHADOW_TOTAL_N_INSUFFICIENT");
  if (independentDays < thresholds.minimumIndependentDays) insufficiency.push("SHADOW_INDEPENDENT_DAYS_INSUFFICIENT");
  if (quality.perClass.LONG.support < thresholds.minimumLongSupport) insufficiency.push("SHADOW_LONG_SUPPORT_INSUFFICIENT");
  if (quality.perClass.SHORT.support < thresholds.minimumShortSupport) insufficiency.push("SHADOW_SHORT_SUPPORT_INSUFFICIENT");
  if (quality.perClass.NEUTRAL.support < thresholds.minimumNeutralSupport) insufficiency.push("SHADOW_NEUTRAL_SUPPORT_INSUFFICIENT");
  if ((regimeCounts.BULL ?? 0) < thresholds.minimumBullRegimeN) insufficiency.push("SHADOW_BULL_REGIME_INSUFFICIENT");
  if ((regimeCounts.BEAR ?? 0) < thresholds.minimumBearRegimeN) insufficiency.push("SHADOW_BEAR_REGIME_INSUFFICIENT");
  if ((regimeCounts.SIDEWAYS ?? 0) < thresholds.minimumSidewaysRegimeN) insufficiency.push("SHADOW_SIDEWAYS_REGIME_INSUFFICIENT");
  const failures = [];
  if (neutralShare != null && neutralShare > thresholds.maximumNeutralShare) failures.push("NEUTRAL_DOMINANCE");
  for (const direction of ["LONG", "SHORT"]) {
    const recall = quality.perClass[direction].recall;
    if (recall != null && recall < thresholds.minimumDirectionalRecall) failures.push(`${direction}_RECALL_COLLAPSE`);
  }
  if (calibrationError != null && calibrationError > thresholds.maximumCalibrationError) failures.push("CONFIDENCE_MISCALIBRATION");
  const driftStatus = canonicalShadowHandoff.driftVerdict?.status;
  const rawReferenceAvailable = canonicalShadowHandoff.referenceRawSampleAvailable === true
    || (Array.isArray(canonicalShadowHandoff.driftMetrics)
      && canonicalShadowHandoff.driftMetrics.length > 0
      && canonicalShadowHandoff.driftMetrics.every((row) => row.status === "MEASURED"));
  const drift = rawReferenceAvailable
    ? {
      status: driftStatus,
      psi: canonicalShadowHandoff.driftMetrics?.map((row) => row.psi) ?? [],
      ks: canonicalShadowHandoff.driftMetrics?.map((row) => row.ksStatistic) ?? [],
      jsd: canonicalShadowHandoff.driftMetrics?.map((row) => row.jsd) ?? [],
    }
    : { status: "N/A", psi: null, ks: null, jsd: null };
  if (!rawReferenceAvailable) insufficiency.push("RAW_REFERENCE_EVIDENCE_MISSING");
  else if (driftStatus === "BRAKE" || driftStatus === "WATCH") failures.push("FEATURE_DRIFT");
  else if (driftStatus !== "STABLE") insufficiency.push("DRIFT_NOT_EVALUABLE");
  const metrics = deepFreeze({
    totalN,
    independentDays,
    predictedCounts,
    regimeCounts,
    perClass: quality.perClass,
    macroF1: quality.macroF1,
    balancedAccuracy: quality.balancedAccuracy,
    bullRecall: quality.perClass.LONG.recall,
    bearRecall: quality.perClass.SHORT.recall,
    sidewaysRecall: quality.perClass.NEUTRAL.recall,
    directionalHitRate,
    confidenceCalibrationError: calibrationError,
    entropy,
    neutralShare,
    symbolSlices: groupedCounts(observations, "symbol"),
    timeframeSlices: groupedCounts(observations, "timeframe"),
    marketSlices: groupedCounts(observations, "market"),
    regimeSlices: regimeCounts,
    chronologicalSlices: groupedCounts(observations, "chronologicalSlice"),
    drift,
  });
  const status = failures.length ? "FAIL" : insufficiency.length ? "MISSING_EVIDENCE" : "PASS";
  const finalBlockers = failures.length ? failures : insufficiency;
  const failureObservation = status === "PASS" ? null : createResearchFailureObservationV1({
    strategyIdentityDigest: candidate.strategyIdentityDigest,
    stage: "SHADOW",
    status,
    failureCodes: finalBlockers,
    observedAt: at,
    evidence: metrics,
  });
  return statusResult("shadow-sufficiency-v1", status, finalBlockers, {
    sufficient: status === "PASS",
    metrics,
    canonicalShadowHandoffDigest: canonicalShadowHandoff.evidenceDigest,
    failureObservation,
  });
}

export function admitShadowToNaturalPaperV1({
  shadowCandidate,
  shadowEvaluation,
  paperCapability,
  observedAt,
  resourceUsage = {},
  budget = PHASE3_DEFAULT_BUDGET,
} = {}) {
  const candidate = record(shadowCandidate);
  const evaluation = record(shadowEvaluation);
  const capability = record(paperCapability);
  const at = iso(observedAt);
  const limits = validateBudget(budget);
  if ((resourceUsage.activeNaturalPaperStrategies ?? 0) >= limits.maxNaturalPaperStrategies) {
    return statusResult("natural-paper-admission-v1", "NOT_EVALUABLE", ["NOT_EVALUABLE_RESOURCE_LIMIT"], {
      admitted: false,
      naturalPaperCandidate: null,
    });
  }
  const blockers = [];
  if (candidate?.schemaVersion !== "shadow-candidate-v1" || candidate.status !== "PASS" || candidate.identityFrozen !== true) blockers.push("SHADOW_CANDIDATE_INVALID");
  if (evaluation?.status !== "PASS" || evaluation.sufficient !== true) blockers.push("SHADOW_SUFFICIENCY_REQUIRED");
  if (evaluation?.metrics?.drift?.status !== "STABLE") blockers.push("UNRESOLVED_DRIFT");
  if (!at) blockers.push("OBSERVED_AT_INVALID");
  if (capability?.paperOnly !== true || capability.executionAuthority !== "NONE") blockers.push("PAPER_ONLY_CAPABILITY_REQUIRED");
  if (!safetyValid(capability?.safety)) blockers.push("PAPER_CAPABILITY_SAFETY_INVALID");
  if (blockers.length) {
    return statusResult("natural-paper-admission-v1", blockers.includes("SHADOW_SUFFICIENCY_REQUIRED") ? "MISSING_EVIDENCE" : "FAIL", blockers, {
      admitted: false,
      naturalPaperCandidate: null,
    });
  }
  const body = {
    schemaVersion: "natural-paper-candidate-v1",
    status: "PASS",
    admitted: true,
    candidateId: `paper:${candidate.strategyIdentityDigest}`,
    strategyId: candidate.strategyId,
    strategyIdentity: candidate.strategyIdentity,
    strategyIdentityDigest: candidate.strategyIdentityDigest,
    shadowEvidenceDigest: sha256Canonical({
      canonicalShadowHandoffDigest: evaluation.canonicalShadowHandoffDigest,
      metrics: evaluation.metrics,
    }),
    admittedAt: at,
    strategyIdentityFrozen: true,
    formulaMutationAllowed: false,
    parameterMutationAllowed: false,
    paperOnly: true,
    executionAuthority: "NONE",
  };
  const naturalPaperCandidate = deepFreeze({ ...body, candidateDigest: sha256Canonical(body) });
  return statusResult("natural-paper-admission-v1", "PASS", [], { admitted: true, naturalPaperCandidate });
}

function firstZero(stages) {
  for (const stage of stages) {
    if (["MISSING_EVIDENCE", "NOT_EVALUABLE"].includes(stage.status) || stage.count == null) {
      return { stage: "UNKNOWN", reason: stage.reason ?? `UNMEASURED_${stage.stage}` };
    }
    if (stage.count === 0) return { stage: stage.stage, reason: stage.reason ?? "MEASURED_ZERO" };
  }
  return { stage: "NONE", reason: "NO_MEASURED_ZERO" };
}

export function validateNaturalPaperCycleV1({ naturalPaperCandidate, cycle, seenCycleIds = [] } = {}) {
  const candidate = record(naturalPaperCandidate);
  const input = record(cycle);
  const blockers = [];
  if (candidate?.schemaVersion !== "natural-paper-candidate-v1" || candidate.status !== "PASS" || candidate.paperOnly !== true) {
    blockers.push("NATURAL_PAPER_CANDIDATE_INVALID");
  }
  for (const field of ["naturalCycleId", "candidateId", "strategyId", "market", "symbol", "timeframe", "triggerSource", "mutationIdentity"]) {
    if (!nonEmpty(input?.[field])) blockers.push(`NATURAL_CYCLE_FIELD_MISSING:${field}`);
  }
  const at = iso(input?.timestamp);
  if (!at) blockers.push("NATURAL_CYCLE_TIMESTAMP_INVALID");
  if (!provenanceValid(input?.provenance)) blockers.push("NATURAL_CYCLE_PROVENANCE_INVALID");
  if (input?.provenance?.boundStrategyIdentityDigest !== candidate?.strategyIdentityDigest) {
    blockers.push("NATURAL_CYCLE_PROVENANCE_IDENTITY_MISMATCH");
  }
  if (input?.candidateId !== candidate?.candidateId || input?.strategyId !== candidate?.strategyId
    || input?.strategyIdentityDigest !== candidate?.strategyIdentityDigest) blockers.push("NATURAL_CYCLE_IDENTITY_MISMATCH");
  if (input?.mutationIdentity !== candidate?.strategyIdentityDigest) blockers.push("NATURAL_CYCLE_MUTATION_IDENTITY_MISMATCH");
  if (input?.executionAuthority !== "NONE" || input?.networkCalls !== 0 || input?.privateApiCalls !== 0 || input?.orderCalls !== 0) {
    blockers.push("NATURAL_CYCLE_AUTHORITY_FORBIDDEN");
  }
  const stages = Array.isArray(input?.stages) ? input.stages : [];
  if (stages.length !== PHASE3_NATURAL_PAPER_STAGE_ORDER.length
    || stages.some((stage, index) => stage?.stage !== PHASE3_NATURAL_PAPER_STAGE_ORDER[index])) {
    blockers.push("NATURAL_FUNNEL_STAGE_ORDER_INVALID");
  }
  for (const stage of stages) {
    if (!PHASE3_EVIDENCE_STATUSES.includes(stage?.status)) blockers.push(`NATURAL_STAGE_STATUS_INVALID:${stage?.stage}`);
    if (stage?.count != null && !nonNegativeInteger(stage.count)) blockers.push(`NATURAL_STAGE_COUNT_INVALID:${stage?.stage}`);
    if (["PASS", "FAIL"].includes(stage?.status) && stage.count == null) blockers.push(`NATURAL_STAGE_MEASUREMENT_MISSING:${stage?.stage}`);
    if (["MISSING_EVIDENCE", "NOT_EVALUABLE"].includes(stage?.status) && stage.count != null) blockers.push(`NATURAL_UNKNOWN_FABRICATED_ZERO:${stage?.stage}`);
  }
  const duplicate = nonEmpty(input?.naturalCycleId) && seenCycleIds.includes(input.naturalCycleId);
  const flags = record(input?.flags) ?? {};
  const disqualifying = NATURAL_DISQUALIFYING_FLAGS.filter((flag) => flags[flag] === true);
  if (input?.triggerSource !== "NATURAL_FORWARD") disqualifying.push("nonNaturalTrigger");
  const naturalCredit = blockers.length === 0 && !duplicate && disqualifying.length === 0 ? 1 : 0;
  const first = firstZero(stages);
  const status = blockers.length ? "FAIL" : "PASS";
  const body = {
    schemaVersion: "natural-paper-cycle-evidence-v1",
    status,
    naturalCycleId: input?.naturalCycleId ?? null,
    candidateId: input?.candidateId ?? null,
    strategyId: input?.strategyId ?? null,
    strategyIdentityDigest: input?.strategyIdentityDigest ?? null,
    timestamp: at,
    market: input?.market ?? null,
    symbol: input?.symbol ?? null,
    timeframe: input?.timeframe ?? null,
    provenance: input?.provenance ?? null,
    triggerSource: input?.triggerSource ?? null,
    duplicate,
    flags: deepFreeze({ ...flags }),
    disqualifyingSources: unique(disqualifying),
    mutationIdentity: input?.mutationIdentity ?? null,
    stageOrder: PHASE3_NATURAL_PAPER_STAGE_ORDER,
    stages: deepFreeze(stages.map((stage) => ({ ...stage }))),
    firstZeroStage: first.stage,
    firstZeroReason: first.reason,
    naturalCredit,
    replayCredit: 0,
    duplicateCredit: 0,
    historicalCredit: 0,
    syntheticCredit: 0,
    settlementCredit: naturalCredit === 1 && stages.at(-1)?.status === "PASS" && stages.at(-1)?.count > 0 ? 1 : 0,
    networkCalls: 0,
    privateApiCalls: 0,
    orderCalls: 0,
    executionAuthority: "NONE",
  };
  return statusResult("natural-paper-cycle-validation-v1", status, blockers, {
    evidence: deepFreeze({ ...body, evidenceDigest: sha256Canonical(body) }),
  });
}

export function evaluateNaturalPaperSufficiencyV1({
  naturalPaperCandidate,
  cycleEvidence = [],
  policy = PHASE3_DEFAULT_NATURAL_PAPER_POLICY,
  budget = PHASE3_DEFAULT_BUDGET,
} = {}) {
  const candidate = record(naturalPaperCandidate);
  const thresholds = validateNaturalPaperPolicy(policy);
  const limits = validateBudget(budget);
  if (!candidate || candidate.schemaVersion !== "natural-paper-candidate-v1" || candidate.status !== "PASS") {
    return statusResult("natural-paper-sufficiency-v1", "FAIL", ["NATURAL_PAPER_CANDIDATE_INVALID"], {
      sufficient: false,
      naturalCycleN: null,
      settlementCycleN: null,
    });
  }
  if (!Array.isArray(cycleEvidence) || cycleEvidence.length > limits.maxSignalsPerCycle) {
    return statusResult("natural-paper-sufficiency-v1", "NOT_EVALUABLE", ["NOT_EVALUABLE_RESOURCE_LIMIT"], {
      sufficient: false,
      naturalCycleN: null,
      settlementCycleN: null,
    });
  }
  const blockers = [];
  const ids = new Set();
  for (const row of cycleEvidence) {
    if (row?.schemaVersion !== "natural-paper-cycle-evidence-v1" || !verifyCanonicalDigest(row)) blockers.push("NATURAL_CYCLE_EVIDENCE_INVALID");
    if (row?.strategyIdentityDigest !== candidate.strategyIdentityDigest) blockers.push("NATURAL_CYCLE_IDENTITY_MISMATCH");
    if (ids.has(row?.naturalCycleId)) blockers.push("DUPLICATE_NATURAL_CYCLE");
    ids.add(row?.naturalCycleId);
    if (row?.executionAuthority !== "NONE" || row?.networkCalls !== 0 || row?.privateApiCalls !== 0 || row?.orderCalls !== 0) {
      blockers.push("NATURAL_CYCLE_AUTHORITY_FORBIDDEN");
    }
  }
  if (blockers.length) {
    return statusResult("natural-paper-sufficiency-v1", "FAIL", blockers, {
      sufficient: false,
      naturalCycleN: null,
      settlementCycleN: null,
    });
  }
  const credited = cycleEvidence.filter((row) => row.naturalCredit === 1);
  const naturalCycleN = credited.length;
  const settlementCycleN = credited.filter((row) => row.settlementCredit === 1).length;
  const independentDays = new Set(credited.map((row) => row.timestamp?.slice(0, 10)).filter(Boolean)).size;
  const insufficiency = [];
  if (naturalCycleN < thresholds.minimumNaturalCycles) insufficiency.push("NATURAL_CYCLE_N_INSUFFICIENT");
  if (independentDays < thresholds.minimumIndependentDays) insufficiency.push("NATURAL_INDEPENDENT_DAYS_INSUFFICIENT");
  if (settlementCycleN < thresholds.minimumSettlementCycles) insufficiency.push("NATURAL_SETTLEMENT_CYCLE_INSUFFICIENT");
  const sufficient = insufficiency.length === 0;
  return statusResult("natural-paper-sufficiency-v1", sufficient ? "PASS" : "MISSING_EVIDENCE", insufficiency, {
    sufficient,
    naturalCycleN,
    settlementCycleN,
    independentDays,
    replayCredit: 0,
    duplicateCredit: 0,
    historicalCredit: 0,
    syntheticCredit: 0,
  });
}

function costValue(costs, field) {
  const cell = record(costs?.[field]);
  return cell && finite(cell.value) && cell.value >= 0 && nonEmpty(cell.evidenceId) ? cell.value : null;
}

function maxDrawdownFromReturns(returns) {
  if (!returns.length) return null;
  let equity = 1;
  let peak = 1;
  let maximumDrawdown = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  return maximumDrawdown;
}

function sharpe(returns) {
  if (!returns.length) return null;
  const average = mean(returns);
  if (returns.length === 1) return 0;
  const variance = returns.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (returns.length - 1);
  const deviation = Math.sqrt(variance);
  return deviation > 0 ? average / deviation : 0;
}

export function evaluateSettlementEvidenceV1({
  naturalPaperCandidate,
  cycleEvidence = [],
  settlements = [],
  policy = PHASE3_DEFAULT_SETTLEMENT_POLICY,
  budget = PHASE3_DEFAULT_BUDGET,
} = {}) {
  const candidate = record(naturalPaperCandidate);
  const thresholds = validateSettlementPolicy(policy);
  const limits = validateBudget(budget);
  if (!candidate || candidate.schemaVersion !== "natural-paper-candidate-v1" || candidate.status !== "PASS") {
    return statusResult("settlement-evidence-v1", "FAIL", ["NATURAL_PAPER_CANDIDATE_INVALID"], {
      sufficient: false,
      profitabilityProven: false,
      metrics: null,
    });
  }
  if (!Array.isArray(settlements) || settlements.length > limits.maxSettlementsTracked) {
    return statusResult("settlement-evidence-v1", "NOT_EVALUABLE", ["NOT_EVALUABLE_RESOURCE_LIMIT"], {
      sufficient: false,
      profitabilityProven: false,
      metrics: null,
    });
  }
  const creditedCycles = new Map((Array.isArray(cycleEvidence) ? cycleEvidence : [])
    .filter((row) => row?.naturalCredit === 1)
    .map((row) => [row.naturalCycleId, row]));
  const blockers = [];
  const ids = new Set();
  const measured = [];
  for (const settlement of settlements) {
    if (!nonEmpty(settlement?.settlementId) || ids.has(settlement.settlementId)) {
      blockers.push("DUPLICATE_SETTLEMENT");
      continue;
    }
    ids.add(settlement.settlementId);
    if (!creditedCycles.has(settlement.naturalCycleId)) blockers.push("SETTLEMENT_NATURAL_CREDIT_MISSING");
    if (settlement.strategyIdentityDigest !== candidate.strategyIdentityDigest) blockers.push("SETTLEMENT_STRATEGY_IDENTITY_MISMATCH");
    if (settlement.replay || settlement.duplicate || settlement.synthetic || settlement.historical) blockers.push("SETTLEMENT_NON_NATURAL_EVIDENCE");
    if (!provenanceValid(settlement.provenance)) blockers.push("SETTLEMENT_PROVENANCE_INVALID");
    if (settlement.provenance?.boundStrategyIdentityDigest !== candidate.strategyIdentityDigest) {
      blockers.push("SETTLEMENT_PROVENANCE_IDENTITY_MISMATCH");
    }
    const entryAt = iso(settlement.entryTimestamp);
    const exitAt = iso(settlement.exitTimestamp);
    if (!entryAt || !exitAt || Date.parse(exitAt) <= Date.parse(entryAt)) blockers.push("SETTLEMENT_TIME_INVALID");
    for (const field of ["entryPrice", "exitPrice", "quantity", "leverage", "grossPnl", "netPnl", "return", "mfe", "mae", "holdingPeriodMs"]) {
      if (!finite(settlement[field])) blockers.push(`SETTLEMENT_FIELD_INVALID:${field}`);
    }
    if (!positiveSettlementField(settlement.entryPrice) || !positiveSettlementField(settlement.exitPrice)
      || !positiveSettlementField(settlement.quantity) || !positiveSettlementField(settlement.leverage)
      || !positiveSettlementField(settlement.holdingPeriodMs)) blockers.push("SETTLEMENT_POSITIVE_FIELD_INVALID");
    if (!["LONG", "SHORT"].includes(settlement.side)) blockers.push("SETTLEMENT_SIDE_INVALID");
    if (!PHASE3_REGIMES.includes(settlement.marketRegime)) blockers.push("SETTLEMENT_REGIME_INVALID");
    if (!nonEmpty(settlement.exitReason)) blockers.push("SETTLEMENT_EXIT_REASON_MISSING");
    const values = COST_FIELDS.map((field) => costValue(settlement.costs, field));
    if (values.some((value) => value == null)) blockers.push("SETTLEMENT_COST_EVIDENCE_MISSING");
    const totalCosts = values.every(finite) ? values.reduce((sum, value) => sum + value, 0) : null;
    if (totalCosts != null && finite(settlement.grossPnl) && finite(settlement.netPnl)
      && Math.abs((settlement.grossPnl - totalCosts) - settlement.netPnl) > 1e-9) blockers.push("SETTLEMENT_NET_PNL_MISMATCH");
    measured.push({ ...settlement, entryTimestamp: entryAt, exitTimestamp: exitAt, totalCosts });
  }
  if (blockers.length) {
    return statusResult("settlement-evidence-v1", "FAIL", blockers, {
      sufficient: false,
      profitabilityProven: false,
      profitability: "NOT_PROVEN",
      metrics: null,
      settlements: deepFreeze(measured),
    });
  }
  const settledN = measured.length;
  const independentDays = new Set(measured.map((row) => row.exitTimestamp.slice(0, 10))).size;
  const regimeCounts = groupedCounts(measured, "marketRegime");
  const sideCounts = groupedCounts(measured, "side");
  const gains = measured.filter((row) => row.netPnl > 0).reduce((sum, row) => sum + row.netPnl, 0);
  const losses = Math.abs(measured.filter((row) => row.netPnl < 0).reduce((sum, row) => sum + row.netPnl, 0));
  const returns = measured.map((row) => row.return);
  const metrics = deepFreeze({
    settledN,
    independentDays,
    regimeCounts,
    sideCounts,
    profitFactor: settledN === 0 ? null : losses > 0 ? gains / losses : gains > 0 ? null : 0,
    expectancy: settledN === 0 ? null : mean(measured.map((row) => row.netPnl)),
    maximumDrawdown: settledN === 0 ? null : maxDrawdownFromReturns(returns),
    winRate: settledN === 0 ? null : measured.filter((row) => row.netPnl > 0).length / settledN,
    sharpe: settledN === 0 ? null : sharpe(returns),
    mfe: settledN === 0 ? null : mean(measured.map((row) => row.mfe)),
    mae: settledN === 0 ? null : mean(measured.map((row) => row.mae)),
    holdingPeriodMs: settledN === 0 ? null : mean(measured.map((row) => row.holdingPeriodMs)),
  });
  const insufficiency = [];
  if (settledN < thresholds.minimumSettledN) insufficiency.push("SETTLEMENT_N_INSUFFICIENT");
  if (independentDays < thresholds.minimumIndependentDays) insufficiency.push("SETTLEMENT_INDEPENDENT_DAYS_INSUFFICIENT");
  if ((regimeCounts.BULL ?? 0) < thresholds.minimumBullRegimeN) insufficiency.push("SETTLEMENT_BULL_REGIME_INSUFFICIENT");
  if ((regimeCounts.BEAR ?? 0) < thresholds.minimumBearRegimeN) insufficiency.push("SETTLEMENT_BEAR_REGIME_INSUFFICIENT");
  if ((regimeCounts.SIDEWAYS ?? 0) < thresholds.minimumSidewaysRegimeN) insufficiency.push("SETTLEMENT_SIDEWAYS_REGIME_INSUFFICIENT");
  if ((sideCounts.LONG ?? 0) < thresholds.minimumLongN) insufficiency.push("SETTLEMENT_LONG_COVERAGE_INSUFFICIENT");
  if ((sideCounts.SHORT ?? 0) < thresholds.minimumShortN) insufficiency.push("SETTLEMENT_SHORT_COVERAGE_INSUFFICIENT");
  const sufficient = insufficiency.length === 0;
  const profitabilityProven = sufficient
    && finite(metrics.profitFactor) && metrics.profitFactor > thresholds.minimumProfitFactor
    && finite(metrics.expectancy) && metrics.expectancy > thresholds.minimumExpectancy;
  return statusResult("settlement-evidence-v1", sufficient ? "PASS" : "MISSING_EVIDENCE", insufficiency, {
    sufficient,
    forwardEvidenceSufficient: sufficient,
    profitabilityProven,
    profitability: profitabilityProven ? "PROVEN" : "NOT_PROVEN",
    metrics,
    settlements: deepFreeze(measured),
  });
}

function positiveSettlementField(value) {
  return finite(value) && value > 0;
}

function healthDimension(status, reason, source, evidenceDigest = null) {
  return deepFreeze({
    status: normalizedStatus(status),
    reason,
    source,
    evidenceDigest: validDigest(evidenceDigest) ? evidenceDigest : null,
  });
}

function upstreamHealthStatus(binding) {
  if (!record(binding)) return "MISSING_EVIDENCE";
  if (["HEALTHY", "PASS"].includes(binding.status)) return "PASS";
  if (["WATCH", "DEGRADED", "UNSTABLE", "FAIL", "BLOCKED", "INVALID"].includes(binding.status)) return "FAIL";
  if (binding.status === "NOT_EVALUABLE") return "NOT_EVALUABLE";
  return "MISSING_EVIDENCE";
}

export function buildPhase3StrategyHealthV1({
  strategyIdentityDigest,
  historicalEvidence = {},
  shadowEvaluation,
  naturalPaperEvidence,
  settlementEvidence,
  canonicalHealthBinding,
  safety = PHASE3_SAFETY,
} = {}) {
  const historical = record(historicalEvidence) ?? {};
  const shadow = record(shadowEvaluation);
  const paper = record(naturalPaperEvidence);
  const settlement = record(settlementEvidence);
  const canonicalStatus = upstreamHealthStatus(canonicalHealthBinding);
  const driftStatus = shadow?.metrics?.drift?.status;
  const dimensions = {
    historicalRobustness: healthDimension(historical.historicalRobustness, "TOURNAMENT_HISTORICAL", "#551"),
    oosRobustness: healthDimension(historical.oosRobustness, "TOURNAMENT_OOS", "#551"),
    walkForwardStability: healthDimension(historical.walkForwardStability, "TOURNAMENT_WALK_FORWARD", "#551"),
    costRobustness: healthDimension(historical.costRobustness, "TOURNAMENT_COST_STRESS", "#551"),
    regimeRobustness: healthDimension(historical.regimeRobustness, "TOURNAMENT_REGIME_STRESS", "#551"),
    statisticalConfidence: healthDimension(historical.statisticalConfidence, "TOURNAMENT_STATISTICAL_FIREWALL", "#551/#547"),
    shadowDirectionalQuality: healthDimension(shadow?.status, "CANONICAL_SHADOW_DIRECTIONAL_QUALITY", "#704", shadow?.canonicalShadowHandoffDigest),
    driftHealth: healthDimension(driftStatus === "STABLE" ? "PASS" : driftStatus === "N/A" || driftStatus === "NOT_EVALUABLE"
      ? "MISSING_EVIDENCE" : driftStatus == null ? "MISSING_EVIDENCE" : "FAIL", "CANONICAL_SHADOW_DRIFT", "#693/#704"),
    naturalPaperMaturity: healthDimension(paper?.sufficient === true ? "PASS" : paper?.status, "CANONICAL_NATURAL_PAPER", "#670/#677"),
    settlementMaturity: healthDimension(settlement?.sufficient === true ? "PASS" : settlement?.status, "CANONICAL_SETTLEMENT", "#670/#694"),
    safetyIntegrity: healthDimension(safetyValid(safety) ? "PASS" : "FAIL", "RESEARCH_ONLY_AUTHORITY", "PHASE3_SAFETY"),
  };
  const rows = PHASE3_HEALTH_DIMENSIONS.map((key) => [key, dimensions[key]]);
  let status = "HEALTHY";
  if (!validDigest(strategyIdentityDigest)) status = "INVALID";
  else if (dimensions.safetyIntegrity.status === "FAIL") status = "BLOCKED";
  else if (canonicalStatus === "FAIL") status = "UNSTABLE";
  else if (rows.some(([, row]) => row.status === "FAIL")) status = "UNSTABLE";
  else if (canonicalStatus === "MISSING_EVIDENCE" || rows.some(([, row]) => row.status === "MISSING_EVIDENCE" || row.status === "NOT_EVALUABLE")) {
    status = "INSUFFICIENT_EVIDENCE";
  }
  const body = {
    schemaVersion: "strategy-health-phase3-v1",
    strategyIdentityDigest,
    status,
    dimensions: deepFreeze(dimensions),
    canonicalHealthBindingStatus: canonicalStatus,
    reasons: unique(rows.filter(([, row]) => row.status !== "PASS").map(([key, row]) => `${key}:${row.status}:${row.reason}`)),
    executionAuthority: "NONE",
  };
  return deepFreeze({ ...body, evidenceDigest: sha256Canonical(body), safety: PHASE3_SAFETY });
}

export function buildProfitabilityTruthV1({
  historicalEdgeObserved = false,
  shadowEvaluation,
  naturalPaperEvidence,
  settlementEvidence,
} = {}) {
  const forwardEvidenceSufficient = shadowEvaluation?.status === "PASS"
    && naturalPaperEvidence?.sufficient === true
    && settlementEvidence?.sufficient === true;
  const profitabilityProven = forwardEvidenceSufficient && settlementEvidence?.profitabilityProven === true;
  return deepFreeze({
    schemaVersion: "profitability-truth-v1",
    HISTORICAL_EDGE_OBSERVED: historicalEdgeObserved === true,
    FORWARD_EVIDENCE_SUFFICIENT: forwardEvidenceSufficient,
    PROFITABILITY_PROVEN: profitabilityProven,
    backtestAloneProvesProfitability: false,
    shadowAccuracyAloneProvesProfitability: false,
    paperEntryAloneProvesProfitability: false,
    executionAuthority: "NONE",
  });
}

export function selectPhase3ChampionsV1({ historicalChampionVerdict, candidates = [] } = {}) {
  const historical = record(historicalChampionVerdict);
  const evaluations = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const blockers = [];
    if (historical?.status !== "PROVISIONAL_CHAMPION") blockers.push("HISTORICAL_PROVISIONAL_CHAMPION_MISSING");
    if (historical?.strategyIdentityDigest !== candidate?.strategyIdentityDigest) blockers.push("HISTORICAL_CHAMPION_IDENTITY_MISMATCH");
    if (candidate?.tournamentSurvivor !== true) blockers.push("TOURNAMENT_SURVIVOR_REQUIRED");
    if (candidate?.identityFrozen !== true) blockers.push("FROZEN_STRATEGY_IDENTITY_REQUIRED");
    if (candidate?.shadowEvaluation?.status !== "PASS" || candidate.shadowEvaluation.sufficient !== true) blockers.push("SHADOW_SUFFICIENCY_REQUIRED");
    if (candidate?.naturalPaperEvidence?.sufficient !== true) blockers.push("NATURAL_PAPER_SUFFICIENCY_REQUIRED");
    if (candidate?.settlementEvidence?.sufficient !== true) blockers.push("SETTLEMENT_SUFFICIENCY_REQUIRED");
    if (candidate?.health?.status !== "HEALTHY") blockers.push("STRATEGY_HEALTH_HEALTHY_REQUIRED");
    if (!safetyValid(candidate?.safety)) blockers.push("SAFETY_PASS_REQUIRED");
    const provisionalEligible = blockers.length === 0;
    const validatedBlockers = [...blockers];
    if (candidate?.historicalGatesPass !== true || candidate?.holdoutPass !== true) validatedBlockers.push("FULL_HISTORICAL_GATES_REQUIRED");
    if (candidate?.criticalDrift === true) validatedBlockers.push("CRITICAL_DRIFT_PRESENT");
    if (candidate?.settlementEvidence?.profitabilityProven !== true) validatedBlockers.push("FORWARD_PROFITABILITY_EVIDENCE_REQUIRED");
    return deepFreeze({
      strategyId: candidate?.strategyId ?? null,
      strategyIdentityDigest: candidate?.strategyIdentityDigest ?? null,
      provisionalEligible,
      validatedEligible: validatedBlockers.length === 0,
      blockers: unique(blockers),
      validatedBlockers: unique(validatedBlockers),
      researchScore: finite(candidate?.researchScore) ? candidate.researchScore : null,
    });
  });
  const ranking = (rows) => [...rows].sort((left, right) => {
    if (left.researchScore !== right.researchScore) return (right.researchScore ?? -Infinity) - (left.researchScore ?? -Infinity);
    return String(left.strategyIdentityDigest).localeCompare(String(right.strategyIdentityDigest));
  });
  const provisional = ranking(evaluations.filter((row) => row.provisionalEligible))[0] ?? null;
  const validated = ranking(evaluations.filter((row) => row.validatedEligible))[0] ?? null;
  const body = {
    schemaVersion: "phase3-champion-selector-v1",
    currentProvisionalChampion: provisional ? deepFreeze({
      strategyId: provisional.strategyId,
      strategyIdentityDigest: provisional.strategyIdentityDigest,
      status: "PROVISIONAL_CHAMPION",
    }) : "NONE",
    currentValidatedChampion: validated ? deepFreeze({
      strategyId: validated.strategyId,
      strategyIdentityDigest: validated.strategyIdentityDigest,
      status: "VALIDATED_CHAMPION",
    }) : "NONE",
    evaluations,
    fallbackWinnerAllowed: false,
    liveTradingEligible: false,
    executionAuthority: "NONE",
  };
  return deepFreeze({ ...body, evidenceDigest: sha256Canonical(body), safety: PHASE3_SAFETY });
}

export function buildFailureResearchRestartV1(failureObservation) {
  const failure = record(failureObservation);
  if (failure?.schemaVersion !== "research-failure-observation-v1"
    || !validDigest(failure.failureObservationDigest)
    || failure.failureObservationDigest !== sha256Canonical(Object.fromEntries(
      Object.entries(failure).filter(([key]) => key !== "failureObservationDigest"),
    ))) {
    throw new TypeError("RESEARCH_FAILURE_OBSERVATION_INVALID");
  }
  return deepFreeze({
    schemaVersion: "failure-research-restart-v1",
    sourceFailureObservationDigest: failure.failureObservationDigest,
    next: Object.freeze([
      "NEW_HYPOTHESIS",
      "NEW_FORMULA_CANDIDATE",
      "NEW_STRATEGY_IDENTITY",
      "TOURNAMENT_RESTART",
    ]),
    sameStrategyMutationAllowed: false,
    priorPerformanceInheritanceAllowed: false,
    priorSampleCreditInheritanceAllowed: false,
    executionAuthority: "NONE",
  });
}

export function buildPhase3ResearchReadModelV1({
  generated = 0,
  tournament = 0,
  survivors = [],
  shadowEvaluations = [],
  naturalPaperCycles = [],
  settlementEvidence = [],
  health = [],
  championVerdict = null,
} = {}) {
  const provisional = championVerdict?.currentProvisionalChampion !== "NONE" && championVerdict?.currentProvisionalChampion != null ? 1 : 0;
  const validated = championVerdict?.currentValidatedChampion !== "NONE" && championVerdict?.currentValidatedChampion != null ? 1 : 0;
  return deepFreeze({
    schemaVersion: "phase3-research-read-model-v1",
    autonomousResearchStage: 4,
    pipeline: {
      Generated: Math.max(0, generated),
      Tournament: Math.max(0, tournament),
      Survivor: survivors.length,
      Shadow: shadowEvaluations.filter((row) => row?.status === "PASS").length,
      NaturalPaper: naturalPaperCycles.filter((row) => row?.naturalCredit === 1).length,
      Settlement: settlementEvidence.filter((row) => row?.sufficient === true).length,
      Healthy: health.filter((row) => row?.status === "HEALTHY").length,
      ProvisionalChampion: provisional,
      ValidatedChampion: validated,
    },
    labels: {
      PASS: "검증됨",
      FAIL: "탈락",
      MISSING_EVIDENCE: "증거 부족",
      NOT_EVALUABLE: "평가 불가",
      RESEARCHING: "연구중",
      NONE: "없음",
    },
    safety: PHASE3_SAFETY,
  });
}


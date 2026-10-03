import { createHash } from "node:crypto";
import {
  CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH,
  CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1,
  CRYPTO_PUMP_REVERSAL_VERSION,
} from "./crypto-pump-reversal-clean-v1.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA64 = /^[0-9a-f]{64}$/u;

export const PUMP_PROSPECTIVE_POLICY_VERSION = "crypto-pump-reversal-prospective-policy-v1";

export const PUMP_PROSPECTIVE_STAGE_THRESHOLDS = Object.freeze({
  functionalCheckN: 10,
  firstEconomicReviewN: 30,
  regimeReviewN: 50,
  fullValidationReviewN: 100,
});

export const PUMP_REQUIRED_FULL_COST_COMPONENTS = Object.freeze([
  "commission",
  "tax",
  "spread",
  "slippage",
  "funding",
  "latency",
  "liquidityImpact",
  "partialFillImpact",
]);

const OUTCOME_KEYS = new Set([
  "outcome",
  "result",
  "pnl",
  "netPnl",
  "returnPercent",
  "netReturnPercent",
  "winRate",
  "profitFactor",
  "targetHit",
  "stopHit",
  "futureReturn",
]);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function containsOutcome(value, seen = new Set()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) throw new Error("PUMP_PROSPECTIVE_INPUT_CYCLE_FORBIDDEN");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.some((item) => containsOutcome(item, seen));
    for (const [key, child] of Object.entries(value)) {
      if (OUTCOME_KEYS.has(key)) return true;
      if (containsOutcome(child, seen)) return true;
    }
    return false;
  } finally {
    seen.delete(value);
  }
}

function safety() {
  return Object.freeze({
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
    profitabilityCredit: 0,
    championPromotionAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
}

export function buildPumpProspectivePolicyV1({
  researchCodeSha,
  policyFrozenAtMs,
  eligibleAfterMs = policyFrozenAtMs + DAY_MS,
} = {}) {
  if (!SHA40.test(String(researchCodeSha ?? ""))) throw new Error("PUMP_PROSPECTIVE_RESEARCH_SHA_REQUIRED");
  if (!Number.isSafeInteger(policyFrozenAtMs) || policyFrozenAtMs <= 0) throw new Error("PUMP_PROSPECTIVE_FROZEN_AT_INVALID");
  if (!Number.isSafeInteger(eligibleAfterMs) || eligibleAfterMs < policyFrozenAtMs + DAY_MS) {
    throw new Error("PUMP_PROSPECTIVE_FUTURE_BUFFER_LT_24H");
  }

  const candidateCore = Object.freeze({
    strategyId: CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1,
    strategyVersion: CRYPTO_PUMP_REVERSAL_VERSION,
    parameterHash: CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH,
    researchCodeSha: researchCodeSha.toLowerCase(),
    strategyFamily: "EVENT_SPECIALIST",
    market: "CRYPTO_FUTURES",
    direction: "SHORT",
    timeframe: "1h",
    horizonHours: 72,
    universeBinding: "POINT_IN_TIME_DYNAMIC_BITGET_USDT_FUTURES",
    symbolBinding: "DYNAMIC_EVENT_SYMBOL",
  });
  const candidateDigest = sha256(candidateCore);
  const candidateId = `paper-candidate-v1:${candidateDigest}`;
  const core = Object.freeze({
    schemaVersion: PUMP_PROSPECTIVE_POLICY_VERSION,
    status: "FROZEN_PROSPECTIVE_RESEARCH_ONLY",
    policyFrozenAtMs,
    eligibleAfterMs,
    minimumFutureBufferMs: DAY_MS,
    candidate: Object.freeze({ ...candidateCore, candidateId }),
    candidateDigest,
    stageThresholds: PUMP_PROSPECTIVE_STAGE_THRESHOLDS,
    fullCostPolicy: Object.freeze({
      requiredComponents: PUMP_REQUIRED_FULL_COST_COMPONENTS,
      allEightRequired: true,
      missingCostAsZeroAllowed: false,
      fundingDirectionalFilterAllowed: false,
      settlementBeforeFullCostAllowed: false,
    }),
    antiTuning: Object.freeze({
      performanceBasedUniverseExclusionAllowed: false,
      samePeriodBadCoinExclusionAllowed: false,
      oosParameterRetuningAllowed: false,
      outcomeAwareCandidateSelectionAllowed: false,
      thresholdRelaxationAfterResultsAllowed: false,
    }),
    bootstrap: Object.freeze({
      rawProspectiveSignalCollectionAllowed: true,
      nextBarPaperResearchEntryAllowed: true,
      canonicalProfitAdmissionBeforeObservedCalibration: false,
      fabricatedExpectedEdgeAllowed: false,
      fabricatedSampleSizeAllowed: false,
      rawProspectiveSampleEconomicCredit: 0,
    }),
    integrationBlockers: Object.freeze([
      "STRATEGY_LEVEL_PROSPECTIVE_OWNER_NOT_CONNECTED",
      "CANONICAL_FULL_COST_SETTLEMENT_NOT_CONNECTED",
      "CANONICAL_PROFIT_ADMISSION_REQUIRES_OBSERVED_CALIBRATION",
    ]),
    safety: safety(),
  });
  return deepFreeze({ ...core, policyDigest: sha256(core) });
}

export function verifyPumpProspectivePolicyV1(policy) {
  const blockers = [];
  const add = (code) => { if (!blockers.includes(code)) blockers.push(code); };
  if (!policy || policy.schemaVersion !== PUMP_PROSPECTIVE_POLICY_VERSION) add("PUMP_PROSPECTIVE_POLICY_VERSION_INVALID");
  if (policy?.status !== "FROZEN_PROSPECTIVE_RESEARCH_ONLY") add("PUMP_PROSPECTIVE_POLICY_STATUS_INVALID");
  if (!SHA64.test(String(policy?.candidateDigest ?? ""))) add("PUMP_PROSPECTIVE_CANDIDATE_DIGEST_INVALID");
  if (!/^paper-candidate-v1:[0-9a-f]{64}$/u.test(String(policy?.candidate?.candidateId ?? ""))) add("PUMP_PROSPECTIVE_CANDIDATE_ID_INVALID");
  if (policy?.candidate?.strategyId !== CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1
    || policy?.candidate?.parameterHash !== CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH
    || policy?.candidate?.market !== "CRYPTO_FUTURES"
    || policy?.candidate?.direction !== "SHORT"
    || policy?.candidate?.symbolBinding !== "DYNAMIC_EVENT_SYMBOL") {
    add("PUMP_PROSPECTIVE_CANDIDATE_IDENTITY_INVALID");
  }
  if (!SHA40.test(String(policy?.candidate?.researchCodeSha ?? ""))) add("PUMP_PROSPECTIVE_RESEARCH_SHA_INVALID");
  if (!Number.isSafeInteger(policy?.policyFrozenAtMs)
    || !Number.isSafeInteger(policy?.eligibleAfterMs)
    || policy.eligibleAfterMs < policy.policyFrozenAtMs + DAY_MS) {
    add("PUMP_PROSPECTIVE_FUTURE_BOUNDARY_INVALID");
  }
  if (stable(policy?.stageThresholds) !== stable(PUMP_PROSPECTIVE_STAGE_THRESHOLDS)) add("PUMP_PROSPECTIVE_STAGE_THRESHOLDS_MUTATED");
  if (stable(policy?.fullCostPolicy?.requiredComponents) !== stable(PUMP_REQUIRED_FULL_COST_COMPONENTS)
    || policy?.fullCostPolicy?.allEightRequired !== true
    || policy?.fullCostPolicy?.missingCostAsZeroAllowed !== false
    || policy?.fullCostPolicy?.fundingDirectionalFilterAllowed !== false
    || policy?.fullCostPolicy?.settlementBeforeFullCostAllowed !== false) {
    add("PUMP_PROSPECTIVE_FULL_COST_POLICY_INVALID");
  }
  if (policy?.antiTuning?.performanceBasedUniverseExclusionAllowed !== false
    || policy?.antiTuning?.samePeriodBadCoinExclusionAllowed !== false
    || policy?.antiTuning?.oosParameterRetuningAllowed !== false
    || policy?.antiTuning?.outcomeAwareCandidateSelectionAllowed !== false
    || policy?.antiTuning?.thresholdRelaxationAfterResultsAllowed !== false) {
    add("PUMP_PROSPECTIVE_ANTI_TUNING_INVALID");
  }
  if (policy?.bootstrap?.canonicalProfitAdmissionBeforeObservedCalibration !== false
    || policy?.bootstrap?.fabricatedExpectedEdgeAllowed !== false
    || policy?.bootstrap?.fabricatedSampleSizeAllowed !== false
    || policy?.bootstrap?.rawProspectiveSampleEconomicCredit !== 0) {
    add("PUMP_PROSPECTIVE_BOOTSTRAP_INVALID");
  }
  const s = policy?.safety ?? {};
  if (s.profitabilityProven !== false
    || s.profitabilityClaimAllowed !== false
    || s.profitabilityCredit !== 0
    || s.championPromotionAllowed !== false
    || s.liveTrading !== false
    || s.autoTrading !== false
    || s.realOrderEnabled !== false
    || s.privateTradingApiAllowed !== false
    || s.executionAuthority !== "NONE") {
    add("PUMP_PROSPECTIVE_SAFETY_INVALID");
  }
  if (!SHA64.test(String(policy?.policyDigest ?? ""))) add("PUMP_PROSPECTIVE_POLICY_DIGEST_INVALID");
  else {
    const { policyDigest, ...rest } = policy;
    if (sha256(rest) !== policyDigest) add("PUMP_PROSPECTIVE_POLICY_DIGEST_MISMATCH");
  }
  return deepFreeze({ valid: blockers.length === 0, blockers });
}

export function admitPumpProspectiveSignalV1(policy, signal, {
  observedAtMs,
  synthetic = false,
  replay = false,
  backfill = false,
  historical = false,
  manual = false,
  testOnly = false,
} = {}) {
  const verdict = verifyPumpProspectivePolicyV1(policy);
  if (!verdict.valid) throw new Error(`PUMP_PROSPECTIVE_POLICY_INVALID:${verdict.blockers.join(",")}`);
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < policy.eligibleAfterMs) {
    throw new Error("PUMP_PROSPECTIVE_PRE_BOUNDARY_SIGNAL_FORBIDDEN");
  }
  if ([synthetic, replay, backfill, historical, manual, testOnly].some((flag) => flag !== false)) {
    throw new Error("PUMP_PROSPECTIVE_NON_GENUINE_SIGNAL_FORBIDDEN");
  }
  if (containsOutcome(signal)) throw new Error("PUMP_PROSPECTIVE_OUTCOME_AWARE_SIGNAL_FORBIDDEN");
  if (!signal
    || signal.schemaVersion !== "crypto-pump-reversal-clean-signal-v1"
    || signal.strategyId !== policy.candidate.strategyId
    || signal.strategyVersion !== policy.candidate.strategyVersion
    || signal.parameterHash !== policy.candidate.parameterHash
    || signal.market !== "CRYPTO_FUTURES"
    || signal.direction !== "SHORT"
    || signal.eligibleForProspectiveResearchSample !== true
    || signal.canonicalProfitAdmissionEligible !== false
    || signal.profitabilityProven !== false
    || !SHA64.test(String(signal.signalId ?? ""))) {
    throw new Error("PUMP_PROSPECTIVE_SIGNAL_IDENTITY_INVALID");
  }
  if (!Number.isSafeInteger(signal.signalConfirmedAtMs)
    || signal.signalConfirmedAtMs < policy.eligibleAfterMs
    || signal.signalConfirmedAtMs > observedAtMs) {
    throw new Error("PUMP_PROSPECTIVE_SIGNAL_TIME_INVALID");
  }

  const observationCore = Object.freeze({
    schemaVersion: "crypto-pump-reversal-prospective-observation-v1",
    policyDigest: policy.policyDigest,
    candidateId: policy.candidate.candidateId,
    candidateDigest: policy.candidateDigest,
    strategyId: policy.candidate.strategyId,
    strategyVersion: policy.candidate.strategyVersion,
    parameterHash: policy.candidate.parameterHash,
    researchCodeSha: policy.candidate.researchCodeSha,
    market: "CRYPTO_FUTURES",
    symbol: signal.symbol,
    direction: "SHORT",
    signalId: signal.signalId,
    signalConfirmedAtMs: signal.signalConfirmedAtMs,
    nextBarOpenTimestampMs: signal.nextBarOpenTimestampMs,
    observedAtMs,
    sampleClass: "GENUINE_FUTURE_PROSPECTIVE_RESEARCH",
    dynamicSymbolAllowed: true,
    synthetic: false,
    replay: false,
    backfill: false,
    historical: false,
    manual: false,
    testOnly: false,
    profitabilityCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
  });
  return deepFreeze({
    status: "ADMITTED_RAW_PROSPECTIVE",
    observation: Object.freeze({
      ...observationCore,
      observationId: sha256(observationCore),
    }),
    canonicalProfitAdmissionEligible: false,
    fullCostSettlementRequired: true,
    profitabilityCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
  });
}

export function pumpProspectiveStageForCounts({
  rawSettledN = 0,
  fullCostSettledN = 0,
} = {}) {
  if (!Number.isInteger(rawSettledN) || rawSettledN < 0
    || !Number.isInteger(fullCostSettledN) || fullCostSettledN < 0
    || fullCostSettledN > rawSettledN) {
    throw new Error("PUMP_PROSPECTIVE_SAMPLE_COUNTS_INVALID");
  }
  const n = fullCostSettledN;
  const stage = n >= 100 ? "FULL_VALIDATION_REVIEW"
    : n >= 50 ? "REGIME_REVIEW"
      : n >= 30 ? "FIRST_ECONOMIC_REVIEW"
        : n >= 10 ? "FUNCTIONAL_CHECK"
          : "COLLECTING";
  return deepFreeze({
    stage,
    rawSettledN,
    fullCostSettledN,
    functionCheckReady: n >= 10,
    firstEconomicReviewReady: n >= 30,
    regimeReviewReady: n >= 50,
    fullValidationReviewReady: n >= 100,
    passAllowed: false,
    passBlockers: [
      "OOS_WALK_FORWARD_NOT_YET_EVALUATED",
      "PROMOTION_POLICY_NOT_SATISFIED",
    ],
    profitabilityProven: false,
    currentValidatedChampion: "NONE",
    executionAuthority: "NONE",
  });
}

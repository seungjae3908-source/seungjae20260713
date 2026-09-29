import { sha256Canonical } from "./research-cache-provenance.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "./adaptive-multi-evidence-point-in-time-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_POSITION_POLICY_V2_VERSION } from "./adaptive-multi-evidence-position-policy-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION =
  "adaptive-multi-evidence-natural-paper-v2";

const MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const EXECUTION_STYLES = new Set(["SCALPING", "SWING", "MID_LONG"]);
const SHA40 = /^[0-9a-f]{40}$/iu;
const SHA64 = /^[0-9a-f]{64}$/iu;
const V2_CANDIDATE = /^generated-formula-candidate:sha256:[0-9a-f]{64}$/u;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positive(value) {
  const number = finite(value);
  return number != null && number > 0 ? number : null;
}

function safety() {
  return {
    paperOnly: true,
    shadowAllowed: true,
    scheduleActive: false,
    runtimeActivated: false,
    activationRequiresSeparateApproval: true,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

export function isAdaptiveMultiEvidenceV2FrozenCandidateId(value) {
  return typeof value === "string" && V2_CANDIDATE.test(value);
}

function failure(blockers) {
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "BLOCKED_DATA",
    blockers: [...new Set(blockers)].sort(),
    candidate: null,
    cycleContract: null,
    frozenV1Contamination: 0,
    economicSampleCredit: 0,
    ...safety(),
  });
}

function executionDirection(market, direction) {
  if (market === "CRYPTO_FUTURES") return direction === "LONG" || direction === "SHORT" ? direction : null;
  return direction === "LONG" ? "BUY" : null;
}

function executionOrderType(simulation) {
  if (simulation === "MARKET_SIM") return "MARKET";
  if (simulation === "LIMIT_SIM" || simulation === "SPLIT_SIM") return "LIMIT";
  return null;
}

function validateNaturalEvidence(raw, signalId, signalTimestampMs, evaluatedAtMs) {
  return raw?.provenanceClass === "NATURAL_FORWARD"
    && raw.synthetic === false && raw.replay === false && raw.testOnly === false
    && raw.backfill === false && raw.historical === false && raw.duplicate === false
    && text(raw.observationId) && text(raw.source)
    && Number.isSafeInteger(raw.observedAtMs) && raw.observedAtMs >= signalTimestampMs
    && raw.observedAtMs <= evaluatedAtMs && signalId != null;
}

function validateExecution(raw, identity, market, quantity, orderType) {
  const costPolicy = raw?.costPolicy;
  const policy = raw?.executionPolicy;
  const evidence = raw?.dataEvidence;
  const quote = raw?.quote;
  const order = raw?.order;
  const blockers = [];
  if (!text(costPolicy?.version) || costPolicy.version !== identity.costPolicyVersion) {
    blockers.push("V2_NATURAL_PAPER_COST_POLICY_MISMATCH");
  }
  for (const key of ["commissionRate", "taxRate", "spreadRate", "slippageRate", "latencyRate",
    "liquidityImpactRate", "partialFillImpactRate", "fundingRate"]) {
    if (finite(costPolicy?.[key]) == null || costPolicy[key] < 0) blockers.push("V2_NATURAL_PAPER_COST_POLICY_INCOMPLETE");
  }
  if (!text(policy?.version) || policy.version !== identity.executionPolicyVersion
      || policy.fillModel !== "TOP_OF_BOOK" || policy.sameBarPolicy !== "STOP_FIRST"
      || policy.allowPartialFill !== true || !(positive(policy.maxParticipationRate) <= 1)) {
    blockers.push("V2_NATURAL_PAPER_EXECUTION_POLICY_INVALID");
  }
  if (!text(raw?.marketAdapterIdentity?.id) || !text(raw?.marketAdapterIdentity?.version)
      || !text(evidence?.provider) || evidence?.publicOnly !== true
      || evidence?.dataQuality !== "READY" || !text(evidence?.provenance)
      || !Number.isSafeInteger(evidence?.asOfMs) || !Number.isSafeInteger(evidence?.maxAgeMs)
      || evidence.maxAgeMs <= 0) blockers.push("V2_NATURAL_PAPER_PUBLIC_EVIDENCE_INVALID");
  if (!positive(quote?.bid) || !positive(quote?.ask) || quote.ask < quote.bid
      || !positive(quote?.bidSize) || !positive(quote?.askSize)
      || quote?.asOfMs !== evidence?.asOfMs || quote?.maxAgeMs !== evidence?.maxAgeMs) {
    blockers.push("V2_NATURAL_PAPER_QUOTE_INVALID");
  }
  if (order?.type !== orderType || order?.direction !== executionDirection(market, identity.direction)
      || order?.quantity !== quantity || (orderType === "LIMIT" && !positive(order?.limitPrice))) {
    blockers.push("V2_NATURAL_PAPER_SIMULATED_ORDER_INVALID");
  }
  return blockers;
}

export function buildAdaptiveMultiEvidenceNaturalPaperCandidateV2(input = {}) {
  const blockers = [];
  const policy = input.positionPolicy;
  if (policy?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_POSITION_POLICY_V2_VERSION
      || policy?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
      || policy?.status !== "POSITION_POLICY_READY" || policy?.executionAuthority !== "NONE"
      || policy?.frozenV1Contamination !== 0) blockers.push("V2_NATURAL_PAPER_POSITION_POLICY_INVALID");
  if (input.executionAuthority != null && input.executionAuthority !== "NONE") {
    blockers.push("V2_NATURAL_PAPER_EXECUTION_AUTHORITY_FORBIDDEN");
  }
  const identity = {
    candidateId: policy?.identity?.strategyIdentity,
    strategyFamily: text(input.strategyFamily),
    strategyId: text(input.strategyId),
    strategyVersion: text(input.strategyVersion),
    parameterHash: text(input.parameterHash)?.toLowerCase() ?? null,
    parameterDigest: text(input.parameterDigest)?.toLowerCase() ?? null,
    researchCodeSha: text(input.researchCodeSha)?.toLowerCase() ?? null,
    costPolicyVersion: text(input.execution?.costPolicy?.version),
    executionPolicyVersion: text(input.execution?.executionPolicy?.version),
    accountMode: "PAPER",
    direction: policy?.identity?.direction,
  };
  if (!isAdaptiveMultiEvidenceV2FrozenCandidateId(identity.candidateId)
      || !identity.strategyFamily || !identity.strategyId || !identity.strategyVersion
      || !SHA64.test(identity.parameterHash ?? "") || identity.parameterDigest !== identity.parameterHash
      || !SHA40.test(identity.researchCodeSha ?? "") || !identity.costPolicyVersion
      || !identity.executionPolicyVersion) blockers.push("V2_NATURAL_PAPER_STRATEGY_IDENTITY_INVALID");
  const market = policy?.identity?.market;
  const symbol = policy?.identity?.symbol;
  const direction = executionDirection(market, identity.direction);
  const signalId = text(input.signalId);
  const signalTimestampMs = input.signalTimestampMs;
  const evaluatedAtMs = input.evaluatedAtMs;
  const horizon = input.horizon;
  const referencePrice = positive(input.referencePrice);
  const executionStyle = text(input.executionStyle)?.toUpperCase() ?? null;
  const orderType = executionOrderType(policy?.executionSimulation);
  if (!MARKETS.has(market) || !text(symbol) || !direction || !signalId
      || !Number.isSafeInteger(signalTimestampMs) || !Number.isSafeInteger(evaluatedAtMs)
      || signalTimestampMs > evaluatedAtMs || !Number.isSafeInteger(horizon) || horizon <= 0
      || !referencePrice || !orderType || !text(input.timeframe) || !EXECUTION_STYLES.has(executionStyle)) {
    blockers.push("V2_NATURAL_PAPER_SIGNAL_OR_TIME_INVALID");
  }
  if (!validateNaturalEvidence(input.naturalEvidence, signalId, signalTimestampMs, evaluatedAtMs)) {
    blockers.push("V2_NATURAL_PAPER_GENUINE_FORWARD_EVIDENCE_REQUIRED");
  }
  blockers.push(...validateExecution(input.execution, identity, market, policy?.sizing?.addedQuantity, orderType));
  const expectedNetEdge = finite(input.expectedNetEvidence?.expectedNetEdge);
  const expectedNetReturn = finite(input.expectedNetEvidence?.expectedNetReturn);
  const riskRewardRatio = finite(input.expectedNetEvidence?.riskRewardRatio);
  const sampleSize = input.expectedNetEvidence?.sampleSize;
  if (!(expectedNetEdge > 0) || !(expectedNetReturn > 0) || !(riskRewardRatio >= 1)
      || !Number.isSafeInteger(sampleSize) || sampleSize <= 0
      || text(input.expectedNetEvidence?.evidenceId) == null) {
    blockers.push("V2_NATURAL_PAPER_PROSPECTIVE_NET_EVIDENCE_INVALID");
  }
  if (blockers.length > 0) return failure(blockers);

  const strategyIdentity = Object.freeze({
    candidateId: identity.candidateId,
    strategyFamily: identity.strategyFamily,
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    parameterDigest: identity.parameterDigest,
    researchCodeSha: identity.researchCodeSha,
    costPolicyVersion: identity.costPolicyVersion,
    executionPolicyVersion: identity.executionPolicyVersion,
    accountMode: "PAPER",
  });
  const learningSnapshot = Object.freeze({
    signalId,
    timestamp: new Date(signalTimestampMs).toISOString(),
    market,
    symbol,
    symbolName: null,
    strategyHorizon: executionStyle,
    direction,
    signalScore: null,
    displayConfidence: null,
    referencePrice,
    entryPrice: input.entryPrice ?? referencePrice,
    stopLoss: policy.exits.hardStop,
    target1: policy.exits.takeProfit1.price,
    target2: policy.exits.takeProfit2.price,
    riskReward: riskRewardRatio,
    timeframes: Object.freeze([text(input.timeframe)]),
    strategyProfileVersion: identity.strategyVersion,
    indicatorSnapshot: Object.freeze({}),
    indicatorScores: Object.freeze({}),
    patternSnapshot: Object.freeze({}),
    volumeContext: Object.freeze({}),
    volatilityContext: Object.freeze({}),
    trendContext: Object.freeze({}),
    marketRegime: text(input.marketRegime) ?? "UNKNOWN",
    liquidityContext: Object.freeze({ participation: policy.sizing.liquidityParticipation }),
    aiValidatorResult: null,
    riskEngineResult: Object.freeze({ evidenceId: policy.audit.globalRiskEvidenceId }),
    dataProvenance: Object.freeze([input.execution.dataEvidence.provenance]),
    dataTimestamp: new Date(input.execution.dataEvidence.asOfMs).toISOString(),
    immutable: true,
    executionAuthority: "NONE",
  });
  const candidate = {
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    candidateId: identity.candidateId,
    signal: {
      signalId,
      market,
      symbol,
      timestampMs: signalTimestampMs,
      style: executionStyle,
      timeframe: text(input.timeframe),
      horizon,
      direction,
      strategyIdentity,
      learningSnapshot,
    },
    riskEvidence: {
      status: "APPROVED",
      evaluatedAtMs,
      simulatedOnly: true,
      evidenceId: policy.audit.globalRiskEvidenceId,
    },
    riskPolicyIdentity: {
      policyId: policy.exits.validatedPolicyEvidenceId,
      policyVersion: identity.strategyVersion,
      source: ADAPTIVE_MULTI_EVIDENCE_POSITION_POLICY_V2_VERSION,
      researchCodeSha: identity.researchCodeSha,
    },
    profitGate: { decision: "ELIGIBLE", eligible: true, reasons: [], executionAuthority: "NONE" },
    profitEvidence: {
      status: "READY",
      expectedNetEdge,
      expectedNetReturn,
      riskRewardRatio,
      sampleSize,
      costPolicyId: identity.costPolicyVersion,
      evidenceId: input.expectedNetEvidence.evidenceId,
      executionAuthority: "NONE",
    },
    execution: {
      marketAdapterIdentity: input.execution.marketAdapterIdentity,
      strategyIdentity,
      costPolicy: input.execution.costPolicy,
      executionPolicy: input.execution.executionPolicy,
      dataEvidence: {
        ...input.execution.dataEvidence,
        quoteEvidence: {
          available: true,
          bid: input.execution.quote.bid,
          ask: input.execution.quote.ask,
          asOfMs: input.execution.quote.asOfMs,
          maxAgeMs: input.execution.quote.maxAgeMs,
        },
      },
    },
    order: input.execution.order,
    quote: input.execution.quote,
    naturalEvidence: input.naturalEvidence,
    testOnly: false,
  };
  const cycleContract = {
    schemaVersion: "adaptive-multi-evidence-natural-paper-cycle-contract-v2",
    stages: Object.freeze([
      "MARKET_DATA", "SCANNER", "CANDIDATE", "EVIDENCE", "SPECIALISTS", "REGIME",
      "DECISION", "COST_LIQUIDITY", "GLOBAL_RISK", "PAPER_ENTRY", "FILL", "POSITION",
      "EXIT", "SETTLEMENT", "FULL_COST", "JOURNAL", "PERFORMANCE", "NEXT_CYCLE",
    ]),
    recurringOwner: "recurring-paper-loop-v1",
    schedulerOwner: "paper-scheduler-driver-v1",
    lifecycleOwner: "natural-paper-position-settlement-lifecycle-v1",
    settlementCostOwner: "natural-paper-trigger-bound-settlement-cost-producer-v1",
    idempotencyRequired: true,
    restartRestoreRequired: true,
    duplicateSettlementProtectionRequired: true,
    activationState: "INACTIVE_REQUIRES_SEPARATE_APPROVAL",
    scheduleActive: false,
    executionAuthority: "NONE",
  };
  const core = { candidate, cycleContract };
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "NATURAL_PAPER_CANDIDATE_READY_INACTIVE",
    ...core,
    handoffDigest: sha256Canonical(core),
    blockers: [],
    frozenV1Contamination: 0,
    economicSampleCredit: 0,
    profitabilityProven: false,
    ...safety(),
  });
}

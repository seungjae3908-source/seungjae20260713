import {
  deriveExecutionDecision,
  normalizeSignalDirection,
  resolveSignalLifecycle,
} from "./signal-direction-contract-v1.js";

const SEARCH_OUTCOMES = new Set(["SEARCH_FAILURE", "VALID_NO_TRADE", "TRADE_CANDIDATES"]);
const MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);

function freeze(value) { return Object.freeze(value); }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function immutableSha(value) { return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value); }

function result(status, blockers = [], candidate = null) {
  return freeze({
    schemaVersion: "meaningful-search-paper-bridge-v1",
    status,
    blockers: freeze([...new Set(blockers)]),
    candidate,
    submitToPaper: status === "PAPER_ELIGIBLE",
    submitToPaperExit: status === "PAPER_EXIT_SIGNAL",
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
  });
}

function validateSafetyEnvelope(value, blockers, prefix) {
  if (value?.executionAuthority != null && value.executionAuthority !== "NONE") blockers.push(`${prefix}_EXECUTION_AUTHORITY_FORBIDDEN`);
  if (value?.orderSubmitted === true) blockers.push(`${prefix}_REAL_ORDER_FORBIDDEN`);
  if (value?.exchangeRequestSent === true) blockers.push(`${prefix}_EXCHANGE_REQUEST_FORBIDDEN`);
  if (value?.privateApiUsed === true || value?.privateTradingApiAllowed === true) blockers.push(`${prefix}_PRIVATE_API_FORBIDDEN`);
  if (value?.liveTrading === true || value?.liveOrderAllowed === true) blockers.push(`${prefix}_LIVE_TRADING_FORBIDDEN`);
}

function validateProfitEvidence(profitEvidence, blockers) {
  if (profitEvidence?.status !== "READY") blockers.push("PROFIT_EVIDENCE_NOT_READY");
  if (!finite(profitEvidence?.expectedNetEdge) || profitEvidence.expectedNetEdge <= 0) blockers.push("POSITIVE_NET_EDGE_EVIDENCE_REQUIRED");
  if (!finite(profitEvidence?.expectedNetReturn) || profitEvidence.expectedNetReturn <= 0) blockers.push("POSITIVE_NET_RETURN_EVIDENCE_REQUIRED");
  if (!finite(profitEvidence?.riskRewardRatio) || profitEvidence.riskRewardRatio < 1) blockers.push("RISK_REWARD_EVIDENCE_REQUIRED");
  if (!Number.isInteger(profitEvidence?.sampleSize) || profitEvidence.sampleSize <= 0) blockers.push("FORWARD_SAMPLE_EVIDENCE_REQUIRED");
  if (!nonEmpty(profitEvidence?.costPolicyId)) blockers.push("COST_POLICY_EVIDENCE_REQUIRED");
  validateSafetyEnvelope(profitEvidence, blockers, "PROFIT_EVIDENCE");
}

function resolvedRegime(signal) {
  if (nonEmpty(signal?.regime)) return signal.regime.trim();
  if (nonEmpty(signal?.learningSnapshot?.marketRegime)) return signal.learningSnapshot.marketRegime.trim();
  return null;
}

function validateStrategyIdentity(candidate, blockers) {
  const signal = candidate?.signal;
  const identity = signal?.strategyIdentity;
  const executionIdentity = candidate?.execution?.strategyIdentity;
  const learning = signal?.learningSnapshot;

  if (!nonEmpty(identity?.strategyId)) blockers.push("STRATEGY_ID_REQUIRED");
  if (!nonEmpty(identity?.strategyVersion)) blockers.push("STRATEGY_VERSION_REQUIRED");
  if (!nonEmpty(identity?.parameterHash)) blockers.push("PARAMETER_HASH_REQUIRED");
  if (!immutableSha(identity?.researchCodeSha)) blockers.push("RESEARCH_CODE_SHA_REQUIRED");
  if (!nonEmpty(signal?.timeframe)) blockers.push("TIMEFRAME_REQUIRED");
  if (!Number.isInteger(signal?.horizon) || signal.horizon <= 0) blockers.push("HORIZON_REQUIRED");
  if (!resolvedRegime(signal)) blockers.push("REGIME_REQUIRED");

  if (learning) {
    if (learning.signalId !== signal?.signalId) blockers.push("LEARNING_SIGNAL_ID_MISMATCH");
    if (learning.market !== signal?.market) blockers.push("LEARNING_MARKET_MISMATCH");
    if (learning.symbol !== signal?.symbol) blockers.push("LEARNING_SYMBOL_MISMATCH");
    if (nonEmpty(learning.strategyProfileVersion) && nonEmpty(identity?.strategyVersion)
      && learning.strategyProfileVersion !== identity.strategyVersion) blockers.push("LEARNING_STRATEGY_VERSION_MISMATCH");
    if (Array.isArray(learning.timeframes) && nonEmpty(signal?.timeframe)
      && !learning.timeframes.includes(signal.timeframe)) blockers.push("LEARNING_TIMEFRAME_MISMATCH");
    if (nonEmpty(learning.strategyHorizon) && nonEmpty(signal?.style)
      && learning.strategyHorizon.toUpperCase() !== signal.style.toUpperCase()) blockers.push("LEARNING_HORIZON_STYLE_MISMATCH");
    const learningDirection = normalizeSignalDirection(learning.direction);
    const signalDirection = normalizeSignalDirection(signal?.signalDirection ?? signal?.direction);
    if (learningDirection !== signalDirection) blockers.push("LEARNING_DIRECTION_MISMATCH");
    if (nonEmpty(signal?.regime) && nonEmpty(learning.marketRegime) && signal.regime !== learning.marketRegime) {
      blockers.push("LEARNING_REGIME_MISMATCH");
    }
  }

  if (!executionIdentity || typeof executionIdentity !== "object") {
    blockers.push("EXECUTION_STRATEGY_IDENTITY_REQUIRED");
    return;
  }
  if (nonEmpty(identity?.strategyId) && executionIdentity.strategyId !== identity.strategyId) blockers.push("EXECUTION_STRATEGY_ID_MISMATCH");
  if (nonEmpty(identity?.strategyVersion) && executionIdentity.strategyVersion !== identity.strategyVersion) blockers.push("EXECUTION_STRATEGY_VERSION_MISMATCH");
  if (nonEmpty(identity?.parameterHash) && executionIdentity.parameterHash !== identity.parameterHash) blockers.push("EXECUTION_PARAMETER_HASH_MISMATCH");
  if (immutableSha(identity?.researchCodeSha)
    && String(executionIdentity.researchCodeSha ?? "").toLowerCase() !== identity.researchCodeSha.toLowerCase()) {
    blockers.push("EXECUTION_RESEARCH_SHA_MISMATCH");
  }
}

function validateCostIdentity(candidate, profitEvidence, blockers) {
  const evidenceVersion = profitEvidence?.costPolicyId;
  const executionVersion = candidate?.execution?.costPolicy?.version;
  if (!nonEmpty(executionVersion)) blockers.push("EXECUTION_COST_POLICY_REQUIRED");
  if (nonEmpty(evidenceVersion) && nonEmpty(executionVersion) && evidenceVersion !== executionVersion) {
    blockers.push("PAPER_COST_POLICY_VERSION_MISMATCH");
  }
}

function validateCandidate(candidate, blockers) {
  const signal = candidate?.signal;
  if (!signal || !nonEmpty(signal.signalId)) blockers.push("SIGNAL_ID_REQUIRED");
  if (!MARKETS.has(signal?.market)) blockers.push("MARKET_UNSUPPORTED");
  if (!nonEmpty(signal?.symbol)) blockers.push("SYMBOL_REQUIRED");
  if (!finite(signal?.timestampMs)) blockers.push("SIGNAL_TIMESTAMP_REQUIRED");
  if (!signal?.learningSnapshot || signal.learningSnapshot.signalId !== signal.signalId) blockers.push("LEARNING_SNAPSHOT_REQUIRED");
  if (candidate?.riskEvidence?.status !== "APPROVED" || candidate?.riskEvidence?.simulatedOnly !== true) blockers.push("RISK_EVIDENCE_NOT_APPROVED");
  if (candidate?.execution?.dataEvidence?.dataQuality !== "READY") blockers.push("BLOCKED_DATA");
  validateStrategyIdentity(candidate, blockers);
  validateSafetyEnvelope(candidate, blockers, "CANDIDATE");
}

function directionPolicy(candidate) {
  const signal = candidate?.signal ?? {};
  const evaluatedAtMs = finite(candidate?.riskEvidence?.evaluatedAtMs)
    ? candidate.riskEvidence.evaluatedAtMs
    : finite(candidate?.execution?.dataEvidence?.asOfMs)
      ? candidate.execution.dataEvidence.asOfMs
      : signal.timestampMs;
  const lifecycle = resolveSignalLifecycle({
    lifecycle: signal.lifecycle ?? candidate?.signalLifecycle ?? "ACTIVE",
    generatedAtMs: signal.timestampMs,
    ttlMs: signal.ttlMs,
    expiresAtMs: signal.expiresAtMs,
    evaluatedAtMs,
    invalidated: signal.invalidated === true || candidate?.invalidated === true,
    enteredPaper: signal.lifecycle === "ENTERED_PAPER",
    settled: signal.lifecycle === "SETTLED",
  });
  const signalDirection = normalizeSignalDirection(signal.signalDirection ?? signal.direction ?? candidate?.signalDirection ?? candidate?.direction);
  const execution = deriveExecutionDecision({
    market: signal.market,
    direction: signalDirection,
    positionSide: signal.positionSide ?? candidate?.positionSide ?? "FLAT",
    lifecycle,
    reduceOnly: signal.reduceOnly === true || candidate?.reduceOnly === true,
  });
  return freeze({ signalDirection, lifecycle, ...execution });
}

function buildPaperIdentity(candidate, policy, profitEvidence = null) {
  const signal = candidate?.signal ?? {};
  const strategy = signal.strategyIdentity ?? {};
  return freeze({
    signalId: signal.signalId ?? null,
    strategyId: strategy.strategyId ?? null,
    strategyVersion: strategy.strategyVersion ?? null,
    parameterHash: strategy.parameterHash ?? null,
    market: signal.market ?? null,
    symbol: signal.symbol ?? null,
    timeframe: signal.timeframe ?? null,
    horizon: signal.horizon ?? null,
    direction: policy?.signalDirection ?? normalizeSignalDirection(signal.signalDirection ?? signal.direction),
    regime: resolvedRegime(signal),
    costPolicyVersion: profitEvidence?.costPolicyId ?? candidate?.execution?.costPolicy?.version ?? null,
    researchCodeSha: immutableSha(strategy.researchCodeSha) ? strategy.researchCodeSha.toLowerCase() : null,
    executionAuthority: "NONE",
  });
}

function enrichCandidate(candidate, policy, profitGate = null, profitEvidence = null) {
  const signal = freeze({
    ...candidate.signal,
    direction: policy.signalDirection,
    signalDirection: policy.signalDirection,
    lifecycle: policy.lifecycle,
    executionIntent: policy.executionIntent,
    positionSide: policy.positionSide,
  });
  const enriched = {
    ...candidate,
    signal,
    paperIdentity: buildPaperIdentity(candidate, policy, profitEvidence),
    signalDirection: policy.signalDirection,
    signalLifecycle: policy.lifecycle,
    executionIntent: policy.executionIntent,
    positionSide: policy.positionSide,
    nextPositionSide: policy.nextPositionSide,
    directionReason: policy.reason,
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
  if (profitGate) enriched.profitGate = freeze({ decision: "ELIGIBLE", eligible: true, reasons: freeze([]), executionAuthority: "NONE" });
  if (profitEvidence) enriched.profitEvidence = freeze({ ...profitEvidence, executionAuthority: "NONE" });
  return freeze(enriched);
}

export function prepareMeaningfulSearchPaperCandidate({ searchOutcome, candidate, profitGate, profitEvidence } = {}) {
  if (!SEARCH_OUTCOMES.has(searchOutcome)) throw new TypeError("valid searchOutcome is required");
  if (searchOutcome === "SEARCH_FAILURE") return result("BLOCKED", ["SEARCH_FAILURE"]);
  if (searchOutcome === "VALID_NO_TRADE") return result("NO_TRADE", ["VALID_NO_TRADE"]);

  const policy = directionPolicy(candidate);
  if (policy.signalDirection === "NO_TRADE") return result("NO_TRADE", ["SIGNAL_NO_TRADE"], enrichCandidate(candidate, policy));
  if (!policy.allowed) return result("BLOCKED", [policy.reason], candidate ? enrichCandidate(candidate, policy) : null);
  if (policy.executionIntent === "NONE" || policy.executionIntent === "HOLD") {
    return result("NO_TRADE", [policy.reason], enrichCandidate(candidate, policy));
  }

  const candidateBlockers = [];
  validateCandidate(candidate, candidateBlockers);
  if (candidateBlockers.length) return result("BLOCKED", candidateBlockers, enrichCandidate(candidate, policy));

  if (policy.executionIntent === "EXIT" || policy.executionIntent === "REDUCE") {
    return result("PAPER_EXIT_SIGNAL", [], enrichCandidate(candidate, policy));
  }

  const gateReasons = Array.isArray(profitGate?.reasons) ? profitGate.reasons.filter(nonEmpty) : [];
  if (profitGate?.decision !== "ELIGIBLE" || profitGate?.eligible !== true) {
    return result("NO_TRADE", gateReasons.length ? gateReasons : ["PROFIT_GATE_NOT_ELIGIBLE"], enrichCandidate(candidate, policy));
  }
  if (profitGate?.executionAuthority !== "NONE") return result("BLOCKED", ["PROFIT_GATE_EXECUTION_AUTHORITY_FORBIDDEN"], enrichCandidate(candidate, policy));

  const blockers = [];
  validateProfitEvidence(profitEvidence, blockers);
  validateCostIdentity(candidate, profitEvidence, blockers);
  if (blockers.length) return result("BLOCKED", blockers, enrichCandidate(candidate, policy, profitGate, profitEvidence));

  return result("PAPER_ELIGIBLE", [], enrichCandidate(candidate, policy, profitGate, profitEvidence));
}

export function meaningfulSearchPaperCandidates(decisions = []) {
  if (!Array.isArray(decisions)) throw new TypeError("decisions array is required");
  const results = decisions.map((decision) => prepareMeaningfulSearchPaperCandidate(decision));
  return freeze({
    results: freeze(results),
    candidates: freeze(results.filter((row) => row.submitToPaper).map((row) => row.candidate)),
    exitSignals: freeze(results.filter((row) => row.submitToPaperExit).map((row) => row.candidate)),
    blocked: results.filter((row) => row.status === "BLOCKED").length,
    noTrade: results.filter((row) => row.status === "NO_TRADE").length,
    eligible: results.filter((row) => row.status === "PAPER_ELIGIBLE").length,
    exits: results.filter((row) => row.status === "PAPER_EXIT_SIGNAL").length,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  });
}
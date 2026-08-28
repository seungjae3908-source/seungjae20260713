import { createHash } from "node:crypto";

export const NATURAL_PAPER_POSITION_SETTLEMENT_LIFECYCLE_VERSION =
  "natural-paper-position-settlement-lifecycle-v1";

const OPEN = "OPEN";
const NATURAL_FORWARD = "NATURAL_FORWARD";
const TEST_ONLY = "TEST_ONLY";
const MISSING_EVIDENCE = "MISSING_EVIDENCE";

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function immutableSha(value) {
  return nonEmpty(value) && /^[0-9a-f]{40}$/iu.test(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safetyEnvelope() {
  return Object.freeze({
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    executionAuthority: "NONE",
  });
}

function timeframeMs(timeframe) {
  const match = typeof timeframe === "string" ? /^(\d+)(m|h|d)$/iu.exec(timeframe.trim()) : null;
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Number(match[1]) * multiplier;
}

function exactExitHorizon(sample, candidate) {
  const explicit = candidate?.signal?.expiresAtMs;
  if (explicit != null && (!Number.isSafeInteger(explicit) || explicit <= sample.identity.evaluatedAtMs)) {
    throw new Error("PAPER_POSITION_EXIT_HORIZON_INVALID");
  }
  if (Number.isSafeInteger(explicit) && explicit > sample.identity.evaluatedAtMs) {
    return Object.freeze({ expiresAtMs: explicit, source: "signal.expiresAtMs" });
  }
  const intervalMs = timeframeMs(sample.identity.timeframe);
  if (!Number.isSafeInteger(intervalMs) || !Number.isSafeInteger(sample.identity.horizon)) {
    return Object.freeze({ expiresAtMs: null, source: MISSING_EVIDENCE });
  }
  return Object.freeze({
    expiresAtMs: sample.identity.evaluatedAtMs + (intervalMs * sample.identity.horizon),
    source: "immutable sample timeframe x horizon",
  });
}

function optionalCanonicalPrice(value, field) {
  if (value == null) return null;
  if (!positive(value)) throw new Error(`PAPER_POSITION_${field}_INVALID`);
  return value;
}

function normalizeSampleClass(candidate) {
  const evidence = candidate?.naturalEvidence;
  if (candidate?.testOnly === true || evidence?.provenanceClass === TEST_ONLY) return TEST_ONLY;
  if (evidence?.provenanceClass === NATURAL_FORWARD
    && evidence.synthetic === false
    && evidence.replay === false
    && evidence.testOnly === false
    && nonEmpty(evidence.observationId)
    && nonEmpty(evidence.source)
    && finite(evidence.observedAtMs)) return NATURAL_FORWARD;
  return MISSING_EVIDENCE;
}

function positionIdentity(position) {
  return Object.freeze({
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    signalId: position.signalId,
    market: position.market,
    symbol: position.symbol,
    direction: position.direction,
    strategyId: position.strategyId,
    strategyVersion: position.strategyVersion,
    parameterHash: position.parameterHash,
    researchCodeSha: position.researchCodeSha,
    costPolicyVersion: position.costPolicyVersion,
  });
}

function validatePositionIdentity(identity) {
  for (const key of [
    "positionId", "paperSampleId", "signalId", "market", "symbol", "direction",
    "strategyId", "strategyVersion", "parameterHash", "costPolicyVersion",
  ]) {
    if (!nonEmpty(identity?.[key])) throw new Error(`PAPER_POSITION_${key.toUpperCase()}_REQUIRED`);
  }
  if (!immutableSha(identity.researchCodeSha)) throw new Error("PAPER_POSITION_RESEARCH_SHA_REQUIRED");
}

function immutableContractDigest(lifecycle) {
  return hash({
    identity: lifecycle.identity,
    strategyIdentity: lifecycle.strategyIdentity,
    modelIdentity: lifecycle.modelIdentity,
    modelIdentityStatus: lifecycle.modelIdentityStatus,
    entry: lifecycle.entry,
    exitPolicy: lifecycle.exitPolicy,
    sampleEligibility: lifecycle.sampleEligibility,
  });
}

function assertLifecycle(position) {
  const lifecycle = position?.lifecycle;
  if (lifecycle?.schemaVersion !== NATURAL_PAPER_POSITION_SETTLEMENT_LIFECYCLE_VERSION) {
    throw new Error("PAPER_POSITION_LIFECYCLE_REQUIRED");
  }
  const identity = positionIdentity(position);
  validatePositionIdentity(identity);
  if (lifecycle.status !== OPEN || position.lifecycleState !== OPEN) {
    throw new Error("PAPER_POSITION_NOT_OPEN");
  }
  if (lifecycle.identityDigest !== hash(identity)) throw new Error("PAPER_POSITION_IDENTITY_DIGEST_MISMATCH");
  if (lifecycle.immutableContractDigest !== immutableContractDigest(lifecycle)) {
    throw new Error("PAPER_POSITION_IMMUTABLE_CONTRACT_DIGEST_MISMATCH");
  }
  if (!positive(lifecycle.entry?.fillPrice) || !positive(lifecycle.entry?.quantity)) {
    throw new Error("PAPER_POSITION_ENTRY_FILL_INVALID");
  }
  if (!Number.isSafeInteger(lifecycle.entry?.timestampMs)) throw new Error("PAPER_POSITION_ENTRY_TIME_REQUIRED");
  if (lifecycle.entry.timestampMs !== position.entryTimestampMs
    || lifecycle.entry.fillPrice !== position.entryFillPrice
    || lifecycle.entry.quantity !== position.quantity
    || lifecycle.strategyIdentity.strategyId !== position.strategyId
    || lifecycle.strategyIdentity.strategyVersion !== position.strategyVersion
    || lifecycle.strategyIdentity.parameterHash !== position.parameterHash
    || lifecycle.strategyIdentity.researchCodeSha !== position.researchCodeSha.toLowerCase()) {
    throw new Error("PAPER_POSITION_IMMUTABLE_LINEAGE_MISMATCH");
  }
  return lifecycle;
}

function priceRules(direction, exitPolicy, bar) {
  const long = direction === "BUY" || direction === "LONG";
  const short = direction === "SHORT";
  if (!long && !short) throw new Error("PAPER_POSITION_DIRECTION_UNSUPPORTED");

  const stop = exitPolicy.stopLossPrice;
  const targets = exitPolicy.takeProfitPrices.filter(positive);
  const stopHit = positive(stop) && (long ? bar.low <= stop : bar.high >= stop);
  const hitTargets = targets.filter((target) => long ? bar.high >= target : bar.low <= target);
  if (stopHit) return Object.freeze({ reason: "STOP_LOSS", type: "STOP_MARKET", price: stop });
  if (hitTargets.length > 0) {
    const price = long ? Math.min(...hitTargets) : Math.max(...hitTargets);
    return Object.freeze({ reason: "TAKE_PROFIT", type: "LIMIT", price });
  }
  return null;
}

function validateObservation(position, observation, evaluatedAtMs) {
  const identity = positionIdentity(position);
  if (!nonEmpty(observation?.observationId)) throw new Error("PAPER_POSITION_OBSERVATION_ID_REQUIRED");
  if (observation.positionId !== identity.positionId || observation.paperSampleId !== identity.paperSampleId) {
    throw new Error("PAPER_POSITION_OBSERVATION_POSITION_MISMATCH");
  }
  for (const key of ["market", "symbol", "direction", "strategyId", "strategyVersion", "parameterHash", "costPolicyVersion"]) {
    if (observation[key] !== identity[key]) throw new Error(`PAPER_POSITION_OBSERVATION_${key.toUpperCase()}_MISMATCH`);
  }
  if (!immutableSha(observation.researchCodeSha)
    || observation.researchCodeSha.toLowerCase() !== identity.researchCodeSha.toLowerCase()) {
    throw new Error("PAPER_POSITION_OBSERVATION_RESEARCH_SHA_MISMATCH");
  }
  if (observation.publicOnly !== true || !nonEmpty(observation.source) || !nonEmpty(observation.provenance)) {
    throw new Error("PAPER_POSITION_PUBLIC_PROVENANCE_REQUIRED");
  }
  if (!Number.isSafeInteger(observation.observedAtMs)
    || observation.observedAtMs <= position.entryTimestampMs
    || observation.observedAtMs > evaluatedAtMs) {
    throw new Error("PAPER_POSITION_OBSERVATION_TIME_INVALID");
  }
  if (!finite(observation.maxAgeMs) || observation.maxAgeMs <= 0
    || evaluatedAtMs - observation.observedAtMs > observation.maxAgeMs) {
    throw new Error("PAPER_POSITION_OBSERVATION_STALE");
  }
  const bar = observation.bar;
  if (!positive(bar?.open) || !positive(bar?.high) || !positive(bar?.low) || !positive(bar?.close)
    || bar.high < bar.low || bar.open > bar.high || bar.open < bar.low || bar.close > bar.high || bar.close < bar.low) {
    throw new Error("PAPER_POSITION_MARK_BAR_INVALID");
  }
}

function observationSampleClass(observation) {
  const evidence = observation?.naturalEvidence;
  return evidence?.provenanceClass === NATURAL_FORWARD
    && evidence.synthetic === false
    && evidence.replay === false
    && evidence.testOnly === false
    && nonEmpty(evidence.observationId)
    && evidence.observationId === observation.observationId
    && nonEmpty(evidence.source)
    && nonEmpty(evidence.provenance)
    && evidence.observedAtMs === observation.observedAtMs
    ? NATURAL_FORWARD
    : evidence?.provenanceClass === TEST_ONLY ? TEST_ONLY : MISSING_EVIDENCE;
}

function excursion(position, bar, current) {
  const long = position.direction === "BUY" || position.direction === "LONG";
  const sign = long ? 1 : -1;
  const favorablePrice = long ? bar.high : bar.low;
  const adversePrice = long ? bar.low : bar.high;
  const favorable = ((favorablePrice - position.entryFillPrice) / position.entryFillPrice) * sign * 100;
  const adverse = ((adversePrice - position.entryFillPrice) / position.entryFillPrice) * sign * 100;
  return Object.freeze({
    mfePercent: current.mfePercent == null ? favorable : Math.max(current.mfePercent, favorable),
    maePercent: current.maePercent == null ? adverse : Math.min(current.maePercent, adverse),
  });
}

function settlementEvidenceBlockers(position, observation, evaluatedAtMs) {
  const blockers = [];
  const cost = observation?.settlementCostEvidence;
  const componentNames = ["fees", "spread", "slippage", "funding", "latency", "liquidityImpact", "partialFillImpact"];
  const maximumAgeMs = observation?.maxAgeMs;
  const completeComponents = componentNames.every((name) => {
    const component = cost?.components?.[name];
    return component?.state === "PRESENT"
      && component.countsAsExecutionCost === true
      && finite(component.value)
      && nonEmpty(component.unit)
      && nonEmpty(component.quality)
      && nonEmpty(component.source)
      && finite(component.observedAtMs)
      && component.observedAtMs <= evaluatedAtMs
      && finite(maximumAgeMs)
      && evaluatedAtMs - component.observedAtMs <= maximumAgeMs;
  });
  if (!nonEmpty(cost?.schemaVersion)
    || cost?.status !== "PRESENT"
    || cost?.fullCostReady !== true
    || cost?.unknownIsZero !== false
    || cost?.unavailableCostConvertedToZero !== false
    || cost?.supplementalCostInput?.costPolicyId !== position.costPolicyVersion
    || !completeComponents) {
    blockers.push("PAPER_POSITION_SETTLEMENT_COST_EVIDENCE_MISSING");
  }
  const funding = observation?.settlementInput?.fundingEvidence;
  if (funding?.complete !== true || !Array.isArray(funding?.payments)) {
    blockers.push("PAPER_POSITION_FUNDING_EVIDENCE_MISSING");
  }
  if (!observation?.settlementInput?.exitExecution) blockers.push("PAPER_POSITION_EXIT_EXECUTION_EVIDENCE_MISSING");
  return blockers;
}

export function createNaturalPaperPositionLifecycle({ position, sample, candidate } = {}) {
  if (sample?.status !== OPEN || !position || typeof position !== "object") {
    throw new Error("PAPER_POSITION_OPEN_SAMPLE_REQUIRED");
  }
  const identity = positionIdentity(position);
  validatePositionIdentity(identity);
  if (sample.identity?.symbol !== identity.symbol
    || sample.identity?.market !== identity.market
    || sample.identity?.executionDirection !== identity.direction
    || sample.identity?.researchCodeSha?.toLowerCase() !== identity.researchCodeSha.toLowerCase()) {
    throw new Error("PAPER_POSITION_ENTRY_LINEAGE_MISMATCH");
  }
  const horizon = exactExitHorizon(sample, candidate);
  const snapshot = candidate?.signal?.learningSnapshot;
  const takeProfitPrices = [
    optionalCanonicalPrice(snapshot?.target1, "TARGET1"),
    optionalCanonicalPrice(snapshot?.target2, "TARGET2"),
  ].filter(positive);
  const sameBarPolicy = candidate?.execution?.executionPolicy?.sameBarPolicy;
  if (sameBarPolicy !== "STOP_FIRST") throw new Error("PAPER_POSITION_SAME_BAR_POLICY_UNSUPPORTED");
  const sampleClass = normalizeSampleClass(candidate);
  const entry = Object.freeze({
    timestampMs: sample.identity.evaluatedAtMs,
    signalTimestampMs: candidate?.signal?.timestampMs ?? null,
    fillPrice: sample.fill.fillPrice,
    quantity: sample.fill.filledQuantity,
    fillStatus: sample.fill.status,
    evidenceProvenance: deepFreeze(structuredClone(sample.entryEvidenceProvenance)),
    evidenceDigest: sample.entryEvidenceProvenance?.evidenceSnapshotDigest ?? null,
  });
  const strategyIdentity = Object.freeze({
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    researchCodeSha: identity.researchCodeSha.toLowerCase(),
  });
  const modelIdentity = candidate?.signal?.modelIdentity
    ? deepFreeze(structuredClone(candidate.signal.modelIdentity))
    : null;
  const exitPolicy = Object.freeze({
    sameBarPolicy,
    expiresAtMs: horizon.expiresAtMs,
    horizonSource: horizon.source,
    stopLossPrice: optionalCanonicalPrice(snapshot?.stopLoss, "STOP_LOSS"),
    takeProfitPrices: Object.freeze(takeProfitPrices),
    invalidationPolicyId: nonEmpty(candidate?.signal?.invalidationPolicyId) ? candidate.signal.invalidationPolicyId : null,
  });
  const sampleEligibility = Object.freeze({
    provenanceClass: sampleClass,
    entryObservationId: sampleClass === NATURAL_FORWARD ? candidate.naturalEvidence.observationId : null,
    naturalSampleCredit: 0,
    testOnlySampleCredit: 0,
  });
  const immutableContract = {
    identity: Object.freeze(identity),
    strategyIdentity,
    modelIdentity,
    modelIdentityStatus: modelIdentity ? "PRESENT" : MISSING_EVIDENCE,
    entry,
    exitPolicy,
    sampleEligibility,
  };
  return Object.freeze({
    schemaVersion: NATURAL_PAPER_POSITION_SETTLEMENT_LIFECYCLE_VERSION,
    status: OPEN,
    ...immutableContract,
    identityDigest: hash(identity),
    immutableContractDigest: immutableContractDigest(immutableContract),
    mark: Object.freeze({
      lastObservedAtMs: null,
      lastPrice: null,
      observationCount: 0,
      mfePercent: null,
      maePercent: null,
    }),
    processedObservationIds: Object.freeze([]),
    pathBars: Object.freeze([]),
    pendingExit: null,
    ...safetyEnvelope(),
  });
}

export function advanceNaturalPaperPositionLifecycle({ position, observation, evaluatedAtMs } = {}) {
  const lifecycle = assertLifecycle(position);
  if (!Number.isSafeInteger(evaluatedAtMs)) throw new Error("PAPER_POSITION_EVALUATED_AT_REQUIRED");
  validateObservation(position, observation, evaluatedAtMs);
  if (lifecycle.processedObservationIds.includes(observation.observationId)) {
    return Object.freeze({ status: "DUPLICATE_OBSERVATION", blocker: "DUPLICATE_POSITION_OBSERVATION", position });
  }
  if (lifecycle.mark.lastObservedAtMs != null && observation.observedAtMs <= lifecycle.mark.lastObservedAtMs) {
    throw new Error("PAPER_POSITION_OBSERVATION_ORDER_INVALID");
  }

  const excursions = excursion(position, observation.bar, lifecycle.mark);
  let nextLifecycle = Object.freeze({
    ...lifecycle,
    mark: Object.freeze({
      lastObservedAtMs: observation.observedAtMs,
      lastPrice: observation.bar.close,
      observationCount: lifecycle.mark.observationCount + 1,
      ...excursions,
    }),
    processedObservationIds: Object.freeze([...lifecycle.processedObservationIds, observation.observationId]),
    pathBars: Object.freeze([...lifecycle.pathBars, Object.freeze({
      timestampMs: observation.observedAtMs,
      high: observation.bar.high,
      low: observation.bar.low,
    })]),
  });

  let exit = lifecycle.pendingExit ?? priceRules(position.direction, lifecycle.exitPolicy, observation.bar);
  const invalidation = observation.invalidationEvidence;
  if (!exit && invalidation?.invalidated === true) {
    if (!nonEmpty(lifecycle.exitPolicy.invalidationPolicyId)
      || invalidation.policyId !== lifecycle.exitPolicy.invalidationPolicyId
      || invalidation.status !== "PRESENT"
      || !nonEmpty(invalidation.source)
      || !nonEmpty(invalidation.provenance)
      || invalidation.observedAtMs !== observation.observedAtMs) {
      throw new Error("PAPER_POSITION_INVALIDATION_EVIDENCE_MISMATCH");
    }
    exit = Object.freeze({ reason: "INVALIDATION", type: "MARKET", price: null });
  }
  if (!exit && Number.isSafeInteger(lifecycle.exitPolicy.expiresAtMs)
    && observation.observedAtMs >= lifecycle.exitPolicy.expiresAtMs) {
    exit = Object.freeze({ reason: "TIMEOUT", type: "MARKET", price: null });
  }
  if (exit && lifecycle.pendingExit == null) {
    nextLifecycle = Object.freeze({
      ...nextLifecycle,
      pendingExit: Object.freeze({ ...exit, triggeredAtMs: observation.observedAtMs }),
    });
  }
  const updatedPosition = Object.freeze({ ...position, lifecycle: nextLifecycle });
  if (!exit) return Object.freeze({ status: "HOLD", position: updatedPosition, exitReason: null });

  const blockers = settlementEvidenceBlockers(position, observation, evaluatedAtMs);
  if (blockers.length > 0) {
    return Object.freeze({
      status: "BLOCKED_SETTLEMENT_EVIDENCE",
      position: updatedPosition,
      exitReason: exit.reason,
      blockers: Object.freeze(blockers),
    });
  }
  const observedClass = observationSampleClass(observation);
  const naturalSampleCredit = lifecycle.sampleEligibility.provenanceClass === NATURAL_FORWARD
    && observedClass === NATURAL_FORWARD ? 1 : 0;
  const settlementInput = {
    ...structuredClone(observation.settlementInput),
    exitOrderType: exit.type,
    pathBars: [...(observation.settlementInput.pathBars ?? []), ...nextLifecycle.pathBars]
      .filter((bar, index, rows) => rows.findIndex((candidate) => candidate.timestampMs === bar.timestampMs
        && candidate.high === bar.high && candidate.low === bar.low) === index),
  };
  if (exit.type === "LIMIT") settlementInput.exitLimitPrice = exit.price;
  if (exit.type === "STOP_MARKET") settlementInput.exitStopPrice = exit.price;
  return Object.freeze({
    status: "EXIT_ELIGIBLE",
    position: updatedPosition,
    exitReason: exit.reason,
    settlementInput: Object.freeze(settlementInput),
    evidence: Object.freeze({
      observationId: observation.observationId,
      observedAtMs: observation.observedAtMs,
      source: observation.source,
      provenance: observation.provenance,
      costEvidence: deepFreeze(structuredClone(observation.settlementCostEvidence)),
      naturalSampleCredit,
      testOnlySampleCredit: 0,
      executionAuthority: "NONE",
      orderSubmitted: false,
    }),
  });
}

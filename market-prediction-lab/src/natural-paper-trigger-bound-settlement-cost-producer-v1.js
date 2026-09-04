import { createHash } from "node:crypto";

export const NATURAL_PAPER_TRIGGER_BOUND_SETTLEMENT_COST_PRODUCER_VERSION =
  "natural-paper-trigger-bound-settlement-cost-producer-v1";

export const AUTHORITATIVE_NATURAL_PAPER_TRIGGER_SETTLEMENT_EVIDENCE_VERSION =
  "authoritative-natural-paper-trigger-settlement-evidence-v1";

const NATURAL_FORWARD = "NATURAL_FORWARD";
const CANONICALLY_BOUND_OBSERVATIONS = new WeakSet();
const COST_COMPONENTS = Object.freeze([
  "commission", "tax", "spread", "slippage", "funding", "latency", "liquidityImpact", "partialFillImpact",
]);

function stableSerialize(value, seen = new WeakSet()) {
  if (value && typeof value === "object") {
    if (seen.has(value)) throw new TypeError("cyclic evidence is forbidden");
    seen.add(value);
  }
  if (Array.isArray(value)) {
    const serialized = `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  if (value && typeof value === "object") {
    const serialized = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`).join(",")}}`;
    seen.delete(value);
    return serialized;
  }
  return JSON.stringify(value) ?? "undefined";
}

function hash(value) {
  try {
    return createHash("sha256").update(stableSerialize(value)).digest("hex");
  } catch {
    return null;
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function digest(value) {
  return nonEmpty(value) && /^[0-9a-f]{64}$/iu.test(value);
}

function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function safeTime(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function unique(values) {
  return [...new Set(values)];
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

function blocked(blockers) {
  return deepFreeze({
    schemaVersion: NATURAL_PAPER_TRIGGER_BOUND_SETTLEMENT_COST_PRODUCER_VERSION,
    status: "BLOCKED_DATA",
    fullCostReady: false,
    blockers: unique(blockers),
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
    naturalSampleCredit: 0,
    ...safetyEnvelope(),
  });
}

function positionIdentity(position) {
  return {
    positionId: position?.positionId,
    paperSampleId: position?.paperSampleId,
    signalId: position?.signalId,
    market: position?.market,
    symbol: position?.symbol,
    direction: position?.direction,
    strategyId: position?.strategyId,
    strategyVersion: position?.strategyVersion,
    parameterHash: position?.parameterHash,
    researchCodeSha: position?.researchCodeSha,
    costPolicyVersion: position?.costPolicyVersion,
  };
}

function exitExecutionIdentity(position, trigger, sourceIdentity, provenanceId, exitExecutionDigest) {
  return {
    exitTriggerId: trigger?.exitTriggerId,
    triggerObservationId: trigger?.triggerObservationId,
    triggeredAtMs: trigger?.triggeredAtMs,
    positionId: position?.positionId,
    paperSampleId: position?.paperSampleId,
    market: position?.market,
    symbol: position?.symbol,
    direction: position?.direction,
    costPolicyVersion: position?.costPolicyVersion,
    sourceIdentity,
    provenanceId,
    exitExecutionDigest,
  };
}

function triggerIdentityValid(position, trigger) {
  if (!trigger || typeof trigger !== "object" || !digest(trigger.exitTriggerId)) return false;
  const { exitTriggerId, ...payload } = trigger;
  return exitTriggerId === hash(payload)
    && trigger.positionId === position?.positionId
    && trigger.paperSampleId === position?.paperSampleId
    && trigger.costPolicyVersion === position?.costPolicyVersion
    && trigger.positionLifecycleDigest === position?.lifecycle?.immutableContractDigest;
}

function same(left, right) {
  const leftDigest = hash(left);
  const rightDigest = hash(right);
  return digest(leftDigest) && digest(rightDigest) && leftDigest === rightDigest;
}

function evidenceReplayBlockers(evidence) {
  const blockers = [];
  for (const [field, code] of [
    ["synthetic", "SYNTHETIC"],
    ["replay", "REPLAY"],
    ["backfill", "BACKFILL"],
    ["duplicate", "DUPLICATE"],
    ["historical", "HISTORICAL"],
    ["testOnly", "TEST_ONLY"],
  ]) {
    if (evidence?.[field] !== false) blockers.push(`PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_${code}_EVIDENCE_FORBIDDEN`);
  }
  return blockers;
}

function componentIdentityBlockers({ component, name, expectedPosition, expectedExecution, evaluatedAtMs, maximumAgeMs }) {
  const blockers = [];
  const code = name.toUpperCase();
  if (!nonEmpty(component?.sourceIdentity) || !digest(component?.provenanceId)) {
    blockers.push(`PAPER_POSITION_SETTLEMENT_${code}_SOURCE_IDENTITY_MISSING`);
  }
  if (!same(component?.positionIdentity, expectedPosition)) {
    blockers.push(`PAPER_POSITION_SETTLEMENT_${code}_POSITION_IDENTITY_MISMATCH`);
  }
  if (!same(component?.exitExecutionIdentity, expectedExecution)) {
    blockers.push(`PAPER_POSITION_SETTLEMENT_${code}_EXIT_EXECUTION_IDENTITY_MISMATCH`);
  }
  const freshness = component?.freshness;
  if (!safeTime(component?.observedAtMs)
    || freshness?.observedAtMs !== component.observedAtMs
    || !positive(freshness?.maximumAgeMs)
    || freshness.maximumAgeMs > maximumAgeMs
    || component.observedAtMs > evaluatedAtMs
    || evaluatedAtMs - component.observedAtMs > freshness.maximumAgeMs) {
    blockers.push(`PAPER_POSITION_SETTLEMENT_${code}_FRESHNESS_IDENTITY_MISMATCH`);
  }
  return blockers;
}

function bindingBlockers({ position, observation, trigger, evaluatedAtMs }) {
  const blockers = [];
  const binding = observation?.triggerBoundSettlementEvidence;
  const input = observation?.settlementInput;
  const cost = observation?.settlementCostEvidence;
  if (!triggerIdentityValid(position, trigger)) {
    blockers.push("PAPER_POSITION_EXIT_TRIGGER_IDENTITY_MISMATCH");
  }
  if (!observation || typeof observation !== "object" || !CANONICALLY_BOUND_OBSERVATIONS.has(observation)) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_CANONICAL_PRODUCER_REQUIRED");
  }
  if (binding?.schemaVersion !== NATURAL_PAPER_TRIGGER_BOUND_SETTLEMENT_COST_PRODUCER_VERSION
    || binding?.status !== "PRESENT"
    || binding?.fullCostReady !== true
    || binding?.unknownIsZero !== false
    || binding?.unavailableCostConvertedToZero !== false
    || binding?.executionAuthority !== "NONE"
    || binding?.liveOrderAllowed !== false
    || binding?.privateTradingApiAllowed !== false
    || binding?.orderSubmitted !== false
    || binding?.exchangeRequestSent !== false) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_BINDING_MISSING");
  }
  if (!nonEmpty(binding?.sourceIdentity) || !digest(binding?.provenanceId)) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_SOURCE_IDENTITY_MISSING");
  }
  const expectedPosition = positionIdentity(position);
  const expectedExecution = exitExecutionIdentity(
    position,
    trigger,
    binding?.sourceIdentity,
    binding?.provenanceId,
    hash(input?.exitExecution),
  );
  if (!digest(expectedExecution.exitExecutionDigest)) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_EXIT_EXECUTION_IDENTITY_MISMATCH");
  }
  if (!same(binding?.positionIdentity, expectedPosition)) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_POSITION_IDENTITY_MISMATCH");
  }
  if (!same(binding?.exitExecutionIdentity, expectedExecution)) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_EXIT_EXECUTION_IDENTITY_MISMATCH");
  }
  const freshness = binding?.freshness;
  if (!safeTime(freshness?.observedAtMs) || !positive(freshness?.maximumAgeMs)
    || freshness.maximumAgeMs > observation?.maxAgeMs
    || freshness.observedAtMs > evaluatedAtMs
    || evaluatedAtMs - freshness.observedAtMs > freshness.maximumAgeMs) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_EVIDENCE_STALE");
  }
  if (binding?.exitTriggerId !== trigger?.exitTriggerId
    || input?.exitTriggerId !== trigger?.exitTriggerId
    || cost?.exitTriggerId !== trigger?.exitTriggerId) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_EXIT_TRIGGER_MISMATCH");
  }
  const settlementInputDigest = hash(input);
  const settlementCostEvidenceDigest = hash(cost);
  if (!digest(settlementInputDigest) || !digest(settlementCostEvidenceDigest)
    || binding?.settlementInputDigest !== settlementInputDigest
    || binding?.settlementCostEvidenceDigest !== settlementCostEvidenceDigest) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_PAYLOAD_DIGEST_MISMATCH");
  }
  const bindingPayload = {
    schemaVersion: binding?.schemaVersion,
    exitTriggerId: binding?.exitTriggerId,
    sourceIdentity: binding?.sourceIdentity,
    provenanceId: binding?.provenanceId,
    positionIdentity: binding?.positionIdentity,
    exitExecutionIdentity: binding?.exitExecutionIdentity,
    freshness: binding?.freshness,
    settlementInputDigest: binding?.settlementInputDigest,
    settlementCostEvidenceDigest: binding?.settlementCostEvidenceDigest,
  };
  const bindingDigest = hash(bindingPayload);
  if (!digest(bindingDigest) || binding?.evidenceDigest !== bindingDigest) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_BINDING_DIGEST_MISMATCH");
  }
  if (!same(cost?.positionIdentity, expectedPosition)
    || !same(cost?.exitExecutionIdentity, expectedExecution)
    || cost?.sourceIdentity !== binding?.sourceIdentity
    || cost?.provenanceId !== binding?.provenanceId) {
    blockers.push("PAPER_POSITION_SETTLEMENT_COST_ENVELOPE_IDENTITY_MISMATCH");
  }
  const maximumAgeMs = cost?.maximumAgeMs;
  if (!positive(maximumAgeMs) || maximumAgeMs > observation?.maxAgeMs) {
    blockers.push("PAPER_POSITION_SETTLEMENT_COST_FRESHNESS_IDENTITY_MISMATCH");
  }
  for (const name of COST_COMPONENTS) {
    blockers.push(...componentIdentityBlockers({
      component: cost?.components?.[name],
      name,
      expectedPosition,
      expectedExecution,
      evaluatedAtMs,
      maximumAgeMs,
    }));
  }
  const funding = cost?.components?.funding;
  if (cost?.projectedFundingRealized !== false || funding?.projectedIsRealized !== false
    || funding?.evidenceClass === "PROJECTED_COMPONENT"
    || (position?.market === "CRYPTO_FUTURES" && funding?.realized !== true)) {
    blockers.push("PAPER_POSITION_PROJECTED_FUNDING_REALIZATION_FORBIDDEN");
  }
  if (position?.market !== "CRYPTO_FUTURES" && funding?.realized !== false) {
    blockers.push("PAPER_POSITION_NON_FUTURES_FUNDING_REALIZATION_MISMATCH");
  }
  return unique(blockers);
}

export function validateNaturalPaperTriggerBoundSettlementEvidence({
  position,
  observation,
  trigger = position?.lifecycle?.pendingExit,
  evaluatedAtMs,
} = {}) {
  const blockers = bindingBlockers({ position, observation, trigger, evaluatedAtMs });
  return deepFreeze({
    schemaVersion: NATURAL_PAPER_TRIGGER_BOUND_SETTLEMENT_COST_PRODUCER_VERSION,
    status: blockers.length === 0 ? "PRESENT" : "BLOCKED_DATA",
    fullCostReady: blockers.length === 0,
    blockers,
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
    naturalSampleCredit: 0,
    ...safetyEnvelope(),
  });
}

export function bindNaturalPaperTriggerBoundSettlementEvidence({
  position,
  observation,
  authoritativeEvidence,
  evaluatedAtMs,
} = {}) {
  const trigger = position?.lifecycle?.pendingExit;
  const blockers = [];
  if (!triggerIdentityValid(position, trigger)) blockers.push("PAPER_POSITION_EXIT_TRIGGER_IDENTITY_MISMATCH");
  if (!safeTime(evaluatedAtMs)) blockers.push("PAPER_POSITION_EVALUATED_AT_REQUIRED");
  if (authoritativeEvidence?.schemaVersion !== AUTHORITATIVE_NATURAL_PAPER_TRIGGER_SETTLEMENT_EVIDENCE_VERSION
    || authoritativeEvidence?.status !== "PRESENT"
    || authoritativeEvidence?.fullCostReady !== true
    || authoritativeEvidence?.unknownIsZero !== false
    || authoritativeEvidence?.unavailableCostConvertedToZero !== false
    || authoritativeEvidence?.executionAuthority !== "NONE"
    || authoritativeEvidence?.liveOrderAllowed !== false
    || authoritativeEvidence?.privateTradingApiAllowed !== false
    || authoritativeEvidence?.orderSubmitted !== false
    || authoritativeEvidence?.exchangeRequestSent !== false) {
    blockers.push("PAPER_POSITION_AUTHORITATIVE_SETTLEMENT_EVIDENCE_MISSING");
  }
  blockers.push(...evidenceReplayBlockers(authoritativeEvidence));
  const sourceIdentity = authoritativeEvidence?.sourceIdentity;
  const provenanceId = authoritativeEvidence?.provenanceId;
  if (!nonEmpty(sourceIdentity) || !digest(provenanceId)) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_SOURCE_IDENTITY_MISSING");
  }
  const input = authoritativeEvidence?.settlementInput;
  const cost = authoritativeEvidence?.settlementCostEvidence;
  const expectedPosition = positionIdentity(position);
  const expectedExecution = exitExecutionIdentity(
    position,
    trigger,
    sourceIdentity,
    provenanceId,
    hash(input?.exitExecution),
  );
  if (!digest(expectedExecution.exitExecutionDigest)) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_EXIT_EXECUTION_IDENTITY_MISMATCH");
  }
  if (!same(authoritativeEvidence?.positionIdentity, expectedPosition)) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_POSITION_IDENTITY_MISMATCH");
  }
  if (!same(authoritativeEvidence?.exitExecutionIdentity, expectedExecution)) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_EXIT_EXECUTION_IDENTITY_MISMATCH");
  }
  const freshness = authoritativeEvidence?.freshness;
  if (!safeTime(freshness?.observedAtMs) || !positive(freshness?.maximumAgeMs)
    || freshness.maximumAgeMs > observation?.maxAgeMs
    || freshness.observedAtMs > evaluatedAtMs
    || evaluatedAtMs - freshness.observedAtMs > freshness.maximumAgeMs) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_EVIDENCE_STALE");
  }
  if (input?.exitTriggerId !== trigger?.exitTriggerId
    || cost?.exitTriggerId !== trigger?.exitTriggerId) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_EXIT_TRIGGER_MISMATCH");
  }
  if (input?.exitBar?.timestampMs !== trigger?.triggeredAtMs
    || input?.exitBar?.open !== trigger?.bar?.open
    || input?.exitBar?.high !== trigger?.bar?.high
    || input?.exitBar?.low !== trigger?.bar?.low
    || input?.exitBar?.close !== trigger?.bar?.close) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_BAR_MISMATCH");
  }
  if (input?.exitExecution?.costPolicy?.version !== position?.costPolicyVersion) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_COST_POLICY_MISMATCH");
  }
  const settlementInputDigest = hash(input);
  const settlementCostEvidenceDigest = hash(cost);
  if (!digest(settlementInputDigest) || !digest(settlementCostEvidenceDigest)) {
    blockers.push("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_PAYLOAD_DIGEST_MISMATCH");
  }
  if (blockers.length > 0) return blocked(blockers);

  const settlementInput = structuredClone(input);
  const settlementCostEvidence = structuredClone(cost);
  const bindingPayload = {
    schemaVersion: NATURAL_PAPER_TRIGGER_BOUND_SETTLEMENT_COST_PRODUCER_VERSION,
    exitTriggerId: trigger.exitTriggerId,
    sourceIdentity,
    provenanceId,
    positionIdentity: expectedPosition,
    exitExecutionIdentity: expectedExecution,
    freshness: structuredClone(freshness),
    settlementInputDigest,
    settlementCostEvidenceDigest,
  };
  const triggerBoundSettlementEvidence = {
    ...bindingPayload,
    status: "PRESENT",
    fullCostReady: true,
    evidenceDigest: hash(bindingPayload),
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
    naturalSampleCredit: 0,
    ...safetyEnvelope(),
  };
  const boundObservation = deepFreeze({
    ...structuredClone(observation),
    settlementInput,
    settlementCostEvidence,
    triggerBoundSettlementEvidence,
  });
  CANONICALLY_BOUND_OBSERVATIONS.add(boundObservation);
  const validation = validateNaturalPaperTriggerBoundSettlementEvidence({
    position,
    observation: boundObservation,
    trigger,
    evaluatedAtMs,
  });
  if (validation.status !== "PRESENT") return blocked(validation.blockers);
  return deepFreeze({
    schemaVersion: NATURAL_PAPER_TRIGGER_BOUND_SETTLEMENT_COST_PRODUCER_VERSION,
    status: "PRESENT",
    fullCostReady: true,
    observation: boundObservation,
    exitTriggerId: trigger.exitTriggerId,
    evidenceDigest: triggerBoundSettlementEvidence.evidenceDigest,
    blockers: [],
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
    naturalSampleCredit: 0,
    ...safetyEnvelope(),
  });
}

export function createNaturalPaperTriggerBoundSettlementCostProducer({ collectAuthoritativeEvidence } = {}) {
  if (typeof collectAuthoritativeEvidence !== "function") {
    throw new TypeError("authoritative Settlement evidence collector is required");
  }
  return async function produceTriggerBoundSettlementCost({ position, observation, evaluatedAtMs } = {}) {
    const trigger = position?.lifecycle?.pendingExit;
    if (!triggerIdentityValid(position, trigger)) return blocked(["PAPER_POSITION_EXIT_TRIGGER_IDENTITY_MISMATCH"]);
    let authoritativeEvidence;
    try {
      authoritativeEvidence = await collectAuthoritativeEvidence(deepFreeze({
        position: structuredClone(position),
        observation: structuredClone(observation),
        exitTrigger: structuredClone(trigger),
        evaluatedAtMs,
        ...safetyEnvelope(),
      }));
    } catch {
      return blocked(["PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_COST_PRODUCER_FAILED"]);
    }
    return bindNaturalPaperTriggerBoundSettlementEvidence({
      position,
      observation,
      authoritativeEvidence,
      evaluatedAtMs,
    });
  };
}

export const NATURAL_PAPER_TRIGGER_BOUND_SETTLEMENT_COST_PRODUCER_SAFETY = safetyEnvelope();

import { bindPhase4ChallengerToAdaptiveRuntimeOwnersV1 } from "./adaptive-multi-market-tournament-runtime-adapter-v1.js";
import { consumePhase4ExistingOwnerHandoffsV1 } from "./phase4-existing-owner-handoff-consumer-v1.js";
import { runPhase4ProspectiveResultRuntimeSourceV1 } from "./phase4-prospective-result-runtime-source-v1.js";

export const PHASE4_EXISTING_OWNER_RUNTIME_CALLER_CONTRACT_V1 = Object.freeze({
  version: "phase4-existing-owner-runtime-caller-v1",
  sourceContract: "phase4-prospective-result-runtime-source-v1",
  routeContract: "adaptive-tournament-phase4-owner-routing/v1",
  consumerContract: "phase4-existing-owner-handoff-consumer-v1",
  productionCallable: true,
  runtimeActivationAllowed: false,
  schedulerActivationAllowed: false,
  dispatchAllowed: false,
  economicCreditCreated: false,
  executionAuthority: "NONE",
});

const FORBIDDEN_OVERRIDE_KEYS = Object.freeze([
  "phase4Result",
  "sourceResult",
  "routed",
  "consumer",
  "consumerResult",
  "candidateId",
  "selectionPolicy",
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function truthLocks(extra = {}) {
  return deepFreeze({
    ...extra,
    runtimeActivationAllowed: false,
    schedulerActivationAllowed: false,
    dispatchAllowed: false,
    economicCreditCreated: false,
    sampleCredit: 0,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    CHAMPION: "NONE",
    executionAuthority: "NONE",
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    actualForwardHandoffs: 0,
    actualShadowHandoffs: 0,
    actualPaperHandoffs: 0,
    realOrderCount: 0,
  });
}

function blocked(firstZero, stage, { source = null, routed = null, consumer = null } = {}) {
  return truthLocks({
    schemaVersion: 1,
    contract: PHASE4_EXISTING_OWNER_RUNTIME_CALLER_CONTRACT_V1.version,
    status: "BLOCKED",
    stage,
    FIRST_ZERO: firstZero,
    reason: firstZero,
    source,
    phase4Result: source?.phase4Result ?? null,
    routed,
    consumer,
    actualOwnerCalls: Number.isSafeInteger(consumer?.actualOwnerCalls) ? consumer.actualOwnerCalls : 0,
    ownerContractAcceptances: Number.isSafeInteger(consumer?.ownerContractAcceptances)
      ? consumer.ownerContractAcceptances
      : 0,
    ownerPreflightOnly: consumer?.ownerPreflightOnly === true,
    testOnly: consumer?.testOnly === true,
  });
}

/**
 * Non-activating production-callable Phase4 orchestration seam.
 *
 * This caller only composes existing authoritative contracts:
 * Phase3 authoritative result source -> Phase4 frozen challenger -> runtime
 * identity binding / existing-owner routing -> existing owner consumer preflight.
 * It never schedules work, dispatches Forward/Shadow/Paper, persists state,
 * creates economic credit, or grants execution authority.
 */
export function runPhase4ExistingOwnerRuntimeCallerV1(input = {}) {
  if (!record(input)) {
    return blocked("PHASE4_EXISTING_OWNER_RUNTIME_CALLER_INPUT_INVALID", "INPUT");
  }
  if (FORBIDDEN_OVERRIDE_KEYS.some((key) => Object.hasOwn(input, key))) {
    return blocked("PHASE4_EXISTING_OWNER_RUNTIME_CALLER_OVERRIDE_REJECTED", "INPUT");
  }

  const source = runPhase4ProspectiveResultRuntimeSourceV1({
    authoritativePhase3Sources: input.authoritativePhase3Sources,
    freezeTimestamp: input.freezeTimestamp,
  });
  if (source?.status !== "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_READY" || !source.phase4Result) {
    return blocked(
      source?.FIRST_ZERO ?? "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_MISSING",
      "SOURCE",
      { source },
    );
  }

  const routed = bindPhase4ChallengerToAdaptiveRuntimeOwnersV1({
    phase4Result: source.phase4Result,
    runtimeStrategyIdentity: input.runtimeStrategyIdentity,
  });
  if (routed?.status !== "BOUND_TO_EXISTING_OWNERS_NON_ACTIVATING" || !routed.binding) {
    return blocked(
      routed?.FIRST_ZERO ?? "PHASE4_EXISTING_OWNER_ROUTE_INVALID",
      "ROUTE",
      { source, routed },
    );
  }

  const consumer = consumePhase4ExistingOwnerHandoffsV1({
    phase4Result: source.phase4Result,
    routed,
    ownerEvidence: input.ownerEvidence ?? {},
    ownerFunctions: input.ownerFunctions ?? null,
    testOnly: input.testOnly === true,
    paperNowMs: input.paperNowMs ?? Date.now(),
  });
  if (consumer?.status !== "EXISTING_OWNERS_CONNECTED_NON_ACTIVATING") {
    return blocked(
      consumer?.FIRST_ZERO ?? "PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_BLOCKED",
      "CONSUMER",
      { source, routed, consumer },
    );
  }

  return truthLocks({
    schemaVersion: 1,
    contract: PHASE4_EXISTING_OWNER_RUNTIME_CALLER_CONTRACT_V1.version,
    status: "PHASE4_EXISTING_OWNER_RUNTIME_CALLER_READY_NON_ACTIVATING",
    stage: "READY_NON_ACTIVATING",
    FIRST_ZERO: null,
    reason: null,
    source,
    phase4Result: source.phase4Result,
    routed,
    consumer,
    candidateId: source.candidateId,
    parameterDigest: source.parameterDigest,
    datasetIdentity: source.datasetIdentity,
    datasetDigest: source.datasetDigest,
    prospectiveBoundary: source.prospectiveBoundary,
    prospectiveBoundaryMs: source.prospectiveBoundaryMs,
    candidateIdentityPreserved: true,
    secondIdentityCreated: false,
    remapPerformed: false,
    rehashPerformed: false,
    fallbackIdentityUsed: false,
    actualOwnerCalls: consumer.actualOwnerCalls,
    ownerContractAcceptances: consumer.ownerContractAcceptances,
    ownerPreflightOnly: true,
    testOnly: consumer.testOnly === true,
  });
}

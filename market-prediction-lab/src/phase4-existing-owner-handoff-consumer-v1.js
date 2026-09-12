import {
  admitResearchSurvivorToShadowV1,
  createShadowForwardObservationV1,
  evaluateShadowSufficiencyV1,
} from "./autonomous-alpha-factory-phase3-v1.js";
import { resolveCanonicalPaperAdmissionBridgeCandidate } from "./canonical-paper-admission-bridge-v1.js";
import { resolveCanonicalStrategyIdentity } from "./canonical-strategy-identity-v1.js";

export const PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1 = Object.freeze({
  version: "phase4-existing-owner-handoff-consumer-v1",
  phase4RouteContract: "adaptive-tournament-phase4-owner-routing/v1",
  forwardOwner: "AUTONOMOUS_ALPHA_FACTORY_PHASE3_FORWARD_OWNER",
  shadowOwner: "AUTONOMOUS_ALPHA_FACTORY_PHASE3_SHADOW_OWNER",
  paperOwner: "CANONICAL_PAPER_ADMISSION_BRIDGE_V1",
  runtimeActivationAllowed: false,
  dispatchAllowed: false,
  economicCreditCreated: false,
  executionAuthority: "NONE",
});

const EXPECTED_OWNER_TARGETS = Object.freeze({
  forward: "CANONICAL_FORWARD_OWNER_CHAIN",
  shadow: "CANONICAL_SHADOW_OWNER",
  paper: "CANONICAL_PAPER_OWNER_CHAIN",
});

const DEFAULT_OWNER_FUNCTIONS = Object.freeze({
  shadowAdmission: admitResearchSurvivorToShadowV1,
  forwardObservation: createShadowForwardObservationV1,
  shadowSufficiency: evaluateShadowSufficiencyV1,
  paperAdmission: resolveCanonicalPaperAdmissionBridgeCandidate,
});

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function truthLocks(extra = {}) {
  return deepFreeze({
    ...extra,
    runtimeActivationAllowed: false,
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

function blocked(firstZero, extra = {}) {
  return truthLocks({
    schemaVersion: 1,
    contract: PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.version,
    status: "BLOCKED",
    FIRST_ZERO: firstZero,
    reason: firstZero,
    actualOwnerCalls: 0,
    ownerContractAcceptances: 0,
    ...extra,
  });
}

function validatePhase4Route({ phase4Result, routed }) {
  const result = record(phase4Result);
  const route = record(routed);
  const challenger = record(result?.challenger);
  if (result?.status !== "PROSPECTIVE_ADMISSION_READY" || challenger?.state !== "FROZEN_CHALLENGER") {
    return { ok: false, firstZero: "PHASE4_EXISTING_OWNER_RESULT_NOT_READY" };
  }
  if (route?.contract !== "adaptive-tournament-phase4-owner-routing/v1"
    || route.status !== "BOUND_TO_EXISTING_OWNERS_NON_ACTIVATING"
    || !record(route.binding)
    || !record(route.ownerRoutes)) {
    return { ok: false, firstZero: "PHASE4_EXISTING_OWNER_ROUTE_INVALID" };
  }
  if (route.binding.candidateId !== challenger.candidateId
    || route.binding.prospectiveBoundary !== challenger.prospectiveBoundary
    || route.binding.prospectiveBoundaryMs !== challenger.prospectiveBoundaryMs
    || route.candidateIdentityPreserved !== true
    || route.secondIdentityCreated !== false
    || route.remapPerformed !== false
    || route.rehashPerformed !== false
    || route.fallbackIdentityUsed !== false) {
    return { ok: false, firstZero: "PHASE4_EXISTING_OWNER_IDENTITY_CONTINUITY_INVALID" };
  }
  if (route.runtimeActivationAllowed !== false
    || route.dispatchAllowed !== false
    || route.economicCreditCreated !== false
    || route.executionAuthority !== "NONE") {
    return { ok: false, firstZero: "PHASE4_EXISTING_OWNER_SAFETY_ENVELOPE_INVALID" };
  }
  for (const [key, expectedTarget] of Object.entries(EXPECTED_OWNER_TARGETS)) {
    const ownerRoute = record(route.ownerRoutes[key]);
    if (!ownerRoute
      || ownerRoute.ownerTarget !== expectedTarget
      || ownerRoute.candidateId !== challenger.candidateId
      || ownerRoute.status !== "ROUTED_NON_ACTIVATING"
      || ownerRoute.activationAllowed !== false
      || ownerRoute.dispatchAllowed !== false
      || ownerRoute.economicCreditCreated !== false
      || ownerRoute.executionAuthority !== "NONE") {
      return { ok: false, firstZero: `PHASE4_EXISTING_${key.toUpperCase()}_OWNER_ROUTE_INVALID` };
    }
  }
  return { ok: true, challenger, route };
}

function validateCanonicalOwnerIdentity({ challenger, runtimeIdentity, strategyIdentity }) {
  const resolved = resolveCanonicalStrategyIdentity(strategyIdentity ?? {});
  if (resolved.status !== "IDENTITY_COMPLETE") {
    return {
      ok: false,
      firstZero: "PHASE4_EXISTING_OWNER_STRATEGY_IDENTITY_INCOMPLETE",
      details: { missingFields: resolved.missingFields, blockers: resolved.blockers },
    };
  }
  const identity = resolved.identity;
  const exact = [
    ["strategyId", runtimeIdentity?.strategyId, identity.strategyId],
    ["strategyFamily", runtimeIdentity?.strategyFamily, identity.strategyFamily],
    ["strategyVersion", runtimeIdentity?.strategyVersion, identity.strategyVersion],
    ["parameterHash", runtimeIdentity?.parameterHash, identity.parameterHash],
    ["researchCodeSha", runtimeIdentity?.researchCodeSha?.toLowerCase?.(), identity.researchCodeSha],
    ["costPolicyVersion", runtimeIdentity?.costPolicyVersion, identity.costPolicyVersion],
    ["market", challenger.market, identity.market],
    ["timeframe", challenger.timeframe, identity.timeframe],
    ["direction", challenger.sidePolicy, identity.direction],
  ];
  const mismatches = exact.filter(([, expected, actual]) => expected !== actual).map(([field]) => field);
  if (runtimeIdentity?.candidateId !== challenger.candidateId
    || runtimeIdentity?.parameterDigest !== challenger.parameterDigest
    || runtimeIdentity?.accountMode !== "PAPER") {
    mismatches.push("phase4RuntimeIdentity");
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      firstZero: "PHASE4_EXISTING_OWNER_STRATEGY_IDENTITY_MISMATCH",
      details: { mismatchedFields: [...new Set(mismatches)].sort() },
    };
  }
  return { ok: true, resolved };
}

function resolveOwnerFunctions({ ownerFunctions, testOnly }) {
  if (ownerFunctions == null) return { ok: true, owners: DEFAULT_OWNER_FUNCTIONS, testOnly: false };
  if (testOnly !== true || !record(ownerFunctions)) {
    return { ok: false, firstZero: "PHASE4_EXISTING_OWNER_OVERRIDE_FORBIDDEN" };
  }
  const keys = Object.keys(DEFAULT_OWNER_FUNCTIONS);
  if (keys.some((key) => typeof ownerFunctions[key] !== "function")) {
    return { ok: false, firstZero: "PHASE4_EXISTING_OWNER_OVERRIDE_INVALID" };
  }
  return { ok: true, owners: ownerFunctions, testOnly: true };
}

function paperIdentityMatches({ candidate, runtimeIdentity, challenger }) {
  const identity = candidate?.signal?.strategyIdentity;
  return record(identity)
    && identity.candidateId === challenger.candidateId
    && identity.strategyId === runtimeIdentity.strategyId
    && identity.strategyFamily === runtimeIdentity.strategyFamily
    && identity.strategyVersion === runtimeIdentity.strategyVersion
    && identity.parameterHash === challenger.parameterDigest
    && identity.parameterDigest === challenger.parameterDigest
    && identity.researchCodeSha?.toLowerCase?.() === runtimeIdentity.researchCodeSha.toLowerCase()
    && identity.costPolicyVersion === runtimeIdentity.costPolicyVersion
    && identity.accountMode === "PAPER";
}

/**
 * Pure, non-activating consumer seam from the merged Phase4 owner routes into
 * the already-owned Forward / Shadow / Paper validation contracts.
 *
 * This function never schedules work, dispatches a runtime, persists state, or
 * grants economic credit. Missing owner evidence is a blocker, never zero.
 */
export function consumePhase4ExistingOwnerHandoffsV1({
  phase4Result,
  routed,
  ownerEvidence = {},
  ownerFunctions = null,
  testOnly = false,
  paperNowMs = Date.now(),
} = {}) {
  const routeValidation = validatePhase4Route({ phase4Result, routed });
  if (!routeValidation.ok) return blocked(routeValidation.firstZero);
  const { challenger, route } = routeValidation;
  const runtimeIdentity = route.binding.candidateStrategyIdentity;

  const identityValidation = validateCanonicalOwnerIdentity({
    challenger,
    runtimeIdentity,
    strategyIdentity: ownerEvidence.strategyIdentity,
  });
  if (!identityValidation.ok) {
    return blocked(identityValidation.firstZero, { identityDetails: identityValidation.details ?? null });
  }

  const ownerResolution = resolveOwnerFunctions({ ownerFunctions, testOnly });
  if (!ownerResolution.ok) return blocked(ownerResolution.firstZero);
  const owners = ownerResolution.owners;
  let actualOwnerCalls = 0;
  let ownerContractAcceptances = 0;

  if (!record(ownerEvidence.researchSurvivorEvidence) || !nonEmpty(ownerEvidence.observedAt)) {
    return blocked("PHASE4_SHADOW_OWNER_INPUT_MISSING", {
      canonicalStrategyIdentityDigest: identityValidation.resolved.strategyIdentityDigest,
    });
  }

  actualOwnerCalls += 1;
  const shadowAdmission = owners.shadowAdmission({
    survivorEvidence: ownerEvidence.researchSurvivorEvidence,
    strategyIdentity: ownerEvidence.strategyIdentity,
    observedAt: ownerEvidence.observedAt,
    resourceUsage: ownerEvidence.resourceUsage ?? {},
  });
  if (shadowAdmission?.status !== "PASS" || shadowAdmission?.admitted !== true || !shadowAdmission.shadowCandidate) {
    return truthLocks({
      schemaVersion: 1,
      contract: PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.version,
      status: "BLOCKED",
      FIRST_ZERO: "PHASE4_SHADOW_OWNER_ADMISSION_BLOCKED",
      reason: "PHASE4_SHADOW_OWNER_ADMISSION_BLOCKED",
      actualOwnerCalls,
      ownerContractAcceptances,
      shadowAdmission,
      testOnly: ownerResolution.testOnly,
    });
  }
  ownerContractAcceptances += 1;

  if (!record(ownerEvidence.forwardObservation)) {
    return truthLocks({
      schemaVersion: 1,
      contract: PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.version,
      status: "BLOCKED",
      FIRST_ZERO: "PHASE4_FORWARD_OWNER_OBSERVATION_MISSING",
      reason: "PHASE4_FORWARD_OWNER_OBSERVATION_MISSING",
      actualOwnerCalls,
      ownerContractAcceptances,
      shadowAdmission,
      testOnly: ownerResolution.testOnly,
    });
  }

  actualOwnerCalls += 1;
  const forward = owners.forwardObservation({
    shadowCandidate: shadowAdmission.shadowCandidate,
    observation: ownerEvidence.forwardObservation,
  });
  if (forward?.status !== "PASS" || !forward.observation) {
    return truthLocks({
      schemaVersion: 1,
      contract: PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.version,
      status: "BLOCKED",
      FIRST_ZERO: "PHASE4_FORWARD_OWNER_EVIDENCE_BLOCKED",
      reason: "PHASE4_FORWARD_OWNER_EVIDENCE_BLOCKED",
      actualOwnerCalls,
      ownerContractAcceptances,
      shadowAdmission,
      forward,
      testOnly: ownerResolution.testOnly,
    });
  }
  ownerContractAcceptances += 1;

  if (!record(ownerEvidence.canonicalShadowHandoff)) {
    return truthLocks({
      schemaVersion: 1,
      contract: PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.version,
      status: "BLOCKED",
      FIRST_ZERO: "PHASE4_CANONICAL_SHADOW_HANDOFF_MISSING",
      reason: "PHASE4_CANONICAL_SHADOW_HANDOFF_MISSING",
      actualOwnerCalls,
      ownerContractAcceptances,
      shadowAdmission,
      forward,
      testOnly: ownerResolution.testOnly,
    });
  }

  const observations = [
    forward.observation,
    ...(Array.isArray(ownerEvidence.additionalShadowObservations)
      ? ownerEvidence.additionalShadowObservations
      : []),
  ];
  actualOwnerCalls += 1;
  const shadow = owners.shadowSufficiency({
    shadowCandidate: shadowAdmission.shadowCandidate,
    observations,
    canonicalShadowHandoff: ownerEvidence.canonicalShadowHandoff,
    observedAt: ownerEvidence.observedAt,
  });
  if (shadow?.status !== "PASS" || shadow?.sufficient !== true) {
    return truthLocks({
      schemaVersion: 1,
      contract: PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.version,
      status: "BLOCKED",
      FIRST_ZERO: "PHASE4_SHADOW_OWNER_SUFFICIENCY_NOT_READY",
      reason: "PHASE4_SHADOW_OWNER_SUFFICIENCY_NOT_READY",
      actualOwnerCalls,
      ownerContractAcceptances,
      shadowAdmission,
      forward,
      shadow,
      testOnly: ownerResolution.testOnly,
    });
  }
  ownerContractAcceptances += 1;

  if (!record(ownerEvidence.paperAdmissionBundle)) {
    return truthLocks({
      schemaVersion: 1,
      contract: PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.version,
      status: "BLOCKED",
      FIRST_ZERO: "PHASE4_PAPER_OWNER_BUNDLE_MISSING",
      reason: "PHASE4_PAPER_OWNER_BUNDLE_MISSING",
      actualOwnerCalls,
      ownerContractAcceptances,
      shadowAdmission,
      forward,
      shadow,
      testOnly: ownerResolution.testOnly,
    });
  }

  actualOwnerCalls += 1;
  const paper = owners.paperAdmission({
    bundle: ownerEvidence.paperAdmissionBundle,
    nowMs: paperNowMs,
  });
  if (paper?.status !== "BRIDGE_READY" || !paper.candidate) {
    return truthLocks({
      schemaVersion: 1,
      contract: PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.version,
      status: "BLOCKED",
      FIRST_ZERO: "PHASE4_PAPER_OWNER_ADMISSION_BLOCKED",
      reason: "PHASE4_PAPER_OWNER_ADMISSION_BLOCKED",
      actualOwnerCalls,
      ownerContractAcceptances,
      shadowAdmission,
      forward,
      shadow,
      paper,
      testOnly: ownerResolution.testOnly,
    });
  }
  if (!paperIdentityMatches({ candidate: paper.candidate, runtimeIdentity, challenger })) {
    return truthLocks({
      schemaVersion: 1,
      contract: PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.version,
      status: "BLOCKED",
      FIRST_ZERO: "PHASE4_PAPER_OWNER_IDENTITY_MISMATCH",
      reason: "PHASE4_PAPER_OWNER_IDENTITY_MISMATCH",
      actualOwnerCalls,
      ownerContractAcceptances,
      shadowAdmission,
      forward,
      shadow,
      paper,
      testOnly: ownerResolution.testOnly,
    });
  }
  ownerContractAcceptances += 1;

  return truthLocks({
    schemaVersion: 1,
    contract: PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.version,
    status: "EXISTING_OWNERS_CONNECTED_NON_ACTIVATING",
    FIRST_ZERO: null,
    reason: null,
    candidateId: challenger.candidateId,
    prospectiveBoundary: challenger.prospectiveBoundary,
    canonicalStrategyIdentityDigest: identityValidation.resolved.strategyIdentityDigest,
    actualOwnerCalls,
    ownerContractAcceptances,
    ownerPreflightOnly: true,
    shadowAdmission,
    forward,
    shadow,
    paper,
    testOnly: ownerResolution.testOnly,
  });
}

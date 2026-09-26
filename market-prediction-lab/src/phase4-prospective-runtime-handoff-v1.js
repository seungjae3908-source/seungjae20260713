import {
  verifyPhase4FrozenChallengerV1,
  verifyPhase4HandoffIdentityV1,
} from "./phase4-frozen-challenger-core-v1.js";

export const PHASE4_PROSPECTIVE_RUNTIME_HANDOFF_SCHEMA_VERSION =
  "phase4-prospective-runtime-handoff-v1";

const SHA40 = /^[0-9a-f]{40}$/iu;
const STAGES = Object.freeze({
  prospective: "PROSPECTIVE_SAMPLE_ADMISSION",
  forward: "FORWARD",
  shadow: "SHADOW",
  paper: "PAPER",
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function truthLocks() {
  return {
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
  };
}

function blocked(reason) {
  return deepFreeze({
    schemaVersion: PHASE4_PROSPECTIVE_RUNTIME_HANDOFF_SCHEMA_VERSION,
    status: "BLOCKED",
    FIRST_ZERO: reason,
    reason,
    binding: null,
    ...truthLocks(),
  });
}

function validRuntimeIdentity(identity) {
  return text(identity?.strategyId)
    && text(identity?.strategyVersion)
    && text(identity?.parameterHash)
    && SHA40.test(identity?.researchCodeSha ?? "")
    && text(identity?.costPolicyVersion)
    && text(identity?.executionPolicyVersion)
    && text(identity?.candidateId)
    && text(identity?.strategyFamily)
    && text(identity?.parameterDigest)
    && identity?.accountMode === "PAPER";
}

function runtimeIdentityMatchesChallenger(identity, challenger) {
  return identity.candidateId === challenger.candidateId
    && identity.strategyFamily === challenger.strategyFamily
    && identity.strategyVersion === challenger.strategyVersion
    && identity.parameterDigest === challenger.parameterDigest
    && identity.parameterHash === challenger.parameterDigest
    && identity.accountMode === challenger.accountMode;
}

function handoffsValid(challenger, handoffs) {
  const source = record(handoffs);
  if (!source) return false;
  for (const [key, stage] of Object.entries(STAGES)) {
    const handoff = source[key];
    if (!record(handoff) || handoff.stage !== stage || handoff.status !== "CONTRACT_READY") return false;
    const verification = verifyPhase4HandoffIdentityV1({ challenger, handoff });
    if (verification?.valid !== true) return false;
  }
  return true;
}

function stageBindings(handoffs) {
  return Object.freeze(Object.fromEntries(Object.entries(STAGES).map(([key, stage]) => [
    key,
    Object.freeze({
      stage,
      status: "BOUND_NON_ACTIVATING",
      challengerId: handoffs[key].challengerId,
      candidateId: handoffs[key].candidateId,
      freezeDigest: handoffs[key].freezeDigest,
      prospectiveBoundary: handoffs[key].prospectiveBoundary,
      prospectiveBoundaryMs: handoffs[key].prospectiveBoundaryMs,
      activationAllowed: false,
      dispatchAllowed: false,
      economicCreditCreated: false,
      executionAuthority: "NONE",
    }),
  ])));
}

export function bindPhase4ProspectiveRuntimeIdentityV1({
  phase4Result,
  runtimeStrategyIdentity,
} = {}) {
  const result = record(phase4Result);
  if (!result || result.status !== "PROSPECTIVE_ADMISSION_READY") {
    return blocked("PHASE4_RESULT_NOT_READY");
  }

  const challenger = record(result.challenger);
  const challengerVerification = verifyPhase4FrozenChallengerV1(challenger);
  if (challengerVerification?.valid !== true) {
    return blocked("PHASE4_FROZEN_CHALLENGER_INVALID");
  }
  if (!handoffsValid(challenger, result.handoffs)) {
    return blocked("PHASE4_HANDOFF_IDENTITY_INVALID");
  }

  const runtimeIdentity = record(runtimeStrategyIdentity);
  if (!runtimeIdentity) return blocked("PHASE4_RUNTIME_STRATEGY_IDENTITY_BINDING_MISSING");
  if (!validRuntimeIdentity(runtimeIdentity)) return blocked("PHASE4_RUNTIME_STRATEGY_IDENTITY_INVALID");
  if (!runtimeIdentityMatchesChallenger(runtimeIdentity, challenger)) {
    return blocked("PHASE4_RUNTIME_STRATEGY_IDENTITY_MISMATCH");
  }

  if (("executionAuthority" in runtimeIdentity && runtimeIdentity.executionAuthority !== "NONE")
    || runtimeIdentity.liveTradingAllowed === true
    || runtimeIdentity.privateTradingApiAllowed === true
    || runtimeIdentity.realOrderAllowed === true) {
    return blocked("PHASE4_RUNTIME_SAFETY_ENVELOPE_INVALID");
  }

  const candidateStrategyIdentity = structuredClone(runtimeIdentity);
  const binding = {
    schemaVersion: PHASE4_PROSPECTIVE_RUNTIME_HANDOFF_SCHEMA_VERSION,
    status: "BOUND_NON_ACTIVATING",
    challengerId: challenger.challengerId,
    freezeId: challenger.freezeId,
    freezeDigest: challenger.freezeDigest,
    candidateId: challenger.candidateId,
    prospectiveBoundary: challenger.prospectiveBoundary,
    prospectiveBoundaryMs: challenger.prospectiveBoundaryMs,
    candidateStrategyIdentity,
    stageBindings: stageBindings(result.handoffs),
    candidateIdentityPreserved: candidateStrategyIdentity.candidateId === challenger.candidateId,
    secondIdentityCreated: false,
    remapPerformed: false,
    rehashPerformed: false,
    fallbackIdentityUsed: false,
    ...truthLocks(),
  };

  return deepFreeze({
    schemaVersion: PHASE4_PROSPECTIVE_RUNTIME_HANDOFF_SCHEMA_VERSION,
    status: "BOUND_NON_ACTIVATING",
    FIRST_ZERO: null,
    reason: null,
    binding,
    ...truthLocks(),
  });
}

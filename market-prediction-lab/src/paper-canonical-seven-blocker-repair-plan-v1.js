export const PAPER_CANONICAL_SEVEN_BLOCKER_REPAIR_PLAN_VERSION =
  "paper-canonical-seven-blocker-repair-plan-v1";

export const PAPER_CANONICAL_SEVEN_BLOCKERS = Object.freeze([
  "PAPER_CANONICAL_PAPER_STATE_BINDING_NOT_READY",
  "PAPER_CANONICAL_PAPER_STATE_SNAPSHOT_NOT_READY",
  "PAPER_CANONICAL_NATURAL_STATE_NOT_READY",
  "PAPER_CANONICAL_FULL_COST_EIGHT_COMPONENTS_NOT_READY",
  "PAPER_CANONICAL_SETTLEMENT_DURABLE_PACKET_NOT_READY",
  "PAPER_CANONICAL_CLOSE_POSITION_REBIND_NOT_READY",
  "PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_UNCONFIGURED",
]);

const TECHNICAL_BLOCKERS = new Set([
  "PAPER_CANONICAL_PAPER_STATE_BINDING_NOT_READY",
  "PAPER_CANONICAL_PAPER_STATE_SNAPSHOT_NOT_READY",
  "PAPER_CANONICAL_NATURAL_STATE_NOT_READY",
  "PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_UNCONFIGURED",
]);

const GENUINE_EVIDENCE_BLOCKERS = new Set([
  "PAPER_CANONICAL_FULL_COST_EIGHT_COMPONENTS_NOT_READY",
  "PAPER_CANONICAL_SETTLEMENT_DURABLE_PACKET_NOT_READY",
  "PAPER_CANONICAL_CLOSE_POSITION_REBIND_NOT_READY",
]);

const ACTIONS = Object.freeze({
  PAPER_CANONICAL_PAPER_STATE_BINDING_NOT_READY: Object.freeze({
    id: "PREPARE_PUBLISHER_BINDING",
    class: "CONFIG_REPAIR",
    existingOwner: "paper-forward-publisher-binding-preparation",
    requiresProductionEnvironment: true,
    requiresGenuineEvidence: false,
  }),
  PAPER_CANONICAL_PAPER_STATE_SNAPSHOT_NOT_READY: Object.freeze({
    id: "REFRESH_EXACT_SHA_PAPER_SNAPSHOT",
    class: "SAFE_METADATA_REBIND",
    existingOwner: "paper-forward-flat-snapshot-republish",
    requiresProductionEnvironment: true,
    requiresGenuineEvidence: false,
  }),
  PAPER_CANONICAL_NATURAL_STATE_NOT_READY: Object.freeze({
    id: "RUN_EXACT_SHA_NATURAL_PAPER_ONE_SHOT",
    class: "NATURAL_EVIDENCE",
    existingOwner: "research-production-forward-one-shot",
    requiresProductionEnvironment: true,
    requiresGenuineEvidence: true,
  }),
  PAPER_CANONICAL_FULL_COST_EIGHT_COMPONENTS_NOT_READY: Object.freeze({
    id: "WAIT_FOR_GENUINE_FULL_COST_POSITION",
    class: "NATURAL_EVIDENCE",
    existingOwner: "recurring-paper-loop-v1",
    requiresProductionEnvironment: false,
    requiresGenuineEvidence: true,
  }),
  PAPER_CANONICAL_SETTLEMENT_DURABLE_PACKET_NOT_READY: Object.freeze({
    id: "WAIT_FOR_GENUINE_SETTLEMENT_PACKET",
    class: "NATURAL_EVIDENCE",
    existingOwner: "canonical-natural-settlement-owner-evidence-v1",
    requiresProductionEnvironment: false,
    requiresGenuineEvidence: true,
  }),
  PAPER_CANONICAL_CLOSE_POSITION_REBIND_NOT_READY: Object.freeze({
    id: "REVALIDATE_GENUINE_CLOSE_POSITION_REBIND",
    class: "READ_ONLY_RECHECK",
    existingOwner: "natural-paper-trigger-bound-settlement-cost-producer-v1",
    requiresProductionEnvironment: false,
    requiresGenuineEvidence: true,
  }),
  PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_UNCONFIGURED: Object.freeze({
    id: "PUBLISH_EXPLICIT_RECEIPT_FRESHNESS_POLICY",
    class: "CONFIG_REPAIR",
    existingOwner: "paper-canonical-evidence-bridge",
    requiresProductionEnvironment: true,
    requiresGenuineEvidence: false,
  }),
});

const ACTION_ORDER = Object.freeze([
  "PAPER_CANONICAL_PAPER_STATE_BINDING_NOT_READY",
  "PAPER_CANONICAL_PAPER_STATE_SNAPSHOT_NOT_READY",
  "PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_UNCONFIGURED",
  "PAPER_CANONICAL_NATURAL_STATE_NOT_READY",
  "PAPER_CANONICAL_FULL_COST_EIGHT_COMPONENTS_NOT_READY",
  "PAPER_CANONICAL_SETTLEMENT_DURABLE_PACKET_NOT_READY",
  "PAPER_CANONICAL_CLOSE_POSITION_REBIND_NOT_READY",
]);

function uniqueStrings(value) {
  return [...new Set(Array.isArray(value) ? value.map(String) : [])];
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function evidenceCounts(input) {
  const source = input?.evidenceCounts ?? {};
  return Object.freeze({
    naturalPositions: nonNegativeInteger(source.naturalPositions),
    naturalSettlements: nonNegativeInteger(source.naturalSettlements),
    fullCostReadyPositions: nonNegativeInteger(source.fullCostReadyPositions),
    durableSettlementPackets: nonNegativeInteger(source.durableSettlementPackets),
    canonicalRebinds: nonNegativeInteger(source.canonicalRebinds),
  });
}

function safetyEnvelope() {
  return Object.freeze({
    executionAuthority: "NONE",
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    realOrderCount: 0,
    financialMutationAuthority: false,
    profitabilityCredit: 0,
    naturalSampleCreditGrantedByRepair: 0,
    replayCredit: 0,
    backfillCredit: 0,
    syntheticCredit: 0,
    manualCredit: 0,
    hindsightCredit: 0,
  });
}

export function buildPaperCanonicalSevenBlockerRepairPlan(readiness = {}) {
  const blockers = uniqueStrings(readiness.blockers);
  const seven = blockers.filter((value) => PAPER_CANONICAL_SEVEN_BLOCKERS.includes(value));
  const unrelated = blockers.filter((value) => !PAPER_CANONICAL_SEVEN_BLOCKERS.includes(value));
  const counts = evidenceCounts(readiness);

  if (unrelated.length > 0) {
    return Object.freeze({
      schemaVersion: PAPER_CANONICAL_SEVEN_BLOCKER_REPAIR_PLAN_VERSION,
      status: "BLOCKED_UNRELATED",
      sevenBlockers: Object.freeze(seven),
      unrelatedBlockers: Object.freeze(unrelated),
      actions: Object.freeze([]),
      technicalRepairPending: seven.some((value) => TECHNICAL_BLOCKERS.has(value)),
      genuineEvidencePending: seven.some((value) => GENUINE_EVIDENCE_BLOCKERS.has(value)),
      readyForActivationReview: false,
      activationApplied: false,
      evidenceCounts: counts,
      safety: safetyEnvelope(),
    });
  }

  if (readiness.readyForActivationReview === true && blockers.length === 0) {
    return Object.freeze({
      schemaVersion: PAPER_CANONICAL_SEVEN_BLOCKER_REPAIR_PLAN_VERSION,
      status: "READY_FOR_ACTIVATION_REVIEW",
      sevenBlockers: Object.freeze([]),
      unrelatedBlockers: Object.freeze([]),
      actions: Object.freeze([]),
      technicalRepairPending: false,
      genuineEvidencePending: false,
      readyForActivationReview: true,
      activationApplied: false,
      evidenceCounts: counts,
      safety: safetyEnvelope(),
    });
  }

  const actions = ACTION_ORDER
    .filter((blocker) => seven.includes(blocker))
    .map((blocker) => Object.freeze({
      blocker,
      ...ACTIONS[blocker],
    }));

  const technicalRepairPending = seven.some((value) => TECHNICAL_BLOCKERS.has(value));
  const genuineEvidencePending = seven.some((value) => GENUINE_EVIDENCE_BLOCKERS.has(value));

  const status = technicalRepairPending
    ? "REPAIR_REQUIRED"
    : genuineEvidencePending
      ? "WAITING_GENUINE_EVIDENCE"
      : "BLOCKED_NO_MATCHING_REPAIR";

  return Object.freeze({
    schemaVersion: PAPER_CANONICAL_SEVEN_BLOCKER_REPAIR_PLAN_VERSION,
    status,
    sevenBlockers: Object.freeze(seven),
    unrelatedBlockers: Object.freeze([]),
    actions: Object.freeze(actions),
    technicalRepairPending,
    genuineEvidencePending,
    readyForActivationReview: false,
    activationApplied: false,
    evidenceCounts: counts,
    safety: safetyEnvelope(),
  });
}

export const PAPER_CANONICAL_SEVEN_BLOCKER_REPAIR_SAFETY = safetyEnvelope();

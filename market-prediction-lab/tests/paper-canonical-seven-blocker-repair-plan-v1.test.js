import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPaperCanonicalSevenBlockerRepairPlan,
  PAPER_CANONICAL_SEVEN_BLOCKERS,
} from "../src/paper-canonical-seven-blocker-repair-plan-v1.js";

test("all seven blockers become one ordered repair plan without granting evidence credit", () => {
  const plan = buildPaperCanonicalSevenBlockerRepairPlan({
    readyForActivationReview: false,
    blockers: [...PAPER_CANONICAL_SEVEN_BLOCKERS],
    evidenceCounts: {
      naturalPositions: 0,
      naturalSettlements: 0,
      fullCostReadyPositions: 0,
      durableSettlementPackets: 0,
      canonicalRebinds: 0,
    },
  });

  assert.equal(plan.status, "REPAIR_REQUIRED");
  assert.equal(plan.actions.length, 7);
  assert.deepEqual(plan.actions.map((row) => row.id), [
    "PREPARE_PUBLISHER_BINDING",
    "REFRESH_EXACT_SHA_PAPER_SNAPSHOT",
    "PUBLISH_EXPLICIT_RECEIPT_FRESHNESS_POLICY",
    "RUN_EXACT_SHA_NATURAL_PAPER_ONE_SHOT",
    "WAIT_FOR_GENUINE_FULL_COST_POSITION",
    "WAIT_FOR_GENUINE_SETTLEMENT_PACKET",
    "REVALIDATE_GENUINE_CLOSE_POSITION_REBIND",
  ]);
  assert.equal(plan.technicalRepairPending, true);
  assert.equal(plan.genuineEvidencePending, true);
  assert.equal(plan.readyForActivationReview, false);
  assert.equal(plan.activationApplied, false);
  assert.equal(plan.safety.executionAuthority, "NONE");
  assert.equal(plan.safety.profitabilityCredit, 0);
  assert.equal(plan.safety.syntheticCredit, 0);
  assert.equal(plan.safety.replayCredit, 0);
  assert.equal(plan.safety.backfillCredit, 0);
});

test("genuine-evidence blockers can never be promoted by the repair planner", () => {
  const blockers = [
    "PAPER_CANONICAL_FULL_COST_EIGHT_COMPONENTS_NOT_READY",
    "PAPER_CANONICAL_SETTLEMENT_DURABLE_PACKET_NOT_READY",
    "PAPER_CANONICAL_CLOSE_POSITION_REBIND_NOT_READY",
  ];
  const plan = buildPaperCanonicalSevenBlockerRepairPlan({
    readyForActivationReview: false,
    blockers,
    evidenceCounts: {
      naturalPositions: 0,
      naturalSettlements: 0,
      fullCostReadyPositions: 0,
      durableSettlementPackets: 0,
      canonicalRebinds: 0,
    },
  });

  assert.equal(plan.status, "WAITING_GENUINE_EVIDENCE");
  assert.equal(plan.technicalRepairPending, false);
  assert.equal(plan.genuineEvidencePending, true);
  assert.equal(plan.readyForActivationReview, false);
  assert.ok(plan.actions.every((row) => row.requiresGenuineEvidence === true));
  assert.equal(plan.safety.naturalSampleCreditGrantedByRepair, 0);
});

test("unknown blockers fail closed and produce no action", () => {
  const plan = buildPaperCanonicalSevenBlockerRepairPlan({
    blockers: [
      "PAPER_CANONICAL_PAPER_STATE_BINDING_NOT_READY",
      "PAPER_CANONICAL_UNKNOWN_NEW_BLOCKER",
    ],
  });
  assert.equal(plan.status, "BLOCKED_UNRELATED");
  assert.deepEqual(plan.unrelatedBlockers, ["PAPER_CANONICAL_UNKNOWN_NEW_BLOCKER"]);
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.readyForActivationReview, false);
});

test("ready input remains read-only and does not apply activation", () => {
  const plan = buildPaperCanonicalSevenBlockerRepairPlan({
    readyForActivationReview: true,
    blockers: [],
    evidenceCounts: {
      naturalPositions: 2,
      naturalSettlements: 2,
      fullCostReadyPositions: 2,
      durableSettlementPackets: 2,
      canonicalRebinds: 2,
    },
  });
  assert.equal(plan.status, "READY_FOR_ACTIVATION_REVIEW");
  assert.equal(plan.readyForActivationReview, true);
  assert.equal(plan.activationApplied, false);
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.safety.realOrderCount, 0);
});

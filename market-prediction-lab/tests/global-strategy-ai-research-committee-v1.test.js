import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_RESEARCH_COMMITTEE_ROLES,
  createAiResearchCommitteePlan,
  createAiResearchReview,
  failAiResearchProvider,
  synthesizeAiResearchCommittee,
  verifyAiResearchCommitteePlan,
} from "../src/global-strategy-ai-research-committee-v1.js";

const evidenceFingerprint = "strategy-evidence-ledger:fixture-v1";

function provider(providerId, priority, overrides = {}) {
  return {
    providerId,
    modelId: `${providerId}-model-v1`,
    billingTier: "FREE",
    state: "AVAILABLE",
    priority,
    supportedRoles: [...AI_RESEARCH_COMMITTEE_ROLES],
    ...overrides,
  };
}

function plan(providers = [provider("free-primary", 0), provider("free-secondary", 1)]) {
  return createAiResearchCommitteePlan({ evidenceFingerprint, providers });
}

function reviewFor(currentPlan, role, conclusion = "INSUFFICIENT_EVIDENCE", overrides = {}) {
  const assignment = currentPlan.assignments.find((item) => item.role === role);
  return createAiResearchReview({
    plan: currentPlan,
    review: {
      role,
      providerId: assignment.providerId,
      modelId: assignment.modelId,
      evidenceFingerprint,
      conclusion,
      findings: [{ category: "EVIDENCE", statement: `${role} narrative finding`, evidenceReferences: ["ledger-entry-v1"] }],
      limitations: ["AI narrative requires deterministic retest"],
      suggestedDeterministicTests: ["run isolated holdout"],
      ...overrides,
    },
  });
}

test("committee exposes six fixed roles and chooses free providers only", () => {
  const current = plan([
    provider("paid-fast", 0, { billingTier: "PAID" }),
    provider("free-primary", 1),
  ]);
  assert.equal(AI_RESEARCH_COMMITTEE_ROLES.length, 6);
  assert.equal(current.status, "COMMITTEE_PLAN_READY");
  assert.equal(current.assignments.every((item) => item.providerId === "free-primary"), true);
  assert.equal(current.assignments.every((item) => item.billingTier === "FREE"), true);
  assert.equal(current.paidFallbackUsed, false);
  assert.equal(current.safety.actualProviderCalls, 0);
  assert.equal(verifyAiResearchCommitteePlan(current), true);
});

test("paid-only provider inventory fails closed without fallback", () => {
  const current = plan([provider("paid-only", 0, { billingTier: "PAID" })]);
  assert.equal(current.status, "AI_RESEARCH_UNAVAILABLE");
  assert.deepEqual(current.unavailableRoles, [...AI_RESEARCH_COMMITTEE_ROLES]);
  assert.equal(current.assignments.every((item) => item.providerId === null), true);
  assert.equal(current.paidFallbackUsed, false);
  assert.equal(current.safety.actualPaidProviderCalls, 0);
});

test("free provider failure chooses another free provider and never a paid one", () => {
  const current = plan([
    provider("free-primary", 0),
    provider("free-secondary", 1),
    provider("paid-tertiary", 2, { billingTier: "PAID" }),
  ]);
  const failed = failAiResearchProvider(current, { providerId: "free-primary", failureClass: "RATE_LIMIT" });
  assert.equal(failed.status, "COMMITTEE_PLAN_READY");
  assert.equal(failed.assignments.every((item) => item.providerId === "free-secondary"), true);
  assert.equal(failed.assignments.every((item) => item.billingTier === "FREE"), true);
  assert.deepEqual(failed.failedProviderIds, ["free-primary"]);
});

test("all free providers failing returns AI_RESEARCH_UNAVAILABLE", () => {
  const first = failAiResearchProvider(plan(), { providerId: "free-primary", failureClass: "NETWORK" });
  const second = failAiResearchProvider(first, { providerId: "free-secondary", failureClass: "NETWORK" });
  assert.equal(second.status, "AI_RESEARCH_UNAVAILABLE");
  assert.equal(second.assignments.every((item) => item.providerId === null), true);
  assert.equal(second.paidFallbackUsed, false);
});

test("duplicate provider identity and unknown failure identity are rejected", () => {
  assert.throws(() => plan([provider("same", 0), provider("same", 1)]), /DUPLICATE_PROVIDER_ID/);
  assert.throws(() => failAiResearchProvider(plan(), { providerId: "unknown", failureClass: "NETWORK" }), /UNKNOWN_PROVIDER_ID/);
});

test("AI review cannot contribute numerical evidence or promotion scores", () => {
  const current = plan();
  assert.throws(() => reviewFor(current, "EVIDENCE_REVIEWER", "SUPPORTS_FURTHER_RESEARCH", { probabilityEstimate: 0.9 }), /AI_NUMERIC_AUTHORITY_FORBIDDEN/);
  assert.throws(() => reviewFor(current, "EVIDENCE_REVIEWER", "SUPPORTS_FURTHER_RESEARCH", { promotionScore: 99 }), /AI_NUMERIC_AUTHORITY_FORBIDDEN/);
  const review = reviewFor(current, "EVIDENCE_REVIEWER");
  assert.equal(review.numericalEvidence, null);
  assert.equal(review.promotionScore, null);
  assert.equal(review.safety.aiCanChangeCanonicalMetrics, false);
});

test("review must use the assigned free provider and exact evidence fingerprint", () => {
  const current = plan();
  assert.throws(() => reviewFor(current, "REPLICATION_CRITIC", "INSUFFICIENT_EVIDENCE", { providerId: "unassigned" }), /PROVIDER_ASSIGNMENT_MISMATCH/);
  assert.throws(() => reviewFor(current, "REPLICATION_CRITIC", "INSUFFICIENT_EVIDENCE", { evidenceFingerprint: "other" }), /FINGERPRINT_MISMATCH/);
});

test("committee disagreement is preserved as REVIEW_CONFLICT", () => {
  const current = plan();
  const reviews = AI_RESEARCH_COMMITTEE_ROLES.map((role, index) => reviewFor(
    current,
    role,
    index === 0 ? "SUPPORTS_FURTHER_RESEARCH" : index === 1 ? "OPPOSES_FURTHER_RESEARCH" : "INSUFFICIENT_EVIDENCE",
  ));
  const result = synthesizeAiResearchCommittee({ plan: current, reviews });
  assert.equal(result.status, "REVIEW_CONFLICT");
  assert.equal(result.disagreementPreserved, true);
  assert.equal(result.preservedOpinions.length, 6);
  assert.equal(result.consensusScore, null);
  assert.equal(result.deterministicRetestRequired, true);
});

test("unanimous insufficient reviews remain insufficient and grant no authority", () => {
  const current = plan();
  const reviews = AI_RESEARCH_COMMITTEE_ROLES.map((role) => reviewFor(current, role));
  const result = synthesizeAiResearchCommittee({ plan: current, reviews });
  assert.equal(result.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.promotionEligible, false);
  assert.equal(result.scannerEligible, false);
  assert.equal(result.championEligible, false);
  assert.equal(result.safety.executionAuthority, "NONE");
  assert.equal(result.safety.actualOrders, 0);
});

test("missing committee roles cannot be misreported as a complete review", () => {
  const current = plan();
  const result = synthesizeAiResearchCommittee({
    plan: current,
    reviews: [reviewFor(current, "EVIDENCE_REVIEWER", "SUPPORTS_FURTHER_RESEARCH")],
  });
  assert.equal(result.status, "INCOMPLETE_REVIEW");
  assert.equal(result.missingRoles.length, 5);
  assert.equal(result.probabilityEstimate, null);
  assert.equal(result.performanceEstimate, null);
});

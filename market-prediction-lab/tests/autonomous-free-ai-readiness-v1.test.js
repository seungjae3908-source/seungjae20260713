import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFreeAiProviderReadiness,
  FREE_AI_PROVIDER_HEALTH_STATES,
} from "../src/autonomous-free-ai-readiness-v1.js";
import {
  createAutonomousResearchRuntimeState,
  executeDualFreeAiRuntime,
} from "../src/autonomous-research-runtime-v1.js";
import { createDualFreeAiReviewPlan } from "../src/autonomous-strategy-formula-generator-v1.js";

const CHECKED_AT = "2026-08-21T09:00:00+09:00";

function readinessProviders() {
  return [
    { slot: "AI_PROVIDER_A", providerName: "free-provider-a", modelName: "free-model-a", availability: "READY", roleSupport: ["PROPOSER", "CRITIC"], billingTier: "FREE", lastCheck: CHECKED_AT, failureReason: null },
    { slot: "AI_PROVIDER_B", providerName: "free-provider-b", modelName: "free-model-b", availability: "READY", roleSupport: ["PROPOSER", "CRITIC"], billingTier: "FREE", lastCheck: CHECKED_AT, failureReason: null },
  ];
}

function runtimeProviders() {
  return [
    { providerId: "free-provider-a", modelId: "free-model-a", billingTier: "FREE", state: "AVAILABLE", priority: 0 },
    { providerId: "free-provider-b", modelId: "free-model-b", billingTier: "FREE", state: "AVAILABLE", priority: 1 },
  ];
}

test("FREE AI provider unavailable health is explicit and never attempts paid fallback", () => {
  const health = buildFreeAiProviderReadiness({ providers: [], checkedAt: CHECKED_AT });
  assert.equal(health.AI_PROVIDER_A_READY, "UNAVAILABLE");
  assert.equal(health.AI_PROVIDER_B_READY, "UNAVAILABLE");
  assert.equal(health.AI_DUAL_REVIEW_READY, "UNAVAILABLE");
  assert.equal(health.AI_RESEARCH_STATUS, "AI_RESEARCH_UNAVAILABLE");
  assert.equal(health.FREE_PROVIDER_ONLY, true);
  assert.equal(health.PAID_FALLBACK, false);
  assert.equal(health.providerCallAttempted, false);
  assert.equal(health.providerChecks.AI_PROVIDER_A.failureReason, "PROVIDER_NOT_CONFIGURED");
  assert.equal(health.providerChecks.AI_PROVIDER_A.providerName, "NOT_CONFIGURED");
});

test("FREE AI readiness classifies rate limits, provider aliasing, and secret-bearing metadata", () => {
  assert.deepEqual(FREE_AI_PROVIDER_HEALTH_STATES, ["READY", "UNAVAILABLE", "RATE_LIMITED", "MISCONFIGURED"]);
  const rateLimited = buildFreeAiProviderReadiness({
    checkedAt: CHECKED_AT,
    providers: readinessProviders().map((row, index) => index === 1 ? { ...row, availability: "RATE_LIMITED", failureReason: "HTTP_429" } : row),
  });
  assert.equal(rateLimited.AI_PROVIDER_B_READY, "RATE_LIMITED");
  assert.equal(rateLimited.AI_DUAL_REVIEW_READY, "RATE_LIMITED");
  const unrecognized = buildFreeAiProviderReadiness({
    checkedAt: CHECKED_AT,
    providers: readinessProviders().map((row, index) => index === 1 ? { ...row, availability: "UNVERIFIED" } : row),
  });
  assert.equal(unrecognized.AI_PROVIDER_B_READY, "UNAVAILABLE");
  assert.equal(unrecognized.providerChecks.AI_PROVIDER_B.failureReason, "PROVIDER_AVAILABILITY_UNRECOGNIZED");
  const aliased = buildFreeAiProviderReadiness({
    checkedAt: CHECKED_AT,
    providers: readinessProviders().map((row) => ({ ...row, providerName: "same-provider" })),
  });
  assert.equal(aliased.AI_PROVIDER_A_READY, "READY");
  assert.equal(aliased.AI_PROVIDER_B_READY, "READY");
  assert.equal(aliased.AI_DUAL_REVIEW_READY, "MISCONFIGURED");
  assert.throws(() => buildFreeAiProviderReadiness({ providers: [readinessProviders()[0], readinessProviders()[0]], checkedAt: CHECKED_AT }), /DUPLICATE_AI_PROVIDER_SLOT/);
  assert.throws(() => buildFreeAiProviderReadiness({ providers: [{ ...readinessProviders()[0], apiKey: "must-never-enter-readiness" }], checkedAt: CHECKED_AT }), /SECRET_METADATA_FORBIDDEN/);
});

test("dual-AI conflict preserves exact provider/model/role/source/output audit fields", async () => {
  const sourceFingerprint = "f".repeat(64);
  const plan = createDualFreeAiReviewPlan({ evidenceFingerprint: sourceFingerprint, providers: runtimeProviders() });
  const result = await executeDualFreeAiRuntime(createAutonomousResearchRuntimeState(), {
    plan,
    researchSourceId: "research-source:real-pilot",
    researchRecord: { title: "real-source-metadata" },
    analysis: { status: "CONTRACT_TEST_ONLY" },
    calledAt: CHECKED_AT,
  }, async ({ slot }) => ({
    slot: slot.slot,
    providerId: slot.providerId,
    conclusion: slot.role === "ADVERSARIAL_REVIEWER" ? "REJECT_HYPOTHESIS" : "PROPOSE_DETERMINISTIC_TEST",
    mechanismOrChallenge: slot.role === "ADVERSARIAL_REVIEWER" ? "Costs and leakage require rejection" : "Run a bounded deterministic test",
    expectedRegime: "REQUIRES_TEST",
    findings: [slot.role === "ADVERSARIAL_REVIEWER" ? "ADVERSARIAL_DISAGREEMENT" : "PROPOSER_HYPOTHESIS"],
    proposedBoundedVariants: [],
    deterministicResolution: "RUN_CANONICAL_QUEUE_226",
  }));
  assert.equal(result.synthesis.status, "AI_REVIEW_CONFLICT");
  assert.equal(result.calls.length, 4);
  for (const call of result.calls) {
    for (const field of ["reviewId", "provider", "model", "role", "sourceFingerprint", "outputFingerprint", "timestamp", "status", "disagreementReason"]) {
      assert.equal(Object.hasOwn(call, field), true, `missing ${field}`);
    }
    assert.equal(call.sourceFingerprint, sourceFingerprint);
    assert.match(call.reviewId, /^dual-ai-review:/);
    assert.match(call.outputFingerprint, /^[0-9a-f]{64}$/);
    assert.match(call.disagreementReason, /ADVERSARIAL_DISAGREEMENT/);
  }
  assert.equal(Object.keys(result.state.aiOutputs).length, 4);
  assert.equal(result.paidFallbackUsed, false);
});

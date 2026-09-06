import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  CANONICAL_SHADOW_BOOTSTRAP_SEED_V1,
  assertCanonicalRuntimeBindingShapeV1,
  canonicalBootstrapSeedAllowedV1,
  canonicalShadowPublisherGateV1,
  canonicalShadowRuntimeRequestV1,
  canonicalShadowScheduleGateV1,
  canonicalStrandedBootstrapRecoveryAllowedV1,
  parseCanonicalShadowActivationCommandV1,
  parseCanonicalShadowRecoveryApprovalV1,
} from "../src/canonical-shadow-runtime-activation-v1.js";

test("activation command requires an exact lowercase 40-char SHA", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(parseCanonicalShadowActivationCommandV1(`/activate-canonical-shadow ${sha}`), { targetSha: sha });
  assert.equal(parseCanonicalShadowActivationCommandV1(`/activate-canonical-shadow ${"A".repeat(40)}`), null);
  assert.equal(parseCanonicalShadowActivationCommandV1(`/activate-canonical-shadow ${"a".repeat(39)}`), null);
});

test("stranded recovery approval requires an exact lowercase 40-char SHA", () => {
  const sha = "c".repeat(40);
  assert.deepEqual(parseCanonicalShadowRecoveryApprovalV1(`/approve-canonical-shadow-recovery ${sha}`), { targetSha: sha });
  assert.equal(parseCanonicalShadowRecoveryApprovalV1(`/approve-canonical-shadow-recovery ${"C".repeat(40)}`), null);
  assert.equal(parseCanonicalShadowRecoveryApprovalV1(`/approve-canonical-shadow-recovery ${"c".repeat(39)}`), null);
  assert.equal(parseCanonicalShadowRecoveryApprovalV1(`/activate-canonical-shadow ${sha}`), null);
});

test("runtime request IDs distinguish activation from hourly schedule", () => {
  assert.deepEqual(canonicalShadowRuntimeRequestV1("activate-5423752984"), { kind: "ACTIVATION", id: "5423752984", value: "activate-5423752984" });
  assert.deepEqual(canonicalShadowRuntimeRequestV1("hourly-32955082719"), { kind: "HOURLY", id: "32955082719", value: "hourly-32955082719" });
  assert.equal(canonicalShadowRuntimeRequestV1("manual-1").kind, "INVALID");
});

test("canonical hourly schedule stays dormant while legacy workflow remains enabled", () => {
  assert.deepEqual(canonicalShadowScheduleGateV1({ legacyWorkflowState: "active" }), {
    active: false,
    reason: "LEGACY_ACTIVE_CANONICAL_DORMANT",
  });
  assert.deepEqual(canonicalShadowScheduleGateV1({ legacyWorkflowState: "disabled_manually" }), {
    active: true,
    reason: "LEGACY_DISABLED_CANONICAL_ACTIVE",
  });
});

test("bootstrap exception is exact and activation-only", () => {
  const exact = {
    requestId: "activate-5423752984",
    producerRunId: CANONICAL_SHADOW_BOOTSTRAP_SEED_V1.producerRunId,
    predecessorRunId: CANONICAL_SHADOW_BOOTSTRAP_SEED_V1.predecessorRunId,
    predecessorArtifactDigest: `sha256:${CANONICAL_SHADOW_BOOTSTRAP_SEED_V1.predecessorArtifactDigest}`,
  };
  assert.equal(canonicalBootstrapSeedAllowedV1(exact), true);
  assert.equal(canonicalBootstrapSeedAllowedV1({ ...exact, requestId: "hourly-1" }), false);
  assert.equal(canonicalBootstrapSeedAllowedV1({ ...exact, predecessorRunId: "32933416613" }), false);
  assert.equal(canonicalBootstrapSeedAllowedV1({ ...exact, predecessorArtifactDigest: "0".repeat(64) }), false);
});

test("stranded bootstrap recovery is hourly, exact-main, legacy-disabled, zero-receipt, unclaimed, and explicitly approved", () => {
  const targetSha = "d".repeat(40);
  const exact = {
    requestId: "hourly-34020000001",
    recoveryApprovalCommentId: "5557999001",
    recoveryApprovalTargetSha: targetSha,
    targetSha,
    legacyWorkflowState: "disabled_manually",
    publishedReceiptCount: 0,
    recoveryApprovalClaimCount: 0,
    producerRunId: CANONICAL_SHADOW_BOOTSTRAP_SEED_V1.producerRunId,
    predecessorRunId: CANONICAL_SHADOW_BOOTSTRAP_SEED_V1.predecessorRunId,
    predecessorArtifactDigest: `sha256:${CANONICAL_SHADOW_BOOTSTRAP_SEED_V1.predecessorArtifactDigest}`,
  };
  assert.equal(canonicalStrandedBootstrapRecoveryAllowedV1(exact), true);
  assert.equal(canonicalStrandedBootstrapRecoveryAllowedV1({ ...exact, requestId: "activate-1" }), false);
  assert.equal(canonicalStrandedBootstrapRecoveryAllowedV1({ ...exact, recoveryApprovalCommentId: "" }), false);
  assert.equal(canonicalStrandedBootstrapRecoveryAllowedV1({ ...exact, recoveryApprovalTargetSha: "e".repeat(40) }), false);
  assert.equal(canonicalStrandedBootstrapRecoveryAllowedV1({ ...exact, legacyWorkflowState: "active" }), false);
  assert.equal(canonicalStrandedBootstrapRecoveryAllowedV1({ ...exact, publishedReceiptCount: 1 }), false);
  assert.equal(canonicalStrandedBootstrapRecoveryAllowedV1({ ...exact, recoveryApprovalClaimCount: 1 }), false);
  assert.equal(canonicalStrandedBootstrapRecoveryAllowedV1({ ...exact, predecessorRunId: "32933416613" }), false);
  assert.equal(canonicalStrandedBootstrapRecoveryAllowedV1({ ...exact, predecessorArtifactDigest: "0".repeat(64) }), false);
});

test("publisher fails closed unless source run and runtime authorization agree", () => {
  assert.deepEqual(canonicalShadowPublisherGateV1({ sourceConclusion: "failure", requestId: "activate-1", activationAuthorized: true }), {
    publish: false,
    reason: "SOURCE_RUN_NOT_SUCCESS",
  });
  assert.deepEqual(canonicalShadowPublisherGateV1({ sourceConclusion: "success", requestId: "activate-1", activationAuthorized: false }), {
    publish: false,
    reason: "ACTIVATION_NOT_AUTHORIZED",
  });
  assert.deepEqual(canonicalShadowPublisherGateV1({ sourceConclusion: "success", requestId: "activate-1", activationAuthorized: true }), {
    publish: true,
    reason: "ACTIVATION_AUTHORIZED",
  });
  assert.deepEqual(canonicalShadowPublisherGateV1({ sourceConclusion: "success", requestId: "hourly-1", legacyWorkflowState: "active" }), {
    publish: false,
    reason: "LEGACY_ACTIVE_CANONICAL_DORMANT",
  });
  assert.deepEqual(canonicalShadowPublisherGateV1({ sourceConclusion: "success", requestId: "hourly-1", legacyWorkflowState: "disabled_manually" }), {
    publish: true,
    reason: "LEGACY_DISABLED_CANONICAL_ACTIVE",
  });
});

test("publisher workflow clean-skips artifactless source runs before mutation gates", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/prediction-lab-canonical-shadow-publisher.yml", import.meta.url), "utf8");
  const classifierStart = workflow.indexOf("  classify-source-artifact:");
  const publishStart = workflow.indexOf("  publish:");
  assert.ok(classifierStart >= 0, "publisher must classify source artifact availability");
  assert.ok(publishStart > classifierStart, "artifact classifier must run before publisher");

  const classifier = workflow.slice(classifierStart, publishStart);
  const publisher = workflow.slice(publishStart);
  assert.match(classifier, /github\.paginate\(/);
  assert.doesNotMatch(classifier, /response\.data\.artifacts/);
  assert.match(classifier, /matches\.length === 0/);
  assert.match(classifier, /matches\.length === 1 \? 'true' : 'false'/);
  assert.match(classifier, /matches\.length > 1/);
  assert.match(classifier, /core\.setFailed/);
  assert.match(classifier, /produced no publisher artifact; clean skip/);
  assert.doesNotMatch(classifier, /secrets\./);
  assert.match(publisher, /needs: classify-source-artifact/);
  assert.match(publisher, /needs\.classify-source-artifact\.outputs\.eligible == 'true'/);
});

test("stranded recovery workflow is approval-gated, one-shot, and refuses a second bootstrap lineage", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/prediction-lab-canonical-shadow-cycle.yml", import.meta.url), "utf8");
  assert.match(workflow, /issues\/838\/comments\?per_page=100/);
  assert.match(workflow, /--paginate --slurp/);
  assert.match(workflow, /approve-canonical-shadow-recovery/);
  assert.match(workflow, /actions\/artifacts\?per_page=100/);
  assert.match(workflow, /publication_receipt_count/);
  assert.match(workflow, /recovery_approval_claim_count/);
  assert.match(workflow, /canonical-shadow-recovery-attempt-/);
  assert.match(workflow, /Recovery approval comment .* already claimed/);
  assert.match(workflow, /Canonical publication receipt history exists but no valid predecessor/);
  assert.match(workflow, /canonicalStrandedBootstrapRecoveryAllowedV1/);
  assert.match(workflow, /canonicalRuntimeBootstrapRecovery/);
  assert.match(workflow, /legacy_state/);
  const claimUpload = workflow.indexOf("- name: Upload one-time stranded recovery claim");
  const predecessorDownload = workflow.indexOf("- name: Download exact predecessor evidence");
  assert.ok(claimUpload >= 0 && predecessorDownload > claimUpload, "recovery approval must be durably claimed before bootstrap predecessor state is used");
  assert.doesNotMatch(workflow, /replay|backfill|synthetic credit/i);
});

test("binding shape rejects guessed or mutable identities", () => {
  const researchSha = "b".repeat(40);
  assert.deepEqual(assertCanonicalRuntimeBindingShapeV1({ producerRunId: "32921992780", predecessorRunId: "32933416612", researchSha }), {
    producerRunId: "32921992780",
    predecessorRunId: "32933416612",
    researchSha,
  });
  assert.throws(() => assertCanonicalRuntimeBindingShapeV1({ producerRunId: "0", predecessorRunId: "1", researchSha }));
  assert.throws(() => assertCanonicalRuntimeBindingShapeV1({ producerRunId: "1", predecessorRunId: "1", researchSha: "main" }));
});

test("stranded recovery rejects missing and coercible zero-count evidence without throwing", () => {
  const targetSha = "d".repeat(40);
  const exact = {
    requestId: "hourly-34020000001",
    recoveryApprovalCommentId: "5557999001",
    recoveryApprovalTargetSha: targetSha,
    targetSha,
    legacyWorkflowState: "disabled_manually",
    publishedReceiptCount: 0,
    recoveryApprovalClaimCount: 0,
    ...CANONICAL_SHADOW_BOOTSTRAP_SEED_V1,
  };
  for (const publishedReceiptCount of [0, "0"]) {
    for (const recoveryApprovalClaimCount of [0, "0"]) {
      assert.equal(canonicalStrandedBootstrapRecoveryAllowedV1({ ...exact, publishedReceiptCount, recoveryApprovalClaimCount }), true);
    }
  }
  const invalidCounts = [
    undefined, null, "", " ", "\t\n", false, true, [], [0], ["0"], {},
    { valueOf: () => 0 }, new Number(0), new String("0"),
    "00", "0.0", "0e0", "+0", "-0", "0x0", " 0 ", "NaN",
    NaN, Infinity, -Infinity, -1, 1, 0.5, "1", 0n, Symbol("0"),
    { valueOf() { throw new Error("Count evidence must not be coerced"); } },
  ];
  for (const field of ["publishedReceiptCount", "recoveryApprovalClaimCount"]) {
    for (const [index, value] of invalidCounts.entries()) {
      assert.equal(canonicalStrandedBootstrapRecoveryAllowedV1({ ...exact, [field]: value }), false, `${field} invalid case ${index}`);
    }
    const missing = { ...exact };
    delete missing[field];
    assert.equal(canonicalStrandedBootstrapRecoveryAllowedV1(missing), false, `${field} must be present`);
  }
});

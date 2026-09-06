const SHA40 = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const HASH64 = /^(?:sha256:)?([0-9a-f]{64})$/u;

export const CANONICAL_SHADOW_BOOTSTRAP_SEED_V1 = Object.freeze({
  producerRunId: "32921992780",
  predecessorRunId: "32933416612",
  predecessorArtifactDigest: "4604d37fbc6b8cf5c95bdb915f7a7de2e205bd3705ece148b7267d2782cebfb1",
});

export function parseCanonicalShadowActivationCommandV1(body) {
  const match = String(body ?? "").trim().match(/^\/activate-canonical-shadow ([0-9a-f]{40})$/u);
  return match && SHA40.test(match[1]) ? Object.freeze({ targetSha: match[1] }) : null;
}

export function parseCanonicalShadowRecoveryApprovalV1(body) {
  const match = String(body ?? "").trim().match(/^\/approve-canonical-shadow-recovery ([0-9a-f]{40})$/u);
  return match && SHA40.test(match[1]) ? Object.freeze({ targetSha: match[1] }) : null;
}

export function canonicalShadowRuntimeRequestV1(value) {
  const text = String(value ?? "").trim();
  let match = text.match(/^activate-([1-9][0-9]*)$/u);
  if (match) return Object.freeze({ kind: "ACTIVATION", id: match[1], value: text });
  match = text.match(/^hourly-([1-9][0-9]*)$/u);
  if (match) return Object.freeze({ kind: "HOURLY", id: match[1], value: text });
  return Object.freeze({ kind: "INVALID", id: null, value: text });
}

export function canonicalShadowScheduleGateV1({ legacyWorkflowState } = {}) {
  return Object.freeze({
    active: legacyWorkflowState === "disabled_manually",
    reason: legacyWorkflowState === "disabled_manually" ? "LEGACY_DISABLED_CANONICAL_ACTIVE" : "LEGACY_ACTIVE_CANONICAL_DORMANT",
  });
}

function exactBootstrapSeedV1({ producerRunId, predecessorRunId, predecessorArtifactDigest } = {}) {
  const digestMatch = String(predecessorArtifactDigest ?? "").toLowerCase().match(HASH64);
  return String(producerRunId ?? "") === CANONICAL_SHADOW_BOOTSTRAP_SEED_V1.producerRunId
    && String(predecessorRunId ?? "") === CANONICAL_SHADOW_BOOTSTRAP_SEED_V1.predecessorRunId
    && digestMatch?.[1] === CANONICAL_SHADOW_BOOTSTRAP_SEED_V1.predecessorArtifactDigest;
}

export function canonicalBootstrapSeedAllowedV1({
  requestId,
  producerRunId,
  predecessorRunId,
  predecessorArtifactDigest,
} = {}) {
  const request = canonicalShadowRuntimeRequestV1(requestId);
  return request.kind === "ACTIVATION"
    && exactBootstrapSeedV1({ producerRunId, predecessorRunId, predecessorArtifactDigest });
}

export function canonicalStrandedBootstrapRecoveryAllowedV1({
  requestId,
  recoveryApprovalCommentId,
  recoveryApprovalTargetSha,
  targetSha,
  legacyWorkflowState,
  publishedReceiptCount,
  recoveryApprovalClaimCount,
  producerRunId,
  predecessorRunId,
  predecessorArtifactDigest,
} = {}) {
  const request = canonicalShadowRuntimeRequestV1(requestId);
  const approvalSha = String(recoveryApprovalTargetSha ?? "");
  const exactTargetSha = String(targetSha ?? "");
  // Missing or malformed evidence is not an observed zero.
  return request.kind === "HOURLY"
    && POSITIVE_INTEGER.test(String(recoveryApprovalCommentId ?? ""))
    && SHA40.test(approvalSha)
    && SHA40.test(exactTargetSha)
    && approvalSha === exactTargetSha
    && legacyWorkflowState === "disabled_manually"
    && (publishedReceiptCount === 0 || publishedReceiptCount === "0")
    && (recoveryApprovalClaimCount === 0 || recoveryApprovalClaimCount === "0")
    && exactBootstrapSeedV1({ producerRunId, predecessorRunId, predecessorArtifactDigest });
}

export function canonicalShadowPublisherGateV1({
  sourceConclusion,
  requestId,
  legacyWorkflowState,
  activationAuthorized = false,
} = {}) {
  if (sourceConclusion !== "success") return Object.freeze({ publish: false, reason: "SOURCE_RUN_NOT_SUCCESS" });
  const request = canonicalShadowRuntimeRequestV1(requestId);
  if (request.kind === "ACTIVATION") {
    return Object.freeze({ publish: activationAuthorized === true, reason: activationAuthorized === true ? "ACTIVATION_AUTHORIZED" : "ACTIVATION_NOT_AUTHORIZED" });
  }
  if (request.kind === "HOURLY") {
    const schedule = canonicalShadowScheduleGateV1({ legacyWorkflowState });
    return Object.freeze({ publish: schedule.active, reason: schedule.reason });
  }
  return Object.freeze({ publish: false, reason: "CANONICAL_RUNTIME_REQUEST_INVALID" });
}

export function assertCanonicalRuntimeBindingShapeV1({ producerRunId, predecessorRunId, researchSha } = {}) {
  if (!POSITIVE_INTEGER.test(String(producerRunId ?? ""))) throw new Error("producerRunId must be a positive integer");
  if (!POSITIVE_INTEGER.test(String(predecessorRunId ?? ""))) throw new Error("predecessorRunId must be a positive integer");
  if (!SHA40.test(String(researchSha ?? ""))) throw new Error("researchSha must be an exact lowercase SHA");
  return Object.freeze({ producerRunId: String(producerRunId), predecessorRunId: String(predecessorRunId), researchSha: String(researchSha) });
}

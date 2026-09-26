const SHA256 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const PROBABILITY_KEYS = Object.freeze(["bullish", "neutral", "bearish"]);

export const CANONICAL_SHADOW_RUNTIME_CUTOVER_V1 = Object.freeze({
  schemaVersion: "prediction-lab-canonical-shadow-runtime-cutover-v1",
  cutoverEnabled: false,
  scheduleActivated: false,
  writerConcurrencyGroup: "prediction-lab-canonical-shadow-writer-v1",
  cancelInProgress: false,
  artifactRetentionDays: 90,
  stateRootRelativePath: "forward/shadow-state.json",
  branchWrite: false,
  liveOrderAllowed: false,
  privateAccountRequestAllowed: false,
  executionAuthority: "NONE",
});

export const CANONICAL_SHADOW_ROLLBACK_V1 = Object.freeze({
  trigger: "CANONICAL_SHADOW_CUTOVER_FAILURE",
  steps: Object.freeze([
    "STOP_CANONICAL_WRITER",
    "PRESERVE_LAST_GOOD_STATE",
    "RESTORE_LEGACY_RUNTIME_PATH",
  ]),
  automaticStateResetAllowed: false,
  automaticLegacyActivationAllowed: false,
  separateApprovalRequired: true,
});

export class CanonicalShadowCutoverError extends Error {
  constructor(classification, reason) {
    super(reason);
    this.name = "CanonicalShadowCutoverError";
    this.classification = classification;
  }
}

function fail(classification, reason) {
  throw new CanonicalShadowCutoverError(classification, reason);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function digest(value) {
  return typeof value === "string" && SHA256.test(value);
}

function immutableSha(value) {
  return typeof value === "string" && SHA40.test(value);
}

function successfulArtifact(value, expectedName) {
  return object(value)
    && POSITIVE_INTEGER.test(String(value.id ?? ""))
    && value.name === expectedName
    && digest(value.digest)
    && value.expired === false
    && iso(value.createdAt)
    && iso(value.expiresAt);
}

export function validateCanonicalProducerBindingV1(candidate, { asOf = new Date().toISOString() } = {}) {
  const runId = String(candidate?.runId ?? "");
  const artifact = candidate?.artifact;
  if (!POSITIVE_INTEGER.test(runId) || candidate?.workflowConclusion !== "success") {
    fail("PRODUCER_BINDING_REJECTED", "PRODUCER_RUN_NOT_SUCCESSFUL");
  }
  if (!successfulArtifact(artifact, `prediction-lab-model-reference-evidence-${runId}`)) {
    fail("PRODUCER_BINDING_REJECTED", "PRODUCER_ARTIFACT_INVALID");
  }
  if (!iso(asOf) || Date.parse(artifact.expiresAt) <= Date.parse(asOf)) {
    fail("PRODUCER_BINDING_REJECTED", "PRODUCER_ARTIFACT_EXPIRED");
  }
  if (!immutableSha(candidate.researchSha)
      || candidate.strategyIdentityValid !== true || !digest(candidate.strategyIdentityDigest)
      || candidate.modelIdentityValid !== true || !digest(candidate.modelIdentityDigest)
      || candidate.train?.valid !== true || !digest(candidate.train?.digest)
      || candidate.validation?.valid !== true || !digest(candidate.validation?.digest)) {
    fail("PRODUCER_BINDING_REJECTED", "PRODUCER_IDENTITY_OR_SPLIT_INVALID");
  }
  return Object.freeze({
    runId,
    researchSha: candidate.researchSha,
    strategyIdentityDigest: candidate.strategyIdentityDigest,
    modelIdentityDigest: candidate.modelIdentityDigest,
    trainDigest: candidate.train.digest,
    validationDigest: candidate.validation.digest,
    artifact: Object.freeze({ ...artifact }),
  });
}

export function selectCanonicalProducerBindingV1(candidates, options = {}) {
  if (!Array.isArray(candidates)) fail("PRODUCER_BINDING_MISSING", "PRODUCER_CANDIDATES_REQUIRED");
  const valid = [];
  for (const candidate of candidates) {
    try { valid.push(validateCanonicalProducerBindingV1(candidate, options)); }
    catch (error) {
      if (!(error instanceof CanonicalShadowCutoverError)) throw error;
    }
  }
  valid.sort((left, right) => Date.parse(right.artifact.createdAt) - Date.parse(left.artifact.createdAt));
  if (!valid.length) fail("PRODUCER_BINDING_MISSING", "NO_VALID_CANONICAL_PRODUCER");
  return valid[0];
}

export function selectCanonicalPredecessorBindingV1({
  candidates,
  producer,
  researchSha,
  strategyIdentityDigest,
  modelIdentityDigest,
  asOf = new Date().toISOString(),
  isResearchAncestor = () => false,
} = {}) {
  if (!Array.isArray(candidates) || !producer || !immutableSha(researchSha)
      || !digest(strategyIdentityDigest) || !digest(modelIdentityDigest) || !iso(asOf)) {
    fail("PREDECESSOR_BINDING_MISSING", "PREDECESSOR_CONTEXT_INVALID");
  }
  const valid = candidates.filter((candidate) => {
    const runId = String(candidate?.runId ?? "");
    const sameLineage = candidate?.researchSha === researchSha
      || (immutableSha(candidate?.researchSha) && isResearchAncestor(candidate.researchSha, researchSha) === true);
    return POSITIVE_INTEGER.test(runId)
      && candidate.workflowConclusion === "success"
      && successfulArtifact(candidate.artifact, `prediction-lab-shadow-cycle-${runId}`)
      && Date.parse(candidate.artifact.expiresAt) > Date.parse(asOf)
      && candidate.schemaVersion === "prediction-lab-shadow-cycle-provenance-v2"
      && String(candidate.producerRunId ?? "") === producer.runId
      && candidate.strategyIdentityDigest === strategyIdentityDigest
      && candidate.modelIdentityDigest === modelIdentityDigest
      && sameLineage
      && candidate.schemaValid === true
      && candidate.digestValid === true
      && candidate.replay === false
      && candidate.corrupted === false;
  });
  valid.sort((left, right) => Date.parse(right.artifact.createdAt) - Date.parse(left.artifact.createdAt));
  if (!valid.length) fail("PREDECESSOR_BINDING_MISSING", "NO_VALID_CANONICAL_PREDECESSOR");
  return Object.freeze({ ...valid[0], artifact: Object.freeze({ ...valid[0].artifact }) });
}

function sameNumber(left, right, tolerance) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function sameProbabilities(left, right, tolerance) {
  return PROBABILITY_KEYS.every((key) => sameNumber(left?.[key], right?.[key], tolerance));
}

export function assertCanonicalShadowEquivalenceV1({ legacy, canonical, tolerance = 1e-12 } = {}) {
  if (!object(legacy) || !object(canonical) || !Number.isFinite(tolerance) || tolerance < 0) {
    fail("EQUIVALENCE_FAILED", "EQUIVALENCE_INPUT_INVALID");
  }
  const scalarFields = [
    "symbol",
    "market",
    "timeframe",
    "inputTimestamp",
    "featureSchemaDigest",
    "modelIdentity",
    "finalDirection",
  ];
  const differences = scalarFields.filter((field) => legacy[field] !== canonical[field]);
  if (!sameNumber(legacy.referencePrice, canonical.referencePrice, tolerance)) differences.push("referencePrice");
  for (const field of ["ruleProbability", "modelProbability", "blendProbability"]) {
    if (!sameProbabilities(legacy[field], canonical[field], tolerance)) differences.push(field);
  }
  if (JSON.stringify(legacy.observationIdentityInput) !== JSON.stringify(canonical.observationIdentityInput)) {
    differences.push("observationIdentityInput");
  }
  if (differences.length) fail("EQUIVALENCE_FAILED", `SEMANTIC_DIFFERENCE:${differences.join(",")}`);
  return Object.freeze({
    status: "PASS",
    differences: Object.freeze([]),
    canonicalProvenanceAdditionsAllowed: true,
  });
}

export function validateCanonicalCycleInputV1({ providerStatus, observedAt, expiresAt } = {}) {
  if (providerStatus !== "SUCCESS") fail("PROVIDER_FAILURE", "PUBLIC_PROVIDER_NOT_SUCCESSFUL");
  if (!iso(observedAt) || !iso(expiresAt) || Date.parse(expiresAt) <= Date.parse(observedAt)) {
    fail("DATA_STALE", "MARKET_DATA_NOT_FRESH");
  }
  return Object.freeze({ status: "VALID" });
}

export function settlementCarryForwardDecisionV1({ status, dueAt, now, futurePriceCapturedAt = null } = {}) {
  if (status === "SETTLED") return Object.freeze({ action: "NOOP_ALREADY_SETTLED" });
  if (status !== "PENDING_SETTLEMENT" || !iso(dueAt) || !iso(now)) {
    fail("SETTLEMENT_REJECTED", "SETTLEMENT_CONTEXT_INVALID");
  }
  if (Date.parse(now) < Date.parse(dueAt)) {
    if (futurePriceCapturedAt != null) fail("SETTLEMENT_REJECTED", "FUTURE_PRICE_PREFETCH_FORBIDDEN");
    return Object.freeze({ action: "CARRY_FORWARD" });
  }
  if (futurePriceCapturedAt != null && (!iso(futurePriceCapturedAt) || Date.parse(futurePriceCapturedAt) < Date.parse(dueAt))) {
    fail("SETTLEMENT_REJECTED", "SETTLEMENT_PRICE_PROVENANCE_INVALID");
  }
  return Object.freeze({ action: "SETTLEMENT_DUE" });
}

export function publicationGuardDecisionV1({ artifactComplete, stateRootPublishSucceeded, crashPhase = null } = {}) {
  if (artifactComplete !== true) fail("ARTIFACT_INVALID", "PARTIAL_ARTIFACT_UPLOAD");
  if (["BEFORE_PUBLISH", "AFTER_ARTIFACT_BEFORE_STATE_ROOT"].includes(crashPhase)) {
    return Object.freeze({ action: "PRESERVE_LAST_GOOD", wrote: false });
  }
  if (stateRootPublishSucceeded !== true) fail("STATE_ROOT_PUBLISH_FAILED", "PRESERVE_LAST_GOOD");
  return Object.freeze({ action: "PUBLISHED_ATOMICALLY", wrote: true });
}

export function assertSingleCanonicalWriterV1({ activeWriterCount, concurrencyGroup } = {}) {
  if (concurrencyGroup !== CANONICAL_SHADOW_RUNTIME_CUTOVER_V1.writerConcurrencyGroup) {
    fail("CONCURRENCY_REJECTED", "WRITER_CONCURRENCY_GROUP_MISMATCH");
  }
  if (!Number.isInteger(activeWriterCount) || activeWriterCount !== 1) {
    fail("CONCURRENCY_REJECTED", "EXACTLY_ONE_CANONICAL_WRITER_REQUIRED");
  }
  return Object.freeze({ status: "SINGLE_WRITER" });
}

export function buildCanonicalShadowCutoverPlanV1({ researchSha, producer, predecessor } = {}) {
  if (!immutableSha(researchSha) || !producer || !predecessor) {
    fail("CUTOVER_PLAN_REJECTED", "IMMUTABLE_BINDINGS_REQUIRED");
  }
  return Object.freeze({
    ...CANONICAL_SHADOW_RUNTIME_CUTOVER_V1,
    researchSha,
    producerRunId: producer.runId,
    producerArtifactId: String(producer.artifact.id),
    predecessorShadowRunId: String(predecessor.runId),
    predecessorArtifactId: String(predecessor.artifact.id),
    rollback: CANONICAL_SHADOW_ROLLBACK_V1,
  });
}

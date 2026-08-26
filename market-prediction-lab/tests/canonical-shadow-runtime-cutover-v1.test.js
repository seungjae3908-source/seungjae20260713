import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCanonicalShadowEquivalenceV1,
  assertSingleCanonicalWriterV1,
  buildCanonicalShadowCutoverPlanV1,
  CANONICAL_SHADOW_ROLLBACK_V1,
  CANONICAL_SHADOW_RUNTIME_CUTOVER_V1,
  publicationGuardDecisionV1,
  selectCanonicalPredecessorBindingV1,
  selectCanonicalProducerBindingV1,
  settlementCarryForwardDecisionV1,
  validateCanonicalCycleInputV1,
} from "../src/canonical-shadow-runtime-cutover-v1.js";

const D = (value) => value.repeat(64).slice(0, 64);
const SHA = "a".repeat(40);
const PRIOR_SHA = "b".repeat(40);
const AS_OF = "2026-08-26T07:00:00.000Z";

function producer(overrides = {}) {
  const runId = String(overrides.runId ?? "32921992780");
  return {
    runId,
    workflowConclusion: "success",
    researchSha: SHA,
    strategyIdentityValid: true,
    strategyIdentityDigest: D("1"),
    modelIdentityValid: true,
    modelIdentityDigest: D("2"),
    train: { valid: true, digest: D("3") },
    validation: { valid: true, digest: D("4") },
    artifact: {
      id: String(overrides.artifactId ?? "9590232582"),
      name: `prediction-lab-model-reference-evidence-${runId}`,
      digest: D("5"),
      expired: false,
      createdAt: "2026-08-26T06:00:00.000Z",
      expiresAt: "2026-11-24T06:00:00.000Z",
    },
    ...overrides,
  };
}

function predecessor(overrides = {}) {
  const runId = String(overrides.runId ?? "32933416612");
  return {
    runId,
    workflowConclusion: "success",
    schemaVersion: "prediction-lab-shadow-cycle-provenance-v2",
    producerRunId: "32921992780",
    strategyIdentityDigest: D("1"),
    modelIdentityDigest: D("2"),
    researchSha: PRIOR_SHA,
    schemaValid: true,
    digestValid: true,
    replay: false,
    corrupted: false,
    artifact: {
      id: String(overrides.artifactId ?? "9593997765"),
      name: `prediction-lab-shadow-cycle-${runId}`,
      digest: D("6"),
      expired: false,
      createdAt: "2026-08-26T06:30:00.000Z",
      expiresAt: "2026-11-24T06:30:00.000Z",
    },
    ...overrides,
  };
}

test("Producer auto-binding ignores invalid latest artifacts and requires exact identity plus TRAIN and VALIDATION", () => {
  const invalidLatest = producer({
    runId: "32999999999",
    artifact: { ...producer().artifact, id: "9599999999", name: "latest-file", createdAt: "2026-08-26T06:59:00.000Z" },
  });
  const selected = selectCanonicalProducerBindingV1([invalidLatest, producer()], { asOf: AS_OF });
  assert.equal(selected.runId, "32921992780");
  for (const mutation of [
    { workflowConclusion: "failure" },
    { strategyIdentityValid: false },
    { modelIdentityValid: false },
    { train: { valid: false, digest: D("3") } },
    { validation: { valid: false, digest: D("4") } },
    { artifact: { ...producer().artifact, expired: true } },
  ]) {
    assert.throws(() => selectCanonicalProducerBindingV1([{ ...producer(), ...mutation }], { asOf: AS_OF }), /NO_VALID_CANONICAL_PRODUCER/);
  }
});

test("predecessor discovery rejects missing expired corrupted wrong-producer identity replay and incompatible lineage", () => {
  const selectedProducer = selectCanonicalProducerBindingV1([producer()], { asOf: AS_OF });
  const select = (candidates) => selectCanonicalPredecessorBindingV1({
    candidates,
    producer: selectedProducer,
    researchSha: SHA,
    strategyIdentityDigest: D("1"),
    modelIdentityDigest: D("2"),
    asOf: AS_OF,
    isResearchAncestor: (ancestor, head) => ancestor === PRIOR_SHA && head === SHA,
  });
  assert.equal(select([predecessor()]).runId, "32933416612");
  for (const mutation of [
    { artifact: { ...predecessor().artifact, expiresAt: "2026-08-26T06:59:00.000Z" } },
    { corrupted: true },
    { producerRunId: "32900000000" },
    { strategyIdentityDigest: D("7") },
    { modelIdentityDigest: D("8") },
    { replay: true },
    { researchSha: "c".repeat(40) },
  ]) assert.throws(() => select([{ ...predecessor(), ...mutation }]), /NO_VALID_CANONICAL_PREDECESSOR/);
  assert.throws(() => select([]), /NO_VALID_CANONICAL_PREDECESSOR/);
});

test("same fixture requires semantic equivalence while allowing canonical provenance additions", () => {
  const probabilities = { bullish: 0.42, neutral: 0.43, bearish: 0.15 };
  const shared = {
    symbol: "BTCUSDT",
    market: "CRYPTO_FUTURES",
    timeframe: "15m",
    inputTimestamp: 1735850700000,
    featureSchemaDigest: D("9"),
    modelIdentity: "tiny-linear-baseline-v0",
    ruleProbability: probabilities,
    modelProbability: probabilities,
    blendProbability: probabilities,
    finalDirection: "neutral",
    referencePrice: 120.25,
    observationIdentityInput: ["BTCUSDT", "15m", 1735850700000, 8],
  };
  assert.equal(assertCanonicalShadowEquivalenceV1({
    legacy: shared,
    canonical: { ...shared, inferenceContract: "deployed-rule-model-65-35", provenance: { canonical: true } },
  }).status, "PASS");
  assert.throws(() => assertCanonicalShadowEquivalenceV1({ legacy: shared, canonical: { ...shared, finalDirection: "bearish" } }), /SEMANTIC_DIFFERENCE:finalDirection/);
});

test("provider timeout and stale market data fail closed", () => {
  assert.throws(() => validateCanonicalCycleInputV1({ providerStatus: "TIMEOUT", observedAt: AS_OF, expiresAt: "2026-08-26T07:05:00.000Z" }), /PUBLIC_PROVIDER_NOT_SUCCESSFUL/);
  assert.throws(() => validateCanonicalCycleInputV1({ providerStatus: "SUCCESS", observedAt: AS_OF, expiresAt: AS_OF }), /MARKET_DATA_NOT_FRESH/);
});

test("settlement carries forward until due and forbids future-price prefetch or duplicate settlement", () => {
  assert.equal(settlementCarryForwardDecisionV1({ status: "PENDING_SETTLEMENT", dueAt: "2026-08-26T08:00:00.000Z", now: AS_OF }).action, "CARRY_FORWARD");
  assert.throws(() => settlementCarryForwardDecisionV1({ status: "PENDING_SETTLEMENT", dueAt: "2026-08-26T08:00:00.000Z", now: AS_OF, futurePriceCapturedAt: AS_OF }), /FUTURE_PRICE_PREFETCH_FORBIDDEN/);
  assert.equal(settlementCarryForwardDecisionV1({ status: "PENDING_SETTLEMENT", dueAt: AS_OF, now: "2026-08-26T07:01:00.000Z", futurePriceCapturedAt: AS_OF }).action, "SETTLEMENT_DUE");
  assert.equal(settlementCarryForwardDecisionV1({ status: "SETTLED", dueAt: AS_OF, now: AS_OF }).action, "NOOP_ALREADY_SETTLED");
});

test("partial upload publish failure and crash windows preserve last-good state", () => {
  assert.throws(() => publicationGuardDecisionV1({ artifactComplete: false, stateRootPublishSucceeded: false }), /PARTIAL_ARTIFACT_UPLOAD/);
  assert.throws(() => publicationGuardDecisionV1({ artifactComplete: true, stateRootPublishSucceeded: false }), /PRESERVE_LAST_GOOD/);
  for (const crashPhase of ["BEFORE_PUBLISH", "AFTER_ARTIFACT_BEFORE_STATE_ROOT"]) {
    assert.deepEqual(publicationGuardDecisionV1({ artifactComplete: true, stateRootPublishSucceeded: false, crashPhase }), { action: "PRESERVE_LAST_GOOD", wrote: false });
  }
  assert.equal(publicationGuardDecisionV1({ artifactComplete: true, stateRootPublishSucceeded: true }).action, "PUBLISHED_ATOMICALLY");
});

test("concurrent schedule runs require one shared canonical writer group", () => {
  assert.equal(assertSingleCanonicalWriterV1({ activeWriterCount: 1, concurrencyGroup: CANONICAL_SHADOW_RUNTIME_CUTOVER_V1.writerConcurrencyGroup }).status, "SINGLE_WRITER");
  assert.throws(() => assertSingleCanonicalWriterV1({ activeWriterCount: 2, concurrencyGroup: CANONICAL_SHADOW_RUNTIME_CUTOVER_V1.writerConcurrencyGroup }), /EXACTLY_ONE_CANONICAL_WRITER_REQUIRED/);
  assert.throws(() => assertSingleCanonicalWriterV1({ activeWriterCount: 1, concurrencyGroup: "per-run" }), /WRITER_CONCURRENCY_GROUP_MISMATCH/);
});

test("cutover plan stays disabled and carries an approval-gated rollback path", () => {
  const selectedProducer = selectCanonicalProducerBindingV1([producer()], { asOf: AS_OF });
  const selectedPredecessor = selectCanonicalPredecessorBindingV1({
    candidates: [predecessor()],
    producer: selectedProducer,
    researchSha: SHA,
    strategyIdentityDigest: D("1"),
    modelIdentityDigest: D("2"),
    asOf: AS_OF,
    isResearchAncestor: () => true,
  });
  const plan = buildCanonicalShadowCutoverPlanV1({ researchSha: SHA, producer: selectedProducer, predecessor: selectedPredecessor });
  assert.equal(plan.cutoverEnabled, false);
  assert.equal(plan.scheduleActivated, false);
  assert.equal(plan.executionAuthority, "NONE");
  assert.deepEqual(plan.rollback, CANONICAL_SHADOW_ROLLBACK_V1);
  assert.deepEqual(plan.rollback.steps, ["STOP_CANONICAL_WRITER", "PRESERVE_LAST_GOOD_STATE", "RESTORE_LEGACY_RUNTIME_PATH"]);
  assert.equal(plan.rollback.separateApprovalRequired, true);
});

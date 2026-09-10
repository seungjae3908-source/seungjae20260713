import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveCanonicalStrategyIdentity } from "../src/canonical-strategy-identity-v1.js";
import { sha256Canonical } from "../src/research-cache-provenance.js";
import {
  GITHUB_ARTIFACT_TRANSPORT_SCHEMA_VERSION,
  SHADOW_ARTIFACT_PUBLICATION_MANIFEST_SCHEMA_VERSION,
  buildShadowArtifactPublicationManifestV1,
  publishShadowArtifactToStateRootV1,
  validateAndNormalizeShadowArtifactV1,
} from "../src/shadow-state-root-transport-v1.js";

const CHECKED_AT = "2026-08-26T03:00:00.000Z";
const MANIFEST_AT = "2026-08-26T03:05:00.000Z";
const ARTIFACT_AT = "2026-08-26T03:06:00.000Z";
const AS_OF = "2026-08-26T03:07:00.000Z";
const EXPIRES_AT = "2026-11-24T03:06:00.000Z";
const RESEARCH_SHA = "8".repeat(40);
const PRODUCER_SHA = "3".repeat(40);
const RUN_ID = "32925597702";
const ARTIFACT_ID = "9591382818";
const ARCHIVE_DIGEST = "9".repeat(64);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function quality(settledN = 0) {
  const classRow = { support: 0, predictedSupport: 0, precision: null, recall: null, f1: null };
  return {
    sampleN: settledN,
    settledN,
    totalObservationN: settledN,
    directionRatio: { LONG: null, SHORT: null, NEUTRAL: null },
    predictedCounts: { bullish: 0, neutral: 0, bearish: 0 },
    confusionMatrix: {
      bullish: { bullish: 0, neutral: 0, bearish: 0 },
      neutral: { bullish: 0, neutral: 0, bearish: 0 },
      bearish: { bullish: 0, neutral: 0, bearish: 0 },
    },
    perClass: { bullish: { ...classRow }, neutral: { ...classRow }, bearish: { ...classRow } },
    bullRecall: null,
    bearRecall: null,
    precision: null,
    recall: null,
    macroF1: null,
    balancedAccuracy: null,
    brier: null,
    logLoss: null,
    calibration: { expectedCalibrationError: null, bins: [] },
    catastrophicOppositeDirectionErrors: { count: 0, ratio: null },
  };
}

function fixtureState({ freshnessExpiresAt = EXPIRES_AT, strategyVersion = "1" } = {}) {
  const strategy = resolveCanonicalStrategyIdentity({
    strategyId: "shadow-fixture-v1",
    strategyFamily: "shadow-fixture",
    strategyVersion,
    market: "CRYPTO_FUTURES",
    direction: "BOTH",
    timeframe: "15m",
    formulaIdentity: { family: "fixture" },
    parameterHash: hash("parameters"),
    researchCodeSha: PRODUCER_SHA,
    datasetId: "fixture-dataset",
    datasetDigest: hash("dataset"),
    datasetStart: "2026-01-01T00:00:00.000Z",
    datasetEnd: "2026-08-25T00:00:00.000Z",
    costPolicyVersion: "cost-v1",
    riskPolicyVersion: "risk-v1",
    evidenceSchemaVersion: "evidence-v1",
  });
  assert.equal(strategy.status, "IDENTITY_COMPLETE");
  const referenceIdentity = {
    datasetId: strategy.identity.datasetId,
    datasetDigest: strategy.identity.datasetDigest,
    trainSplitDigest: hash("train"),
    validationSplitDigest: hash("validation"),
    rawArtifactDigest: hash("raw-artifact"),
    preprocessingVersion: "preprocess-v1",
    featureOrderDigest: hash("feature-order"),
  };
  const modelIdentity = {
    schemaVersion: "prediction-lab-model-identity-mapping-v1",
    exactModelBytesSha: hash("exact-model-bytes"),
    exactModelBytesShaSemantics: "sha256(exact serialized model bytes)",
    canonicalModelArtifactDigest: hash("canonical-model"),
    canonicalModelArtifactDigestSemantics: "sha256(canonical parsed model artifact)",
    trainingRunIdentity: {
      artifactId: "9590232582",
      artifactReference: "prediction-lab-model-reference-evidence-32921992780",
      outerArtifactDigest: hash("outer-artifact"),
      rawArtifactDigest: referenceIdentity.rawArtifactDigest,
      trainingCodeSha: PRODUCER_SHA,
      measuredAt: CHECKED_AT,
    },
    trainingRunIdentityDigest: null,
    strategyIdentityDigest: strategy.strategyIdentityDigest,
    datasetIdentity: { datasetId: referenceIdentity.datasetId, datasetDigest: referenceIdentity.datasetDigest },
    datasetIdentityDigest: referenceIdentity.datasetDigest,
    featureOrderDigest: referenceIdentity.featureOrderDigest,
    preprocessingVersion: referenceIdentity.preprocessingVersion,
    modelSchemaVersion: "tiny-softmax-v1",
  };
  modelIdentity.trainingRunIdentityDigest = sha256Canonical(modelIdentity.trainingRunIdentity);
  const modelIdentityDigest = sha256Canonical(modelIdentity);
  const zeroQuality = quality(0);
  const driftVerdict = {
    status: "NOT_EVALUABLE",
    reason: "SETTLEMENT_NOT_DUE",
    psi: null,
    ksStatistic: null,
    jsd: null,
    strongestDriftingFeatures: [],
    asOf: CHECKED_AT,
  };
  const healthBody = {
    schemaVersion: "prediction-lab-strategy-health-shadow-handoff-v1",
    strategyIdentity: strategy.identity,
    strategyIdentityDigest: strategy.strategyIdentityDigest,
    modelIdentity,
    modelIdentityDigest,
    datasetReferenceIdentity: referenceIdentity,
    directionalQuality: zeroQuality,
    ruleOnlyQuality: zeroQuality,
    modelOnlyQuality: zeroQuality,
    blendQuality: zeroQuality,
    driftVerdict,
    driftMetrics: [{ feature: "return5", status: "MISSING_EVIDENCE", psi: null, ksStatistic: null, jsd: null }],
    sampleN: 4,
    settledN: 0,
    referenceN: 20,
    freshness: { status: "FRESH", checkedAt: CHECKED_AT, expiresAt: freshnessExpiresAt },
    missingEvidence: ["SETTLEMENT_NOT_DUE"],
    executionAuthority: "NONE",
  };
  const strategyHealthHandoff = { ...healthBody, evidenceDigest: sha256Canonical(healthBody) };
  const outerBody = {
    schemaVersion: "prediction-lab-shadow-evidence-handoff-v1",
    status: "MISSING_EVIDENCE",
    reason: "SETTLEMENT_NOT_DUE",
    observationEvidence: { sampleN: 4, settledN: 0, futureOnly: true, duplicateCredited: false, replayCredited: false },
    featureMetrics: healthBody.driftMetrics,
    driftVerdict,
    directionalQuality: { RULE_ONLY: zeroQuality, MODEL_ONLY: zeroQuality, DEPLOYED_FROZEN_BLEND: zeroQuality },
    strategyHealthHandoff,
    PROFITABILITY_PROVEN: false,
    FORWARD_EVIDENCE_SUFFICIENT: false,
    safety: { LIVE_TRADING: false, AUTO_TRADING: false, REAL_ORDER_ENABLED: false, PRIVATE_TRADING_API_ALLOWED: false, executionAuthority: "NONE", orderSubmitted: false },
  };
  const outer = { ...outerBody, evidenceDigest: sha256Canonical(outerBody) };
  return {
    schemaVersion: 3,
    createdAt: Date.parse(CHECKED_AT),
    groups: {
      "crypto-futures-15m": {
        canonicalEvidence: {
          schemaVersion: "prediction-lab-shadow-runtime-evidence-v1",
          runtimeStatus: "MISSING_EVIDENCE",
          runtimeReason: "SETTLEMENT_NOT_DUE",
          strategyIdentityDigest: strategy.strategyIdentityDigest,
          modelIdentityDigest,
          observations: [],
          handoff: outer,
          PROFITABILITY_PROVEN: false,
          FORWARD_EVIDENCE_SUFFICIENT: false,
        },
      },
    },
  };
}

async function writeJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, text);
  return text;
}

function metadata(overrides = {}) {
  return {
    schemaVersion: GITHUB_ARTIFACT_TRANSPORT_SCHEMA_VERSION,
    repository: "seungjae3908-source/seungjae20260713",
    sourceRunId: RUN_ID,
    artifactId: ARTIFACT_ID,
    artifactName: `prediction-lab-shadow-cycle-${RUN_ID}`,
    sourceHeadSha: RESEARCH_SHA,
    expectedArchiveDigest: ARCHIVE_DIGEST,
    downloadedArchiveDigest: ARCHIVE_DIGEST,
    createdAt: ARTIFACT_AT,
    expiresAt: EXPIRES_AT,
    expired: false,
    workflowConclusion: "success",
    replayArtifact: false,
    ...overrides,
  };
}

async function makeArtifact(root, { state = fixtureState(), manifestAt = MANIFEST_AT, runId = RUN_ID, researchSha = RESEARCH_SHA } = {}) {
  await mkdir(root, { recursive: true });
  await writeJson(join(root, "shadow-state.json"), state);
  await writeJson(join(root, "shadow-summary.json"), { schemaVersion: 3, status: "MISSING_EVIDENCE" });
  await writeJson(join(root, "shadow-cycle-provenance.json"), {
    schemaVersion: 2,
    researchCodeSha: researchSha,
    runId,
    producerRunId: "32921992780",
    predecessorShadowRunId: "32925137948",
    branchWrite: false,
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
    scheduleActivated: false,
  });
  const manifest = await buildShadowArtifactPublicationManifestV1({ artifactRoot: root, createdAt: manifestAt });
  await writeJson(join(root, "shadow-artifact-publication-manifest.json"), manifest);
  return { state, manifest };
}

async function resealState(root, state) {
  const stateText = await writeJson(join(root, "shadow-state.json"), state);
  const manifestPath = join(root, "shadow-artifact-publication-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files["shadow-state.json"] = createHash("sha256").update(stateText).digest("hex");
  manifest.stateEvidenceDigest = sha256Canonical(state);
  const handoff = state.groups["crypto-futures-15m"].canonicalEvidence.handoff.strategyHealthHandoff;
  manifest.handoffEvidenceDigests["crypto-futures-15m"] = handoff.evidenceDigest;
  delete manifest.evidenceDigest;
  manifest.evidenceDigest = sha256Canonical(manifest);
  await writeJson(manifestPath, manifest);
}

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), "shadow-transport-v1-"));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function expectClassification(promise, classification) {
  await assert.rejects(promise, (error) => error?.classification === classification);
}

test("valid #704 artifact publishes atomically to the existing canonical state root", () => withWorkspace(async (root) => {
  const artifact = join(root, "artifact");
  const stateRoot = join(root, "state-root");
  await makeArtifact(artifact);
  const result = await publishShadowArtifactToStateRootV1({ artifactRoot: artifact, artifactMetadata: metadata(), stateRoot, asOf: AS_OF });
  assert.equal(result.status, "PUBLISHED");
  assert.equal(result.wrote, true);
  const published = JSON.parse(await readFile(join(stateRoot, "forward", "shadow-state.json"), "utf8"));
  assert.equal(published.canonicalPublication.sourceRunId, RUN_ID);
  assert.equal(published.canonicalPublication.artifactId, ARTIFACT_ID);
  assert.equal(published.canonicalPublication.settledObservationCount, 0);
  assert.equal(published.canonicalPublication.PROFITABILITY_PROVEN, false);
  assert.equal(published.canonicalPublication.FORWARD_EVIDENCE_SUFFICIENT, false);
  assert.equal(published.groups["crypto-futures-15m"].canonicalEvidence.handoff.strategyHealthHandoff.directionalQuality.macroF1, null);
}));

test("missing artifact file fails closed without creating state", () => withWorkspace(async (root) => {
  const artifact = join(root, "artifact");
  const stateRoot = join(root, "state-root");
  await makeArtifact(artifact);
  await rm(join(artifact, "shadow-summary.json"));
  await expectClassification(publishShadowArtifactToStateRootV1({ artifactRoot: artifact, artifactMetadata: metadata(), stateRoot, asOf: AS_OF }), "ARTIFACT_INVALID");
  await assert.rejects(readFile(join(stateRoot, "forward", "shadow-state.json")), /ENOENT/);
}));

test("expired artifact and stale handoff are rejected", () => withWorkspace(async (root) => {
  const artifact = join(root, "artifact");
  await makeArtifact(artifact);
  await expectClassification(validateAndNormalizeShadowArtifactV1({ artifactRoot: artifact, artifactMetadata: metadata({ expiresAt: "2026-08-26T03:06:30.000Z" }), asOf: AS_OF }), "FRESHNESS_REJECTION");

  const stale = join(root, "stale");
  await makeArtifact(stale, { state: fixtureState({ freshnessExpiresAt: "2026-08-26T03:06:30.000Z" }) });
  await expectClassification(validateAndNormalizeShadowArtifactV1({ artifactRoot: stale, artifactMetadata: metadata(), asOf: AS_OF }), "FRESHNESS_REJECTION");
}));

test("tampered artifact bytes and archive digest mismatch are rejected", () => withWorkspace(async (root) => {
  const artifact = join(root, "artifact");
  await makeArtifact(artifact);
  const state = JSON.parse(await readFile(join(artifact, "shadow-state.json"), "utf8"));
  state.groups["crypto-futures-15m"].canonicalEvidence.runtimeReason = "TAMPERED";
  await writeJson(join(artifact, "shadow-state.json"), state);
  await expectClassification(validateAndNormalizeShadowArtifactV1({ artifactRoot: artifact, artifactMetadata: metadata(), asOf: AS_OF }), "DIGEST_PROVENANCE_REJECTION");

  const clean = join(root, "clean");
  await makeArtifact(clean);
  await expectClassification(validateAndNormalizeShadowArtifactV1({ artifactRoot: clean, artifactMetadata: metadata({ downloadedArchiveDigest: "1".repeat(64) }), asOf: AS_OF }), "DIGEST_PROVENANCE_REJECTION");
}));

test("Strategy Identity mismatch is rejected even when container digests are resealed", () => withWorkspace(async (root) => {
  const artifact = join(root, "artifact");
  const built = await makeArtifact(artifact);
  const state = structuredClone(built.state);
  const canonical = state.groups["crypto-futures-15m"].canonicalEvidence;
  canonical.handoff.strategyHealthHandoff.strategyIdentity.strategyVersion = "tampered";
  const health = canonical.handoff.strategyHealthHandoff;
  delete health.evidenceDigest;
  health.evidenceDigest = sha256Canonical(health);
  delete canonical.handoff.evidenceDigest;
  canonical.handoff.evidenceDigest = sha256Canonical(canonical.handoff);
  await resealState(artifact, state);
  await expectClassification(validateAndNormalizeShadowArtifactV1({ artifactRoot: artifact, artifactMetadata: metadata(), asOf: AS_OF }), "IDENTITY_MISMATCH");
}));

test("Model Identity mismatch is rejected even when handoff digests are resealed", () => withWorkspace(async (root) => {
  const artifact = join(root, "artifact");
  const { state } = await makeArtifact(artifact);
  const canonical = state.groups["crypto-futures-15m"].canonicalEvidence;
  const health = canonical.handoff.strategyHealthHandoff;
  health.modelIdentity.exactModelBytesSha = hash("other-model");
  delete health.evidenceDigest;
  health.evidenceDigest = sha256Canonical(health);
  delete canonical.handoff.evidenceDigest;
  canonical.handoff.evidenceDigest = sha256Canonical(canonical.handoff);
  await resealState(artifact, state);
  await expectClassification(validateAndNormalizeShadowArtifactV1({ artifactRoot: artifact, artifactMetadata: metadata(), asOf: AS_OF }), "IDENTITY_MISMATCH");
}));

test("feature order and preprocessing mismatches are rejected", () => withWorkspace(async (root) => {
  for (const field of ["featureOrderDigest", "preprocessingVersion"]) {
    const artifact = join(root, field);
    const { state } = await makeArtifact(artifact);
    const canonical = state.groups["crypto-futures-15m"].canonicalEvidence;
    const health = canonical.handoff.strategyHealthHandoff;
    health.datasetReferenceIdentity[field] = field === "featureOrderDigest" ? hash("different-features") : "different-preprocessing";
    delete health.evidenceDigest;
    health.evidenceDigest = sha256Canonical(health);
    delete canonical.handoff.evidenceDigest;
    canonical.handoff.evidenceDigest = sha256Canonical(canonical.handoff);
    await resealState(artifact, state);
    await expectClassification(validateAndNormalizeShadowArtifactV1({ artifactRoot: artifact, artifactMetadata: metadata(), asOf: AS_OF }), "IDENTITY_MISMATCH");
  }
}));

test("duplicate artifact is idempotent and never overwrites last-good state", () => withWorkspace(async (root) => {
  const artifact = join(root, "artifact");
  const stateRoot = join(root, "state-root");
  await makeArtifact(artifact);
  await publishShadowArtifactToStateRootV1({ artifactRoot: artifact, artifactMetadata: metadata(), stateRoot, asOf: AS_OF });
  const before = await readFile(join(stateRoot, "forward", "shadow-state.json"));
  const duplicate = await publishShadowArtifactToStateRootV1({ artifactRoot: artifact, artifactMetadata: metadata(), stateRoot, asOf: AS_OF });
  const after = await readFile(join(stateRoot, "forward", "shadow-state.json"));
  assert.equal(duplicate.status, "DUPLICATE_ARTIFACT");
  assert.equal(duplicate.wrote, false);
  assert.deepEqual(after, before);
}));

test("older replay artifact cannot replace a newer last-good publication", () => withWorkspace(async (root) => {
  const newer = join(root, "newer");
  const stateRoot = join(root, "state-root");
  await makeArtifact(newer);
  await publishShadowArtifactToStateRootV1({ artifactRoot: newer, artifactMetadata: metadata(), stateRoot, asOf: AS_OF });
  const before = await readFile(join(stateRoot, "forward", "shadow-state.json"));

  const older = join(root, "older");
  await makeArtifact(older, { manifestAt: "2026-08-26T03:01:00.000Z", runId: "32920000000" });
  const oldMetadata = metadata({
    sourceRunId: "32920000000",
    artifactId: "9590000000",
    artifactName: "prediction-lab-shadow-cycle-32920000000",
    createdAt: "2026-08-26T03:02:00.000Z",
    expectedArchiveDigest: "7".repeat(64),
    downloadedArchiveDigest: "7".repeat(64),
  });
  await expectClassification(publishShadowArtifactToStateRootV1({ artifactRoot: older, artifactMetadata: oldMetadata, stateRoot, asOf: AS_OF }), "REPLAY_ARTIFACT");
  assert.deepEqual(await readFile(join(stateRoot, "forward", "shadow-state.json")), before);
}));

test("last-good identity mismatch is rejected without overwriting current state", () => withWorkspace(async (root) => {
  const first = join(root, "first");
  const stateRoot = join(root, "state-root");
  await makeArtifact(first);
  await publishShadowArtifactToStateRootV1({ artifactRoot: first, artifactMetadata: metadata(), stateRoot, asOf: AS_OF });
  const before = await readFile(join(stateRoot, "forward", "shadow-state.json"));

  const second = join(root, "second");
  await makeArtifact(second, {
    state: fixtureState({ strategyVersion: "2" }),
    manifestAt: "2026-08-26T03:08:00.000Z",
    runId: "32930000000",
  });
  const secondMetadata = metadata({
    sourceRunId: "32930000000",
    artifactId: "9593000000",
    artifactName: "prediction-lab-shadow-cycle-32930000000",
    createdAt: "2026-08-26T03:09:00.000Z",
    expiresAt: "2026-11-24T03:09:00.000Z",
    expectedArchiveDigest: "6".repeat(64),
    downloadedArchiveDigest: "6".repeat(64),
  });
  await expectClassification(publishShadowArtifactToStateRootV1({
    artifactRoot: second,
    artifactMetadata: secondMetadata,
    stateRoot,
    asOf: "2026-08-26T03:10:00.000Z",
  }), "IDENTITY_MISMATCH");
  assert.deepEqual(await readFile(join(stateRoot, "forward", "shadow-state.json")), before);
}));

test("future observation timestamp is rejected after intact file resealing", () => withWorkspace(async (root) => {
  const artifact = join(root, "artifact");
  const { state } = await makeArtifact(artifact);
  state.groups["crypto-futures-15m"].canonicalEvidence.observations = [{ observedAt: "2026-08-26T03:08:00.000Z" }];
  await resealState(artifact, state);
  await expectClassification(validateAndNormalizeShadowArtifactV1({ artifactRoot: artifact, artifactMetadata: metadata(), asOf: AS_OF }), "FRESHNESS_REJECTION");
}));

test("publication evidence digest is deterministic for identical artifact identity and asOf", () => withWorkspace(async (root) => {
  const artifact = join(root, "artifact");
  await makeArtifact(artifact);
  const first = await validateAndNormalizeShadowArtifactV1({ artifactRoot: artifact, artifactMetadata: metadata(), asOf: AS_OF });
  const second = await validateAndNormalizeShadowArtifactV1({ artifactRoot: artifact, artifactMetadata: metadata(), asOf: AS_OF });
  assert.equal(first.publication.evidenceDigest, second.publication.evidenceDigest);
  assert.equal(first.publication.observationCount, 4);
  assert.equal(first.publication.settledObservationCount, 0);
  assert.deepEqual(first.publication.missingEvidenceReasons, ["SETTLEMENT_NOT_DUE"]);
}));

test("manifest schema remains exact and profitability cannot be promoted by transport", () => withWorkspace(async (root) => {
  const artifact = join(root, "artifact");
  const { manifest } = await makeArtifact(artifact);
  assert.equal(manifest.schemaVersion, SHADOW_ARTIFACT_PUBLICATION_MANIFEST_SCHEMA_VERSION);
  const normalized = await validateAndNormalizeShadowArtifactV1({ artifactRoot: artifact, artifactMetadata: metadata(), asOf: AS_OF });
  assert.equal(normalized.publication.PROFITABILITY_PROVEN, false);
  assert.equal(normalized.publication.FORWARD_EVIDENCE_SUFFICIENT, false);
  assert.equal(normalized.publication.safety.executionAuthority, "NONE");
}));

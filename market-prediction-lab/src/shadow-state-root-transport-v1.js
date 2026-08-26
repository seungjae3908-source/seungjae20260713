import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { resolveCanonicalStrategyIdentity } from "./canonical-strategy-identity-v1.js";
import { sha256Canonical } from "./research-cache-provenance.js";
import {
  SHADOW_EVIDENCE_HANDOFF_SCHEMA_VERSION,
  STRATEGY_HEALTH_HANDOFF_SCHEMA_VERSION,
} from "./shadow-evidence-handoff-v1.js";

export const SHADOW_ARTIFACT_PUBLICATION_MANIFEST_SCHEMA_VERSION = "prediction-lab-shadow-artifact-publication-manifest-v1";
export const SHADOW_STATE_PUBLICATION_SCHEMA_VERSION = "prediction-lab-shadow-state-publication-v1";
export const GITHUB_ARTIFACT_TRANSPORT_SCHEMA_VERSION = "github-actions-artifact-transport-v1";

const STATE_SCHEMA_VERSION = 3;
const RUNTIME_EVIDENCE_SCHEMA_VERSION = "prediction-lab-shadow-runtime-evidence-v1";
const HASH_64 = /^[0-9a-f]{64}$/u;
const SHA_40 = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const SOURCE_FILES = Object.freeze([
  "shadow-state.json",
  "shadow-summary.json",
  "shadow-cycle-provenance.json",
]);
const MANIFEST_FILE = "shadow-artifact-publication-manifest.json";
const FORBIDDEN_STATE_ROOTS = Object.freeze(["/opt/stock-app-data", "/srv/stock-app", "/var/lib/stock-app"]);
const SAFETY = Object.freeze({
  LIVE_TRADING: false,
  AUTO_TRADING: false,
  REAL_ORDER_ENABLED: false,
  PRIVATE_TRADING_API_ALLOWED: false,
  executionAuthority: "NONE",
  orderSubmitted: false,
});

export class ShadowStateRootTransportError extends Error {
  constructor(classification, reason) {
    super(`${classification}: ${reason}`);
    this.name = "ShadowStateRootTransportError";
    this.classification = classification;
    this.reason = reason;
  }
}

function fail(classification, reason) {
  throw new ShadowStateRootTransportError(classification, reason);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function digest(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/^sha256:/u, "");
  return HASH_64.test(normalized) ? normalized : null;
}

function sha(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SHA_40.test(normalized) ? normalized : null;
}

function positiveIntegerString(value) {
  const normalized = String(value ?? "").trim();
  return POSITIVE_INTEGER.test(normalized) ? normalized : null;
}

function iso(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path, classification, reason) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") fail(classification, reason);
    fail(classification, `${reason}: ${String(error?.message ?? error).slice(0, 180)}`);
  }
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("CURRENT_STATE_INVALID", String(error?.message ?? error).slice(0, 180));
  }
}

async function findArtifactFiles(root) {
  const absoluteRoot = resolve(root);
  const matches = new Map([...SOURCE_FILES, MANIFEST_FILE].map((name) => [name, []]));
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const resolved = resolve(path);
      if (resolved !== absoluteRoot && !resolved.startsWith(`${absoluteRoot}${sep}`)) fail("ARTIFACT_INVALID", "ARTIFACT_PATH_ESCAPE");
      if (entry.isSymbolicLink()) fail("ARTIFACT_INVALID", "ARTIFACT_SYMLINK_REJECTED");
      if (entry.isDirectory()) await visit(path);
      else if (matches.has(entry.name)) matches.get(entry.name).push(path);
    }
  }
  try {
    const stats = await lstat(absoluteRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail("ARTIFACT_MISSING", "ARTIFACT_ROOT_INVALID");
    await visit(absoluteRoot);
  } catch (error) {
    if (error instanceof ShadowStateRootTransportError) throw error;
    fail("ARTIFACT_MISSING", "ARTIFACT_ROOT_MISSING");
  }
  const paths = {};
  for (const [name, rows] of matches) {
    if (name === MANIFEST_FILE && rows.length === 0) continue;
    if (rows.length !== 1) fail("ARTIFACT_INVALID", `${name.toUpperCase().replaceAll(".", "_")}_COUNT_${rows.length}`);
    paths[name] = rows[0];
  }
  return Object.freeze(paths);
}

function canonicalWithoutDigest(value) {
  const body = structuredClone(value);
  delete body.evidenceDigest;
  return body;
}

function assertCanonicalDigest(value, classification, reason) {
  if (!object(value) || !digest(value.evidenceDigest) || sha256Canonical(canonicalWithoutDigest(value)) !== digest(value.evidenceDigest)) {
    fail(classification, reason);
  }
}

function assertNoFutureTimestamp(value, asOf, reason) {
  const timestamp = iso(value);
  if (!timestamp || Date.parse(timestamp) > Date.parse(asOf)) fail("FRESHNESS_REJECTION", reason);
  return timestamp;
}

function validateQuality(quality, expectedSettledN, label) {
  if (!object(quality) || !Number.isInteger(quality.settledN) || quality.settledN < 0 || quality.settledN !== expectedSettledN) {
    fail("SCHEMA_MISMATCH", `${label}_SETTLED_N_INVALID`);
  }
  if (expectedSettledN === 0) {
    for (const field of ["bullRecall", "bearRecall", "precision", "recall", "macroF1", "balancedAccuracy", "brier", "logLoss"]) {
      if (quality[field] !== null) fail("SCHEMA_MISMATCH", `${label}_${field.toUpperCase()}_MUST_BE_NULL_AT_N0`);
    }
    for (const field of ["LONG", "SHORT", "NEUTRAL"]) {
      if (object(quality.directionRatio)?.[field] !== null) fail("SCHEMA_MISMATCH", `${label}_${field}_RATIO_MUST_BE_NULL_AT_N0`);
    }
  }
}

function validateStrategyHealthHandoff(handoff, asOf) {
  if (!object(handoff) || handoff.schemaVersion !== STRATEGY_HEALTH_HANDOFF_SCHEMA_VERSION || handoff.executionAuthority !== "NONE") {
    fail("SCHEMA_MISMATCH", "STRATEGY_HEALTH_HANDOFF_SCHEMA_INVALID");
  }
  assertCanonicalDigest(handoff, "DIGEST_PROVENANCE_REJECTION", "STRATEGY_HEALTH_HANDOFF_DIGEST_MISMATCH");
  const resolved = resolveCanonicalStrategyIdentity(handoff.strategyIdentity ?? {});
  if (resolved.status !== "IDENTITY_COMPLETE" || digest(handoff.strategyIdentityDigest) !== resolved.strategyIdentityDigest) {
    fail("IDENTITY_MISMATCH", "STRATEGY_IDENTITY_MISMATCH");
  }
  const model = object(handoff.modelIdentity);
  if (!model || digest(handoff.modelIdentityDigest) !== sha256Canonical(model)
      || digest(model.strategyIdentityDigest) !== resolved.strategyIdentityDigest
      || !digest(model.exactModelBytesSha) || !digest(model.canonicalModelArtifactDigest)
      || !digest(model.featureOrderDigest) || !String(model.preprocessingVersion ?? "").trim()
      || !sha(model.trainingRunIdentity?.trainingCodeSha)
      || !digest(model.trainingRunIdentity?.outerArtifactDigest)
      || !digest(model.trainingRunIdentity?.rawArtifactDigest)
      || digest(model.trainingRunIdentityDigest) !== sha256Canonical(model.trainingRunIdentity)) {
    fail("IDENTITY_MISMATCH", "MODEL_IDENTITY_MISMATCH");
  }
  const reference = object(handoff.datasetReferenceIdentity);
  if (!reference || !object(model.datasetIdentity)
      || model.datasetIdentity.datasetId !== reference.datasetId
      || digest(model.datasetIdentity.datasetDigest) !== digest(reference.datasetDigest)
      || digest(model.datasetIdentityDigest) !== digest(reference.datasetDigest)
      || digest(model.featureOrderDigest) !== digest(reference.featureOrderDigest)
      || model.preprocessingVersion !== reference.preprocessingVersion
      || !digest(reference.trainSplitDigest) || !digest(reference.validationSplitDigest)
      || !digest(reference.rawArtifactDigest)) {
    fail("IDENTITY_MISMATCH", "REFERENCE_IDENTITY_MISMATCH");
  }
  if (!Number.isInteger(handoff.sampleN) || handoff.sampleN < 0
      || !Number.isInteger(handoff.settledN) || handoff.settledN < 0 || handoff.settledN > handoff.sampleN
      || !Number.isInteger(handoff.referenceN) || handoff.referenceN <= 0) {
    fail("SCHEMA_MISMATCH", "SHADOW_SAMPLE_COUNTS_INVALID");
  }
  const freshness = object(handoff.freshness);
  const checkedAt = iso(freshness?.checkedAt);
  const expiresAt = iso(freshness?.expiresAt);
  if (freshness?.status !== "FRESH" || !checkedAt || !expiresAt
      || Date.parse(checkedAt) > Date.parse(asOf) || Date.parse(expiresAt) <= Date.parse(asOf)) {
    fail("FRESHNESS_REJECTION", "SHADOW_HANDOFF_STALE_OR_FUTURE");
  }
  validateQuality(handoff.directionalQuality, handoff.settledN, "DIRECTIONAL_QUALITY");
  validateQuality(handoff.ruleOnlyQuality, handoff.settledN, "RULE_ONLY_QUALITY");
  validateQuality(handoff.modelOnlyQuality, handoff.settledN, "MODEL_ONLY_QUALITY");
  validateQuality(handoff.blendQuality, handoff.settledN, "FROZEN_BLEND_QUALITY");
  if (!object(handoff.driftVerdict) || !Array.isArray(handoff.driftMetrics) || !Array.isArray(handoff.missingEvidence)) {
    fail("SCHEMA_MISMATCH", "DRIFT_EVIDENCE_INVALID");
  }
  if (handoff.settledN === 0) {
    if (handoff.driftVerdict.status !== "NOT_EVALUABLE"
        || handoff.driftVerdict.psi !== null || handoff.driftVerdict.ksStatistic !== null || handoff.driftVerdict.jsd !== null
        || handoff.missingEvidence.length === 0) {
      fail("SCHEMA_MISMATCH", "SETTLED_N0_MUST_REMAIN_MISSING_EVIDENCE");
    }
    for (const metric of handoff.driftMetrics) {
      if (metric.psi !== null || metric.ksStatistic !== null || metric.jsd !== null) {
        fail("SCHEMA_MISMATCH", "DRIFT_METRICS_MUST_BE_NULL_AT_N0");
      }
    }
  }
  return Object.freeze({
    strategyIdentityDigest: resolved.strategyIdentityDigest,
    modelIdentityDigest: digest(handoff.modelIdentityDigest),
    evidenceDigest: digest(handoff.evidenceDigest),
    producerArtifactDigest: digest(model.trainingRunIdentity.outerArtifactDigest),
    producerArtifactId: String(model.trainingRunIdentity.artifactId),
    observationCount: handoff.sampleN,
    settledObservationCount: handoff.settledN,
    missingEvidenceReasons: [...handoff.missingEvidence],
  });
}

function validateState(state, asOf) {
  if (!object(state) || state.schemaVersion !== STATE_SCHEMA_VERSION || !object(state.groups)) fail("SCHEMA_MISMATCH", "SHADOW_STATE_SCHEMA_INVALID");
  const handoffs = [];
  for (const [group, row] of Object.entries(state.groups).sort(([left], [right]) => left.localeCompare(right))) {
    const canonical = object(row?.canonicalEvidence);
    if (!canonical) continue;
    if (canonical.schemaVersion !== RUNTIME_EVIDENCE_SCHEMA_VERSION || !object(canonical.handoff)) {
      fail("SCHEMA_MISMATCH", `CANONICAL_RUNTIME_EVIDENCE_INVALID:${group}`);
    }
    const outer = canonical.handoff;
    if (outer.schemaVersion !== SHADOW_EVIDENCE_HANDOFF_SCHEMA_VERSION) fail("SCHEMA_MISMATCH", `SHADOW_HANDOFF_SCHEMA_INVALID:${group}`);
    if (canonical.PROFITABILITY_PROVEN !== false || canonical.FORWARD_EVIDENCE_SUFFICIENT !== false
        || outer.PROFITABILITY_PROVEN !== false || outer.FORWARD_EVIDENCE_SUFFICIENT !== false
        || outer.safety?.executionAuthority !== "NONE" || outer.safety?.LIVE_TRADING !== false
        || outer.safety?.REAL_ORDER_ENABLED !== false || outer.safety?.PRIVATE_TRADING_API_ALLOWED !== false) {
      fail("DIGEST_PROVENANCE_REJECTION", `SHADOW_SAFETY_OR_PROFITABILITY_AUTHORITY_INVALID:${group}`);
    }
    assertCanonicalDigest(outer, "DIGEST_PROVENANCE_REJECTION", `SHADOW_HANDOFF_DIGEST_MISMATCH:${group}`);
    const validated = validateStrategyHealthHandoff(outer.strategyHealthHandoff, asOf);
    if (digest(canonical.strategyIdentityDigest) !== validated.strategyIdentityDigest
        || digest(canonical.modelIdentityDigest) !== validated.modelIdentityDigest) {
      fail("IDENTITY_MISMATCH", `CANONICAL_RUNTIME_IDENTITY_MISMATCH:${group}`);
    }
    for (const observation of Array.isArray(canonical.observations) ? canonical.observations : []) {
      if (observation.observedAt != null) assertNoFutureTimestamp(observation.observedAt, asOf, `FUTURE_OBSERVATION:${group}`);
      if (observation.settlement?.settledAt != null) assertNoFutureTimestamp(observation.settlement.settledAt, asOf, `FUTURE_SETTLEMENT:${group}`);
    }
    handoffs.push(Object.freeze({ group, ...validated }));
  }
  if (!handoffs.length) fail("MISSING_EVIDENCE", "CANONICAL_SHADOW_HANDOFF_MISSING");
  return Object.freeze(handoffs);
}

function normalizedFileDigests(files) {
  return Object.freeze(Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))));
}

export async function buildShadowArtifactPublicationManifestV1({ artifactRoot, createdAt = new Date().toISOString() } = {}) {
  const canonicalCreatedAt = iso(createdAt);
  if (!canonicalCreatedAt) fail("FRESHNESS_REJECTION", "MANIFEST_CREATED_AT_INVALID");
  const paths = await findArtifactFiles(artifactRoot);
  const [stateBytes, summaryBytes, provenanceBytes] = await Promise.all(SOURCE_FILES.map((name) => readFile(paths[name])));
  const [state, summary, provenance] = await Promise.all([
    readJson(paths["shadow-state.json"], "ARTIFACT_INVALID", "SHADOW_STATE_JSON_INVALID"),
    readJson(paths["shadow-summary.json"], "ARTIFACT_INVALID", "SHADOW_SUMMARY_JSON_INVALID"),
    readJson(paths["shadow-cycle-provenance.json"], "ARTIFACT_INVALID", "SHADOW_PROVENANCE_JSON_INVALID"),
  ]);
  if (!object(summary)) fail("SCHEMA_MISMATCH", "SHADOW_SUMMARY_SCHEMA_INVALID");
  if (!object(provenance) || provenance.schemaVersion !== 2 || !positiveIntegerString(provenance.runId)
      || !positiveIntegerString(provenance.producerRunId)
      || !sha(provenance.researchCodeSha) || provenance.branchWrite !== false || provenance.liveOrderAllowed !== false
      || provenance.privateAccountRequestAllowed !== false || provenance.scheduleActivated !== false) {
    fail("DIGEST_PROVENANCE_REJECTION", "SHADOW_PROVENANCE_INVALID");
  }
  const handoffs = validateState(state, canonicalCreatedAt);
  const files = normalizedFileDigests({
    "shadow-state.json": sha256Bytes(stateBytes),
    "shadow-summary.json": sha256Bytes(summaryBytes),
    "shadow-cycle-provenance.json": sha256Bytes(provenanceBytes),
  });
  const body = {
    schemaVersion: SHADOW_ARTIFACT_PUBLICATION_MANIFEST_SCHEMA_VERSION,
    repository: process.env.GITHUB_REPOSITORY || null,
    sourceRunId: String(provenance.runId),
    researchCodeSha: sha(provenance.researchCodeSha),
    producerRunId: positiveIntegerString(provenance.producerRunId),
    predecessorShadowRunId: positiveIntegerString(provenance.predecessorShadowRunId),
    createdAt: canonicalCreatedAt,
    files,
    stateEvidenceDigest: sha256Canonical(state),
    handoffEvidenceDigests: Object.freeze(Object.fromEntries(handoffs.map((row) => [row.group, row.evidenceDigest]))),
    replayArtifact: false,
    duplicateArtifact: false,
    safety: SAFETY,
  };
  return Object.freeze({ ...body, evidenceDigest: sha256Canonical(body) });
}

function validateArtifactMetadata(metadata, provenance, manifest, asOf) {
  const value = object(metadata);
  if (!value || value.schemaVersion !== GITHUB_ARTIFACT_TRANSPORT_SCHEMA_VERSION) fail("DIGEST_PROVENANCE_REJECTION", "ARTIFACT_METADATA_SCHEMA_INVALID");
  const sourceRunId = positiveIntegerString(value.sourceRunId);
  const artifactId = positiveIntegerString(value.artifactId);
  const sourceHeadSha = sha(value.sourceHeadSha);
  const expectedArchiveDigest = digest(value.expectedArchiveDigest);
  const downloadedArchiveDigest = digest(value.downloadedArchiveDigest);
  const createdAt = iso(value.createdAt);
  const expiresAt = iso(value.expiresAt);
  if (!sourceRunId || !artifactId || !sourceHeadSha || !expectedArchiveDigest || !downloadedArchiveDigest
      || expectedArchiveDigest !== downloadedArchiveDigest || value.expired !== false || value.workflowConclusion !== "success") {
    fail("DIGEST_PROVENANCE_REJECTION", "ARTIFACT_METADATA_INVALID_OR_DIGEST_MISMATCH");
  }
  if (value.artifactName !== `prediction-lab-shadow-cycle-${sourceRunId}`
      || sourceRunId !== String(provenance.runId) || sourceRunId !== String(manifest.sourceRunId)
      || sourceHeadSha !== sha(provenance.researchCodeSha) || sourceHeadSha !== sha(manifest.researchCodeSha)) {
    fail("DIGEST_PROVENANCE_REJECTION", "ARTIFACT_RUN_OR_HEAD_PROVENANCE_MISMATCH");
  }
  const metadataRepository = String(value.repository ?? "").trim();
  const manifestRepository = String(manifest.repository ?? "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(metadataRepository) || (manifestRepository && metadataRepository !== manifestRepository)) {
    fail("DIGEST_PROVENANCE_REJECTION", "ARTIFACT_REPOSITORY_PROVENANCE_MISMATCH");
  }
  if (!createdAt || !expiresAt || Date.parse(createdAt) > Date.parse(asOf) || Date.parse(expiresAt) <= Date.parse(asOf)
      || Date.parse(manifest.createdAt) > Date.parse(asOf) || Date.parse(manifest.createdAt) > Date.parse(createdAt)) {
    fail("FRESHNESS_REJECTION", "ARTIFACT_EXPIRED_STALE_OR_FUTURE");
  }
  if (value.replayArtifact === true || manifest.replayArtifact !== false || manifest.duplicateArtifact !== false) {
    fail("REPLAY_ARTIFACT", "ARTIFACT_REPLAY_FLAGGED");
  }
  return Object.freeze({
    repository: metadataRepository,
    artifactId,
    artifactName: value.artifactName,
    artifactDigest: expectedArchiveDigest,
    sourceRunId,
    sourceHeadSha,
    createdAt,
    expiresAt,
  });
}

function validateManifest(manifest, state, fileBytes, handoffs) {
  if (!object(manifest) || manifest.schemaVersion !== SHADOW_ARTIFACT_PUBLICATION_MANIFEST_SCHEMA_VERSION) fail("SCHEMA_MISMATCH", "PUBLICATION_MANIFEST_SCHEMA_INVALID");
  assertCanonicalDigest(manifest, "DIGEST_PROVENANCE_REJECTION", "PUBLICATION_MANIFEST_DIGEST_MISMATCH");
  for (const name of SOURCE_FILES) {
    if (digest(manifest.files?.[name]) !== sha256Bytes(fileBytes[name])) fail("DIGEST_PROVENANCE_REJECTION", `ARTIFACT_FILE_DIGEST_MISMATCH:${name}`);
  }
  if (digest(manifest.stateEvidenceDigest) !== sha256Canonical(state)) fail("DIGEST_PROVENANCE_REJECTION", "SHADOW_STATE_EVIDENCE_DIGEST_MISMATCH");
  for (const handoff of handoffs) {
    if (digest(manifest.handoffEvidenceDigests?.[handoff.group]) !== handoff.evidenceDigest) {
      fail("DIGEST_PROVENANCE_REJECTION", `HANDOFF_EVIDENCE_DIGEST_MISMATCH:${handoff.group}`);
    }
  }
}

export async function validateAndNormalizeShadowArtifactV1({ artifactRoot, artifactMetadata, asOf = new Date().toISOString() } = {}) {
  const canonicalAsOf = iso(asOf);
  if (!canonicalAsOf) fail("FRESHNESS_REJECTION", "TRANSPORT_AS_OF_INVALID");
  const paths = await findArtifactFiles(artifactRoot);
  if (!paths[MANIFEST_FILE]) fail("ARTIFACT_MISSING", "PUBLICATION_MANIFEST_MISSING");
  const fileBytes = Object.fromEntries(await Promise.all(SOURCE_FILES.map(async (name) => [name, await readFile(paths[name])])));
  const [state, summary, provenance, manifest] = await Promise.all([
    readJson(paths["shadow-state.json"], "ARTIFACT_INVALID", "SHADOW_STATE_JSON_INVALID"),
    readJson(paths["shadow-summary.json"], "ARTIFACT_INVALID", "SHADOW_SUMMARY_JSON_INVALID"),
    readJson(paths["shadow-cycle-provenance.json"], "ARTIFACT_INVALID", "SHADOW_PROVENANCE_JSON_INVALID"),
    readJson(paths[MANIFEST_FILE], "ARTIFACT_INVALID", "PUBLICATION_MANIFEST_JSON_INVALID"),
  ]);
  if (!object(summary) || !object(provenance) || provenance.schemaVersion !== 2) fail("SCHEMA_MISMATCH", "SHADOW_ARTIFACT_SCHEMA_INVALID");
  const handoffs = validateState(state, canonicalAsOf);
  validateManifest(manifest, state, fileBytes, handoffs);
  const metadata = validateArtifactMetadata(artifactMetadata, provenance, manifest, canonicalAsOf);
  const missingEvidenceReasons = [...new Set(handoffs.flatMap((row) => row.missingEvidenceReasons).filter(Boolean))].sort();
  const publicationBody = {
    schemaVersion: SHADOW_STATE_PUBLICATION_SCHEMA_VERSION,
    sourceType: "GITHUB_ACTIONS_ARTIFACT",
    repository: metadata.repository,
    sourceRunId: metadata.sourceRunId,
    artifactId: metadata.artifactId,
    artifactName: metadata.artifactName,
    producerRunId: positiveIntegerString(provenance.producerRunId),
    predecessorShadowRunId: positiveIntegerString(provenance.predecessorShadowRunId),
    researchCodeSha: metadata.sourceHeadSha,
    artifactCreatedAt: metadata.createdAt,
    artifactExpiresAt: metadata.expiresAt,
    shadowArtifactDigest: metadata.artifactDigest,
    sourceShadowStateSha256: sha256Bytes(fileBytes["shadow-state.json"]),
    sourceShadowSummarySha256: sha256Bytes(fileBytes["shadow-summary.json"]),
    sourceProvenanceSha256: sha256Bytes(fileBytes["shadow-cycle-provenance.json"]),
    manifestEvidenceDigest: digest(manifest.evidenceDigest),
    producerArtifacts: Object.freeze(handoffs.map((row) => Object.freeze({ group: row.group, artifactId: row.producerArtifactId, artifactDigest: row.producerArtifactDigest }))),
    handoffEvidenceDigests: Object.freeze(Object.fromEntries(handoffs.map((row) => [row.group, row.evidenceDigest]))),
    strategyModelIdentities: Object.freeze(handoffs.map((row) => Object.freeze({ group: row.group, strategyIdentityDigest: row.strategyIdentityDigest, modelIdentityDigest: row.modelIdentityDigest }))),
    observationCount: handoffs.reduce((sum, row) => sum + row.observationCount, 0),
    settledObservationCount: handoffs.reduce((sum, row) => sum + row.settledObservationCount, 0),
    missingEvidenceReasons: Object.freeze(missingEvidenceReasons),
    freshness: Object.freeze({ status: "FRESH", checkedAt: canonicalAsOf, expiresAt: metadata.expiresAt }),
    publishedAt: canonicalAsOf,
    replayArtifact: false,
    duplicateArtifact: false,
    PROFITABILITY_PROVEN: false,
    FORWARD_EVIDENCE_SUFFICIENT: false,
    safety: SAFETY,
  };
  const publication = Object.freeze({ ...publicationBody, evidenceDigest: sha256Canonical(publicationBody) });
  return Object.freeze({
    status: "VALID",
    state: Object.freeze({ ...state, canonicalPublication: publication }),
    publication,
    handoffs,
    safety: SAFETY,
  });
}

function identityPairs(state) {
  if (!object(state?.groups)) return new Map();
  const pairs = new Map();
  for (const [group, row] of Object.entries(state.groups)) {
    const handoff = row?.canonicalEvidence?.handoff?.strategyHealthHandoff;
    if (object(handoff) && digest(handoff.strategyIdentityDigest) && digest(handoff.modelIdentityDigest)) {
      pairs.set(group, `${digest(handoff.strategyIdentityDigest)}:${digest(handoff.modelIdentityDigest)}`);
    }
  }
  return pairs;
}

function assertLastGoodCompatibility(current, next) {
  const currentPublication = object(current?.canonicalPublication);
  const nextPublication = next.publication;
  if (currentPublication) {
    assertCanonicalDigest(currentPublication, "CURRENT_STATE_INVALID", "CURRENT_PUBLICATION_DIGEST_INVALID");
    if (String(currentPublication.artifactId) === nextPublication.artifactId
        || digest(currentPublication.shadowArtifactDigest) === digest(nextPublication.shadowArtifactDigest)) {
      return "DUPLICATE_ARTIFACT";
    }
    if (!iso(currentPublication.artifactCreatedAt) || Date.parse(nextPublication.artifactCreatedAt) <= Date.parse(currentPublication.artifactCreatedAt)) {
      fail("REPLAY_ARTIFACT", "ARTIFACT_NOT_NEWER_THAN_LAST_GOOD");
    }
  }
  const currentPairs = identityPairs(current);
  const nextPairs = identityPairs(next.state);
  for (const [group, pair] of currentPairs) {
    if (nextPairs.has(group) && nextPairs.get(group) !== pair) fail("IDENTITY_MISMATCH", `LAST_GOOD_IDENTITY_MISMATCH:${group}`);
  }
  return "COMPATIBLE";
}

function assertSafeStateRoot(stateRoot) {
  if (!stateRoot || !isAbsolute(stateRoot)) fail("STATE_ROOT_INVALID", "STATE_ROOT_MUST_BE_ABSOLUTE");
  const root = resolve(stateRoot);
  for (const forbidden of FORBIDDEN_STATE_ROOTS) {
    const candidate = resolve(forbidden);
    if (root === candidate || root.startsWith(`${candidate}${sep}`)) fail("STATE_ROOT_INVALID", "STATE_ROOT_OVERLAPS_PROTECTED_APPLICATION_STORAGE");
  }
  const target = resolve(root, "forward", "shadow-state.json");
  if (relative(root, target).startsWith("..")) fail("STATE_ROOT_INVALID", "STATE_ROOT_TARGET_ESCAPE");
  return Object.freeze({ root, target });
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function publishShadowArtifactToStateRootV1({ artifactRoot, artifactMetadata, stateRoot, asOf = new Date().toISOString() } = {}) {
  const paths = assertSafeStateRoot(stateRoot);
  const normalized = await validateAndNormalizeShadowArtifactV1({ artifactRoot, artifactMetadata, asOf });
  const current = await readOptionalJson(paths.target);
  const compatibility = current ? assertLastGoodCompatibility(current, normalized) : "COMPATIBLE";
  if (compatibility === "DUPLICATE_ARTIFACT") {
    return Object.freeze({ status: "DUPLICATE_ARTIFACT", wrote: false, statePath: paths.target, publication: normalized.publication, safety: SAFETY });
  }
  await atomicWriteJson(paths.target, normalized.state);
  return Object.freeze({ status: "PUBLISHED", wrote: true, statePath: paths.target, publication: normalized.publication, safety: SAFETY });
}

export function shadowStateRootTransportSafetyV1() {
  return SAFETY;
}

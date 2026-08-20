import { researchDigest } from "./research-trial-registry.js";

export const GLOBAL_EVIDENCE_LEDGER_SCHEMA_VERSION = 2;
export const EVIDENCE_ACCEPTED = "EVIDENCE_ACCEPTED";
export const DUPLICATE_ACCEPTED_ONCE = "DUPLICATE_ACCEPTED_ONCE";
export const EVIDENCE_ID_CONFLICT = "EVIDENCE_ID_CONFLICT";
export const ARTIFACT_CHAIN_BROKEN = "ARTIFACT_CHAIN_BROKEN";

const SHA40 = /^[0-9a-f]{40}$/i;
const DIGEST64 = /^[0-9a-f]{64}$/i;

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function requiredSha(value) {
  const sha = requiredString(value, "researchCodeSha");
  if (!SHA40.test(sha)) throw new TypeError("researchCodeSha must be an exact 40-character SHA");
  return sha.toLowerCase();
}

function requiredDigest(value, name) {
  const digest = requiredString(value, name).toLowerCase();
  if (!DIGEST64.test(digest)) throw new TypeError(`${name} must be a 64-character SHA-256 digest`);
  return digest;
}

function requiredTimestamp(value) {
  if (Number.isInteger(value) && value > 0) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
    throw new TypeError("observationTimestamp must be a valid timestamp");
  }
  const text = requiredString(value, "observationTimestamp");
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new TypeError("observationTimestamp must be a valid timestamp");
  return new Date(timestamp).toISOString();
}

function canonicalEvidenceIdentity(raw) {
  return Object.freeze({
    producerFamily: requiredString(raw?.producerFamily, "producerFamily"),
    strategyIdentityDigest: requiredDigest(raw?.strategyIdentityDigest, "strategyIdentityDigest"),
    researchCodeSha: requiredSha(raw?.researchCodeSha),
    market: requiredString(raw?.market, "market"),
    symbol: requiredString(raw?.symbol, "symbol"),
    timeframe: requiredString(raw?.timeframe, "timeframe"),
    side: requiredString(raw?.side, "side"),
    observationTimestamp: requiredTimestamp(raw?.observationTimestamp),
    horizon: requiredString(raw?.horizon, "horizon"),
    sourceDatasetId: requiredString(raw?.sourceDatasetId, "sourceDatasetId"),
    provenanceDigest: requiredDigest(raw?.provenanceDigest, "provenanceDigest"),
    outcomeKind: requiredString(raw?.outcomeKind, "outcomeKind"),
  });
}

function runtimeProvenance(raw) {
  const source = Object.freeze({
    workflowFamily: requiredString(raw?.workflowFamily, "workflowFamily"),
    artifactLineageDigest: requiredDigest(raw?.artifactLineageDigest, "artifactLineageDigest"),
  });
  return Object.freeze({ ...source, sourceDigest: researchDigest(source) });
}

export function buildGlobalEvidenceId(raw) {
  return `evidence-v2:${researchDigest(canonicalEvidenceIdentity(raw))}`;
}

function ledgerCore({ ledgerId, predecessorDigest, records, duplicateAttempts, conflicts }) {
  return Object.freeze({
    schemaVersion: GLOBAL_EVIDENCE_LEDGER_SCHEMA_VERSION,
    ledgerId,
    predecessorDigest,
    records,
    duplicateAttempts,
    conflicts,
    safety: Object.freeze({
      canonicalUniqueEvidenceOnly: true,
      runtimeProvenanceExcludedFromSampleIdentity: true,
      canonicalStrategyIdentityDigestRequired: true,
      duplicateSampleCountIncrement: 0,
      conflictSampleCountIncrement: 0,
      historicalBackfillAllowed: false,
      forwardEvidenceCanSelectCandidate: false,
      liveTradingAllowed: false,
      privateTradingApiAllowed: false,
      orderAuthority: false,
    }),
  });
}

function withDigest(core) {
  return Object.freeze({ ...core, ledgerDigest: researchDigest(core) });
}

export function createGlobalEvidenceLedger({ ledgerId = "GLOBAL_EVIDENCE_LEDGER_V2" } = {}) {
  return withDigest(ledgerCore({
    ledgerId: requiredString(ledgerId, "ledgerId"),
    predecessorDigest: null,
    records: Object.freeze([]),
    duplicateAttempts: Object.freeze([]),
    conflicts: Object.freeze([]),
  }));
}

function verifyRecord(record) {
  if (!record || typeof record !== "object") return false;
  if (record.evidenceId !== `evidence-v2:${researchDigest(record.identity)}`) return false;
  if (record.payloadDigest !== researchDigest(record.payload)) return false;
  if (record.canonicalSampleContribution !== 1) return false;
  if (!Array.isArray(record.sources) || record.sources.length === 0) return false;
  const sourceDigests = new Set();
  for (const source of record.sources) {
    if (!source || source.sourceDigest !== researchDigest({
      workflowFamily: source.workflowFamily,
      artifactLineageDigest: source.artifactLineageDigest,
    })) return false;
    if (sourceDigests.has(source.sourceDigest)) return false;
    sourceDigests.add(source.sourceDigest);
  }
  return true;
}

export function verifyGlobalEvidenceLedger(ledger) {
  if (!ledger || ledger.schemaVersion !== GLOBAL_EVIDENCE_LEDGER_SCHEMA_VERSION) {
    return Object.freeze({ valid: false, reason: ARTIFACT_CHAIN_BROKEN });
  }
  const expectedCore = ledgerCore({
    ledgerId: ledger.ledgerId,
    predecessorDigest: ledger.predecessorDigest ?? null,
    records: Object.freeze([...(ledger.records ?? [])]),
    duplicateAttempts: Object.freeze([...(ledger.duplicateAttempts ?? [])]),
    conflicts: Object.freeze([...(ledger.conflicts ?? [])]),
  });
  const digestValid = researchDigest(expectedCore) === ledger.ledgerDigest;
  const ids = (ledger.records ?? []).map((record) => record.evidenceId);
  const uniqueIds = new Set(ids);
  const recordsValid = (ledger.records ?? []).every(verifyRecord);
  if (!digestValid || ids.length !== uniqueIds.size || !recordsValid) {
    return Object.freeze({ valid: false, reason: ARTIFACT_CHAIN_BROKEN });
  }
  return Object.freeze({ valid: true, reason: null });
}

function successor(ledger, { records, duplicateAttempts, conflicts }) {
  const verification = verifyGlobalEvidenceLedger(ledger);
  if (!verification.valid) throw new Error(ARTIFACT_CHAIN_BROKEN);
  return withDigest(ledgerCore({
    ledgerId: ledger.ledgerId,
    predecessorDigest: ledger.ledgerDigest,
    records: Object.freeze(records),
    duplicateAttempts: Object.freeze(duplicateAttempts),
    conflicts: Object.freeze(conflicts),
  }));
}

export function assertGlobalEvidenceContinuity(predecessor, current) {
  const predecessorVerification = verifyGlobalEvidenceLedger(predecessor);
  const currentVerification = verifyGlobalEvidenceLedger(current);
  if (!predecessorVerification.valid || !currentVerification.valid || current.predecessorDigest !== predecessor.ledgerDigest) {
    throw new Error(ARTIFACT_CHAIN_BROKEN);
  }
  return true;
}

export function recordGlobalEvidence(ledger, raw) {
  const verification = verifyGlobalEvidenceLedger(ledger);
  if (!verification.valid) throw new Error(ARTIFACT_CHAIN_BROKEN);
  const identity = canonicalEvidenceIdentity(raw);
  const source = runtimeProvenance(raw);
  const evidenceId = `evidence-v2:${researchDigest(identity)}`;
  const payload = Object.freeze({ ...(raw?.payload ?? {}) });
  const payloadDigest = researchDigest(payload);
  const existing = ledger.records.find((record) => record.evidenceId === evidenceId);

  if (!existing) {
    const record = Object.freeze({
      evidenceId,
      identity,
      payload,
      payloadDigest,
      sources: Object.freeze([source]),
      canonicalSampleContribution: 1,
    });
    const next = successor(ledger, {
      records: [...ledger.records, record],
      duplicateAttempts: [...ledger.duplicateAttempts],
      conflicts: [...ledger.conflicts],
    });
    return Object.freeze({ status: EVIDENCE_ACCEPTED, evidenceId, sampleCountDelta: 1, conflict: false, ledger: next });
  }

  if (existing.payloadDigest === payloadDigest) {
    const sourceAlreadyRecorded = existing.sources.some((item) => item.sourceDigest === source.sourceDigest);
    const updatedRecord = sourceAlreadyRecorded
      ? existing
      : Object.freeze({ ...existing, sources: Object.freeze([...existing.sources, source]) });
    const duplicate = Object.freeze({
      evidenceId,
      payloadDigest,
      sourceDigest: source.sourceDigest,
      sourceAlreadyRecorded,
      acceptedCanonicalRecordDigest: existing.payloadDigest,
    });
    const next = successor(ledger, {
      records: ledger.records.map((record) => record.evidenceId === evidenceId ? updatedRecord : record),
      duplicateAttempts: [...ledger.duplicateAttempts, duplicate],
      conflicts: [...ledger.conflicts],
    });
    return Object.freeze({ status: DUPLICATE_ACCEPTED_ONCE, evidenceId, sampleCountDelta: 0, conflict: false, ledger: next });
  }

  const conflict = Object.freeze({
    evidenceId,
    canonicalPayloadDigest: existing.payloadDigest,
    conflictingPayloadDigest: payloadDigest,
    conflictingSourceDigest: source.sourceDigest,
    status: EVIDENCE_ID_CONFLICT,
  });
  const next = successor(ledger, {
    records: [...ledger.records],
    duplicateAttempts: [...ledger.duplicateAttempts],
    conflicts: [...ledger.conflicts, conflict],
  });
  return Object.freeze({ status: EVIDENCE_ID_CONFLICT, evidenceId, sampleCountDelta: 0, conflict: true, ledger: next });
}

export function canonicalUniqueEvidence(ledger, filters = {}) {
  const verification = verifyGlobalEvidenceLedger(ledger);
  if (!verification.valid) throw new Error(ARTIFACT_CHAIN_BROKEN);
  if (ledger.conflicts.length > 0) throw new Error(EVIDENCE_ID_CONFLICT);
  const rows = ledger.records.filter((record) => Object.entries(filters).every(([key, value]) => {
    if (value == null) return true;
    return record.identity?.[key] === value;
  }));
  return Object.freeze(rows);
}

export function summarizeGlobalEvidenceLedger(ledger) {
  const verification = verifyGlobalEvidenceLedger(ledger);
  if (!verification.valid) throw new Error(ARTIFACT_CHAIN_BROKEN);
  const byProducer = {};
  let runtimeSourceCount = 0;
  for (const record of ledger.records) {
    byProducer[record.identity.producerFamily] = (byProducer[record.identity.producerFamily] ?? 0) + 1;
    runtimeSourceCount += record.sources.length;
  }
  return Object.freeze({
    ledgerId: ledger.ledgerId,
    ledgerDigest: ledger.ledgerDigest,
    predecessorDigest: ledger.predecessorDigest,
    canonicalUniqueEvidenceCount: ledger.records.length,
    runtimeSourceCount,
    duplicateAcceptedOnceCount: ledger.duplicateAttempts.length,
    conflictCount: ledger.conflicts.length,
    byProducer: Object.freeze(byProducer),
    failClosed: ledger.conflicts.length > 0,
  });
}

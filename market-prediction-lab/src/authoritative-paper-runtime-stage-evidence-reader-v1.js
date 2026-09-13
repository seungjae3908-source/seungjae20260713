export const AUTHORITATIVE_PAPER_RUNTIME_STAGE_EVIDENCE_READER_VERSION =
  "authoritative-paper-runtime-stage-evidence-reader-v1";

const CANONICAL_LOOP_EVIDENCE = "canonical-natural-paper-loop-stage-evidence-v1";
const PAPER_RUNTIME_MEASURED = "AUTHORITATIVE_PAPER_ADMISSION_MEASURED";
const STAGES = Object.freeze([
  Object.freeze({ runtimeKey: "Entry", evidenceKey: "entry", idField: "paperSampleId", collection: "samples" }),
  Object.freeze({ runtimeKey: "Position", evidenceKey: "position", idField: "positionId", collection: "positions" }),
  Object.freeze({ runtimeKey: "Settlement", evidenceKey: "settlement", idField: "settlementId", collection: "settlements" }),
]);
const RUNTIME_IDENTITY_FIELDS = Object.freeze([
  "candidateId",
  "strategyFamily",
  "strategyId",
  "strategyVersion",
  "parameterHash",
  "parameterDigest",
  "costPolicyVersion",
  "executionPolicyVersion",
  "accountMode",
]);
const STAGE_IDENTITY_FIELDS = Object.freeze([
  "candidateId",
  "strategyFamily",
  "strategyId",
  "strategyVersion",
  "parameterHash",
  "parameterDigest",
  "costPolicyVersion",
  "market",
  "provider",
  "symbol",
  "timeframe",
  "sidePolicy",
  "accountMode",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function immutableSha(value) {
  return nonEmpty(value) && /^[0-9a-f]{40}$/iu.test(value);
}

function digest(value) {
  return nonEmpty(value) && /^[0-9a-f]{64}$/iu.test(value);
}

function canonicalCandidateId(value) {
  return typeof value === "string"
    && (/^phase3-candidate:sha256:[0-9a-f]{64}$/u.test(value)
      || /^paper-candidate-v1:[0-9a-f]{64}$/u.test(value));
}

function fieldCode(field) {
  return field.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase();
}

function assertExpectedIdentity(expected) {
  if (!canonicalCandidateId(expected?.candidateId)) throw new Error("PAPER_STAGE_EXPECTED_CANDIDATE_ID_REQUIRED");
  for (const field of [
    "strategyFamily",
    "strategyId",
    "strategyVersion",
    "parameterHash",
    "parameterDigest",
    "costPolicyVersion",
    "executionPolicyVersion",
    "market",
    "provider",
    "symbol",
    "timeframe",
    "sidePolicy",
  ]) {
    if (!nonEmpty(expected?.[field])) throw new Error(`PAPER_STAGE_EXPECTED_${fieldCode(field)}_REQUIRED`);
  }
  if (expected.parameterHash !== expected.parameterDigest) throw new Error("PAPER_STAGE_EXPECTED_PARAMETER_IDENTITY_MISMATCH");
  if (!immutableSha(expected?.researchCodeSha)) throw new Error("PAPER_STAGE_EXPECTED_RESEARCH_SHA_REQUIRED");
  if (expected?.accountMode !== "PAPER") throw new Error("PAPER_STAGE_EXPECTED_ACCOUNT_MODE_REQUIRED");
}

function runtimeIdentity(state) {
  const identity = isRecord(state?.identity) ? state.identity : {};
  return Object.freeze({
    candidateId: identity.candidateId ?? null,
    strategyFamily: identity.strategyFamily ?? null,
    strategyId: identity.strategyId ?? null,
    strategyVersion: identity.strategyVersion ?? null,
    parameterHash: identity.parameterHash ?? null,
    parameterDigest: identity.parameterDigest ?? null,
    researchCodeSha: String(identity.researchCodeSha ?? "").toLowerCase() || null,
    costPolicyVersion: identity.costPolicyVersion ?? null,
    executionPolicyVersion: identity.executionPolicyVersion ?? null,
    accountMode: identity.accountMode ?? null,
  });
}

function assertRuntimeIdentity(state, expected) {
  const actual = runtimeIdentity(state);
  for (const field of RUNTIME_IDENTITY_FIELDS) {
    if (actual[field] !== expected[field]) {
      throw new Error(`PAPER_STAGE_RUNTIME_${fieldCode(field)}_MISMATCH`);
    }
  }
  if (actual.researchCodeSha !== expected.researchCodeSha.toLowerCase()) {
    throw new Error("PAPER_STAGE_RUNTIME_RESEARCH_SHA_MISMATCH");
  }
}

function rowProviders(row, sample) {
  return [
    row?.provider,
    row?.identity?.provider,
    row?.entryEvidenceProvenance?.provider,
    row?.exitEvidenceProvenance?.provider,
    sample?.entryEvidenceProvenance?.provider,
    sample?.exitEvidenceProvenance?.provider,
    sample?.identity?.provider,
  ].filter(nonEmpty);
}

function rowIdentity(row, stage) {
  const sample = isRecord(row?.sample) ? row.sample : null;
  const sampleIdentity = isRecord(sample?.identity) ? sample.identity : {};
  const source = isRecord(row?.identity) ? row.identity : isRecord(row) ? row : {};
  const providers = rowProviders(row, sample);
  if (new Set(providers).size > 1) {
    throw new Error(`PAPER_STAGE_${stage.toUpperCase()}_PROVIDER_MISMATCH`);
  }
  return Object.freeze({
    candidateId: source.candidateId ?? row?.candidateId ?? sampleIdentity.candidateId ?? null,
    strategyFamily: source.strategyFamily ?? row?.strategyFamily ?? sampleIdentity.strategyFamily ?? null,
    strategyId: source.strategyId ?? row?.strategyId ?? sampleIdentity.strategyId ?? null,
    strategyVersion: source.strategyVersion ?? row?.strategyVersion ?? sampleIdentity.strategyVersion ?? null,
    parameterHash: source.parameterHash ?? row?.parameterHash ?? sampleIdentity.parameterHash ?? null,
    parameterDigest: source.parameterDigest ?? row?.parameterDigest ?? sampleIdentity.parameterDigest ?? null,
    researchCodeSha: String(
      source.researchCodeSha ?? row?.researchCodeSha ?? sampleIdentity.researchCodeSha ?? "",
    ).toLowerCase() || null,
    costPolicyVersion: source.costPolicyVersion
      ?? row?.costPolicyVersion
      ?? row?.profitEvidence?.costPolicyId
      ?? sample?.profitEvidence?.costPolicyId
      ?? null,
    market: source.market ?? row?.market ?? sampleIdentity.market ?? null,
    provider: providers[0] ?? null,
    symbol: source.symbol ?? row?.symbol ?? sampleIdentity.symbol ?? null,
    timeframe: source.timeframe ?? row?.timeframe ?? sampleIdentity.timeframe ?? null,
    sidePolicy: source.executionDirection
      ?? row?.entryDirection
      ?? row?.direction
      ?? source.signalDirection
      ?? row?.signalDirection
      ?? sampleIdentity.executionDirection
      ?? sampleIdentity.signalDirection
      ?? null,
    accountMode: source.accountMode ?? row?.accountMode ?? sampleIdentity.accountMode ?? null,
  });
}

function assertExactIdentity(row, expected, stage) {
  const actual = rowIdentity(row, stage);
  for (const field of STAGE_IDENTITY_FIELDS) {
    if (actual[field] !== expected[field]) {
      throw new Error(`PAPER_STAGE_${stage.toUpperCase()}_${fieldCode(field)}_MISMATCH`);
    }
  }
  if (actual.researchCodeSha !== expected.researchCodeSha.toLowerCase()) {
    throw new Error(`PAPER_STAGE_${stage.toUpperCase()}_RESEARCH_SHA_MISMATCH`);
  }
}

function validateDirectEvidence(evidence, expected) {
  if (evidence?.schemaVersion !== CANONICAL_LOOP_EVIDENCE) throw new Error("PAPER_STAGE_CANONICAL_LOOP_EVIDENCE_REQUIRED");
  if (evidence?.replayed === true) throw new Error("PAPER_STAGE_REPLAY_EVIDENCE_FORBIDDEN");
  if (evidence?.naturalCredit !== 0 || evidence?.replayCredit !== 0 || evidence?.duplicateCredit !== 0) {
    throw new Error("PAPER_STAGE_ECONOMIC_CREDIT_FORBIDDEN");
  }
  if (!immutableSha(evidence?.identity?.strategySha)
    || evidence.identity.strategySha.toLowerCase() !== expected.researchCodeSha.toLowerCase()
    || !immutableSha(evidence?.identity?.runtimeSha)
    || evidence.identity.runtimeSha.toLowerCase() !== expected.researchCodeSha.toLowerCase()) {
    throw new Error("PAPER_STAGE_LOOP_RESEARCH_SHA_MISMATCH");
  }
}

function measuredStage({ stage, evidence, state, expected }) {
  const direct = evidence?.stageCounts?.[stage.evidenceKey];
  if (!direct || direct.field !== stage.evidenceKey) throw new Error(`PAPER_STAGE_${stage.evidenceKey.toUpperCase()}_EVIDENCE_REQUIRED`);
  if (direct.naturalCredit !== 0 || direct.replayCredit !== 0 || direct.duplicateCredit !== 0) {
    throw new Error("PAPER_STAGE_ECONOMIC_CREDIT_FORBIDDEN");
  }
  if (direct.status !== "MEASURED" || !Number.isInteger(direct.count) || direct.count < 0) {
    return Object.freeze({
      status: "UNKNOWN",
      count: null,
      blocker: direct.blocker ?? `PAPER_${stage.runtimeKey.toUpperCase()}_UNMEASURED`,
      provenance: direct.provenance ?? null,
      observedAt: direct.observedAt ?? null,
      observationIds: Object.freeze([]),
      candidateBound: false,
    });
  }
  if (!Array.isArray(direct.observationIds) || direct.observationIds.length !== direct.count
    || new Set(direct.observationIds).size !== direct.observationIds.length) {
    throw new Error(`PAPER_STAGE_${stage.evidenceKey.toUpperCase()}_OBSERVATION_ID_INVALID`);
  }
  if (direct.count === 0) {
    return Object.freeze({
      status: "UNKNOWN",
      count: null,
      blocker: `PAPER_${stage.runtimeKey.toUpperCase()}_ZERO_NOT_CANDIDATE_BOUND`,
      provenance: direct.provenance ?? null,
      observedAt: direct.observedAt ?? null,
      observationIds: Object.freeze([]),
      candidateBound: false,
    });
  }
  const rows = state?.[stage.collection];
  if (!Array.isArray(rows)) throw new Error(`PAPER_STAGE_${stage.collection.toUpperCase()}_COLLECTION_REQUIRED`);
  for (const observationId of direct.observationIds) {
    if (!nonEmpty(observationId) && !digest(observationId)) {
      throw new Error(`PAPER_STAGE_${stage.evidenceKey.toUpperCase()}_OBSERVATION_ID_INVALID`);
    }
    const matches = rows.filter((row) => row?.[stage.idField] === observationId);
    if (matches.length !== 1) throw new Error(`PAPER_STAGE_${stage.evidenceKey.toUpperCase()}_ROW_BINDING_MISSING`);
    assertExactIdentity(matches[0], expected, stage.evidenceKey);
  }
  return Object.freeze({
    status: "MEASURED",
    count: direct.count,
    blocker: null,
    provenance: direct.provenance ?? null,
    observedAt: direct.observedAt ?? null,
    observationIds: Object.freeze([...direct.observationIds]),
    candidateBound: true,
  });
}

export function readAuthoritativePaperRuntimeStageEvidenceV1({
  paperRuntimeResult,
  recurringCycleResult,
  expectedCandidateIdentity,
} = {}) {
  assertExpectedIdentity(expectedCandidateIdentity);
  if (paperRuntimeResult?.status !== PAPER_RUNTIME_MEASURED) throw new Error("PAPER_STAGE_ADMISSION_RESULT_NOT_MEASURED");
  const admission = paperRuntimeResult?.runtimeStageMeasurements?.Admission;
  if (admission?.status !== "MEASURED") throw new Error("PAPER_STAGE_ADMISSION_MEASUREMENT_REQUIRED");
  if (paperRuntimeResult?.sampleCredit !== 0
    || paperRuntimeResult?.executionRealismCredit !== 0
    || paperRuntimeResult?.profitabilityCredit !== 0
    || paperRuntimeResult?.executionAuthority !== "NONE") {
    throw new Error("PAPER_STAGE_RUNTIME_AUTHORITY_OR_CREDIT_VIOLATION");
  }

  const state = recurringCycleResult?.state;
  const evidence = recurringCycleResult?.summary?.canonicalNaturalStageEvidence;
  assertRuntimeIdentity(state, expectedCandidateIdentity);
  validateDirectEvidence(evidence, expectedCandidateIdentity);

  const runtimeStageMeasurements = {
    Admission: Object.freeze({ ...admission }),
  };
  for (const stage of STAGES) {
    runtimeStageMeasurements[stage.runtimeKey] = measuredStage({
      stage,
      evidence,
      state,
      expected: expectedCandidateIdentity,
    });
  }

  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_RUNTIME_STAGE_EVIDENCE_READER_VERSION,
    status: "AUTHORITATIVE_PAPER_RUNTIME_STAGES_RECONCILED",
    candidateIdentity: Object.freeze({
      ...expectedCandidateIdentity,
      researchCodeSha: expectedCandidateIdentity.researchCodeSha.toLowerCase(),
    }),
    runtimeStageMeasurements: Object.freeze(runtimeStageMeasurements),
    sampleCredit: 0,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    fullCostReady: false,
    profitabilityProven: false,
    executionAuthority: "NONE",
    runtimeActivationAllowed: false,
    scheduleActivationAllowed: false,
    dispatchAllowed: false,
    liveTrading: false,
    privateTradingApiAllowed: false,
    realOrderAllowed: false,
  });
}

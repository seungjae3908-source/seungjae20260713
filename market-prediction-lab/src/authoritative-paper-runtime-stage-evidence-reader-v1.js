export const AUTHORITATIVE_PAPER_RUNTIME_STAGE_EVIDENCE_READER_VERSION =
  "authoritative-paper-runtime-stage-evidence-reader-v1";

const CANONICAL_LOOP_EVIDENCE = "canonical-natural-paper-loop-stage-evidence-v1";
const PAPER_RUNTIME_MEASURED = "AUTHORITATIVE_PAPER_ADMISSION_MEASURED";
const STAGES = Object.freeze([
  Object.freeze({ runtimeKey: "Entry", evidenceKey: "entry", idField: "paperSampleId", collection: "samples" }),
  Object.freeze({ runtimeKey: "Position", evidenceKey: "position", idField: "positionId", collection: "positions" }),
  Object.freeze({ runtimeKey: "Settlement", evidenceKey: "settlement", idField: "settlementId", collection: "settlements" }),
]);

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

function assertExpectedIdentity(expected) {
  if (!canonicalCandidateId(expected?.candidateId)) throw new Error("PAPER_STAGE_EXPECTED_CANDIDATE_ID_REQUIRED");
  for (const field of ["strategyFamily", "strategyId", "strategyVersion", "parameterHash", "parameterDigest", "costPolicyVersion"]) {
    if (!nonEmpty(expected?.[field])) throw new Error(`PAPER_STAGE_EXPECTED_${field.toUpperCase()}_REQUIRED`);
  }
  if (expected.parameterHash !== expected.parameterDigest) throw new Error("PAPER_STAGE_EXPECTED_PARAMETER_IDENTITY_MISMATCH");
  if (!immutableSha(expected?.researchCodeSha)) throw new Error("PAPER_STAGE_EXPECTED_RESEARCH_SHA_REQUIRED");
  if (expected?.accountMode !== "PAPER") throw new Error("PAPER_STAGE_EXPECTED_ACCOUNT_MODE_REQUIRED");
}

function rowIdentity(row) {
  const source = row?.identity && typeof row.identity === "object" ? row.identity : row;
  return Object.freeze({
    candidateId: source?.candidateId ?? row?.candidateId ?? null,
    strategyFamily: source?.strategyFamily ?? row?.strategyFamily ?? null,
    strategyId: source?.strategyId ?? row?.strategyId ?? null,
    strategyVersion: source?.strategyVersion ?? row?.strategyVersion ?? null,
    parameterHash: source?.parameterHash ?? row?.parameterHash ?? null,
    parameterDigest: source?.parameterDigest ?? row?.parameterDigest ?? null,
    researchCodeSha: String(source?.researchCodeSha ?? row?.researchCodeSha ?? "").toLowerCase() || null,
    costPolicyVersion: source?.costPolicyVersion ?? row?.costPolicyVersion ?? null,
    accountMode: source?.accountMode ?? row?.accountMode ?? null,
  });
}

function assertExactIdentity(row, expected, stage) {
  const actual = rowIdentity(row);
  for (const field of [
    "candidateId", "strategyFamily", "strategyId", "strategyVersion",
    "parameterHash", "parameterDigest", "costPolicyVersion", "accountMode",
  ]) {
    if (actual[field] !== expected[field]) throw new Error(`PAPER_STAGE_${stage.toUpperCase()}_IDENTITY_MISMATCH`);
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

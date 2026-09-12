import { readAuthoritativePaperRuntimeStageEvidenceV1 } from "./authoritative-paper-runtime-stage-evidence-reader-v1.js";

export const AUTHORITATIVE_PAPER_RUNTIME_STAGE_EVIDENCE_CALLER_VERSION =
  "authoritative-paper-runtime-stage-evidence-caller-v1";

const RUNTIME_STAGE_ORDER = Object.freeze([
  "Scanner Candidate",
  "Profit Gate",
  "Identity",
  "Paper Admission",
  "Entry",
  "Position",
  "Exit",
  "Settlement",
]);
const RECONCILED_STAGES = Object.freeze(["Entry", "Position", "Settlement"]);

function freeze(value) {
  return Object.freeze(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeFactoryEnvelope(value) {
  return value?.executionAuthority === "NONE"
    && value?.simulatedOnly === true
    && value?.liveOrderAllowed === false
    && value?.privateTradingApiAllowed === false
    && value?.orderSubmitted === false
    && value?.exchangeRequestSent === false
    && value?.productionMutationAllowed === false
    && value?.profitabilityClaimAllowed === false;
}

function safeCandidateEnvelope(value) {
  return value?.executionAuthority === "NONE"
    && value?.simulatedOnly === true
    && value?.liveOrderAllowed === false
    && value?.privateTradingApiAllowed === false
    && value?.orderSubmitted === false
    && value?.exchangeRequestSent === false
    && value?.productionMutationAllowed === false;
}

function candidateIdentity(candidate) {
  const signalStrategy = candidate?.signal?.strategyIdentity;
  const source = isRecord(signalStrategy)
    ? signalStrategy
    : isRecord(candidate?.strategyIdentity)
      ? candidate.strategyIdentity
      : isRecord(candidate?.identity)
        ? candidate.identity
        : {};
  const paperIdentity = isRecord(candidate?.paperIdentity) ? candidate.paperIdentity : {};
  return freeze({
    candidateId: source.candidateId ?? candidate?.candidateId ?? paperIdentity.candidateId ?? null,
    strategyFamily: source.strategyFamily ?? candidate?.strategyFamily ?? paperIdentity.strategyFamily ?? null,
    strategyId: source.strategyId ?? candidate?.strategyId ?? paperIdentity.strategyId ?? null,
    strategyVersion: source.strategyVersion ?? candidate?.strategyVersion ?? paperIdentity.strategyVersion ?? null,
    parameterHash: source.parameterHash ?? candidate?.parameterHash ?? paperIdentity.parameterHash ?? null,
    parameterDigest: source.parameterDigest ?? candidate?.parameterDigest ?? paperIdentity.parameterDigest ?? null,
    researchCodeSha: String(
      source.researchCodeSha ?? candidate?.researchCodeSha ?? paperIdentity.researchCodeSha ?? "",
    ).toLowerCase() || null,
    costPolicyVersion: source.costPolicyVersion
      ?? candidate?.costPolicyVersion
      ?? paperIdentity.costPolicyVersion
      ?? candidate?.profitEvidence?.costPolicyId
      ?? candidate?.execution?.costPolicy?.version
      ?? null,
    accountMode: source.accountMode ?? candidate?.accountMode ?? paperIdentity.accountMode ?? null,
  });
}

function exactIdentity(actual, expected) {
  if (!isRecord(expected)) return false;
  for (const field of [
    "candidateId",
    "strategyFamily",
    "strategyId",
    "strategyVersion",
    "parameterHash",
    "parameterDigest",
    "costPolicyVersion",
    "accountMode",
  ]) {
    if (actual[field] !== expected[field]) return false;
  }
  return actual.researchCodeSha === String(expected.researchCodeSha ?? "").toLowerCase();
}

function factoryAdmissionMeasurement(paperRuntimeResult) {
  if (!Array.isArray(paperRuntimeResult?.stageMeasurements)) {
    throw new Error("PAPER_STAGE_FACTORY_MEASUREMENTS_REQUIRED");
  }
  const admission = paperRuntimeResult.stageMeasurements.find((row) => row?.stage === "Paper Admission");
  if (admission?.status !== "MEASURED" || !Number.isInteger(admission?.count) || admission.count < 1) {
    throw new Error("PAPER_STAGE_FACTORY_ADMISSION_NOT_MEASURED");
  }
  return admission;
}

function exactFactoryCandidate(paperRuntimeResult, expectedCandidateIdentity) {
  if (!safeFactoryEnvelope(paperRuntimeResult)) {
    throw new Error("PAPER_STAGE_FACTORY_SAFETY_VIOLATION");
  }
  if (!Array.isArray(paperRuntimeResult?.paperBridge?.candidates)) {
    throw new Error("PAPER_STAGE_FACTORY_CANDIDATES_REQUIRED");
  }
  factoryAdmissionMeasurement(paperRuntimeResult);
  const matches = paperRuntimeResult.paperBridge.candidates.filter((candidate) => {
    if (!safeCandidateEnvelope(candidate)) return false;
    return exactIdentity(candidateIdentity(candidate), expectedCandidateIdentity);
  });
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? "PAPER_STAGE_FACTORY_CANDIDATE_BINDING_MISSING"
      : "PAPER_STAGE_FACTORY_CANDIDATE_BINDING_AMBIGUOUS");
  }
  return matches[0];
}

function singleFactoryCandidateIdentity(paperRuntimeResult) {
  if (!safeFactoryEnvelope(paperRuntimeResult)) {
    throw new Error("PAPER_STAGE_FACTORY_SAFETY_VIOLATION");
  }
  if (!Array.isArray(paperRuntimeResult?.paperBridge?.candidates)) {
    throw new Error("PAPER_STAGE_FACTORY_CANDIDATES_REQUIRED");
  }
  factoryAdmissionMeasurement(paperRuntimeResult);
  if (paperRuntimeResult.paperBridge.candidates.length !== 1) {
    throw new Error(paperRuntimeResult.paperBridge.candidates.length === 0
      ? "PAPER_STAGE_FACTORY_SINGLE_CANDIDATE_MISSING"
      : "PAPER_STAGE_FACTORY_SINGLE_CANDIDATE_AMBIGUOUS");
  }
  const [candidate] = paperRuntimeResult.paperBridge.candidates;
  if (!safeCandidateEnvelope(candidate)) {
    throw new Error("PAPER_STAGE_FACTORY_CANDIDATE_SAFETY_VIOLATION");
  }
  return candidateIdentity(candidate);
}

function candidateBoundAdmissionResult(paperRuntimeResult, expectedCandidateIdentity) {
  const admission = factoryAdmissionMeasurement(paperRuntimeResult);
  exactFactoryCandidate(paperRuntimeResult, expectedCandidateIdentity);
  return freeze({
    status: "AUTHORITATIVE_PAPER_ADMISSION_MEASURED",
    runtimeStageMeasurements: freeze({
      Admission: freeze({
        status: "MEASURED",
        count: 1,
        blocker: null,
        provenance: "authoritative-paper-runtime-factory-v1 Paper Admission + exact paperBridge candidate identity",
        observedAt: admission.measuredAtMs ?? null,
        candidateBound: true,
      }),
    }),
    sampleCredit: 0,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    executionAuthority: "NONE",
  });
}

function reconciledFactoryStage(stage, directEvidence) {
  return freeze({
    ...stage,
    status: directEvidence.status,
    count: directEvidence.status === "MEASURED" ? directEvidence.count : null,
    blocker: directEvidence.blocker ?? null,
    provenance: directEvidence.provenance ?? null,
    measuredAtMs: Number.isFinite(directEvidence.observedAt) ? directEvidence.observedAt : null,
    observationIds: directEvidence.observationIds,
    candidateBound: directEvidence.candidateBound === true,
  });
}

function firstMeasuredZero(stageMeasurements) {
  for (const row of stageMeasurements) {
    if (row?.status !== "MEASURED") {
      return freeze({ stage: "UNKNOWN", reason: row?.blocker ?? "EARLIER_STAGE_NOT_MEASURED" });
    }
    if (row.count === 0) return freeze({ stage: row.stage, reason: "MEASURED_ZERO" });
  }
  return freeze({ stage: "UNKNOWN", reason: "NO_MEASURED_ZERO" });
}

function stageCount(stageMeasurements, stageName) {
  const row = stageMeasurements.find((stage) => stage?.stage === stageName);
  return row?.status === "MEASURED" && Number.isInteger(row.count) ? row.count : null;
}

function blockedStageEvidenceAdoption(paperRuntimeResult, error) {
  const blocker = nonEmpty(error?.message) ? error.message : "PAPER_STAGE_EVIDENCE_RECONCILIATION_FAILED";
  return freeze({
    ...paperRuntimeResult,
    stageEvidenceConnection: freeze({
      schemaVersion: AUTHORITATIVE_PAPER_RUNTIME_STAGE_EVIDENCE_CALLER_VERSION,
      status: "BLOCKED",
      blocker,
      sampleCredit: 0,
      executionRealismCredit: 0,
      profitabilityCredit: 0,
      fullCostReady: false,
      profitabilityProven: false,
      executionAuthority: "NONE",
      runtimeActivationAllowed: false,
      scheduleActivationAllowed: false,
      dispatchAllowed: false,
    }),
  });
}

export function reconcileAuthoritativePaperRuntimeStageEvidenceV1({
  paperRuntimeResult,
  recurringCycleResult,
  expectedCandidateIdentity,
} = {}) {
  exactFactoryCandidate(paperRuntimeResult, expectedCandidateIdentity);
  const reconciled = readAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult: candidateBoundAdmissionResult(paperRuntimeResult, expectedCandidateIdentity),
    recurringCycleResult,
    expectedCandidateIdentity,
  });
  const directByStage = reconciled.runtimeStageMeasurements;
  const stageMeasurements = freeze(paperRuntimeResult.stageMeasurements.map((stage) => {
    if (!RECONCILED_STAGES.includes(stage?.stage)) return stage;
    return reconciledFactoryStage(stage, directByStage[stage.stage]);
  }));
  if (stageMeasurements.length !== RUNTIME_STAGE_ORDER.length
    || stageMeasurements.some((row, index) => row?.stage !== RUNTIME_STAGE_ORDER[index])) {
    throw new Error("PAPER_STAGE_FACTORY_STAGE_ORDER_INVALID");
  }
  const firstZero = firstMeasuredZero(stageMeasurements);
  return freeze({
    ...paperRuntimeResult,
    stageMeasurements,
    firstZeroStage: firstZero.stage,
    firstZeroReason: firstZero.reason,
    entryCount: stageCount(stageMeasurements, "Entry"),
    settlementCount: stageCount(stageMeasurements, "Settlement"),
    recurringStageEvidence: reconciled,
    stageEvidenceConnection: freeze({
      schemaVersion: AUTHORITATIVE_PAPER_RUNTIME_STAGE_EVIDENCE_CALLER_VERSION,
      status: "RECONCILED",
      candidateId: expectedCandidateIdentity.candidateId,
      sampleCredit: 0,
      executionRealismCredit: 0,
      profitabilityCredit: 0,
      fullCostReady: false,
      profitabilityProven: false,
      executionAuthority: "NONE",
      runtimeActivationAllowed: false,
      scheduleActivationAllowed: false,
      dispatchAllowed: false,
    }),
    sampleCredit: 0,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    fullCostReady: false,
    profitabilityProven: false,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
  });
}

export function reconcileSingleAuthoritativePaperRuntimeCandidateStageEvidenceV1({
  paperRuntimeResult,
  recurringCycleResult,
} = {}) {
  const expectedCandidateIdentity = singleFactoryCandidateIdentity(paperRuntimeResult);
  return reconcileAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult,
    recurringCycleResult,
    expectedCandidateIdentity,
  });
}

export function adoptExistingAuthoritativePaperRuntimeStageEvidenceV1({
  paperRuntimeResult,
  recurringCycleResult,
} = {}) {
  try {
    return reconcileSingleAuthoritativePaperRuntimeCandidateStageEvidenceV1({
      paperRuntimeResult,
      recurringCycleResult,
    });
  } catch (error) {
    return blockedStageEvidenceAdoption(paperRuntimeResult, error);
  }
}

export async function callAuthoritativePaperRuntimeWithStageEvidenceV1({
  paperRuntimeForMarket,
  runtimeInput = {},
  recurringCycleResult,
  expectedCandidateIdentity,
} = {}) {
  if (typeof paperRuntimeForMarket !== "function") {
    throw new TypeError("authoritative paperRuntimeForMarket is required");
  }
  if (!isRecord(runtimeInput)) throw new TypeError("authoritative Paper runtimeInput must be an object");
  const paperRuntimeResult = await paperRuntimeForMarket(runtimeInput);
  try {
    return reconcileAuthoritativePaperRuntimeStageEvidenceV1({
      paperRuntimeResult,
      recurringCycleResult,
      expectedCandidateIdentity,
    });
  } catch (error) {
    return blockedStageEvidenceAdoption(paperRuntimeResult, error);
  }
}

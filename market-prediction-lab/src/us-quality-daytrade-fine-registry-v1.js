import {
  appendResearchTrial,
  buildSelectedStrategyFingerprint,
  createResearchTrialRegistry,
  researchDigest,
  summarizeTrialRegistry,
} from "./research-trial-registry.js";
import { QUALITY_DAYTRADE_SEARCH_CONTRACT_VERSION } from "./us-quality-daytrade-search-plan-v1.js";

export const QUALITY_DAYTRADE_FINE_REGISTRY_VERSION = "us-quality-daytrade-fine-registry-v1";
const VALID_STAGES = new Set(["development", "validation", "oos", "walk_forward", "final_holdout", "shadow", "paper"]);
const SEARCH_TUNING_STAGES = new Set(["development", "validation"]);

function nonEmpty(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} is required`);
  return value.trim();
}

function normalizeStage(value) {
  const stage = nonEmpty(value, "stage");
  if (!VALID_STAGES.has(stage)) throw new RangeError(`unsupported research stage: ${stage}`);
  return stage;
}

function parentIdentity(registry) {
  if (!registry?.strategyIdentity) throw new TypeError("valid parent trial registry is required");
  const { strategyId, strategyVersion, researchCodeSha, datasetSnapshotHash, market, timeframe, direction } = registry.strategyIdentity;
  return Object.freeze({ strategyId, strategyVersion, researchCodeSha, datasetSnapshotHash, market, timeframe, direction });
}

function validateInputs({ experimentPlan, coarseRegistry, searchPlan }) {
  if (!experimentPlan || !Array.isArray(experimentPlan.candidates) || !experimentPlan.registry) {
    throw new TypeError("valid coarse experimentPlan is required");
  }
  if (!coarseRegistry || !Array.isArray(coarseRegistry.trials) || !coarseRegistry.strategyIdentity) {
    throw new TypeError("valid coarseRegistry is required");
  }
  if (!searchPlan || searchPlan.contractVersion !== QUALITY_DAYTRADE_SEARCH_CONTRACT_VERSION) {
    throw new TypeError("valid coarse-to-fine searchPlan is required");
  }
  if (searchPlan.status !== "READY_FOR_FINE") throw new Error("searchPlan must be READY_FOR_FINE before fine candidates are frozen");
  if (!Array.isArray(searchPlan.fineCandidates) || searchPlan.fineCandidates.length === 0) {
    throw new Error("searchPlan must contain fine candidates");
  }
  if (coarseRegistry.experimentId !== experimentPlan.registry.experimentId) {
    throw new Error("coarse registry / experiment plan experimentId mismatch");
  }
  const expectedFingerprint = experimentPlan.registry.strategyIdentity?.familyFingerprint;
  if (!expectedFingerprint || coarseRegistry.strategyIdentity.familyFingerprint !== expectedFingerprint) {
    throw new Error("coarse registry / experiment plan strategy identity mismatch");
  }
  if (searchPlan.coarseCandidateCount !== experimentPlan.candidates.length) {
    throw new Error("searchPlan coarse candidate count mismatch");
  }
  if (searchPlan.oosEvidenceCanTuneSearch !== false || searchPlan.walkForwardEvidenceCanTuneSearch !== false || searchPlan.finalHoldoutEvidenceCanTuneSearch !== false || searchPlan.paperEvidenceCanTuneSearch !== false || searchPlan.shadowEvidenceCanTuneSearch !== false) {
    throw new Error("searchPlan contamination safeguards must remain fail-closed");
  }
}

function freezeFineCandidates(searchPlan) {
  const rows = searchPlan.fineCandidates.map((candidate) => Object.freeze({
    candidateId: nonEmpty(candidate.candidateId, "fine candidateId"),
    parameterHash: nonEmpty(candidate.parameterHash, "fine parameterHash"),
    seedCandidateId: nonEmpty(candidate.seedCandidateId, "fine seedCandidateId"),
    params: Object.freeze({ ...(candidate.params ?? {}) }),
  }));
  const ids = new Set(rows.map((row) => row.candidateId));
  const hashes = new Set(rows.map((row) => row.parameterHash));
  if (ids.size !== rows.length || hashes.size !== rows.length) throw new Error("fine candidate identity collision detected");
  return Object.freeze(rows);
}

export function buildQualityDaytradeFineExperimentPlan({ experimentPlan, coarseRegistry, searchPlan } = {}) {
  validateInputs({ experimentPlan, coarseRegistry, searchPlan });
  const candidates = freezeFineCandidates(searchPlan);
  const fineExperimentId = `${coarseRegistry.experimentId}:fine:${searchPlan.planDigest.slice(0, 16)}`;
  const registry = createResearchTrialRegistry({ experimentId: fineExperimentId, identity: parentIdentity(coarseRegistry) });
  if (registry.strategyIdentity.familyFingerprint !== coarseRegistry.strategyIdentity.familyFingerprint) {
    throw new Error("fine registry must preserve exact strategy family identity");
  }
  const candidateManifestDigest = researchDigest(candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    parameterHash: candidate.parameterHash,
    seedCandidateId: candidate.seedCandidateId,
    params: candidate.params,
  })));
  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_FINE_REGISTRY_VERSION,
    parentExperimentId: coarseRegistry.experimentId,
    parentRegistryDigest: coarseRegistry.registryDigest,
    parentSearchPlanDigest: searchPlan.planDigest,
    fineExperimentId,
    strategyIdentity: registry.strategyIdentity,
    registry,
    candidates,
    candidateManifestDigest,
    fineCandidateCount: candidates.length,
    duplicateExactTrialAllowed: false,
    searchTuningEvidenceStages: Object.freeze(["development", "validation"]),
    oosCanRetuneFineParameters: false,
    walkForwardCanRetuneFineParameters: false,
    finalHoldoutCanRetuneFineParameters: false,
    shadowCanRetuneFineParameters: false,
    paperCanRetuneFineParameters: false,
    liveTradingAllowed: false,
    privateApiAllowed: false,
    executionAuthority: "NONE",
    frozenPlanDigest: researchDigest({
      familyFingerprint: registry.strategyIdentity.familyFingerprint,
      parentRegistryDigest: coarseRegistry.registryDigest,
      parentSearchPlanDigest: searchPlan.planDigest,
      candidateManifestDigest,
    }),
  });
}

function requireFrozenCandidate(finePlan, candidate) {
  if (!finePlan || finePlan.contractVersion !== QUALITY_DAYTRADE_FINE_REGISTRY_VERSION || !Array.isArray(finePlan.candidates)) {
    throw new TypeError("valid fine experiment plan is required");
  }
  const candidateId = nonEmpty(candidate?.candidateId, "candidate.candidateId");
  const parameterHash = nonEmpty(candidate?.parameterHash, "candidate.parameterHash");
  const frozen = finePlan.candidates.find((row) => row.candidateId === candidateId && row.parameterHash === parameterHash);
  if (!frozen) throw new Error("candidate is outside the frozen fine manifest");
  return frozen;
}

export function appendQualityDaytradeFineTrial(finePlan, registry, {
  candidate,
  stage,
  evaluationSliceId,
  returnSeries,
  metrics = {},
  selectionEligible = false,
  startedAt = null,
  completedAt = null,
} = {}) {
  if (!registry || registry.experimentId !== finePlan?.fineExperimentId) throw new Error("fine registry experimentId mismatch");
  if (registry.strategyIdentity?.familyFingerprint !== finePlan?.strategyIdentity?.familyFingerprint) throw new Error("fine registry strategy identity mismatch");
  const frozen = requireFrozenCandidate(finePlan, candidate);
  const normalizedStage = normalizeStage(stage);
  if (selectionEligible === true && !SEARCH_TUNING_STAGES.has(normalizedStage)) {
    throw new Error(`${normalizedStage} evidence cannot retune frozen fine parameters`);
  }
  const sliceId = nonEmpty(evaluationSliceId, "evaluationSliceId");
  const trialId = researchDigest({
    familyFingerprint: registry.strategyIdentity.familyFingerprint,
    fineExperimentId: finePlan.fineExperimentId,
    frozenPlanDigest: finePlan.frozenPlanDigest,
    candidateId: frozen.candidateId,
    parameterHash: frozen.parameterHash,
    stage: normalizedStage,
    evaluationSliceId: sliceId,
  });
  const next = appendResearchTrial(registry, {
    trialId,
    candidateId: frozen.candidateId,
    parameterHash: frozen.parameterHash,
    stage: normalizedStage,
    selectionEligible: selectionEligible === true,
    returnSeries,
    startedAt,
    completedAt,
    metrics: Object.freeze({ ...metrics, evaluationSliceId: sliceId, frozenPlanDigest: finePlan.frozenPlanDigest }),
  });
  const trial = next.trials.at(-1);
  return Object.freeze({
    registry: next,
    trial,
    selectedStrategyFingerprint: buildSelectedStrategyFingerprint(next, trial),
    summary: summarizeTrialRegistry(next),
  });
}

export function hasExactQualityDaytradeFineTrial(finePlan, registry, { candidate, stage, evaluationSliceId } = {}) {
  if (!registry || registry.experimentId !== finePlan?.fineExperimentId) throw new Error("fine registry experimentId mismatch");
  const frozen = requireFrozenCandidate(finePlan, candidate);
  const normalizedStage = normalizeStage(stage);
  const sliceId = nonEmpty(evaluationSliceId, "evaluationSliceId");
  const trialId = researchDigest({
    familyFingerprint: registry.strategyIdentity.familyFingerprint,
    fineExperimentId: finePlan.fineExperimentId,
    frozenPlanDigest: finePlan.frozenPlanDigest,
    candidateId: frozen.candidateId,
    parameterHash: frozen.parameterHash,
    stage: normalizedStage,
    evaluationSliceId: sliceId,
  });
  return registry.trials.some((trial) => trial.trialId === trialId);
}

import {
  appendResearchTrial,
  buildSelectedStrategyFingerprint,
  createResearchTrialRegistry,
  researchDigest,
  summarizeTrialRegistry,
} from "./research-trial-registry.js";
import { buildQualityDaytradeParameterGrid } from "./us-quality-daytrade-research-v1.js";

export const QUALITY_DAYTRADE_TRIAL_CONTRACT_VERSION = "us-quality-daytrade-trial-registry-v1";
const VALID_SESSIONS = new Set(["PREMARKET", "REGULAR", "AFTER_HOURS"]);
const VALID_TIERS = new Set(["A", "B"]);
const VALID_STAGES = new Set(["development", "validation", "oos", "walk_forward", "final_holdout", "shadow", "paper"]);

function nonEmpty(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} is required`);
  return value.trim();
}

function immutableSha(value, name) {
  const normalized = nonEmpty(value, name).toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) throw new TypeError(`${name} must be an immutable 40-char SHA`);
  return normalized;
}

function normalizeTier(value) {
  const tier = String(value ?? "A").toUpperCase();
  if (!VALID_TIERS.has(tier)) throw new RangeError("qualityTier must be A or B");
  return tier;
}

function normalizeSession(value) {
  const session = String(value ?? "REGULAR").toUpperCase();
  if (!VALID_SESSIONS.has(session)) throw new RangeError("session must be PREMARKET, REGULAR, or AFTER_HOURS");
  return session;
}

function normalizeStage(value) {
  const stage = nonEmpty(value, "stage");
  if (!VALID_STAGES.has(stage)) throw new RangeError(`unsupported research stage: ${stage}`);
  return stage;
}

function candidateIdentity({ familyFingerprint, qualityTier, catalystDay, session, params }) {
  const parameterPayload = Object.freeze({
    qualityTier,
    catalystDay: catalystDay === true,
    session,
    takeProfitPct: params.takeProfitPct,
    fixedStopPct: params.fixedStopPct,
    timeStopMinutes: params.timeStopMinutes,
    exitMode: params.exitMode,
  });
  const parameterHash = researchDigest(parameterPayload);
  const candidateId = `quality-daytrade:${qualityTier}:${session}:${catalystDay ? "catalyst" : "normal"}:${parameterHash.slice(0, 16)}`;
  return Object.freeze({
    candidateId,
    parameterHash,
    selectedStrategyFingerprint: researchDigest({ familyFingerprint, candidateId, parameterHash }),
    params: Object.freeze({ ...params }),
  });
}

export function buildQualityDaytradeExperimentPlan({
  experimentId,
  researchCodeSha,
  datasetSnapshotHash,
  timeframe,
  qualityTier = "A",
  catalystDay = false,
  session = "REGULAR",
} = {}) {
  const tier = normalizeTier(qualityTier);
  const normalizedSession = normalizeSession(session);
  const codeSha = immutableSha(researchCodeSha, "researchCodeSha");
  const registry = createResearchTrialRegistry({
    experimentId: nonEmpty(experimentId, "experimentId"),
    identity: {
      strategyId: `US_QUALITY_DAYTRADE_${tier}`,
      strategyVersion: QUALITY_DAYTRADE_TRIAL_CONTRACT_VERSION,
      researchCodeSha: codeSha,
      datasetSnapshotHash: nonEmpty(datasetSnapshotHash, "datasetSnapshotHash"),
      market: "US_STOCK",
      timeframe: nonEmpty(timeframe, "timeframe"),
      direction: "LONG",
    },
  });
  const grid = buildQualityDaytradeParameterGrid({ catalystDay: catalystDay === true, qualityTier: tier });
  const candidates = Object.freeze(grid.combinations.map((params) => candidateIdentity({
    familyFingerprint: registry.strategyIdentity.familyFingerprint,
    qualityTier: tier,
    catalystDay: catalystDay === true,
    session: normalizedSession,
    params,
  })));
  const uniqueCandidateIds = new Set(candidates.map((row) => row.candidateId));
  const uniqueParameterHashes = new Set(candidates.map((row) => row.parameterHash));
  if (uniqueCandidateIds.size !== candidates.length || uniqueParameterHashes.size !== candidates.length) {
    throw new Error("quality day-trade parameter identity collision detected");
  }
  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_TRIAL_CONTRACT_VERSION,
    registry,
    qualityTier: tier,
    catalystDay: catalystDay === true,
    session: normalizedSession,
    candidates,
    coarseCombinationCount: candidates.length,
    duplicateExactTrialAllowed: false,
    forwardEvidenceCanSelectCandidate: false,
    liveTradingAllowed: false,
    privateApiAllowed: false,
    executionAuthority: "NONE",
  });
}

export function appendQualityDaytradeTrial(registry, {
  candidate,
  stage,
  evaluationSliceId,
  returnSeries,
  metrics = {},
  selectionEligible = false,
  startedAt = null,
  completedAt = null,
} = {}) {
  if (!candidate || typeof candidate !== "object") throw new TypeError("candidate is required");
  const normalizedStage = normalizeStage(stage);
  const sliceId = nonEmpty(evaluationSliceId, "evaluationSliceId");
  const candidateId = nonEmpty(candidate.candidateId, "candidate.candidateId");
  const parameterHash = nonEmpty(candidate.parameterHash, "candidate.parameterHash");
  const trialId = researchDigest({
    familyFingerprint: registry?.strategyIdentity?.familyFingerprint,
    candidateId,
    parameterHash,
    stage: normalizedStage,
    evaluationSliceId: sliceId,
  });
  const next = appendResearchTrial(registry, {
    trialId,
    candidateId,
    parameterHash,
    stage: normalizedStage,
    selectionEligible: selectionEligible === true,
    returnSeries,
    startedAt,
    completedAt,
    metrics: Object.freeze({ ...metrics, evaluationSliceId: sliceId }),
  });
  const recorded = next.trials.at(-1);
  return Object.freeze({
    registry: next,
    trial: recorded,
    selectedStrategyFingerprint: buildSelectedStrategyFingerprint(next, recorded),
    summary: summarizeTrialRegistry(next),
  });
}

export function hasExactQualityDaytradeTrial(registry, { candidate, stage, evaluationSliceId } = {}) {
  if (!registry || !Array.isArray(registry.trials)) throw new TypeError("valid registry is required");
  const normalizedStage = normalizeStage(stage);
  const sliceId = nonEmpty(evaluationSliceId, "evaluationSliceId");
  const candidateId = nonEmpty(candidate?.candidateId, "candidate.candidateId");
  const parameterHash = nonEmpty(candidate?.parameterHash, "candidate.parameterHash");
  const trialId = researchDigest({
    familyFingerprint: registry.strategyIdentity.familyFingerprint,
    candidateId,
    parameterHash,
    stage: normalizedStage,
    evaluationSliceId: sliceId,
  });
  return registry.trials.some((trial) => trial.trialId === trialId);
}

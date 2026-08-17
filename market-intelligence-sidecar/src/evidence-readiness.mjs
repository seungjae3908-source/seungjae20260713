const TRAINING_SPLITS = new Set(['DEVELOPMENT', 'CALIBRATION']);
const FORBIDDEN_TUNING_SPLITS = new Set(['OOS', 'WALK_FORWARD', 'FINAL_HOLDOUT', 'PAPER', 'SHADOW', 'LIVE']);

export const DEFAULT_EVIDENCE_READINESS_POLICY = Object.freeze({
  version: 'MIS_EVIDENCE_READINESS_V1',
  conformalMinCalibrationSamples: 100,
  metaMinTrainingSamples: 300,
  metaMinEvaluationSamples: 300,
  fillMinTrainingSamples: 500,
  fillMinEvaluationSamples: 500,
  expectedShortfallMinSamples: 250,
  minimumRegimeCount: 2,
});

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolvePolicy(policy = {}) {
  const merged = { ...DEFAULT_EVIDENCE_READINESS_POLICY, ...(policy ?? {}) };
  if (typeof merged.version !== 'string' || !merged.version.trim()) throw new Error('EVIDENCE_READINESS_POLICY_VERSION_REQUIRED');
  for (const key of Object.keys(DEFAULT_EVIDENCE_READINESS_POLICY).filter((key) => key !== 'version')) {
    const parsed = Number(merged[key]);
    if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`EVIDENCE_READINESS_POLICY_FIELD_INVALID:${key}`);
    merged[key] = parsed;
  }
  return merged;
}

function normalizedSplit(value) {
  return String(value ?? '').trim().toUpperCase();
}

function lineageReady(row) {
  return typeof row?.lineage === 'string' && row.lineage.trim().length > 0
    && typeof row?.strategyVersion === 'string' && row.strategyVersion.trim().length > 0
    && typeof row?.policyVersion === 'string' && row.policyVersion.trim().length > 0;
}

function fixedBeforeOutcome(row) {
  return row?.policyFrozenBeforeOutcome === true && row?.featuresCapturedBeforeOutcome === true;
}

function isTrainingEligible(row) {
  const split = normalizedSplit(row?.splitRole);
  return TRAINING_SPLITS.has(split)
    && !FORBIDDEN_TUNING_SPLITS.has(split)
    && fixedBeforeOutcome(row)
    && lineageReady(row);
}

function countRegimes(rows) {
  return new Set(rows.map((row) => String(row?.regime ?? '').trim().toUpperCase()).filter(Boolean)).size;
}

function blocker(code, details = {}) {
  return Object.freeze({ code, ...details });
}

function result(status, blockers, details = {}) {
  return Object.freeze({ status, blockers: Object.freeze(blockers), ...details });
}

export function evaluateConformalEvidenceReadiness(rows = [], policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const all = Array.isArray(rows) ? rows : [];
  const blockers = [];
  const eligible = all.filter((row) => isTrainingEligible(row)
    && row?.costAdjusted === true
    && finite(row?.predictedNetEdgeBps) != null
    && finite(row?.realizedNetReturnBps) != null);

  if (!all.some((row) => row?.costAdjusted === true)) blockers.push(blocker('COST_ADJUSTED_OUTCOMES_NOT_CAPTURED'));
  if (!all.some((row) => finite(row?.predictedNetEdgeBps) != null)) blockers.push(blocker('PREDICTED_NET_EDGE_NOT_CAPTURED'));
  if (eligible.length < policy.conformalMinCalibrationSamples) {
    blockers.push(blocker('CONFORMAL_CALIBRATION_SAMPLE_INSUFFICIENT', {
      sampleSize: eligible.length,
      minimumSamples: policy.conformalMinCalibrationSamples,
    }));
  }
  const regimeCount = countRegimes(eligible);
  if (regimeCount < policy.minimumRegimeCount) blockers.push(blocker('CONFORMAL_REGIME_COVERAGE_INSUFFICIENT', { regimeCount }));

  const nonconformityScoresBps = blockers.length ? [] : eligible.map((row) => Math.abs(Number(row.realizedNetReturnBps) - Number(row.predictedNetEdgeBps)));
  return result(blockers.length ? 'NOT_READY' : 'DATA_READY', blockers, {
    eligibleSamples: eligible.length,
    regimeCount,
    nonconformityScoresBps: Object.freeze(nonconformityScoresBps),
    gateReady: false,
    gateReadyReason: blockers.length ? 'CALIBRATION_DATA_NOT_READY' : 'CALIBRATED_MODEL_EVALUATION_STILL_REQUIRED',
  });
}

export function evaluateMetaLabelEvidenceReadiness(rows = [], modelEvidence = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const all = Array.isArray(rows) ? rows : [];
  const blockers = [];
  const training = all.filter((row) => isTrainingEligible(row)
    && row?.costAdjusted === true
    && finite(row?.realizedNetReturnBps) != null
    && typeof row?.featureSnapshotHash === 'string'
    && row.featureSnapshotHash.trim().length > 0);

  if (!all.some((row) => row?.costAdjusted === true)) blockers.push(blocker('COST_ADJUSTED_META_LABELS_NOT_CAPTURED'));
  if (!all.some((row) => typeof row?.featureSnapshotHash === 'string' && row.featureSnapshotHash.trim())) blockers.push(blocker('SIGNAL_TIME_FEATURE_SNAPSHOT_NOT_CAPTURED'));
  if (training.length < policy.metaMinTrainingSamples) blockers.push(blocker('META_TRAINING_SAMPLE_INSUFFICIENT', { sampleSize: training.length, minimumSamples: policy.metaMinTrainingSamples }));
  const regimeCount = countRegimes(training);
  if (regimeCount < policy.minimumRegimeCount) blockers.push(blocker('META_REGIME_COVERAGE_INSUFFICIENT', { regimeCount }));

  const evaluationSamples = Math.max(0, finite(modelEvidence?.evaluationSamples, 0));
  const brierScore = finite(modelEvidence?.brierScore);
  const calibrationError = finite(modelEvidence?.calibrationError);
  const modelId = String(modelEvidence?.modelId ?? '').trim();
  const modelEvaluatedOnUntouchedData = modelEvidence?.evaluatedOnUntouchedData === true;
  const modelReady = Boolean(modelId)
    && evaluationSamples >= policy.metaMinEvaluationSamples
    && brierScore != null
    && calibrationError != null
    && modelEvaluatedOnUntouchedData;
  if (!modelReady) blockers.push(blocker('META_MODEL_UNTOUCHED_EVALUATION_NOT_READY', { evaluationSamples }));

  return result(blockers.length ? 'NOT_READY' : 'GATE_READY', blockers, {
    eligibleTrainingSamples: training.length,
    regimeCount,
    modelId: modelId || null,
    evaluationSamples,
    brierScore,
    calibrationError,
    labels: blockers.length ? Object.freeze([]) : Object.freeze(training.map((row) => ({
      lineage: row.lineage,
      featureSnapshotHash: row.featureSnapshotHash,
      takeLabel: Number(row.realizedNetReturnBps) > 0 ? 1 : 0,
    }))),
  });
}

export function evaluateFillEvidenceReadiness(rows = [], modelEvidence = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const all = Array.isArray(rows) ? rows : [];
  const blockers = [];
  const training = all.filter((row) => isTrainingEligible(row)
    && row?.orderSubmitted === true
    && row?.featuresCapturedBeforeOrder === true
    && typeof row?.executionFeatureSnapshotHash === 'string'
    && row.executionFeatureSnapshotHash.trim()
    && (row?.filledWithinHorizon === true || row?.filledWithinHorizon === false));

  if (!all.some((row) => row?.orderSubmitted === true)) blockers.push(blocker('REAL_EXECUTION_OBSERVATIONS_NOT_CAPTURED'));
  if (!all.some((row) => row?.featuresCapturedBeforeOrder === true)) blockers.push(blocker('PRE_ORDER_EXECUTION_FEATURES_NOT_CAPTURED'));
  if (training.length < policy.fillMinTrainingSamples) blockers.push(blocker('FILL_TRAINING_SAMPLE_INSUFFICIENT', { sampleSize: training.length, minimumSamples: policy.fillMinTrainingSamples }));

  const evaluationSamples = Math.max(0, finite(modelEvidence?.evaluationSamples, 0));
  const brierScore = finite(modelEvidence?.brierScore);
  const calibrationError = finite(modelEvidence?.calibrationError);
  const modelId = String(modelEvidence?.modelId ?? '').trim();
  const untouched = modelEvidence?.evaluatedOnUntouchedData === true;
  const modelReady = Boolean(modelId)
    && evaluationSamples >= policy.fillMinEvaluationSamples
    && brierScore != null
    && calibrationError != null
    && untouched;
  if (!modelReady) blockers.push(blocker('FILL_MODEL_UNTOUCHED_EVALUATION_NOT_READY', { evaluationSamples }));

  return result(blockers.length ? 'NOT_READY' : 'GATE_READY', blockers, {
    eligibleTrainingSamples: training.length,
    modelId: modelId || null,
    evaluationSamples,
    brierScore,
    calibrationError,
  });
}

export function evaluateEventEvidenceReadiness(rows = [], policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const all = Array.isArray(rows) ? rows : [];
  const blockers = [];
  const eligible = all.filter((row) => fixedBeforeOutcome(row)
    && lineageReady(row)
    && row?.eventSnapshotCaptured === true
    && typeof row?.eventSource === 'string'
    && row.eventSource.trim()
    && (row?.eventVerified === true || row?.eventVerified === false));
  if (!all.some((row) => row?.eventSnapshotCaptured === true)) blockers.push(blocker('VERIFIED_EVENT_LINEAGE_NOT_CAPTURED'));
  if (eligible.length < policy.metaMinEvaluationSamples) blockers.push(blocker('EVENT_EVALUATION_SAMPLE_INSUFFICIENT', { sampleSize: eligible.length, minimumSamples: policy.metaMinEvaluationSamples }));
  return result(blockers.length ? 'NOT_READY' : 'EVALUATION_READY', blockers, { eligibleSamples: eligible.length });
}

export function evaluateExpectedShortfallEvidenceReadiness(rows = [], policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const all = Array.isArray(rows) ? rows : [];
  const blockers = [];
  const eligible = all.filter((row) => lineageReady(row)
    && row?.costAdjusted === true
    && finite(row?.realizedNetReturnBps) != null);
  if (!all.some((row) => row?.costAdjusted === true)) blockers.push(blocker('COST_ADJUSTED_LOSS_SAMPLES_NOT_CAPTURED'));
  if (eligible.length < policy.expectedShortfallMinSamples) blockers.push(blocker('EXPECTED_SHORTFALL_SAMPLE_INSUFFICIENT', { sampleSize: eligible.length, minimumSamples: policy.expectedShortfallMinSamples }));
  const regimeCount = countRegimes(eligible);
  if (regimeCount < policy.minimumRegimeCount) blockers.push(blocker('EXPECTED_SHORTFALL_REGIME_COVERAGE_INSUFFICIENT', { regimeCount }));
  const lossSamplesPct = blockers.length ? [] : eligible.map((row) => Math.max(0, -Number(row.realizedNetReturnBps) / 100));
  return result(blockers.length ? 'NOT_READY' : 'DATA_READY', blockers, {
    eligibleSamples: eligible.length,
    regimeCount,
    lossSamplesPct: Object.freeze(lossSamplesPct),
  });
}

export function evaluateSafetyGateEvidenceReadiness(input = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const forward = Array.isArray(input.forwardObservations) ? input.forwardObservations : [];
  const execution = Array.isArray(input.executionObservations) ? input.executionObservations : [];
  const event = Array.isArray(input.eventObservations) ? input.eventObservations : forward;
  const conformal = evaluateConformalEvidenceReadiness(forward, policy);
  const metaLabel = evaluateMetaLabelEvidenceReadiness(forward, input.metaModelEvidence, policy);
  const fill = evaluateFillEvidenceReadiness(execution, input.fillModelEvidence, policy);
  const eventRisk = evaluateEventEvidenceReadiness(event, policy);
  const expectedShortfall = evaluateExpectedShortfallEvidenceReadiness(forward, policy);

  const readyForRequiredEnforcement = [conformal, metaLabel, fill, eventRisk, expectedShortfall]
    .every((entry) => ['DATA_READY', 'GATE_READY', 'EVALUATION_READY'].includes(entry.status));

  const forbiddenTuningRows = [...forward, ...execution].filter((row) => FORBIDDEN_TUNING_SPLITS.has(normalizedSplit(row?.splitRole)) && row?.usedForTuning === true);
  const leakageBlockers = forbiddenTuningRows.length
    ? [blocker('FORBIDDEN_HOLDOUT_OR_LIVE_TUNING_DETECTED', { count: forbiddenTuningRows.length })]
    : [];

  return Object.freeze({
    contract: 'market-intelligence-evidence-readiness/v1',
    policy,
    conformal,
    metaLabel,
    fill,
    eventRisk,
    expectedShortfall,
    leakage: result(leakageBlockers.length ? 'BLOCKED' : 'PASS', leakageBlockers),
    readyForRequiredEnforcement: readyForRequiredEnforcement && leakageBlockers.length === 0,
    policyMutationAllowed: false,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}

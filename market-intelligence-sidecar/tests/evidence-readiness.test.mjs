import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateConformalEvidenceReadiness,
  evaluateExpectedShortfallEvidenceReadiness,
  evaluateFillEvidenceReadiness,
  evaluateMetaLabelEvidenceReadiness,
  evaluateSafetyGateEvidenceReadiness,
} from '../src/evidence-readiness.mjs';

function forwardRow(index, overrides = {}) {
  return {
    splitRole: index % 2 ? 'DEVELOPMENT' : 'CALIBRATION',
    policyFrozenBeforeOutcome: true,
    featuresCapturedBeforeOutcome: true,
    lineage: `lineage-${index}`,
    strategyVersion: 'strategy-v1',
    policyVersion: 'policy-v1',
    regime: index % 3 === 0 ? 'TREND' : 'RANGE',
    costAdjusted: true,
    predictedNetEdgeBps: 5 + (index % 5),
    realizedNetReturnBps: -4 + (index % 13),
    featureSnapshotHash: `feature-${index}`,
    eventSnapshotCaptured: true,
    eventSource: 'verified-calendar',
    eventVerified: index % 7 === 0,
    ...overrides,
  };
}

function executionRow(index, overrides = {}) {
  return {
    splitRole: index % 2 ? 'DEVELOPMENT' : 'CALIBRATION',
    policyFrozenBeforeOutcome: true,
    featuresCapturedBeforeOutcome: true,
    lineage: `execution-${index}`,
    strategyVersion: 'strategy-v1',
    policyVersion: 'policy-v1',
    regime: index % 2 ? 'TREND' : 'RANGE',
    orderSubmitted: true,
    featuresCapturedBeforeOrder: true,
    executionFeatureSnapshotHash: `exec-feature-${index}`,
    filledWithinHorizon: index % 4 !== 0,
    ...overrides,
  };
}

test('current-style forward outcomes without cost-adjusted net edge stay explicitly not ready', () => {
  const rows = Array.from({ length: 400 }, (_, index) => forwardRow(index, {
    costAdjusted: false,
    predictedNetEdgeBps: null,
    featureSnapshotHash: null,
    eventSnapshotCaptured: false,
    eventSource: null,
  }));
  const result = evaluateSafetyGateEvidenceReadiness({ forwardObservations: rows });
  assert.equal(result.readyForRequiredEnforcement, false);
  assert.ok(result.conformal.blockers.some((entry) => entry.code === 'COST_ADJUSTED_OUTCOMES_NOT_CAPTURED'));
  assert.ok(result.conformal.blockers.some((entry) => entry.code === 'PREDICTED_NET_EDGE_NOT_CAPTURED'));
  assert.ok(result.metaLabel.blockers.some((entry) => entry.code === 'SIGNAL_TIME_FEATURE_SNAPSHOT_NOT_CAPTURED'));
  assert.ok(result.fill.blockers.some((entry) => entry.code === 'REAL_EXECUTION_OBSERVATIONS_NOT_CAPTURED'));
  assert.ok(result.eventRisk.blockers.some((entry) => entry.code === 'VERIFIED_EVENT_LINEAGE_NOT_CAPTURED'));
  assert.equal(result.policyMutationAllowed, false);
  assert.equal(result.profitabilityClaimAllowed, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('conformal readiness produces only real residual scores from frozen cost-adjusted calibration rows', () => {
  const rows = Array.from({ length: 150 }, (_, index) => forwardRow(index));
  const result = evaluateConformalEvidenceReadiness(rows);
  assert.equal(result.status, 'DATA_READY');
  assert.equal(result.eligibleSamples, 150);
  assert.equal(result.nonconformityScoresBps.length, 150);
  assert.equal(result.nonconformityScoresBps[0], Math.abs(rows[0].realizedNetReturnBps - rows[0].predictedNetEdgeBps));
});

test('meta-label readiness refuses to declare gate readiness until untouched model calibration evidence exists', () => {
  const rows = Array.from({ length: 350 }, (_, index) => forwardRow(index));
  const noModel = evaluateMetaLabelEvidenceReadiness(rows, {});
  assert.equal(noModel.status, 'NOT_READY');
  assert.ok(noModel.blockers.some((entry) => entry.code === 'META_MODEL_UNTOUCHED_EVALUATION_NOT_READY'));

  const ready = evaluateMetaLabelEvidenceReadiness(rows, {
    modelId: 'meta-v1',
    evaluationSamples: 350,
    brierScore: 0.18,
    calibrationError: 0.05,
    evaluatedOnUntouchedData: true,
  });
  assert.equal(ready.status, 'GATE_READY');
  assert.equal(ready.labels.length, 350);
});

test('fill gate requires real submitted execution observations and untouched model evaluation', () => {
  const absent = evaluateFillEvidenceReadiness([], {});
  assert.equal(absent.status, 'NOT_READY');
  assert.ok(absent.blockers.some((entry) => entry.code === 'REAL_EXECUTION_OBSERVATIONS_NOT_CAPTURED'));

  const rows = Array.from({ length: 550 }, (_, index) => executionRow(index));
  const ready = evaluateFillEvidenceReadiness(rows, {
    modelId: 'fill-v1',
    evaluationSamples: 600,
    brierScore: 0.16,
    calibrationError: 0.04,
    evaluatedOnUntouchedData: true,
  });
  assert.equal(ready.status, 'GATE_READY');
  assert.equal(ready.eligibleTrainingSamples, 550);
});

test('expected shortfall readiness uses cost-adjusted realized net losses only', () => {
  const rows = Array.from({ length: 300 }, (_, index) => forwardRow(index));
  const result = evaluateExpectedShortfallEvidenceReadiness(rows);
  assert.equal(result.status, 'DATA_READY');
  assert.equal(result.lossSamplesPct.length, 300);
  assert.ok(result.lossSamplesPct.every((value) => value >= 0));
});

test('forbidden final-holdout or live tuning blocks enforcement readiness even when every dataset is otherwise ready', () => {
  const forward = Array.from({ length: 350 }, (_, index) => forwardRow(index));
  forward.push(forwardRow(999, { splitRole: 'FINAL_HOLDOUT', usedForTuning: true }));
  const execution = Array.from({ length: 550 }, (_, index) => executionRow(index));
  const result = evaluateSafetyGateEvidenceReadiness({
    forwardObservations: forward,
    executionObservations: execution,
    metaModelEvidence: {
      modelId: 'meta-v1', evaluationSamples: 350, brierScore: 0.18,
      calibrationError: 0.05, evaluatedOnUntouchedData: true,
    },
    fillModelEvidence: {
      modelId: 'fill-v1', evaluationSamples: 600, brierScore: 0.16,
      calibrationError: 0.04, evaluatedOnUntouchedData: true,
    },
  });
  assert.equal(result.leakage.status, 'BLOCKED');
  assert.equal(result.readyForRequiredEnforcement, false);
  assert.ok(result.leakage.blockers.some((entry) => entry.code === 'FORBIDDEN_HOLDOUT_OR_LIVE_TUNING_DETECTED'));
});

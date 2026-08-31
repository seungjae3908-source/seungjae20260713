import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
  type PublicForwardPartialFillCalibrationObservation,
  type PublicForwardPartialFillSampleClass,
} from './public-forward-partial-fill-calibration-collector.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
  persistPublicForwardPartialFillCalibrationDataset,
  type PublicForwardPartialFillCalibrationDataset,
} from './public-forward-partial-fill-calibration-dataset-store.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_SPLIT_AUDIT_SAFETY,
  auditPublicForwardPartialFillCalibrationSplits,
  readAndAuditPublicForwardPartialFillCalibrationDataset,
  type PublicForwardPartialFillRegimeBinding,
  type PublicForwardPartialFillSplitPolicy,
} from './public-forward-partial-fill-calibration-split-audit.service';

const collectorCodeSha = 'a'.repeat(40);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function observation(
  id: string,
  windowStartMs: number,
  overrides: Partial<PublicForwardPartialFillCalibrationObservation> = {},
): PublicForwardPartialFillCalibrationObservation {
  const sampleClass = (overrides.sampleClass ?? 'FORWARD_NATURAL_SAMPLE') as PublicForwardPartialFillSampleClass;
  return {
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_SIMULATION_OBSERVATION',
    sourceType: 'PUBLIC_FORWARD_SIMULATION',
    sampleClass,
    observationId: id,
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantityNotionalBucketIdentity: 'BTCUSDT-LONG-QTY-2',
    collectorCodeSha,
    windowStartMs,
    windowEndMs: windowStartMs + 100,
    observedAtMs: windowStartMs + 200,
    passiveLimitPrice: 100,
    requestedQuantity: 2,
    eligiblePublicTouchQuantityUpperBound: 1,
    opportunityFillRatioUpperBound: 0.5,
    eligiblePublicExecutionIds: [`exec-${id}`],
    actualFillFraction: null,
    actualFillObserved: false,
    queuePositionKnown: false,
    partialFillCostPercent: null,
    sourceIdentity: 'BITGET_PUBLIC_FORWARD_PASSIVE_QUEUE_OPPORTUNITY_V1',
    sourceDigest: digest(`source-${id}`),
    sourceObservationLineageId: `lineage-${id}`,
    sourceObservationLineageDigest: digest(`lineage-${id}`),
    preEventBookDigest: digest(`pre-${id}`),
    forwardPublicFillsDigest: digest(`fills-${id}`),
    postEventBookDigest: digest(`post-${id}`),
    endpoints: ['/api/v3/market/orderbook', '/api/v3/market/fills'],
    forwardCalibrationSampleCredit: sampleClass === 'FORWARD_NATURAL_SAMPLE' ? 1 : 0,
    historicalBackfillCredit: 0,
    testFixtureCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    calibrationArtifactProduced: false,
    durablePersistencePerformed: false,
    calibrationSampleSufficient: false,
    partialFillStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    privateApiUsed: false,
    executionAuthority: 'NONE',
    liveTrading: false,
    orderSubmitted: false,
    ...overrides,
  };
}

function binding(
  current: PublicForwardPartialFillCalibrationObservation,
  overrides: Partial<PublicForwardPartialFillRegimeBinding> = {},
): PublicForwardPartialFillRegimeBinding {
  return {
    observationId: current.observationId,
    sourceObservationLineageDigest: current.sourceObservationLineageDigest,
    market: current.market,
    symbol: current.symbol,
    side: current.side,
    quantityNotionalBucketIdentity: current.quantityNotionalBucketIdentity,
    regimeOwnerIdentity: 'REGIME_BRAIN_EXTERNAL_V1',
    regimeEvidenceIdentity: `regime-evidence-${current.observationId}`,
    regimeEvidenceDigest: digest(`regime-evidence-${current.observationId}`),
    regimePolicyIdentity: 'REGIME_POLICY_V1',
    regimePolicyDigest: digest('REGIME_POLICY_V1'),
    volatilityRegimeIdentity: 'VOL_NORMAL',
    liquidityRegimeIdentity: 'LIQ_NORMAL',
    observedAtMs: current.windowStartMs - 50,
    ...overrides,
  };
}

function policy(overrides: Partial<PublicForwardPartialFillSplitPolicy> = {}): PublicForwardPartialFillSplitPolicy {
  return {
    policyIdentity: 'PARTIAL_FILL_SPLIT_POLICY_V1',
    policyVersion: '1',
    policyFrozenAtMs: 3_500,
    expectedRegimeOwnerIdentity: 'REGIME_BRAIN_EXTERNAL_V1',
    expectedRegimePolicyIdentity: 'REGIME_POLICY_V1',
    expectedRegimePolicyDigest: digest('REGIME_POLICY_V1'),
    maxRegimeEvidenceAgeMs: 500,
    windows: {
      train: { startInclusiveMs: 1_000, endExclusiveMs: 4_000 },
      validation: { startInclusiveMs: 4_000, endExclusiveMs: 7_000 },
      oos: { startInclusiveMs: 7_000, endExclusiveMs: 10_000 },
    },
    overallMinimums: { train: 2, validation: 2, oos: 2 },
    scopeMinimums: [{
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantityNotionalBucketIdentity: 'BTCUSDT-LONG-QTY-2',
      volatilityRegimeIdentity: 'VOL_NORMAL',
      liquidityRegimeIdentity: 'LIQ_NORMAL',
      minimums: { train: 2, validation: 2, oos: 2 },
    }],
    ...overrides,
  };
}

const naturalObservations = () => [
  observation('train-1', 1_500),
  observation('train-2', 2_500),
  observation('validation-1', 4_500),
  observation('validation-2', 5_500),
  observation('oos-1', 7_500),
  observation('oos-2', 8_500),
];

async function withDataset(
  observations: readonly PublicForwardPartialFillCalibrationObservation[],
  sampleClass: PublicForwardPartialFillSampleClass,
  run: (dataset: PublicForwardPartialFillCalibrationDataset) => Promise<void> | void,
) {
  const root = await mkdtemp(join(tmpdir(), 'partial-fill-split-audit-'));
  try {
    const persisted = await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass,
      collectorCodeSha,
      observations,
      nowMs: 11_000,
    });
    await run(persisted.dataset);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('audits a caller-policy-frozen chronological TRAIN/VALIDATION/OOS split without producing cost or OOS PASS', async () => {
  const observations = naturalObservations();
  await withDataset(observations, 'FORWARD_NATURAL_SAMPLE', (dataset) => {
    const result = auditPublicForwardPartialFillCalibrationSplits({
      dataset,
      regimeBindings: observations.map((current) => binding(current)),
      policy: policy(),
    });
    assert.equal(result.status, 'PRESENT');
    assert.deepEqual(result.blockers, []);
    assert.ok(result.audit);
    assert.deepEqual(result.audit.counts, { train: 2, validation: 2, oos: 2 });
    assert.equal(result.audit.regimeScopeComplete, true);
    assert.equal(result.audit.splitAssignmentComplete, true);
    assert.equal(result.audit.calibrationSampleSufficient, true);
    assert.equal(result.audit.sampleDeficits.length, 0);
    assert.equal(result.audit.oosValidationComplete, false);
    assert.equal(result.audit.calibrationArtifactProduced, false);
    assert.equal(result.audit.partialFillCostPresent, false);
    assert.equal(result.audit.naturalEntryCredit, 0);
    assert.equal(result.audit.runtimeCostCredit, 0);
    assert.equal(result.audit.partialFillStatus, 'BLOCKED_DATA');
    assert.equal(result.audit.fullCostReady, false);
    assert.deepEqual(result.audit.assignments.map((item) => item.split), [
      'TRAIN', 'TRAIN', 'VALIDATION', 'VALIDATION', 'OOS', 'OOS',
    ]);
  });
});

test('read-only canonical reader feeds the split audit while N=1 remains explicit BLOCKED_DATA cost truth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'partial-fill-reader-audit-'));
  try {
    const current = observation('train-1', 1_500);
    const persisted = await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [current],
      nowMs: 11_000,
    });
    const result = await readAndAuditPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      expectedDatasetIdentity: persisted.dataset.datasetIdentity,
      expectedDatasetDigest: persisted.dataset.datasetDigest,
      regimeBindings: [binding(current)],
      policy: policy(),
    });
    assert.equal(result.status, 'PRESENT');
    assert.equal(result.datasetIdentity, persisted.dataset.datasetIdentity);
    assert.equal(result.datasetDigest, persisted.dataset.datasetDigest);
    assert.equal(result.datasetRelativePath, persisted.datasetRelativePath);
    assert.equal(result.observationCount, 1);
    assert.ok(result.audit);
    assert.deepEqual(result.audit.counts, { train: 1, validation: 0, oos: 0 });
    assert.equal(result.audit.calibrationSampleSufficient, false);
    assert.ok(result.audit.sampleDeficits.includes('OVERALL_TRAIN:1/2'));
    assert.equal(result.calibrationArtifactProduced, false);
    assert.equal(result.partialFillCostPresent, false);
    assert.equal(result.fullCostReady, false);
    assert.equal(result.evidenceCompleteCredit, 0);
    assert.equal(result.executionAuthority, 'NONE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reader-to-audit seam exposes a fail-closed blocker instead of substituting missing canonical data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'partial-fill-reader-missing-'));
  try {
    const result = await readAndAuditPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      expectedDatasetIdentity: `partial-fill-forward-dataset:FORWARD_NATURAL_SAMPLE:${collectorCodeSha}`,
      expectedDatasetDigest: digest('missing-dataset'),
      regimeBindings: [],
      policy: policy(),
    });
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.match(result.blockers[0], /CANONICAL_PARTIAL_FILL_DATASET_MISSING/u);
    assert.equal(result.audit, null);
    assert.equal(result.partialFillCostPresent, false);
    assert.equal(result.fullCostReady, false);
    assert.equal(result.evidenceCompleteCredit, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports explicit policy deficits without inventing a lower default sample threshold', async () => {
  const observations = naturalObservations();
  await withDataset(observations, 'FORWARD_NATURAL_SAMPLE', (dataset) => {
    const stricter = policy({
      overallMinimums: { train: 3, validation: 3, oos: 3 },
      scopeMinimums: [{
        ...policy().scopeMinimums[0],
        minimums: { train: 3, validation: 3, oos: 3 },
      }],
    });
    const result = auditPublicForwardPartialFillCalibrationSplits({
      dataset,
      regimeBindings: observations.map((current) => binding(current)),
      policy: stricter,
    });
    assert.equal(result.status, 'PRESENT');
    assert.ok(result.audit);
    assert.equal(result.audit.calibrationSampleSufficient, false);
    assert.ok(result.audit.sampleDeficits.includes('OVERALL_TRAIN:2/3'));
    assert.ok(result.audit.sampleDeficits.some((item) => item.includes(':OOS:2/3')));
    assert.equal(result.audit.partialFillCostPresent, false);
  });
});

test('missing external regime evidence fails closed instead of computing a duplicate regime', async () => {
  const observations = naturalObservations();
  await withDataset(observations, 'FORWARD_NATURAL_SAMPLE', (dataset) => {
    const result = auditPublicForwardPartialFillCalibrationSplits({
      dataset,
      regimeBindings: observations.slice(1).map((current) => binding(current)),
      policy: policy(),
    });
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.equal(result.audit, null);
    assert.ok(result.blockers.includes('REGIME_BINDING_MISSING'));
  });
});

test('post-event regime evidence is rejected as leakage', async () => {
  const observations = naturalObservations();
  await withDataset(observations, 'FORWARD_NATURAL_SAMPLE', (dataset) => {
    const bindings = observations.map((current, index) => binding(current, index === 0
      ? { observedAtMs: current.windowStartMs + 1 }
      : {}));
    const result = auditPublicForwardPartialFillCalibrationSplits({ dataset, regimeBindings: bindings, policy: policy() });
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.ok(result.blockers.includes('REGIME_EVIDENCE_AFTER_EVENT_START'));
  });
});

test('stale pre-event regime evidence is rejected', async () => {
  const observations = naturalObservations();
  await withDataset(observations, 'FORWARD_NATURAL_SAMPLE', (dataset) => {
    const bindings = observations.map((current, index) => binding(current, index === 0
      ? { observedAtMs: current.windowStartMs - 501 }
      : {}));
    const result = auditPublicForwardPartialFillCalibrationSplits({ dataset, regimeBindings: bindings, policy: policy() });
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.ok(result.blockers.includes('REGIME_EVIDENCE_STALE'));
  });
});

test('reusing one regime evidence digest across independent samples is rejected as pseudo-replication', async () => {
  const observations = naturalObservations();
  await withDataset(observations, 'FORWARD_NATURAL_SAMPLE', (dataset) => {
    const reused = digest('reused-regime-evidence');
    const bindings = observations.map((current, index) => binding(current, index < 2
      ? { regimeEvidenceDigest: reused }
      : {}));
    const result = auditPublicForwardPartialFillCalibrationSplits({ dataset, regimeBindings: bindings, policy: policy() });
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.ok(result.blockers.includes('REGIME_EVIDENCE_DIGEST_REUSED'));
  });
});

test('overlapping chronological windows fail closed', async () => {
  const observations = naturalObservations();
  await withDataset(observations, 'FORWARD_NATURAL_SAMPLE', (dataset) => {
    const invalid = policy({
      windows: {
        train: { startInclusiveMs: 1_000, endExclusiveMs: 4_500 },
        validation: { startInclusiveMs: 4_000, endExclusiveMs: 7_000 },
        oos: { startInclusiveMs: 7_000, endExclusiveMs: 10_000 },
      },
    });
    const result = auditPublicForwardPartialFillCalibrationSplits({
      dataset,
      regimeBindings: observations.map((current) => binding(current)),
      policy: invalid,
    });
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.ok(result.blockers.includes('TRAIN_VALIDATION_WINDOW_OVERLAP'));
  });
});

test('split policy must be frozen before validation begins', async () => {
  const observations = naturalObservations();
  await withDataset(observations, 'FORWARD_NATURAL_SAMPLE', (dataset) => {
    const result = auditPublicForwardPartialFillCalibrationSplits({
      dataset,
      regimeBindings: observations.map((current) => binding(current)),
      policy: policy({ policyFrozenAtMs: 4_001 }),
    });
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.ok(result.blockers.includes('SPLIT_POLICY_NOT_FROZEN_BEFORE_VALIDATION'));
  });
});

test('research-only dataset cannot receive forward calibration split credit', async () => {
  const observations = naturalObservations().map((current) => ({
    ...current,
    sampleClass: 'CALIBRATION_RESEARCH_SAMPLE' as const,
    forwardCalibrationSampleCredit: 0 as const,
  }));
  await withDataset(observations, 'CALIBRATION_RESEARCH_SAMPLE', (dataset) => {
    const result = auditPublicForwardPartialFillCalibrationSplits({
      dataset,
      regimeBindings: observations.map((current) => binding(current)),
      policy: policy(),
    });
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.ok(result.blockers.includes('FORWARD_NATURAL_DATASET_REQUIRED'));
  });
});

test('scope not declared by the frozen sufficiency policy is rejected instead of cherry-picked away', async () => {
  const observations = naturalObservations();
  observations[5] = observation('oos-2', 8_500, {
    side: 'SHORT',
    quantityNotionalBucketIdentity: 'BTCUSDT-SHORT-QTY-2',
  });
  await withDataset(observations, 'FORWARD_NATURAL_SAMPLE', (dataset) => {
    const result = auditPublicForwardPartialFillCalibrationSplits({
      dataset,
      regimeBindings: observations.map((current) => binding(current)),
      policy: policy(),
    });
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.ok(result.blockers.includes('UNPOLICIED_SCOPE_PRESENT'));
  });
});

test('zero or missing minima are invalid because no default magic N is allowed', async () => {
  const observations = naturalObservations();
  await withDataset(observations, 'FORWARD_NATURAL_SAMPLE', (dataset) => {
    const result = auditPublicForwardPartialFillCalibrationSplits({
      dataset,
      regimeBindings: observations.map((current) => binding(current)),
      policy: policy({ overallMinimums: { train: 0, validation: 2, oos: 2 } }),
    });
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.ok(result.blockers.includes('OVERALL_TRAIN_MINIMUM_INVALID'));
  });
});

test('safety contract keeps regime computation, OOS evaluation, cost, execution, and activation authority off', () => {
  assert.deepEqual(PUBLIC_FORWARD_PARTIAL_FILL_SPLIT_AUDIT_SAFETY, {
    verifiedForwardDatasetRequired: true,
    externalRegimeEvidenceRequired: true,
    regimeComputationOwned: false,
    defaultSampleThresholdAllowed: false,
    randomSplitAllowed: false,
    chronologicalSplitRequired: true,
    oosPerformanceEvaluationAllowed: false,
    partialFillCostProduced: false,
    calibrationArtifactProduced: false,
    oosValidationComplete: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    orderSubmissionAllowed: false,
    fullCostReady: false,
  });
});

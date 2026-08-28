import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHORITATIVE_PAPER_PARTIAL_FILL_CALIBRATION_VERSION,
  AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY,
  buildAuthoritativePaperPartialFillCostEvidence,
  computeAuthoritativePaperPartialFillCalibrationDigest,
  type CompetingCostEvidenceIdentity,
  type PartialFillCalibrationArtifact,
  type PartialFillCalibrationContext,
} from './authoritative-paper-partial-fill-cost-evidence.service';

const nowMs = 2_000_000;
const producerCodeSha = 'a'.repeat(40);
const calibrationCodeSha = 'b'.repeat(40);
const hex = (value: string) => value.repeat(64).slice(0, 64);

function competingCostEvidence(): readonly CompetingCostEvidenceIdentity[] {
  return Object.freeze([
    {
      costOwner: 'SPREAD' as const,
      evidenceIdentity: 'COMPETING_A', evidenceDigest: hex('1'),
      sourceIdentity: 'COST_SOURCE_A', sourceDigest: hex('2'),
      sourceObservationLineageId: 'LINEAGE_A', sourceObservationLineageDigest: hex('3'),
    },
    {
      costOwner: 'VISIBLE_L2_BOOK_WALK_SLIPPAGE' as const,
      evidenceIdentity: 'COMPETING_B', evidenceDigest: hex('4'),
      sourceIdentity: 'COST_SOURCE_B', sourceDigest: hex('5'),
      sourceObservationLineageId: 'LINEAGE_B', sourceObservationLineageDigest: hex('6'),
    },
    {
      costOwner: 'LATENCY_ADVERSE_MOVE' as const,
      evidenceIdentity: 'COMPETING_C', evidenceDigest: hex('7'),
      sourceIdentity: 'COST_SOURCE_C', sourceDigest: hex('8'),
      sourceObservationLineageId: 'LINEAGE_C', sourceObservationLineageDigest: hex('9'),
    },
    {
      costOwner: 'INDEPENDENT_LIQUIDITY_IMPACT' as const,
      evidenceIdentity: 'COMPETING_D', evidenceDigest: hex('a'),
      sourceIdentity: 'COST_SOURCE_D', sourceDigest: hex('b'),
      sourceObservationLineageId: 'LINEAGE_D', sourceObservationLineageDigest: hex('c'),
    },
  ]);
}

function context(overrides: Partial<PartialFillCalibrationContext> = {}): PartialFillCalibrationContext {
  return {
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantityNotionalBucketIdentity: 'BTCUSDT_LONG_QTY_001',
    volatilityRegimeIdentity: 'VOL_NORMAL',
    liquidityRegimeIdentity: 'LIQ_NORMAL',
    producerCodeSha,
    calibrationCodeSha,
    nowMs,
    maximumAgeMs: 5_000,
    competingCostEvidence: competingCostEvidence(),
    ...overrides,
  };
}

function artifactBase(): Omit<PartialFillCalibrationArtifact, 'artifactDigest'> {
  return {
    schemaVersion: AUTHORITATIVE_PAPER_PARTIAL_FILL_CALIBRATION_VERSION,
    evidenceClass: 'CALIBRATION_ARTIFACT',
    testOnly: false,
    artifactId: 'PARTIAL_FILL_CALIBRATION_001',
    methodologyVersion: 'PF_INCREMENTAL_COST_V1',
    producerCodeSha,
    calibrationCodeSha,
    datasetIdentity: 'PF_DATASET_ALL',
    datasetDigest: hex('d'),
    sampleN: 30,
    trainDatasetIdentity: 'PF_TRAIN',
    trainDatasetDigest: hex('e'),
    trainSampleN: 10,
    validationDatasetIdentity: 'PF_VALIDATION',
    validationDatasetDigest: hex('f'),
    validationSampleN: 10,
    oosDatasetIdentity: 'PF_OOS',
    oosDatasetDigest: hex('0'),
    oosSampleN: 10,
    marketScopes: ['CRYPTO_FUTURES'],
    symbolScopes: ['BTCUSDT'],
    sideScopes: ['LONG'],
    quantityNotionalBucketIdentity: 'BTCUSDT_LONG_QTY_001',
    volatilityRegimeIdentity: 'VOL_NORMAL',
    liquidityRegimeIdentity: 'LIQ_NORMAL',
    calibratedAtMs: nowMs - 1_000,
    maximumAgeMs: 5_000,
    provenance: {
      sourceType: 'PUBLIC_FORWARD_SIMULATION',
      sourceProvider: 'PUBLIC_FORWARD_RESEARCH',
      sourceIdentity: 'PF_PUBLIC_FORWARD_SOURCE_V1',
      sourceDigest: hex('1a'),
      immutable: true,
    },
    sourceObservationLineage: {
      lineageId: 'PF_LINEAGE_001',
      lineageDigest: hex('2a'),
      sourceType: 'PUBLIC_FORWARD_SIMULATION',
      sourceIdentity: 'PF_PUBLIC_FORWARD_SOURCE_V1',
      observationCount: 30,
      firstObservedAtMs: nowMs - 4_000,
      lastObservedAtMs: nowMs - 1_500,
    },
    outOfSampleValidationReference: {
      referenceId: 'PF_OOS_REFERENCE_001',
      referenceDigest: hex('3a'),
      trainDatasetIdentity: 'PF_TRAIN',
      trainDatasetDigest: hex('e'),
      validationDatasetIdentity: 'PF_VALIDATION',
      validationDatasetDigest: hex('f'),
      oosDatasetIdentity: 'PF_OOS',
      oosDatasetDigest: hex('0'),
      sampleN: 10,
      status: 'PASS',
      heldOut: true,
      contaminationFree: true,
      evaluatedAtMs: nowMs - 1_200,
    },
    estimatedPartialFillImpactPercent: 0.25,
    estimatedPartialFillImpactBps: 25,
    zeroEvidenceReason: null,
    zeroEvidenceReference: null,
    costOwnership: {
      owner: 'PARTIAL_FILL',
      sourceIdentity: 'PF_PUBLIC_FORWARD_SOURCE_V1',
      sourceDigest: hex('1a'),
    },
    independenceEvidence: {
      status: 'VERIFIED',
      targetVariable: 'PARTIAL_FILL_INCREMENTAL_COST_EXCLUDING_SPREAD_BOOK_WALK_LATENCY_AND_LIQUIDITY_IMPACT',
      spreadExcluded: true,
      bookWalkExcluded: true,
      latencyAdverseMoveExcluded: true,
      liquidityImpactExcluded: true,
      fullImplementationShortfallUsed: false,
      sharedObservationLineageAllowed: false,
      validationReferenceId: 'PF_OOS_REFERENCE_001',
    },
  };
}

function withDigest(
  artifact: Omit<PartialFillCalibrationArtifact, 'artifactDigest'>,
): PartialFillCalibrationArtifact {
  return {
    ...artifact,
    artifactDigest: computeAuthoritativePaperPartialFillCalibrationDigest(artifact),
  };
}

test('independent OOS partial-fill calibration produces estimated cost evidence', () => {
  const artifact = withDigest(artifactBase());
  const result = buildAuthoritativePaperPartialFillCostEvidence({ artifact, expected: context() });
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.evidence?.valuePercent, 0.25);
  assert.equal(result.evidence?.quality, 'ESTIMATED');
  assert.match(result.evidence?.source ?? '', /^INDEPENDENT_PARTIAL_FILL_CALIBRATION:/);
  assert.equal(result.sampleN, 30);
  assert.equal(result.oosSampleN, 10);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.realFillObserved, false);
});

test('missing calibration artifact stays blocked instead of deriving cost from public L2', () => {
  const result = buildAuthoritativePaperPartialFillCostEvidence({ artifact: null, expected: context() });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.evidence, null);
  assert.ok(result.blockers.includes('PARTIAL_FILL_CALIBRATION_ARTIFACT_REQUIRED'));
});

test('test fixture calibration receives zero runtime credit', () => {
  const base = artifactBase();
  const artifact = withDigest({ ...base, evidenceClass: 'TEST_FIXTURE', testOnly: true });
  const result = buildAuthoritativePaperPartialFillCostEvidence({ artifact, expected: context() });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.evidence, null);
  assert.ok(result.blockers.includes('PARTIAL_FILL_TEST_FIXTURE_RUNTIME_CREDIT_FORBIDDEN'));
});

test('partial-fill source identity cannot reuse a competing cost source identity', () => {
  const base = artifactBase();
  const reused = competingCostEvidence()[1].sourceIdentity;
  const artifact = withDigest({
    ...base,
    provenance: { ...base.provenance, sourceIdentity: reused },
    sourceObservationLineage: { ...base.sourceObservationLineage, sourceIdentity: reused },
    costOwnership: { ...base.costOwnership, sourceIdentity: reused },
  });
  const result = buildAuthoritativePaperPartialFillCostEvidence({ artifact, expected: context() });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('PARTIAL_FILL_COST_SOURCE_IDENTITY_REUSED'));
});

test('partial-fill observation lineage cannot alias another cost owner lineage', () => {
  const base = artifactBase();
  const reused = competingCostEvidence()[2];
  const artifact = withDigest({
    ...base,
    sourceObservationLineage: {
      ...base.sourceObservationLineage,
      lineageId: reused.sourceObservationLineageId,
      lineageDigest: reused.sourceObservationLineageDigest,
    },
  });
  const result = buildAuthoritativePaperPartialFillCostEvidence({ artifact, expected: context() });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('PARTIAL_FILL_SOURCE_OBSERVATION_LINEAGE_REUSED'));
});

test('TRAIN VALIDATION and untouched OOS identities must remain distinct', () => {
  const base = artifactBase();
  const artifact = withDigest({
    ...base,
    oosDatasetIdentity: base.validationDatasetIdentity,
  });
  const result = buildAuthoritativePaperPartialFillCostEvidence({ artifact, expected: context() });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('PARTIAL_FILL_SAMPLE_SPLIT_INVALID'));
});

test('exact zero requires independent measured-zero reference tied to lineage and OOS validation', () => {
  const base = artifactBase();
  const invalidZero = withDigest({
    ...base,
    estimatedPartialFillImpactPercent: 0,
    estimatedPartialFillImpactBps: 0,
  });
  const blocked = buildAuthoritativePaperPartialFillCostEvidence({ artifact: invalidZero, expected: context() });
  assert.equal(blocked.status, 'BLOCKED_DATA');
  assert.ok(blocked.blockers.includes('PARTIAL_FILL_MEASURED_ZERO_EVIDENCE_REQUIRED'));

  const validZeroBase = {
    ...base,
    estimatedPartialFillImpactPercent: 0,
    estimatedPartialFillImpactBps: 0,
    zeroEvidenceReason: 'OOS_CALIBRATION_SUPPORTS_MEASURED_ZERO',
    zeroEvidenceReference: {
      referenceId: 'PF_ZERO_REFERENCE_001',
      referenceDigest: hex('4a'),
      result: 'MEASURED_ZERO_COMPATIBLE' as const,
      sourceObservationLineageId: base.sourceObservationLineage.lineageId,
      outOfSampleValidationReferenceId: base.outOfSampleValidationReference.referenceId,
    },
  };
  const validZero = withDigest(validZeroBase);
  const present = buildAuthoritativePaperPartialFillCostEvidence({ artifact: validZero, expected: context() });
  assert.equal(present.status, 'PRESENT');
  assert.equal(present.evidence?.valuePercent, 0);
  assert.equal(present.unknownCostIsZero, false);
});

test('stale or scope-mismatched calibration fails closed', () => {
  const base = artifactBase();
  const stale = withDigest({ ...base, calibratedAtMs: nowMs - 20_000 });
  const staleResult = buildAuthoritativePaperPartialFillCostEvidence({ artifact: stale, expected: context() });
  assert.equal(staleResult.status, 'BLOCKED_DATA');
  assert.ok(staleResult.blockers.includes('PARTIAL_FILL_CALIBRATION_STALE'));

  const scoped = withDigest(base);
  const scopeResult = buildAuthoritativePaperPartialFillCostEvidence({
    artifact: scoped,
    expected: context({ symbol: 'ETHUSDT' }),
  });
  assert.equal(scopeResult.status, 'BLOCKED_DATA');
  assert.ok(scopeResult.blockers.includes('PARTIAL_FILL_SYMBOL_SCOPE_MISMATCH'));
});

test('safety contract forbids L2 derivation, cost reuse, private API, live trading, and missing-data zero', () => {
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.publicForwardCalibrationOnly, true);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.directPublicL2SnapshotMayProducePartialFillCost, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.bookWalkSlippageReusedAsPartialFillCost, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.latencyAdverseMoveReusedAsPartialFillCost, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.liquidityImpactReusedAsPartialFillCost, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.sharedObservationLineageAllowed, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.testFixtureRuntimeCredit, 0);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.missingDataMayProduceZeroCost, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.privateApiAllowed, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.liveTrading, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.orderSubmissionAllowed, false);
});

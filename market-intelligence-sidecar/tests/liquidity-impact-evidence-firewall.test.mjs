import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIQUIDITY_IMPACT_COST_OWNERS,
  LIQUIDITY_IMPACT_EVIDENCE_SCHEMA,
  LIQUIDITY_IMPACT_EVIDENCE_VERSION,
  admitValidatedLiquidityImpactEvidenceForRuntime,
  computeLiquidityImpactArtifactDigest,
  validateLiquidityImpactCalibrationEvidence,
} from '../src/liquidity-impact-evidence-firewall.mjs';

const NOW = Date.UTC(2026, 7, 28, 7, 40, 0);
const DAY = 24 * 60 * 60 * 1_000;
const PRODUCER_SHA = 'a'.repeat(40);
const CALIBRATION_SHA = 'b'.repeat(40);
const PUBLIC_SOURCE_DIGEST = '1'.repeat(64);
const LINEAGE_DIGEST = '2'.repeat(64);
const OWNERSHIP_SOURCE_DIGEST = '3'.repeat(64);
const OOS_REFERENCE_DIGEST = '4'.repeat(64);
const TRAIN_DIGEST = '5'.repeat(64);
const VALIDATION_DIGEST = '6'.repeat(64);

function competingCostEvidence() {
  return [
    {
      costOwner: LIQUIDITY_IMPACT_COST_OWNERS.BOOK_WALK,
      evidenceIdentity: 'book-walk-observation-v1',
      evidenceDigest: '7'.repeat(64),
      sourceIdentity: 'current-visible-depth-execution-loss',
      sourceDigest: '8'.repeat(64),
      sourceObservationLineageId: 'book-walk-lineage-v1',
      sourceObservationLineageDigest: '9'.repeat(64),
    },
    {
      costOwner: LIQUIDITY_IMPACT_COST_OWNERS.LATENCY,
      evidenceIdentity: 'decision-arrival-adverse-move-v1',
      evidenceDigest: 'a'.repeat(64),
      sourceIdentity: 'decision-arrival-price-observation',
      sourceDigest: 'b'.repeat(64),
      sourceObservationLineageId: 'latency-lineage-v1',
      sourceObservationLineageDigest: 'c'.repeat(64),
    },
    {
      costOwner: LIQUIDITY_IMPACT_COST_OWNERS.SPREAD,
      evidenceIdentity: 'spread-observation-v1',
      evidenceDigest: 'd'.repeat(64),
      sourceIdentity: 'best-bid-ask-spread-observation',
      sourceDigest: 'e'.repeat(64),
      sourceObservationLineageId: 'spread-lineage-v1',
      sourceObservationLineageDigest: 'f'.repeat(64),
    },
  ];
}

function expected(overrides = {}) {
  return {
    nowMs: NOW,
    maximumAge: 7 * DAY,
    producerCodeSha: PRODUCER_SHA,
    calibrationCodeSha: CALIBRATION_SHA,
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantityNotionalBucketIdentity: 'btc-usdt-notional-10k-25k-v1',
    volatilityRegimeIdentity: 'btc-realized-volatility-medium-v1',
    provenance: {
      sourceType: 'PUBLIC_HISTORICAL_MARKET_DATA',
      sourceProvider: 'BITGET_PUBLIC_ARCHIVE',
      sourceIdentity: 'bitget-public-historical-depth-trades-v1',
      sourceDigest: PUBLIC_SOURCE_DIGEST,
    },
    competingCostEvidence: competingCostEvidence(),
    ...overrides,
  };
}

function artifact(overrides = {}) {
  const value = {
    schema: LIQUIDITY_IMPACT_EVIDENCE_SCHEMA,
    version: LIQUIDITY_IMPACT_EVIDENCE_VERSION,
    evidenceClass: 'TEST_FIXTURE',
    testOnly: true,
    artifactId: 'test-only-independent-liquidity-impact-btc-v1',
    artifactDigest: null,
    methodologyVersion: 'residual-liquidity-impact-calibration-v1',
    producerCodeSha: PRODUCER_SHA,
    calibrationCodeSha: CALIBRATION_SHA,
    datasetIdentity: 'test-only-bitget-btc-public-history-2026w33-v1',
    datasetDigest: '0'.repeat(64),
    sampleN: 1_000,
    trainSampleN: 800,
    validationSampleN: 200,
    marketScopes: ['CRYPTO_FUTURES'],
    symbolScopes: ['BTCUSDT'],
    sideScopes: ['LONG', 'SHORT'],
    quantityNotionalBucketIdentity: 'btc-usdt-notional-10k-25k-v1',
    volatilityRegimeIdentity: 'btc-realized-volatility-medium-v1',
    calibratedAt: NOW - DAY,
    maximumAge: 7 * DAY,
    provenance: {
      sourceType: 'PUBLIC_HISTORICAL_MARKET_DATA',
      sourceProvider: 'BITGET_PUBLIC_ARCHIVE',
      sourceIdentity: 'bitget-public-historical-depth-trades-v1',
      sourceDigest: PUBLIC_SOURCE_DIGEST,
      immutable: true,
    },
    sourceObservationLineage: {
      lineageId: 'independent-post-trade-residual-lineage-v1',
      lineageDigest: LINEAGE_DIGEST,
      sourceType: 'PUBLIC_HISTORICAL_MARKET_DATA',
      sourceIdentity: 'bitget-public-historical-depth-trades-v1',
      observationCount: 1_000,
      firstObservedAt: NOW - 30 * DAY,
      lastObservedAt: NOW - 2 * DAY,
    },
    outOfSampleValidationReference: {
      referenceId: 'test-only-liquidity-impact-oos-v1',
      referenceDigest: OOS_REFERENCE_DIGEST,
      datasetIdentity: 'test-only-bitget-btc-public-history-2026w33-v1',
      trainDatasetDigest: TRAIN_DIGEST,
      validationDatasetDigest: VALIDATION_DIGEST,
      sampleN: 200,
      status: 'PASS',
      heldOut: true,
      contaminationFree: true,
      evaluatedAt: NOW - DAY,
    },
    estimatedImpactPercent: 0.02,
    estimatedImpactBps: 2,
    zeroEvidenceReason: null,
    zeroEvidenceReference: null,
    costOwnership: {
      owner: LIQUIDITY_IMPACT_COST_OWNERS.LIQUIDITY,
      excludedCostOwners: [
        LIQUIDITY_IMPACT_COST_OWNERS.BOOK_WALK,
        LIQUIDITY_IMPACT_COST_OWNERS.LATENCY,
        LIQUIDITY_IMPACT_COST_OWNERS.SPREAD,
      ],
      sourceIdentity: 'independent-residual-impact-calibration-output-v1',
      sourceDigest: OWNERSHIP_SOURCE_DIGEST,
    },
    independenceEvidence: {
      status: 'VERIFIED',
      targetVariable: 'RESIDUAL_PRICE_IMPACT_AFTER_VISIBLE_BOOK_WALK_AND_LATENCY',
      bookWalkExcluded: true,
      latencyAdverseMoveExcluded: true,
      spreadExcluded: true,
      implementationShortfallDecomposed: true,
      fullImplementationShortfallUsed: false,
      sharedObservationLineageAllowed: false,
      validationReferenceId: 'test-only-liquidity-impact-oos-v1',
    },
    ...overrides,
  };
  value.artifactDigest = computeLiquidityImpactArtifactDigest(value);
  return value;
}

function validate(value, expectedOverrides = {}) {
  return validateLiquidityImpactCalibrationEvidence({
    artifact: value,
    expected: expected(expectedOverrides),
  });
}

function mutated(mutate) {
  const value = artifact();
  mutate(value);
  value.artifactDigest = computeLiquidityImpactArtifactDigest(value);
  return value;
}

test('missing calibration artifact remains BLOCKED_DATA', () => {
  const result = validateLiquidityImpactCalibrationEvidence({ expected: expected() });
  assert.equal(result.validationStatus, 'REJECTED');
  assert.equal(result.liquidityImpactStatus, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('CALIBRATION_ARTIFACT_REQUIRED'));
  assert.equal(result.fullCostReady, false);
});

test('same visible book-walk digest cannot be reused as liquidity impact', () => {
  const bookWalk = competingCostEvidence()[0];
  const value = mutated((item) => {
    item.costOwnership.sourceDigest = bookWalk.sourceDigest;
  });
  const result = validate(value);
  assert.equal(result.validationStatus, 'REJECTED');
  assert.ok(result.blockers.includes('COST_SOURCE_DIGEST_REUSED'));
});

test('same visible book-walk artifact evidence digest is rejected', () => {
  const value = artifact();
  const bookWalkDigest = value.artifactDigest;
  const result = validate(value, {
    competingCostEvidence: competingCostEvidence().map((item, index) => (
      index === 0 ? { ...item, evidenceDigest: bookWalkDigest } : item
    )),
  });
  assert.equal(result.validationStatus, 'REJECTED');
  assert.ok(result.blockers.includes('COST_EVIDENCE_DIGEST_REUSED'));
});

test('same source observation lineage cannot be shared with latency adverse move', () => {
  const latency = competingCostEvidence()[1];
  const value = mutated((item) => {
    item.sourceObservationLineage.lineageId = latency.sourceObservationLineageId;
    item.sourceObservationLineage.lineageDigest = latency.sourceObservationLineageDigest;
  });
  const result = validate(value);
  assert.equal(result.validationStatus, 'REJECTED');
  assert.ok(result.blockers.includes('SOURCE_OBSERVATION_LINEAGE_REUSED'));
});

test('fabricated zero without explicit measured-zero evidence is rejected', () => {
  const value = mutated((item) => {
    item.estimatedImpactPercent = 0;
    item.estimatedImpactBps = 0;
    item.zeroEvidenceReason = null;
    item.zeroEvidenceReference = null;
  });
  const result = validate(value);
  assert.equal(result.validationStatus, 'REJECTED');
  assert.ok(result.blockers.includes('MEASURED_ZERO_EVIDENCE_REQUIRED'));
});

test('explicit measured-zero-compatible artifact can pass structure but remains test-only', () => {
  const value = mutated((item) => {
    item.estimatedImpactPercent = 0;
    item.estimatedImpactBps = 0;
    item.zeroEvidenceReason = 'held-out residual distribution is explicitly zero-compatible';
    item.zeroEvidenceReference = {
      referenceId: 'test-only-zero-measurement-v1',
      referenceDigest: 'c'.repeat(64),
      result: 'MEASURED_ZERO_COMPATIBLE',
      sourceObservationLineageId: item.sourceObservationLineage.lineageId,
      outOfSampleValidationReferenceId: item.outOfSampleValidationReference.referenceId,
    };
  });
  const result = validate(value);
  assert.equal(result.validationStatus, 'PASS');
  assert.equal(result.runtimeEligible, false);
});

test('stale calibration is rejected', () => {
  const value = mutated((item) => {
    item.calibratedAt = NOW - 8 * DAY;
  });
  const result = validate(value);
  assert.equal(result.validationStatus, 'REJECTED');
  assert.ok(result.blockers.includes('CALIBRATION_STALE'));
});

test('wrong market and symbol scopes are rejected', () => {
  const wrongMarket = mutated((item) => { item.marketScopes = ['US_STOCK']; });
  const wrongSymbol = mutated((item) => { item.symbolScopes = ['ETHUSDT']; });
  assert.ok(validate(wrongMarket).blockers.includes('MARKET_SCOPE_MISMATCH'));
  assert.ok(validate(wrongSymbol).blockers.includes('SYMBOL_SCOPE_MISMATCH'));
});

test('producer and calibration SHA mismatches are rejected', () => {
  const producer = mutated((item) => { item.producerCodeSha = 'c'.repeat(40); });
  const calibration = mutated((item) => { item.calibrationCodeSha = 'd'.repeat(40); });
  assert.ok(validate(producer).blockers.includes('PRODUCER_CODE_SHA_MISMATCH'));
  assert.ok(validate(calibration).blockers.includes('CALIBRATION_CODE_SHA_MISMATCH'));
});

test('missing dataset identity digest sample provenance and OOS evidence fail closed', () => {
  const value = mutated((item) => {
    item.datasetIdentity = null;
    item.datasetDigest = null;
    item.sampleN = null;
    item.provenance = null;
    item.sourceObservationLineage = null;
    item.outOfSampleValidationReference = null;
  });
  const result = validate(value);
  for (const blocker of [
    'DATASET_IDENTITY_REQUIRED',
    'DATASET_DIGEST_REQUIRED',
    'SAMPLE_N_REQUIRED',
    'PROVENANCE_REQUIRED',
    'SOURCE_OBSERVATION_LINEAGE_REQUIRED',
    'OOS_VALIDATION_REFERENCE_REQUIRED',
  ]) assert.ok(result.blockers.includes(blocker), blocker);
});

test('provenance mismatch is rejected', () => {
  const value = mutated((item) => {
    item.provenance.sourceProvider = 'UNEXPECTED_PROVIDER';
  });
  const result = validate(value);
  assert.equal(result.validationStatus, 'REJECTED');
  assert.ok(result.blockers.includes('PROVENANCE_MISMATCH'));
});

test('negative NaN and infinite impact costs are rejected', () => {
  for (const invalid of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    const value = artifact();
    value.estimatedImpactPercent = invalid;
    const result = validate(value);
    assert.equal(result.validationStatus, 'REJECTED');
    assert.ok(result.blockers.includes('LIQUIDITY_IMPACT_COST_INVALID'));
  }
});

test('VISIBLE_L2_BOOK_WALK_ONLY output cannot be copied into market impact', () => {
  const value = mutated((item) => {
    item.methodologyVersion = 'VISIBLE_L2_BOOK_WALK_ONLY';
    item.costOwnership.sourceIdentity = 'VISIBLE_L2_BOOK_WALK_ONLY';
  });
  const result = validate(value);
  assert.equal(result.validationStatus, 'REJECTED');
  assert.ok(result.blockers.includes('FORBIDDEN_METHODOLOGY_REUSED'));
  assert.ok(result.blockers.includes('FORBIDDEN_COST_SOURCE_REUSED'));
});

test('full implementation shortfall cannot be labeled liquidity impact', () => {
  const value = mutated((item) => {
    item.methodologyVersion = 'implementation-shortfall-square-root-v1';
    item.independenceEvidence.targetVariable = 'IMPLEMENTATION_SHORTFALL';
    item.independenceEvidence.fullImplementationShortfallUsed = true;
  });
  const result = validate(value);
  assert.equal(result.validationStatus, 'REJECTED');
  assert.ok(result.blockers.includes('FORBIDDEN_METHODOLOGY_REUSED'));
  assert.ok(result.blockers.includes('INDEPENDENCE_EVIDENCE_INVALID'));
});

test('spread or slippage source identity cannot be reused', () => {
  const spread = competingCostEvidence()[2];
  const value = mutated((item) => {
    item.costOwnership.sourceIdentity = spread.sourceIdentity;
  });
  const result = validate(value);
  assert.equal(result.validationStatus, 'REJECTED');
  assert.ok(result.blockers.includes('COST_SOURCE_IDENTITY_REUSED'));
});

test('valid structurally independent fixture passes validator but earns zero runtime credit', () => {
  const value = artifact();
  const validation = validate(value);
  assert.equal(validation.validationStatus, 'PASS');
  assert.equal(validation.liquidityImpactStatus, 'BLOCKED_DATA');
  assert.equal(validation.runtimeEligible, false);
  assert.equal(validation.testFixtureRuntimeCredit, 0);
  assert.equal(validation.naturalEvidenceCredit, 0);
  assert.equal(validation.fullCostReady, false);

  const runtime = admitValidatedLiquidityImpactEvidenceForRuntime({
    artifact: value,
    expected: expected(),
  });
  assert.equal(runtime.validationStatus, 'REJECTED');
  assert.equal(runtime.liquidityImpactStatus, 'BLOCKED_DATA');
  assert.equal(runtime.artifact, null);
  assert.ok(runtime.blockers.includes('TEST_FIXTURE_RUNTIME_CREDIT_FORBIDDEN'));
  assert.equal(runtime.testFixtureRuntimeCredit, 0);
  assert.equal(runtime.naturalEvidenceCredit, 0);
  assert.equal(runtime.fullCostReady, false);
});

test('forged PASS validation object cannot bypass raw artifact revalidation', () => {
  const forged = {
    validationStatus: 'PASS',
    runtimeEligible: true,
    artifact: {
      ...artifact({ evidenceClass: 'CALIBRATION_ARTIFACT', testOnly: false }),
    },
  };
  const runtime = admitValidatedLiquidityImpactEvidenceForRuntime(forged);
  assert.equal(runtime.validationStatus, 'REJECTED');
  assert.equal(runtime.liquidityImpactStatus, 'BLOCKED_DATA');
  assert.ok(runtime.blockers.includes('VALIDATION_CONTEXT_REQUIRED'));
  assert.equal(runtime.fullCostReady, false);
});


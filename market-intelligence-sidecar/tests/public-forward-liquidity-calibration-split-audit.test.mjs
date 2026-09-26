import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  mergeLiquidityCalibrationBatch,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_SAFETY,
  auditPublicForwardLiquidityCalibrationSplits,
  computePublicForwardLiquiditySplitPolicyDigest,
} from '../src/public-forward-liquidity-calibration-split-audit.mjs';

const COLLECTOR_SHA = 'a'.repeat(40);
const hex = (value) => value.repeat(64).slice(0, 64);

function observation(id, eventTimestampMs, sourceDigit, publicExecutionId = `exec-${id}`, overrides = {}) {
  return {
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    observationId: id,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    forwardCalibrationSampleCredit: 1,
    historicalBackfillForwardCredit: 0,
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    eventTimestampMs,
    receiveTimestampMs: eventTimestampMs + 10,
    aggressiveSide: 'BUY',
    aggressiveSideMethod: 'BITGET_PUBLIC_TRADE_SIDE_VERIFIED_AT_PRE_EVENT_BBO',
    tradeFlowQuantity: 2,
    tradeFlowNotional: 200,
    publicExecutionPrice: 100,
    preEventBestBid: 99,
    preEventBestAsk: 101,
    preEventMid: 100,
    preEventSpread: 2,
    preEventSpreadBps: 200,
    preEventVisibleL2Depth: { bids: [{ price: 99, quantity: 10 }], asks: [{ price: 101, quantity: 10 }] },
    preEventBookDigest: hex('b'),
    instantaneousVisibleDepthBookWalk: {
      identity: `book-walk-${id}`,
      kind: 'INSTANTANEOUS_VISIBLE_DEPTH_BOOK_WALK',
      ownership: 'SLIPPAGE_VISIBLE_L2_BOOK_WALK_ONLY',
      calibrationSourceOnly: true,
      liquidityImpactCoefficient: null,
    },
    subsequentPublicPriceDrift: [{
      identity: `drift-${id}`,
      kind: 'SUBSEQUENT_PUBLIC_PRICE_DRIFT',
      calibrationSourceOnly: true,
      executionCostEligible: false,
    }],
    publicDataSource: 'BITGET_PUBLIC_UTA_V3',
    rawSourceProvenance: {
      publicTrade: {
        provider: 'BITGET_PUBLIC_UTA_V3',
        endpoint: '/api/v3/market/fills',
        publicExecutionId,
      },
    },
    sourceDigest: hex(sourceDigit),
    collectorCodeSha: COLLECTOR_SHA,
    missingDataFlags: [],
    calibrationSourceOnly: true,
    executionCostEligible: false,
    liquidityImpactCoefficient: null,
    causalMarketImpactClaim: false,
    paperOrderSourceAllowed: false,
    safety: {
      publicDataOnly: true,
      executionAuthority: 'NONE',
      privateTradingApiAllowed: false,
      liveTradingAllowed: false,
      realOrderAllowed: false,
    },
    ...overrides,
  };
}

function dataset(observations = [
  observation('obs-train', 1_000, '1'),
  observation('obs-validation', 2_000, '2'),
  observation('obs-oos', 3_000, '3'),
]) {
  return mergeLiquidityCalibrationBatch(null, {
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    capability: { PUBLIC_CALIBRATION_DATA_CAPABLE: true },
    observations,
    droppedEvents: [],
    datasetProvenance: {
      rawSource: {
        provider: 'BITGET_PUBLIC_UTA_V3',
        endpoints: ['/api/v3/market/orderbook', '/api/v3/market/fills'],
        privateApiUsed: false,
      },
      collectionPeriod: { startedAtMs: 900, completedAtMs: 3_100 },
      firstObservedAtMs: 1_000,
      lastObservedAtMs: 3_000,
      eventCount: observations.length,
      droppedCount: 0,
      droppedReasons: {},
      rawDigest: hex('4'),
      normalizedDigest: hex('5'),
      collectorCodeSha: COLLECTOR_SHA,
    },
  }).dataset;
}

function policy(overrides = {}) {
  const value = {
    policyIdentity: 'liquidity-forward-split-policy-v1',
    policyVersion: 'v1',
    policyDigest: null,
    policyFrozenAtMs: 900,
    expectedScopeOwnerIdentity: 'canonical-liquidity-quantity-scope-owner',
    expectedScopePolicyIdentity: 'canonical-liquidity-quantity-scope-policy-v1',
    expectedScopePolicyDigest: hex('6'),
    expectedRegimeOwnerIdentity: 'canonical-regime-owner',
    expectedRegimePolicyIdentity: 'canonical-regime-policy-v1',
    expectedRegimePolicyDigest: hex('7'),
    maxRegimeEvidenceAgeMs: 500,
    windows: {
      train: { startInclusiveMs: 500, endExclusiveMs: 1_500 },
      validation: { startInclusiveMs: 1_500, endExclusiveMs: 2_500 },
      oos: { startInclusiveMs: 2_500, endExclusiveMs: 3_500 },
    },
    overallMinimums: { train: 1, validation: 1, oos: 1 },
    scopeMinimums: [{
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      aggressiveSide: 'BUY',
      quantityNotionalBucketIdentity: 'bucket-1',
      volatilityRegimeIdentity: 'VOL_NORMAL',
      liquidityRegimeIdentity: 'LIQ_NORMAL',
      minimums: { train: 1, validation: 1, oos: 1 },
    }],
    ...overrides,
  };
  value.policyDigest = computePublicForwardLiquiditySplitPolicyDigest(value);
  return value;
}

function scopeBinding(item, index) {
  return {
    observationId: item.observationId,
    sourceDigest: item.sourceDigest,
    market: item.market,
    symbol: item.symbol,
    aggressiveSide: item.aggressiveSide,
    tradeFlowQuantity: item.tradeFlowQuantity,
    tradeFlowNotional: item.tradeFlowNotional,
    quantityNotionalBucketIdentity: 'bucket-1',
    scopeOwnerIdentity: 'canonical-liquidity-quantity-scope-owner',
    scopeEvidenceIdentity: `scope-evidence-${item.observationId}`,
    scopeEvidenceDigest: hex(String(index + 8)),
    scopePolicyIdentity: 'canonical-liquidity-quantity-scope-policy-v1',
    scopePolicyDigest: hex('6'),
    scopePolicyFrozenAtMs: 800,
  };
}

function regimeBinding(item, index) {
  return {
    observationId: item.observationId,
    sourceDigest: item.sourceDigest,
    market: item.market,
    symbol: item.symbol,
    aggressiveSide: item.aggressiveSide,
    regimeOwnerIdentity: 'canonical-regime-owner',
    regimeEvidenceIdentity: `regime-evidence-${item.observationId}`,
    regimeEvidenceDigest: hex(String(index + 11)),
    regimePolicyIdentity: 'canonical-regime-policy-v1',
    regimePolicyDigest: hex('7'),
    volatilityRegimeIdentity: 'VOL_NORMAL',
    liquidityRegimeIdentity: 'LIQ_NORMAL',
    observedAtMs: item.eventTimestampMs - 100,
  };
}

function evidenceFor(data) {
  return {
    scopeBindings: data.observations.map(scopeBinding),
    regimeBindings: data.observations.map(regimeBinding),
  };
}

test('explicit frozen TRAIN VALIDATION untouched-OOS policy can become sample-sufficient without producing impact cost', () => {
  const data = dataset();
  const evidence = evidenceFor(data);
  const result = auditPublicForwardLiquidityCalibrationSplits({
    dataset: data,
    ...evidence,
    policy: policy(),
  });
  assert.equal(result.status, 'PRESENT');
  assert.deepEqual(result.blockers, []);
  assert.equal(result.audit.calibrationSampleSufficient, true);
  assert.deepEqual(result.audit.counts, { train: 1, validation: 1, oos: 1 });
  assert.equal(result.audit.oosValidationComplete, false);
  assert.equal(result.audit.calibrationArtifactProduced, false);
  assert.equal(result.audit.liquidityImpactPresent, false);
  assert.equal(result.audit.liquidityImpactStatus, 'BLOCKED_DATA');
  assert.equal(result.audit.naturalEntryCredit, 0);
  assert.equal(result.audit.runtimeCostCredit, 0);
  assert.equal(result.audit.fullCostReady, false);
});

test('no default N exists and non-positive explicit minimums fail closed', () => {
  const value = policy({ overallMinimums: { train: 0, validation: 1, oos: 1 } });
  const data = dataset();
  const result = auditPublicForwardLiquidityCalibrationSplits({ dataset: data, ...evidenceFor(data), policy: value });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('OVERALL_TRAIN_MINIMUM_INVALID'));
});

test('split policy frozen after validation starts is rejected', () => {
  const value = policy({ policyFrozenAtMs: 1_600 });
  const data = dataset();
  const result = auditPublicForwardLiquidityCalibrationSplits({ dataset: data, ...evidenceFor(data), policy: value });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('SPLIT_POLICY_NOT_FROZEN_BEFORE_VALIDATION'));
});

test('missing external quantity scope evidence fails closed instead of inventing a bucket', () => {
  const data = dataset();
  const evidence = evidenceFor(data);
  evidence.scopeBindings.pop();
  const result = auditPublicForwardLiquidityCalibrationSplits({ dataset: data, ...evidence, policy: policy() });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('SCOPE_BINDING_MISSING'));
});

test('scope policy must have been frozen before the credited event', () => {
  const data = dataset();
  const evidence = evidenceFor(data);
  evidence.scopeBindings[0] = { ...evidence.scopeBindings[0], scopePolicyFrozenAtMs: 1_001 };
  const result = auditPublicForwardLiquidityCalibrationSplits({ dataset: data, ...evidence, policy: policy() });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('SCOPE_POLICY_NOT_FROZEN_BEFORE_EVENT'));
});

test('future or stale regime evidence cannot classify a forward observation', () => {
  const data = dataset();
  const future = evidenceFor(data);
  future.regimeBindings[0] = { ...future.regimeBindings[0], observedAtMs: 1_001 };
  const futureResult = auditPublicForwardLiquidityCalibrationSplits({ dataset: data, ...future, policy: policy() });
  assert.ok(futureResult.blockers.includes('REGIME_EVIDENCE_AFTER_EVENT'));

  const stale = evidenceFor(data);
  stale.regimeBindings[0] = { ...stale.regimeBindings[0], observedAtMs: 400 };
  const staleResult = auditPublicForwardLiquidityCalibrationSplits({ dataset: data, ...stale, policy: policy() });
  assert.ok(staleResult.blockers.includes('REGIME_EVIDENCE_STALE'));
});

test('unpolicied regime or bucket scope cannot be silently cherry-picked away', () => {
  const data = dataset();
  const evidence = evidenceFor(data);
  evidence.scopeBindings[2] = { ...evidence.scopeBindings[2], quantityNotionalBucketIdentity: 'bucket-2' };
  const result = auditPublicForwardLiquidityCalibrationSplits({ dataset: data, ...evidence, policy: policy() });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('UNPOLICIED_SCOPE_PRESENT'));
});

test('same public execution cannot receive multiple sample credit under different observation IDs', () => {
  const data = dataset([
    observation('obs-train', 1_000, '1', 'same-exec'),
    observation('obs-validation', 2_000, '2', 'same-exec'),
    observation('obs-oos', 3_000, '3', 'unique-exec'),
  ]);
  const result = auditPublicForwardLiquidityCalibrationSplits({ dataset: data, ...evidenceFor(data), policy: policy() });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('DUPLICATE_PUBLIC_EXECUTION_CREDIT_FORBIDDEN'));
});

test('insufficient genuine sample remains BLOCKED_DATA with exact deficits and no OOS-performance claim', () => {
  const data = dataset();
  const value = policy({ overallMinimums: { train: 2, validation: 1, oos: 1 } });
  const result = auditPublicForwardLiquidityCalibrationSplits({ dataset: data, ...evidenceFor(data), policy: value });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('CALIBRATION_SAMPLE_INSUFFICIENT'));
  assert.ok(result.audit.sampleDeficits.includes('OVERALL:TRAIN:1<2'));
  assert.equal(result.audit.calibrationSampleSufficient, false);
  assert.equal(result.audit.oosValidationComplete, false);
  assert.equal(result.audit.liquidityImpactPresent, false);
});

test('historical/backfill or execution-cost authority escalation is rejected', () => {
  const historical = dataset([
    observation('obs-train', 1_000, '1', 'exec-train', { historicalBackfillForwardCredit: 1 }),
    observation('obs-validation', 2_000, '2'),
    observation('obs-oos', 3_000, '3'),
  ]);
  const historicalResult = auditPublicForwardLiquidityCalibrationSplits({
    dataset: historical,
    ...evidenceFor(historical),
    policy: policy(),
  });
  assert.ok(historicalResult.blockers.includes('NON_FORWARD_OBSERVATION_CREDIT_FORBIDDEN'));

  const escalated = dataset([
    observation('obs-train', 1_000, '1', 'exec-train', { executionCostEligible: true }),
    observation('obs-validation', 2_000, '2'),
    observation('obs-oos', 3_000, '3'),
  ]);
  const escalatedResult = auditPublicForwardLiquidityCalibrationSplits({
    dataset: escalated,
    ...evidenceFor(escalated),
    policy: policy(),
  });
  assert.ok(escalatedResult.blockers.includes('DATASET_INVALID')
    || escalatedResult.blockers.includes('OBSERVATION_AUTHORITY_ESCALATION'));
});

test('safety contract keeps tuning defaults cost authority and execution disabled', () => {
  assert.deepEqual(PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_SAFETY, {
    verifiedForwardDatasetRequired: true,
    externalScopeEvidenceRequired: true,
    externalRegimeEvidenceRequired: true,
    bucketComputationOwned: false,
    regimeComputationOwned: false,
    defaultSampleThresholdAllowed: false,
    randomSplitAllowed: false,
    chronologicalSplitRequired: true,
    oosOutcomeEvaluationAllowed: false,
    calibrationArtifactProduced: false,
    liquidityImpactProduced: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    orderSubmissionAllowed: false,
    fullCostReady: false,
  });
});

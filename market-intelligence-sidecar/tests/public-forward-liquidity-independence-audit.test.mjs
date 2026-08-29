import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeBitgetPublicOrderBookFrame,
  normalizeBitgetPublicTradesFrame,
} from '../src/public-data.mjs';
import {
  buildPublicLiquidityObservationBatch,
  mergeLiquidityCalibrationBatch,
  sha256,
  verifyLiquidityCalibrationDataset,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  computePublicForwardLiquiditySplitPolicyDigest,
} from '../src/public-forward-liquidity-calibration-split-audit.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_INDEPENDENCE_SAFETY,
  auditPublicForwardLiquidityIndependentSplits,
  buildPublicForwardLiquidityIndependentProjection,
  classifyPublicForwardLiquidityIndependence,
} from '../src/public-forward-liquidity-independence-audit.mjs';

const COLLECTOR_SHA = 'a'.repeat(40);

function bookFrame({ marketTimestampMs, seed }) {
  return normalizeBitgetPublicOrderBookFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: {
        ts: String(marketTimestampMs),
        b: [[100, 20 + seed], [99, 30 + seed]],
        a: [[101, 20 + seed], [102, 30 + seed]],
      },
    },
    requestStartedAtMs: marketTimestampMs - 50,
    receiveTimestampMs: marketTimestampMs + 10,
    maxFrameAgeMs: 10_000,
    endpoint: '/api/v3/market/orderbook',
    query: `category=USDT-FUTURES&symbol=BTCUSDT&limit=50&seed=${seed}`,
  });
}

function tradeFrame({ events, receiveTimestampMs, seed }) {
  return normalizeBitgetPublicTradesFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: events.map((event) => ({
        execId: event.execId,
        execLinkId: `${event.execId}-link`,
        price: String(event.price ?? 101),
        size: String(event.quantity ?? 1),
        side: event.side ?? 'buy',
        ts: String(event.eventTimestampMs),
        isRPI: 'NO',
      })),
    },
    requestStartedAtMs: receiveTimestampMs - 50,
    receiveTimestampMs,
    endpoint: '/api/v3/market/fills',
    query: `category=USDT-FUTURES&symbol=BTCUSDT&limit=100&seed=${seed}`,
  });
}

function batch({ base, events, seed }) {
  const preEventBook = bookFrame({ marketTimestampMs: base - 100, seed });
  const trades = tradeFrame({ events, receiveTimestampMs: base + 300, seed });
  const postEventBooks = [bookFrame({ marketTimestampMs: base + 600, seed: seed + 100 })];
  return buildPublicLiquidityObservationBatch({
    preEventBook,
    tradeFrame: trades,
    postEventBooks,
    collectorCodeSha: COLLECTOR_SHA,
    maxPreEventBookAgeMs: 5_000,
  });
}

function mergeBatches(batches) {
  let dataset = null;
  for (const current of batches) dataset = mergeLiquidityCalibrationBatch(dataset, current).dataset;
  assert.deepEqual(verifyLiquidityCalibrationDataset(dataset), { valid: true, reason: null });
  return dataset;
}

function genuineDataset() {
  return mergeBatches([
    batch({
      base: 10_000,
      seed: 1,
      events: [
        { execId: 'exec-train-1', eventTimestampMs: 10_000, quantity: 1 },
        { execId: 'exec-train-2', eventTimestampMs: 10_050, quantity: 2 },
      ],
    }),
    batch({
      base: 20_000,
      seed: 2,
      events: [{ execId: 'exec-validation', eventTimestampMs: 20_000, quantity: 1 }],
    }),
    batch({
      base: 30_000,
      seed: 3,
      events: [{ execId: 'exec-oos', eventTimestampMs: 30_000, quantity: 1 }],
    }),
  ]);
}

function policy() {
  const body = {
    policyIdentity: 'liquidity-independent-forward-split-v1',
    policyVersion: 'v1',
    policyFrozenAtMs: 8_000,
    expectedScopeOwnerIdentity: 'canonical-liquidity-scope-owner',
    expectedScopePolicyIdentity: 'canonical-liquidity-scope-policy-v1',
    expectedScopePolicyDigest: sha256('scope-policy-v1'),
    expectedRegimeOwnerIdentity: 'canonical-liquidity-regime-owner',
    expectedRegimePolicyIdentity: 'canonical-liquidity-regime-policy-v1',
    expectedRegimePolicyDigest: sha256('regime-policy-v1'),
    maxRegimeEvidenceAgeMs: 1_000,
    windows: {
      train: { startInclusiveMs: 9_000, endExclusiveMs: 15_000 },
      validation: { startInclusiveMs: 19_000, endExclusiveMs: 25_000 },
      oos: { startInclusiveMs: 29_000, endExclusiveMs: 35_000 },
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
  };
  return { ...body, policyDigest: computePublicForwardLiquiditySplitPolicyDigest(body) };
}

function bindings(dataset, splitPolicy) {
  const scopeBindings = dataset.observations.map((observation, index) => ({
    observationId: observation.observationId,
    sourceDigest: observation.sourceDigest,
    market: observation.market,
    symbol: observation.symbol,
    aggressiveSide: observation.aggressiveSide,
    tradeFlowQuantity: observation.tradeFlowQuantity,
    tradeFlowNotional: observation.tradeFlowNotional,
    quantityNotionalBucketIdentity: 'bucket-1',
    scopeOwnerIdentity: splitPolicy.expectedScopeOwnerIdentity,
    scopePolicyIdentity: splitPolicy.expectedScopePolicyIdentity,
    scopePolicyDigest: splitPolicy.expectedScopePolicyDigest,
    scopeEvidenceIdentity: `scope-evidence-${index}`,
    scopeEvidenceDigest: sha256(`scope-evidence-${index}`),
    scopePolicyFrozenAtMs: 8_000,
  }));
  const regimeBindings = dataset.observations.map((observation, index) => ({
    observationId: observation.observationId,
    sourceDigest: observation.sourceDigest,
    market: observation.market,
    symbol: observation.symbol,
    aggressiveSide: observation.aggressiveSide,
    regimeOwnerIdentity: splitPolicy.expectedRegimeOwnerIdentity,
    regimePolicyIdentity: splitPolicy.expectedRegimePolicyIdentity,
    regimePolicyDigest: splitPolicy.expectedRegimePolicyDigest,
    regimeEvidenceIdentity: `regime-evidence-${index}`,
    regimeEvidenceDigest: sha256(`regime-evidence-${index}`),
    volatilityRegimeIdentity: 'VOL_NORMAL',
    liquidityRegimeIdentity: 'LIQ_NORMAL',
    observedAtMs: observation.eventTimestampMs - 10,
  }));
  return { scopeBindings, regimeBindings };
}

test('raw accepted rows sharing one source frame collapse before split credit', () => {
  const dataset = genuineDataset();
  const result = classifyPublicForwardLiquidityIndependence(dataset);
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.audit.counts.RAW_ACCEPTED_N, 4);
  assert.equal(result.audit.counts.UNIQUE_EVENT_N, 4);
  assert.equal(result.audit.counts.INDEPENDENT_N, 3);
  assert.equal(result.audit.counts.DEPENDENT_REJECTED_N, 1);
  assert.equal(result.audit.counts.SOURCE_FRAME_COLLISION_N, 1);
  assert.equal(result.audit.counts.INDEPENDENT_BUY_N, 3);
  assert.equal(result.audit.counts.INDEPENDENT_SELL_N, 0);
  assert.ok(result.audit.dependentRejections[0].reasons.includes('SAME_SOURCE_FRAME'));
  assert.equal(result.audit.rawAcceptedNDescriptiveOnly, true);
});

test('independent projection stays verifiable and binds predecessor raw dataset digest', () => {
  const dataset = genuineDataset();
  const classified = classifyPublicForwardLiquidityIndependence(dataset);
  const projection = buildPublicForwardLiquidityIndependentProjection(dataset, classified.audit);
  assert.equal(projection.predecessorDigest, dataset.datasetDigest);
  assert.equal(projection.observations.length, 3);
  assert.deepEqual(verifyLiquidityCalibrationDataset(projection), { valid: true, reason: null });
  assert.ok(projection.duplicateAttempts.some((value) => value.reason === 'DEPENDENT_OBSERVATION_SPLIT_CREDIT_FORBIDDEN'));
});

test('canonical split sufficiency is evaluated only on effective-independent observations', () => {
  const dataset = genuineDataset();
  const splitPolicy = policy();
  const { scopeBindings, regimeBindings } = bindings(dataset, splitPolicy);
  const result = auditPublicForwardLiquidityIndependentSplits({
    dataset,
    scopeBindings,
    regimeBindings,
    policy: splitPolicy,
  });
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.audit.totalObservationCount, 3);
  assert.equal(result.audit.rawAcceptedObservationCount, 4);
  assert.equal(result.audit.effectiveIndependentObservationCount, 3);
  assert.equal(result.audit.dependentRejectedObservationCount, 1);
  assert.equal(result.audit.calibrationSampleSufficient, true);
  assert.equal(result.audit.independenceFilteredBeforeSplit, true);
  assert.equal(result.audit.rawAcceptedNDescriptiveOnly, true);
  assert.equal(result.audit.fullCostReady, false);
  assert.equal(result.audit.liquidityImpactPresent, false);
  assert.equal(result.audit.runtimeCostCredit, 0);
});

test('insufficient independent N stays BLOCKED_DATA even when raw N is larger', () => {
  const dataset = genuineDataset();
  const splitPolicy = policy();
  splitPolicy.overallMinimums.train = 2;
  splitPolicy.scopeMinimums[0].minimums.train = 2;
  splitPolicy.policyDigest = computePublicForwardLiquiditySplitPolicyDigest(splitPolicy);
  const { scopeBindings, regimeBindings } = bindings(dataset, splitPolicy);
  const result = auditPublicForwardLiquidityIndependentSplits({
    dataset,
    scopeBindings,
    regimeBindings,
    policy: splitPolicy,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('CALIBRATION_SAMPLE_INSUFFICIENT'));
  assert.equal(result.audit.rawAcceptedObservationCount, 4);
  assert.equal(result.audit.effectiveIndependentObservationCount, 3);
  assert.equal(result.audit.calibrationSampleSufficient, false);
  assert.equal(result.audit.fullCostReady, false);
});

test('conflicting payloads for one public execution identity fail closed', () => {
  const first = batch({
    base: 40_000,
    seed: 4,
    events: [{ execId: 'collision-exec', eventTimestampMs: 40_000, quantity: 1 }],
  });
  const second = batch({
    base: 40_000,
    seed: 5,
    events: [{ execId: 'collision-exec', eventTimestampMs: 40_000, quantity: 3 }],
  });
  const dataset = mergeBatches([first, second]);
  const result = classifyPublicForwardLiquidityIndependence(dataset);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('PUBLIC_EVENT_IDENTITY_COLLISION'));
  assert.equal(result.audit.counts.IDENTITY_COLLISION_N, 1);
  assert.equal(result.audit.fullCostReady, false);
});

test('independence audit is deterministic and never produces cost or execution authority', () => {
  const dataset = genuineDataset();
  const first = classifyPublicForwardLiquidityIndependence(dataset);
  const second = classifyPublicForwardLiquidityIndependence(dataset);
  assert.equal(first.audit.auditDigest, second.audit.auditDigest);
  assert.deepEqual(PUBLIC_FORWARD_LIQUIDITY_INDEPENDENCE_SAFETY, {
    singleRawDatasetSsotRequired: true,
    rawAcceptedNDescriptiveOnly: true,
    crossEventDedupRequired: true,
    sourceFrameIndependenceRequired: true,
    overlappingObservationWindowCreditAllowed: false,
    effectiveIndependentSampleCreditOwnedHere: true,
    independenceFilteredBeforeSplit: true,
    splitPolicyStillExternallyFrozen: true,
    splitAssignmentOwnedByCanonicalSplitAuditor: true,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  });
});

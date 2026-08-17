import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRealizedTca,
  evaluateCalibratedFillModel,
  evaluateExecutionQuality,
  evaluateQueueEvidence,
  walkOrderBook,
} from '../src/execution-quality.mjs';

const NOW = Date.UTC(2026, 7, 17, 7, 40, 0);

function goodFillModel() {
  return {
    modelId: 'fill-v1',
    fillProbability: 0.78,
    evaluationSamples: 1200,
    brierScore: 0.16,
    calibrationError: 0.04,
    evaluatedAt: NOW - 60_000,
  };
}

test('book walk reports visible-depth coverage and non-negative buy slippage without inventing missing depth', () => {
  const result = walkOrderBook({
    direction: 'BUY',
    targetQty: 3,
    arrivalPrice: 100,
    asks: [[100, 1], [101, 1], [102, 1]],
  }, { maxBookWalkSlippageBps: 500 });
  assert.equal(result.status, 'PASS');
  assert.equal(result.coverageRatio, 1);
  assert.equal(result.vwap, 101);
  assert.ok(result.slippageBps > 0);
  assert.equal(result.permanentMarketImpactEstimated, false);
});

test('insufficient L2 depth vetoes executable coverage rather than assuming a full fill', () => {
  const result = walkOrderBook({
    direction: 'SELL',
    targetQty: 10,
    arrivalPrice: 100,
    bids: [[100, 2], [99, 2]],
  });
  assert.equal(result.status, 'VETO');
  assert.equal(result.filledQty, 4);
  assert.equal(result.unfilledQty, 6);
  assert.ok(result.reasons.includes('INSUFFICIENT_VISIBLE_DEPTH'));
});

test('queue analytics require verified order-level evidence and never infer L3 position from L2', () => {
  const unavailable = evaluateQueueEvidence({ queueAheadQty: 10, ownOrderQty: 2, marketableQtyAtLevel: 20 });
  assert.equal(unavailable.status, 'NOT_AVAILABLE');
  assert.equal(unavailable.reason, 'VERIFIED_QUEUE_EVIDENCE_REQUIRED');

  const observed = evaluateQueueEvidence({
    queueEvidenceVerified: true,
    queueAheadQty: 10,
    ownOrderQty: 2,
    marketableQtyAtLevel: 11,
    cancellationsAheadQty: 0,
  });
  assert.equal(observed.status, 'OBSERVED_ONLY');
  assert.equal(observed.executableOwnQty, 1);
  assert.equal(observed.observedFillFraction, 0.5);
  assert.equal(observed.probabilityEstimated, false);
});

test('fill probability is trusted only when empirical model calibration evidence is sufficient', () => {
  const pass = evaluateCalibratedFillModel(goodFillModel(), {}, NOW);
  assert.equal(pass.status, 'PASS');

  const undersampled = evaluateCalibratedFillModel({ ...goodFillModel(), evaluationSamples: 20 }, {}, NOW);
  assert.equal(undersampled.status, 'NOT_AVAILABLE');
  assert.equal(undersampled.reason, 'FILL_MODEL_SAMPLE_INSUFFICIENT');

  const low = evaluateCalibratedFillModel({ ...goodFillModel(), fillProbability: 0.4 }, {}, NOW);
  assert.equal(low.status, 'VETO');
  assert.equal(low.reason, 'FILL_PROBABILITY_TOO_LOW');
});

test('realized TCA separates delay, execution, fees and total implementation shortfall', () => {
  const result = calculateRealizedTca({
    direction: 'BUY',
    decisionPrice: 100,
    arrivalPrice: 100.1,
    fillVwap: 100.2,
    feesBps: 2,
  }, { maxObservedImplementationShortfallBps: 100 });
  assert.equal(result.status, 'OBSERVED');
  assert.ok(result.delayCostBps > 0);
  assert.ok(result.executionCostBps > 0);
  assert.ok(result.implementationShortfallBps > result.executionCostBps);
  assert.equal(result.realizedOnly, true);
});

test('observe-only execution quality never deletes scanner candidate or grants order authority', () => {
  const result = evaluateExecutionQuality({
    now: NOW,
    bookWalk: {
      direction: 'BUY', targetQty: 1, arrivalPrice: 100, asks: [[100, 2]],
    },
    fillModel: {},
  });
  assert.equal(result.autoTrading.state, 'PASS');
  assert.equal(result.scanner.candidateDeletionAllowed, false);
  assert.equal(result.autoTrading.orderAllowed, false);
  assert.equal(result.safety.executionAuthority, 'NONE');
});

test('required execution-quality mode keeps missing calibrated fill evidence out of parent eligibility', () => {
  const result = evaluateExecutionQuality({
    now: NOW,
    bookWalk: {
      direction: 'BUY', targetQty: 1, arrivalPrice: 100, asks: [[100, 2]],
    },
    fillModel: {},
  }, { enforcement: 'REQUIRED_FOR_PARENT_GATE' });
  assert.equal(result.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.autoTrading.orderAllowed, false);
});

test('calibrated low fill probability can veto auto-trading eligibility without changing scanner visibility', () => {
  const result = evaluateExecutionQuality({
    now: NOW,
    bookWalk: {
      direction: 'BUY', targetQty: 1, arrivalPrice: 100, asks: [[100, 2]],
    },
    fillModel: { ...goodFillModel(), fillProbability: 0.3 },
  }, { enforcement: 'REQUIRED_FOR_PARENT_GATE' });
  assert.equal(result.autoTrading.state, 'VETO');
  assert.equal(result.scanner.candidateDeletionAllowed, false);
  assert.equal(result.autoTrading.orderAllowed, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildForwardCalibrationGrossEdgeEvidence,
} from './forward-calibration-gross-edge.service';
import type {
  ForwardObservationProfitCalibration,
} from './forward-recommendation-observer.service';

function readyCalibration(
  overrides: Partial<ForwardObservationProfitCalibration> = {},
): ForwardObservationProfitCalibration {
  const identity = Object.freeze({
    strategyId: 'CRYPTO_FUTURES_SWING_V1',
    strategyVersion: 'signal-profile-v1',
    parameterHash: 'params-v1',
    researchCodeSha: 'a'.repeat(40),
    market: 'CRYPTO_FUTURES' as const,
    symbol: 'BTCUSDT',
    timeframe: '60m',
    horizon: 24,
    direction: 'LONG' as const,
  });
  return Object.freeze({
    schemaVersion: 'forward-recommendation-profit-calibration-v2' as const,
    source: 'LIVE_RECOMMENDATION' as const,
    status: 'READY' as const,
    identity,
    calibration: Object.freeze({ status: 'READY' as const, sampleSize: 30, tpFirstCount: 18 }),
    probabilities: Object.freeze({ tp: 18 / 30, sl: 8 / 30, expire: 4 / 30 }),
    returns: Object.freeze({ target: 0.02, stop: -0.01, expire: 0.001 }),
    counts: Object.freeze({ tp: 18, sl: 8, expire: 4, conservativeConflicts: 0 }),
    costAdjusted: false as const,
    executionAuthority: 'NONE' as const,
    financialMutationAllowed: false as const,
    liveOrderAllowed: false as const,
    privateTradingApiAllowed: false as const,
    profitabilityClaimAllowed: false as const,
    ...overrides,
  });
}

test('converts READY empirical TP/SL/EXPIRE calibration into gross edge bps', () => {
  const result = buildForwardCalibrationGrossEdgeEvidence({
    calibration: readyCalibration(),
    asOf: '2026-08-26T08:00:00.000Z',
  });

  assert.equal(result.status, 'READY');
  assert.equal(result.sampleSize, 30);
  assert.equal(result.expectedGrossEdgeBps, 94.666667);
  assert.equal(result.netAlphaInput.expectedGrossEdgeBps, 94.666667);
  assert.equal(result.netAlphaInput.evidenceReady, true);
  assert.equal(result.netAlphaInput.market, 'CRYPTO_FUTURES');
  assert.equal(result.costAdjusted, false);
  assert.equal(result.conformalLowerEdgeBps, null);
  assert.equal(result.netAlphaInput.conformalLowerEdgeBps, null);
  assert.equal(result.netAlphaInput.costPolicyVersion, null);
  assert.equal(result.netAlphaInput.costs, null);
  assert.equal(result.netAlphaReady, false);
  assert.equal(result.profitabilityClaimAllowed, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.netAlphaInput), true);
});

test('fails closed when forward calibration is not READY', () => {
  const calibration = readyCalibration({
    status: 'INSUFFICIENT_SAMPLE',
    calibration: Object.freeze({ status: 'INSUFFICIENT_SAMPLE', sampleSize: 12, tpFirstCount: 7 }),
    probabilities: Object.freeze({ tp: null, sl: null, expire: null }),
    returns: Object.freeze({ target: null, stop: null, expire: null }),
    counts: Object.freeze({ tp: 7, sl: 3, expire: 2, conservativeConflicts: 0 }),
  });
  const result = buildForwardCalibrationGrossEdgeEvidence({
    calibration,
    asOf: '2026-08-26T08:00:00.000Z',
  });

  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.expectedGrossEdgeBps, null);
  assert.equal(result.netAlphaInput.evidenceReady, false);
  assert.ok(result.reasons.includes('FORWARD_CALIBRATION_NOT_READY'));
  assert.ok(result.reasons.includes('FORWARD_CALIBRATION_PROBABILITY_INCOMPLETE'));
});

test('rejects probability sums that do not represent one empirical outcome distribution', () => {
  const calibration = readyCalibration({
    probabilities: Object.freeze({ tp: 0.7, sl: 0.2, expire: 0.2 }),
  });
  const result = buildForwardCalibrationGrossEdgeEvidence({
    calibration,
    asOf: '2026-08-26T08:00:00.000Z',
  });

  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.expectedGrossEdgeBps, null);
  assert.ok(result.reasons.includes('FORWARD_CALIBRATION_PROBABILITY_SUM_INVALID'));
});

test('rejects count/sample mismatches instead of silently normalizing them', () => {
  const calibration = readyCalibration({
    counts: Object.freeze({ tp: 18, sl: 8, expire: 3, conservativeConflicts: 0 }),
  });
  const result = buildForwardCalibrationGrossEdgeEvidence({
    calibration,
    asOf: '2026-08-26T08:00:00.000Z',
  });

  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.expectedGrossEdgeBps, null);
  assert.ok(result.reasons.includes('FORWARD_CALIBRATION_COUNT_MISMATCH'));
});

test('does not fabricate timestamp, conservative lower edge, costs or net alpha readiness', () => {
  const result = buildForwardCalibrationGrossEdgeEvidence({
    calibration: readyCalibration(),
    asOf: 'not-a-time',
  });

  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.asOf, null);
  assert.equal(result.asOfMs, null);
  assert.equal(result.conformalLowerEdgeBps, null);
  assert.equal(result.netAlphaInput.costPolicyVersion, null);
  assert.equal(result.netAlphaInput.costs, null);
  assert.equal(result.netAlphaReady, false);
  assert.ok(result.reasons.includes('FORWARD_CALIBRATION_AS_OF_INVALID'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRegimeBrain } from '../src/regime-brain.mjs';

const NOW = Date.UTC(2026, 7, 22, 3, 20, 0);

function readyInput(overrides = {}) {
  return {
    now: NOW,
    asOf: NOW - 5_000,
    market: 'CRYPTO_FUTURES',
    trendScore: 0.72,
    realizedVol: 0.018,
    referenceVol: 0.015,
    spreadBps: 4,
    referenceSpreadBps: 5,
    topDepthNotional: 900_000,
    referenceTopDepthNotional: 1_000_000,
    referenceSamples: 500,
    drift: {
      evaluatedAt: NOW - 10_000,
      sampleSize: 600,
      featurePsi: { momentum: 0.04, volatility: 0.06, liquidity: 0.05 },
    },
    ...overrides,
  };
}

test('classifies a fresh stable trending market without granting order authority', () => {
  const result = evaluateRegimeBrain(readyInput());
  assert.equal(result.status, 'READY');
  assert.equal(result.regime.label, 'TREND_UP');
  assert.equal(result.drift.status, 'STABLE');
  assert.equal(result.autoTrading.state, 'PASS');
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.orderAllowed, false);
  assert.equal(result.safety.candidateDeletionAllowed, false);
});

test('low liquidity becomes an explicit veto instead of a synthetic weak score', () => {
  const result = evaluateRegimeBrain(readyInput({
    spreadBps: 14,
    referenceSpreadBps: 5,
    topDepthNotional: 200_000,
  }));
  assert.equal(result.regime.label, 'LOW_LIQUIDITY');
  assert.equal(result.autoTrading.state, 'VETO');
  assert.ok(result.autoTrading.reasons.includes('REGIME_LOW_LIQUIDITY'));
});

test('feature distribution drift brake vetoes even when the directional trend is strong', () => {
  const result = evaluateRegimeBrain(readyInput({
    drift: {
      evaluatedAt: NOW - 10_000,
      sampleSize: 600,
      featurePsi: { momentum: 0.31, volatility: 0.08, liquidity: 0.05 },
    },
  }));
  assert.equal(result.drift.status, 'BRAKE');
  assert.equal(result.autoTrading.state, 'VETO');
  assert.ok(result.autoTrading.reasons.includes('FEATURE_DISTRIBUTION_DRIFT_BRAKE'));
});

test('missing or stale regime evidence stays unavailable and is never coerced to zero', () => {
  const missing = evaluateRegimeBrain({ now: NOW, market: 'CRYPTO_SPOT' });
  assert.equal(missing.status, 'NOT_AVAILABLE');
  assert.equal(missing.regime, null);
  assert.equal(missing.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
  assert.ok(missing.reasons.includes('TREND_SCORE_NOT_AVAILABLE'));

  const stale = evaluateRegimeBrain(readyInput({ asOf: NOW - 120_000 }));
  assert.equal(stale.status, 'NOT_AVAILABLE');
  assert.ok(stale.reasons.includes('REGIME_EVIDENCE_STALE'));
});

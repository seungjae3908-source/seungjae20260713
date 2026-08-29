import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRegimeBrain } from '../src/regime-brain.mjs';

const NOW = Date.UTC(2026, 7, 22, 3, 20, 0);
const REFERENCE_DIGEST = 'a'.repeat(64);

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
      referenceId: 'TRAIN_REFERENCE_V1',
      referenceDigest: REFERENCE_DIGEST,
      referenceFrozen: true,
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
  assert.equal(result.drift.referenceId, 'TRAIN_REFERENCE_V1');
  assert.equal(result.drift.referenceDigest, REFERENCE_DIGEST);
  assert.equal(result.drift.referenceFrozen, true);
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
      referenceId: 'TRAIN_REFERENCE_V1',
      referenceDigest: REFERENCE_DIGEST,
      referenceFrozen: true,
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

  const future = evaluateRegimeBrain(readyInput({ asOf: NOW + 5_000 }));
  assert.equal(future.status, 'NOT_AVAILABLE');
  assert.ok(future.reasons.includes('REGIME_EVIDENCE_FROM_FUTURE'));
});

test('drift baseline must be immutable and explicitly provenance-bound', () => {
  const drift = { ...readyInput().drift };
  delete drift.referenceDigest;
  const result = evaluateRegimeBrain(readyInput({ drift }));
  assert.equal(result.status, 'READY');
  assert.equal(result.drift.status, 'NOT_AVAILABLE');
  assert.equal(result.drift.reason, 'DRIFT_REFERENCE_PROVENANCE_NOT_AVAILABLE');
  assert.equal(result.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
});

test('malformed PSI cannot be silently discarded while valid rows produce a stable verdict', () => {
  const result = evaluateRegimeBrain(readyInput({
    drift: {
      ...readyInput().drift,
      featurePsi: { momentum: 0.04, volatility: Number.NaN, liquidity: 0.05 },
    },
  }));
  assert.equal(result.drift.status, 'NOT_AVAILABLE');
  assert.equal(result.drift.reason, 'DRIFT_FEATURE_PSI_INVALID');
  assert.equal(result.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
});

test('invalid, insufficient, stale, and future drift evidence all fail closed', () => {
  const fractional = evaluateRegimeBrain(readyInput({
    drift: { ...readyInput().drift, sampleSize: 200.5 },
  }));
  assert.equal(fractional.drift.status, 'NOT_AVAILABLE');
  assert.equal(fractional.drift.reason, 'DRIFT_SAMPLE_INVALID');

  const insufficient = evaluateRegimeBrain(readyInput({
    drift: { ...readyInput().drift, sampleSize: 199 },
  }));
  assert.equal(insufficient.drift.status, 'NOT_AVAILABLE');
  assert.equal(insufficient.drift.reason, 'DRIFT_SAMPLE_INSUFFICIENT');

  const stale = evaluateRegimeBrain(readyInput({
    drift: { ...readyInput().drift, evaluatedAt: NOW - 120_000 },
  }));
  assert.equal(stale.drift.status, 'NOT_AVAILABLE');
  assert.equal(stale.drift.reason, 'DRIFT_EVIDENCE_STALE');

  const future = evaluateRegimeBrain(readyInput({
    drift: { ...readyInput().drift, evaluatedAt: NOW + 5_000 },
  }));
  assert.equal(future.drift.status, 'NOT_AVAILABLE');
  assert.equal(future.drift.reason, 'DRIFT_EVIDENCE_FROM_FUTURE');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRegimeBrain } from '../src/regime-brain.mjs';

const NOW = Date.UTC(2026, 7, 22, 3, 20, 0);
const REFERENCE_DIGEST = 'a'.repeat(64);

function drift(overrides = {}) {
  return {
    evaluatedAt: NOW - 10_000,
    sampleSize: 600,
    referenceId: 'TRAIN_REFERENCE_V1',
    referenceDigest: REFERENCE_DIGEST,
    referenceFrozen: true,
    referenceValidatedAt: NOW - 10_000,
    referenceSampleSize: 800,
    referenceComputable: true,
    zeroVarianceFeatures: [],
    featurePsi: { momentum: 0.04, volatility: 0.06, liquidity: 0.05 },
    ...overrides,
  };
}

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
    drift: drift(),
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
  assert.equal(result.safety.liveTrading, false);
  assert.equal(result.safety.aiNumericalAuthority, false);
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
    drift: drift({ featurePsi: { momentum: 0.31, volatility: 0.08, liquidity: 0.05 } }),
  }));
  assert.equal(result.drift.status, 'BRAKE');
  assert.equal(result.autoTrading.state, 'VETO');
  assert.ok(result.autoTrading.reasons.includes('FEATURE_DISTRIBUTION_DRIFT_BRAKE'));
});

test('missing stale and future regime evidence fail closed', () => {
  const missing = evaluateRegimeBrain({ now: NOW, market: 'CRYPTO_SPOT' });
  assert.equal(missing.status, 'NOT_AVAILABLE');
  assert.equal(missing.regime, null);
  assert.equal(missing.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
  assert.ok(missing.reasons.includes('TREND_SCORE_NOT_AVAILABLE'));

  const noClock = evaluateRegimeBrain({ ...readyInput(), now: undefined });
  assert.equal(noClock.status, 'NOT_AVAILABLE');
  assert.ok(noClock.reasons.includes('REGIME_CLOCK_NOT_AVAILABLE'));

  const stale = evaluateRegimeBrain(readyInput({ asOf: NOW - 120_000 }));
  assert.equal(stale.status, 'NOT_AVAILABLE');
  assert.ok(stale.reasons.includes('REGIME_EVIDENCE_STALE'));

  const future = evaluateRegimeBrain(readyInput({ asOf: NOW + 5_000 }));
  assert.equal(future.status, 'NOT_AVAILABLE');
  assert.ok(future.reasons.includes('REGIME_EVIDENCE_FROM_FUTURE'));
});

test('numeric strings are not accepted as authoritative regime or PSI numbers', () => {
  const regimeString = evaluateRegimeBrain(readyInput({ trendScore: '0.72' }));
  assert.equal(regimeString.status, 'NOT_AVAILABLE');
  assert.ok(regimeString.reasons.includes('TREND_SCORE_NOT_AVAILABLE'));

  const psiString = evaluateRegimeBrain(readyInput({
    drift: drift({ featurePsi: { momentum: '0.04', volatility: 0.06 } }),
  }));
  assert.equal(psiString.drift.status, 'NOT_AVAILABLE');
  assert.equal(psiString.drift.reason, 'DRIFT_FEATURE_PSI_INVALID');
});

test('drift baseline must be immutable and explicitly provenance-bound', () => {
  const incomplete = drift();
  delete incomplete.referenceDigest;
  const result = evaluateRegimeBrain(readyInput({ drift: incomplete }));
  assert.equal(result.status, 'READY');
  assert.equal(result.drift.status, 'NOT_AVAILABLE');
  assert.equal(result.drift.reason, 'DRIFT_REFERENCE_PROVENANCE_NOT_AVAILABLE');
  assert.equal(result.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
});

test('drift reference validation clock, reference sample and computability all fail closed', () => {
  const stale = evaluateRegimeBrain(readyInput({
    drift: drift({ referenceValidatedAt: NOW - 120_000 }),
  }));
  assert.equal(stale.drift.status, 'NOT_AVAILABLE');
  assert.equal(stale.drift.reason, 'DRIFT_REFERENCE_VALIDATION_EVIDENCE_STALE');

  const future = evaluateRegimeBrain(readyInput({
    drift: drift({ referenceValidatedAt: NOW + 5_000 }),
  }));
  assert.equal(future.drift.status, 'NOT_AVAILABLE');
  assert.equal(future.drift.reason, 'DRIFT_REFERENCE_VALIDATION_EVIDENCE_FROM_FUTURE');

  const smallReference = evaluateRegimeBrain(readyInput({
    drift: drift({ referenceSampleSize: 199 }),
  }));
  assert.equal(smallReference.drift.status, 'NOT_AVAILABLE');
  assert.equal(smallReference.drift.reason, 'DRIFT_REFERENCE_SAMPLE_INSUFFICIENT');

  const zeroVariance = evaluateRegimeBrain(readyInput({
    drift: drift({ zeroVarianceFeatures: ['momentum'] }),
  }));
  assert.equal(zeroVariance.drift.status, 'NOT_AVAILABLE');
  assert.equal(zeroVariance.drift.reason, 'DRIFT_REFERENCE_NOT_COMPUTABLE');

  const notComputable = evaluateRegimeBrain(readyInput({
    drift: drift({ referenceComputable: false }),
  }));
  assert.equal(notComputable.drift.status, 'NOT_AVAILABLE');
  assert.equal(notComputable.drift.reason, 'DRIFT_REFERENCE_NOT_COMPUTABLE');
});

test('invalid insufficient stale and future current drift evidence all fail closed', () => {
  const fractional = evaluateRegimeBrain(readyInput({ drift: drift({ sampleSize: 200.5 }) }));
  assert.equal(fractional.drift.status, 'NOT_AVAILABLE');
  assert.equal(fractional.drift.reason, 'DRIFT_SAMPLE_INVALID');

  const insufficient = evaluateRegimeBrain(readyInput({ drift: drift({ sampleSize: 199 }) }));
  assert.equal(insufficient.drift.status, 'NOT_AVAILABLE');
  assert.equal(insufficient.drift.reason, 'DRIFT_SAMPLE_INSUFFICIENT');

  const stale = evaluateRegimeBrain(readyInput({ drift: drift({ evaluatedAt: NOW - 120_000 }) }));
  assert.equal(stale.drift.status, 'NOT_AVAILABLE');
  assert.equal(stale.drift.reason, 'DRIFT_EVIDENCE_STALE');

  const future = evaluateRegimeBrain(readyInput({ drift: drift({ evaluatedAt: NOW + 5_000 }) }));
  assert.equal(future.drift.status, 'NOT_AVAILABLE');
  assert.equal(future.drift.reason, 'DRIFT_EVIDENCE_FROM_FUTURE');
});

test('request-supplied regime thresholds cannot loosen or reshape the canonical policy', () => {
  assert.throws(
    () => evaluateRegimeBrain(readyInput(), { maxEvidenceAgeMs: 120_000 }),
    /REGIME_POLICY_OVERRIDE_NOT_ALLOWED:maxEvidenceAgeMs/,
  );
  assert.throws(
    () => evaluateRegimeBrain(readyInput(), { trendThreshold: 0.2 }),
    /REGIME_POLICY_OVERRIDE_NOT_ALLOWED:trendThreshold/,
  );
  const required = evaluateRegimeBrain(readyInput(), { enforcement: 'REQUIRED_FOR_PARENT_GATE' });
  assert.equal(required.policy.enforcement, 'REQUIRED_FOR_PARENT_GATE');
  assert.equal(required.policy.trendThreshold, 0.60);
});

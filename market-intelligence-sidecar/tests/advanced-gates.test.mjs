import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAdvancedGates,
  evaluateConformalUncertainty,
  evaluateEventRiskGate,
  evaluateMetaLabelGate,
} from '../src/advanced-gates.mjs';

const NOW = Date.UTC(2026, 7, 17, 7, 30, 0);
const calibrationScores = Array.from({ length: 120 }, (_, index) => 2 + (index % 10) * 0.25);

function goodMeta() {
  return {
    modelId: 'meta-v1',
    takeProbability: 0.68,
    evaluationSamples: 800,
    brierScore: 0.18,
    calibrationError: 0.05,
    evaluatedAt: NOW - 60_000,
  };
}

test('split conformal gate passes only when calibrated lower edge stays positive and interval is bounded', () => {
  const result = evaluateConformalUncertainty({
    expectedDirectionalEdgeBps: 12,
    calibrationNonconformityBps: calibrationScores,
  });
  assert.equal(result.status, 'PASS');
  assert.ok(result.lowerBps > 0);
  assert.ok(result.widthBps <= 50);
  assert.equal(result.calibrationSamples, 120);
  assert.equal(result.assumption, 'SPLIT_CONFORMAL_EXCHANGEABILITY_REQUIRED');
});

test('split conformal gate vetoes a point estimate whose lower bound crosses non-positive edge', () => {
  const result = evaluateConformalUncertainty({
    expectedDirectionalEdgeBps: 2,
    calibrationNonconformityBps: calibrationScores,
  });
  assert.equal(result.status, 'VETO');
  assert.ok(result.reasons.includes('CONFORMAL_LOWER_BOUND_NON_POSITIVE'));
});

test('conformal gate never fabricates confidence from too few calibration samples', () => {
  const result = evaluateConformalUncertainty({
    expectedDirectionalEdgeBps: 20,
    calibrationNonconformityBps: [1, 2, 3],
  });
  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.reason, 'CONFORMAL_CALIBRATION_SAMPLE_INSUFFICIENT');
});

test('meta-label gate only acts as a calibrated take-or-skip veto', () => {
  const pass = evaluateMetaLabelGate(goodMeta(), {}, NOW);
  assert.equal(pass.status, 'PASS');
  assert.equal(pass.role, 'SECONDARY_TAKE_OR_SKIP_ONLY');

  const veto = evaluateMetaLabelGate({ ...goodMeta(), takeProbability: 0.41 }, {}, NOW);
  assert.equal(veto.status, 'VETO');
  assert.equal(veto.reason, 'META_LABEL_TAKE_PROBABILITY_TOO_LOW');
});

test('poorly calibrated meta model is unavailable rather than trusted as a veto', () => {
  const result = evaluateMetaLabelGate({ ...goodMeta(), brierScore: 0.41 }, {}, NOW);
  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.reason, 'META_MODEL_CALIBRATION_QUALITY_INSUFFICIENT');
});

test('verified high-impact event window blocks auto-trading eligibility', () => {
  const result = evaluateEventRiskGate({
    market: 'CRYPTO_FUTURES',
    events: [{
      id: 'macro-1',
      type: 'FOMC',
      severity: 'HIGH',
      verified: true,
      source: 'verified-calendar',
      markets: ['CRYPTO_FUTURES'],
      startsAt: NOW + 10 * 60_000,
      endsAt: NOW + 20 * 60_000,
    }],
  }, {}, NOW);
  assert.equal(result.status, 'VETO');
  assert.equal(result.reason, 'VERIFIED_HIGH_IMPACT_EVENT_WINDOW');
});

test('unverified event remains visible but does not hard block', () => {
  const result = evaluateEventRiskGate({
    market: 'US_STOCK',
    events: [{
      id: 'rumor-event',
      type: 'EARNINGS_RUMOR',
      severity: 'CRITICAL',
      verified: false,
      startsAt: NOW,
    }],
  }, {}, NOW);
  assert.equal(result.status, 'WATCH');
  assert.equal(result.blockingEvents.length, 0);
});

test('observe-only mode preserves scanner candidates and never grants an order', () => {
  const result = evaluateAdvancedGates({
    now: NOW,
    market: 'CRYPTO_SPOT',
    uncertainty: {},
    metaLabel: {},
    events: [],
  });
  assert.equal(result.autoTrading.state, 'PASS');
  assert.equal(result.scanner.candidateDeletionAllowed, false);
  assert.equal(result.autoTrading.orderAllowed, false);
  assert.equal(result.safety.executionAuthority, 'NONE');
});

test('required mode downgrades missing advanced evidence without deleting scanner candidate', () => {
  const result = evaluateAdvancedGates({
    now: NOW,
    market: 'CRYPTO_SPOT',
    uncertainty: {},
    metaLabel: {},
    events: [],
  }, { enforcement: 'REQUIRED_FOR_PARENT_GATE' });
  assert.equal(result.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.scanner.candidateDeletionAllowed, false);
  assert.ok(result.scanner.warnings.includes('ADVANCED_GATE_EVIDENCE_REQUIRED'));
});

test('a valid gate set can pass parent eligibility while still having zero execution authority', () => {
  const result = evaluateAdvancedGates({
    now: NOW,
    market: 'CRYPTO_FUTURES',
    uncertainty: {
      expectedDirectionalEdgeBps: 15,
      calibrationNonconformityBps: calibrationScores,
    },
    metaLabel: goodMeta(),
    events: [],
  }, { enforcement: 'REQUIRED_FOR_PARENT_GATE' });
  assert.equal(result.autoTrading.state, 'PASS');
  assert.equal(result.autoTrading.orderAllowed, false);
  assert.equal(result.autoTrading.executionAuthority, 'NONE');
});

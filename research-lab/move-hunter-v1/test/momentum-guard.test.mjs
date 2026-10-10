import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOMENTUM_GUARD_FORWARD_V1,
  evaluateMomentumGuardForwardV1,
} from '../src/momentum-guard.mjs';

function snapshot(momentum) {
  return {
    status: 'READY_FOR_SPECIALIST_RESEARCH_ONLY',
    decisionAuthority: 'EVIDENCE_ONLY',
    executionAuthority: 'NONE',
    decisionTime: 1_700_000_000_000,
    contentDigest: 'a'.repeat(64),
    features: { momentum },
  };
}

test('frozen momentum guard accepts positive ROC MACD and bounded RSI only', () => {
  const result = evaluateMomentumGuardForwardV1(snapshot({
    roc: 0.01,
    rsi: 60,
    macdHistogramPct: 0.002,
  }));
  assert.equal(result.eligible, true);
  assert.equal(result.automaticEntryAuthority, false);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.observedHistoryMayCountAsOos, false);
});

test('momentum guard rejects any one failed frozen component without threshold relaxation', () => {
  for (const momentum of [
    { roc: 0, rsi: 60, macdHistogramPct: 0.002 },
    { roc: 0.01, rsi: 82, macdHistogramPct: 0.002 },
    { roc: 0.01, rsi: 60, macdHistogramPct: 0 },
  ]) {
    const result = evaluateMomentumGuardForwardV1(snapshot(momentum));
    assert.equal(result.eligible, false);
  }
  assert.equal(MOMENTUM_GUARD_FORWARD_V1.parameterGrid, false);
  assert.equal(MOMENTUM_GUARD_FORWARD_V1.thresholdRelaxationAllowed, false);
  assert.equal(MOMENTUM_GUARD_FORWARD_V1.riskIncreaseAllowed, false);
});

test('missing canonical momentum data fails closed', () => {
  const result = evaluateMomentumGuardForwardV1({
    status: 'PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY',
    decisionAuthority: 'EVIDENCE_ONLY',
    executionAuthority: 'NONE',
    features: {},
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.eligible, false);
});

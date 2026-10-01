import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FUTURES_V2_PREREGISTRATION_V1,
  evaluateFuturesV2PreregisteredCandidate,
  summarizeFuturesV2PreregisteredDecisions,
} from '../src/futures-v2-preregistration.mjs';

const POST = '2026-09-28T08:00:00.000Z';

function router({
  regime = 'TREND_UP',
  directionalRegime = regime,
  volatilityRegime = 'NORMAL',
  latestSwingLegDirection = 'UP',
  structureTransition = 'NONE',
  priceActionStatus = 'AVAILABLE',
} = {}) {
  return {
    schemaVersion: 'adaptive-multi-evidence-regime-router-v2',
    lineageId: 'ADAPTIVE_MULTI_EVIDENCE_V2',
    status: 'READY_FOR_STRATEGY_ROUTING_RESEARCH_ONLY',
    regime,
    directionalRegime,
    volatilityRegime,
    routeAuthority: 'RESEARCH_FAMILY_ELIGIBILITY_ONLY',
    priceActionContext: {
      status: priceActionStatus,
      latestSwingLegDirection,
      structureTransition,
    },
    economicSampleCredit: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE',
  };
}

test('Futures V2 preregistration acknowledges post-hoc hypothesis generation and forbids same-window credit', () => {
  const p = FUTURES_V2_PREREGISTRATION_V1;
  assert.equal(p.market, 'CRYPTO_FUTURES');
  assert.equal(p.timeframe, '60M');
  assert.equal(p.diagnosis.postHocHypothesisGenerationAcknowledged, true);
  assert.equal(p.diagnosis.sameWindowCandidateSelectionForbidden, true);
  assert.equal(p.sourceDiagnosticWindow.mayCountAsOos, false);
  assert.equal(p.sourceDiagnosticWindow.mayCountAsForward, false);
  assert.equal(p.validation.historicalReplayMaySelectWinner, false);
  assert.equal(p.validation.automaticWinnerSelectionAllowed, false);
  assert.equal(p.validation.executionAuthority, 'NONE');
});

test('pre-preregistration decision is blocked from V2 evidence', () => {
  const row = evaluateFuturesV2PreregisteredCandidate({
    candidateId: 'FUTURES_V2_CONTROL',
    regimeRouter: router(),
    side: 'LONG',
    decisionTime: '2026-09-28T07:00:00.000Z',
  });
  assert.equal(row.status, 'BLOCKED_DATA');
  assert.equal(row.reasons[0], 'DECISION_NOT_POST_PREREGISTRATION');
  assert.equal(row.economicSampleCredit, 0);
});

test('risk-regime pause blocks HIGH_VOLATILITY and permits PANIC prospectively', () => {
  const blocked = evaluateFuturesV2PreregisteredCandidate({
    candidateId: 'FUTURES_V2_RISK_REGIME_PAUSE',
    regimeRouter: router({ regime: 'HIGH_VOLATILITY', volatilityRegime: 'HIGH_VOLATILITY' }),
    side: 'LONG',
    decisionTime: POST,
  });
  assert.equal(blocked.status, 'RESEARCH_EVIDENCE_ONLY');
  assert.equal(blocked.eligible, false);
  assert.ok(blocked.reasons.includes('PREREGISTERED_RISK_REGIME_PAUSE'));

  const allowed = evaluateFuturesV2PreregisteredCandidate({
    candidateId: 'FUTURES_V2_RISK_REGIME_PAUSE',
    regimeRouter: router({ regime: 'PANIC_DISLOCATION', volatilityRegime: 'PANIC_DISLOCATION' }),
    side: 'LONG',
    decisionTime: POST,
  });
  assert.equal(allowed.eligible, true);
});

test('trend-structure candidate requires side-regime and swing alignment', () => {
  const good = evaluateFuturesV2PreregisteredCandidate({
    candidateId: 'FUTURES_V2_TREND_STRUCTURE_CONFIRM',
    regimeRouter: router({
      regime: 'TREND_DOWN',
      directionalRegime: 'TREND_DOWN',
      latestSwingLegDirection: 'DOWN',
    }),
    side: 'SHORT',
    decisionTime: POST,
  });
  assert.equal(good.eligible, true);

  const badSide = evaluateFuturesV2PreregisteredCandidate({
    candidateId: 'FUTURES_V2_TREND_STRUCTURE_CONFIRM',
    regimeRouter: router({
      regime: 'TREND_UP',
      directionalRegime: 'TREND_UP',
      latestSwingLegDirection: 'UP',
    }),
    side: 'SHORT',
    decisionTime: POST,
  });
  assert.equal(badSide.eligible, false);
  assert.ok(badSide.reasons.includes('DIRECTIONAL_REGIME_NOT_ALIGNED'));
  assert.ok(badSide.reasons.includes('LATEST_SWING_NOT_ALIGNED'));

  const opposite = evaluateFuturesV2PreregisteredCandidate({
    candidateId: 'FUTURES_V2_TREND_STRUCTURE_CONFIRM',
    regimeRouter: router({
      regime: 'TREND_UP',
      latestSwingLegDirection: 'UP',
      structureTransition: 'CHOCH_DOWN',
    }),
    side: 'LONG',
    decisionTime: POST,
  });
  assert.equal(opposite.eligible, false);
  assert.ok(opposite.reasons.includes('OPPOSITE_STRUCTURE_TRANSITION'));
});

test('combined candidate applies both preregistered gates without execution authority', () => {
  const row = evaluateFuturesV2PreregisteredCandidate({
    candidateId: 'FUTURES_V2_COMBINED',
    regimeRouter: router({
      regime: 'HIGH_VOLATILITY',
      volatilityRegime: 'HIGH_VOLATILITY',
      latestSwingLegDirection: 'UP',
    }),
    side: 'LONG',
    decisionTime: POST,
  });
  assert.equal(row.eligible, false);
  assert.ok(row.reasons.includes('PREREGISTERED_RISK_REGIME_PAUSE'));
  assert.equal(row.historicalReplayMaySelectWinner, false);
  assert.equal(row.automaticWinnerSelectionAllowed, false);
  assert.equal(row.automaticScannerAdoptionAllowed, false);
  assert.equal(row.automaticPromotionAllowed, false);
  assert.equal(row.executionAuthority, 'NONE');
});

test('summary never chooses a performance winner', () => {
  const rows = [
    'FUTURES_V2_CONTROL',
    'FUTURES_V2_RISK_REGIME_PAUSE',
    'FUTURES_V2_TREND_STRUCTURE_CONFIRM',
    'FUTURES_V2_COMBINED',
  ].map((candidateId) => evaluateFuturesV2PreregisteredCandidate({
    candidateId,
    regimeRouter: router(),
    side: 'LONG',
    decisionTime: POST,
  }));
  const summary = summarizeFuturesV2PreregisteredDecisions(rows);
  assert.equal(summary.acceptedN, 4);
  assert.equal(summary.performanceWinner, null);
  assert.equal(summary.winnerSelectionAllowed, false);
  assert.equal(summary.automaticPromotionAllowed, false);
  assert.equal(summary.economicSampleCredit, 0);
  assert.equal(summary.executionAuthority, 'NONE');
});

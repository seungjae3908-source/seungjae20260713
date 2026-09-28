import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FUTURES_V2_COST_RISK_DECLARATION_V1,
  evaluateFuturesV2CostRiskGuard,
} from '../src/futures-v2-cost-risk-preregistration.mjs';

test('cost-risk declaration is bound to the exact earlier declaration commit', () => {
  const p = FUTURES_V2_COST_RISK_DECLARATION_V1;
  assert.equal(p.candidate.maximumCostToInitialRiskRatio, 0.25);
  assert.equal(p.candidate.thresholdSource, 'PREREGISTERED_ENGINEERING_RISK_BUDGET_NOT_SAME_WINDOW_OPTIMIZED');
  assert.equal(p.freezeBoundary.active, true);
  assert.equal(p.freezeBoundary.declarationCommitSha, '37b3ffacdaa2c8d8611917b79c66e923241cc5a6');
  assert.equal(p.freezeBoundary.preregisteredAt, '2026-09-28T07:37:20Z');
  assert.equal(p.validation.sameDiagnosticWindowMayValidateCandidate, false);
  assert.equal(p.validation.historicalReplayMaySelectWinner, false);
  assert.equal(p.validation.executionAuthority, 'NONE');
});

test('pre-declaration decisions are blocked from cost-risk evidence', () => {
  const row = evaluateFuturesV2CostRiskGuard({
    initialRiskPct: 0.015,
    roundTripCostRate: 0.0026,
    decisionTime: '2026-09-28T07:37:20Z',
  });
  assert.equal(row.status, 'BLOCKED_DATA');
  assert.equal(row.reason, 'DECISION_NOT_POST_COST_RISK_PREREGISTRATION');
  assert.equal(row.economicSampleCredit, 0);
});

test('post-declaration cost-risk guard uses only the frozen 25 percent risk-budget threshold', () => {
  const pass = evaluateFuturesV2CostRiskGuard({
    initialRiskPct: 0.012,
    roundTripCostRate: 0.0026,
    decisionTime: '2026-09-29T00:00:00.000Z',
  });
  assert.equal(pass.status, 'RESEARCH_EVIDENCE_ONLY');
  assert.equal(pass.eligible, true);
  assert.equal(pass.costToInitialRiskRatio < 0.25, true);

  const fail = evaluateFuturesV2CostRiskGuard({
    initialRiskPct: 0.008,
    roundTripCostRate: 0.0026,
    decisionTime: '2026-09-29T00:00:00.000Z',
  });
  assert.equal(fail.status, 'RESEARCH_EVIDENCE_ONLY');
  assert.equal(fail.eligible, false);
  assert.equal(fail.reason, 'COST_CONSUMES_TOO_MUCH_INITIAL_RISK');
  assert.equal(fail.automaticScannerAdoptionAllowed, false);
  assert.equal(fail.automaticPromotionAllowed, false);
  assert.equal(fail.executionAuthority, 'NONE');
});

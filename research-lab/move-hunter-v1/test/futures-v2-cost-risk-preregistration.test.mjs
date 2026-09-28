import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FUTURES_V2_COST_RISK_DECLARATION_V1,
  evaluateFuturesV2CostRiskGuard,
} from '../src/futures-v2-cost-risk-preregistration.mjs';

test('cost-risk declaration is intentionally inactive in the declaration commit', () => {
  const p = FUTURES_V2_COST_RISK_DECLARATION_V1;
  assert.equal(p.candidate.maximumCostToInitialRiskRatio, 0.25);
  assert.equal(p.candidate.thresholdSource, 'PREREGISTERED_ENGINEERING_RISK_BUDGET_NOT_SAME_WINDOW_OPTIMIZED');
  assert.equal(p.freezeBoundary.active, false);
  assert.equal(p.freezeBoundary.declarationCommitSha, null);
  assert.equal(p.freezeBoundary.preregisteredAt, null);
  assert.equal(p.validation.sameDiagnosticWindowMayValidateCandidate, false);
  assert.equal(p.validation.historicalReplayMaySelectWinner, false);
  assert.equal(p.validation.executionAuthority, 'NONE');
});

test('evaluation fails closed until the declaration commit is bound later', () => {
  const row = evaluateFuturesV2CostRiskGuard({
    initialRiskPct: 0.015,
    roundTripCostRate: 0.0026,
    decisionTime: '2026-09-28T08:00:00.000Z',
  });
  assert.equal(row.status, 'BLOCKED_DATA');
  assert.equal(row.reason, 'COST_RISK_DECLARATION_NOT_FROZEN');
  assert.equal(row.economicSampleCredit, 0);
  assert.equal(row.executionAuthority, 'NONE');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completedPromotionStages,
  type StrategyPromotionItem,
} from './strategy-promotion';

function fixture(): StrategyPromotionItem {
  const stage = (name: string, status: StrategyPromotionItem['stages'][number]['status']) => ({
    stage: name,
    status,
    startedAt: null,
    completedAt: null,
    observedAt: '2026-08-14T00:00:00.000Z',
    source: 'fixture',
    provider: null,
    sourceSha: null,
    sampleSize: null,
    sampleCount: null,
    tradeCount: null,
    metrics: null,
    gate: 'EVIDENCE_REQUIRED',
    gateResult: status,
    failureReason: status === 'PASS' ? null : 'EVIDENCE_REQUIRED',
    failureReasons: status === 'PASS' ? [] : ['EVIDENCE_REQUIRED'],
    provenance: [],
    costAssumptions: null,
    costPolicy: null,
    dataQuality: 'UNKNOWN',
    fetchedAt: null,
    validatedAt: null,
    corporateActionAdjusted: null,
    survivorshipSafe: null,
    pointInTimeSafe: null,
    requiredEvidence: [],
  });

  return {
    identity: {
      strategyFamily: 'FUTURES_SCALP',
      strategyId: 'CRYPTO_FUTURES_SCALP_V1_LONG',
      strategyVersion: 'V1',
      version: 'V1',
      parameterHash: 'a'.repeat(64),
      market: 'CRYPTO_FUTURES',
      assetClass: 'crypto_futures',
      symbol: null,
      universe: 'BITGET_USDT',
      timeframe: '15m',
      strategyHorizon: 'SCALP',
      horizon: 'SCALP',
      direction: 'LONG',
      researchCodeSha: 'b'.repeat(40),
      costPolicyVersion: 'COST_V1',
      riskPolicyVersion: 'RISK_V1',
    },
    promotionState: 'RESEARCH',
    stages: [stage('OOS', 'PASS'), stage('FINAL_HOLDOUT', 'BLOCKED')],
    drift: { classification: null, status: 'INSUFFICIENT_SAMPLE', reason: 'INSUFFICIENT_DATA', observedSampleSize: null },
    killState: 'NONE',
    blockers: ['FINAL_HOLDOUT_REQUIRED'],
    promotionEligible: false,
    executionAuthority: 'NONE',
    liveTradingAuthority: false,
    privateTradingApiCount: 0,
  };
}

test('Promotion Center counts only PASS stages and never treats BLOCKED evidence as completed', () => {
  const item = fixture();
  assert.equal(completedPromotionStages(item), 1);
  assert.equal(item.promotionEligible, false);
  assert.equal(item.executionAuthority, 'NONE');
  assert.equal(item.liveTradingAuthority, false);
  assert.equal(item.privateTradingApiCount, 0);
});

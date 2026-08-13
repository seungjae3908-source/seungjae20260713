import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COST_STRESS_MULTIPLIERS,
  StrategyPromotionService,
  strategyParameterHash,
  type PromotionStageKey,
} from './strategy-promotion.service';
import { getScannerStrategyProfile } from './scanner-strategy-profile.service';

const SHA = '1111111111111111111111111111111111111111';
const NOW = new Date('2026-08-13T00:00:00.000Z');
const STRATEGY = 'CRYPTO_FUTURES_SCALP_V1_LONG';

function pass(stage: PromotionStageKey) {
  return {
    stage,
    status: 'PASS' as const,
    source: 'verified-fixture',
    provider: 'CANONICAL_TEST_PROVIDER',
    sourceSha: SHA,
    datasetId: 'dataset-v1',
    dataRange: { start: '2025-01-01T00:00:00.000Z', end: '2026-01-01T00:00:00.000Z' },
    sampleCount: 50,
    metrics: { evidenceLinked: true },
    provenance: ['immutable-test-artifact'],
    dataQuality: 'VERIFIED' as const,
  };
}

test('canonical profile hash is deterministic and direction identity is immutable', () => {
  const profile = getScannerStrategyProfile('CRYPTO_FUTURES', 'SCALP');
  assert.equal(strategyParameterHash(profile), strategyParameterHash(profile));
  assert.match(strategyParameterHash(profile), /^[0-9a-f]{64}$/);
  const result = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW }).list({ market: 'CRYPTO_FUTURES' });
  assert.equal(result.items.length, 6);
  assert.equal(result.items[0]?.identity.researchCodeSha, SHA);
  assert.equal(result.items[0]?.identity.strategyVersion, profile.version);
  assert.equal(result.items[0]?.identity.strategyHorizon, 'SCALP');
  assert.equal(result.items[0]?.executionAuthority, 'NONE');
  assert.equal(result.privateTradingApiCount, 0);
});

test('PASS evidence without exact provenance is blocked instead of promoted', () => {
  const result = new StrategyPromotionService({
    sourceSha: SHA,
    now: () => NOW,
    evidence: { [STRATEGY]: [{ stage: 'HISTORICAL_BACKTEST', status: 'PASS', source: 'unlinked-fixture' }] },
  }).get(STRATEGY);
  const historical = result?.stages.find((stage) => stage.stage === 'HISTORICAL_BACKTEST');
  assert.equal(historical?.status, 'BLOCKED');
  assert.ok(historical?.failureReasons.includes('EXACT_SOURCE_SHA_REQUIRED'));
  assert.equal(result?.promotionEligible, false);
});

test('missing exact-linked evidence fails closed with no promotion candidate', () => {
  const result = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW }).list();
  assert.equal(result.items.length, 24);
  assert.equal(result.promotionCandidates, 0);
  assert.ok(result.items.every((item) => item.promotionEligible === false));
  assert.ok(result.items.every((item) => item.liveTradingAuthority === false));
  assert.equal(result.items.find((item) => item.identity.strategyId === STRATEGY)?.promotionState, 'RESEARCH');
});

test('promotion candidate requires every research, paper, shadow, outcome and cost scenario gate', () => {
  const evidence = {
    [STRATEGY]: [
      pass('HISTORICAL_BACKTEST'), pass('OUT_OF_SAMPLE'), pass('PURGED_WALK_FORWARD'),
      { ...pass('COST_STRESS'), metrics: Object.fromEntries(COST_STRESS_MULTIPLIERS.map((value) => [`cost_${value}x`, true])) },
      pass('REGIME'), pass('FINAL_HOLDOUT'), pass('PAPER'), pass('SHADOW'),
      { ...pass('RECOMMENDATION_OUTCOMES'), sampleSize: 50, metrics: { hitRate: 0.55, expectedValue: 0.3 } },
    ],
  } as const;
  const result = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW, evidence }).get(STRATEGY);
  assert.equal(result?.promotionState, 'PROMOTION_CANDIDATE');
  assert.equal(result?.promotionEligible, true);
  assert.equal(result?.drift.status, 'INSUFFICIENT_SAMPLE');
});

test('critical drift suspends recommendation without granting live authority', () => {
  const evidence = {
    [STRATEGY]: [
      { ...pass('HISTORICAL_BACKTEST'), sampleSize: 100, metrics: { hitRate: 0.7, expectedValue: 1.5 } },
      { ...pass('RECOMMENDATION_OUTCOMES'), sampleSize: 40, metrics: { hitRate: 0.4, expectedValue: 0.1 } },
    ],
  } as const;
  const result = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW, evidence }).get(STRATEGY);
  assert.equal(result?.drift.classification, 'CRITICAL');
  assert.equal(result?.promotionState, 'SUSPENDED');
  assert.equal(result?.liveTradingAuthority, false);
});

test('versioned filters and kill state remain fail closed', () => {
  const service = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW, killStates: { [STRATEGY]: 'KILLED' } });
  const killed = service.list({ market: 'CRYPTO_FUTURES', strategyHorizon: 'SCALP', direction: 'LONG', status: 'KILLED' });
  assert.equal(killed.policyVersion, 'STRATEGY_PROMOTION_POLICY_V1');
  assert.equal(killed.items.length, 1);
  assert.equal(killed.items[0]?.promotionState, 'KILLED');
  assert.equal(killed.items[0]?.executionAuthority, 'NONE');
});

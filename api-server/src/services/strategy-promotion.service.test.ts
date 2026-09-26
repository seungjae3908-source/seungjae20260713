import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COST_STRESS_MULTIPLIERS,
  StrategyPromotionService,
  strategyCandidateId,
  strategyParameterHash,
  type PromotionStageKey,
} from './strategy-promotion.service';
import { getScannerStrategyProfile } from './scanner-strategy-profile.service';
import { buildResearchPromotionBridge } from './strategy-promotion-research-bridge.service';

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
    startedAt: '2026-01-02T00:00:00.000Z',
    completedAt: '2026-01-03T00:00:00.000Z',
    fetchedAt: '2026-01-02T00:00:00.000Z',
    validatedAt: '2026-01-03T00:00:00.000Z',
    sampleCount: 50,
    metrics: { evidenceLinked: true },
    provenance: ['immutable-test-artifact'],
    corporateActionAdjusted: true,
    survivorshipSafe: true,
    pointInTimeSafe: true,
    costPolicy: { version: 'BACKTEST_FEES_SLIPPAGE_FUNDING_V1' },
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

test('Paper candidate id is deterministic and changes with immutable parameters', () => {
  const source = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW })
    .list({ market: 'CRYPTO_FUTURES', strategyHorizon: 'SCALP', direction: 'LONG' }).items[0];
  assert.ok(source);
  const candidateId = strategyCandidateId(source.identity);
  assert.equal(candidateId, strategyCandidateId({ ...source.identity }));
  assert.match(candidateId, /^paper-candidate-v1:[0-9a-f]{64}$/u);
  assert.notEqual(candidateId, strategyCandidateId({ ...source.identity, parameterHash: 'f'.repeat(64) }));
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
      { ...pass('RECOMMENDATION_OUTCOMES'), sampleSize: 50, metrics: {
        hitRate: 0.55, expectedValue: 0.3, driftClassification: 'HEALTHY',
        driftPolicyVersion: 'SIGNAL_PERFORMANCE_CALIBRATION_V1', riskGatePassed: true,
        dataQualityGatePassed: true, costStressMaintained: true,
      } },
    ],
  } as const;
  const result = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW, evidence }).get(STRATEGY);
  assert.equal(result?.promotionState, 'PROMOTION_CANDIDATE');
  assert.equal(result?.promotionEligible, true);
  assert.equal(result?.drift.status, 'MEASURED');
});

test('critical drift suspends recommendation without granting live authority', () => {
  const evidence = {
    [STRATEGY]: [
      { ...pass('HISTORICAL_BACKTEST'), sampleSize: 100, metrics: { hitRate: 0.7, expectedValue: 1.5 } },
      { ...pass('RECOMMENDATION_OUTCOMES'), sampleSize: 40, metrics: {
        hitRate: 0.4, expectedValue: 0.1, driftClassification: 'CRITICAL',
        driftPolicyVersion: 'SIGNAL_PERFORMANCE_CALIBRATION_V1',
      } },
    ],
  } as const;
  const result = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW, evidence }).get(STRATEGY);
  assert.equal(result?.drift.classification, 'CRITICAL');
  assert.equal(result?.promotionState, 'SUSPENDED');
  assert.equal(result?.liveTradingAuthority, false);
});

test('numeric performance gaps without a versioned upstream drift policy do not invent a classification', () => {
  const evidence = {
    [STRATEGY]: [
      { ...pass('HISTORICAL_BACKTEST'), sampleSize: 100, metrics: { hitRate: 0.7, expectedValue: 1.5 } },
      { ...pass('RECOMMENDATION_OUTCOMES'), sampleSize: 40, metrics: {
        hitRate: 0.4, expectedValue: 0.1, riskGatePassed: true,
        dataQualityGatePassed: true, costStressMaintained: true,
      } },
    ],
  } as const;
  const result = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW, evidence }).get(STRATEGY);
  assert.equal(result?.drift.classification, null);
  assert.equal(result?.drift.status, 'INSUFFICIENT_SAMPLE');
  assert.equal(result?.promotionEligible, false);
});

test('versioned filters and kill state remain fail closed', () => {
  const service = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW, killStates: { [STRATEGY]: 'KILLED' } });
  const killed = service.list({ market: 'CRYPTO_FUTURES', strategyHorizon: 'SCALP', direction: 'LONG', status: 'KILLED' });
  assert.equal(killed.policyVersion, 'STRATEGY_PROMOTION_POLICY_V1');
  assert.equal(killed.items.length, 1);
  assert.equal(killed.items[0]?.promotionState, 'KILLED');
  assert.equal(killed.items[0]?.executionAuthority, 'NONE');
});

function researchOverview(candidatePerformance: Record<string, unknown> | null, safetyOverrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'research-dashboard-overview-v1',
    safety: {
      readOnlyDashboard: true,
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
      forbiddenAuthorityObserved: false,
      ...safetyOverrides,
    },
    paper: { candidatePerformance },
  };
}

function trainingCandidateFrom(record: NonNullable<ReturnType<StrategyPromotionService['get']>>) {
  return {
    present: true,
    status: 'PRESENT',
    schemaVersion: 'frozen-candidate-performance-reader-v1',
    identity14Verified: true,
    promotionIdentity: {
      candidateId: strategyCandidateId(record.identity),
      strategyId: record.identity.strategyId,
      strategyVersion: record.identity.strategyVersion,
      parameterHash: record.identity.parameterHash,
      researchCodeSha: record.identity.researchCodeSha,
      market: record.identity.market,
      timeframe: record.identity.timeframe,
      sidePolicy: record.identity.direction,
      accountMode: 'PAPER',
      costPolicyVersion: record.identity.costPolicyVersion,
      executionPolicyVersion: 'PAPER_EXECUTION_POLICY_V1',
    },
    TRAIN_N: 12,
    VALIDATION_N: 0,
    OOS_N: 0,
    Settlement_N: 0,
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    TRAIN_DIAGNOSTIC_ONLY: true,
    VALIDATION_COMPLETE: false,
    OOS_COMPLETE: false,
    Net_PnL: null,
    executionAuthority: 'NONE',
  };
}

test('Research promotion bridge maps exact Scanner identity but keeps TRAIN-only evidence research-only', () => {
  const promotion = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW })
    .get(STRATEGY);
  assert.ok(promotion);
  const bridge = buildResearchPromotionBridge(
    researchOverview(trainingCandidateFrom(promotion!)),
    SHA,
    NOW.toISOString(),
  );

  assert.equal(bridge.status, 'RESEARCH_ONLY');
  assert.equal(bridge.candidate?.strategyId, STRATEGY);
  assert.equal(bridge.scannerProfile?.strategyId, STRATEGY);
  assert.equal(bridge.evidence.trainN, 12);
  assert.equal(bridge.evidence.validationN, 0);
  assert.equal(bridge.evidence.oosN, 0);
  assert.ok(bridge.blockers.includes('TRAIN_DIAGNOSTIC_ONLY'));
  assert.ok(bridge.blockers.includes('VALIDATION_NOT_COMPLETE'));
  assert.ok(bridge.blockers.includes('OOS_NOT_COMPLETE'));
  assert.ok(bridge.blockers.includes('FULL_COST_NOT_READY'));
  assert.equal(bridge.automaticAdoptionAllowed, false);
  assert.equal(bridge.paperHandoffAllowed, false);
  assert.equal(bridge.scannerMutationAllowed, false);
  assert.equal(bridge.executionAuthority, 'NONE');
});

test('Research promotion bridge shows Validation collection without turning it into OOS or Paper credit', () => {
  const promotion = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW }).get(STRATEGY);
  assert.ok(promotion);
  const candidate = {
    ...trainingCandidateFrom(promotion!),
    TRAIN_N: 512,
    VALIDATION_N: 8,
    OOS_N: 0,
  };
  const bridge = buildResearchPromotionBridge(researchOverview(candidate), SHA, NOW.toISOString());
  assert.equal(bridge.status, 'VALIDATION_COLLECTING');
  assert.equal(bridge.evidence.validationN, 8);
  assert.equal(bridge.evidence.oosN, 0);
  assert.equal(bridge.evidence.validationComplete, false);
  assert.equal(bridge.evidence.oosComplete, false);
  assert.equal(bridge.paperHandoffAllowed, false);
});

test('Research promotion bridge refuses a candidate whose immutable identity is not a Scanner profile', () => {
  const promotion = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW }).get(STRATEGY);
  assert.ok(promotion);
  const candidate = trainingCandidateFrom(promotion!);
  candidate.promotionIdentity = {
    ...candidate.promotionIdentity,
    strategyId: 'research-only-strategy-alpha',
    parameterHash: 'f'.repeat(64),
  };
  const bridge = buildResearchPromotionBridge(researchOverview(candidate), SHA, NOW.toISOString());
  assert.equal(bridge.status, 'UNMAPPED');
  assert.equal(bridge.scannerProfile, null);
  assert.ok(bridge.blockers.includes('SCANNER_PROFILE_IDENTITY_UNMAPPED'));
  assert.equal(bridge.automaticAdoptionAllowed, false);
});

test('Research promotion bridge fails closed on stale research SHA or unsafe dashboard authority', () => {
  const promotion = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW }).get(STRATEGY);
  assert.ok(promotion);
  const candidate = trainingCandidateFrom(promotion!);

  const stale = buildResearchPromotionBridge(
    researchOverview(candidate),
    '2'.repeat(40),
    NOW.toISOString(),
  );
  assert.equal(stale.status, 'UNMAPPED');
  assert.ok(stale.blockers.includes('RESEARCH_CODE_SHA_NOT_CURRENT'));
  assert.equal(stale.automaticAdoptionAllowed, false);

  const unsafe = buildResearchPromotionBridge(
    researchOverview(candidate, { orderAuthority: true }),
    SHA,
    NOW.toISOString(),
  );
  assert.equal(unsafe.status, 'INVALID');
  assert.ok(unsafe.blockers.includes('RESEARCH_DASHBOARD_SAFETY_INVALID'));
  assert.equal(unsafe.orderAllowed, false);
});

test('Research promotion bridge keeps missing candidate explicit and rejects authority escalation in candidate evidence', () => {
  const missing = buildResearchPromotionBridge(
    researchOverview(null),
    SHA,
    NOW.toISOString(),
  );
  assert.equal(missing.status, 'NO_CANDIDATE');
  assert.equal(missing.candidate, null);

  const promotion = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW }).get(STRATEGY);
  assert.ok(promotion);
  const escalated = {
    ...trainingCandidateFrom(promotion!),
    FULL_COST_READY: true,
    PROFITABILITY_PROVEN: true,
  };
  const invalid = buildResearchPromotionBridge(
    researchOverview(escalated),
    SHA,
    NOW.toISOString(),
  );
  assert.equal(invalid.status, 'INVALID');
  assert.equal(invalid.automaticAdoptionAllowed, false);
  assert.equal(invalid.paperHandoffAllowed, false);
});


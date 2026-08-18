import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COST_STRESS_MULTIPLIERS,
  StrategyPromotionService,
  type PromotionStageKey,
} from './strategy-promotion.service';
import { attestLiveTradingProfitability } from './trade-profitability-attestation.service';
import { evaluateTradingOptimization } from './trade-automation-optimization.service';
import { DEFAULT_TRADING_POLICY, type TradingPlanInput } from './trade-automation.types';
import { normalizeTradingPolicy } from './trade-automation-risk.service';

const SHA = '1111111111111111111111111111111111111111';
const NOW = new Date('2026-08-18T04:00:00.000Z');
const STRATEGY = 'CRYPTO_FUTURES_SCALP_V1_LONG';

function plan(overrides: Partial<TradingPlanInput> = {}): TradingPlanInput {
  const observedAt = NOW.toISOString();
  return {
    exchange: 'bitget', accountMode: 'live', strategyId: STRATEGY, signalId: 'attested-signal',
    symbol: 'BTCUSDT', market: 'USDT-FUTURES', side: 'long', orderType: 'market', quantity: 0.01,
    quoteAmount: null, limitPrice: null, estimatedKrw: 50_000, stopPrice: 95_000,
    targetPrices: [110_000], splitRatios: [100], leverage: 2, marginMode: 'isolated', reduceOnly: false,
    invalidateAction: 'hold', signalReasons: ['server-evidence'], entryPrice: 100_000,
    estimatedSlippagePercent: 0.05, averageSpreadPercent: 0.05,
    economics: {
      sampleSize: 9999, winProbability: 0.99, averageWinR: 99, averageLossR: 0.01,
      estimatedCostsR: 0, profitFactor: 99, maxDrawdownPercent: 0.01,
      marketRegime: 'bull', calibratedAt: observedAt,
    },
    marketSnapshot: {
      observedAt, riskObservedAt: observedAt, dataDelayMs: 0, oneMinuteMovePercent: 0.1,
      spreadPercent: 0.05, orderbookGapPercent: 0.05, halted: false, availableBalance: 1_000_000,
      accountValueKrw: 5_000_000, dailyPnlPercent: 0, assetExposurePercent: 0,
      openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0, currentPrice: 100_000,
      plannedPrice: 100_000, marketStatus: 'OPEN', availableLiquidityKrw: 5_000_000,
      estimatedSlippagePercent: 0.05, estimatedFeePercent: 0.05, correlatedExposurePercent: 0,
      signalState: 'entry_ready', signalObservedAt: observedAt,
    },
    ...overrides,
  };
}

function pass(stage: PromotionStageKey) {
  return {
    stage,
    status: 'PASS' as const,
    source: 'verified-server-fixture',
    provider: 'CANONICAL_TEST_PROVIDER',
    sourceSha: SHA,
    datasetId: 'immutable-dataset-v1',
    dataRange: { start: '2025-01-01T00:00:00.000Z', end: '2026-08-18T03:59:00.000Z' },
    startedAt: '2026-08-18T03:50:00.000Z',
    completedAt: '2026-08-18T03:59:00.000Z',
    fetchedAt: '2026-08-18T03:59:00.000Z',
    validatedAt: '2026-08-18T03:59:00.000Z',
    sampleCount: 60,
    metrics: { evidenceLinked: true },
    provenance: ['immutable-server-artifact'],
    corporateActionAdjusted: true,
    survivorshipSafe: true,
    pointInTimeSafe: true,
    costPolicy: { version: 'BACKTEST_FEES_SLIPPAGE_FUNDING_V1' },
    dataQuality: 'VERIFIED' as const,
  };
}

function promotedService() {
  const evidence = {
    [STRATEGY]: [
      pass('HISTORICAL_BACKTEST'), pass('OUT_OF_SAMPLE'), pass('PURGED_WALK_FORWARD'),
      { ...pass('COST_STRESS'), metrics: Object.fromEntries(COST_STRESS_MULTIPLIERS.map((value) => [`cost_${value}x`, true])) },
      { ...pass('REGIME'), metrics: { marketRegime: 'bull' } },
      pass('FINAL_HOLDOUT'),
      { ...pass('PAPER'), metrics: {
        hitRate: 0.58, averageWinR: 1.4, averageLossR: 0.9, estimatedCostsR: 0.08,
        profitFactor: 1.45, maxDrawdownPercent: 8, marketRegime: 'bull',
      } },
      pass('SHADOW'),
      { ...pass('RECOMMENDATION_OUTCOMES'), sampleSize: 60, metrics: {
        hitRate: 0.58, expectedValue: 0.35, averageWinR: 1.4, averageLossR: 0.9,
        estimatedCostsR: 0.08, profitFactor: 1.45, maxDrawdownPercent: 8, marketRegime: 'bull',
        driftClassification: 'HEALTHY', driftPolicyVersion: 'SIGNAL_PERFORMANCE_CALIBRATION_V1',
        riskGatePassed: true, dataQualityGatePassed: true, costStressMaintained: true,
      } },
    ],
  } as const;
  return new StrategyPromotionService({ sourceSha: SHA, now: () => NOW, evidence });
}

test('live plan ignores client economics unless same-identity server promotion evidence exists', () => {
  const blocked = attestLiveTradingProfitability(plan(), new StrategyPromotionService({ sourceSha: SHA, now: () => NOW }));
  assert.equal(blocked.required, true);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.clientEconomicsTrusted, false);
  assert.ok(blocked.blockCodes.includes('SERVER_STRATEGY_NOT_PROMOTION_READY'));
  assert.equal(blocked.serverEconomics, null);
});

test('promotion candidate projects trusted live economics from server evidence instead of request values', () => {
  const result = attestLiveTradingProfitability(plan(), promotedService(), { now: NOW.getTime() });
  assert.equal(result.allowed, true);
  assert.equal(result.clientEconomicsTrusted, false);
  assert.equal(result.promotionState, 'PROMOTION_CANDIDATE');
  assert.equal(result.researchCodeSha, SHA);
  assert.match(result.parameterHash ?? '', /^[0-9a-f]{64}$/);
  assert.equal(result.serverEconomics?.sampleSize, 60);
  assert.equal(result.serverEconomics?.winProbability, 0.58);
  assert.equal(result.serverEconomics?.averageWinR, 1.4);
  assert.equal(result.serverEconomics?.profitFactor, 1.45);
  assert.notEqual(result.serverEconomics?.profitFactor, plan().economics?.profitFactor);
  assert.equal(result.orderAuthorityGranted, false);
});

test('stale server promotion economics expire locally and block live attestation', () => {
  const result = attestLiveTradingProfitability(plan(), promotedService(), {
    now: NOW.getTime() + 25 * 60 * 60_000,
    maxEvidenceAgeHours: 24,
  });
  assert.equal(result.required, true);
  assert.equal(result.allowed, false);
  assert.ok(result.blockCodes.includes('PROFITABILITY_EVIDENCE_STALE'));
  assert.equal(result.serverEconomics, null);
  assert.equal(result.orderAuthorityGranted, false);
});

test('server promotion identity mismatch blocks live attestation', () => {
  const direction = attestLiveTradingProfitability(plan({ side: 'short' }), promotedService(), { now: NOW.getTime() });
  assert.equal(direction.allowed, false);
  assert.ok(direction.blockCodes.includes('SERVER_STRATEGY_DIRECTION_MISMATCH'));

  const market = attestLiveTradingProfitability(
    plan({ exchange: 'upbit', market: 'KRW', symbol: 'BTC', side: 'buy' }),
    promotedService(),
    { now: NOW.getTime() },
  );
  assert.equal(market.allowed, false);
  assert.ok(market.blockCodes.includes('SERVER_STRATEGY_MARKET_MISMATCH'));
});

test('paper plans do not require live profitability attestation', () => {
  const result = attestLiveTradingProfitability(
    plan({ accountMode: 'paper' }),
    new StrategyPromotionService({ sourceSha: SHA, now: () => NOW }),
    { now: NOW.getTime() + 25 * 60 * 60_000, maxEvidenceAgeHours: 24 },
  );
  assert.equal(result.required, false);
  assert.equal(result.allowed, true);
  assert.equal(result.serverEconomics, null);
  assert.equal(result.orderAuthorityGranted, false);
});

test('live optimization fails closed on fabricated client economics when server evidence is absent', () => {
  const policy = normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, pilotStage: 'validated' });
  const result = evaluateTradingOptimization(plan(), policy, NOW.getTime());
  assert.equal(result.allowed, false);
  assert.ok(result.blockCodes.includes('SERVER_PROFITABILITY_ATTESTATION_REQUIRED'));
  assert.ok(result.blockCodes.includes('ECONOMICS_REQUIRED'));
  assert.equal(result.expectedValueR, null);
});

test('automatic economics treats zero profit factor and missing drawdown as missing evidence', () => {
  const automatic = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY, mode: 'automatic', automaticEnabled: true, pilotStage: 'validated',
  });
  const input = plan({
    accountMode: 'paper',
    economics: {
      sampleSize: 100, winProbability: 0.6, averageWinR: 1.2, averageLossR: 0.8,
      estimatedCostsR: 0.05, profitFactor: 0, maxDrawdownPercent: null,
      marketRegime: 'bull', calibratedAt: NOW.toISOString(),
    },
  });
  const result = evaluateTradingOptimization(input, automatic, NOW.getTime());
  assert.ok(result.blockCodes.includes('PROFIT_FACTOR_REQUIRED'));
  assert.ok(result.blockCodes.includes('STRATEGY_DRAWDOWN_REQUIRED'));
});

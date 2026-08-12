import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdvisorContextError,
  analyzePortfolio,
  buildPortfolioAdvisorContext,
  buildPortfolioAdvisorEnvelope,
  buildPortfolioScenario,
  proposePortfolio,
  sanitizeAdvisorContext,
} from './index.ts';
import type { PortfolioAnalyticsInput, PortfolioProposalInput } from './types.ts';

const basePosition = {
  assetId: 'US:AAPL',
  market: 'US' as const,
  symbol: 'AAPL',
  positionSide: 'LONG' as const,
  quantity: 10,
  averageCost: 100,
  currentPrice: 120,
  currency: 'USD',
  sector: 'Technology',
};

function metricValue(metric: { status: string; value?: number }): number {
  assert.equal(metric.status, 'available');
  assert.equal(typeof metric.value, 'number');
  return metric.value as number;
}

test('empty portfolio keeps deterministic values and marks market risk evidence insufficient', () => {
  const result = analyzePortfolio({ positions: [], cash: 1_000_000, baseCurrency: 'KRW' });
  assert.equal(metricValue(result.totalValue), 1_000_000);
  assert.equal(metricValue(result.cashValue), 1_000_000);
  assert.equal(metricValue(result.cashWeight), 100);
  assert.equal(result.volatilityPercent.status, 'insufficient');
  assert.equal(result.correlation.status, 'insufficient');
});

test('single position computes value, pnl and concentration without inventing volatility', () => {
  const result = analyzePortfolio({ positions: [basePosition], cash: 0, baseCurrency: 'USD' });
  assert.equal(metricValue(result.totalValue), 1200);
  assert.equal(metricValue(result.unrealizedPnl), 200);
  assert.ok(Math.abs(metricValue(result.returnPercent) - 20) < 1e-9);
  assert.equal(metricValue(result.concentration), 1);
  assert.equal(result.volatilityPercent.status, 'insufficient');
});

test('missing cash is explicit and never fabricated as zero', () => {
  const result = analyzePortfolio({ positions: [basePosition], cash: null, baseCurrency: 'USD' });
  assert.equal(result.cashValue.status, 'insufficient');
  assert.equal(result.totalValue.status, 'insufficient');
  assert.equal(result.cashWeight.status, 'insufficient');
  assert.ok(result.missing.includes('cash'));
  assert.equal(result.knownValue, 1200);
  assert.equal(metricValue(result.concentration), 1);
});

test('short positions use inverse price direction for unrealized pnl and return', () => {
  const result = analyzePortfolio({
    positions: [{ ...basePosition, positionSide: 'SHORT', averageCost: 120, currentPrice: 100 }],
    cash: 0,
    baseCurrency: 'USD',
  });
  assert.equal(metricValue(result.unrealizedPnl), 200);
  assert.ok(Math.abs(metricValue(result.returnPercent) - (200 / 1200) * 100) < 1e-9);
});

test('multiple positions compute risk only from supplied volatility and correlation evidence', () => {
  const input: PortfolioAnalyticsInput = {
    positions: [
      basePosition,
      { ...basePosition, assetId: 'US:MSFT', symbol: 'MSFT', quantity: 5, currentPrice: 200, averageCost: 180 },
    ],
    cash: 800,
    baseCurrency: 'USD',
    riskEvidence: {
      annualizedVolatilityByAssetId: { 'US:AAPL': 0.2, 'US:MSFT': 0.3 },
      correlations: [{ leftAssetId: 'US:AAPL', rightAssetId: 'US:MSFT', correlation: 0.5 }],
    },
    riskScorePolicy: {
      bands: [
        { maxVolatilityPercent: 10, score: 20 },
        { maxVolatilityPercent: 20, score: 50 },
        { maxVolatilityPercent: 100, score: 80 },
      ],
    },
  };
  const result = analyzePortfolio(input);
  assert.equal(result.volatilityPercent.status, 'available');
  assert.equal(metricValue(result.correlation), 0.5);
  assert.equal(result.portfolioRiskScore.status, 'available');
  assert.ok(result.positions.every((position) => position.riskContributionPercent.status === 'available'));
});

test('concentrated and balanced portfolios produce different HHI concentration', () => {
  const concentrated = analyzePortfolio({ positions: [basePosition], cash: 0, baseCurrency: 'USD' });
  const balanced = analyzePortfolio({
    positions: [basePosition, { ...basePosition, assetId: 'US:MSFT', symbol: 'MSFT' }],
    cash: 0,
    baseCurrency: 'USD',
  });
  assert.ok(metricValue(concentrated.concentration) > metricValue(balanced.concentration));
});

test('zero cash and high cash are represented explicitly', () => {
  const zeroCash = analyzePortfolio({ positions: [basePosition], cash: 0, baseCurrency: 'USD' });
  const highCash = analyzePortfolio({ positions: [basePosition], cash: 4800, baseCurrency: 'USD' });
  assert.equal(metricValue(zeroCash.cashWeight), 0);
  assert.equal(metricValue(highCash.cashWeight), 80);
});

test('missing price propagates insufficiency instead of a fabricated total or weight', () => {
  const result = analyzePortfolio({ positions: [{ ...basePosition, currentPrice: null }], cash: 100, baseCurrency: 'USD' });
  assert.equal(result.totalValue.status, 'insufficient');
  assert.equal(metricValue(result.cashValue), 100);
  assert.equal(result.positions[0].weight.status, 'insufficient');
  assert.ok(result.missing.includes('US:AAPL:price'));
});

test('missing sector marks sector exposure insufficient while other deterministic metrics remain available', () => {
  const result = analyzePortfolio({ positions: [{ ...basePosition, sector: null }], cash: 0, baseCurrency: 'USD' });
  assert.equal(result.sectorExposure.status, 'insufficient');
  assert.equal(result.marketExposure.status, 'available');
});

test('missing volatility or correlation never creates fake risk evidence', () => {
  const result = analyzePortfolio({
    positions: [basePosition, { ...basePosition, assetId: 'US:MSFT', symbol: 'MSFT' }],
    cash: 0,
    baseCurrency: 'USD',
    riskEvidence: { annualizedVolatilityByAssetId: { 'US:AAPL': 0.2 } },
  });
  assert.equal(result.volatilityPercent.status, 'insufficient');
  assert.equal(result.correlation.status, 'insufficient');
  assert.equal(result.portfolioRiskScore.status, 'insufficient');
});

function proposalInput(): PortfolioProposalInput {
  return {
    investmentBudget: 2_000_000,
    investmentHorizon: 'medium',
    riskProfile: 'balanced',
    markets: ['US'],
    requiredSymbols: ['AAPL'],
    excludedSymbols: ['TSLA'],
    allocationPolicy: {
      maxPositions: 3,
      maxPositionWeight: 0.35,
      minCashWeight: 0.2,
      requireVerifiedBacktest: true,
      requireScannerEvidence: true,
      requireKnownCorrelation: false,
    },
    candidates: [
      {
        assetId: 'US:AAPL', market: 'US', symbol: 'AAPL', price: 200, currency: 'USD', role: 'core',
        dataQuality: 'pass', liquidity: 'pass', scannerEvidence: 'verified', backtestEvidence: 'verified', risk: 'pass', correlation: 'unknown',
      },
      {
        assetId: 'US:MSFT', market: 'US', symbol: 'MSFT', price: 400, currency: 'USD', role: 'core',
        dataQuality: 'pass', liquidity: 'pass', scannerEvidence: 'partial', backtestEvidence: 'verified', risk: 'pass', correlation: 'unknown',
      },
      {
        assetId: 'US:TSLA', market: 'US', symbol: 'TSLA', price: 250, currency: 'USD', role: 'satellite',
        dataQuality: 'pass', liquidity: 'pass', scannerEvidence: 'verified', backtestEvidence: 'verified', risk: 'pass', correlation: 'unknown',
      },
    ],
  };
}

test('required and excluded symbols are enforced and allocation is deterministic', () => {
  const result = proposePortfolio(proposalInput());
  assert.equal(result.status, 'READY');
  assert.ok(result.allocations.some((row) => row.symbol === 'AAPL'));
  assert.ok(!result.allocations.some((row) => row.symbol === 'TSLA'));
  const totalWeight = result.allocations.reduce((sum, row) => sum + row.weight, 0);
  assert.ok(Math.abs(totalWeight - 1) < 1e-9);
  assert.equal(result.allocations.find((row) => row.symbol === 'CASH')?.role, 'cash');
});

test('proposal refuses to fabricate weights when allocation policy is missing', () => {
  const input = proposalInput();
  delete input.allocationPolicy;
  const result = proposePortfolio(input);
  assert.equal(result.status, 'INSUFFICIENT_POLICY');
  assert.deepEqual(result.allocations, []);
});

test('insufficient backtest evidence rejects a required symbol', () => {
  const input = proposalInput();
  input.candidates[0] = { ...input.candidates[0], backtestEvidence: 'insufficient' };
  const result = proposePortfolio(input);
  assert.equal(result.status, 'INSUFFICIENT_CANDIDATES');
  assert.deepEqual(result.requiredMissing, ['AAPL']);
});

test('scenario engine emits no return numbers when evidence is insufficient', () => {
  const result = buildPortfolioScenario({
    strategyVersion: 'v1', sampleSize: 20, oosPassed: false, walkForwardPassed: null,
    maxDrawdownPercent: null, expectancy: null, profitFactor: null, confidence: null, costStressPassed: false,
    validatedScenarioReturnsPercent: { bear: -10, base: 10, bull: 30 },
  }, {
    minSampleSize: 100, requireOos: true, requireWalkForward: true, requireCostStress: true,
  });
  assert.equal(result.returnScenarioStatus, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.scenarios.bear.returnPercent, null);
  assert.equal(result.scenarios.base.returnPercent, null);
  assert.equal(result.scenarios.bull.returnPercent, null);
});

test('scenario engine passes through validated numbers only after evidence gate', () => {
  const result = buildPortfolioScenario({
    strategyVersion: 'v2', sampleSize: 1000, oosPassed: true, walkForwardPassed: true,
    maxDrawdownPercent: 12, expectancy: 0.2, profitFactor: 1.4, confidence: 0.8, costStressPassed: true,
    validatedScenarioReturnsPercent: { bear: -8, base: 7, bull: 18 },
  }, {
    minSampleSize: 500, requireOos: true, requireWalkForward: true, requireCostStress: true,
    minProfitFactor: 1.1, minConfidence: 0.7,
  });
  assert.equal(result.returnScenarioStatus, 'VALIDATED_SCENARIOS_AVAILABLE');
  assert.equal(result.scenarios.base.returnPercent, 7);
});

test('scenario engine fails closed when validated bear/base/bull ordering is inverted', () => {
  const result = buildPortfolioScenario({
    strategyVersion: 'v2', sampleSize: 1000, oosPassed: true, walkForwardPassed: true,
    maxDrawdownPercent: 12, expectancy: 0.2, profitFactor: 1.4, confidence: 0.8, costStressPassed: true,
    validatedScenarioReturnsPercent: { bear: 20, base: 0, bull: -20 },
  }, {
    minSampleSize: 500, requireOos: true, requireWalkForward: true, requireCostStress: true,
    minProfitFactor: 1.1, minConfidence: 0.7,
  });
  assert.equal(result.returnScenarioStatus, 'EVIDENCE_SUFFICIENT_NO_RETURN_ESTIMATE');
  assert.deepEqual(result.missingOrFailed, ['VALIDATED_SCENARIO_ORDER_INVALID']);
  assert.equal(result.scenarios.bear.returnPercent, null);
  assert.equal(result.scenarios.base.returnPercent, null);
  assert.equal(result.scenarios.bull.returnPercent, null);
});

test('advisor context rejects private fields and client identity recursively', () => {
  for (const value of [
    { portfolio: { apiKey: 'abcdefghijk12345' } },
    { nested: { userId: '11111111-1111-1111-1111-111111111111' } },
    { telegram: { telegramChatId: '123456789' } },
  ]) {
    assert.throws(
      () => sanitizeAdvisorContext(value),
      (error: unknown) => error instanceof AdvisorContextError && error.code === 'ADVISOR_PRIVATE_DATA_FORBIDDEN',
    );
  }
});

test('advisor works with partial or stale facts without gaining execution authority', () => {
  const analytics = analyzePortfolio({ positions: [{ ...basePosition, currentPrice: null }], cash: null, baseCurrency: 'USD' });
  const context = buildPortfolioAdvisorContext(analytics, [{ ...basePosition, currentPrice: null }], {
    marketContext: { freshness: 'stale' },
    missing: ['scannerEvidence'],
  });
  const envelope = buildPortfolioAdvisorEnvelope(context, false);
  assert.equal(envelope.context.cash.status, 'insufficient');
  assert.equal(envelope.deterministicAnalysisAvailable, true);
  assert.equal(envelope.aiExplanationAvailable, false);
  assert.equal(envelope.orderAuthority, 'none');
  assert.ok(envelope.context.missing.includes('scannerEvidence'));
});
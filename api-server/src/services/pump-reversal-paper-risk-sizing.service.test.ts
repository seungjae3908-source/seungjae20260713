import assert from 'node:assert/strict';
import test from 'node:test';

import { sizePumpReversalPaperRisk } from './pump-reversal-paper-risk-sizing.service';

const NOW = 1_800_000_000_000;

function record() {
  return {
    status: 'OPEN',
    observation: {
      candidateId: 'paper-candidate-v1:' + 'a'.repeat(64),
      candidateDigest: 'b'.repeat(64),
      policyDigest: 'c'.repeat(64),
      symbol: 'ALTUSDT',
    },
    signal: {
      strategyId: 'CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1',
      market: 'CRYPTO_FUTURES',
      direction: 'SHORT',
      symbol: 'ALTUSDT',
      signalId: 'd'.repeat(64),
      parameterHash: 'e'.repeat(64),
    },
    position: {
      positionId: 'f'.repeat(64),
      entryTimestampMs: NOW - 1_000,
      entryPrice: 100,
      stopPrice: 125,
      timeExitAtMs: NOW + 72 * 60 * 60 * 1000,
      actualExchangeFillClaim: false,
    },
  } as const;
}

function account() {
  return {
    equity: 10_000,
    dailyRealizedPnl: 0,
    weeklyRealizedPnl: 0,
    consecutiveLosses: 0,
    openExposure: 0,
    sameDirectionExposure: 0,
    observedAtMs: NOW - 100,
  };
}

function rules() {
  return {
    symbol: 'ALTUSDT',
    quantityStep: 0.001,
    quantityPrecision: 3,
    minimumQuantity: 0.001,
    minimumNotional: 5,
    maximumLeverage: 20,
    maintenanceMarginRate: 0.005,
    status: 'live',
    updatedAt: new Date(NOW - 100).toISOString(),
  } as const;
}

function publicEvidence() {
  return {
    provider: 'bitget',
    productType: 'USDT-FUTURES',
    symbol: 'ALTUSDT',
    lastPrice: 100,
    bidPrice: 99.9,
    askPrice: 100.1,
    markPrice: 100,
    indexPrice: 100,
    tickerTimestampMs: NOW - 100,
    fundingRate: 0.0001,
    fundingIntervalHours: 8,
    nextFundingUpdateMs: NOW + 60_000,
    openInterest: 1_000_000,
    openInterestTimestampMs: NOW - 100,
    minTradeNum: 0.001,
    sizeMultiplier: 0.001,
    minTradeUsdt: 5,
    priceStep: 0.001,
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0006,
    minLeverage: 1,
    maxLeverage: 20,
    candles5m: [],
    candles1h: [],
    benchmarkBtc1h: [],
    benchmarkBtc1d: [],
    observedAtMs: NOW,
    dataQuality: 'ready',
  } as const;
}

function supplemental() {
  const component = (valuePercent: number, source: string) => ({
    valuePercent,
    quality: 'ESTIMATED' as const,
    source,
    observedAtMs: NOW - 100,
  });
  return {
    costPolicyId: 'pump-cost-v1',
    observedAtMs: NOW - 100,
    latency: component(0.01, 'latency'),
    liquidityImpact: component(0.02, 'liquidity'),
    partialFillImpact: component(0.01, 'partial-fill'),
  };
}

function depth() {
  return {
    bids: [[99.9, 100], [99.8, 100]] as const,
    asks: [[100.1, 100], [100.2, 100]] as const,
    observedAtMs: NOW - 100,
    provenance: ['public-L2'] as const,
  };
}

test('Pump sizing uses 0.25% risk, 2x leverage, and never exceeds 1% nominal probe', () => {
  const result = sizePumpReversalPaperRisk({
    record: record(),
    account: account(),
    contractRules: rules(),
    publicEvidence: publicEvidence(),
    depth: depth(),
    supplementalCostEvidence: supplemental(),
    nowMs: NOW,
  });

  assert.equal(result.status, 'READY');
  assert.equal(result.riskPercent, 0.25);
  assert.equal(result.leverage, 2);
  assert.equal(result.marginMode, 'isolated');
  assert.equal(result.maximumProbeNotional, 100);
  assert.ok((result.finalNotional ?? Infinity) <= 100);
  assert.ok((result.riskResult?.actualRiskPercent ?? Infinity) <= 0.25);
  assert.equal(result.fundingDirectionalFilterUsed, false);
  assert.equal(result.fundingCountsAsProfitabilityEvidence, false);
  assert.equal(result.profitabilityClaimAllowed, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('Funding is conservatively accumulated over the 72h risk horizon, not used as direction alpha', () => {
  const result = sizePumpReversalPaperRisk({
    record: record(),
    account: account(),
    contractRules: rules(),
    publicEvidence: publicEvidence(),
    depth: depth(),
    supplementalCostEvidence: supplemental(),
    nowMs: NOW,
  });
  assert.equal(result.conservativeFundingRiskRate, 0.0009);
  assert.equal(result.riskInput?.estimatedFundingRate, 0.0009);
  assert.equal(result.fundingDirectionalFilterUsed, false);
});

test('stale account evidence blocks sizing instead of reusing an old balance', () => {
  const result = sizePumpReversalPaperRisk({
    record: record(),
    account: { ...account(), observedAtMs: NOW - 31_000 },
    contractRules: rules(),
    publicEvidence: publicEvidence(),
    depth: depth(),
    supplementalCostEvidence: supplemental(),
    nowMs: NOW,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.includes('PUMP_PAPER_ACCOUNT_EVIDENCE_STALE'));
  assert.equal(result.finalQuantity, null);
});

test('price drift above 2% from the exact next-bar reference blocks sizing', () => {
  const result = sizePumpReversalPaperRisk({
    record: record(),
    account: account(),
    contractRules: rules(),
    publicEvidence: { ...publicEvidence(), lastPrice: 103 },
    depth: depth(),
    supplementalCostEvidence: supplemental(),
    nowMs: NOW,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.includes('PUMP_ENTRY_REFERENCE_PRICE_DRIFT'));
});

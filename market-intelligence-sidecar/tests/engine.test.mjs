import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMarketIntelligence } from '../src/engine.mjs';

const now = 1_800_000_000_000;

function baseBook() {
  return {
    ts: now,
    bids: [[100, 12], [99.9, 8], [99.8, 6]],
    asks: [[100.1, 8], [100.2, 7], [100.3, 6]],
  };
}

test('aggressive buying without price progress is bearish absorption, not bullish accumulation', () => {
  const result = evaluateMarketIntelligence({
    now,
    asOf: now,
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    orderBook: baseBook(),
    trades: [
      { side: 'buy', price: 100.00, size: 20, ts: now - 4_000 },
      { side: 'buy', price: 100.01, size: 20, ts: now - 3_000 },
      { side: 'buy', price: 100.02, size: 20, ts: now - 2_000 },
      { side: 'sell', price: 100.01, size: 2, ts: now - 1_000 },
    ],
    derivatives: { openInterest: 1100, previousOpenInterest: 1000, fundingRate: 0.0008, longShortRatio: 1.8 },
  });
  assert.ok(result.microstructure.cvdNormalized > 0.8);
  assert.ok(result.microstructure.bearishAbsorptionScore > 50);
  assert.equal(result.microstructure.bullishAbsorptionScore, 0);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.autoTrading.orderAllowed, false);
});

test('large bid wall withdrawal without matching fills is identified as bearish liquidity withdrawal', () => {
  const previous = {
    ts: now - 1_000,
    bids: [[100, 100], [99.9, 5], [99.8, 5], [99.7, 5]],
    asks: [[100.1, 5], [100.2, 5], [100.3, 5]],
  };
  const current = {
    ts: now,
    bids: [[100, 5], [99.9, 5], [99.8, 5]],
    asks: [[100.1, 5], [100.2, 5], [100.3, 5]],
  };
  const result = evaluateMarketIntelligence({
    now,
    market: 'CRYPTO_SPOT',
    symbol: 'KRW-BTC',
    orderBook: current,
    previous: { orderBook: previous },
    trades: [{ side: 'sell', price: 99.95, size: 1, ts: now - 200 }],
  });
  assert.equal(result.microstructure.liquidityWithdrawal.side, 'bid');
  assert.ok(result.microstructure.liquidityWithdrawal.score > 70);
  assert.ok(result.scanner.adjustment < 0);
});

test('extreme microcap dilution risk hard-blocks auto trading while preserving scanner evidence', () => {
  const result = evaluateMarketIntelligence({
    now,
    market: 'US_STOCK',
    symbol: 'ABCD',
    orderBook: baseBook(),
    trades: [{ side: 'buy', price: 100, size: 10, ts: now - 100 }],
    microcap: {
      cash: 1_000_000,
      quarterlyCashBurn: 2_000_000,
      marketCap: 20_000_000,
      shelfCapacity: 50_000_000,
      atmActive: true,
      sharesOutstanding: 50_000_000,
      previousSharesOutstanding: 30_000_000,
      warrantShares: 20_000_000,
      reverseSplitCount12m: 2,
      convertibleRiskScore: 80,
      shortInterestPctFloat: 35,
      daysToCover: 4,
    },
  });
  assert.ok(result.structural.dilutionRisk >= 95);
  assert.equal(result.scanner.hardBlockReason, 'EXTREME_DILUTION_RISK');
  assert.equal(result.autoTrading.mode, 'BLOCKED_RISK');
  assert.equal(result.autoTrading.orderAllowed, false);
});

test('missing optional intelligence remains visible instead of deleting scanner candidates', () => {
  const result = evaluateMarketIntelligence({
    now,
    asOf: now,
    market: 'KR_STOCK',
    symbol: '005930',
  });
  assert.equal(result.scanner.mode, 'SOFT_INTELLIGENCE_LAYER');
  assert.equal(result.scanner.hardBlockReason, null);
  assert.ok(result.warnings.includes('ORDER_BOOK_NOT_AVAILABLE'));
  assert.ok(result.warnings.includes('TRADE_FLOW_NOT_AVAILABLE'));
});

test('auto-trading remains paper-only until forward evidence meets explicit policy', () => {
  const insufficient = evaluateMarketIntelligence({
    now,
    market: 'CRYPTO_FUTURES',
    symbol: 'ETHUSDT',
    orderBook: baseBook(),
    validation: { forwardSamples: 100, profitFactor: 1.5, expectedNetEdgeBps: 8, maxDrawdownPct: 10, regimeCount: 3 },
  });
  assert.equal(insufficient.autoTrading.mode, 'PAPER_ONLY');

  const sufficient = evaluateMarketIntelligence({
    now,
    market: 'CRYPTO_FUTURES',
    symbol: 'ETHUSDT',
    orderBook: baseBook(),
    validation: { forwardSamples: 400, profitFactor: 1.5, expectedNetEdgeBps: 8, maxDrawdownPct: 10, regimeCount: 3 },
  });
  assert.equal(sufficient.autoTrading.mode, 'ELIGIBLE_FOR_PARENT_GATE');
  assert.equal(sufficient.autoTrading.orderAllowed, false);
  assert.equal(sufficient.autoTrading.parentGateRequired, true);
});

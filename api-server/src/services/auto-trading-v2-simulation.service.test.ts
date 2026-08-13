import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateAutoTradingV2Liquidation,
  replayAutoTradingV2HistoricalSnapshots,
} from './auto-trading-v2-simulation.service';
import type { AutoTradingV2MarketSnapshot } from './auto-trading-v2.service';

function snapshot(overrides: Partial<AutoTradingV2MarketSnapshot> = {}): AutoTradingV2MarketSnapshot {
  return {
    symbol: 'BTCUSDT',
    observedAt: '2026-08-13T02:00:00.000Z',
    source: 'BINANCE_USDT_M_PUBLIC',
    publicOnly: true,
    closedCandleOnly: true,
    markPrice: 100,
    indexPrice: 100,
    bidPrice: 99.99,
    askPrice: 100.01,
    spreadPercent: 0.02,
    markIndexDislocationPercent: 0,
    fundingRate: 0.0001,
    nextFundingTime: null,
    btc1dClose: 110,
    btc1dMa20: 100,
    btc1hClose: 105,
    btc1hMa20: 100,
    symbol1hClose: 105,
    symbol1hMa20: 100,
    symbol5mClose: 101,
    symbol5mMa20: 100,
    atr14: 1,
    atrPercent: 1,
    oneMinuteMovePercent: 0.1,
    expansionRvolPercent: 450,
    volumeContraction: true,
    pullbackDistancePercent: 0.2,
    continuationLong: true,
    continuationShort: false,
    lastClosedCandleTime: 1_786_575_000_000,
    dataStale: false,
    ...overrides,
  };
}

test('isolated liquidation estimate is explicitly simulation-only and stop remains before liquidation', () => {
  const estimate = estimateAutoTradingV2Liquidation({
    direction: 'LONG', entryPrice: 100, stopPrice: 98, leverage: 5,
  });
  assert.equal(estimate.model, 'SIMULATION_ONLY_NOT_EXCHANGE_EXACT');
  assert.equal(estimate.marginMode, 'ISOLATED');
  assert.equal(estimate.leverage, 5);
  assert.ok(estimate.liquidationDistancePercent > 15);
  assert.equal(estimate.stopBeforeLiquidation, true);
  assert.ok(estimate.estimatedLiquidationPrice < 98);
});

test('short liquidation estimate is direction aware and leverage capped at 5x', () => {
  const estimate = estimateAutoTradingV2Liquidation({
    direction: 'SHORT', entryPrice: 100, stopPrice: 102, leverage: 20,
  });
  assert.equal(estimate.leverage, 5);
  assert.ok(estimate.estimatedLiquidationPrice > 102);
  assert.equal(estimate.stopBeforeLiquidation, true);
});

test('historical replay uses closed-candle deterministic engine and dedupes same lifecycle signal', () => {
  const base = snapshot();
  const result = replayAutoTradingV2HistoricalSnapshots([base, { ...base }], {
    mode: 'SHADOW', equityKrw: 1_000_000, riskPerTradePercent: 0.25, leverage: 3,
  });
  assert.equal(result.closedCandleOnly, true);
  assert.equal(result.evaluatedSnapshots, 2);
  assert.equal(result.executableSignals, 1);
  assert.equal(result.duplicateSignalsSkipped, 1);
  assert.equal(result.longSignals, 1);
  assert.equal(result.shortSignals, 0);
  assert.equal(result.signals[0].realOrderCount, 0);
  assert.equal(result.signals[0].realCancelCount, 0);
  assert.equal(result.signals[0].privateTradingApiCount, 0);
  assert.equal(result.signals[0].liquidation.model, 'SIMULATION_ONLY_NOT_EXCHANGE_EXACT');
});

test('historical replay records blocked snapshots without manufacturing executions', () => {
  const result = replayAutoTradingV2HistoricalSnapshots([
    snapshot({ symbol: 'SOLUSDT', symbol1hClose: 95, symbol1hMa20: 100 }),
  ], { mode: 'PAPER', equityKrw: 1_000_000 });
  assert.equal(result.evaluatedSnapshots, 1);
  assert.equal(result.executableSignals, 0);
  assert.equal(result.blockedSignals, 1);
  assert.deepEqual(result.signals, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateFuturesDirectionalFormula,
  evaluateFuturesDirectionalPair,
  type FuturesDirectionalCandle,
} from './crypto-futures-directional-formula.service';

const FIXED_NOW = Date.UTC(2026, 7, 27, 0, 0, 0);

function trendCandles(direction: 'up' | 'down', count = 40): FuturesDirectionalCandle[] {
  const step = 60_000;
  return Array.from({ length: count }, (_, index) => {
    const close = direction === 'up' ? 100 + index * 0.5 : 120 - index;
    return {
      time: FIXED_NOW - (count - index) * step,
      open: direction === 'up' ? close - 0.2 : close + 0.4,
      high: close + 1,
      low: close - 1,
      close,
      volume: index === count - 1 ? 300_000 : 100_000,
      quoteVolume: 10_000_000,
    };
  });
}

test('futures LONG and SHORT formulas are evaluated independently, not as inverse scores', () => {
  const input = {
    timeframe: '15m',
    condition: 'trend' as const,
    price: 120,
    changePercent: 4,
    tradingValue: 20_000_000_000,
    fundingRate: 0.0001,
    openInterest: 5_000_000,
    bid: 119.9,
    ask: 120.1,
    tickerTimestamp: FIXED_NOW,
    candles: trendCandles('up'),
    now: FIXED_NOW,
  };
  const long = evaluateFuturesDirectionalFormula({ ...input, direction: 'LONG' });
  const short = evaluateFuturesDirectionalFormula({ ...input, direction: 'SHORT' });

  assert.equal(long.direction, 'LONG');
  assert.equal(short.direction, 'SHORT');
  assert.equal(long.conditionMatched, true);
  assert.equal(short.conditionMatched, false);
  assert.ok(long.score > short.score);
  assert.notEqual(long.score + short.score, 100);
  assert.ok(long.scoreBreakdown.trend > 0);
  assert.equal(short.scoreBreakdown.trend, 0);
});

test('futures SHORT formula can become independently eligible on bearish evidence', () => {
  const result = evaluateFuturesDirectionalFormula({
    direction: 'SHORT',
    timeframe: '15m',
    condition: 'trend',
    price: 80,
    changePercent: -4,
    tradingValue: 20_000_000_000,
    fundingRate: 0.0008,
    openInterest: 5_000_000,
    bid: 79.9,
    ask: 80.1,
    tickerTimestamp: FIXED_NOW,
    candles: trendCandles('down'),
    now: FIXED_NOW,
  });

  assert.equal(result.direction, 'SHORT');
  assert.equal(result.conditionMatched, true);
  assert.ok(result.score >= 75);
  assert.ok(result.confidence >= 70);
  assert.ok(result.pricePlan.stopLoss != null && result.pricePlan.stopLoss > 80);
  assert.ok(result.pricePlan.targets.every((target) => target < 80));
});

test('futures directional pair exposes LONG/SHORT separately and returns explicit NO_TRADE or direction decision', () => {
  const bullish = evaluateFuturesDirectionalPair({
    timeframe: '15m',
    condition: 'trend',
    price: 120,
    changePercent: 4,
    tradingValue: 20_000_000_000,
    fundingRate: 0.0001,
    openInterest: 5_000_000,
    bid: 119.9,
    ask: 120.1,
    tickerTimestamp: FIXED_NOW,
    candles: trendCandles('up'),
    now: FIXED_NOW,
  });
  assert.equal(bullish.long.direction, 'LONG');
  assert.equal(bullish.short.direction, 'SHORT');
  assert.equal(bullish.decision, bullish.long.strongSignalEligible ? 'LONG' : 'NO_TRADE');

  const staleTime = FIXED_NOW - 24 * 60 * 60_000;
  const stale = evaluateFuturesDirectionalPair({
    timeframe: '15m',
    condition: 'trend',
    price: 120,
    changePercent: 0,
    tradingValue: 20_000_000_000,
    fundingRate: null,
    openInterest: null,
    bid: null,
    ask: null,
    tickerTimestamp: staleTime,
    candles: trendCandles('up').map((row) => ({ ...row, time: row.time - 24 * 60 * 60_000 })),
    now: FIXED_NOW,
  });
  assert.equal(stale.decision, 'NO_TRADE');
  assert.equal(stale.long.strongSignalEligible, false);
  assert.equal(stale.short.strongSignalEligible, false);
});

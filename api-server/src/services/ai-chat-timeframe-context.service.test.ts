import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAiChatTimeframeEvidence } from './ai-chat-timeframe-context.service';
import type { NormalizedCandle } from './futures-market-data.service';

function candles(count: number, options: { lastOpen?: boolean } = {}): NormalizedCandle[] {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.5;
    return {
      timestamp: start + index * 60_000,
      open: close - 0.2,
      high: close + 0.4,
      low: close - 0.5,
      close,
      volume: 1000 + index,
      quoteVolume: null,
      timeframe: '1m',
      symbol: 'BTCUSDT',
      market: 'crypto-futures',
      source: 'fixture',
      isClosed: !(options.lastOpen && index === count - 1),
      isDelayed: false,
      updatedAt: new Date(start + index * 60_000).toISOString(),
    };
  });
}

test('AI timeframe evidence uses only closed candles and canonical indicators', () => {
  const evidence = buildAiChatTimeframeEvidence({
    market: 'BITGET',
    symbol: 'BTCUSDT',
    timeframe: '1m',
    provider: 'fixture-public',
    asOf: '2026-01-01T01:00:00.000Z',
    candles: candles(61, { lastOpen: true }),
  });

  assert.equal(evidence.status, 'complete');
  assert.equal(evidence.candleCount, 60);
  assert.equal(evidence.closedCandlesOnly, true);
  assert.equal(evidence.publicMarketDataOnly, true);
  assert.equal(evidence.orderCapability, false);
  assert.equal(evidence.lastClosedCandle?.close, 129.5);
  assert.ok(evidence.indicators.ema20 != null);
  assert.ok(evidence.indicators.ema50 != null);
  assert.ok(evidence.indicators.rsi14 != null);
  assert.ok(evidence.indicators.atr14 != null);
  assert.ok(evidence.warnings.some((value) => value.includes('미완성 캔들 1개')));
});

test('AI timeframe evidence stays partial instead of fabricating missing long-window indicators', () => {
  const evidence = buildAiChatTimeframeEvidence({
    market: 'KR',
    symbol: '005930',
    timeframe: '15m',
    provider: 'fixture-public',
    asOf: null,
    candles: candles(20),
  });

  assert.equal(evidence.status, 'partial');
  assert.equal(evidence.candleCount, 20);
  assert.equal(evidence.indicators.ema50, null);
  assert.ok(evidence.warnings.some((value) => value.includes('EMA50')));
});

test('AI timeframe evidence returns unavailable on unusable candle evidence', () => {
  const evidence = buildAiChatTimeframeEvidence({
    market: 'UPBIT',
    symbol: 'BTC',
    timeframe: '4H',
    provider: 'fixture-public',
    asOf: null,
    candles: [],
  });

  assert.equal(evidence.status, 'unavailable');
  assert.equal(evidence.lastClosedCandle, null);
  assert.deepEqual(evidence.indicators, { ema20: null, ema50: null, rsi14: null, atr14: null });
});

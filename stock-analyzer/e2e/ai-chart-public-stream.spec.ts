import { expect, test } from '@playwright/test';
import {
  AI_CHART_PUBLIC_STREAM_ENDPOINTS,
  aiChartStreamFreshness,
  buildAiChartPublicStreamSubscription,
  createAiChartStreamReduction,
  nextAiChartReconnectDelayMs,
  parseBitgetPublicTradeMessage,
  parseUpbitPublicTradeMessage,
  reduceAiChartPublicTrade,
  shouldFallbackToPolling,
} from '../src/lib/ai-chart-public-stream';

const bootstrapCandle = {
  time: 1_787_788_800,
  sourceTime: '2026-08-27T00:00:00.000Z',
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 5,
  isClosed: false,
  closeStateSource: 'unknown' as const,
};

test('public stream subscriptions never use private endpoints', () => {
  expect(AI_CHART_PUBLIC_STREAM_ENDPOINTS.UPBIT).toBe('wss://api.upbit.com/websocket/v1');
  expect(AI_CHART_PUBLIC_STREAM_ENDPOINTS.BITGET).toBe('wss://ws.bitget.com/v2/ws/public');
  expect(Object.values(AI_CHART_PUBLIC_STREAM_ENDPOINTS).join(' ')).not.toContain('/private');

  const upbit = buildAiChartPublicStreamSubscription({ market: 'UPBIT', symbol: 'BTC', ticket: 'e2e' });
  expect(upbit.subscribePayload).toContain('"type":"trade"');
  expect(upbit.subscribePayload).toContain('"KRW-BTC"');
  expect(upbit.subscribePayload).toContain('"is_only_realtime":true');
  expect(upbit.heartbeatPayload).toBe('PING');

  const bitget = buildAiChartPublicStreamSubscription({ market: 'BITGET', symbol: 'BTC-USDT' });
  expect(bitget.subscribePayload).toContain('"instType":"USDT-FUTURES"');
  expect(bitget.subscribePayload).toContain('"channel":"trade"');
  expect(bitget.subscribePayload).toContain('"instId":"BTCUSDT"');
  expect(bitget.heartbeatPayload).toBe('ping');
});

test('Upbit sequential_id is preserved for uniqueness but never treated as ordered sequence', () => {
  const [event] = parseUpbitPublicTradeMessage({
    type: 'trade',
    code: 'KRW-BTC',
    trade_price: 101,
    trade_volume: 0.25,
    trade_timestamp: 1_787_788_860_000,
    sequential_id: 101,
    ask_bid: 'BID',
  }, 1_787_788_860_100);

  expect(event).toMatchObject({
    provider: 'UPBIT_PUBLIC',
    market: 'UPBIT',
    symbol: 'BTC',
    sequence: null,
    price: 101,
    volume: 0.25,
    aggressor: 'BUY',
  });
  expect(event.eventId).toContain('101');
});

test('Bitget public trade parser does not invent a sequence number', () => {
  const [event] = parseBitgetPublicTradeMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: 'trade', instId: 'BTCUSDT' },
    data: [{ ts: '1787788860000', price: '101.5', size: '0.1', side: 'sell', tradeId: 'T-1' }],
  }, 1_787_788_860_100);

  expect(event).toMatchObject({
    provider: 'BITGET_PUBLIC',
    market: 'BITGET',
    symbol: 'BTCUSDT',
    sequence: null,
    aggressor: 'SELL',
  });
});

test('stream reducer detects duplicate, time out-of-order and missing bars without invented provider sequence', () => {
  const initial = createAiChartStreamReduction([bootstrapCandle]);
  const first = reduceAiChartPublicTrade(initial, {
    provider: 'UPBIT_PUBLIC',
    market: 'UPBIT',
    symbol: 'BTC',
    eventId: 'UPBIT:KRW-BTC:100',
    sequence: null,
    eventTimeMs: 1_787_788_860_000,
    receivedAtMs: 1_787_788_860_100,
    price: 102,
    volume: 1,
    aggressor: 'BUY',
  }, '1m');

  expect(first.duplicate).toBe(false);
  expect(first.sequenceGap).toBe(false);
  expect(first.candles.at(-1)?.close).toBe(102);

  const duplicate = reduceAiChartPublicTrade(first, {
    provider: 'UPBIT_PUBLIC',
    market: 'UPBIT',
    symbol: 'BTC',
    eventId: 'UPBIT:KRW-BTC:100',
    sequence: null,
    eventTimeMs: 1_787_788_860_000,
    receivedAtMs: 1_787_788_860_200,
    price: 999,
    volume: 99,
    aggressor: 'BUY',
  }, '1m');
  expect(duplicate.duplicate).toBe(true);
  expect(duplicate.candles.at(-1)?.close).toBe(102);

  const gap = reduceAiChartPublicTrade(first, {
    provider: 'UPBIT_PUBLIC',
    market: 'UPBIT',
    symbol: 'BTC',
    eventId: 'UPBIT:KRW-BTC:103',
    sequence: null,
    eventTimeMs: 1_787_789_040_000,
    receivedAtMs: 1_787_789_040_050,
    price: 103,
    volume: 0.5,
    aggressor: 'SELL',
  }, '1m');
  expect(gap.sequenceGap).toBe(false);
  expect(gap.missingBars).toBeGreaterThan(0);
  expect(gap.candles.at(-2)?.isClosed).toBe(true);

  const old = reduceAiChartPublicTrade(gap, {
    provider: 'UPBIT_PUBLIC',
    market: 'UPBIT',
    symbol: 'BTC',
    eventId: 'UPBIT:KRW-BTC:102',
    sequence: null,
    eventTimeMs: 1_787_788_980_000,
    receivedAtMs: 1_787_789_040_060,
    price: 1,
    volume: 1,
    aggressor: 'SELL',
  }, '1m');
  expect(old.outOfOrder).toBe(true);
  expect(old.candles.at(-1)?.close).toBe(103);
});

test('reducer only checks sequence gaps when a provider supplies a real ordered sequence', () => {
  const first = reduceAiChartPublicTrade(createAiChartStreamReduction([]), {
    provider: 'BITGET_PUBLIC',
    market: 'BITGET',
    symbol: 'BTCUSDT',
    eventId: 'synthetic-ordered-10',
    sequence: 10,
    eventTimeMs: 10_000,
    receivedAtMs: 10_010,
    price: 100,
    volume: 1,
    aggressor: 'BUY',
  }, '1m');
  const next = reduceAiChartPublicTrade(first, {
    provider: 'BITGET_PUBLIC',
    market: 'BITGET',
    symbol: 'BTCUSDT',
    eventId: 'synthetic-ordered-12',
    sequence: 12,
    eventTimeMs: 70_000,
    receivedAtMs: 70_010,
    price: 101,
    volume: 1,
    aggressor: 'BUY',
  }, '1m');
  expect(next.sequenceGap).toBe(true);
});

test('freshness and reconnect logic fail closed into polling fallback', () => {
  expect(aiChartStreamFreshness({ status: 'LIVE_STREAM', lastEventAtMs: 10_000, nowMs: 20_000, staleAfterMs: 15_000 })).toBe('FRESH');
  expect(aiChartStreamFreshness({ status: 'LIVE_STREAM', lastEventAtMs: 10_000, nowMs: 30_001, staleAfterMs: 15_000 })).toBe('DELAYED');
  expect(aiChartStreamFreshness({ status: 'LIVE_STREAM', lastEventAtMs: 10_000, nowMs: 40_001, staleAfterMs: 15_000 })).toBe('STALE');
  expect(nextAiChartReconnectDelayMs(0)).toBe(1_000);
  expect(nextAiChartReconnectDelayMs(9)).toBe(30_000);
  expect(shouldFallbackToPolling({ status: 'RECOVERING', lastEventAtMs: 10_000, nowMs: 40_001, staleAfterMs: 15_000, reconnectAttempts: 2 })).toBe(true);
  expect(shouldFallbackToPolling({ status: 'RECOVERING', lastEventAtMs: 39_000, nowMs: 40_000, staleAfterMs: 15_000, reconnectAttempts: 5 })).toBe(true);
});

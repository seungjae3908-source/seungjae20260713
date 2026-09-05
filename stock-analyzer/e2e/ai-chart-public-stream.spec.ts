import { expect, test } from '@playwright/test';
import { normalizeChartCandles } from '../src/lib/chart-candle-normalizer';
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

test('public trade parsers never coerce missing volume or timestamp to zero', () => {
  for (const missing of [undefined, null, '', '   ', [], {}, false]) {
    const upbit = { type: 'trade', code: 'KRW-BTC', trade_price: 100, trade_volume: 1, trade_timestamp: 10_000 };
    expect(parseUpbitPublicTradeMessage({ ...upbit, trade_volume: missing }, 10_100)).toEqual([]);
    expect(parseUpbitPublicTradeMessage({ ...upbit, trade_timestamp: missing }, 10_100)).toEqual([]);
    const arg = { instType: 'USDT-FUTURES', channel: 'trade', instId: 'BTCUSDT' };
    const trade = { ts: '10000', price: '100', size: '1', tradeId: 'known' };
    expect(parseBitgetPublicTradeMessage({ arg, data: [{ ...trade, size: missing }] }, 10_100)).toEqual([]);
    expect(parseBitgetPublicTradeMessage({ arg, data: [{ ...trade, ts: missing }] }, 10_100)).toEqual([]);
  }
});

test('future and invalid event clocks never become fresh public evidence', () => {
  for (const clock of [-1, 0, Infinity, NaN, 100_001]) {
    expect(parseUpbitPublicTradeMessage({ type: 'trade', code: 'KRW-BTC', trade_price: 100, trade_volume: 1, trade_timestamp: clock }, 100_000)).toEqual([]);
    expect(parseBitgetPublicTradeMessage({ arg: { instType: 'USDT-FUTURES', channel: 'trade', instId: 'BTCUSDT' }, data: [{ ts: clock, price: '100', size: '1', tradeId: 'known' }] }, 100_000)).toEqual([]);
  }
  for (const clock of [NaN, Infinity, 100_001]) {
    expect(aiChartStreamFreshness({ status: 'LIVE_STREAM', lastEventAtMs: clock, nowMs: 100_000 })).toBe('UNAVAILABLE');
  }
});

test('REST bootstrap excludes unknown volume but preserves explicitly observed zero', () => {
  const candle = { time: '2026-08-27T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100 };
  for (const volume of [undefined, null, '', '   ', NaN]) {
    const result = normalizeChartCandles([{ ...candle, volume }], '1m');
    expect(result.candles).toEqual([]);
    expect(result.droppedRows).toBe(1);
    expect(result.warnings).toContain('사용 가능한 실제 캔들이 없음');
  }
  expect(normalizeChartCandles([{ ...candle, volume: 0 }], '1m').candles[0].volume).toBe(0);
  expect(normalizeChartCandles([{ ...candle, volume: '0' }], '1m').candles[0].volume).toBe(0);
});

test('Upbit REST UTC and KST candle clocks are normalized explicitly and preserve raw OHLCV truth', () => {
  const nowSeconds = Math.floor(Date.parse('2026-08-27T00:01:00.000Z') / 1_000);
  const common = {
    opening_price: 100,
    high_price: 101,
    low_price: 99,
    trade_price: 100.5,
    candle_acc_trade_volume: 12.25,
  };

  const utc = normalizeChartCandles([{ ...common, candle_date_time_utc: '2026-08-27T00:00:00' }], '1m', nowSeconds);
  const kst = normalizeChartCandles([{ ...common, candle_date_time_kst: '2026-08-27T09:00:00' }], '1m', nowSeconds);

  expect(utc.candles).toHaveLength(1);
  expect(kst.candles).toHaveLength(1);
  expect(utc.candles[0]).toMatchObject({
    time: Math.floor(Date.parse('2026-08-27T00:00:00Z') / 1_000),
    sourceTime: '2026-08-27T00:00:00Z',
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 12.25,
  });
  expect(kst.candles[0]).toMatchObject({
    time: Math.floor(Date.parse('2026-08-27T09:00:00+09:00') / 1_000),
    sourceTime: '2026-08-27T09:00:00+09:00',
  });
});

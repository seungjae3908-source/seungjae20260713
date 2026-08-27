import { expect, test } from '@playwright/test';
import {
  createAiChartPublicStreamClient,
  decodeAiChartWebSocketPayload,
} from '../src/lib/ai-chart-public-stream-client';

type MessageHandler = ((event: MessageEvent) => void) | null;
type EventHandler = ((event: Event) => void) | null;
type CloseHandler = ((event: CloseEvent) => void) | null;

class FakeSocket {
  readyState = 1;
  binaryType: BinaryType = 'blob';
  sent: string[] = [];
  closed = false;
  onopen: EventHandler = null;
  onmessage: MessageHandler = null;
  onerror: EventHandler = null;
  onclose: CloseHandler = null;

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sent.push(String(data));
  }

  close(_code?: number, _reason?: string) {
    this.closed = true;
  }
}

test('public stream client subscribes, emits public trades and tears down read-only socket', () => {
  const socket = new FakeSocket();
  const statuses: string[] = [];
  const trades: Array<{ provider: string; symbol: string; price: number }> = [];
  const client = createAiChartPublicStreamClient({
    market: 'BITGET',
    symbol: 'BTCUSDT',
    socketFactory: () => socket,
    now: () => 1_787_788_860_100,
    onStatus: (status) => statuses.push(status),
    onTrade: (event) => trades.push({ provider: event.provider, symbol: event.symbol, price: event.price }),
  });

  client.start();
  expect(statuses).toEqual(['CONNECTING']);
  expect(socket.binaryType).toBe('arraybuffer');
  socket.onopen?.({} as Event);
  expect(statuses.at(-1)).toBe('LIVE_STREAM');
  expect(client.snapshot().connectedAtMs).toBe(1_787_788_860_100);
  expect(socket.sent[0]).toContain('"channel":"trade"');
  expect(socket.sent[0]).not.toContain('private');

  socket.onmessage?.({
    data: JSON.stringify({
      action: 'snapshot',
      arg: { instType: 'USDT-FUTURES', channel: 'trade', instId: 'BTCUSDT' },
      data: [{ ts: '1787788860000', price: '101.5', size: '0.1', side: 'buy', tradeId: 'T-2' }],
    }),
  } as MessageEvent);
  expect(trades).toEqual([{ provider: 'BITGET_PUBLIC', symbol: 'BTCUSDT', price: 101.5 }]);
  expect(client.snapshot().freshness).toBe('FRESH');

  client.stop();
  expect(statuses.at(-1)).toBe('DISCONNECTED');
  expect(client.snapshot().connectedAtMs).toBeNull();
  expect(socket.closed).toBe(true);
});

test('utf8 ArrayBuffer websocket frames are decoded instead of silently discarded', () => {
  const socket = new FakeSocket();
  const trades: Array<{ symbol: string; price: number }> = [];
  const client = createAiChartPublicStreamClient({
    market: 'UPBIT',
    symbol: 'BTC',
    socketFactory: () => socket,
    now: () => 1_787_788_860_100,
    onTrade: (event) => trades.push({ symbol: event.symbol, price: event.price }),
  });
  client.start();
  socket.onopen?.({} as Event);

  const bytes = new TextEncoder().encode(JSON.stringify({
    type: 'trade',
    code: 'KRW-BTC',
    trade_price: 102.5,
    trade_volume: 0.2,
    trade_timestamp: 1_787_788_860_000,
    sequential_id: 99,
    ask_bid: 'BID',
  }));
  expect(decodeAiChartWebSocketPayload(bytes)).toContain('KRW-BTC');
  socket.onmessage?.({ data: bytes.buffer } as MessageEvent);
  expect(trades).toEqual([{ symbol: 'BTC', price: 102.5 }]);
  expect(client.snapshot().freshness).toBe('FRESH');
  client.stop();
});

test('connected socket with no first public trade fails closed to polling fallback', () => {
  const socket = new FakeSocket();
  const statuses: string[] = [];
  const diagnostics: string[] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  let currentNow = 1_000;

  const client = createAiChartPublicStreamClient({
    market: 'UPBIT',
    symbol: 'BTC',
    socketFactory: () => socket,
    now: () => currentNow,
    setTimeoutFn: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: () => undefined,
    onStatus: (status) => statuses.push(status),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.reason),
  });

  client.start();
  socket.onopen?.({} as Event);
  expect(statuses.at(-1)).toBe('LIVE_STREAM');
  expect(client.snapshot().freshness).toBe('UNAVAILABLE');

  const watchdog = scheduled.find((timer) => timer.delayMs === 5_000);
  expect(watchdog).toBeDefined();
  currentNow += 90_001;
  watchdog?.callback();

  expect(statuses.at(-1)).toBe('FALLBACK_POLLING');
  expect(diagnostics).toContain('FIRST_EVENT_TIMEOUT');
  expect(client.snapshot().status).toBe('FALLBACK_POLLING');
  expect(socket.closed).toBe(true);
});

test('missing WebSocket capability fails closed to polling fallback', () => {
  const statuses: string[] = [];
  const client = createAiChartPublicStreamClient({
    market: 'UPBIT',
    symbol: 'BTC',
    socketFactory: () => { throw new Error('blocked'); },
    onStatus: (status) => statuses.push(status),
  });

  client.start();
  expect(statuses).toEqual(['CONNECTING', 'FALLBACK_POLLING']);
  expect(client.snapshot().status).toBe('FALLBACK_POLLING');
  expect(client.snapshot().freshness).toBe('UNAVAILABLE');
});

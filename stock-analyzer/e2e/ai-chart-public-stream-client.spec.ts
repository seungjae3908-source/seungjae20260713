import { expect, test } from '@playwright/test';
import {
  createAiChartPublicStreamClient,
  decodeAiChartWebSocketPayload,
} from '../src/lib/ai-chart-public-stream-client';

type MessageHandler = ((event: MessageEvent) => void) | null;
type EventHandler = ((event: Event) => void) | null;
type CloseHandler = ((event: CloseEvent) => void) | null;

class FrameController {
  private nextId = 1;
  private callbacks = new Map<number, FrameRequestCallback>();

  request = (callback: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };

  cancel = (id: number): void => {
    this.callbacks.delete(id);
  };

  flush(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(0);
  }

  get pending(): number {
    return this.callbacks.size;
  }
}

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
  const frames = new FrameController();
  const statuses: string[] = [];
  const trades: Array<{ provider: string; symbol: string; price: number }> = [];
  const client = createAiChartPublicStreamClient({
    market: 'BITGET',
    symbol: 'BTCUSDT',
    socketFactory: () => socket,
    now: () => 1_787_788_860_100,
    requestAnimationFrameFn: frames.request,
    cancelAnimationFrameFn: frames.cancel,
    onStatus: (status) => statuses.push(status),
    onTrade: (event) => trades.push({ provider: event.provider, symbol: event.symbol, price: event.price }),
  });

  client.start();
  expect(statuses).toEqual(['CONNECTING']);
  expect(socket.binaryType).toBe('arraybuffer');
  socket.onopen?.({} as Event);
  expect(statuses.at(-1)).toBe('WAITING_FIRST_EVENT');
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
  expect(trades).toEqual([]);
  expect(frames.pending).toBe(1);
  frames.flush();
  expect(statuses.at(-1)).toBe('LIVE_STREAM');
  expect(trades).toEqual([{ provider: 'BITGET_PUBLIC', symbol: 'BTCUSDT', price: 101.5 }]);
  expect(client.snapshot().freshness).toBe('FRESH');

  client.stop();
  expect(statuses.at(-1)).toBe('DISCONNECTED');
  expect(client.snapshot().connectedAtMs).toBeNull();
  expect(socket.closed).toBe(true);
});

test('utf8 ArrayBuffer websocket frames are decoded instead of silently discarded', () => {
  const socket = new FakeSocket();
  const frames = new FrameController();
  const trades: Array<{ symbol: string; price: number }> = [];
  const client = createAiChartPublicStreamClient({
    market: 'UPBIT',
    symbol: 'BTC',
    socketFactory: () => socket,
    now: () => 1_787_788_860_100,
    requestAnimationFrameFn: frames.request,
    cancelAnimationFrameFn: frames.cancel,
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
  expect(trades).toEqual([]);
  frames.flush();
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
  expect(statuses.at(-1)).toBe('WAITING_FIRST_EVENT');
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

test('foreign symbol events cannot enter the selected instrument or refresh its clock', () => {
  for (const market of ['UPBIT', 'BITGET'] as const) {
    const socket = new FakeSocket();
    const trades: unknown[] = [];
    const client = createAiChartPublicStreamClient({ market, symbol: market === 'UPBIT' ? 'KRW-BTC' : 'BTC-USDT', socketFactory: () => socket, now: () => 10_100, onTrade: (event) => trades.push(event) });
    client.start();
    socket.onopen?.({} as Event);
    const data = market === 'UPBIT'
      ? { type: 'trade', code: 'KRW-ETH', trade_price: 100, trade_volume: 1, trade_timestamp: 10_000 }
      : { arg: { instType: 'USDT-FUTURES', channel: 'trade', instId: 'ETHUSDT' }, data: [{ ts: '10000', price: '100', size: '1', tradeId: 'foreign' }] };
    socket.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
    expect(trades).toEqual([]);
    expect(client.snapshot().lastEventAtMs).toBeNull();
    client.stop();
  }
});

test('a delayed old socket close cannot tear down the replacement connection', () => {
  const sockets = [new FakeSocket(), new FakeSocket()];
  let index = 0;
  const scheduled: Array<() => void> = [];
  const client = createAiChartPublicStreamClient({ market: 'UPBIT', symbol: 'BTC', socketFactory: () => sockets[index++], now: () => 10_100, setTimeoutFn: (callback) => { scheduled.push(callback); return scheduled.length as unknown as ReturnType<typeof setTimeout>; }, clearTimeoutFn: () => undefined });
  client.start();
  sockets[0].onopen?.({} as Event);
  sockets[0].onclose?.({} as CloseEvent);
  scheduled.at(-1)?.();
  sockets[1].onopen?.({} as Event);
  sockets[0].onclose?.({} as CloseEvent);
  expect(client.snapshot().status).toBe('WAITING_FIRST_EVENT');
  expect(client.snapshot().connectedAtMs).toBe(10_100);
  expect(client.snapshot().reconnectAttempts).toBe(1);
  client.stop();
});

test('a socket that never opens exits CONNECTING through bounded polling fallback', () => {
  const socket = new FakeSocket();
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const client = createAiChartPublicStreamClient({ market: 'UPBIT', symbol: 'BTC', socketFactory: () => socket, setTimeoutFn: (callback, delayMs) => { scheduled.push({ callback, delayMs }); return scheduled.length as unknown as ReturnType<typeof setTimeout>; }, clearTimeoutFn: () => undefined });
  client.start();
  const connectionDeadline = scheduled.find((timer) => timer.delayMs === 45_000);
  expect(connectionDeadline).toBeDefined();
  connectionDeadline?.callback();
  expect(client.snapshot().status).toBe('FALLBACK_POLLING');
  expect(client.snapshot().freshness).toBe('UNAVAILABLE');
  expect(socket.closed).toBe(true);
  client.stop();
});


test('burst processing is bounded and fails closed instead of dropping arbitrary trades', () => {
  const socket = new FakeSocket();
  const frames = new FrameController();
  const client = createAiChartPublicStreamClient({
    market: 'BITGET',
    symbol: 'BTCUSDT',
    socketFactory: () => socket,
    now: () => 10_100,
    maxPendingEvents: 2,
    requestAnimationFrameFn: frames.request,
    cancelAnimationFrameFn: frames.cancel,
  });

  client.start();
  socket.onopen?.({} as Event);
  socket.onmessage?.({
    data: JSON.stringify({
      arg: { instType: 'USDT-FUTURES', channel: 'trade', instId: 'BTCUSDT' },
      data: [
        { ts: '10000', price: '100', size: '1', tradeId: 'burst-1' },
        { ts: '10001', price: '101', size: '1', tradeId: 'burst-2' },
        { ts: '10002', price: '102', size: '1', tradeId: 'burst-3' },
      ],
    }),
  } as MessageEvent);

  expect(client.snapshot().status).toBe('FALLBACK_POLLING');
  expect(client.snapshot().pendingEvents).toBe(0);
  expect(client.snapshot().maxPendingEvents).toBe(2);
  expect(frames.pending).toBe(0);
  expect(socket.closed).toBe(true);
});

test('stop cancels queued frames so a late old-subscription event cannot mutate the consumer', () => {
  const socket = new FakeSocket();
  const frames = new FrameController();
  const trades: unknown[] = [];
  const client = createAiChartPublicStreamClient({
    market: 'UPBIT',
    symbol: 'BTC',
    socketFactory: () => socket,
    now: () => 10_100,
    requestAnimationFrameFn: frames.request,
    cancelAnimationFrameFn: frames.cancel,
    onTrade: (event) => trades.push(event),
  });

  client.start();
  socket.onopen?.({} as Event);
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'trade',
      code: 'KRW-BTC',
      trade_price: 100,
      trade_volume: 1,
      trade_timestamp: 10_000,
      sequential_id: 1,
    }),
  } as MessageEvent);
  expect(frames.pending).toBe(1);

  client.stop();
  expect(frames.pending).toBe(0);
  frames.flush();
  expect(trades).toEqual([]);
});

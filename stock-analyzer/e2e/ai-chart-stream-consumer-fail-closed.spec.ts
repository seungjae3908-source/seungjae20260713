import { expect, test } from '@playwright/test';
import { createAiChartPublicStreamClient } from '../src/lib/ai-chart-public-stream-client';

type EventHandler = ((event: Event) => void) | null;
type MessageHandler = ((event: MessageEvent) => void) | null;
type CloseHandler = ((event: CloseEvent) => void) | null;
type TimerHandle = ReturnType<typeof setTimeout>;

class ConsumerFailureSocketFake {
  static instances: ConsumerFailureSocketFake[] = [];

  readyState = 0;
  binaryType: BinaryType = 'blob';
  onopen: EventHandler = null;
  onmessage: MessageHandler = null;
  onerror: EventHandler = null;
  onclose: CloseHandler = null;
  sendCount = 0;
  closeCount = 0;

  constructor(_url: string) {
    ConsumerFailureSocketFake.instances.push(this);
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sendCount += 1;
  }

  close(_code?: number, _reason?: string): void {
    this.closeCount += 1;
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

function bitgetTrade(symbol: string, tradeId: string, timestamp = 49_000): MessageEvent {
  return {
    data: JSON.stringify({
      arg: { instType: 'USDT-FUTURES', channel: 'trade', instId: symbol },
      data: [{ ts: String(timestamp), price: '100', size: '1', side: 'buy', tradeId }],
    }),
  } as MessageEvent;
}

function runtime() {
  let nextTimer = 1;
  let nextFrame = 1;
  const timers = new Map<TimerHandle, () => void>();
  const frames = new Map<number, FrameRequestCallback>();

  return {
    timers,
    frames,
    setTimeoutFn(callback: () => void, _delayMs: number): TimerHandle {
      const handle = nextTimer++ as unknown as TimerHandle;
      timers.set(handle, callback);
      return handle;
    },
    clearTimeoutFn(handle: TimerHandle): void {
      timers.delete(handle);
    },
    requestAnimationFrameFn(callback: FrameRequestCallback): number {
      const handle = nextFrame++;
      frames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrameFn(handle: number): void {
      frames.delete(handle);
    },
    runNextFrame(): void {
      const next = frames.entries().next();
      expect(next.done).toBe(false);
      const [handle, callback] = next.value as [number, FrameRequestCallback];
      frames.delete(handle);
      callback(50_000);
    },
  };
}

function installFakeWebSocket() {
  const originalWebSocket = globalThis.WebSocket;
  ConsumerFailureSocketFake.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: ConsumerFailureSocketFake,
  });
  return () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  };
}

test('batch consumer exception is contained and fails closed exactly once', () => {
  const restore = installFakeWebSocket();
  const clock = runtime();
  const statuses: Array<{ status: string; reason: string }> = [];

  try {
    const client = createAiChartPublicStreamClient({
      market: 'BITGET',
      symbol: 'BATCHFAILUSDT',
      now: () => 50_000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      requestAnimationFrameFn: clock.requestAnimationFrameFn,
      cancelAnimationFrameFn: clock.cancelAnimationFrameFn,
      onTrades: () => { throw new Error('fixture batch consumer failure'); },
      onStatus: (status, reason) => statuses.push({ status, reason }),
    });

    client.start();
    const socket = ConsumerFailureSocketFake.instances[0];
    socket.onopen?.({} as Event);
    socket.onmessage?.(bitgetTrade('BATCHFAILUSDT', 'batch-1'));

    expect(() => clock.runNextFrame()).not.toThrow();
    expect(client.snapshot()).toMatchObject({
      status: 'FALLBACK_POLLING',
      reason: 'PROTOCOL_FAILURE',
      reconnectAttempts: 0,
      pendingEvents: 0,
      pendingRenderWork: 0,
    });
    expect(statuses.filter((row) => row.reason === 'PROTOCOL_FAILURE')).toHaveLength(1);
    expect(socket.closeCount).toBe(1);
    expect(clock.timers.size).toBe(0);
    expect(clock.frames.size).toBe(0);

    const second = createAiChartPublicStreamClient({
      market: 'BITGET',
      symbol: 'BATCHFAILUSDT',
      now: () => 50_000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      requestAnimationFrameFn: clock.requestAnimationFrameFn,
      cancelAnimationFrameFn: clock.cancelAnimationFrameFn,
      onTrades: () => true,
    });
    second.start();
    expect(ConsumerFailureSocketFake.instances).toHaveLength(1);
    expect(second.snapshot()).toMatchObject({
      status: 'FALLBACK_POLLING',
      reason: 'PROVIDER_FALLBACK_COOLDOWN',
      reconnectAttempts: 0,
    });

    client.stop();
    second.stop();
  } finally {
    restore();
  }
});

test('single-trade consumer exception is contained and fails closed exactly once', () => {
  const restore = installFakeWebSocket();
  const clock = runtime();
  const statuses: Array<{ status: string; reason: string }> = [];

  try {
    const client = createAiChartPublicStreamClient({
      market: 'BITGET',
      symbol: 'SINGLEFAILUSDT',
      now: () => 50_000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      requestAnimationFrameFn: clock.requestAnimationFrameFn,
      cancelAnimationFrameFn: clock.cancelAnimationFrameFn,
      onTrade: () => { throw new Error('fixture single consumer failure'); },
      onStatus: (status, reason) => statuses.push({ status, reason }),
    });

    client.start();
    const socket = ConsumerFailureSocketFake.instances[0];
    socket.onopen?.({} as Event);
    socket.onmessage?.(bitgetTrade('SINGLEFAILUSDT', 'single-1'));

    expect(() => clock.runNextFrame()).not.toThrow();
    expect(client.snapshot()).toMatchObject({
      status: 'FALLBACK_POLLING',
      reason: 'PROTOCOL_FAILURE',
      reconnectAttempts: 0,
      pendingEvents: 0,
      pendingRenderWork: 0,
    });
    expect(statuses.filter((row) => row.reason === 'PROTOCOL_FAILURE')).toHaveLength(1);
    expect(socket.closeCount).toBe(1);
    expect(clock.timers.size).toBe(0);
    expect(clock.frames.size).toBe(0);

    client.stop();
  } finally {
    restore();
  }
});

test('explicit consumer rejection remains non-terminal and does not become a protocol failure', () => {
  const restore = installFakeWebSocket();
  const clock = runtime();
  const diagnostics: string[] = [];

  try {
    const client = createAiChartPublicStreamClient({
      market: 'BITGET',
      symbol: 'REJECTUSDT',
      now: () => 50_000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      requestAnimationFrameFn: clock.requestAnimationFrameFn,
      cancelAnimationFrameFn: clock.cancelAnimationFrameFn,
      onTrades: () => false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.reason),
    });

    client.start();
    const socket = ConsumerFailureSocketFake.instances[0];
    socket.onopen?.({} as Event);
    socket.onmessage?.(bitgetTrade('REJECTUSDT', 'reject-1'));
    clock.runNextFrame();

    expect(client.snapshot()).toMatchObject({
      status: 'WAITING_FIRST_EVENT',
      reason: 'PUBLIC_STREAM_CONNECTED_WAITING_FOR_DATA',
      lastEventAtMs: null,
      reconnectAttempts: 0,
    });
    expect(diagnostics).toContain('STREAM_BATCH_REJECTED');
    expect(diagnostics).not.toContain('PROTOCOL_FAILURE');
    expect(socket.closeCount).toBe(0);

    client.stop();
  } finally {
    restore();
  }
});

test('accepted consumer path still transitions to live stream', () => {
  const restore = installFakeWebSocket();
  const clock = runtime();
  let accepted = 0;

  try {
    const client = createAiChartPublicStreamClient({
      market: 'BITGET',
      symbol: 'ACCEPTUSDT',
      now: () => 50_000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      requestAnimationFrameFn: clock.requestAnimationFrameFn,
      cancelAnimationFrameFn: clock.cancelAnimationFrameFn,
      onTrade: () => { accepted += 1; },
    });

    client.start();
    const socket = ConsumerFailureSocketFake.instances[0];
    socket.onopen?.({} as Event);
    socket.onmessage?.(bitgetTrade('ACCEPTUSDT', 'accept-1'));
    clock.runNextFrame();

    expect(accepted).toBe(1);
    expect(client.snapshot()).toMatchObject({
      status: 'LIVE_STREAM',
      reason: 'FIRST_VALID_EVENT_ACCEPTED',
      lastEventAtMs: 49_000,
      reconnectAttempts: 0,
    });
    expect(socket.closeCount).toBe(0);

    client.stop();
  } finally {
    restore();
  }
});

test('status observer exception cannot break connect, reconnect, or stop control flow', () => {
  const restore = installFakeWebSocket();
  const clock = runtime();

  try {
    const client = createAiChartPublicStreamClient({
      market: 'BITGET',
      symbol: 'STATUSFAILUSDT',
      now: () => 50_000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      requestAnimationFrameFn: clock.requestAnimationFrameFn,
      cancelAnimationFrameFn: clock.cancelAnimationFrameFn,
      onTrades: () => true,
      onStatus: () => { throw new Error('fixture status observer failure'); },
    });

    expect(() => client.start()).not.toThrow();
    expect(ConsumerFailureSocketFake.instances).toHaveLength(1);
    expect(client.snapshot()).toMatchObject({ status: 'CONNECTING', reason: 'CONNECTING' });

    const socket = ConsumerFailureSocketFake.instances[0];
    expect(() => socket.onopen?.({} as Event)).not.toThrow();
    expect(client.snapshot()).toMatchObject({
      status: 'WAITING_FIRST_EVENT',
      reason: 'PUBLIC_STREAM_CONNECTED_WAITING_FOR_DATA',
      reconnectAttempts: 0,
    });
    expect(clock.timers.size).toBe(2);

    expect(() => socket.onclose?.({} as CloseEvent)).not.toThrow();
    expect(client.snapshot()).toMatchObject({
      status: 'RECOVERING',
      reason: 'SOCKET_CLOSED',
      reconnectAttempts: 1,
    });
    expect(clock.timers.size).toBe(1);

    expect(() => client.stop()).not.toThrow();
    expect(client.snapshot()).toMatchObject({ status: 'DISCONNECTED', reason: 'CLIENT_STOPPED' });
    expect(clock.timers.size).toBe(0);
  } finally {
    restore();
  }
});

test('diagnostic observer exception remains isolated across socket and live-stream notifications', () => {
  const restore = installFakeWebSocket();
  const clock = runtime();

  try {
    const client = createAiChartPublicStreamClient({
      market: 'BITGET',
      symbol: 'DIAGFAILUSDT',
      now: () => 50_000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      requestAnimationFrameFn: clock.requestAnimationFrameFn,
      cancelAnimationFrameFn: clock.cancelAnimationFrameFn,
      onTrades: () => true,
      onDiagnostic: () => { throw new Error('fixture diagnostic observer failure'); },
    });

    expect(() => client.start()).not.toThrow();
    const socket = ConsumerFailureSocketFake.instances[0];
    expect(() => socket.onopen?.({} as Event)).not.toThrow();
    expect(() => socket.onerror?.({} as Event)).not.toThrow();
    expect(() => socket.onmessage?.({ data: { unsupported: true } } as unknown as MessageEvent)).not.toThrow();

    expect(() => socket.onmessage?.(bitgetTrade('DIAGFAILUSDT', 'diag-1'))).not.toThrow();
    expect(() => clock.runNextFrame()).not.toThrow();
    expect(client.snapshot()).toMatchObject({
      status: 'LIVE_STREAM',
      reason: 'FIRST_VALID_EVENT_ACCEPTED',
      lastEventAtMs: 49_000,
      reconnectAttempts: 0,
    });

    expect(() => client.stop()).not.toThrow();
    expect(client.snapshot()).toMatchObject({ status: 'DISCONNECTED', reason: 'CLIENT_STOPPED' });
  } finally {
    restore();
  }
});

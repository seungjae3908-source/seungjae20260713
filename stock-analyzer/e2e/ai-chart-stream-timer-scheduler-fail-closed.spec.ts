import { expect, test } from '@playwright/test';
import { createAiChartPublicStreamClient } from '../src/lib/ai-chart-public-stream-client';

type EventHandler = ((event: Event) => void) | null;
type MessageHandler = ((event: MessageEvent) => void) | null;
type CloseHandler = ((event: CloseEvent) => void) | null;
type TimerHandle = ReturnType<typeof setTimeout>;

class TimerFailureSocketFake {
  readyState = 0;
  binaryType: BinaryType = 'blob';
  onopen: EventHandler = null;
  onmessage: MessageHandler = null;
  onerror: EventHandler = null;
  onclose: CloseHandler = null;
  closeCount = 0;
  sendCount = 0;

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sendCount += 1;
  }

  close(_code?: number, _reason?: string): void {
    this.closeCount += 1;
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

function timerRuntime(failOnCall: number) {
  let calls = 0;
  let nextHandle = 1;
  const active = new Set<TimerHandle>();

  return {
    active,
    get calls() { return calls; },
    setTimeoutFn(_callback: () => void, _delayMs: number): TimerHandle {
      calls += 1;
      if (calls === failOnCall) throw new Error(`fixture timer scheduler failure ${calls}`);
      const handle = nextHandle++ as unknown as TimerHandle;
      active.add(handle);
      return handle;
    },
    clearTimeoutFn(handle: TimerHandle): void {
      active.delete(handle);
    },
  };
}

function createClient(socket: TimerFailureSocketFake, failOnCall: number) {
  const timers = timerRuntime(failOnCall);
  const client = createAiChartPublicStreamClient({
    market: 'BITGET',
    symbol: 'BTCUSDT',
    now: () => 50_000,
    socketFactory: () => socket,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    requestAnimationFrameFn: () => 1,
    cancelAnimationFrameFn: () => undefined,
    onTrades: () => true,
  });
  return { client, timers };
}

test('connect-timeout scheduler exception cannot escape start and fails closed', () => {
  const socket = new TimerFailureSocketFake();
  const { client, timers } = createClient(socket, 1);

  expect(() => client.start()).not.toThrow();
  expect(timers.calls).toBe(1);
  expect(timers.active.size).toBe(0);
  expect(socket.closeCount).toBe(1);
  expect(client.snapshot()).toMatchObject({
    status: 'FALLBACK_POLLING',
    reason: 'PROTOCOL_FAILURE',
    connectedAtMs: null,
    pendingEvents: 0,
    pendingRenderWork: 0,
  });
});

test('heartbeat scheduler exception cannot escape open or leave watchdog work behind', () => {
  const socket = new TimerFailureSocketFake();
  const { client, timers } = createClient(socket, 2);

  client.start();
  expect(timers.calls).toBe(1);
  expect(() => socket.onopen?.({} as Event)).not.toThrow();

  expect(timers.calls).toBe(2);
  expect(timers.active.size).toBe(0);
  expect(socket.closeCount).toBe(1);
  expect(client.snapshot()).toMatchObject({
    status: 'FALLBACK_POLLING',
    reason: 'PROTOCOL_FAILURE',
    connectedAtMs: null,
    reconnectAttempts: 0,
  });
});

test('watchdog scheduler exception clears an already scheduled heartbeat and fails closed', () => {
  const socket = new TimerFailureSocketFake();
  const { client, timers } = createClient(socket, 3);

  client.start();
  expect(() => socket.onopen?.({} as Event)).not.toThrow();

  expect(timers.calls).toBe(3);
  expect(timers.active.size).toBe(0);
  expect(socket.closeCount).toBe(1);
  expect(client.snapshot()).toMatchObject({
    status: 'FALLBACK_POLLING',
    reason: 'PROTOCOL_FAILURE',
    connectedAtMs: null,
    reconnectAttempts: 0,
  });
});

test('reconnect scheduler exception cannot escape close or strand recovering state', () => {
  const socket = new TimerFailureSocketFake();
  const { client, timers } = createClient(socket, 4);

  client.start();
  socket.onopen?.({} as Event);
  expect(client.snapshot()).toMatchObject({
    status: 'WAITING_FIRST_EVENT',
    reason: 'PUBLIC_STREAM_CONNECTED_WAITING_FOR_DATA',
    reconnectAttempts: 0,
  });
  expect(timers.active.size).toBe(2);

  expect(() => socket.onclose?.({} as CloseEvent)).not.toThrow();
  expect(timers.calls).toBe(4);
  expect(timers.active.size).toBe(0);
  expect(client.snapshot()).toMatchObject({
    status: 'FALLBACK_POLLING',
    reason: 'PROTOCOL_FAILURE',
    connectedAtMs: null,
    reconnectAttempts: 1,
  });
});

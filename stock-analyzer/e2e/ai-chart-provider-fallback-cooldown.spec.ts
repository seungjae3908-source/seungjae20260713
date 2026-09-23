import { expect, test } from '@playwright/test';
import { createAiChartPublicStreamClient } from '../src/lib/ai-chart-public-stream-client';

type EventHandler = ((event: Event) => void) | null;
type MessageHandler = ((event: MessageEvent) => void) | null;
type CloseHandler = ((event: CloseEvent) => void) | null;

class DefaultSocketFake {
  static instances: DefaultSocketFake[] = [];

  readyState = 0;
  binaryType: BinaryType = 'blob';
  onopen: EventHandler = null;
  onmessage: MessageHandler = null;
  onerror: EventHandler = null;
  onclose: CloseHandler = null;

  constructor(_url: string) {
    DefaultSocketFake.instances.push(this);
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {}

  close(_code?: number, _reason?: string): void {}
}

test('pre-open provider rejection stays on REST fallback across recreated default clients', () => {
  const originalWebSocket = globalThis.WebSocket;

  try {
    DefaultSocketFake.instances = [];
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: DefaultSocketFake,
    });

    const firstStatuses: Array<{ status: string; reason: string }> = [];
    const first = createAiChartPublicStreamClient({
      market: 'UPBIT',
      symbol: 'RETRYGUARD',
      now: () => 1_000,
      onStatus: (status, reason) => firstStatuses.push({ status, reason }),
    });

    first.start();
    expect(DefaultSocketFake.instances).toHaveLength(1);
    DefaultSocketFake.instances[0].onclose?.({} as CloseEvent);
    expect(first.snapshot().status).toBe('FALLBACK_POLLING');
    expect(firstStatuses.at(-1)).toEqual({
      status: 'FALLBACK_POLLING',
      reason: 'PREOPEN_CONNECTION_CLOSED',
    });
    first.stop();

    const secondStatuses: Array<{ status: string; reason: string }> = [];
    const second = createAiChartPublicStreamClient({
      market: 'UPBIT',
      symbol: 'RETRYGUARD',
      now: () => 1_000,
      onStatus: (status, reason) => secondStatuses.push({ status, reason }),
    });

    second.start();
    expect(DefaultSocketFake.instances).toHaveLength(1);
    expect(second.snapshot().status).toBe('FALLBACK_POLLING');
    expect(secondStatuses).toEqual([{
      status: 'FALLBACK_POLLING',
      reason: 'PROVIDER_FALLBACK_COOLDOWN',
    }]);
    second.stop();
  } finally {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  }
});

test('connect timeout stays on REST fallback across recreated default clients', () => {
  const originalWebSocket = globalThis.WebSocket;

  try {
    DefaultSocketFake.instances = [];
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: DefaultSocketFake,
    });

    let connectTimeout: (() => void) | null = null;
    const firstStatuses: Array<{ status: string; reason: string }> = [];
    const first = createAiChartPublicStreamClient({
      market: 'UPBIT',
      symbol: 'TIMEOUTGUARD',
      now: () => 2_000,
      setTimeoutFn: (callback) => {
        connectTimeout = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {},
      onStatus: (status, reason) => firstStatuses.push({ status, reason }),
    });

    first.start();
    expect(DefaultSocketFake.instances).toHaveLength(1);
    expect(connectTimeout).not.toBeNull();
    connectTimeout?.();
    expect(first.snapshot().status).toBe('FALLBACK_POLLING');
    expect(firstStatuses.at(-1)).toEqual({
      status: 'FALLBACK_POLLING',
      reason: 'CONNECT_TIMEOUT',
    });
    first.stop();

    const secondStatuses: Array<{ status: string; reason: string }> = [];
    const second = createAiChartPublicStreamClient({
      market: 'UPBIT',
      symbol: 'TIMEOUTGUARD',
      now: () => 2_000,
      onStatus: (status, reason) => secondStatuses.push({ status, reason }),
    });

    second.start();
    expect(DefaultSocketFake.instances).toHaveLength(1);
    expect(second.snapshot().status).toBe('FALLBACK_POLLING');
    expect(secondStatuses).toEqual([{
      status: 'FALLBACK_POLLING',
      reason: 'PROVIDER_FALLBACK_COOLDOWN',
    }]);
    second.stop();
  } finally {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  }
});

test('first-event timeout stays on REST fallback across recreated default clients', () => {
  const originalWebSocket = globalThis.WebSocket;

  try {
    DefaultSocketFake.instances = [];
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: DefaultSocketFake,
    });

    let currentNow = 3_000;
    const scheduled: Array<() => void> = [];
    const firstStatuses: Array<{ status: string; reason: string }> = [];
    const first = createAiChartPublicStreamClient({
      market: 'UPBIT',
      symbol: 'FIRSTEVENTGUARD',
      now: () => currentNow,
      setTimeoutFn: (callback) => {
        scheduled.push(callback);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {},
      onStatus: (status, reason) => firstStatuses.push({ status, reason }),
    });

    first.start();
    expect(DefaultSocketFake.instances).toHaveLength(1);
    DefaultSocketFake.instances[0].onopen?.({} as Event);
    expect(first.snapshot().status).toBe('WAITING_FIRST_EVENT');

    currentNow = 1_000_000_000;
    for (const callback of scheduled.slice()) callback();

    expect(first.snapshot().status).toBe('FALLBACK_POLLING');
    expect(firstStatuses.at(-1)).toEqual({
      status: 'FALLBACK_POLLING',
      reason: 'FIRST_EVENT_TIMEOUT',
    });
    first.stop();

    const secondStatuses: Array<{ status: string; reason: string }> = [];
    const second = createAiChartPublicStreamClient({
      market: 'UPBIT',
      symbol: 'FIRSTEVENTGUARD',
      now: () => currentNow,
      onStatus: (status, reason) => secondStatuses.push({ status, reason }),
    });

    second.start();
    expect(DefaultSocketFake.instances).toHaveLength(1);
    expect(second.snapshot().status).toBe('FALLBACK_POLLING');
    expect(secondStatuses).toEqual([{
      status: 'FALLBACK_POLLING',
      reason: 'PROVIDER_FALLBACK_COOLDOWN',
    }]);
    second.stop();
  } finally {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  }
});

test('reconnect limit stays on REST fallback across recreated default clients', () => {
  const originalWebSocket = globalThis.WebSocket;

  try {
    DefaultSocketFake.instances = [];
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: DefaultSocketFake,
    });

    const timers: Array<{ callback: () => void; active: boolean }> = [];
    const firstStatuses: Array<{ status: string; reason: string }> = [];
    const first = createAiChartPublicStreamClient({
      market: 'UPBIT',
      symbol: 'RECONNECTGUARD',
      now: () => 4_000,
      setTimeoutFn: (callback) => {
        timers.push({ callback, active: true });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: (handle) => {
        const index = Number(handle) - 1;
        if (timers[index]) timers[index].active = false;
      },
      onStatus: (status, reason) => firstStatuses.push({ status, reason }),
    });

    const runOnlyActiveTimer = () => {
      const timer = timers.find((candidate) => candidate.active);
      expect(timer, 'expected one reconnect timer').toBeTruthy();
      if (!timer) return;
      timer.active = false;
      timer.callback();
    };

    first.start();
    expect(DefaultSocketFake.instances).toHaveLength(1);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const current = DefaultSocketFake.instances.at(-1);
      expect(current).toBeTruthy();
      current?.onopen?.({} as Event);
      current?.onclose?.({} as CloseEvent);

      if (attempt < 5) {
        expect(first.snapshot().status).toBe('RECOVERING');
        runOnlyActiveTimer();
        expect(DefaultSocketFake.instances).toHaveLength(attempt + 1);
      }
    }

    expect(DefaultSocketFake.instances).toHaveLength(5);
    expect(first.snapshot().status).toBe('FALLBACK_POLLING');
    expect(firstStatuses.at(-1)).toEqual({
      status: 'FALLBACK_POLLING',
      reason: 'RECONNECT_LIMIT_REACHED',
    });
    first.stop();

    const secondStatuses: Array<{ status: string; reason: string }> = [];
    const second = createAiChartPublicStreamClient({
      market: 'UPBIT',
      symbol: 'RECONNECTGUARD',
      now: () => 4_000,
      onStatus: (status, reason) => secondStatuses.push({ status, reason }),
    });

    second.start();
    expect(DefaultSocketFake.instances).toHaveLength(5);
    expect(second.snapshot().status).toBe('FALLBACK_POLLING');
    expect(secondStatuses).toEqual([{
      status: 'FALLBACK_POLLING',
      reason: 'PROVIDER_FALLBACK_COOLDOWN',
    }]);
    second.stop();
  } finally {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  }
});

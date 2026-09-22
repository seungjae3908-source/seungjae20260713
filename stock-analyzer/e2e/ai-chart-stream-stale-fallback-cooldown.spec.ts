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

test('stale established stream stays on REST fallback across recreated default clients', () => {
  const originalWebSocket = globalThis.WebSocket;

  try {
    DefaultSocketFake.instances = [];
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: DefaultSocketFake,
    });

    let currentNow = 5_000;
    const timers: Array<{ callback: () => void; active: boolean }> = [];
    const frames: Array<() => void> = [];
    const firstStatuses: Array<{ status: string; reason: string }> = [];
    const first = createAiChartPublicStreamClient({
      market: 'UPBIT',
      symbol: 'STALEGUARD',
      now: () => currentNow,
      setTimeoutFn: (callback) => {
        timers.push({ callback, active: true });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: (handle) => {
        const index = Number(handle) - 1;
        if (timers[index]) timers[index].active = false;
      },
      requestAnimationFrameFn: (callback) => {
        frames.push(() => callback(currentNow));
        return frames.length;
      },
      cancelAnimationFrameFn: () => {},
      onStatus: (status, reason) => firstStatuses.push({ status, reason }),
    });

    first.start();
    expect(DefaultSocketFake.instances).toHaveLength(1);
    const firstSocket = DefaultSocketFake.instances[0];
    firstSocket.onopen?.({} as Event);
    expect(first.snapshot().status).toBe('WAITING_FIRST_EVENT');

    firstSocket.onmessage?.({
      data: JSON.stringify({
        type: 'trade',
        code: 'KRW-STALEGUARD',
        trade_timestamp: currentNow,
        trade_price: 100,
        trade_volume: 1,
        sequential_id: 'stale-guard-1',
        ask_bid: 'BID',
      }),
    } as MessageEvent);
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(first.snapshot().status).toBe('LIVE_STREAM');

    currentNow = 1_000_000;
    const scheduledBeforeStaleCheck = timers.slice();
    for (const timer of scheduledBeforeStaleCheck) {
      if (!timer.active) continue;
      timer.active = false;
      timer.callback();
    }

    expect(first.snapshot().status).toBe('FALLBACK_POLLING');
    expect(firstStatuses.at(-1)).toEqual({
      status: 'FALLBACK_POLLING',
      reason: 'STREAM_STALE',
    });
    first.stop();

    const secondStatuses: Array<{ status: string; reason: string }> = [];
    const second = createAiChartPublicStreamClient({
      market: 'UPBIT',
      symbol: 'STALEGUARD',
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

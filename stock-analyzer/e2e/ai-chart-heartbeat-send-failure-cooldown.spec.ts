import { expect, test } from '@playwright/test';
import { createAiChartPublicStreamClient } from '../src/lib/ai-chart-public-stream-client';

type EventHandler = ((event: Event) => void) | null;
type MessageHandler = ((event: MessageEvent) => void) | null;
type CloseHandler = ((event: CloseEvent) => void) | null;
type TimerHandle = ReturnType<typeof setTimeout>;

class HeartbeatSendFailureSocketFake {
  static instances: HeartbeatSendFailureSocketFake[] = [];

  readyState = 0;
  binaryType: BinaryType = 'blob';
  onopen: EventHandler = null;
  onmessage: MessageHandler = null;
  onerror: EventHandler = null;
  onclose: CloseHandler = null;
  sendCount = 0;

  constructor(_url: string) {
    HeartbeatSendFailureSocketFake.instances.push(this);
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sendCount += 1;
    if (this.sendCount > 1) throw new Error('fixture heartbeat send failure');
  }

  close(_code?: number, _reason?: string): void {
    throw new Error('fixture close failure');
  }
}

test('heartbeat send failure keeps recreated default stream clients on bounded REST fallback', () => {
  const originalWebSocket = globalThis.WebSocket;
  let nextTimer = 1;
  const timers = new Map<TimerHandle, () => void>();
  const setTimeoutFn = (callback: () => void, _delayMs: number): TimerHandle => {
    const handle = nextTimer++ as unknown as TimerHandle;
    timers.set(handle, callback);
    return handle;
  };
  const clearTimeoutFn = (handle: TimerHandle): void => {
    timers.delete(handle);
  };
  const runNextTimer = (): void => {
    const next = timers.entries().next();
    expect(next.done).toBe(false);
    const [handle, callback] = next.value as [TimerHandle, () => void];
    timers.delete(handle);
    callback();
  };

  try {
    HeartbeatSendFailureSocketFake.instances = [];
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: HeartbeatSendFailureSocketFake,
    });

    const currentNow = 19_000;
    const firstStatuses: Array<{ status: string; reason: string }> = [];
    const first = createAiChartPublicStreamClient({
      market: 'BITGET',
      symbol: 'HEARTBEATGUARD',
      now: () => currentNow,
      setTimeoutFn,
      clearTimeoutFn,
      onTrade: () => {},
      onStatus: (status, reason) => firstStatuses.push({ status, reason }),
    });

    first.start();
    expect(HeartbeatSendFailureSocketFake.instances).toHaveLength(1);
    const firstSocket = HeartbeatSendFailureSocketFake.instances[0];
    firstSocket.onopen?.({} as Event);
    expect(firstSocket.sendCount).toBe(1);

    runNextTimer();

    expect(first.snapshot().status).toBe('FALLBACK_POLLING');
    expect(firstStatuses.at(-1)).toEqual({
      status: 'FALLBACK_POLLING',
      reason: 'HEARTBEAT_SEND_FAILED',
    });
    first.stop();

    const secondStatuses: Array<{ status: string; reason: string }> = [];
    const second = createAiChartPublicStreamClient({
      market: 'BITGET',
      symbol: 'HEARTBEATGUARD',
      now: () => currentNow,
      setTimeoutFn,
      clearTimeoutFn,
      onTrade: () => {},
      onStatus: (status, reason) => secondStatuses.push({ status, reason }),
    });

    second.start();
    expect(HeartbeatSendFailureSocketFake.instances).toHaveLength(1);
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

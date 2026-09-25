import { expect, test } from '@playwright/test';
import { createAiChartPublicStreamClient } from '../src/lib/ai-chart-public-stream-client';

type EventHandler = ((event: Event) => void) | null;
type MessageHandler = ((event: MessageEvent) => void) | null;
type CloseHandler = ((event: CloseEvent) => void) | null;
type TimerHandle = ReturnType<typeof setTimeout>;

class BinaryTypeFailureSocketFake {
  readyState = 0;
  onopen: EventHandler = null;
  onmessage: MessageHandler = null;
  onerror: EventHandler = null;
  onclose: CloseHandler = null;
  closeCount = 0;
  sendCount = 0;

  get binaryType(): BinaryType {
    return 'blob';
  }

  set binaryType(_value: BinaryType) {
    throw new Error('fixture binary type setup failure');
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

test('binary type setup exception cannot escape start and fails closed before timer ownership', () => {
  const socket = new BinaryTypeFailureSocketFake();
  let scheduledTimers = 0;
  const activeTimers = new Set<TimerHandle>();
  const statuses: Array<{ status: string; reason: string }> = [];

  const client = createAiChartPublicStreamClient({
    market: 'BITGET',
    symbol: 'BTCUSDT',
    now: () => 75_000,
    socketFactory: () => socket,
    setTimeoutFn: (_callback, _delayMs) => {
      scheduledTimers += 1;
      const handle = scheduledTimers as unknown as TimerHandle;
      activeTimers.add(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => { activeTimers.delete(handle); },
    requestAnimationFrameFn: () => 1,
    cancelAnimationFrameFn: () => undefined,
    onStatus: (status, reason) => { statuses.push({ status, reason }); },
    onTrades: () => true,
  });

  expect(() => client.start()).not.toThrow();
  expect(scheduledTimers).toBe(0);
  expect(activeTimers.size).toBe(0);
  expect(socket.sendCount).toBe(0);
  expect(socket.closeCount).toBe(1);
  expect(statuses).toEqual([
    { status: 'CONNECTING', reason: 'CONNECTING' },
    { status: 'FALLBACK_POLLING', reason: 'PROTOCOL_FAILURE' },
  ]);
  expect(client.snapshot()).toMatchObject({
    status: 'FALLBACK_POLLING',
    reason: 'PROTOCOL_FAILURE',
    connectedAtMs: null,
    reconnectAttempts: 0,
    pendingEvents: 0,
    pendingRenderWork: 0,
  });
});

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

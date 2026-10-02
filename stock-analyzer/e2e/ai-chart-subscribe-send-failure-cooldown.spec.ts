import { expect, test } from '@playwright/test';
import { createAiChartPublicStreamClient } from '../src/lib/ai-chart-public-stream-client';

type EventHandler = ((event: Event) => void) | null;
type MessageHandler = ((event: MessageEvent) => void) | null;
type CloseHandler = ((event: CloseEvent) => void) | null;

class SubscribeSendFailureSocketFake {
  static instances: SubscribeSendFailureSocketFake[] = [];

  readyState = 0;
  binaryType: BinaryType = 'blob';
  onopen: EventHandler = null;
  onmessage: MessageHandler = null;
  onerror: EventHandler = null;
  onclose: CloseHandler = null;

  constructor(_url: string) {
    SubscribeSendFailureSocketFake.instances.push(this);
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    throw new Error('fixture subscribe send failure');
  }

  close(_code?: number, _reason?: string): void {}
}

test('subscribe send failure keeps recreated default stream clients on bounded REST fallback', () => {
  const originalWebSocket = globalThis.WebSocket;

  try {
    SubscribeSendFailureSocketFake.instances = [];
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: SubscribeSendFailureSocketFake,
    });

    const currentNow = 9_000;
    const firstStatuses: Array<{ status: string; reason: string }> = [];
    const first = createAiChartPublicStreamClient({
      market: 'BITGET',
      symbol: 'SUBFAILGUARD',
      now: () => currentNow,
      onTrade: () => {},
      onStatus: (status, reason) => firstStatuses.push({ status, reason }),
    });

    first.start();
    expect(SubscribeSendFailureSocketFake.instances).toHaveLength(1);
    const firstSocket = SubscribeSendFailureSocketFake.instances[0];
    firstSocket.onopen?.({} as Event);

    expect(first.snapshot().status).toBe('FALLBACK_POLLING');
    expect(firstStatuses.at(-1)).toEqual({
      status: 'FALLBACK_POLLING',
      reason: 'SUBSCRIBE_SEND_FAILED',
    });
    first.stop();

    const secondStatuses: Array<{ status: string; reason: string }> = [];
    const second = createAiChartPublicStreamClient({
      market: 'BITGET',
      symbol: 'SUBFAILGUARD',
      now: () => currentNow,
      onTrade: () => {},
      onStatus: (status, reason) => secondStatuses.push({ status, reason }),
    });

    second.start();
    expect(SubscribeSendFailureSocketFake.instances).toHaveLength(1);
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

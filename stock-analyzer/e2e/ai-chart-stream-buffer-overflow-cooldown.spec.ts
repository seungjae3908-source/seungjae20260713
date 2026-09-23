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

test('buffer overflow keeps recreated default stream clients on bounded REST fallback', () => {
  const originalWebSocket = globalThis.WebSocket;

  try {
    DefaultSocketFake.instances = [];
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: DefaultSocketFake,
    });

    const currentNow = 5_000;
    const firstStatuses: Array<{ status: string; reason: string }> = [];
    const first = createAiChartPublicStreamClient({
      market: 'BITGET',
      symbol: 'BUFFERGUARD',
      now: () => currentNow,
      maxPendingEvents: 2,
      onTrade: () => {},
      onStatus: (status, reason) => firstStatuses.push({ status, reason }),
    });

    first.start();
    expect(DefaultSocketFake.instances).toHaveLength(1);
    const firstSocket = DefaultSocketFake.instances[0];
    firstSocket.onopen?.({} as Event);
    expect(first.snapshot().status).toBe('WAITING_FIRST_EVENT');

    firstSocket.onmessage?.({
      data: JSON.stringify({
        action: 'snapshot',
        arg: { instType: 'USDT-FUTURES', channel: 'trade', instId: 'BUFFERGUARD' },
        data: [
          { ts: '5000', price: '100', size: '1', side: 'buy', tradeId: 'overflow-1' },
          { ts: '5001', price: '101', size: '1', side: 'buy', tradeId: 'overflow-2' },
          { ts: '5002', price: '102', size: '1', side: 'sell', tradeId: 'overflow-3' },
        ],
      }),
    } as MessageEvent);

    expect(first.snapshot().status).toBe('FALLBACK_POLLING');
    expect(first.snapshot().pendingEvents).toBe(0);
    expect(firstStatuses.at(-1)).toEqual({
      status: 'FALLBACK_POLLING',
      reason: 'STREAM_BUFFER_OVERFLOW',
    });
    first.stop();

    const secondStatuses: Array<{ status: string; reason: string }> = [];
    const second = createAiChartPublicStreamClient({
      market: 'BITGET',
      symbol: 'BUFFERGUARD',
      now: () => currentNow,
      onTrade: () => {},
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

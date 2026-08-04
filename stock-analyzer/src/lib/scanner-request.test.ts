import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api';

const emptyScan = {
  ok: true,
  cards: [],
  selected: [],
  supportedIndicators: [],
  fetchedAt: new Date(0).toISOString(),
  searchRunId: 'scan:test',
  timeframe: '1D',
  partial: false,
  timedOut: false,
  completedCount: 1,
  providerErrorCount: 0,
  timeoutCount: 0,
  scanned: 1,
  requestedCount: 1,
  elapsedMs: 1,
  dataState: 'complete' as const,
  message: 'complete',
};

test('api.scan forwards the TanStack AbortSignal to the real fetch request', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let receivedSignal: AbortSignal | null | undefined;

  globalThis.fetch = (async (_input, init) => {
    receivedSignal = init?.signal;
    return new Response(JSON.stringify(emptyScan), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await api.scan(['거래량 증가'], 'KR', { timeframe: '1D' }, controller.signal);
    assert.equal(receivedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api.scan rejects with AbortError when a screen transition cancels the request', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();

  globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    }, { once: true });
  })) as typeof fetch;

  try {
    const pending = api.scan(['거래량 증가'], 'KR', { timeframe: '1D' }, controller.signal);
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

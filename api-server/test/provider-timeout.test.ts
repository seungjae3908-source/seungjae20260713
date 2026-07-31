import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { fetchJson } from '../src/lib/http';
import {
  currentProviderSignal,
  reportProviderFallback,
  runWithProviderSignal,
} from '../src/lib/provider-context';

async function withSlowServer(
  operation: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
    }, 5_000);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('TEST_SERVER_ADDRESS_UNAVAILABLE');
  }
  try {
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('provider HTTP timeout aborts the underlying request', async () => {
  await withSlowServer(async (url) => {
    const startedAt = Date.now();
    await assert.rejects(
      fetchJson(url, { provider: 'test-provider', timeoutMs: 30 }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'ProviderError' &&
        error.message === 'timeout',
    );
    assert.ok(Date.now() - startedAt < 1_000);
  });
});

test('worker provider context propagates parent abort and is cleared', async () => {
  await withSlowServer(async (url) => {
    const controller = new AbortController();
    const pending = runWithProviderSignal(controller.signal, async () => {
      assert.equal(currentProviderSignal(), controller.signal);
      return fetchJson(url, {
        provider: 'test-provider',
        timeoutMs: 5_000,
      });
    });
    setTimeout(() => controller.abort(new Error('TEST_ABORT')), 30);
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'ProviderError' &&
        error.message === 'aborted',
    );
  });
  assert.equal(currentProviderSignal(), undefined);
});

test('worker provider context reports fallback without leaking outside', async () => {
  const controller = new AbortController();
  const fallbacks: string[] = [];
  await runWithProviderSignal(
    controller.signal,
    async () => {
      reportProviderFallback('TEST_PROVIDER_FALLBACK');
    },
    (code) => fallbacks.push(code),
  );
  reportProviderFallback('OUTSIDE_CONTEXT');
  assert.deepEqual(fallbacks, ['TEST_PROVIDER_FALLBACK']);
});

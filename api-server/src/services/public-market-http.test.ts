import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadMarketInformationCache,
  resetMarketInformationCacheForTests,
} from './public-market-http';

function abortError(): Error {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

test('cold market cache loads isolate cancellation between concurrent requests', async () => {
  resetMarketInformationCacheForTests();
  const controller = new AbortController();
  let firstCalls = 0;
  let secondCalls = 0;

  const first = loadMarketInformationCache('race:cold', 60_000, 60_000, async () => {
    firstCalls += 1;
    return new Promise<string>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(abortError());
        return;
      }
      controller.signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  });

  await Promise.resolve();

  const second = loadMarketInformationCache('race:cold', 60_000, 60_000, async () => {
    secondCalls += 1;
    return 'second-request-value';
  });
  const secondSettled = second.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  controller.abort();

  await assert.rejects(
    first,
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );

  const secondResult = await secondSettled;
  if (!secondResult.ok) throw secondResult.error;
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.value.value, 'second-request-value');
  assert.equal(secondResult.value.stale, false);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);

  let unexpectedReloads = 0;
  const cached = await loadMarketInformationCache('race:cold', 60_000, 60_000, async () => {
    unexpectedReloads += 1;
    return 'unexpected';
  });
  assert.equal(cached.value, 'second-request-value');
  assert.equal(cached.stale, false);
  assert.equal(unexpectedReloads, 0);
});

test('market cache returns explicit last-good stale data when a cold refresh fails', async () => {
  resetMarketInformationCacheForTests();
  const first = await loadMarketInformationCache('fallback:last-good', 0, 0, async () => 'last-good');
  assert.equal(first.value, 'last-good');
  assert.equal(first.stale, false);

  const fallback = await loadMarketInformationCache('fallback:last-good', 0, 0, async () => {
    throw new Error('provider unavailable');
  });
  assert.equal(fallback.value, 'last-good');
  assert.equal(fallback.stale, true);
});

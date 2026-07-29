import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LastGoodCache,
  OperationTimeoutError,
  SingleFlight,
  mapWithConcurrency,
  withTimeout,
} from '../src/lib/async-control';

test('withTimeout returns a completed operation', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 100), 'ok');
});

test('withTimeout rejects a slow operation with a typed error', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => undefined), 10, 'slow search'),
    (error) =>
      error instanceof OperationTimeoutError &&
      error.code === 'OPERATION_TIMEOUT' &&
      error.timeoutMs === 10,
  );
});

test('SingleFlight coalesces callers using the same key', async () => {
  const flights = new SingleFlight<string, number>();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 42;
  };

  const [first, second] = await Promise.all([
    flights.run('same', loader),
    flights.run('same', loader),
  ]);

  assert.equal(first, 42);
  assert.equal(second, 42);
  assert.equal(calls, 1);
  assert.equal(flights.size, 0);
});

test('LastGoodCache respects the maximum age', () => {
  const cache = new LastGoodCache<string, string>();
  cache.set('query', 'saved', 1_000);

  assert.equal(cache.get('query', 500, 1_400)?.value, 'saved');
  assert.equal(cache.get('query', 500, 1_501), null);
});

test('mapWithConcurrency preserves result order and failures', async () => {
  const results = await mapWithConcurrency([1, 2, 3], 2, async (value) => {
    if (value === 2) throw new Error('expected');
    return value * 10;
  });

  assert.deepEqual(results[0], { status: 'fulfilled', value: 10 });
  assert.equal(results[1].status, 'rejected');
  assert.deepEqual(results[2], { status: 'fulfilled', value: 30 });
});

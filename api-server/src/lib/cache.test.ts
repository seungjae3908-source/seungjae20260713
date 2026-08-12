import assert from 'node:assert/strict';
import test from 'node:test';
import { cached } from './cache';

function uniqueKey(label: string): string {
  return `cache-test:${label}:${Date.now()}:${Math.random()}`;
}

test('cached shares one loader across concurrent misses for the same key', async () => {
  const key = uniqueKey('single-flight');
  let calls = 0;

  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { ok: true, value: 42 };
  };

  const results = await Promise.all(
    Array.from({ length: 20 }, () => cached(key, 1_000, loader)),
  );

  assert.equal(calls, 1);
  assert.equal(results.length, 20);
  assert.ok(results.every((result) => result.ok && result.value === 42));
});

test('cached keeps the completed value hot without calling the loader again', async () => {
  const key = uniqueKey('hot-hit');
  let calls = 0;

  const first = await cached(key, 1_000, async () => {
    calls += 1;
    return 'ready';
  });
  const second = await cached(key, 1_000, async () => {
    calls += 1;
    return 'unexpected';
  });

  assert.equal(first, 'ready');
  assert.equal(second, 'ready');
  assert.equal(calls, 1);
});

test('cached does not retain failed loaders and allows a later retry', async () => {
  const key = uniqueKey('retry-after-error');
  let calls = 0;

  await assert.rejects(
    cached(key, 1_000, async () => {
      calls += 1;
      throw new Error('temporary upstream failure');
    }),
    /temporary upstream failure/,
  );

  const result = await cached(key, 1_000, async () => {
    calls += 1;
    return 'recovered';
  });

  assert.equal(result, 'recovered');
  assert.equal(calls, 2);
});

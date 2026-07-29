import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cached,
  getMemoryCacheDiagnostics,
  resetMemoryCacheForTests,
} from '../src/lib/cache';

test('memory cache coalesces pending loaders and removes completed flights', async () => {
  resetMemoryCacheForTests();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true };
  };

  const [first, second] = await Promise.all([
    cached('same', 60_000, loader),
    cached('same', 60_000, loader),
  ]);

  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
  assert.equal(calls, 1);
  assert.equal(getMemoryCacheDiagnostics().pendingLoads, 0);
});

test('memory cache evicts oldest entries at the configured maximum', async () => {
  resetMemoryCacheForTests();
  const previous = process.env.MEMORY_CACHE_MAX_ENTRIES;
  process.env.MEMORY_CACHE_MAX_ENTRIES = '100';

  try {
    for (let index = 0; index < 101; index += 1) {
      await cached(`bounded:${index}`, 60_000, async () => index);
    }

    const diagnostics = getMemoryCacheDiagnostics();
    assert.equal(diagnostics.entries, 100);
    assert.equal(diagnostics.maxEntries, 100);
    assert.equal(diagnostics.evicted, 1);
    assert.equal(diagnostics.namespaceEntries.bounded, 100);
    assert.ok(diagnostics.estimatedBytes > 0);
    assert.equal(
      diagnostics.namespaceEstimatedBytes.bounded,
      diagnostics.estimatedBytes,
    );
  } finally {
    if (previous == null) delete process.env.MEMORY_CACHE_MAX_ENTRIES;
    else process.env.MEMORY_CACHE_MAX_ENTRIES = previous;
    resetMemoryCacheForTests();
  }
});

test('expired memory entries are removed before reloading', async () => {
  resetMemoryCacheForTests();
  let calls = 0;
  await cached('expiring', 1, async () => {
    calls += 1;
    return calls;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const value = await cached('expiring', 1, async () => {
    calls += 1;
    return calls;
  });

  assert.equal(value, 2);
  assert.equal(calls, 2);
  assert.ok(getMemoryCacheDiagnostics().expiredDeleted >= 1);
  resetMemoryCacheForTests();
});

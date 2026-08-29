import { expect, test } from '@playwright/test';
import { BoundedTtlCache } from '../../api-server/src/lib/bounded-ttl-cache';

test('server live-data cache never exceeds its hard capacity and evicts least-recently-used live entries', async () => {
  let now = 1_000;
  const cache = new BoundedTtlCache(3, () => now);
  let loads = 0;
  const load = async (value: string) => {
    loads += 1;
    return value;
  };

  await cache.getOrLoad('a', 10_000, () => load('A'));
  await cache.getOrLoad('b', 10_000, () => load('B'));
  await cache.getOrLoad('c', 10_000, () => load('C'));
  expect(cache.size).toBe(3);

  // A cache hit refreshes recency without extending TTL.
  expect(await cache.getOrLoad('a', 10_000, () => load('A2'))).toBe('A');
  expect(loads).toBe(3);

  await cache.getOrLoad('d', 10_000, () => load('D'));
  expect(cache.size).toBe(3);
  expect(cache.keys()).toEqual(['c', 'a', 'd']);

  // B was the least-recently-used live entry and must be loaded again.
  expect(await cache.getOrLoad('b', 10_000, () => load('B2'))).toBe('B2');
  expect(loads).toBe(5);
  expect(cache.size).toBe(3);
});

test('cache hits refresh recency without extending the original TTL', async () => {
  let now = 1_000;
  const cache = new BoundedTtlCache(2, () => now);
  let loads = 0;
  const load = async () => {
    loads += 1;
    return `value-${loads}`;
  };

  expect(await cache.getOrLoad('a', 100, load)).toBe('value-1');
  now = 1_050;

  // A hit may move the entry to the MRU position, but the caller's new TTL
  // must not replace the original expiry at t=1_100.
  expect(await cache.getOrLoad('a', 10_000, load)).toBe('value-1');
  expect(loads).toBe(1);

  now = 1_101;
  expect(await cache.getOrLoad('a', 10_000, load)).toBe('value-2');
  expect(loads).toBe(2);
});

test('expired entries are removed before capacity eviction and failed loaders are never cached', async () => {
  let now = 10_000;
  const cache = new BoundedTtlCache(2, () => now);

  await cache.getOrLoad('short', 50, async () => 'short-lived');
  await cache.getOrLoad('long', 10_000, async () => 'long-lived');
  now += 51;

  await cache.getOrLoad('fresh', 10_000, async () => 'fresh');
  expect(cache.keys()).toEqual(['long', 'fresh']);
  expect(cache.size).toBe(2);

  await expect(cache.getOrLoad('failure', 10_000, async () => {
    throw new Error('provider failed');
  })).rejects.toThrow('provider failed');
  expect(cache.keys()).toEqual(['long', 'fresh']);
});

test('invalid capacity fails closed', () => {
  expect(() => new BoundedTtlCache(0)).toThrow('BOUNDED_TTL_CACHE_MAX_ENTRIES_INVALID');
  expect(() => new BoundedTtlCache(Number.NaN)).toThrow('BOUNDED_TTL_CACHE_MAX_ENTRIES_INVALID');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BoundedWorkTimeoutError,
  runBoundedWorkPool,
} from './bounded-work-pool';
import {
  collectMarketListingWork,
  MARKET_LISTING_CONCURRENCY,
  MARKET_LISTING_DEADLINE_MS,
  MARKET_LISTING_ITEM_TIMEOUT_MS,
} from '../services/market-listing-work-pool';

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    }, { once: true });
  });
}

test('bounded worker pool completes normal work without exceeding concurrency', async () => {
  let active = 0;
  let observedMaximum = 0;
  const result = await runBoundedWorkPool(
    Array.from({ length: 9 }, (_, index) => index),
    async (item, _index, signal) => {
      active += 1;
      observedMaximum = Math.max(observedMaximum, active);
      try {
        await delay(12, signal);
        return item * 2;
      } finally {
        active -= 1;
      }
    },
    { concurrency: 3, deadlineMs: 500, itemTimeoutMs: 100 },
  );

  assert.equal(result.fulfilledCount, 9);
  assert.equal(result.rejectedCount, 0);
  assert.equal(result.timedOutCount, 0);
  assert.equal(result.deadlineReached, false);
  assert.equal(result.maxConcurrency, 3);
  assert.equal(observedMaximum, 3);
  assert.deepEqual(result.outcomes.map((item) => item.value), [0, 2, 4, 6, 8, 10, 12, 14, 16]);
});

test('per-item timeout is explicit and aborts the timed-out worker signal', async () => {
  let abortedSignals = 0;
  const result = await runBoundedWorkPool(
    [5, 120, 120],
    async (ms, _index, signal) => {
      signal.addEventListener('abort', () => {
        abortedSignals += 1;
      }, { once: true });
      await delay(ms, signal);
      return ms;
    },
    { concurrency: 2, deadlineMs: 200, itemTimeoutMs: 35 },
  );

  assert.equal(result.fulfilledCount, 1);
  assert.equal(result.timedOutCount, 2);
  assert.equal(result.rejectedCount, 0);
  assert.equal(abortedSignals, 2);
  assert.ok(result.outcomes.filter((item) => item.status === 'timed_out').every((item) => item.reason instanceof BoundedWorkTimeoutError));
});

test('global deadline prevents new work from starting after the budget is exhausted', async () => {
  const repetitions = 25;

  for (let iteration = 0; iteration < repetitions; iteration += 1) {
    let fakeNow = 0;
    const started: number[] = [];
    const result = await runBoundedWorkPool(
      Array.from({ length: 30 }, (_, index) => index),
      async (item) => {
        started.push(item);
        fakeNow += 40;
        return item;
      },
      {
        concurrency: 2,
        deadlineMs: 75,
        itemTimeoutMs: 60,
        now: () => fakeNow,
      },
    );

    assert.deepEqual(started, [0, 1]);
    assert.equal(result.deadlineReached, true);
    assert.equal(result.startedCount, 2);
    assert.ok(result.startedCount < 30);
    assert.equal(started.length, result.startedCount);
    assert.equal(result.maxConcurrency, 2);
  }
});

test('provider rejections remain distinct from timeouts', async () => {
  const result = await runBoundedWorkPool(
    ['ok', 'provider-error'],
    async (item) => {
      if (item === 'provider-error') throw new Error('provider unavailable');
      return item;
    },
    { concurrency: 2, deadlineMs: 200, itemTimeoutMs: 100 },
  );

  assert.equal(result.fulfilledCount, 1);
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.timedOutCount, 0);
});

test('external abort stops new work and aborts active workers', async () => {
  const controller = new AbortController();
  const started: number[] = [];
  const promise = runBoundedWorkPool(
    Array.from({ length: 20 }, (_, index) => index),
    async (item, _index, signal) => {
      started.push(item);
      await delay(100, signal);
      return item;
    },
    { concurrency: 3, deadlineMs: 500, itemTimeoutMs: 300, signal: controller.signal },
  );

  setTimeout(() => controller.abort(new Error('client disconnected')), 20);
  const result = await promise;
  assert.equal(result.aborted, true);
  assert.ok(result.startedCount <= 3);
  assert.ok(started.length <= 3);
});

test('market listing work collector preserves full results under bounded concurrency', async () => {
  let active = 0;
  let observedMaximum = 0;
  const result = await collectMarketListingWork(
    Array.from({ length: 12 }, (_, index) => index),
    async (item, _index, signal) => {
      active += 1;
      observedMaximum = Math.max(observedMaximum, active);
      try {
        await delay(8, signal);
        return item * 3;
      } finally {
        active -= 1;
      }
    },
    { concurrency: 3, deadlineMs: 500, itemTimeoutMs: 100 },
  );

  assert.deepEqual(result.values, [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33]);
  assert.equal(result.diagnostics.status, 'complete');
  assert.equal(result.diagnostics.candidateCount, 12);
  assert.equal(result.diagnostics.unstartedCount, 0);
  assert.equal(result.diagnostics.unusableCount, 0);
  assert.equal(result.diagnostics.maxConcurrency, 3);
  assert.equal(observedMaximum, 3);
});

test('market listing work collector marks fulfilled unusable provider outcomes as partial without fabricating rows', async () => {
  const result = await collectMarketListingWork(
    ['ok', 'missing', 'provider-error'],
    async (item) => {
      try {
        if (item === 'provider-error') throw new Error('provider unavailable');
        if (item === 'missing') return null;
        return item;
      } catch {
        return null;
      }
    },
    { concurrency: 3, deadlineMs: 200, itemTimeoutMs: 100 },
  );

  const usable = result.values.filter((value): value is string => value !== null);
  assert.deepEqual(usable, ['ok']);
  assert.equal(result.diagnostics.status, 'partial');
  assert.equal(result.diagnostics.fulfilledCount, 3);
  assert.equal(result.diagnostics.rejectedCount, 0);
  assert.equal(result.diagnostics.timedOutCount, 0);
  assert.equal(result.diagnostics.unusableCount, 2);
  assert.equal(result.values.length, 3);
});

test('market listing work collector reports deadline-limited data as partial without fabricated values', async () => {
  const result = await collectMarketListingWork(
    Array.from({ length: 40 }, (_, index) => index),
    async (item, _index, signal) => {
      await delay(80, signal);
      return item;
    },
    { concurrency: 2, deadlineMs: 35, itemTimeoutMs: 30 },
  );

  assert.equal(result.diagnostics.status, 'partial');
  assert.equal(result.diagnostics.deadlineReached, true);
  assert.ok(result.diagnostics.timedOutCount > 0);
  assert.ok(result.diagnostics.unstartedCount > 0);
  assert.equal(result.diagnostics.unusableCount, 0);
  assert.equal(result.values.length, 0);
  assert.ok(result.diagnostics.maxConcurrency <= 2);
});

test('default market listing budgets keep stalled work at the pool concurrency ceiling', () => {
  assert.ok(MARKET_LISTING_CONCURRENCY > 0);
  assert.ok(MARKET_LISTING_CONCURRENCY <= 8);
  assert.ok(MARKET_LISTING_ITEM_TIMEOUT_MS > 0);
  assert.equal(MARKET_LISTING_ITEM_TIMEOUT_MS, MARKET_LISTING_DEADLINE_MS);
  assert.ok(MARKET_LISTING_DEADLINE_MS <= 6_000);
});

test('market movers surfaces bounded listing completeness instead of hiding partial evidence', () => {
  const routeSource = readFileSync(
    path.resolve(process.cwd(), 'api-server/src/routes/market.ts'),
    'utf8',
  );
  const listingSource = readFileSync(
    path.resolve(process.cwd(), 'api-server/src/services/market-listing.service.ts'),
    'utf8',
  );

  assert.match(routeSource, /liveListingsWithDiagnostics/);
  assert.match(routeSource, /dataStatus:\s*live\.diagnostics\.status/);
  assert.match(routeSource, /listingDiagnostics/);
  assert.match(routeSource, /failedMarkets/);
  assert.match(listingSource, /collectMarketListingWork\(\s*candidates/);
  assert.doesNotMatch(listingSource, /Promise\.all\(candidates\.map\(toRow\)\)/);
});

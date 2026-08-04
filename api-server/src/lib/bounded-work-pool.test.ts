import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoundedWorkTimeoutError,
  runBoundedWorkPool,
} from './bounded-work-pool';

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
  const started: number[] = [];
  const result = await runBoundedWorkPool(
    Array.from({ length: 30 }, (_, index) => index),
    async (item, _index, signal) => {
      started.push(item);
      await delay(28, signal);
      return item;
    },
    { concurrency: 2, deadlineMs: 75, itemTimeoutMs: 60 },
  );

  assert.equal(result.deadlineReached, true);
  assert.ok(result.startedCount < 30);
  assert.equal(started.length, result.startedCount);
  assert.ok(result.maxConcurrency <= 2);
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

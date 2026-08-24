import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BoundedWorkTimeoutError,
  runBoundedWorkPool,
} from './bounded-work-pool';
import {
  ProviderAdmissionControl,
  ProviderAdmissionError,
  type ProviderAdmissionIdentity,
} from './provider-admission-control';
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

function admissionIdentity(
  provider = 'test-provider',
  domain = 'provider.test',
  operationClass = 'test-work',
): ProviderAdmissionIdentity {
  return { provider, domain, operationClass };
}

function admissionControl(options: Partial<{
  globalCapacity: number;
  providerCapacity: number;
  timeoutThreshold: number;
  cooldownMs: number;
  now: () => number;
}> = {}): ProviderAdmissionControl {
  return new ProviderAdmissionControl({
    globalCapacity: options.globalCapacity ?? 4,
    providerCapacity: options.providerCapacity ?? 2,
    timeoutThreshold: options.timeoutThreshold,
    cooldownMs: options.cooldownMs ?? 20,
    now: options.now,
  });
}

async function flushSettlements(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
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

test('timed-out lanes are not reused while non-cooperative work is still running', async () => {
  const started: number[] = [];
  const releases: Array<() => void> = [];
  let active = 0;
  let observedMaximum = 0;

  const result = await runBoundedWorkPool(
    [0, 1, 2, 3, 4],
    async (item) => {
      started.push(item);
      active += 1;
      observedMaximum = Math.max(observedMaximum, active);
      try {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return item;
      } finally {
        active -= 1;
      }
    },
    { concurrency: 2, deadlineMs: 200, itemTimeoutMs: 25 },
  );

  try {
    assert.deepEqual(started, [0, 1]);
    assert.equal(result.startedCount, 2);
    assert.equal(result.timedOutCount, 2);
    assert.equal(result.fulfilledCount, 0);
    assert.equal(result.rejectedCount, 0);
    assert.equal(result.deadlineReached, true);
    assert.equal(result.maxConcurrency, 2);
    assert.equal(observedMaximum, 2);
    assert.equal(active, 2);
    assert.deepEqual(result.outcomes.map((item) => item.index), [0, 1]);
  } finally {
    for (const release of releases) release();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(active, 0);
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

test('process-wide admission bounds repeated independent pools and drains late resolves', async () => {
  const control = admissionControl({ timeoutThreshold: 2, cooldownMs: 100 });
  const identity = admissionIdentity('scanner', 'kr', 'asset-scan');
  const releases: Array<() => void> = [];
  const physicalAfterEachPool: number[] = [];
  let physicalActive = 0;
  let physicalHighWater = 0;

  const runPool = () => runBoundedWorkPool(
    [0, 1],
    async () => {
      physicalActive += 1;
      physicalHighWater = Math.max(physicalHighWater, physicalActive);
      try {
        await new Promise<void>((resolve) => releases.push(resolve));
      } finally {
        physicalActive -= 1;
      }
    },
    {
      concurrency: 2,
      deadlineMs: 40,
      itemTimeoutMs: 10,
      admission: { control, identity },
    },
  );

  const results = [];
  for (let index = 0; index < 3; index += 1) {
    results.push(await runPool());
    physicalAfterEachPool.push(control.snapshot().physicalOutstanding);
  }

  assert.deepEqual(physicalAfterEachPool, [2, 2, 2]);
  assert.equal(physicalHighWater, 2);
  assert.equal(results[0].timedOutCount, 2);
  assert.equal(results[1].rejectedCount, 2);
  assert.equal(results[2].rejectedCount, 2);
  assert.ok(
    [...results[1].outcomes, ...results[2].outcomes]
      .every((outcome) => outcome.reason instanceof ProviderAdmissionError
        && outcome.reason.code === 'CIRCUIT_OPEN'),
  );
  assert.equal(control.snapshot().timedOutOutstanding, 2);

  for (const release of releases) release();
  await flushSettlements();
  const drained = control.snapshot();
  assert.equal(drained.physicalOutstanding, 0);
  assert.equal(drained.timedOutOutstanding, 0);
  assert.equal(drained.lateSettledTotal, 2);
});

test('parallel requests creating separate pools share the configured provider capacity', async () => {
  const control = admissionControl({
    globalCapacity: 5,
    providerCapacity: 3,
    timeoutThreshold: 3,
  });
  const identity = admissionIdentity('scanner', 'us', 'asset-scan');
  const releases: Array<() => void> = [];
  let physicalActive = 0;
  let physicalHighWater = 0;

  const request = () => runBoundedWorkPool(
    [0, 1],
    async () => {
      physicalActive += 1;
      physicalHighWater = Math.max(physicalHighWater, physicalActive);
      try {
        await new Promise<void>((resolve) => releases.push(resolve));
      } finally {
        physicalActive -= 1;
      }
    },
    {
      concurrency: 2,
      deadlineMs: 50,
      itemTimeoutMs: 12,
      admission: { control, identity },
    },
  );

  const results = await Promise.all([request(), request(), request(), request()]);
  assert.equal(physicalHighWater, 3);
  assert.equal(control.snapshot().physicalOutstanding, 3);
  assert.equal(control.snapshot().physicalOutstandingHighWater, 3);
  assert.equal(control.snapshot().providers[0]?.physicalOutstandingHighWater, 3);
  assert.equal(results.reduce((sum, result) => sum + result.timedOutCount, 0), 3);
  assert.ok(results.reduce((sum, result) => sum + result.rejectedCount, 0) >= 1);

  for (const release of releases) release();
  await flushSettlements();
  assert.equal(control.snapshot().physicalOutstanding, 0);
});

test('a permanently hung provider remains observable while another provider domain stays available', async () => {
  const control = admissionControl({ timeoutThreshold: 2, cooldownMs: 100 });
  const hungIdentity = admissionIdentity('public-market', 'hung.example', 'quote');
  const healthyIdentity = admissionIdentity('public-market', 'healthy.example', 'quote');
  let healthyActive = 0;
  let healthyHighWater = 0;

  const hung = await runBoundedWorkPool(
    [0, 1],
    async () => new Promise<void>(() => undefined),
    {
      concurrency: 2,
      deadlineMs: 40,
      itemTimeoutMs: 10,
      admission: { control, identity: hungIdentity },
    },
  );
  const healthy = await runBoundedWorkPool(
    [0, 1, 2, 3],
    async (item, _index, signal) => {
      healthyActive += 1;
      healthyHighWater = Math.max(healthyHighWater, healthyActive);
      try {
        await delay(2, signal);
        return item;
      } finally {
        healthyActive -= 1;
      }
    },
    {
      concurrency: 2,
      deadlineMs: 100,
      itemTimeoutMs: 30,
      admission: { control, identity: healthyIdentity },
    },
  );

  assert.equal(hung.timedOutCount, 2);
  assert.equal(healthy.fulfilledCount, 4);
  assert.equal(healthyHighWater, 2);
  const snapshot = control.snapshot();
  assert.equal(snapshot.physicalOutstanding, 2);
  const hungProvider = snapshot.providers.find((item) => item.domain === 'hung.example');
  const healthyProvider = snapshot.providers.find((item) => item.domain === 'healthy.example');
  assert.equal(hungProvider?.circuitState, 'open');
  assert.equal(hungProvider?.timedOutOutstanding, 2);
  assert.equal(healthyProvider?.circuitState, 'closed');
  assert.equal(healthyProvider?.physicalOutstanding, 0);
});

test('capacity exhaustion is synchronous and never queues new work', async () => {
  const control = admissionControl();
  const identity = admissionIdentity('scanner', 'kr', 'quote');
  const releases: Array<() => void> = [];
  let rejectedTaskStarted = false;
  const first = control.start(identity, () => new Promise<void>((resolve) => releases.push(resolve)));
  const second = control.start(identity, () => new Promise<void>((resolve) => releases.push(resolve)));

  assert.throws(
    () => control.start(identity, async () => { rejectedTaskStarted = true; }),
    (error: unknown) => error instanceof ProviderAdmissionError
      && error.code === 'CAPACITY_EXHAUSTED',
  );
  assert.equal(rejectedTaskStarted, false);
  assert.equal(control.snapshot().rejectedCapacityTotal, 1);

  await Promise.resolve();
  for (const release of releases) release();
  await Promise.all([first.task, second.task]);
  first.lease.markCompleted();
  second.lease.markCompleted();
  assert.equal(control.snapshot().physicalOutstanding, 0);
});

test('circuit opens on a full timed-out partition and a bounded half-open success recovers it', async () => {
  let fakeNow = 0;
  const control = admissionControl({
    timeoutThreshold: 2,
    cooldownMs: 100,
    now: () => fakeNow,
  });
  const identity = admissionIdentity('scanner', 'kr', 'quote');
  const releases: Array<() => void> = [];
  const timedOut = await runBoundedWorkPool(
    [0, 1],
    async () => new Promise<void>((resolve) => releases.push(resolve)),
    {
      concurrency: 2,
      deadlineMs: 40,
      itemTimeoutMs: 10,
      admission: { control, identity },
    },
  );

  assert.equal(timedOut.timedOutCount, 2);
  assert.equal(control.snapshot().providers[0]?.circuitState, 'open');
  assert.equal(control.snapshot().circuitTripTotal, 1);
  assert.throws(
    () => control.start(identity, async () => undefined),
    (error: unknown) => error instanceof ProviderAdmissionError
      && error.code === 'CIRCUIT_OPEN',
  );

  for (const release of releases) release();
  await flushSettlements();
  fakeNow = 100;
  const probe = control.start(identity, async () => 'recovered');
  assert.equal(await probe.task, 'recovered');
  probe.lease.markCompleted();
  const recovered = control.snapshot();
  assert.equal(recovered.providers[0]?.circuitState, 'closed');
  assert.equal(recovered.physicalOutstanding, 0);
});

test('late provider rejection is handled without process-level rejection or exception leakage', async () => {
  const control = admissionControl({ timeoutThreshold: 1 });
  const identity = admissionIdentity('scanner', 'kr', 'late-reject');
  let rejectLate!: (reason: Error) => void;
  let unhandledRejections = 0;
  let uncaughtExceptions = 0;
  const onUnhandled = () => { unhandledRejections += 1; };
  const onUncaught = () => { uncaughtExceptions += 1; };
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUncaught);

  try {
    const result = await runBoundedWorkPool(
      [0],
      async () => new Promise<void>((_resolve, reject) => { rejectLate = reject; }),
      {
        concurrency: 1,
        deadlineMs: 40,
        itemTimeoutMs: 10,
        admission: { control, identity },
      },
    );
    assert.equal(result.timedOutCount, 1);
    rejectLate(new Error('late provider rejection'));
    await flushSettlements();
    assert.equal(unhandledRejections, 0);
    assert.equal(uncaughtExceptions, 0);
    assert.equal(control.snapshot().lateSettledTotal, 1);
    assert.equal(control.snapshot().physicalOutstanding, 0);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    process.removeListener('uncaughtException', onUncaught);
  }
});

test('mixed cooperative and non-cooperative work preserves fast progress and eventual drain', async () => {
  const control = admissionControl({
    globalCapacity: 7,
    providerCapacity: 5,
    timeoutThreshold: 5,
  });
  const identity = admissionIdentity('mixed-provider', 'mixed.test', 'mixed-work');
  let releaseLateResolve!: () => void;
  let rejectLate!: (reason: Error) => void;
  const completed: string[] = [];
  let physicalActive = 0;
  let physicalHighWater = 0;
  const work = await runBoundedWorkPool(
    ['fast', 'slow', 'cooperative-timeout', 'late-resolve', 'late-reject'],
    async (item, _index, signal) => {
      physicalActive += 1;
      physicalHighWater = Math.max(physicalHighWater, physicalActive);
      try {
        if (item === 'fast') {
          completed.push(item);
          return item;
        }
        if (item === 'slow') {
          await delay(5, signal);
          completed.push(item);
          return item;
        }
        if (item === 'cooperative-timeout') {
          await delay(100, signal);
          return item;
        }
        if (item === 'late-resolve') {
          await new Promise<void>((resolve) => { releaseLateResolve = resolve; });
          return item;
        }
        await new Promise<void>((_resolve, reject) => { rejectLate = reject; });
        return item;
      } finally {
        physicalActive -= 1;
      }
    },
    {
      concurrency: 3,
      deadlineMs: 100,
      itemTimeoutMs: 20,
      admission: { control, identity },
    },
  );

  assert.deepEqual(completed, ['fast', 'slow']);
  assert.equal(work.fulfilledCount, 2);
  assert.equal(work.timedOutCount, 3);
  assert.equal(physicalHighWater, 3);
  await flushSettlements();
  assert.equal(control.snapshot().physicalOutstanding, 2);
  assert.equal(control.snapshot().lateSettledTotal, 1);
  releaseLateResolve();
  rejectLate(new Error('late mixed rejection'));
  await flushSettlements();
  assert.equal(control.snapshot().physicalOutstanding, 0);
  assert.equal(control.snapshot().lateSettledTotal, 3);
});

test('outstanding age and timed-out physical work remain visible until the underlying task settles', async () => {
  let fakeNow = 100;
  const control = admissionControl({ timeoutThreshold: 1, now: () => fakeNow });
  const identity = admissionIdentity('scanner', 'kr', 'age-proof');
  let release!: () => void;
  const execution = control.start(
    identity,
    () => new Promise<void>((resolve) => { release = resolve; }),
  );

  await Promise.resolve();
  fakeNow = 145;
  assert.equal(control.snapshot().oldestOutstandingAgeMs, 45);
  assert.equal(control.snapshot().physicalOutstandingHighWater, 1);
  assert.equal(control.snapshot().providers[0]?.operations[0]?.physicalOutstandingHighWater, 1);
  execution.lease.markTimedOut();
  assert.equal(control.snapshot().timedOutOutstanding, 1);
  assert.equal(control.snapshot().physicalOutstanding, 1);
  release();
  await execution.task;
  await flushSettlements();
  const settled = control.snapshot();
  assert.equal(settled.oldestOutstandingAgeMs, 0);
  assert.equal(settled.timedOutOutstanding, 0);
  assert.equal(settled.physicalOutstanding, 0);
  assert.equal(settled.lateSettledTotal, 1);
});

test('caller abort is logically terminal while non-cooperative physical work remains observable', async () => {
  const control = admissionControl();
  const identity = admissionIdentity('scanner', 'kr', 'caller-abort');
  const caller = new AbortController();
  let release!: () => void;
  const promise = runBoundedWorkPool(
    [0],
    async () => new Promise<void>((resolve) => { release = resolve; }),
    {
      concurrency: 1,
      deadlineMs: 200,
      itemTimeoutMs: 150,
      signal: caller.signal,
      admission: { control, identity },
    },
  );

  setTimeout(() => caller.abort(new Error('caller disconnected')), 5);
  const result = await promise;
  assert.equal(result.aborted, true);
  assert.equal(result.rejectedCount, 1);
  assert.equal(control.snapshot().admittedActive, 0);
  assert.equal(control.snapshot().physicalOutstanding, 1);
  assert.equal(control.snapshot().timedOutOutstanding, 0);
  release();
  await flushSettlements();
  assert.equal(control.snapshot().physicalOutstanding, 0);
  assert.equal(control.snapshot().lateSettledTotal, 1);
});

test('fast provider work retains configured parallelism without capacity rejection', async () => {
  const control = admissionControl({
    globalCapacity: 12,
    providerCapacity: 6,
    timeoutThreshold: 6,
  });
  const identity = admissionIdentity('fast-provider', 'fast.test', 'quote');
  let active = 0;
  let highWater = 0;
  const result = await runBoundedWorkPool(
    Array.from({ length: 18 }, (_, index) => index),
    async (item, _index, signal) => {
      active += 1;
      highWater = Math.max(highWater, active);
      try {
        await delay(2, signal);
        return item;
      } finally {
        active -= 1;
      }
    },
    {
      concurrency: 6,
      deadlineMs: 200,
      itemTimeoutMs: 50,
      admission: { control, identity },
    },
  );

  assert.equal(result.fulfilledCount, 18);
  assert.equal(result.rejectedCount, 0);
  assert.equal(highWater, 6);
  assert.equal(control.snapshot().rejectedCapacityTotal, 0);
  assert.equal(control.snapshot().physicalOutstanding, 0);
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

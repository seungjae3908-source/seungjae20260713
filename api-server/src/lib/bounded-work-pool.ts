export type BoundedWorkStatus = 'fulfilled' | 'rejected' | 'timed_out';

export interface BoundedWorkOutcome<Result> {
  index: number;
  status: BoundedWorkStatus;
  value?: Result;
  reason?: unknown;
  elapsedMs: number;
}

export interface BoundedWorkPoolOptions {
  concurrency: number;
  deadlineMs: number;
  itemTimeoutMs: number;
  signal?: AbortSignal;
  now?: () => number;
}

export interface BoundedWorkPoolResult<Result> {
  outcomes: BoundedWorkOutcome<Result>[];
  startedCount: number;
  fulfilledCount: number;
  rejectedCount: number;
  timedOutCount: number;
  deadlineReached: boolean;
  aborted: boolean;
  elapsedMs: number;
  maxConcurrency: number;
}

export class BoundedWorkTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Bounded work item exceeded ${timeoutMs}ms`);
    this.name = 'BoundedWorkTimeoutError';
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

async function runWithTimeout<Result>(
  task: Promise<Result>,
  controller: AbortController,
  timeoutMs: number,
): Promise<Result> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(new BoundedWorkTimeoutError(timeoutMs));
          reject(new BoundedWorkTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runBoundedWorkPool<Item, Result>(
  items: readonly Item[],
  worker: (item: Item, index: number, signal: AbortSignal) => Promise<Result>,
  options: BoundedWorkPoolOptions,
): Promise<BoundedWorkPoolResult<Result>> {
  const concurrency = Math.min(
    positiveInteger(options.concurrency, 'concurrency'),
    Math.max(items.length, 1),
  );
  const deadlineMs = positiveInteger(options.deadlineMs, 'deadlineMs');
  const itemTimeoutMs = positiveInteger(options.itemTimeoutMs, 'itemTimeoutMs');
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadlineAt = startedAt + deadlineMs;
  const outcomes: BoundedWorkOutcome<Result>[] = [];
  const activeControllers = new Set<AbortController>();
  let nextIndex = 0;
  let activeCount = 0;
  let maxConcurrency = 0;

  const abortActive = () => {
    for (const controller of activeControllers) {
      if (!controller.signal.aborted) controller.abort(options.signal?.reason);
    }
  };
  options.signal?.addEventListener('abort', abortActive, { once: true });

  const takeNext = (): number | null => {
    if (options.signal?.aborted || nextIndex >= items.length || now() >= deadlineAt) {
      return null;
    }
    const index = nextIndex;
    nextIndex += 1;
    return index;
  };

  const runWorker = async () => {
    while (true) {
      const index = takeNext();
      if (index == null) return;

      const itemStartedAt = now();
      const remainingMs = Math.max(1, deadlineAt - itemStartedAt);
      const timeoutMs = Math.min(itemTimeoutMs, remainingMs);
      const controller = new AbortController();
      activeControllers.add(controller);
      activeCount += 1;
      maxConcurrency = Math.max(maxConcurrency, activeCount);

      try {
        const value = await runWithTimeout(
          worker(items[index], index, controller.signal),
          controller,
          timeoutMs,
        );
        outcomes.push({
          index,
          status: 'fulfilled',
          value,
          elapsedMs: Math.max(0, now() - itemStartedAt),
        });
      } catch (reason) {
        const timedOut = reason instanceof BoundedWorkTimeoutError;
        outcomes.push({
          index,
          status: timedOut ? 'timed_out' : 'rejected',
          reason,
          elapsedMs: Math.max(0, now() - itemStartedAt),
        });
      } finally {
        activeCount -= 1;
        activeControllers.delete(controller);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  } finally {
    options.signal?.removeEventListener('abort', abortActive);
    abortActive();
  }

  outcomes.sort((left, right) => left.index - right.index);
  const elapsedMs = Math.max(0, now() - startedAt);
  const fulfilledCount = outcomes.filter((item) => item.status === 'fulfilled').length;
  const rejectedCount = outcomes.filter((item) => item.status === 'rejected').length;
  const timedOutCount = outcomes.filter((item) => item.status === 'timed_out').length;

  return {
    outcomes,
    startedCount: outcomes.length,
    fulfilledCount,
    rejectedCount,
    timedOutCount,
    deadlineReached: nextIndex < items.length || elapsedMs >= deadlineMs,
    aborted: options.signal?.aborted === true,
    elapsedMs,
    maxConcurrency,
  };
}

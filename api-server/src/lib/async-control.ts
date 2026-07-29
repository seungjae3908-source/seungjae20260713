export class OperationTimeoutError extends Error {
  readonly code = 'OPERATION_TIMEOUT';
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'OperationTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label = 'operation',
): Promise<T> {
  const safeTimeout = Math.max(1, Math.trunc(timeoutMs));
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new OperationTimeoutError(label, safeTimeout)),
          safeTimeout,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SingleFlight<K, V> {
  private readonly pending = new Map<K, Promise<V>>();

  run(key: K, loader: () => Promise<V>): Promise<V> {
    const current = this.pending.get(key);
    if (current) return current;

    const operation = Promise.resolve()
      .then(loader)
      .finally(() => {
        if (this.pending.get(key) === operation) {
          this.pending.delete(key);
        }
      });

    this.pending.set(key, operation);
    return operation;
  }

  has(key: K): boolean {
    return this.pending.has(key);
  }

  get size(): number {
    return this.pending.size;
  }
}

export interface LastGoodValue<V> {
  value: V;
  savedAt: number;
  ageMs: number;
}

export class LastGoodCache<K, V> {
  private readonly values = new Map<K, { value: V; savedAt: number }>();

  set(key: K, value: V, savedAt = Date.now()): void {
    this.values.set(key, { value, savedAt });
  }

  get(
    key: K,
    maxAgeMs = Number.POSITIVE_INFINITY,
    now = Date.now(),
  ): LastGoodValue<V> | null {
    const entry = this.values.get(key);
    if (!entry) return null;

    const ageMs = Math.max(0, now - entry.savedAt);
    if (ageMs > maxAgeMs) return null;

    return {
      value: entry.value,
      savedAt: entry.savedAt,
      ageMs,
    };
  }
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const workerCount = Math.max(
    1,
    Math.min(items.length || 1, Math.trunc(concurrency) || 1),
  );
  let cursor = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;

        try {
          results[index] = {
            status: 'fulfilled',
            value: await mapper(items[index], index),
          };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    }),
  );

  return results;
}

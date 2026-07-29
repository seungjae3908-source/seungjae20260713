export interface WorkerRuntimeOptions {
  name: string;
  intervalMs: number;
  initialDelayMs?: number;
  run: () => Promise<unknown>;
}

export async function runWorker(options: WorkerRuntimeOptions): Promise<void> {
  let stopping = false;
  let wake: (() => void) | null = null;
  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        if (wake === finish) wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      wake = finish;
    });
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[${options.name}] stopping (${signal})`);
    wake?.();
  };

  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  if ((options.initialDelayMs ?? 0) > 0) {
    await delay(options.initialDelayMs ?? 0);
  }

  console.log(
    `[${options.name}] started (interval=${Math.trunc(options.intervalMs)}ms)`,
  );

  while (!stopping) {
    const startedAt = Date.now();
    try {
      const result = await options.run();
      console.log(
        `[${options.name}] completed in ${Date.now() - startedAt}ms`,
        result,
      );
    } catch (error) {
      console.error(`[${options.name}] iteration failed:`, error);
    }

    if (!stopping) {
      await delay(Math.max(1_000, Math.trunc(options.intervalMs)));
    }
  }
}

export function boundedWorkerInterval(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

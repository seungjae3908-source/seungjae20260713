import { acquireWorkerLock } from './worker-lock';

export interface WorkerRuntimeOptions {
  name: string;
  lockName?: string;
  intervalMs: number;
  initialDelayMs?: number;
  run: () => Promise<unknown>;
}

export async function runWorker(options: WorkerRuntimeOptions): Promise<void> {
  const workerLock = await acquireWorkerLock(options.lockName ?? options.name);
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
    console.log(
      JSON.stringify({
        event: 'worker_stopping',
        worker: options.name,
        signal,
      }),
    );
    wake?.();
  };

  const onSigint = () => stop('SIGINT');
  const onSigterm = () => stop('SIGTERM');
  const onMessage = (message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'canary-signal' &&
      'signal' in message &&
      (message.signal === 'SIGTERM' || message.signal === 'SIGINT')
    ) {
      stop(message.signal);
    }
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.on('message', onMessage);

  try {
    if ((options.initialDelayMs ?? 0) > 0) {
      await delay(options.initialDelayMs ?? 0);
    }

    console.log(
      JSON.stringify({
        event: 'worker_started',
        worker: options.name,
        intervalMs: Math.trunc(options.intervalMs),
      }),
    );

    while (!stopping) {
      const startedAt = Date.now();
      try {
        const result = await options.run();
        console.log(
          JSON.stringify({
            event: 'worker_cycle',
            worker: options.name,
            status: 'completed',
            durationMs: Date.now() - startedAt,
            result,
          }),
        );
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : error instanceof Error
              ? error.name
              : 'UNKNOWN_ERROR';
        console.error(
          JSON.stringify({
            event: 'worker_cycle',
            worker: options.name,
            status: 'failed',
            durationMs: Date.now() - startedAt,
            code,
          }),
        );
      }

      if (!stopping) {
        await delay(Math.max(1_000, Math.trunc(options.intervalMs)));
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('message', onMessage);
    await workerLock.release();
    console.log(
      JSON.stringify({
        event: 'worker_stopped',
        worker: options.name,
      }),
    );
    if (process.connected) process.disconnect();
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

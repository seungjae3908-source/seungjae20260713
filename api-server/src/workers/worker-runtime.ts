import { acquireWorkerLock } from './worker-lock';

export interface WorkerRuntimeOptions {
  name: string;
  lockName?: string;
  intervalMs: number;
  initialDelayMs?: number;
  run: () => Promise<unknown>;
  diagnostics?: () => unknown;
}

interface ProcessWithDiagnostics extends NodeJS.Process {
  _getActiveHandles?: () => unknown[];
  _getActiveRequests?: () => unknown[];
}

export async function runWorker(options: WorkerRuntimeOptions): Promise<void> {
  const workerLock = await acquireWorkerLock(options.lockName ?? options.name);
  let stopping = false;
  let wake: (() => void) | null = null;
  let activeDelayTimers = 0;
  let activeCyclePromises = 0;
  const runtimeDiagnostics = () => {
    const runtimeProcess = process as ProcessWithDiagnostics;
    const memory = process.memoryUsage();
    return {
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      activeHandles: runtimeProcess._getActiveHandles?.().length ?? 0,
      activeRequests: runtimeProcess._getActiveRequests?.().length ?? 0,
      inFlightPromises: activeCyclePromises,
      timerCount: activeDelayTimers,
      listenerCount:
        process.listenerCount('SIGINT') +
        process.listenerCount('SIGTERM') +
        process.listenerCount('message'),
    };
  };
  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      activeDelayTimers += 1;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        activeDelayTimers = Math.max(0, activeDelayTimers - 1);
        if (wake === finish) wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      wake = finish;
    });
  const stop = (signal: string) => {
    if (stopping) {
      console.log(
        JSON.stringify({
          event: 'worker_stop_signal_ignored',
          worker: options.name,
          signal,
        }),
      );
      return;
    }
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
      return;
    }

    if (
      process.env.API_CANARY === 'true' &&
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'canary-gc'
    ) {
      const collect = () => ({
        runtime: runtimeDiagnostics(),
        worker: options.diagnostics?.() ?? null,
      });
      const before = collect();
      const gc = (globalThis as typeof globalThis & {
        gc?: () => void;
      }).gc;
      gc?.();
      const after = collect();
      console.log(
        JSON.stringify({
          event: 'worker_gc',
          worker: options.name,
          checkpoint:
            'checkpoint' in message
              ? Number(message.checkpoint)
              : null,
          available: typeof gc === 'function',
          before,
          after,
        }),
      );
    }
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
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
      activeCyclePromises += 1;
      try {
        const result = await options.run();
        console.log(
          JSON.stringify({
            event: 'worker_cycle',
            worker: options.name,
            status: 'completed',
            durationMs: Date.now() - startedAt,
            result,
            diagnostics: {
              runtime: runtimeDiagnostics(),
              worker: options.diagnostics?.() ?? null,
            },
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
            diagnostics: {
              runtime: runtimeDiagnostics(),
              worker: options.diagnostics?.() ?? null,
            },
          }),
        );
      } finally {
        activeCyclePromises = Math.max(0, activeCyclePromises - 1);
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

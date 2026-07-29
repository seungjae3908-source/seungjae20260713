import { SpecialFeedService } from '../services/special-feed.service';
import {
  boundedWorkerInterval,
  runWorker,
} from './worker-runtime';
import { WorkerAlreadyRunningError } from './worker-lock';

const intervalMs = boundedWorkerInterval(
  process.env.SIGNAL_WORKER_INTERVAL_MS,
  30_000,
  20_000,
  15 * 60_000,
);

void runWorker({
  name: 'signal-worker',
  lockName: 'signal-worker',
  intervalMs,
  run: () => SpecialFeedService.runWorkerScanOnce(),
}).catch((error) => {
  const code =
    error instanceof WorkerAlreadyRunningError
      ? error.code
      : error instanceof Error
        ? error.name
        : 'UNKNOWN_ERROR';
  console.error(
    JSON.stringify({
      event: 'worker_exit',
      worker: 'signal-worker',
      code,
    }),
  );
  process.exitCode =
    error instanceof WorkerAlreadyRunningError ? error.exitCode : 1;
  if (process.connected) process.disconnect();
});

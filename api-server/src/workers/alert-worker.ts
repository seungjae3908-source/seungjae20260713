import { runPriceAlertMonitorOnce } from '../services/notification.service';
import {
  boundedWorkerInterval,
  runWorker,
} from './worker-runtime';
import { WorkerAlreadyRunningError } from './worker-lock';

const intervalMs = boundedWorkerInterval(
  process.env.PRICE_ALERT_MONITOR_INTERVAL_MS,
  60_000,
  30_000,
  15 * 60_000,
);
const dryRun =
  String(process.env.ALERT_WORKER_DRY_RUN ?? '').trim().toLowerCase() ===
  'true';

void runWorker({
  name: 'alert-worker',
  lockName: 'alert-worker',
  intervalMs,
  initialDelayMs: 10_000,
  run: () => runPriceAlertMonitorOnce({ dryRun }),
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
      worker: 'alert-worker',
      code,
      dryRun,
    }),
  );
  process.exitCode =
    error instanceof WorkerAlreadyRunningError ? error.exitCode : 1;
  if (process.connected) process.disconnect();
});

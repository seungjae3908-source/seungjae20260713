import { runPriceAlertMonitorOnce } from '../services/notification.service';
import {
  boundedWorkerInterval,
  runWorker,
} from './worker-runtime';

const intervalMs = boundedWorkerInterval(
  process.env.PRICE_ALERT_MONITOR_INTERVAL_MS,
  60_000,
  30_000,
  15 * 60_000,
);

void runWorker({
  name: 'alert-worker',
  intervalMs,
  initialDelayMs: 10_000,
  run: () => runPriceAlertMonitorOnce(),
}).catch((error) => {
  console.error('[alert-worker] fatal error:', error);
  process.exitCode = 1;
});

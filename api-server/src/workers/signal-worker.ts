import { SpecialFeedService } from '../services/special-feed.service';
import {
  boundedWorkerInterval,
  runWorker,
} from './worker-runtime';

const intervalMs = boundedWorkerInterval(
  process.env.SIGNAL_WORKER_INTERVAL_MS,
  30_000,
  20_000,
  15 * 60_000,
);

void runWorker({
  name: 'signal-worker',
  intervalMs,
  run: () => SpecialFeedService.runWorkerScanOnce(),
}).catch((error) => {
  console.error('[signal-worker] fatal error:', error);
  process.exitCode = 1;
});

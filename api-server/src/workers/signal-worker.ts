import { SEC_USER_AGENT } from '../lib/config';
import { SpecialFeedService } from '../services/special-feed.service';
import { boundedWorkerInterval, runWorker } from './worker-runtime';
import { WorkerAlreadyRunningError } from './worker-lock';

const intervalMs = boundedWorkerInterval(
  process.env.SIGNAL_WORKER_INTERVAL_MS,
  30_000,
  20_000,
  15 * 60_000,
);

if (!process.env.MEMORY_CACHE_MAX_ENTRIES) {
  process.env.MEMORY_CACHE_MAX_ENTRIES = '400';
}

type Market = 'KR' | 'US';
const MARKETS: Market[] = ['KR', 'US'];

type MarketResult = {
  itemCount: number | null;
  updatedAt: string | null;
  error: string | null;
};

async function main(): Promise<void> {
  if (!SEC_USER_AGENT || SEC_USER_AGENT.length < 5) {
    throw new Error('SEC_USER_AGENT_INVALID');
  }
  await runWorker({
    name: 'signal-worker',
    lockName: 'signal-worker',
    intervalMs,
    run: async () => {
      const results: Record<string, MarketResult> = {};
      for (const market of MARKETS) {
        try {
          const feed = await SpecialFeedService.getFeed(market, 100);
          const items = (feed as unknown as { items?: unknown }).items;
          const updatedAt = (feed as unknown as { updatedAt?: unknown }).updatedAt;
          results[market] = {
            itemCount: Array.isArray(items) ? items.length : 0,
            updatedAt: typeof updatedAt === 'string' ? updatedAt : null,
            error: null,
          };
        } catch (err) {
          results[market] = {
            itemCount: null,
            updatedAt: null,
            error: err instanceof Error ? err.name : 'UNKNOWN_ERROR',
          };
        }
      }
      return { markets: results, scannedAt: new Date().toISOString() };
    },
    diagnostics: () => ({
      markets: MARKETS,
      note: 'diagnostics simplified for main API compat',
    }),
  });
}

void main().catch((error) => {
  const code = error instanceof WorkerAlreadyRunningError
    ? error.code
    : error instanceof Error ? error.name : 'UNKNOWN_ERROR';
  console.error(JSON.stringify({ event: 'worker_exit', worker: 'signal-worker', code }));
  process.exitCode = error instanceof WorkerAlreadyRunningError ? error.exitCode : 1;
  if (process.connected) process.disconnect();
});

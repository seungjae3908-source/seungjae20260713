import { assertSecUserAgentConfigured } from '../lib/config';
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
if (!process.env.MEMORY_CACHE_MAX_ENTRIES) {
  process.env.MEMORY_CACHE_MAX_ENTRIES = '400';
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object'
    ? (value as UnknownRecord)
    : {};
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeMarket(value: unknown): UnknownRecord {
  const market = asRecord(value);
  return {
    market: market.market ?? null,
    status: market.status ?? null,
    source: market.source ?? null,
    resultCount: finiteNumber(market.resultCount),
    durationMs: finiteNumber(market.durationMs),
    updatedAt: market.updatedAt ?? null,
    warning: market.warning ?? null,
    staleUsed: Boolean(market.staleUsed),
  };
}

function summarizeSignalWorkerResult(result: unknown): UnknownRecord {
  const root = asRecord(result);
  const cycle = asRecord(root.cycle);
  const diagnostics = asRecord(root.diagnostics);
  const markets = asRecord(root.markets);

  return {
    itemCount: finiteNumber(root.itemCount),
    savedAt: root.savedAt ?? null,
    markets: {
      KR: summarizeMarket(markets.KR ?? root.KR),
      US: summarizeMarket(markets.US ?? root.US),
      spot: summarizeMarket(markets.spot ?? root.spot),
      futures: summarizeMarket(markets.futures ?? root.futures),
    },
    cycle: {
      cycleNumber: finiteNumber(cycle.cycleNumber),
      startedAtMs: finiteNumber(cycle.startedAtMs),
      finishedAtMs: finiteNumber(cycle.finishedAtMs),
      durationMs: finiteNumber(cycle.durationMs),
      timeoutMs: finiteNumber(cycle.timeoutMs),
      timedOut: Boolean(cycle.timedOut),
      failureCode: cycle.failureCode ?? null,
      providerTotals: cycle.providerTotals ?? null,
      marketTotals: cycle.marketTotals ?? null,
    },
    diagnostics: {
      pendingPromises: finiteNumber(diagnostics.pendingPromises),
      timerCount: finiteNumber(diagnostics.timerCount),
      snapshotBytes: finiteNumber(diagnostics.snapshotBytes),
      marketResultLengths: diagnostics.marketResultLengths ?? null,
      cache: diagnostics.cache ?? null,
    },
  };
}

function summarizeSignalWorkerDiagnostics(
  value: unknown,
): UnknownRecord {
  const diagnostics = asRecord(value);
  const lastCycle = asRecord(diagnostics.lastCycle);

  return {
    mapEntries: diagnostics.mapEntries ?? null,
    setEntries: diagnostics.setEntries ?? null,
    marketResultLengths: diagnostics.marketResultLengths ?? null,
    lastGoodMarketCount: finiteNumber(
      diagnostics.lastGoodMarketCount,
    ),
    snapshotBytes: finiteNumber(diagnostics.snapshotBytes),
    pendingPromises: finiteNumber(diagnostics.pendingPromises),
    timerCount: finiteNumber(diagnostics.timerCount),
    cache: diagnostics.cache ?? null,
    lastCycle: {
      cycleNumber: finiteNumber(lastCycle.cycleNumber),
      durationMs: finiteNumber(lastCycle.durationMs),
      timeoutMs: finiteNumber(lastCycle.timeoutMs),
      timedOut: Boolean(lastCycle.timedOut),
      failureCode: lastCycle.failureCode ?? null,
      providerTotals: lastCycle.providerTotals ?? null,
      marketTotals: lastCycle.marketTotals ?? null,
    },
  };
}

async function main(): Promise<void> {
  // SEC requests with an invalid one-character or generic User-Agent are
  // rejected with 403. Refuse to start the scan loop until the deployment
  // provides an application name and reachable contact email.
  assertSecUserAgentConfigured();

  await runWorker({
    name: 'signal-worker',
    lockName: 'signal-worker',
    intervalMs,
    run: async () => {
      const result = await SpecialFeedService.runWorkerScanOnce();
      return summarizeSignalWorkerResult(result);
    },
    diagnostics: () =>
      summarizeSignalWorkerDiagnostics(
        SpecialFeedService.getDiagnostics(),
      ),
  });
}

void main().catch((error) => {
  const code =
    error instanceof WorkerAlreadyRunningError
      ? error.code
      : error && typeof error === 'object' && 'code' in error
        ? String(error.code)
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

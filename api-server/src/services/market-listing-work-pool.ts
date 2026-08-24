import { runBoundedWorkPool } from '../lib/bounded-work-pool';

export const MARKET_LISTING_CONCURRENCY = 6;
export const MARKET_LISTING_DEADLINE_MS = 6_000;
export const MARKET_LISTING_ITEM_TIMEOUT_MS = MARKET_LISTING_DEADLINE_MS;

export interface MarketListingWorkOptions {
  concurrency?: number;
  deadlineMs?: number;
  itemTimeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

export interface MarketListingWorkDiagnostics {
  status: 'complete' | 'partial';
  candidateCount: number;
  startedCount: number;
  fulfilledCount: number;
  rejectedCount: number;
  timedOutCount: number;
  unstartedCount: number;
  unusableCount: number;
  deadlineReached: boolean;
  aborted: boolean;
  elapsedMs: number;
  maxConcurrency: number;
}

export interface MarketListingWorkResult<Result> {
  values: Result[];
  diagnostics: MarketListingWorkDiagnostics;
}

export async function collectMarketListingWork<Item, Result>(
  items: readonly Item[],
  worker: (item: Item, index: number, signal: AbortSignal) => Promise<Result>,
  options: MarketListingWorkOptions = {},
): Promise<MarketListingWorkResult<Result>> {
  const pool = await runBoundedWorkPool(items, worker, {
    concurrency: options.concurrency ?? MARKET_LISTING_CONCURRENCY,
    deadlineMs: options.deadlineMs ?? MARKET_LISTING_DEADLINE_MS,
    itemTimeoutMs: options.itemTimeoutMs ?? MARKET_LISTING_ITEM_TIMEOUT_MS,
    signal: options.signal,
    now: options.now,
    admission: {
      identity: {
        provider: 'market-listing',
        domain: 'public-market',
        operationClass: 'listing-work',
      },
    },
  });

  const values = pool.outcomes
    .filter((outcome) => outcome.status === 'fulfilled')
    .map((outcome) => outcome.value as Result);
  const unstartedCount = Math.max(0, items.length - pool.startedCount);
  const unusableCount = values.reduce(
    (count, value) => count + (value == null ? 1 : 0),
    0,
  );
  const partial = pool.aborted
    || pool.deadlineReached
    || pool.rejectedCount > 0
    || pool.timedOutCount > 0
    || unstartedCount > 0
    || unusableCount > 0;

  return {
    values,
    diagnostics: {
      status: partial ? 'partial' : 'complete',
      candidateCount: items.length,
      startedCount: pool.startedCount,
      fulfilledCount: pool.fulfilledCount,
      rejectedCount: pool.rejectedCount,
      timedOutCount: pool.timedOutCount,
      unstartedCount,
      unusableCount,
      deadlineReached: pool.deadlineReached,
      aborted: pool.aborted,
      elapsedMs: pool.elapsedMs,
      maxConcurrency: pool.maxConcurrency,
    },
  };
}

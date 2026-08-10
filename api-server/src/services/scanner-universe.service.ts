import { classifyAssetType, type AssetType } from '../data/asset-type';
import { CATALOG, type CatalogEntry } from '../data/catalog';
import { getKrUniverse } from '../providers/krx';
import { getUsUniverse } from '../providers/us-universe';

export type ScannerListingStatus = 'LISTED' | 'UNKNOWN';
export type ScannerUniverseSource =
  | 'krx-symbol-master'
  | 'finnhub-symbol-master'
  | 'last-good-cache'
  | 'curated-fallback';

export interface ScannerUniverseEntry extends CatalogEntry {
  assetType: AssetType;
  exchange: string | null;
  listingStatus: ScannerListingStatus;
  source: ScannerUniverseSource;
}

export interface ScannerUniverseResult {
  entries: ScannerUniverseEntry[];
  totalCount: number;
  source: ScannerUniverseSource;
  partial: boolean;
  stale: boolean;
  providerErrorCount: number;
  loadedAt: string;
}

export interface ScannerUniverseBatch extends ScannerUniverseResult {
  entries: ScannerUniverseEntry[];
  cursor: number;
  nextCursor: number | null;
  batchSize: number;
}

type MarketScope = 'KR' | 'US';
type CacheRow = { at: number; entries: ScannerUniverseEntry[]; source: ScannerUniverseSource };
const lastGood = new Map<MarketScope, CacheRow>();
const CACHE_MS = 12 * 60 * 60_000;

function catalogFallback(market: MarketScope): ScannerUniverseEntry[] {
  return CATALOG
    .filter((entry) => entry.market === market)
    .map((entry) => ({
      ...entry,
      assetType: classifyAssetType(entry.name, entry.market),
      exchange: null,
      listingStatus: 'UNKNOWN' as const,
      source: 'curated-fallback' as const,
    }));
}

function dedupe(entries: ScannerUniverseEntry[]): ScannerUniverseEntry[] {
  const rows = new Map<string, ScannerUniverseEntry>();
  for (const entry of entries) {
    const ticker = String(entry.ticker ?? '').trim().toUpperCase();
    if (!ticker) continue;
    const key = `${entry.market}:${ticker}`;
    if (!rows.has(key)) rows.set(key, { ...entry, ticker });
  }
  return [...rows.values()].sort((left, right) => left.ticker.localeCompare(right.ticker));
}

function linkedUniverseSignal(
  parent?: AbortSignal,
  deadlineMs?: number,
): { signal: AbortSignal; clear(): void } {
  if (deadlineMs != null && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) {
    throw new Error(`invalid scanner universe deadline: ${deadlineMs}`);
  }
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason ?? new Error('SCAN_UNIVERSE_ABORTED'));
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = deadlineMs == null
    ? undefined
    : setTimeout(
      () => controller.abort(new Error('SCAN_UNIVERSE_DEADLINE_EXCEEDED')),
      deadlineMs,
    );
  return {
    signal: controller.signal,
    clear() {
      if (timeout !== undefined) clearTimeout(timeout);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('SCAN_UNIVERSE_ABORTED');
  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error('SCAN_UNIVERSE_ABORTED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function liveUniverse(market: MarketScope, signal?: AbortSignal): Promise<ScannerUniverseEntry[]> {
  if (market === 'KR') {
    const rows = await getKrUniverse(signal);
    if (signal?.aborted) throw signal.reason ?? new Error('SCAN_UNIVERSE_ABORTED');
    return rows.map((row) => ({
      ticker: row.ticker,
      name: row.name,
      market: 'KR',
      currency: 'KRW',
      assetType: row.assetType,
      exchange: row.marketName || null,
      listingStatus: 'LISTED',
      source: 'krx-symbol-master',
    }));
  }

  const rows = await getUsUniverse(signal);
  return rows.map((row) => ({
    ticker: row.ticker,
    name: row.name,
    market: 'US',
    currency: 'USD',
    assetType: row.assetType,
    exchange: row.exchange,
    listingStatus: 'LISTED',
    source: 'finnhub-symbol-master',
  }));
}

export function clearScannerUniverseCacheForTests(): void {
  lastGood.clear();
}

export const ScannerUniverseService = {
  async get(
    market: MarketScope,
    signal?: AbortSignal,
    deadlineMs?: number,
  ): Promise<ScannerUniverseResult> {
    const now = Date.now();
    const cached = lastGood.get(market);
    if (cached && now - cached.at < CACHE_MS) {
      return {
        entries: cached.entries,
        totalCount: cached.entries.length,
        source: cached.source,
        partial: false,
        stale: false,
        providerErrorCount: 0,
        loadedAt: new Date(cached.at).toISOString(),
      };
    }

    const linked = linkedUniverseSignal(signal, deadlineMs);
    try {
      const live = dedupe(await awaitWithAbort(liveUniverse(market, linked.signal), linked.signal));
      if (live.length > 0) {
        const source: ScannerUniverseSource = market === 'KR'
          ? 'krx-symbol-master'
          : 'finnhub-symbol-master';
        lastGood.set(market, { at: now, entries: live, source });
        return {
          entries: live,
          totalCount: live.length,
          source,
          partial: false,
          stale: false,
          providerErrorCount: 0,
          loadedAt: new Date(now).toISOString(),
        };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    } finally {
      linked.clear();
    }

    if (cached?.entries.length) {
      return {
        entries: cached.entries.map((entry) => ({ ...entry, source: 'last-good-cache' })),
        totalCount: cached.entries.length,
        source: 'last-good-cache',
        partial: true,
        stale: true,
        providerErrorCount: 1,
        loadedAt: new Date(cached.at).toISOString(),
      };
    }

    const fallback = dedupe(catalogFallback(market));
    return {
      entries: fallback,
      totalCount: fallback.length,
      source: 'curated-fallback',
      partial: true,
      stale: true,
      providerErrorCount: 1,
      loadedAt: new Date(now).toISOString(),
    };
  },

  async batch(
    market: MarketScope,
    cursorValue: number,
    batchSizeValue: number,
    signal?: AbortSignal,
    deadlineMs?: number,
  ): Promise<ScannerUniverseBatch> {
    const universe = await this.get(market, signal, deadlineMs);
    const batchSize = Math.max(10, Math.min(200, Math.floor(batchSizeValue) || 120));
    const cursor = Math.max(0, Math.min(universe.totalCount, Math.floor(cursorValue) || 0));
    const entries = universe.entries.slice(cursor, cursor + batchSize);
    const nextCursor = cursor + entries.length < universe.totalCount
      ? cursor + entries.length
      : null;
    return { ...universe, entries, cursor, nextCursor, batchSize };
  },
};

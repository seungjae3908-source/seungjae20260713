import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const BITGET_BASE = 'https://api.bitget.com';
const PRODUCT_TYPE = 'USDT-FUTURES';
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 15 * 60_000;
const DEFAULT_RETENTION_DAYS = 180;
const MAX_HISTORY_LIMIT = 5_000;
const RATIO_REQUEST_DELAY_MS = 1_050;

export const DEFAULT_BITGET_CONTEXT_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
] as const;

export type BitgetMarketContextDataStatus = 'OK' | 'DEGRADED' | 'BLOCKED';

export type BitgetMarketContextSnapshot = {
  version: 'bitget-market-context.v1';
  sampleId: string;
  sampleBucket: number;
  symbol: string;
  productType: typeof PRODUCT_TYPE;
  collectedAt: string;
  sourceTimestamp: number | null;
  market: {
    price: number | null;
    markPrice: number | null;
    indexPrice: number | null;
    bidPrice: number | null;
    askPrice: number | null;
    spreadBps: number | null;
    markIndexPremium: number | null;
    marketMarkGap: number | null;
    fundingRate: number | null;
    fundingRateIntervalHours: number | null;
    nextFundingAt: string | null;
  };
  derivatives: {
    openInterest: number | null;
    openInterestChange5mPct: number | null;
    openInterestChange15mPct: number | null;
    openInterestChange1hPct: number | null;
    accountLongRatio: number | null;
    accountShortRatio: number | null;
    accountLongShortRatio: number | null;
    positionLongRatio: number | null;
    positionShortRatio: number | null;
    positionLongShortRatio: number | null;
    marketLongRatio: number | null;
    marketShortRatio: number | null;
    marketLongShortRatio: number | null;
  };
  policy: {
    dataStatus: BitgetMarketContextDataStatus;
    longPullbackEligible: boolean;
    blockReasons: string[];
    warnings: string[];
  };
  providerTimestamps: {
    ticker: number | null;
    openInterest: number | null;
    accountLongShort: number | null;
    positionLongShort: number | null;
    marketLongShort: number | null;
  };
};

type RawContextInput = Omit<BitgetMarketContextSnapshot, 'policy'>;

type CollectorStatus = {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  symbols: string[];
  dataDirectory: string;
  retentionDays: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  latestCount: number;
};

type HistoryOptions = {
  from?: string | null;
  to?: string | null;
  limit?: number;
};

type BitgetEnvelope<T> = {
  code?: string;
  msg?: string;
  requestTime?: number | string;
  data?: T;
};

type TickerRow = {
  symbol?: unknown;
  lastPr?: unknown;
  markPrice?: unknown;
  indexPrice?: unknown;
  bidPr?: unknown;
  askPr?: unknown;
  fundingRate?: unknown;
  ts?: unknown;
};

type OpenInterestPayload = {
  openInterestList?: Array<{ symbol?: unknown; size?: unknown }>;
  ts?: unknown;
};

type AccountRatioRow = {
  longAccountRatio?: unknown;
  shortAccountRatio?: unknown;
  longShortAccountRatio?: unknown;
  ts?: unknown;
};

type PositionRatioRow = {
  longPositionRatio?: unknown;
  shortPositionRatio?: unknown;
  longShortPositionRatio?: unknown;
  ts?: unknown;
};

type MarketRatioRow = {
  longRatio?: unknown;
  shortRatio?: unknown;
  longShortRatio?: unknown;
  ts?: unknown;
};

type FundingRow = {
  fundingRate?: unknown;
  fundingRateInterval?: unknown;
  nextUpdate?: unknown;
};

let collectorTimer: NodeJS.Timeout | null = null;
let collectorRunning = false;
let lastStartedAt: string | null = null;
let lastCompletedAt: string | null = null;
let lastError: string | null = null;
let retentionCleanupDay: string | null = null;
const latestBySymbol = new Map<string, BitgetMarketContextSnapshot>();
const recentBySymbol = new Map<string, BitgetMarketContextSnapshot[]>();
const loadedHistory = new Set<string>();

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeTimestamp(value: unknown): number | null {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? Math.floor(parsed) : null;
}

function isoTimestamp(value: unknown): string | null {
  const timestamp = safeTimestamp(value);
  if (timestamp == null) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeSymbol(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 30);
}

function parseSymbols(value = process.env.BITGET_CONTEXT_SYMBOLS): string[] {
  const parsed = String(value ?? '')
    .split(',')
    .map(safeSymbol)
    .filter(Boolean);
  return Array.from(new Set(parsed.length ? parsed : [...DEFAULT_BITGET_CONTEXT_SYMBOLS]));
}

function intervalMs(): number {
  const configured = Number(process.env.BITGET_CONTEXT_COLLECTOR_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  return Math.max(
    MIN_INTERVAL_MS,
    Math.min(MAX_INTERVAL_MS, Number.isFinite(configured) ? configured : DEFAULT_INTERVAL_MS),
  );
}

function retentionDays(): number {
  const configured = Number(process.env.BITGET_CONTEXT_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  return Math.max(7, Math.min(730, Number.isFinite(configured) ? Math.floor(configured) : DEFAULT_RETENTION_DAYS));
}

function collectorEnabled(): boolean {
  return String(process.env.BITGET_CONTEXT_COLLECTOR_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function defaultDataDirectory(): string {
  const explicit = String(process.env.BITGET_CONTEXT_DATA_DIR ?? '').trim();
  if (explicit) return path.resolve(explicit);
  const cwd = process.cwd();
  return path.resolve(cwd, path.basename(cwd) === 'api-server' ? '../data/bitget-market-context' : 'data/bitget-market-context');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function fetchBitget<T>(pathname: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams(params);
  let lastFailure: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`${BITGET_BASE}${pathname}?${query.toString()}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'seungjae-bitget-context-collector/1.0',
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const payload = (await response.json()) as BitgetEnvelope<T>;
      if (String(payload.code ?? '') !== '00000') {
        throw new Error(`BITGET_${String(payload.code ?? 'INVALID')}:${String(payload.msg ?? '')}`);
      }
      if (payload.data == null) throw new Error('BITGET_EMPTY_DATA');
      return payload.data;
    } catch (error) {
      lastFailure = error;
      if (attempt < 3) await delay(Math.min(4_000, 500 * 2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure ?? 'BITGET_REQUEST_FAILED'));
}

function latestRow<T extends { ts?: unknown }>(rows: T[] | undefined): T | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows.slice().sort((left, right) => Number(right.ts ?? 0) - Number(left.ts ?? 0))[0] ?? null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return numerator / denominator;
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function historicalOpenInterest(symbol: string, targetTime: number): number | null {
  const rows = recentBySymbol.get(symbol) ?? [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const rowTime = Date.parse(rows[index].collectedAt);
    if (Number.isFinite(rowTime) && rowTime <= targetTime) {
      return rows[index].derivatives.openInterest;
    }
  }
  return null;
}

function calculateOpenInterestChanges(symbol: string, current: number | null, now: number) {
  return {
    openInterestChange5mPct: percentChange(current, historicalOpenInterest(symbol, now - 5 * 60_000)),
    openInterestChange15mPct: percentChange(current, historicalOpenInterest(symbol, now - 15 * 60_000)),
    openInterestChange1hPct: percentChange(current, historicalOpenInterest(symbol, now - 60 * 60_000)),
  };
}

export function evaluateLongPullbackContext(input: RawContextInput): BitgetMarketContextSnapshot['policy'] {
  const blockReasons: string[] = [];
  const warnings: string[] = [];
  const now = Date.parse(input.collectedAt);
  const sourceAgeMs = input.sourceTimestamp == null || !Number.isFinite(now)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, now - input.sourceTimestamp);
  const required = [
    input.market.price,
    input.market.markPrice,
    input.market.indexPrice,
    input.market.bidPrice,
    input.market.askPrice,
    input.market.fundingRate,
    input.derivatives.openInterest,
    input.derivatives.accountLongShortRatio,
    input.derivatives.positionLongShortRatio,
    input.derivatives.marketLongShortRatio,
  ];
  if (required.some((value) => value == null || !Number.isFinite(value))) {
    blockReasons.push('DATA_MISSING');
  }
  if (sourceAgeMs > Math.max(12 * 60_000, intervalMs() * 2.5)) {
    blockReasons.push('DATA_STALE');
  }
  if (input.market.spreadBps != null && input.market.spreadBps > 12) {
    blockReasons.push('SPREAD_TOO_WIDE');
  }
  if (input.market.markIndexPremium != null && Math.abs(input.market.markIndexPremium) > 0.0015) {
    blockReasons.push('MARK_INDEX_DIVERGENCE');
  }
  if (input.market.marketMarkGap != null && Math.abs(input.market.marketMarkGap) > 0.0012) {
    blockReasons.push('MARKET_MARK_DIVERGENCE');
  }
  if (input.market.fundingRate != null) {
    if (input.market.fundingRate > 0.0005) blockReasons.push('LONG_FUNDING_OVERHEATED');
    if (Math.abs(input.market.fundingRate) > 0.0015) blockReasons.push('FUNDING_SHOCK');
    if (input.market.fundingRate < 0) warnings.push('NEGATIVE_FUNDING');
  }
  const crowdingRatios = [
    input.derivatives.accountLongShortRatio,
    input.derivatives.positionLongShortRatio,
    input.derivatives.marketLongShortRatio,
  ].filter((value): value is number => value != null && Number.isFinite(value));
  if (crowdingRatios.some((value) => value > 1.8)) blockReasons.push('LONG_SIDE_CROWDED');
  if (crowdingRatios.some((value) => value < 0.5)) warnings.push('SHORT_SIDE_CROWDED');
  const oi5 = input.derivatives.openInterestChange5mPct;
  const oi15 = input.derivatives.openInterestChange15mPct;
  const oi60 = input.derivatives.openInterestChange1hPct;
  if (oi5 == null || oi15 == null || oi60 == null) {
    warnings.push('OI_HISTORY_INSUFFICIENT');
  }
  if (oi5 != null && Math.abs(oi5) > 3) blockReasons.push('OI_5M_SHOCK');
  if (oi15 != null && Math.abs(oi15) > 6) blockReasons.push('OI_15M_SHOCK');
  if (oi60 != null && Math.abs(oi60) > 12) blockReasons.push('OI_1H_SHOCK');
  const uniqueBlocks = Array.from(new Set(blockReasons));
  const uniqueWarnings = Array.from(new Set(warnings));
  return {
    dataStatus: uniqueBlocks.length > 0 ? 'BLOCKED' : uniqueWarnings.length > 0 ? 'DEGRADED' : 'OK',
    longPullbackEligible: uniqueBlocks.length === 0 && !uniqueWarnings.includes('OI_HISTORY_INSUFFICIENT'),
    blockReasons: uniqueBlocks,
    warnings: uniqueWarnings,
  };
}

function dateKey(iso: string): string {
  return iso.slice(0, 10);
}

function snapshotPath(snapshot: BitgetMarketContextSnapshot): string {
  return path.join(defaultDataDirectory(), dateKey(snapshot.collectedAt), `${snapshot.symbol}.jsonl`);
}

async function appendSnapshot(snapshot: BitgetMarketContextSnapshot): Promise<void> {
  const file = snapshotPath(snapshot);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(snapshot)}\n`, 'utf-8');
}

function remember(snapshot: BitgetMarketContextSnapshot): void {
  const rows = recentBySymbol.get(snapshot.symbol) ?? [];
  const duplicateIndex = rows.findIndex((row) => row.sampleId === snapshot.sampleId);
  if (duplicateIndex >= 0) rows.splice(duplicateIndex, 1);
  rows.push(snapshot);
  rows.sort((left, right) => Date.parse(left.collectedAt) - Date.parse(right.collectedAt));
  if (rows.length > 1_000) rows.splice(0, rows.length - 1_000);
  recentBySymbol.set(snapshot.symbol, rows);
  latestBySymbol.set(snapshot.symbol, snapshot);
}

async function loadRecentHistory(symbol: string): Promise<void> {
  if (loadedHistory.has(symbol)) return;
  loadedHistory.add(symbol);
  const root = defaultDataDirectory();
  try {
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(-3);
    const loaded: BitgetMarketContextSnapshot[] = [];
    for (const directory of entries) {
      const file = path.join(root, directory, `${symbol}.jsonl`);
      try {
        const content = await readFile(file, 'utf-8');
        for (const line of content.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as BitgetMarketContextSnapshot;
            if (parsed.symbol === symbol && parsed.version === 'bitget-market-context.v1') loaded.push(parsed);
          } catch {
            // Ignore a single damaged line and preserve the rest of the history.
          }
        }
      } catch {
        // The symbol may not have a file for every day.
      }
    }
    loaded.slice(-1_000).forEach(remember);
  } catch {
    // First run has no data directory yet.
  }
}

async function cleanupRetention(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (retentionCleanupDay === today) return;
  retentionCleanupDay = today;
  const root = defaultDataDirectory();
  const cutoff = Date.now() - retentionDays() * 86_400_000;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) return;
      const timestamp = Date.parse(`${entry.name}T00:00:00Z`);
      if (Number.isFinite(timestamp) && timestamp < cutoff) {
        await rm(path.join(root, entry.name), { recursive: true, force: true });
      }
    }));
  } catch {
    // No retention cleanup is needed before the first snapshot.
  }
}

async function collectSymbol(symbol: string): Promise<BitgetMarketContextSnapshot> {
  await loadRecentHistory(symbol);
  const params = { symbol, productType: PRODUCT_TYPE };
  const [tickerRows, openInterestPayload, fundingRows] = await Promise.all([
    fetchBitget<TickerRow[]>('/api/v2/mix/market/ticker', params),
    fetchBitget<OpenInterestPayload>('/api/v2/mix/market/open-interest', params),
    fetchBitget<FundingRow[]>('/api/v2/mix/market/current-fund-rate', params),
  ]);
  const accountRows = await fetchBitget<AccountRatioRow[]>('/api/v2/mix/market/account-long-short', { symbol, period: '5m' });
  await delay(RATIO_REQUEST_DELAY_MS);
  const positionRows = await fetchBitget<PositionRatioRow[]>('/api/v2/mix/market/position-long-short', { symbol, period: '5m' });
  await delay(RATIO_REQUEST_DELAY_MS);
  const marketRows = await fetchBitget<MarketRatioRow[]>('/api/v2/mix/market/long-short', { symbol, period: '5m' });

  const ticker = tickerRows[0] ?? null;
  const account = latestRow(accountRows);
  const position = latestRow(positionRows);
  const marketRatio = latestRow(marketRows);
  const funding = fundingRows[0] ?? null;
  const openInterestRow = openInterestPayload.openInterestList?.find(
    (item) => safeSymbol(item.symbol) === symbol,
  ) ?? openInterestPayload.openInterestList?.[0] ?? null;
  const collected = new Date();
  const now = collected.getTime();
  const price = finite(ticker?.lastPr);
  const markPrice = finite(ticker?.markPrice);
  const indexPrice = finite(ticker?.indexPrice);
  const bidPrice = finite(ticker?.bidPr);
  const askPrice = finite(ticker?.askPr);
  const openInterest = finite(openInterestRow?.size);
  const providerTimestamps = {
    ticker: safeTimestamp(ticker?.ts),
    openInterest: safeTimestamp(openInterestPayload.ts),
    accountLongShort: safeTimestamp(account?.ts),
    positionLongShort: safeTimestamp(position?.ts),
    marketLongShort: safeTimestamp(marketRatio?.ts),
  };
  const sourceTimestamp = Math.min(
    ...Object.values(providerTimestamps).filter((value): value is number => value != null),
  );
  const oiChanges = calculateOpenInterestChanges(symbol, openInterest, now);
  const sampleBucket = Math.floor(now / intervalMs());
  const raw: RawContextInput = {
    version: 'bitget-market-context.v1',
    sampleId: `${symbol}:${sampleBucket}`,
    sampleBucket,
    symbol,
    productType: PRODUCT_TYPE,
    collectedAt: collected.toISOString(),
    sourceTimestamp: Number.isFinite(sourceTimestamp) ? sourceTimestamp : null,
    market: {
      price,
      markPrice,
      indexPrice,
      bidPrice,
      askPrice,
      spreadBps: bidPrice != null && askPrice != null && bidPrice > 0
        ? ((askPrice - bidPrice) / ((askPrice + bidPrice) / 2)) * 10_000
        : null,
      markIndexPremium: ratio(markPrice != null && indexPrice != null ? markPrice - indexPrice : null, indexPrice),
      marketMarkGap: ratio(price != null && markPrice != null ? price - markPrice : null, markPrice),
      fundingRate: finite(funding?.fundingRate ?? ticker?.fundingRate),
      fundingRateIntervalHours: finite(funding?.fundingRateInterval),
      nextFundingAt: isoTimestamp(funding?.nextUpdate),
    },
    derivatives: {
      openInterest,
      ...oiChanges,
      accountLongRatio: finite(account?.longAccountRatio),
      accountShortRatio: finite(account?.shortAccountRatio),
      accountLongShortRatio: finite(account?.longShortAccountRatio),
      positionLongRatio: finite(position?.longPositionRatio),
      positionShortRatio: finite(position?.shortPositionRatio),
      positionLongShortRatio: finite(position?.longShortPositionRatio),
      marketLongRatio: finite(marketRatio?.longRatio),
      marketShortRatio: finite(marketRatio?.shortRatio),
      marketLongShortRatio: finite(marketRatio?.longShortRatio),
    },
    providerTimestamps,
  };
  const snapshot: BitgetMarketContextSnapshot = {
    ...raw,
    policy: evaluateLongPullbackContext(raw),
  };
  const previous = latestBySymbol.get(symbol);
  remember(snapshot);
  if (previous?.sampleId !== snapshot.sampleId) await appendSnapshot(snapshot);
  return snapshot;
}

export async function collectBitgetMarketContextOnce(symbols = parseSymbols()): Promise<{
  collected: BitgetMarketContextSnapshot[];
  failures: Array<{ symbol: string; error: string }>;
}> {
  if (collectorRunning) return { collected: [], failures: [{ symbol: '*', error: 'ALREADY_RUNNING' }] };
  collectorRunning = true;
  lastStartedAt = new Date().toISOString();
  lastError = null;
  const collected: BitgetMarketContextSnapshot[] = [];
  const failures: Array<{ symbol: string; error: string }> = [];
  try {
    await cleanupRetention();
    for (const rawSymbol of symbols) {
      const symbol = safeSymbol(rawSymbol);
      if (!symbol) continue;
      try {
        collected.push(await collectSymbol(symbol));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ symbol, error: message.slice(0, 300) });
      }
      await delay(RATIO_REQUEST_DELAY_MS);
    }
    if (failures.length) lastError = failures.map((item) => `${item.symbol}:${item.error}`).join(' | ').slice(0, 1_000);
    lastCompletedAt = new Date().toISOString();
    return { collected, failures };
  } finally {
    collectorRunning = false;
  }
}

export function getBitgetMarketContextStatus(): CollectorStatus {
  return {
    enabled: collectorEnabled(),
    running: collectorRunning,
    intervalMs: intervalMs(),
    symbols: parseSymbols(),
    dataDirectory: defaultDataDirectory(),
    retentionDays: retentionDays(),
    lastStartedAt,
    lastCompletedAt,
    lastError,
    latestCount: latestBySymbol.size,
  };
}

export async function getLatestBitgetMarketContext(symbol?: string | null): Promise<BitgetMarketContextSnapshot[]> {
  if (symbol) {
    const normalized = safeSymbol(symbol);
    await loadRecentHistory(normalized);
    const snapshot = latestBySymbol.get(normalized);
    return snapshot ? [snapshot] : [];
  }
  for (const configured of parseSymbols()) await loadRecentHistory(configured);
  return Array.from(latestBySymbol.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

export async function readBitgetMarketContextHistory(
  symbolValue: string,
  options: HistoryOptions = {},
): Promise<BitgetMarketContextSnapshot[]> {
  const symbol = safeSymbol(symbolValue);
  if (!symbol) return [];
  const root = defaultDataDirectory();
  const from = options.from ? Date.parse(options.from) : Number.NEGATIVE_INFINITY;
  const to = options.to ? Date.parse(options.to) : Number.POSITIVE_INFINITY;
  const limit = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(options.limit ?? 500)));
  const rows: BitgetMarketContextSnapshot[] = [];
  try {
    const directories = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const directory of directories) {
      if (rows.length >= limit) break;
      const directoryTime = Date.parse(`${directory}T00:00:00Z`);
      if (Number.isFinite(to) && directoryTime > to + 86_400_000) continue;
      if (Number.isFinite(from) && directoryTime + 86_400_000 < from) break;
      const file = path.join(root, directory, `${symbol}.jsonl`);
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
        const content = await readFile(file, 'utf-8');
        const parsed = content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
          try {
            const item = JSON.parse(line) as BitgetMarketContextSnapshot;
            const timestamp = Date.parse(item.collectedAt);
            return item.symbol === symbol && timestamp >= from && timestamp <= to ? [item] : [];
          } catch {
            return [];
          }
        });
        rows.push(...parsed.reverse());
      } catch {
        // Missing symbol file for a date is normal.
      }
    }
  } catch {
    return [];
  }
  return rows.slice(0, limit).sort((left, right) => Date.parse(left.collectedAt) - Date.parse(right.collectedAt));
}

export function startBitgetMarketContextCollector(): void {
  if (collectorTimer || !collectorEnabled()) {
    if (!collectorEnabled()) console.log('[api-server] Bitget market context collector disabled');
    return;
  }
  const run = () => {
    void collectBitgetMarketContextOnce().catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      console.error('bitget market context collector error:', error);
    });
  };
  const initial = setTimeout(run, 15_000);
  initial.unref?.();
  collectorTimer = setInterval(run, intervalMs());
  collectorTimer.unref?.();
  console.log(`[api-server] Bitget market context collector enabled (${intervalMs()}ms, ${parseSymbols().join(',')})`);
}

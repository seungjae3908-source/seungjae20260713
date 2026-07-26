import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const BITGET_BASE = 'https://api.bitget.com';
const PRODUCT_TYPE = 'USDT-FUTURES';
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 15 * 60_000;
const DEFAULT_RETENTION_DAYS = 180;
const MAX_HISTORY_LIMIT = 5_000;
const REQUEST_DELAY_MS = 1_050;

export const DEFAULT_BITGET_CONTEXT_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
] as const;

export type BitgetMarketContextDataStatus = 'OK' | 'DEGRADED' | 'BLOCKED';

export type BitgetMarketContextSnapshot = {
  version: 'bitget-market-context.v2';
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
    longEntryAllowed: boolean;
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

type RawContext = Omit<BitgetMarketContextSnapshot, 'policy'>;
type HistoryOptions = { from?: string | null; to?: string | null; limit?: number };
type Envelope<T> = { code?: string; msg?: string; data?: T };
type Timestamped = { ts?: unknown };

type TickerRow = Timestamped & {
  symbol?: unknown;
  lastPr?: unknown;
  markPrice?: unknown;
  indexPrice?: unknown;
  bidPr?: unknown;
  askPr?: unknown;
  fundingRate?: unknown;
};
type OpenInterestPayload = { openInterestList?: Array<{ symbol?: unknown; size?: unknown }>; ts?: unknown };
type AccountRatioRow = Timestamped & { longAccountRatio?: unknown; shortAccountRatio?: unknown; longShortAccountRatio?: unknown };
type PositionRatioRow = Timestamped & { longPositionRatio?: unknown; shortPositionRatio?: unknown; longShortPositionRatio?: unknown };
type MarketRatioRow = Timestamped & { longRatio?: unknown; shortRatio?: unknown; longShortRatio?: unknown };
type FundingRow = { fundingRate?: unknown; fundingRateInterval?: unknown; nextUpdate?: unknown };

let collectorTimer: NodeJS.Timeout | null = null;
let collectorRunning = false;
let lastStartedAt: string | null = null;
let lastCompletedAt: string | null = null;
let lastError: string | null = null;
let cleanupDay: string | null = null;
const latestBySymbol = new Map<string, BitgetMarketContextSnapshot>();
const recentBySymbol = new Map<string, BitgetMarketContextSnapshot[]>();
const loadedSymbols = new Set<string>();

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

function symbolsFromEnv(): string[] {
  const configured = String(process.env.BITGET_CONTEXT_SYMBOLS ?? '')
    .split(',')
    .map(safeSymbol)
    .filter(Boolean);
  return Array.from(new Set(configured.length ? configured : [...DEFAULT_BITGET_CONTEXT_SYMBOLS]));
}

function configuredIntervalMs(): number {
  const value = Number(process.env.BITGET_CONTEXT_COLLECTOR_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Number.isFinite(value) ? value : DEFAULT_INTERVAL_MS));
}

function configuredRetentionDays(): number {
  const value = Number(process.env.BITGET_CONTEXT_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  return Math.max(7, Math.min(730, Number.isFinite(value) ? Math.floor(value) : DEFAULT_RETENTION_DAYS));
}

function collectorEnabled(): boolean {
  return String(process.env.BITGET_CONTEXT_COLLECTOR_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function dataDirectory(): string {
  const explicit = String(process.env.BITGET_CONTEXT_DATA_DIR ?? '').trim();
  if (explicit) return path.resolve(explicit);
  const cwd = process.cwd();
  return path.resolve(cwd, path.basename(cwd) === 'api-server' ? '../data/bitget-market-context' : 'data/bitget-market-context');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchBitget<T>(pathname: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams(params);
  let lastFailure: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`${BITGET_BASE}${pathname}?${query.toString()}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'seungjae-bitget-context/2.0' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const payload = (await response.json()) as Envelope<T>;
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

function latestRow<T extends Timestamped>(rows: T[] | undefined): T | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows.slice().sort((left, right) => Number(right.ts ?? 0) - Number(left.ts ?? 0))[0] ?? null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator == null || denominator == null || denominator === 0 ? null : numerator / denominator;
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function previousOi(symbol: string, targetTime: number): number | null {
  const rows = recentBySymbol.get(symbol) ?? [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const timestamp = Date.parse(rows[index].collectedAt);
    if (Number.isFinite(timestamp) && timestamp <= targetTime) return rows[index].derivatives.openInterest;
  }
  return null;
}

function oiChanges(symbol: string, current: number | null, now: number) {
  return {
    openInterestChange5mPct: percentChange(current, previousOi(symbol, now - 5 * 60_000)),
    openInterestChange15mPct: percentChange(current, previousOi(symbol, now - 15 * 60_000)),
    openInterestChange1hPct: percentChange(current, previousOi(symbol, now - 60 * 60_000)),
  };
}

export function evaluateBitgetLongContext(input: RawContext): BitgetMarketContextSnapshot['policy'] {
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
  if (required.some((value) => value == null || !Number.isFinite(value))) blockReasons.push('DATA_MISSING');
  if (sourceAgeMs > Math.max(12 * 60_000, configuredIntervalMs() * 2.5)) blockReasons.push('DATA_STALE');
  if ((input.market.spreadBps ?? 0) > 12) blockReasons.push('SPREAD_TOO_WIDE');
  if (Math.abs(input.market.markIndexPremium ?? 0) > 0.0015) blockReasons.push('MARK_INDEX_DIVERGENCE');
  if (Math.abs(input.market.marketMarkGap ?? 0) > 0.0012) blockReasons.push('MARKET_MARK_DIVERGENCE');
  if ((input.market.fundingRate ?? 0) > 0.0005) blockReasons.push('LONG_FUNDING_OVERHEATED');
  if (Math.abs(input.market.fundingRate ?? 0) > 0.0015) blockReasons.push('FUNDING_SHOCK');

  const crowding = [
    input.derivatives.accountLongShortRatio,
    input.derivatives.positionLongShortRatio,
    input.derivatives.marketLongShortRatio,
  ].filter((value): value is number => value != null && Number.isFinite(value));
  if (crowding.some((value) => value > 1.8)) blockReasons.push('LONG_SIDE_CROWDED');
  if (crowding.some((value) => value < 0.5)) warnings.push('SHORT_SIDE_CROWDED');

  const oi5 = input.derivatives.openInterestChange5mPct;
  const oi15 = input.derivatives.openInterestChange15mPct;
  const oi60 = input.derivatives.openInterestChange1hPct;
  if (oi5 == null || oi15 == null || oi60 == null) warnings.push('OI_HISTORY_INSUFFICIENT');
  if (oi5 != null && Math.abs(oi5) > 3) blockReasons.push('OI_5M_SHOCK');
  if (oi15 != null && Math.abs(oi15) > 6) blockReasons.push('OI_15M_SHOCK');
  if (oi60 != null && Math.abs(oi60) > 12) blockReasons.push('OI_1H_SHOCK');

  const uniqueBlocks = Array.from(new Set(blockReasons));
  const uniqueWarnings = Array.from(new Set(warnings));
  return {
    dataStatus: uniqueBlocks.length ? 'BLOCKED' : uniqueWarnings.length ? 'DEGRADED' : 'OK',
    longEntryAllowed: uniqueBlocks.length === 0 && !uniqueWarnings.includes('OI_HISTORY_INSUFFICIENT'),
    blockReasons: uniqueBlocks,
    warnings: uniqueWarnings,
  };
}

function remember(snapshot: BitgetMarketContextSnapshot): void {
  const rows = recentBySymbol.get(snapshot.symbol) ?? [];
  const existing = rows.findIndex((row) => row.sampleId === snapshot.sampleId);
  if (existing >= 0) rows.splice(existing, 1);
  rows.push(snapshot);
  rows.sort((left, right) => Date.parse(left.collectedAt) - Date.parse(right.collectedAt));
  if (rows.length > 1_000) rows.splice(0, rows.length - 1_000);
  recentBySymbol.set(snapshot.symbol, rows);
  latestBySymbol.set(snapshot.symbol, snapshot);
}

function snapshotFile(snapshot: BitgetMarketContextSnapshot): string {
  return path.join(dataDirectory(), snapshot.collectedAt.slice(0, 10), `${snapshot.symbol}.jsonl`);
}

async function appendSnapshot(snapshot: BitgetMarketContextSnapshot): Promise<void> {
  const file = snapshotFile(snapshot);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

async function loadRecent(symbol: string): Promise<void> {
  if (loadedSymbols.has(symbol)) return;
  loadedSymbols.add(symbol);
  try {
    const directories = (await readdir(dataDirectory(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(-3);
    const loaded: BitgetMarketContextSnapshot[] = [];
    for (const directory of directories) {
      try {
        const content = await readFile(path.join(dataDirectory(), directory, `${symbol}.jsonl`), 'utf8');
        for (const line of content.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as BitgetMarketContextSnapshot;
            if (parsed.symbol === symbol && parsed.version === 'bitget-market-context.v2') loaded.push(parsed);
          } catch {
            // Ignore one malformed line without discarding the remaining history.
          }
        }
      } catch {
        // A symbol can legitimately have no file on a date.
      }
    }
    loaded.slice(-1_000).forEach(remember);
  } catch {
    // First run has no directory yet.
  }
}

async function cleanupRetention(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (cleanupDay === today) return;
  cleanupDay = today;
  const cutoff = Date.now() - configuredRetentionDays() * 86_400_000;
  try {
    const entries = await readdir(dataDirectory(), { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) return;
      const timestamp = Date.parse(`${entry.name}T00:00:00Z`);
      if (Number.isFinite(timestamp) && timestamp < cutoff) {
        await rm(path.join(dataDirectory(), entry.name), { recursive: true, force: true });
      }
    }));
  } catch {
    // Nothing to clean before first collection.
  }
}

async function collectSymbol(symbol: string): Promise<BitgetMarketContextSnapshot> {
  await loadRecent(symbol);
  const common = { symbol, productType: PRODUCT_TYPE };
  const [tickerRows, openInterestPayload, fundingRows] = await Promise.all([
    fetchBitget<TickerRow[]>('/api/v2/mix/market/ticker', common),
    fetchBitget<OpenInterestPayload>('/api/v2/mix/market/open-interest', common),
    fetchBitget<FundingRow[]>('/api/v2/mix/market/current-fund-rate', common),
  ]);
  const accountRows = await fetchBitget<AccountRatioRow[]>('/api/v2/mix/market/account-long-short', { symbol, period: '5m' });
  await delay(REQUEST_DELAY_MS);
  const positionRows = await fetchBitget<PositionRatioRow[]>('/api/v2/mix/market/position-long-short', { symbol, period: '5m' });
  await delay(REQUEST_DELAY_MS);
  const marketRows = await fetchBitget<MarketRatioRow[]>('/api/v2/mix/market/long-short', { symbol, period: '5m' });

  const ticker = tickerRows[0] ?? null;
  const account = latestRow(accountRows);
  const position = latestRow(positionRows);
  const marketRatio = latestRow(marketRows);
  const funding = fundingRows[0] ?? null;
  const openInterestRow = openInterestPayload.openInterestList?.find((row) => safeSymbol(row.symbol) === symbol)
    ?? openInterestPayload.openInterestList?.[0]
    ?? null;
  const now = Date.now();
  const collectedAt = new Date(now).toISOString();
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
  const timestamps = Object.values(providerTimestamps).filter((value): value is number => value != null);
  const sampleBucket = Math.floor(now / configuredIntervalMs());
  const raw: RawContext = {
    version: 'bitget-market-context.v2',
    sampleId: `${symbol}:${sampleBucket}`,
    sampleBucket,
    symbol,
    productType: PRODUCT_TYPE,
    collectedAt,
    sourceTimestamp: timestamps.length ? Math.min(...timestamps) : null,
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
      ...oiChanges(symbol, openInterest, now),
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
  const snapshot: BitgetMarketContextSnapshot = { ...raw, policy: evaluateBitgetLongContext(raw) };
  const previous = latestBySymbol.get(symbol);
  remember(snapshot);
  if (previous?.sampleId !== snapshot.sampleId) await appendSnapshot(snapshot);
  return snapshot;
}

export async function collectBitgetMarketContextOnce(symbols = symbolsFromEnv()): Promise<{
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
        failures.push({ symbol, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      }
      await delay(REQUEST_DELAY_MS);
    }
    if (failures.length) lastError = failures.map((item) => `${item.symbol}:${item.error}`).join(' | ').slice(0, 1_000);
    lastCompletedAt = new Date().toISOString();
    return { collected, failures };
  } finally {
    collectorRunning = false;
  }
}

export function getBitgetMarketContextStatus() {
  return {
    enabled: collectorEnabled(),
    running: collectorRunning,
    intervalMs: configuredIntervalMs(),
    symbols: symbolsFromEnv(),
    dataDirectory: dataDirectory(),
    retentionDays: configuredRetentionDays(),
    lastStartedAt,
    lastCompletedAt,
    lastError,
    latestCount: latestBySymbol.size,
  };
}

export async function getLatestBitgetMarketContext(symbol?: string | null): Promise<BitgetMarketContextSnapshot[]> {
  if (symbol) {
    const normalized = safeSymbol(symbol);
    await loadRecent(normalized);
    const snapshot = latestBySymbol.get(normalized);
    return snapshot ? [snapshot] : [];
  }
  for (const configured of symbolsFromEnv()) await loadRecent(configured);
  return Array.from(latestBySymbol.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

export async function readBitgetMarketContextHistory(symbolValue: string, options: HistoryOptions = {}) {
  const symbol = safeSymbol(symbolValue);
  if (!symbol) return [];
  const from = options.from ? Date.parse(options.from) : Number.NEGATIVE_INFINITY;
  const to = options.to ? Date.parse(options.to) : Number.POSITIVE_INFINITY;
  const limit = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(options.limit ?? 500)));
  const rows: BitgetMarketContextSnapshot[] = [];
  try {
    const directories = (await readdir(dataDirectory(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const directory of directories) {
      if (rows.length >= limit) break;
      const file = path.join(dataDirectory(), directory, `${symbol}.jsonl`);
      try {
        if (!(await stat(file)).isFile()) continue;
        const content = await readFile(file, 'utf8');
        for (const line of content.split(/\r?\n/).filter(Boolean).reverse()) {
          try {
            const item = JSON.parse(line) as BitgetMarketContextSnapshot;
            const timestamp = Date.parse(item.collectedAt);
            if (item.symbol === symbol && timestamp >= from && timestamp <= to) rows.push(item);
          } catch {
            // Ignore malformed line.
          }
          if (rows.length >= limit) break;
        }
      } catch {
        // Missing date file is normal.
      }
    }
  } catch {
    return [];
  }
  return rows.sort((left, right) => Date.parse(left.collectedAt) - Date.parse(right.collectedAt));
}

export function startBitgetMarketContextCollector(): void {
  if (collectorTimer || !collectorEnabled()) return;
  const run = () => {
    void collectBitgetMarketContextOnce().catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      console.error('bitget market context collector error:', error);
    });
  };
  const initial = setTimeout(run, 15_000);
  initial.unref?.();
  collectorTimer = setInterval(run, configuredIntervalMs());
  collectorTimer.unref?.();
  console.log(`[api-server] Bitget context collector enabled (${configuredIntervalMs()}ms)`);
}

import { classifyAssetType, type AssetType } from '../data/asset-type';
import type { CatalogEntry } from '../data/catalog';

interface FinnhubSymbolRow {
  currency?: string;
  description?: string;
  displaySymbol?: string;
  mic?: string;
  symbol?: string;
  type?: string;
}

export interface UsUniverseEntry extends CatalogEntry {
  assetType: AssetType;
  exchange: 'NASDAQ' | 'NYSE' | 'AMEX' | 'US';
  listingStatus: 'LISTED';
  source: 'finnhub-symbol-master';
  rawType: string;
}

const BASE = 'https://finnhub.io/api/v1';
const CACHE_MS = 12 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
let cache: { at: number; rows: UsUniverseEntry[] } | null = null;

function finnhubKey(): string {
  return String(
    process.env.FINNHUB_API_KEY
      ?? process.env.VITE_FINNHUB_API_KEY
      ?? process.env.FINNHUB_KEY
      ?? '',
  ).trim();
}

function normalizeExchange(mic?: string): UsUniverseEntry['exchange'] {
  const value = String(mic ?? '').toUpperCase();
  if (['XNAS', 'XNMS', 'XNCM', 'XNGS'].includes(value)) return 'NASDAQ';
  if (value === 'XNYS') return 'NYSE';
  if (['XASE', 'ARCX', 'BATS', 'AMEX'].includes(value)) return 'AMEX';
  return 'US';
}

function cleanTicker(value?: string): string {
  return String(value ?? '').normalize('NFKC').trim().toUpperCase();
}

function cleanName(row: FinnhubSymbolRow): string {
  return String(row.description ?? row.displaySymbol ?? row.symbol ?? '')
    .normalize('NFKC')
    .trim();
}

function tradableTicker(ticker: string): boolean {
  return ticker.length > 0
    && ticker.length <= 15
    && !ticker.includes('/')
    && !ticker.includes(' ')
    && /^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/.test(ticker);
}

function leveraged(value: string): boolean {
  return /(?:2x|3x|bull|ultra|leveraged)/i.test(value);
}

function inverse(value: string): boolean {
  return /(?:inverse|short|bear)/i.test(value);
}

function assetType(row: FinnhubSymbolRow): AssetType {
  const merged = `${cleanName(row)} ${String(row.type ?? '')}`.toLowerCase();
  if (merged.includes('etn')) {
    if (leveraged(merged)) return 'LEVERAGED_ETN';
    if (inverse(merged)) return 'INVERSE_ETN';
    return 'ETN';
  }
  if (merged.includes('etf') || merged.includes('etp') || merged.includes('fund')) {
    if (leveraged(merged)) return 'LEVERAGED_ETF';
    if (inverse(merged)) return 'INVERSE_ETF';
    return 'ETF';
  }
  if (merged.includes('adr')) return 'ADR';
  if (merged.includes('reit')) return 'REIT';
  return classifyAssetType(cleanName(row), 'US');
}

function supportedAsset(value: AssetType): boolean {
  return [
    'STOCK', 'ADR', 'REIT', 'ETF', 'ETN',
    'LEVERAGED_ETF', 'INVERSE_ETF', 'LEVERAGED_ETN', 'INVERSE_ETN',
  ].includes(value);
}

function linkedAbortSignal(parent?: AbortSignal): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('US_UNIVERSE_TIMEOUT')),
    REQUEST_TIMEOUT_MS,
  );
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
    },
  };
}

export function clearUsUniverseCacheForTests(): void {
  cache = null;
}

export async function getUsUniverse(signal?: AbortSignal): Promise<UsUniverseEntry[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const lastGood = cache?.rows ?? [];
  const token = finnhubKey();
  if (!token) return lastGood;

  const linked = linkedAbortSignal(signal);
  try {
    const response = await fetch(
      `${BASE}/stock/symbol?exchange=US&token=${encodeURIComponent(token)}`,
      { signal: linked.signal, headers: { Accept: 'application/json' } },
    );
    if (!response.ok) return lastGood;
    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) return lastGood;

    const rows: UsUniverseEntry[] = [];
    const seen = new Set<string>();
    for (const raw of payload as FinnhubSymbolRow[]) {
      const ticker = cleanTicker(raw.symbol);
      const name = cleanName(raw);
      if (!tradableTicker(ticker) || !name) continue;
      const detectedAssetType = assetType(raw);
      if (!supportedAsset(detectedAssetType)) continue;
      const exchange = normalizeExchange(raw.mic);
      const key = `${exchange}:${ticker}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        ticker,
        name,
        market: 'US',
        currency: 'USD',
        assetType: detectedAssetType,
        exchange,
        listingStatus: 'LISTED',
        source: 'finnhub-symbol-master',
        rawType: String(raw.type ?? ''),
      });
    }
    rows.sort((left, right) => left.ticker.localeCompare(right.ticker));
    if (!rows.length) return lastGood;
    cache = { at: Date.now(), rows };
    return rows;
  } catch (error) {
    if (signal?.aborted) throw error;
    return lastGood;
  } finally {
    linked.clear();
  }
}

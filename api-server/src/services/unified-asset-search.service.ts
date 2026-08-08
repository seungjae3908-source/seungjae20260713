import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { aliasesForAsset } from '../data/search-aliases';
import { getKrUniverse } from '../providers/krx';
import { getUsUniverse } from '../providers/us-universe';
import {
  canonicalProductCode,
  createUnifiedAssetId,
  searchUnifiedAssetDocuments,
  type UnifiedAssetDocument,
  type UnifiedAssetType,
  type UnifiedSearchMarket,
} from '../lib/search-normalization';

const UPBIT_MARKETS_URL = 'https://api.upbit.com/v1/market/all?isDetails=true';
const BITGET_CONTRACTS_URL = 'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES';
const INDEX_VERSION = 1;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

type ProviderKey = 'krx' | 'finnhub' | 'upbit' | 'bitget';
type ProviderStatusValue = 'ok' | 'stale' | 'error';

export interface UnifiedSearchProviderStatus {
  provider: ProviderKey;
  status: ProviderStatusValue;
  count: number;
  dataAsOf: string | null;
  message?: string;
}

export interface UnifiedAssetSearchSnapshot {
  version: number;
  builtAt: string;
  documents: UnifiedAssetDocument[];
  providers: UnifiedSearchProviderStatus[];
}

export interface UnifiedSearchSuggestion {
  id: string;
  assetType: UnifiedAssetType;
  market: UnifiedSearchMarket;
  instrumentType: 'stock' | 'spot' | 'futures';
  exchange: string;
  ticker?: string;
  symbol?: string;
  productCode: string;
  koreanName: string;
  englishName: string;
  displayName: string;
  baseSymbol: string;
  quoteCurrency: string;
  matchType: string;
  active: boolean;
  provider: string;
  dataAsOf: string;
}

export interface UnifiedSearchResponse {
  results: UnifiedSearchSuggestion[];
  count: number;
  dataAsOf: string | null;
  stale: boolean;
  partial: boolean;
  providers: UnifiedSearchProviderStatus[];
  hiddenMatches: Array<{ market: UnifiedSearchMarket; count: number }>;
}

let snapshot: UnifiedAssetSearchSnapshot | null = null;
let diskLoadAttempted = false;
let refreshPromise: Promise<UnifiedAssetSearchSnapshot> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

function apiRootDirectory() {
  const cwd = process.cwd();
  return path.basename(cwd) === 'api-server' ? cwd : path.join(cwd, 'api-server');
}

function cacheFilePath() {
  const configured = String(process.env.UNIFIED_SEARCH_INDEX_CACHE_FILE ?? '').trim();
  return configured ? path.resolve(configured) : path.join(apiRootDirectory(), 'data', 'unified-asset-search-index.json');
}

function nowIso() {
  return new Date().toISOString();
}

function validTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function snapshotDataAsOf(current: UnifiedAssetSearchSnapshot): string | null {
  const providerTimes = current.providers
    .map((provider) => validTimestamp(provider.dataAsOf))
    .filter((value): value is number => value != null);
  if (providerTimes.length > 0) return new Date(Math.min(...providerTimes)).toISOString();
  const builtAt = validTimestamp(current.builtAt);
  return builtAt == null ? null : new Date(builtAt).toISOString();
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'seungjae-stock-search/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

function withAliases(document: UnifiedAssetDocument): UnifiedAssetDocument {
  const lookup = document.assetType === 'stock'
    ? document.ticker ?? document.productCode
    : document.baseSymbol;
  const manual = aliasesForAsset(document.assetType, document.market, lookup);
  if (!manual) return document;
  const koreanName = manual.koreanName || document.koreanName;
  const englishName = manual.englishName || document.englishName;
  const aliases = Array.from(new Set([
    ...document.aliases,
    ...manual.aliases,
    manual.koreanName ?? '',
    manual.englishName ?? '',
  ].map((item) => item.trim()).filter(Boolean)));
  return {
    ...document,
    koreanName,
    englishName,
    displayName: koreanName || document.displayName || englishName || document.productCode,
    aliases,
  };
}

function finalizeDocument(input: Omit<UnifiedAssetDocument, 'id'>): UnifiedAssetDocument {
  const document = {
    ...input,
    exchange: canonicalProductCode(input.exchange),
    productCode: canonicalProductCode(input.productCode),
    ticker: input.ticker ? canonicalProductCode(input.ticker) : undefined,
    symbol: input.symbol ? canonicalProductCode(input.symbol) : undefined,
    baseSymbol: canonicalProductCode(input.baseSymbol),
    quoteCurrency: canonicalProductCode(input.quoteCurrency),
  } as UnifiedAssetDocument;
  document.id = createUnifiedAssetId(document);
  return withAliases(document);
}

async function loadKrxDocuments(): Promise<UnifiedAssetDocument[]> {
  const dataAsOf = nowIso();
  const rows = await getKrUniverse();
  return rows.map((row, index) => finalizeDocument({
    assetType: 'stock',
    market: 'KR',
    instrumentType: 'stock',
    exchange: row.marketName.includes('코스닥') ? 'KOSDAQ' : row.marketName.includes('코넥스') ? 'KONEX' : row.marketName.includes('ETF') ? 'KRX' : 'KOSPI',
    ticker: row.ticker,
    productCode: row.ticker,
    koreanName: row.name,
    englishName: '',
    displayName: row.name,
    aliases: [],
    baseSymbol: row.ticker,
    quoteCurrency: 'KRW',
    active: true,
    provider: 'KRX',
    dataAsOf,
    liquidityRank: index + 1,
  }));
}

async function loadUsDocuments(): Promise<UnifiedAssetDocument[]> {
  const dataAsOf = nowIso();
  const rows = await getUsUniverse();
  return rows.map((row, index) => finalizeDocument({
    assetType: 'stock',
    market: 'US',
    instrumentType: 'stock',
    exchange: row.exchange,
    ticker: row.ticker,
    productCode: row.ticker,
    koreanName: '',
    englishName: row.name,
    displayName: row.name,
    aliases: [],
    baseSymbol: row.ticker,
    quoteCurrency: row.currency || 'USD',
    active: true,
    provider: 'FINNHUB',
    dataAsOf,
    liquidityRank: index + 1,
  }));
}

interface UpbitMarketRow {
  market?: string;
  korean_name?: string;
  english_name?: string;
  market_warning?: string;
}

async function loadUpbitDocuments(): Promise<UnifiedAssetDocument[]> {
  const dataAsOf = nowIso();
  const rows = await fetchJson<UpbitMarketRow[]>(UPBIT_MARKETS_URL);
  if (!Array.isArray(rows)) throw new Error('UPBIT_MARKET_LIST_INVALID');
  return rows
    .filter((row) => String(row.market ?? '').startsWith('KRW-'))
    .map((row, index) => {
      const productCode = canonicalProductCode(row.market);
      const baseSymbol = productCode.replace(/^KRW-/, '');
      return finalizeDocument({
        assetType: 'coin',
        market: 'spot',
        instrumentType: 'spot',
        exchange: 'UPBIT',
        symbol: baseSymbol,
        productCode,
        koreanName: String(row.korean_name ?? ''),
        englishName: String(row.english_name ?? ''),
        displayName: String(row.korean_name ?? row.english_name ?? baseSymbol),
        aliases: [baseSymbol, `${baseSymbol}/KRW`, `${baseSymbol}-KRW`, `KRW-${baseSymbol}`],
        baseSymbol,
        quoteCurrency: 'KRW',
        active: true,
        provider: 'UPBIT',
        dataAsOf,
        liquidityRank: index + 1,
      });
    });
}

interface BitgetContractsPayload {
  code?: string;
  data?: Array<{
    symbol?: string;
    baseCoin?: string;
    quoteCoin?: string;
    symbolStatus?: string;
    symbolType?: string;
  }>;
}

async function loadBitgetDocuments(): Promise<UnifiedAssetDocument[]> {
  const dataAsOf = nowIso();
  const payload = await fetchJson<BitgetContractsPayload>(BITGET_CONTRACTS_URL);
  if (String(payload.code ?? '') !== '00000' || !Array.isArray(payload.data)) {
    throw new Error(`BITGET_CONTRACT_LIST_${String(payload.code ?? 'INVALID')}`);
  }
  return payload.data.map((row, index) => {
    const productCode = canonicalProductCode(row.symbol);
    const quoteCurrency = canonicalProductCode(row.quoteCoin || 'USDT');
    const baseSymbol = canonicalProductCode(row.baseCoin || productCode.replace(new RegExp(`${quoteCurrency}$`), ''));
    const status = String(row.symbolStatus ?? '').toLowerCase();
    return finalizeDocument({
      assetType: 'coin',
      market: 'futures',
      instrumentType: 'futures',
      exchange: 'BITGET',
      symbol: productCode,
      productCode,
      koreanName: '',
      englishName: baseSymbol,
      displayName: baseSymbol,
      aliases: [baseSymbol, `${baseSymbol}/${quoteCurrency}`, `${baseSymbol}-${quoteCurrency}`],
      baseSymbol,
      quoteCurrency,
      active: status === 'normal' || status === 'listed' || status === 'online' || status === '',
      provider: 'BITGET',
      dataAsOf,
      liquidityRank: index + 1,
    });
  });
}

const PROVIDER_LOADERS: Record<ProviderKey, () => Promise<UnifiedAssetDocument[]>> = {
  krx: loadKrxDocuments,
  finnhub: loadUsDocuments,
  upbit: loadUpbitDocuments,
  bitget: loadBitgetDocuments,
};

function providerForDocument(document: UnifiedAssetDocument): ProviderKey | null {
  const value = document.provider.toUpperCase();
  if (value === 'KRX') return 'krx';
  if (value === 'FINNHUB') return 'finnhub';
  if (value === 'UPBIT') return 'upbit';
  if (value === 'BITGET') return 'bitget';
  return null;
}

function documentsForProvider(current: UnifiedAssetSearchSnapshot | null, provider: ProviderKey) {
  return (current?.documents ?? []).filter((document) => providerForDocument(document) === provider);
}

function dedupeDocuments(documents: UnifiedAssetDocument[]) {
  const map = new Map<string, UnifiedAssetDocument>();
  for (const document of documents) map.set(document.id, document);
  return [...map.values()];
}

async function loadDiskSnapshot() {
  if (diskLoadAttempted) return;
  diskLoadAttempted = true;
  try {
    const parsed = JSON.parse(await readFile(cacheFilePath(), 'utf8')) as UnifiedAssetSearchSnapshot;
    if (parsed.version === INDEX_VERSION && Array.isArray(parsed.documents) && parsed.documents.length > 0) {
      snapshot = parsed;
    }
  } catch {
    // A missing or invalid cache is a normal first-run state.
  }
}

async function persistSnapshot(next: UnifiedAssetSearchSnapshot) {
  try {
    const target = cacheFilePath();
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(next), 'utf8');
  } catch (error) {
    console.warn('[unified-search] index cache write failed:', error instanceof Error ? error.message : 'unknown');
  }
}

export async function refreshUnifiedAssetSearchIndex(): Promise<UnifiedAssetSearchSnapshot> {
  await loadDiskSnapshot();
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const previous = snapshot;
    const providerKeys = Object.keys(PROVIDER_LOADERS) as ProviderKey[];
    const settled = await Promise.allSettled(
      providerKeys.map(async (provider) => ({
        provider,
        rows: await PROVIDER_LOADERS[provider](),
      })),
    );
    const documents: UnifiedAssetDocument[] = [];
    const providers: UnifiedSearchProviderStatus[] = [];

    settled.forEach((result, index) => {
      const provider = providerKeys[index];
      if (result.status === 'fulfilled' && result.value.rows.length > 0) {
        documents.push(...result.value.rows);
        providers.push({ provider, status: 'ok', count: result.value.rows.length, dataAsOf: result.value.rows[0]?.dataAsOf ?? nowIso() });
        return;
      }
      const fallback = documentsForProvider(previous, provider);
      if (fallback.length > 0) {
        documents.push(...fallback);
        providers.push({ provider, status: 'stale', count: fallback.length, dataAsOf: fallback[0]?.dataAsOf ?? previous?.builtAt ?? null, message: '공급자 갱신 실패로 마지막 정상 인덱스를 사용합니다.' });
        return;
      }
      providers.push({ provider, status: 'error', count: 0, dataAsOf: null, message: result.status === 'rejected' && result.reason instanceof Error ? result.reason.message : '공급자 목록을 불러오지 못했습니다.' });
    });

    const next: UnifiedAssetSearchSnapshot = {
      version: INDEX_VERSION,
      builtAt: nowIso(),
      documents: dedupeDocuments(documents),
      providers,
    };
    if (next.documents.length === 0 && previous?.documents.length) return previous;
    snapshot = next;
    await persistSnapshot(next);
    return next;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function ensureSnapshot(): Promise<UnifiedAssetSearchSnapshot> {
  await loadDiskSnapshot();
  if (!snapshot) return refreshUnifiedAssetSearchIndex();
  const age = Date.now() - Date.parse(snapshot.builtAt);
  if (age >= REFRESH_INTERVAL_MS) void refreshUnifiedAssetSearchIndex().catch(() => undefined);
  return snapshot;
}

function isStale(current: UnifiedAssetSearchSnapshot) {
  const builtAt = validTimestamp(current.builtAt);
  return builtAt == null
    || Date.now() - builtAt > STALE_AFTER_MS
    || current.providers.some((provider) => provider.status === 'stale');
}

function hiddenMarketMatches(documents: UnifiedAssetDocument[], query: string, asset: 'all' | UnifiedAssetType, market: UnifiedSearchMarket | null) {
  if (!market) return [];
  const all = searchUnifiedAssetDocuments(documents, query, { asset, limit: 50 });
  const counts = new Map<UnifiedSearchMarket, number>();
  for (const item of all) {
    if (item.document.market === market) continue;
    counts.set(item.document.market, (counts.get(item.document.market) ?? 0) + 1);
  }
  return [...counts.entries()].map(([matchedMarket, count]) => ({ market: matchedMarket, count }));
}

export async function searchUnifiedAssets(input: {
  q: string;
  asset?: 'all' | UnifiedAssetType;
  market?: UnifiedSearchMarket | null;
  limit?: number;
}): Promise<UnifiedSearchResponse> {
  const current = await ensureSnapshot();
  const asset = input.asset ?? 'all';
  const results = searchUnifiedAssetDocuments(current.documents, input.q, {
    asset,
    market: input.market,
    limit: input.limit,
  }).map(({ document, matchType }) => ({
    id: document.id,
    assetType: document.assetType,
    market: document.market,
    instrumentType: document.instrumentType,
    exchange: document.exchange,
    ticker: document.ticker,
    symbol: document.symbol,
    productCode: document.productCode,
    koreanName: document.koreanName,
    englishName: document.englishName,
    displayName: document.displayName,
    baseSymbol: document.baseSymbol,
    quoteCurrency: document.quoteCurrency,
    matchType,
    active: document.active,
    provider: document.provider,
    dataAsOf: document.dataAsOf,
  }));
  return {
    results,
    count: results.length,
    dataAsOf: snapshotDataAsOf(current),
    stale: isStale(current),
    partial: current.providers.some((provider) => provider.status !== 'ok'),
    providers: current.providers,
    hiddenMatches: hiddenMarketMatches(current.documents, input.q, asset, input.market ?? null),
  };
}

export async function getUnifiedAssetSearchStatus() {
  const current = await ensureSnapshot();
  return {
    ok: current.documents.length > 0,
    count: current.documents.length,
    dataAsOf: snapshotDataAsOf(current),
    stale: isStale(current),
    partial: current.providers.some((provider) => provider.status !== 'ok'),
    providers: current.providers,
  };
}

export function startUnifiedAssetSearchRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshUnifiedAssetSearchIndex().catch((error) => {
      console.warn('[unified-search] scheduled refresh failed:', error instanceof Error ? error.message : 'unknown');
    });
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref();
}

export function replaceUnifiedAssetSearchSnapshotForTests(next: UnifiedAssetSearchSnapshot | null) {
  snapshot = next;
  diskLoadAttempted = true;
}

export function resetUnifiedAssetSearchStateForTests() {
  snapshot = null;
  diskLoadAttempted = true;
  refreshPromise = null;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

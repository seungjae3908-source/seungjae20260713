export type MarketInformationRoomId = 'stocks-kr' | 'stocks-us' | 'coins-spot' | 'coins-futures';
export type MarketInformationSectionStatus = 'ready' | 'empty' | 'partial' | 'stale' | 'unsupported' | 'unavailable' | 'error';
export type MarketInformationMarket = 'KR' | 'US' | 'spot' | 'futures';
export type MarketInformationAssetType = 'stock' | 'coin-spot' | 'coin-futures';
export type MarketInformationCurrency = 'KRW' | 'USD' | 'USDT';

export interface MarketInformationMeta {
  provider: string | null;
  source: string | null;
  market: MarketInformationMarket;
  assetType: MarketInformationAssetType;
  currency: MarketInformationCurrency;
  providerUpdatedAt: string | null;
  observedAt: string | null;
  fetchedAt: string;
  marketTimeZone: string;
  marketStatus: 'OPEN' | 'CLOSED' | '24H' | 'UNKNOWN';
  isDelayed: boolean;
  isStale: boolean;
  partial: boolean;
  unavailableFields: string[];
  errorCode: string | null;
  retryable: boolean;
}

export interface MarketInformationSection<T> {
  status: MarketInformationSectionStatus;
  data: T;
  meta: MarketInformationMeta;
  message: string | null;
}

export interface MarketInformationAssetRow {
  symbol: string;
  name: string;
  exchange: string;
  currency: MarketInformationCurrency;
  price: number | null;
  changePercent: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  tradingValue24h: number | null;
  marketCap: number | null;
  warning: boolean;
  tradingStatus: string | null;
  fundingRatePercent: number | null;
  nextFundingAt: string | null;
  openInterest: number | null;
  rangeVolatility24hPercent: number | null;
  providerUpdatedAt: string | null;
}

export interface MarketInformationIndexRow {
  key: string;
  label: string;
  value: number | null;
  changePercent: number | null;
}

export interface MarketInformationSectorRow {
  key: string;
  label: string;
  tradingValue: number | null;
  constituentCount: number;
  changePercent: number | null;
}

export interface MarketInformationNewsRow {
  id: string;
  kind: 'news' | 'disclosure';
  symbol: string;
  title: string;
  summary: string | null;
  provider: string;
  source: string;
  url: string;
  publishedAt: string;
}

export interface MarketInformationDerivativesData {
  referenceSymbol: string;
  longRatio: number | null;
  shortRatio: number | null;
  longShortRatio: number | null;
  ratioObservedAt: string | null;
  liquidations: Array<{
    symbol: string;
    side: 'long' | 'short' | 'unknown';
    price: number | null;
    amount: number | null;
    occurredAt: string | null;
  }>;
}

export interface MarketInformationResponse {
  ok: true;
  room: MarketInformationRoomId;
  market: MarketInformationMarket;
  assetType: MarketInformationAssetType;
  currency: MarketInformationCurrency;
  fetchedAt: string;
  partial: boolean;
  sections: {
    indices: MarketInformationSection<MarketInformationIndexRow[]>;
    rankings: MarketInformationSection<MarketInformationAssetRow[]>;
    sectors: MarketInformationSection<MarketInformationSectorRow[]>;
    news: MarketInformationSection<MarketInformationNewsRow[]>;
    disclosures: MarketInformationSection<MarketInformationNewsRow[]>;
    derivatives: MarketInformationSection<MarketInformationDerivativesData>;
  };
  requestPolicy: {
    publicMarketDataOnly: true;
    privateExchangeRequests: 0;
    accountRequests: 0;
    balanceRequests: 0;
    positionRequests: 0;
    orderRequests: 0;
    cancelRequests: 0;
    aiRequests: 0;
  };
}

export type JsonObject = Record<string, unknown>;
const FUTURE_TOLERANCE_MS = 5 * 60_000;

export const ROOM_CONFIG: Record<MarketInformationRoomId, {
  market: MarketInformationMarket;
  assetType: MarketInformationAssetType;
  currency: MarketInformationCurrency;
  timeZone: string;
}> = {
  'stocks-kr': { market: 'KR', assetType: 'stock', currency: 'KRW', timeZone: 'Asia/Seoul' },
  'stocks-us': { market: 'US', assetType: 'stock', currency: 'USD', timeZone: 'America/New_York' },
  'coins-spot': { market: 'spot', assetType: 'coin-spot', currency: 'KRW', timeZone: 'Asia/Seoul' },
  'coins-futures': { market: 'futures', assetType: 'coin-futures', currency: 'USDT', timeZone: 'UTC' },
};

export function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function finite(value: unknown): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nonNegative(value: unknown): number | null {
  const parsed = finite(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

export function positive(value: unknown): number | null {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

export function timestampMs(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const numeric = finite(value);
  if (numeric != null && numeric > 0) {
    const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(milliseconds) ? Math.trunc(milliseconds) : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function safeIso(value: unknown, now = Date.now()): string | null {
  const timestamp = timestampMs(value);
  if (timestamp == null || timestamp > now + FUTURE_TOLERANCE_MS) return null;
  return new Date(timestamp).toISOString();
}

export function latestIso(values: unknown[], now = Date.now()): string | null {
  const timestamps = values
    .map(timestampMs)
    .filter((value): value is number => value != null && value <= now + FUTURE_TOLERANCE_MS);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function marketStatus(market: MarketInformationMarket, now = new Date()): 'OPEN' | 'CLOSED' | '24H' | 'UNKNOWN' {
  if (market === 'spot' || market === 'futures') return '24H';
  const timeZone = market === 'KR' ? 'Asia/Seoul' : 'America/New_York';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
    const weekday = part('weekday');
    if (weekday === 'Sat' || weekday === 'Sun') return 'CLOSED';
    const minutes = Number(part('hour')) * 60 + Number(part('minute'));
    const open = market === 'KR' ? 540 : 570;
    const close = market === 'KR' ? 930 : 960;
    return minutes >= open && minutes < close ? 'OPEN' : 'CLOSED';
  } catch {
    return 'UNKNOWN';
  }
}

export function makeMeta(input: {
  room: MarketInformationRoomId;
  provider: string | null;
  source: string | null;
  providerUpdatedAt?: string | null;
  observedAt?: string | null;
  partial?: boolean;
  unavailableFields?: string[];
  errorCode?: string | null;
  retryable?: boolean;
  staleAfterMs?: number;
  forceStale?: boolean;
}): MarketInformationMeta {
  const config = ROOM_CONFIG[input.room];
  const providerUpdatedAt = input.providerUpdatedAt ?? null;
  const timestamp = providerUpdatedAt ? Date.parse(providerUpdatedAt) : NaN;
  const age = Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : Number.POSITIVE_INFINITY;
  const staleAfterMs = input.staleAfterMs ?? 60_000;
  return {
    provider: input.provider,
    source: input.source,
    market: config.market,
    assetType: config.assetType,
    currency: config.currency,
    providerUpdatedAt,
    observedAt: input.observedAt ?? providerUpdatedAt,
    fetchedAt: new Date().toISOString(),
    marketTimeZone: config.timeZone,
    marketStatus: marketStatus(config.market),
    isDelayed: input.forceStale === true || age > staleAfterMs,
    isStale: input.forceStale === true || age > staleAfterMs * 3,
    partial: input.partial === true,
    unavailableFields: uniqueStrings(input.unavailableFields ?? []),
    errorCode: input.errorCode ?? null,
    retryable: input.retryable === true,
  };
}

export function section<T>(status: MarketInformationSectionStatus, data: T, meta: MarketInformationMeta, message: string | null = null): MarketInformationSection<T> {
  return { status, data, meta, message };
}

export function emptyDerivatives(): MarketInformationDerivativesData {
  return { referenceSymbol: 'BTCUSDT', longRatio: null, shortRatio: null, longShortRatio: null, ratioObservedAt: null, liquidations: [] };
}

export function isMarketInformationRoomId(value: unknown): value is MarketInformationRoomId {
  return typeof value === 'string' && Object.hasOwn(ROOM_CONFIG, value);
}

export function requireObjectArray(payload: unknown, provider: string): JsonObject[] {
  if (!Array.isArray(payload)) throw new Error(`${provider}_ARRAY_REQUIRED`);
  return payload.filter(isObject);
}

export function bitgetDataArray(payload: unknown, provider: string): JsonObject[] {
  if (!isObject(payload) || String(payload.code ?? '') !== '00000' || !Array.isArray(payload.data)) {
    throw new Error(`${provider}_INVALID_RESPONSE`);
  }
  return payload.data.filter(isObject);
}

function dedupeAssets(rows: MarketInformationAssetRow[]): MarketInformationAssetRow[] {
  const result = new Map<string, MarketInformationAssetRow>();
  for (const row of rows) if (!result.has(row.symbol)) result.set(row.symbol, row);
  return [...result.values()];
}

export function normalizeUpbitMarkets(payload: unknown): Array<{ market: string; symbol: string; name: string; warning: boolean }> {
  const result = new Map<string, { market: string; symbol: string; name: string; warning: boolean }>();
  for (const row of requireObjectArray(payload, 'UPBIT_MARKETS')) {
    const market = String(row.market ?? '').trim().toUpperCase();
    if (!market.startsWith('KRW-')) continue;
    const symbol = market.slice(4);
    if (!symbol) continue;
    result.set(market, {
      market,
      symbol,
      name: String(row.korean_name ?? row.english_name ?? symbol).trim() || symbol,
      warning: String(row.market_warning ?? 'NONE').toUpperCase() !== 'NONE',
    });
  }
  return [...result.values()];
}

export function normalizeUpbitTickers(
  payload: unknown,
  names: Map<string, { name: string; warning: boolean }>,
  now = Date.now(),
): MarketInformationAssetRow[] {
  const result: MarketInformationAssetRow[] = [];
  for (const row of requireObjectArray(payload, 'UPBIT_TICKERS')) {
    const market = String(row.market ?? '').trim().toUpperCase();
    const symbol = market.startsWith('KRW-') ? market.slice(4) : '';
    const price = positive(row.trade_price);
    if (!symbol || price == null) continue;
    const master = names.get(market);
    const changeRate = finite(row.signed_change_rate);
    result.push({
      symbol,
      name: master?.name ?? symbol,
      exchange: 'UPBIT',
      currency: 'KRW',
      price,
      changePercent: changeRate == null ? null : changeRate * 100,
      high24h: positive(row.high_price),
      low24h: positive(row.low_price),
      volume24h: nonNegative(row.acc_trade_volume_24h),
      tradingValue24h: nonNegative(row.acc_trade_price_24h),
      marketCap: null,
      warning: master?.warning === true || String(row.market_warning ?? 'NONE').toUpperCase() !== 'NONE',
      tradingStatus: String(row.market_state ?? 'ACTIVE').trim() || null,
      fundingRatePercent: null,
      nextFundingAt: null,
      openInterest: null,
      rangeVolatility24hPercent: null,
      providerUpdatedAt: safeIso(row.timestamp ?? row.trade_timestamp, now),
    });
  }
  return dedupeAssets(result);
}

export function normalizeBitgetTickers(
  payload: unknown,
  contracts: Map<string, string>,
  funding: Map<string, { rate: number | null; next: string | null }>,
  now = Date.now(),
): MarketInformationAssetRow[] {
  const result: MarketInformationAssetRow[] = [];
  for (const row of bitgetDataArray(payload, 'BITGET_TICKERS')) {
    const symbol = String(row.symbol ?? '').trim().toUpperCase();
    const price = positive(row.lastPr);
    if (!symbol.endsWith('USDT') || price == null) continue;
    const high = positive(row.high24h);
    const low = positive(row.low24h);
    const change = finite(row.change24h);
    const tickerFunding = finite(row.fundingRate);
    const fundingItem = funding.get(symbol);
    const status = contracts.get(symbol) ?? String(row.deliveryStatus ?? '').trim();
    const volatility = high != null && low != null && low > 0 ? ((high - low) / low) * 100 : null;
    result.push({
      symbol,
      name: symbol,
      exchange: 'BITGET',
      currency: 'USDT',
      price,
      changePercent: change == null ? null : change * 100,
      high24h: high,
      low24h: low,
      volume24h: nonNegative(row.baseVolume),
      tradingValue24h: nonNegative(row.usdtVolume ?? row.quoteVolume),
      marketCap: null,
      warning: false,
      tradingStatus: status || null,
      fundingRatePercent: fundingItem?.rate != null ? fundingItem.rate * 100 : tickerFunding == null ? null : tickerFunding * 100,
      nextFundingAt: fundingItem?.next ?? null,
      openInterest: nonNegative(row.holdingAmount),
      rangeVolatility24hPercent: volatility != null && Number.isFinite(volatility) ? volatility : null,
      providerUpdatedAt: safeIso(row.ts, now),
    });
  }
  return dedupeAssets(result);
}

export function normalizeBitgetDerivatives(longShortPayload: unknown, liquidationPayload: unknown): MarketInformationDerivativesData {
  const ratioRows = bitgetDataArray(longShortPayload, 'BITGET_LONG_SHORT');
  const latest = ratioRows.at(0);
  if (!isObject(liquidationPayload) || String(liquidationPayload.code ?? '') !== '00000' || !isObject(liquidationPayload.data) || !Array.isArray(liquidationPayload.data.list)) {
    throw new Error('BITGET_LIQUIDATIONS_INVALID_RESPONSE');
  }
  const liquidations = liquidationPayload.data.list
    .filter(isObject)
    .map((row) => {
      const side = String(row.side ?? '').toLowerCase();
      return {
        symbol: String(row.symbol ?? '').trim().toUpperCase(),
        side: side === 'buy' ? 'long' as const : side === 'sell' ? 'short' as const : 'unknown' as const,
        price: positive(row.price),
        amount: nonNegative(row.amount),
        occurredAt: safeIso(row.ts),
      };
    })
    .filter((row) => row.symbol && row.occurredAt != null);
  return {
    referenceSymbol: 'BTCUSDT',
    longRatio: finite(latest?.longRatio),
    shortRatio: finite(latest?.shortRatio),
    longShortRatio: finite(latest?.longShortRatio),
    ratioObservedAt: safeIso(latest?.ts),
    liquidations,
  };
}

function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || key === 'ref' || key === 'source') url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function normalizedTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]+/g, '');
}

export function dedupeMarketNews(rows: MarketInformationNewsRow[], now = Date.now()): MarketInformationNewsRow[] {
  const result = new Map<string, MarketInformationNewsRow>();
  for (const row of rows) {
    const title = row.title.trim();
    const url = canonicalUrl(row.url);
    const published = Date.parse(row.publishedAt);
    if (!title || !url || !Number.isFinite(published) || published > now + FUTURE_TOLERANCE_MS) continue;
    const publishedAt = new Date(published).toISOString();
    const key = `${url}|${normalizedTitle(title)}|${row.provider}|${publishedAt}`;
    if (!result.has(key)) result.set(key, { ...row, title, url, publishedAt });
  }
  return [...result.values()].sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
}

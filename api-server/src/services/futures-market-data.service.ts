const BITGET_BASE_URL = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const BITGET_SOURCE = 'bitget';
const REQUEST_TIMEOUT_MS = 8_000;
const STATUS_TTL_MS = 10_000;
const SYMBOLS_TTL_MS = 10 * 60_000;
const SNAPSHOT_TTL_MS = 5_000;
const OI_MIN_COMPARE_MS = 60_000;
const OI_MAX_SAMPLE_AGE_MS = 30 * 60_000;
const MIN_ANALYSIS_CANDLES = 25;

export type DataStatus =
  | 'live'
  | 'delayed'
  | 'cached'
  | 'disconnected'
  | 'error'
  | 'insufficient';

export type NormalizedCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number | null;
  timeframe: string;
  symbol: string;
  market: 'crypto-futures';
  source: string;
  isClosed: boolean;
  isDelayed: boolean;
  updatedAt: string;
};

export type FuturesMarketSnapshot = {
  symbol: string;
  price: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  change24hPercent: number | null;
  volume24h: number | null;
  quoteVolume24h: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  spreadPercent: number | null;
  openInterest: number | null;
  previousOpenInterest: number | null;
  openInterestChangePercent: number | null;
  fundingRate: number | null;
  nextFundingAt: string | null;
  basis: number | null;
  basisPercent: number | null;
  source: string;
  status: DataStatus;
  isDelayed: boolean;
  updatedAt: string;
  warnings: string[];
};

export type FuturesStatusResponse = {
  ok: true;
  provider: 'bitget';
  market: 'crypto-futures';
  status: DataStatus;
  connection: DataStatus;
  publicDataOnly: true;
  orderCapability: false;
  symbolCount: number;
  updatedAt: string;
  warnings: string[];
};

export type FuturesCandlesResult = {
  symbol: string;
  timeframe: string;
  status: DataStatus;
  data: NormalizedCandle[];
  warnings: string[];
  updatedAt: string;
};

export class FuturesMarketDataError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FuturesMarketDataError';
  }
}

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type CacheLoad<T> = {
  value: T;
  fallback: boolean;
};

type OpenInterestSample = {
  value: number;
  capturedAt: number;
};

type JsonObject = Record<string, unknown>;

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
const openInterestSamples = new Map<string, OpenInterestSample[]>();

export const FUTURES_TIMEFRAME_MS: Readonly<Record<string, number>> = Object.freeze({
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1H': 60 * 60_000,
  '4H': 4 * 60 * 60_000,
  '6H': 6 * 60 * 60_000,
  '12H': 12 * 60 * 60_000,
  '1D': 24 * 60 * 60_000,
  '1W': 7 * 24 * 60 * 60_000,
});

const uniqueWarnings = (warnings: string[]) => [...new Set(warnings.filter(Boolean))];

export function toFiniteNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestamp(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed <= 0) return null;
  const milliseconds = parsed < 100_000_000_000 ? parsed * 1000 : parsed;
  return Number.isFinite(milliseconds) ? Math.trunc(milliseconds) : null;
}

export function normalizeFuturesSymbol(value: unknown): string | null {
  const compact = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s/_-]+/g, '');
  if (!/^[A-Z0-9]{2,20}$/.test(compact)) return null;
  const normalized = compact.endsWith('USDT') ? compact : `${compact}USDT`;
  return /^[A-Z0-9]{2,16}USDT$/.test(normalized) ? normalized : null;
}

export function calculateBasis(
  markPrice: number | null,
  indexPrice: number | null,
): { basis: number | null; basisPercent: number | null } {
  if (markPrice == null || indexPrice == null || indexPrice <= 0) {
    return { basis: null, basisPercent: null };
  }
  const basis = markPrice - indexPrice;
  const basisPercent = (basis / indexPrice) * 100;
  return Number.isFinite(basis) && Number.isFinite(basisPercent)
    ? { basis, basisPercent }
    : { basis: null, basisPercent: null };
}

export function calculateSpreadPercent(
  bidPrice: number | null,
  askPrice: number | null,
): number | null {
  if (
    bidPrice == null ||
    askPrice == null ||
    bidPrice <= 0 ||
    askPrice < bidPrice
  ) {
    return null;
  }
  const midpoint = (bidPrice + askPrice) / 2;
  if (!(midpoint > 0)) return null;
  const spreadPercent = ((askPrice - bidPrice) / midpoint) * 100;
  return Number.isFinite(spreadPercent) ? spreadPercent : null;
}

export function calculateOpenInterestChangePercent(
  current: number | null,
  previous: number | null,
): number | null {
  if (current == null || previous == null || previous <= 0) return null;
  const percent = ((current - previous) / previous) * 100;
  return Number.isFinite(percent) ? percent : null;
}

function staleToleranceMs(timeframeMs: number) {
  return Math.max(30_000, Math.round(timeframeMs * 0.5));
}

export function classifyDataStatus(input: {
  now: number;
  lastTimestamp: number | null;
  timeframeMs?: number | null;
  count?: number;
  minimumCount?: number;
  cached?: boolean;
  externalError?: boolean;
  parseError?: boolean;
}): DataStatus {
  if (input.cached) return 'cached';
  if (input.parseError) return 'error';
  if (input.externalError && input.lastTimestamp == null) return 'disconnected';
  if ((input.count ?? 1) < (input.minimumCount ?? 1)) return 'insufficient';
  if (input.lastTimestamp == null) return 'insufficient';
  const timeframeMs = input.timeframeMs ?? 0;
  const staleAt = timeframeMs > 0
    ? input.lastTimestamp + timeframeMs + staleToleranceMs(timeframeMs)
    : input.lastTimestamp + 30_000;
  return input.now <= staleAt ? 'live' : 'delayed';
}

export function resolveSnapshotTimestampStatus(input: {
  now: number;
  sourceTimestamps: unknown[];
  availableCoreValues: number;
}): {
  sourceTimestamp: number | null;
  status: DataStatus;
  warning: string | null;
} {
  const sourceTimes = input.sourceTimestamps
    .map(normalizeTimestamp)
    .filter((value): value is number => value != null);
  const sourceTimestamp = sourceTimes.length ? Math.max(...sourceTimes) : null;
  return {
    sourceTimestamp,
    status: classifyDataStatus({
      now: input.now,
      lastTimestamp: sourceTimestamp,
      count: input.availableCoreValues,
      minimumCount: 2,
    }),
    warning: sourceTimestamp == null
      ? '거래소 데이터 시각을 확인할 수 없습니다.'
      : null,
  };
}

export function normalizeBitgetCandles(
  rows: unknown,
  symbol: string,
  timeframe: string,
  now = Date.now(),
): FuturesCandlesResult {
  const warnings: string[] = [];
  const duration = FUTURES_TIMEFRAME_MS[timeframe];
  if (!duration) {
    return {
      symbol,
      timeframe,
      status: 'error',
      data: [],
      warnings: ['지원하지 않는 시간봉입니다.'],
      updatedAt: new Date(now).toISOString(),
    };
  }

  if (!Array.isArray(rows)) {
    return {
      symbol,
      timeframe,
      status: 'error',
      data: [],
      warnings: ['거래소 캔들 응답 형식이 올바르지 않습니다.'],
      updatedAt: new Date(now).toISOString(),
    };
  }

  let invalidShape = 0;
  let invalidNumber = 0;
  let invalidOhlc = 0;
  let invalidVolume = 0;
  let duplicateCount = 0;
  let missingQuoteVolume = 0;
  const byTimestamp = new Map<number, NormalizedCandle>();

  for (const raw of rows) {
    if (!Array.isArray(raw) || raw.length < 6) {
      invalidShape += 1;
      continue;
    }
    const timestamp = normalizeTimestamp(raw[0]);
    const open = toFiniteNumber(raw[1]);
    const high = toFiniteNumber(raw[2]);
    const low = toFiniteNumber(raw[3]);
    const close = toFiniteNumber(raw[4]);
    const volume = toFiniteNumber(raw[5]);
    const quoteVolume = toFiniteNumber(raw[6]);

    if (
      timestamp == null ||
      open == null ||
      high == null ||
      low == null ||
      close == null
    ) {
      invalidNumber += 1;
      continue;
    }
    if (
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      high < low ||
      open > high ||
      open < low ||
      close > high ||
      close < low
    ) {
      invalidOhlc += 1;
      continue;
    }
    if (volume == null || volume < 0) {
      invalidVolume += 1;
      continue;
    }
    if (quoteVolume == null) missingQuoteVolume += 1;

    const isClosed = now >= timestamp + duration;
    const isDelayed = now > timestamp + duration + staleToleranceMs(duration);
    const candle: NormalizedCandle = {
      timestamp,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume: quoteVolume != null && quoteVolume >= 0 ? quoteVolume : null,
      timeframe,
      symbol,
      market: 'crypto-futures',
      source: BITGET_SOURCE,
      isClosed,
      isDelayed,
      updatedAt: new Date(now).toISOString(),
    };
    if (byTimestamp.has(timestamp)) duplicateCount += 1;
    byTimestamp.set(timestamp, candle);
  }

  if (invalidShape) warnings.push(`형식이 잘못된 캔들 ${invalidShape}개를 제거했습니다.`);
  if (invalidNumber) warnings.push(`숫자 변환에 실패한 캔들 ${invalidNumber}개를 제거했습니다.`);
  if (invalidOhlc) warnings.push(`OHLC 범위가 잘못된 캔들 ${invalidOhlc}개를 제거했습니다.`);
  if (invalidVolume) warnings.push(`거래량이 잘못된 캔들 ${invalidVolume}개를 제거했습니다.`);
  if (duplicateCount) warnings.push(`중복 timestamp 캔들 ${duplicateCount}개를 제거했습니다.`);
  if (missingQuoteVolume) warnings.push(`quoteVolume을 확인할 수 없는 캔들 ${missingQuoteVolume}개가 있습니다.`);

  const data = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  const lastTimestamp = data.at(-1)?.timestamp ?? null;
  const status = classifyDataStatus({
    now,
    lastTimestamp,
    timeframeMs: duration,
    count: data.length,
    minimumCount: MIN_ANALYSIS_CANDLES,
  });
  if (data.length === 0) warnings.push('사용 가능한 캔들 데이터가 없습니다.');
  else if (data.length < MIN_ANALYSIS_CANDLES) {
    warnings.push(`분석에 필요한 최소 ${MIN_ANALYSIS_CANDLES}개 캔들보다 데이터가 적습니다.`);
  }

  return {
    symbol,
    timeframe,
    status,
    data,
    warnings: uniqueWarnings(warnings),
    updatedAt: new Date(now).toISOString(),
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstObject(value: unknown): JsonObject | null {
  if (Array.isArray(value)) {
    const row = value.find(isObject);
    return row ?? null;
  }
  return isObject(value) ? value : null;
}

function payloadData(payload: unknown): unknown {
  return isObject(payload) ? payload.data : null;
}

function payloadRequestTime(payload: unknown): number | null {
  return isObject(payload) ? normalizeTimestamp(payload.requestTime) : null;
}

async function fetchBitget(path: string, params: Record<string, string>): Promise<JsonObject> {
  const url = new URL(path, BITGET_BASE_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'seungjae-investment-app/2.0',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`BITGET_HTTP_${response.status}`);
    const payload = await response.json() as unknown;
    if (!isObject(payload) || String(payload.code ?? '') !== '00000') {
      throw new Error('BITGET_INVALID_RESPONSE');
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('BITGET_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadWithCache<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<CacheLoad<T>> {
  const now = Date.now();
  const existing = cache.get(key) as CacheEntry<T> | undefined;
  if (existing && existing.expiresAt > now) return { value: existing.value, fallback: false };

  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return { value: await running, fallback: false };

  const promise = loader();
  inFlight.set(key, promise as Promise<unknown>);
  try {
    const value = await promise;
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    return { value, fallback: false };
  } catch (error) {
    if (existing) return { value: existing.value, fallback: true };
    throw error;
  } finally {
    inFlight.delete(key);
  }
}

async function getSupportedSymbols(): Promise<CacheLoad<Set<string>>> {
  return loadWithCache('futures:symbols', SYMBOLS_TTL_MS, async () => {
    const payload = await fetchBitget('/api/v2/mix/market/contracts', {
      productType: BITGET_PRODUCT_TYPE,
    });
    const rows = payloadData(payload);
    if (!Array.isArray(rows)) throw new Error('BITGET_CONTRACTS_INVALID');
    const symbols = new Set(
      rows
        .filter(isObject)
        .filter((row) => String(row.symbolStatus ?? '').toLowerCase() !== 'off')
        .map((row) => String(row.symbol ?? '').trim().toUpperCase())
        .filter(Boolean),
    );
    if (!symbols.size) throw new Error('BITGET_CONTRACTS_EMPTY');
    return symbols;
  });
}

async function assertSupportedSymbol(value: unknown): Promise<string> {
  const symbol = normalizeFuturesSymbol(value);
  if (!symbol) {
    throw new FuturesMarketDataError(400, 'INVALID_FUTURES_SYMBOL', '지원하지 않는 선물 심볼입니다.');
  }
  let supported: CacheLoad<Set<string>>;
  try {
    supported = await getSupportedSymbols();
  } catch {
    throw new FuturesMarketDataError(503, 'FUTURES_PROVIDER_DISCONNECTED', '선물 거래소 연결 상태를 확인할 수 없습니다.');
  }
  if (!supported.value.has(symbol)) {
    throw new FuturesMarketDataError(400, 'INVALID_FUTURES_SYMBOL', '지원하지 않는 선물 심볼입니다.');
  }
  return symbol;
}

function previousOpenInterest(symbol: string, current: number | null, now: number) {
  const samples = (openInterestSamples.get(symbol) ?? [])
    .filter((sample) => now - sample.capturedAt <= OI_MAX_SAMPLE_AGE_MS)
    .sort((a, b) => a.capturedAt - b.capturedAt);
  const previous = [...samples]
    .reverse()
    .find((sample) => now - sample.capturedAt >= OI_MIN_COMPARE_MS) ?? null;

  if (current != null) {
    const latest = samples.at(-1);
    if (!latest || latest.value !== current || now - latest.capturedAt >= 5_000) {
      samples.push({ value: current, capturedAt: now });
    }
    openInterestSamples.set(symbol, samples.slice(-60));
  }
  return previous?.value ?? null;
}

function safeIso(value: unknown): string | null {
  const timestamp = normalizeTimestamp(value);
  if (timestamp == null) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function buildSnapshot(symbol: string): Promise<FuturesMarketSnapshot> {
  const now = Date.now();
  const params = { symbol, productType: BITGET_PRODUCT_TYPE };
  const requests = await Promise.allSettled([
    fetchBitget('/api/v2/mix/market/ticker', params),
    fetchBitget('/api/v2/mix/market/symbol-price', params),
    fetchBitget('/api/v2/mix/market/open-interest', params),
    fetchBitget('/api/v2/mix/market/current-fund-rate', params),
    fetchBitget('/api/v2/mix/market/funding-time', params),
  ]);

  if (requests.every((request) => request.status === 'rejected')) {
    throw new Error('BITGET_SNAPSHOT_UNAVAILABLE');
  }

  const warnings: string[] = [];
  const names = ['시세', '마크·인덱스 가격', '미결제약정', '펀딩비', '다음 펀딩 시각'];
  requests.forEach((request, index) => {
    if (request.status === 'rejected') warnings.push(`Bitget ${names[index]} 응답을 확인하지 못했습니다.`);
  });

  const tickerPayload = requests[0].status === 'fulfilled' ? requests[0].value : null;
  const pricePayload = requests[1].status === 'fulfilled' ? requests[1].value : null;
  const oiPayload = requests[2].status === 'fulfilled' ? requests[2].value : null;
  const fundingPayload = requests[3].status === 'fulfilled' ? requests[3].value : null;
  const fundingTimePayload = requests[4].status === 'fulfilled' ? requests[4].value : null;

  const ticker = firstObject(payloadData(tickerPayload));
  const priceRow = firstObject(payloadData(pricePayload));
  const fundingRow = firstObject(payloadData(fundingPayload));
  const fundingTimeRow = firstObject(payloadData(fundingTimePayload));
  const oiData = firstObject(payloadData(oiPayload));
  const oiList = oiData?.openInterestList;
  const oiRow = firstObject(oiList);

  const price = toFiniteNumber(priceRow?.price ?? ticker?.lastPr);
  const markPrice = toFiniteNumber(priceRow?.markPrice ?? ticker?.markPrice);
  const indexPrice = toFiniteNumber(priceRow?.indexPrice ?? ticker?.indexPrice);
  const changeRate = toFiniteNumber(ticker?.change24h);
  const bidPrice = toFiniteNumber(ticker?.bidPr);
  const askPrice = toFiniteNumber(ticker?.askPr);
  const openInterest = toFiniteNumber(oiRow?.size ?? ticker?.holdingAmount);
  const previousOi = previousOpenInterest(symbol, openInterest, now);
  const oiChange = calculateOpenInterestChangePercent(openInterest, previousOi);
  const fundingRate = toFiniteNumber(fundingRow?.fundingRate ?? ticker?.fundingRate);
  const nextFundingAt = safeIso(fundingRow?.nextUpdate ?? fundingTimeRow?.nextFundingTime);
  const { basis, basisPercent } = calculateBasis(markPrice, indexPrice);
  const spreadPercent = calculateSpreadPercent(bidPrice, askPrice);

  if (openInterest != null && previousOi == null) {
    warnings.push('비교 가능한 이전 OI 표본이 없어 OI 변화율을 계산하지 않았습니다.');
  }
  if (nextFundingAt == null) {
    warnings.push('거래소 응답에서 다음 펀딩 시각을 확인할 수 없습니다.');
  }
  if (markPrice == null || indexPrice == null || indexPrice <= 0) {
    warnings.push('마크가격 또는 인덱스가격이 없어 베이시스를 계산하지 않았습니다.');
  }
  if (spreadPercent == null && (bidPrice != null || askPrice != null)) {
    warnings.push('bid·ask 관계가 올바르지 않아 스프레드를 계산하지 않았습니다.');
  }

  const availableCoreValues = [price, markPrice, indexPrice, openInterest, fundingRate]
    .filter((value) => value != null).length;
  const timestampStatus = resolveSnapshotTimestampStatus({
    now,
    sourceTimestamps: [
      ticker?.ts,
      priceRow?.ts,
      oiData?.ts,
      payloadRequestTime(tickerPayload),
      payloadRequestTime(pricePayload),
      payloadRequestTime(oiPayload),
    ],
    availableCoreValues,
  });
  const sourceTimestamp = timestampStatus.sourceTimestamp;
  const status = timestampStatus.status;
  if (timestampStatus.warning) warnings.push(timestampStatus.warning);

  return {
    symbol,
    price,
    markPrice,
    indexPrice,
    change24hPercent: changeRate == null ? null : changeRate * 100,
    volume24h: toFiniteNumber(ticker?.baseVolume),
    quoteVolume24h: toFiniteNumber(ticker?.usdtVolume),
    bidPrice,
    askPrice,
    spreadPercent,
    openInterest,
    previousOpenInterest: previousOi,
    openInterestChangePercent: oiChange,
    fundingRate,
    nextFundingAt,
    basis,
    basisPercent,
    source: BITGET_SOURCE,
    status,
    isDelayed: status === 'delayed',
    updatedAt: new Date(sourceTimestamp ?? now).toISOString(),
    warnings: uniqueWarnings(warnings),
  };
}

export async function getFuturesMarketStatus(): Promise<FuturesStatusResponse> {
  try {
    const symbols = await getSupportedSymbols();
    const updatedAt = new Date().toISOString();
    const status: DataStatus = symbols.fallback ? 'cached' : 'live';
    return {
      ok: true,
      provider: 'bitget',
      market: 'crypto-futures',
      status,
      connection: status,
      publicDataOnly: true,
      orderCapability: false,
      symbolCount: symbols.value.size,
      updatedAt,
      warnings: symbols.fallback
        ? ['거래소 연결 실패로 마지막 정상 심볼 캐시를 반환했습니다.']
        : [],
    };
  } catch {
    throw new FuturesMarketDataError(503, 'FUTURES_PROVIDER_DISCONNECTED', 'Bitget 공개 시장 데이터에 연결할 수 없습니다.');
  }
}

export async function getFuturesMarketSnapshot(value: unknown): Promise<FuturesMarketSnapshot> {
  const symbol = await assertSupportedSymbol(value);
  const key = `futures:snapshot:${symbol}`;
  try {
    const loaded = await loadWithCache(key, SNAPSHOT_TTL_MS, () => buildSnapshot(symbol));
    if (!loaded.fallback) return loaded.value;
    return {
      ...loaded.value,
      status: 'cached',
      isDelayed: true,
      warnings: uniqueWarnings([
        ...loaded.value.warnings,
        '거래소 연결 실패로 마지막 정상 스냅샷 캐시를 반환했습니다.',
      ]),
    };
  } catch (error) {
    if (error instanceof FuturesMarketDataError) throw error;
    throw new FuturesMarketDataError(503, 'FUTURES_PROVIDER_DISCONNECTED', '선물 시장 스냅샷을 불러올 수 없습니다.');
  }
}

function candleTtlMs(timeframe: string) {
  const duration = FUTURES_TIMEFRAME_MS[timeframe] ?? 60_000;
  return Math.min(60_000, Math.max(5_000, Math.round(duration / 4)));
}

export async function getFuturesCandles(input: {
  symbol: unknown;
  timeframe: unknown;
  limit: unknown;
}): Promise<FuturesCandlesResult> {
  const symbol = await assertSupportedSymbol(input.symbol);
  const timeframe = String(input.timeframe ?? '15m');
  if (!FUTURES_TIMEFRAME_MS[timeframe]) {
    throw new FuturesMarketDataError(400, 'INVALID_FUTURES_TIMEFRAME', '지원하지 않는 선물 시간봉입니다.');
  }
  const parsedLimit = toFiniteNumber(input.limit);
  const limit = Math.max(1, Math.min(1000, Math.trunc(parsedLimit ?? 200)));
  const key = `futures:candles:${symbol}:${timeframe}:${limit}`;
  try {
    const loaded = await loadWithCache(key, candleTtlMs(timeframe), async () => {
      const payload = await fetchBitget('/api/v2/mix/market/candles', {
        symbol,
        productType: BITGET_PRODUCT_TYPE,
        granularity: timeframe,
        limit: String(limit),
      });
      return normalizeBitgetCandles(payloadData(payload), symbol, timeframe);
    });
    if (!loaded.fallback) return loaded.value;
    return {
      ...loaded.value,
      status: 'cached',
      data: loaded.value.data.map((candle) => ({ ...candle, isDelayed: true })),
      warnings: uniqueWarnings([
        ...loaded.value.warnings,
        '거래소 연결 실패로 마지막 정상 캔들 캐시를 반환했습니다.',
      ]),
    };
  } catch (error) {
    if (error instanceof FuturesMarketDataError) throw error;
    throw new FuturesMarketDataError(503, 'FUTURES_PROVIDER_DISCONNECTED', '선물 캔들 데이터를 불러올 수 없습니다.');
  }
}

export function resetFuturesMarketDataStateForTests() {
  cache.clear();
  inFlight.clear();
  openInterestSamples.clear();
}

import { Router, type IRouter } from 'express';

import {
  getKiwoomDomesticOrderbook,
  type KiwoomApiResponse,
} from '../providers/kiwoom';

const router: IRouter = Router();
const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const PUBLIC_TIMEOUT_MS = 8_000;
const FRESH_MS = 30_000;

export type InstrumentOrderbookAssetClass =
  | 'stock'
  | 'crypto_spot'
  | 'crypto_futures';
export type InstrumentOrderbookMarket = 'KR' | 'US' | 'UPBIT' | 'BITGET';
export type InstrumentOrderbookStatus =
  | 'ready'
  | 'partial'
  | 'unavailable'
  | 'invalid'
  | 'provider_error';
export type InstrumentOrderbookProvider = 'kiwoom' | 'upbit' | 'bitget' | null;
export type InstrumentOrderbookSource =
  | 'ka10004'
  | 'upbit_v1_orderbook'
  | 'bitget_v2_mix_market_merge_depth'
  | null;

export interface InstrumentOrderbookLevel {
  rank: number;
  price: number;
  quantity: number;
  cumulativeQuantity: number;
}

export interface InstrumentOrderbookPayload {
  ok: boolean;
  available: boolean;
  status: InstrumentOrderbookStatus;
  assetClass: InstrumentOrderbookAssetClass;
  market: InstrumentOrderbookMarket;
  exchange: 'KRX' | 'US' | 'UPBIT' | 'BITGET';
  symbol: string;
  ticker: string;
  currency: 'KRW' | 'USD' | 'USDT';
  provider: InstrumentOrderbookProvider;
  source: InstrumentOrderbookSource;
  sourceTimestampRaw: string | null;
  updatedAt: string | null;
  receivedAt: string;
  freshness: 'fresh' | 'stale' | 'unknown';
  stale: boolean;
  asks: InstrumentOrderbookLevel[];
  bids: InstrumentOrderbookLevel[];
  bestAsk: number | null;
  bestBid: number | null;
  spread: number | null;
  spreadPercent: number | null;
  displayedAskQuantity: number;
  displayedBidQuantity: number;
  totalAskQuantity: number | null;
  totalBidQuantity: number | null;
  imbalance: number | null;
  warnings: string[];
  reason: string | null;
  orderSubmitted: false;
  exchangeRequestSent: false;
}

interface Descriptor {
  assetClass: InstrumentOrderbookAssetClass;
  market: InstrumentOrderbookMarket;
  exchange: InstrumentOrderbookPayload['exchange'];
  symbol: string;
  currency: InstrumentOrderbookPayload['currency'];
  provider: InstrumentOrderbookProvider;
  source: InstrumentOrderbookSource;
}

type RawOrderbook = Record<string, unknown>;
type Side = 'ask' | 'bid';
type RawLevel = { rank: number; price: unknown; quantity: unknown };

type Freshness = Pick<
  InstrumentOrderbookPayload,
  'sourceTimestampRaw' | 'updatedAt' | 'freshness' | 'stale'
>;

function textValue(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text || null;
}

function numericValue(
  value: unknown,
  options: { absolute?: boolean; allowZero?: boolean } = {},
): number | null {
  const text = textValue(value);
  if (text == null) return null;
  const normalized = text
    .replace(/,/g, '')
    .replace(/[₩원주]/g, '')
    .trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  const result = options.absolute ? Math.abs(parsed) : parsed;
  if (result < 0) return null;
  if (!options.allowZero && result === 0) return null;
  return result;
}

function cleanStockSymbol(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, '')
    .slice(0, 24);
}

function cleanSpotSymbol(value: unknown): string {
  const cleaned = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 24);
  return cleaned.replace(/^KRW-/, '');
}

function cleanFuturesSymbol(value: unknown): string {
  const cleaned = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 24);
  if (!cleaned) return '';
  return cleaned.endsWith('USDT') ? cleaned : `${cleaned}USDT`;
}

function normalizeLevels(
  rows: RawLevel[],
  side: Side,
  warnings: string[],
): InstrumentOrderbookLevel[] {
  const accepted: Array<{ sourceRank: number; price: number; quantity: number }> = [];
  const seenPrices = new Set<number>();

  for (const row of rows) {
    const price = numericValue(row.price, { absolute: true });
    const quantity = numericValue(row.quantity, { allowZero: true });
    if (price == null || quantity == null) {
      if (textValue(row.price) != null || textValue(row.quantity) != null) {
        warnings.push(
          `${side === 'ask' ? '매도' : '매수'} ${row.rank}호가의 가격 또는 수량이 유효하지 않아 제외했습니다.`,
        );
      }
      continue;
    }
    if (quantity === 0) continue;
    if (seenPrices.has(price)) {
      warnings.push(
        `${side === 'ask' ? '매도' : '매수'} 호가에 중복 가격 ${price}이 있어 뒤 단계를 제외했습니다.`,
      );
      continue;
    }
    seenPrices.add(price);
    accepted.push({ sourceRank: row.rank, price, quantity });
  }

  accepted.sort((left, right) =>
    side === 'ask' ? left.price - right.price : right.price - left.price,
  );

  let cumulativeQuantity = 0;
  return accepted.slice(0, 10).map((row, index) => {
    cumulativeQuantity += row.quantity;
    return {
      rank: index + 1,
      price: row.price,
      quantity: row.quantity,
      cumulativeQuantity,
    };
  });
}

function freshnessFromDate(
  sourceTimestampRaw: string | null,
  updatedAt: string | null,
  receivedAt: Date,
): Freshness {
  if (updatedAt == null) {
    return {
      sourceTimestampRaw,
      updatedAt: null,
      freshness: 'unknown',
      stale: true,
    };
  }
  const ageMs = receivedAt.getTime() - Date.parse(updatedAt);
  if (!Number.isFinite(ageMs) || ageMs < -60_000) {
    return {
      sourceTimestampRaw,
      updatedAt: null,
      freshness: 'unknown',
      stale: true,
    };
  }
  const stale = ageMs > FRESH_MS;
  return {
    sourceTimestampRaw,
    updatedAt,
    freshness: stale ? 'stale' : 'fresh',
    stale,
  };
}

function parseKiwoomTimestamp(value: unknown, receivedAt: Date): Freshness {
  const raw = textValue(value);
  if (!raw || !/^\d{14}$/.test(raw)) {
    return freshnessFromDate(raw, null, receivedAt);
  }
  const year = raw.slice(0, 4);
  const month = raw.slice(4, 6);
  const day = raw.slice(6, 8);
  const hour = raw.slice(8, 10);
  const minute = raw.slice(10, 12);
  const second = raw.slice(12, 14);
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`);
  const updatedAt = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  return freshnessFromDate(raw, updatedAt, receivedAt);
}

function parseMillisecondTimestamp(value: unknown, receivedAt: Date): Freshness {
  const raw = textValue(value);
  const milliseconds = numericValue(raw, { allowZero: false });
  if (raw == null || milliseconds == null) {
    return freshnessFromDate(raw, null, receivedAt);
  }
  const parsed = new Date(milliseconds);
  const updatedAt = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  return freshnessFromDate(raw, updatedAt, receivedAt);
}

function emptyPayload(
  descriptor: Descriptor,
  receivedAt: Date,
  status: InstrumentOrderbookStatus,
  reason: string,
): InstrumentOrderbookPayload {
  return {
    ok: false,
    available: false,
    status,
    assetClass: descriptor.assetClass,
    market: descriptor.market,
    exchange: descriptor.exchange,
    symbol: descriptor.symbol,
    ticker: descriptor.symbol,
    currency: descriptor.currency,
    provider: descriptor.provider,
    source: descriptor.source,
    sourceTimestampRaw: null,
    updatedAt: null,
    receivedAt: receivedAt.toISOString(),
    freshness: 'unknown',
    stale: true,
    asks: [],
    bids: [],
    bestAsk: null,
    bestBid: null,
    spread: null,
    spreadPercent: null,
    displayedAskQuantity: 0,
    displayedBidQuantity: 0,
    totalAskQuantity: null,
    totalBidQuantity: null,
    imbalance: null,
    warnings: [],
    reason,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function finalizePayload(options: {
  descriptor: Descriptor;
  receivedAt: Date;
  asks: RawLevel[];
  bids: RawLevel[];
  freshness: Freshness;
  totalAskQuantity?: unknown;
  totalBidQuantity?: unknown;
  warnings?: string[];
}): InstrumentOrderbookPayload {
  const warnings = [...(options.warnings ?? [])];
  const asks = normalizeLevels(options.asks, 'ask', warnings);
  const bids = normalizeLevels(options.bids, 'bid', warnings);
  const bestAsk = asks[0]?.price ?? null;
  const bestBid = bids[0]?.price ?? null;
  const displayedAskQuantity = asks.reduce((sum, row) => sum + row.quantity, 0);
  const displayedBidQuantity = bids.reduce((sum, row) => sum + row.quantity, 0);
  const totalAskQuantity = numericValue(options.totalAskQuantity, { allowZero: true });
  const totalBidQuantity = numericValue(options.totalBidQuantity, { allowZero: true });

  if (options.freshness.updatedAt == null) {
    warnings.push(
      '공급자 응답에서 검증 가능한 갱신 시각을 확인할 수 없어 최신성을 보장하지 않습니다.',
    );
  }

  if (asks.length === 0 && bids.length === 0) {
    return {
      ...emptyPayload(
        options.descriptor,
        options.receivedAt,
        'unavailable',
        'ORDERBOOK_LEVELS_EMPTY',
      ),
      ...options.freshness,
      warnings,
    };
  }

  if (bestAsk != null && bestBid != null && bestBid >= bestAsk) {
    return {
      ...emptyPayload(
        options.descriptor,
        options.receivedAt,
        'invalid',
        'ORDERBOOK_CROSSED',
      ),
      ...options.freshness,
      stale: true,
      warnings: [
        ...warnings,
        '최우선 매수호가가 최우선 매도호가 이상인 교차 호가여서 표시를 차단했습니다.',
      ],
    };
  }

  const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null;
  const midpoint = bestAsk != null && bestBid != null ? (bestAsk + bestBid) / 2 : null;
  const spreadPercent =
    spread != null && midpoint != null && midpoint > 0
      ? (spread / midpoint) * 100
      : null;
  const imbalanceDenominator = displayedBidQuantity + displayedAskQuantity;
  const imbalance =
    imbalanceDenominator > 0
      ? (displayedBidQuantity - displayedAskQuantity) / imbalanceDenominator
      : null;
  const partial = asks.length === 0 || bids.length === 0;

  if (partial) {
    warnings.push('매도 또는 매수 한쪽 호가가 비어 있어 부분 데이터로 표시합니다.');
  }

  return {
    ok: true,
    available: true,
    status: partial ? 'partial' : 'ready',
    assetClass: options.descriptor.assetClass,
    market: options.descriptor.market,
    exchange: options.descriptor.exchange,
    symbol: options.descriptor.symbol,
    ticker: options.descriptor.symbol,
    currency: options.descriptor.currency,
    provider: options.descriptor.provider,
    source: options.descriptor.source,
    ...options.freshness,
    receivedAt: options.receivedAt.toISOString(),
    asks,
    bids,
    bestAsk,
    bestBid,
    spread,
    spreadPercent,
    displayedAskQuantity,
    displayedBidQuantity,
    totalAskQuantity,
    totalBidQuantity,
    imbalance,
    warnings,
    reason: null,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function kiwoomField(side: Side, rank: number): { price: string; quantity: string } {
  if (side === 'ask') {
    return rank === 1
      ? { price: 'sel_fpr_bid', quantity: 'sel_fpr_req' }
      : { price: `sel_${rank}th_pre_bid`, quantity: `sel_${rank}th_pre_req` };
  }
  return rank === 1
    ? { price: 'buy_fpr_bid', quantity: 'buy_fpr_req' }
    : { price: `buy_${rank}th_pre_bid`, quantity: `buy_${rank}th_pre_req` };
}

function kiwoomRows(raw: RawOrderbook, side: Side): RawLevel[] {
  return Array.from({ length: 10 }, (_, index) => {
    const rank = index + 1;
    const field = kiwoomField(side, rank);
    return { rank, price: raw[field.price], quantity: raw[field.quantity] };
  });
}

export function normalizeKiwoomOrderbook(
  ticker: string,
  response: KiwoomApiResponse,
  receivedAt = new Date(),
): InstrumentOrderbookPayload {
  const symbol = cleanStockSymbol(ticker);
  const raw = response as RawOrderbook;
  return finalizePayload({
    descriptor: {
      assetClass: 'stock',
      market: 'KR',
      exchange: 'KRX',
      symbol,
      currency: 'KRW',
      provider: 'kiwoom',
      source: 'ka10004',
    },
    receivedAt,
    asks: kiwoomRows(raw, 'ask'),
    bids: kiwoomRows(raw, 'bid'),
    freshness: parseKiwoomTimestamp(raw.bid_req_base_tm, receivedAt),
    totalAskQuantity: raw.tot_sel_req,
    totalBidQuantity: raw.tot_buy_req,
  });
}

export function normalizeUpbitOrderbook(
  symbolInput: string,
  response: unknown,
  receivedAt = new Date(),
): InstrumentOrderbookPayload {
  const symbol = cleanSpotSymbol(symbolInput);
  const descriptor: Descriptor = {
    assetClass: 'crypto_spot',
    market: 'UPBIT',
    exchange: 'UPBIT',
    symbol,
    currency: 'KRW',
    provider: 'upbit',
    source: 'upbit_v1_orderbook',
  };
  const rows = Array.isArray(response) ? response : [];
  const first = rows[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return emptyPayload(descriptor, receivedAt, 'provider_error', 'UPBIT_ORDERBOOK_RESPONSE_INVALID');
  }
  const raw = first as RawOrderbook;
  const units = Array.isArray(raw.orderbook_units) ? raw.orderbook_units : [];
  const asks: RawLevel[] = [];
  const bids: RawLevel[] = [];
  units.forEach((unit, index) => {
    if (!unit || typeof unit !== 'object' || Array.isArray(unit)) return;
    const row = unit as RawOrderbook;
    asks.push({ rank: index + 1, price: row.ask_price, quantity: row.ask_size });
    bids.push({ rank: index + 1, price: row.bid_price, quantity: row.bid_size });
  });
  return finalizePayload({
    descriptor,
    receivedAt,
    asks,
    bids,
    freshness: parseMillisecondTimestamp(raw.timestamp, receivedAt),
    totalAskQuantity: raw.total_ask_size,
    totalBidQuantity: raw.total_bid_size,
  });
}

function pairRows(value: unknown): RawLevel[] {
  if (!Array.isArray(value)) return [];
  const rows: RawLevel[] = [];
  value.forEach((pair, index) => {
    if (!Array.isArray(pair)) return;
    rows.push({ rank: index + 1, price: pair[0], quantity: pair[1] });
  });
  return rows;
}

export function normalizeBitgetFuturesOrderbook(
  symbolInput: string,
  response: unknown,
  receivedAt = new Date(),
): InstrumentOrderbookPayload {
  const symbol = cleanFuturesSymbol(symbolInput);
  const descriptor: Descriptor = {
    assetClass: 'crypto_futures',
    market: 'BITGET',
    exchange: 'BITGET',
    symbol,
    currency: 'USDT',
    provider: 'bitget',
    source: 'bitget_v2_mix_market_merge_depth',
  };
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return emptyPayload(descriptor, receivedAt, 'provider_error', 'BITGET_ORDERBOOK_RESPONSE_INVALID');
  }
  const payload = response as RawOrderbook;
  if (String(payload.code ?? '') !== '00000') {
    return emptyPayload(descriptor, receivedAt, 'provider_error', 'BITGET_ORDERBOOK_PROVIDER_ERROR');
  }
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return emptyPayload(descriptor, receivedAt, 'provider_error', 'BITGET_ORDERBOOK_RESPONSE_INVALID');
  }
  const raw = data as RawOrderbook;
  return finalizePayload({
    descriptor,
    receivedAt,
    asks: pairRows(raw.asks),
    bids: pairRows(raw.bids),
    freshness: parseMillisecondTimestamp(raw.ts, receivedAt),
  });
}

async function fetchPublicJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUBLIC_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'seungjae-investment-app/1.0',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

function providerFailureCode(
  error: unknown,
  provider: Exclude<InstrumentOrderbookProvider, null>,
): string {
  const message = error instanceof Error ? error.message : '';
  if (provider === 'kiwoom') {
    if (/환경변수|등록되지 않았습니다/.test(message)) {
      return 'ORDERBOOK_PROVIDER_NOT_CONFIGURED';
    }
    if (/시간이 초과|aborted/i.test(message)) return 'ORDERBOOK_PROVIDER_TIMEOUT';
    return 'ORDERBOOK_PROVIDER_UNAVAILABLE';
  }
  if (/시간이 초과|aborted/i.test(message)) {
    return provider === 'upbit'
      ? 'UPBIT_ORDERBOOK_PROVIDER_TIMEOUT'
      : 'BITGET_ORDERBOOK_PROVIDER_TIMEOUT';
  }
  return provider === 'upbit'
    ? 'UPBIT_ORDERBOOK_PROVIDER_UNAVAILABLE'
    : 'BITGET_ORDERBOOK_PROVIDER_UNAVAILABLE';
}

async function loadOrderbook(descriptor: Descriptor): Promise<InstrumentOrderbookPayload> {
  if (descriptor.assetClass === 'stock' && descriptor.market === 'US') {
    return emptyPayload(
      descriptor,
      new Date(),
      'unavailable',
      'US_ORDERBOOK_PROVIDER_NOT_CONNECTED',
    );
  }

  try {
    if (descriptor.assetClass === 'stock') {
      const raw = await getKiwoomDomesticOrderbook(descriptor.symbol);
      return normalizeKiwoomOrderbook(descriptor.symbol, raw, new Date());
    }
    if (descriptor.assetClass === 'crypto_spot') {
      const raw = await fetchPublicJson(
        `${UPBIT_BASE}/v1/orderbook?markets=${encodeURIComponent(`KRW-${descriptor.symbol}`)}&count=10`,
      );
      return normalizeUpbitOrderbook(descriptor.symbol, raw, new Date());
    }
    const raw = await fetchPublicJson(
      `${BITGET_BASE}/api/v2/mix/market/merge-depth?symbol=${encodeURIComponent(descriptor.symbol)}&productType=${BITGET_PRODUCT_TYPE}&precision=scale0&limit=15`,
    );
    return normalizeBitgetFuturesOrderbook(descriptor.symbol, raw, new Date());
  } catch (error) {
    const provider = descriptor.provider ?? 'kiwoom';
    const reason = providerFailureCode(error, provider);
    console.error('[instrument-orderbook]', descriptor.market, reason);
    return emptyPayload(descriptor, new Date(), 'provider_error', reason);
  }
}

function stockDescriptor(tickerInput: unknown, marketInput: unknown): Descriptor | null {
  const symbol = cleanStockSymbol(tickerInput);
  const market = String(marketInput ?? '').trim().toUpperCase() === 'US'
    ? 'US'
    : String(marketInput ?? '').trim().toUpperCase() === 'KR'
      ? 'KR'
      : /^\d{6}(?:_(?:NX|AL))?$/.test(symbol)
        ? 'KR'
        : 'US';
  if (market === 'KR' && !/^\d{6}(?:_(?:NX|AL))?$/.test(symbol)) return null;
  if (market === 'US' && !/^[A-Z][A-Z0-9.-]{0,23}$/.test(symbol)) return null;
  return {
    assetClass: 'stock',
    market,
    exchange: market === 'KR' ? 'KRX' : 'US',
    symbol,
    currency: market === 'KR' ? 'KRW' : 'USD',
    provider: market === 'KR' ? 'kiwoom' : null,
    source: market === 'KR' ? 'ka10004' : null,
  };
}

function genericDescriptor(query: Record<string, unknown>): Descriptor | null {
  const assetClassRaw = String(query.assetClass ?? '').trim().toLowerCase();
  if (assetClassRaw === 'stock') {
    return stockDescriptor(query.symbol ?? query.ticker, query.market);
  }
  if (assetClassRaw === 'crypto_spot') {
    const symbol = cleanSpotSymbol(query.symbol);
    if (!/^[A-Z0-9]{2,20}$/.test(symbol)) return null;
    return {
      assetClass: 'crypto_spot',
      market: 'UPBIT',
      exchange: 'UPBIT',
      symbol,
      currency: 'KRW',
      provider: 'upbit',
      source: 'upbit_v1_orderbook',
    };
  }
  if (assetClassRaw === 'crypto_futures') {
    const symbol = cleanFuturesSymbol(query.symbol);
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return null;
    return {
      assetClass: 'crypto_futures',
      market: 'BITGET',
      exchange: 'BITGET',
      symbol,
      currency: 'USDT',
      provider: 'bitget',
      source: 'bitget_v2_mix_market_merge_depth',
    };
  }
  return null;
}

router.get('/orderbook', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const descriptor = genericDescriptor(req.query as Record<string, unknown>);
  if (!descriptor) {
    const fallback: Descriptor = {
      assetClass: 'stock',
      market: 'US',
      exchange: 'US',
      symbol: cleanStockSymbol(req.query.symbol),
      currency: 'USD',
      provider: null,
      source: null,
    };
    return res.status(400).json(
      emptyPayload(fallback, new Date(), 'invalid', 'INVALID_ORDERBOOK_TARGET'),
    );
  }
  return res.status(200).json(await loadOrderbook(descriptor));
});

router.get('/stocks/:ticker/orderbook', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const descriptor = stockDescriptor(req.params.ticker, req.query.market);
  if (!descriptor) {
    const fallback: Descriptor = {
      assetClass: 'stock',
      market: 'KR',
      exchange: 'KRX',
      symbol: cleanStockSymbol(req.params.ticker),
      currency: 'KRW',
      provider: 'kiwoom',
      source: 'ka10004',
    };
    return res.status(400).json(
      emptyPayload(fallback, new Date(), 'invalid', 'INVALID_STOCK_TICKER'),
    );
  }
  return res.status(200).json(await loadOrderbook(descriptor));
});

export default router;

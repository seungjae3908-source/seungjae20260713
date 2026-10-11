import type { ScannerPricePlan, ScannerSignalDirection } from './scanner-signal.types';
import type { OwnerSelectedFlowEvidence } from './owner-selected-live-strategy.service';

const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const ITEM_TIMEOUT_MS = 3_500;

export type OwnerSelectedCryptoMarket = 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';

export type OwnerSelectedCryptoCandle = Readonly<{
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number | null;
}>;

export type OwnerSelectedCryptoPublicEvidence = Readonly<{
  candles: readonly OwnerSelectedCryptoCandle[];
  context15m: readonly OwnerSelectedCryptoCandle[];
  context60m: readonly OwnerSelectedCryptoCandle[];
  flow: OwnerSelectedFlowEvidence | null;
  fundingRate: number | null;
}>;

interface UpbitCandleRow {
  timestamp?: unknown;
  candle_date_time_utc?: unknown;
  opening_price?: unknown;
  high_price?: unknown;
  low_price?: unknown;
  trade_price?: unknown;
  candle_acc_trade_volume?: unknown;
  candle_acc_trade_price?: unknown;
}

interface UpbitTradeTickRow {
  timestamp?: unknown;
  trade_volume?: unknown;
  ask_bid?: unknown;
}

interface UpbitOrderbookUnit {
  bid_size?: unknown;
  ask_size?: unknown;
}

interface UpbitOrderbookRow {
  timestamp?: unknown;
  orderbook_units?: UpbitOrderbookUnit[];
}

interface BitgetEnvelope<T> {
  code?: unknown;
  data?: T;
}

interface BitgetFillRow {
  size?: unknown;
  side?: unknown;
  ts?: unknown;
}

interface BitgetDepthRow {
  asks?: unknown;
  bids?: unknown;
  ts?: unknown;
}

interface BitgetTickerRow {
  symbol?: unknown;
  fundingRate?: unknown;
  holdingAmount?: unknown;
  ts?: unknown;
}

const previousOpenInterest = new Map<string, { value: number; observedAtMs: number }>();

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function linkedSignal(parent: AbortSignal | undefined, timeoutMs = ITEM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('OWNER_SELECTED_PUBLIC_PROVIDER_TIMEOUT')), timeoutMs);
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const linked = linkedSignal(signal);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'seungjae-owner-selected-research/1.0',
      },
      signal: linked.signal,
    });
    if (!response.ok) throw new Error(`OWNER_SELECTED_PUBLIC_HTTP_${response.status}`);
    return await response.json() as T;
  } finally {
    linked.clear();
  }
}

function normalizeCandles(rows: readonly OwnerSelectedCryptoCandle[], nowMs: number) {
  const futureLimit = nowMs + 60_000;
  const map = new Map<number, OwnerSelectedCryptoCandle>();
  for (const row of rows) {
    if (!Number.isFinite(row.time) || row.time <= 0 || row.time > futureLimit) continue;
    if (![row.open, row.high, row.low, row.close].every((value) => Number.isFinite(value) && value > 0)) continue;
    if (!Number.isFinite(row.volume) || row.volume < 0) continue;
    map.set(row.time, Object.freeze({
      ...row,
      high: Math.max(row.high, row.open, row.close),
      low: Math.min(row.low, row.open, row.close),
      quoteVolume: row.quoteVolume != null && Number.isFinite(row.quoteVolume) && row.quoteVolume >= 0
        ? row.quoteVolume
        : null,
    }));
  }
  return Object.freeze([...map.values()].sort((left, right) => left.time - right.time));
}

function bitgetGranularity(timeframe: '5m' | '15m' | '60m') {
  return timeframe === '60m' ? '1H' : timeframe;
}

async function collectSpotCandles(
  symbol: string,
  timeframe: '5m' | '15m' | '60m',
  signal?: AbortSignal,
): Promise<readonly OwnerSelectedCryptoCandle[]> {
  const unit = timeframe === '60m' ? 60 : timeframe === '15m' ? 15 : 5;
  const market = encodeURIComponent(`KRW-${symbol}`);
  const rows = await fetchJson<UpbitCandleRow[]>(
    `${UPBIT_BASE}/v1/candles/minutes/${unit}?market=${market}&count=200`,
    signal,
  );
  const nowMs = Date.now();
  return normalizeCandles(rows.map((row) => ({
    time: finite(row.timestamp) ?? Date.parse(text(row.candle_date_time_utc)),
    open: finite(row.opening_price) ?? Number.NaN,
    high: finite(row.high_price) ?? Number.NaN,
    low: finite(row.low_price) ?? Number.NaN,
    close: finite(row.trade_price) ?? Number.NaN,
    volume: finite(row.candle_acc_trade_volume) ?? Number.NaN,
    quoteVolume: finite(row.candle_acc_trade_price),
  })), nowMs);
}

async function collectFuturesCandles(
  symbol: string,
  timeframe: '5m' | '15m' | '60m',
  signal?: AbortSignal,
): Promise<readonly OwnerSelectedCryptoCandle[]> {
  const payload = await fetchJson<BitgetEnvelope<unknown[]>>(
    `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=${BITGET_PRODUCT_TYPE}&granularity=${encodeURIComponent(bitgetGranularity(timeframe))}&limit=200`,
    signal,
  );
  if (text(payload.code) !== '00000' || !Array.isArray(payload.data)) {
    throw new Error(`OWNER_SELECTED_BITGET_CANDLES_${text(payload.code) || 'INVALID'}`);
  }
  const rows: OwnerSelectedCryptoCandle[] = [];
  for (const raw of payload.data) {
    if (!Array.isArray(raw)) continue;
    rows.push({
      time: finite(raw[0]) ?? Number.NaN,
      open: finite(raw[1]) ?? Number.NaN,
      high: finite(raw[2]) ?? Number.NaN,
      low: finite(raw[3]) ?? Number.NaN,
      close: finite(raw[4]) ?? Number.NaN,
      volume: finite(raw[5]) ?? Number.NaN,
      quoteVolume: finite(raw[6]),
    });
  }
  return normalizeCandles(rows, Date.now());
}

function signedFlow(rows: readonly { side: 'buy' | 'sell'; size: number; ts: number }[]) {
  const ordered = [...rows]
    .filter((row) => row.size > 0 && Number.isFinite(row.ts))
    .sort((left, right) => left.ts - right.ts);
  let buyVolume = 0;
  let sellVolume = 0;
  const signed: number[] = [];
  for (const row of ordered) {
    if (row.side === 'buy') buyVolume += row.size;
    else sellVolume += row.size;
    signed.push(row.side === 'buy' ? row.size : -row.size);
  }
  const half = Math.max(1, Math.floor(signed.length / 2));
  const older = signed.slice(0, half).reduce((sum, value) => sum + value, 0);
  const newer = signed.slice(half).reduce((sum, value) => sum + value, 0);
  const total = buyVolume + sellVolume;
  return {
    buyVolume,
    sellVolume,
    cvd: buyVolume - sellVolume,
    cvdSlope: newer - older,
    takerBuyRatio: total > 0 ? buyVolume / total : 0.5,
  };
}

function depthQuantity(rows: unknown): number {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((sum, row) => {
    if (!Array.isArray(row) || row.length < 2) return sum;
    const quantity = finite(row[1]);
    return sum + (quantity != null && quantity > 0 ? quantity : 0);
  }, 0);
}

function openInterestChange(symbol: string, value: number | null, nowMs: number) {
  if (value == null || value <= 0) return null;
  const previous = previousOpenInterest.get(symbol);
  previousOpenInterest.set(symbol, { value, observedAtMs: nowMs });
  if (!previous || previous.value <= 0 || nowMs <= previous.observedAtMs || nowMs - previous.observedAtMs > 15 * 60_000) {
    return null;
  }
  return (value - previous.value) / previous.value * 100;
}

async function collectSpotFlow(symbol: string, signal?: AbortSignal): Promise<OwnerSelectedFlowEvidence | null> {
  const market = `KRW-${symbol}`;
  const [trades, books] = await Promise.all([
    fetchJson<UpbitTradeTickRow[]>(
      `${UPBIT_BASE}/v1/trades/ticks?market=${encodeURIComponent(market)}&count=200`,
      signal,
    ),
    fetchJson<UpbitOrderbookRow[]>(
      `${UPBIT_BASE}/v1/orderbook?markets=${encodeURIComponent(market)}&level=0`,
      signal,
    ),
  ]);
  const normalized = trades.flatMap((row) => {
    const size = finite(row.trade_volume);
    const ts = finite(row.timestamp);
    const askBid = text(row.ask_bid).toUpperCase();
    const side = askBid === 'BID' ? 'buy' as const : askBid === 'ASK' ? 'sell' as const : null;
    return side && size != null && size > 0 && ts != null && ts > 0 ? [{ side, size, ts }] : [];
  });
  const flow = signedFlow(normalized);
  const units = books[0]?.orderbook_units ?? [];
  const bidDepth = units.reduce((sum, unit) => sum + Math.max(0, finite(unit.bid_size) ?? 0), 0);
  const askDepth = units.reduce((sum, unit) => sum + Math.max(0, finite(unit.ask_size) ?? 0), 0);
  const totalDepth = bidDepth + askDepth;
  const nowMs = Date.now();
  const observedAtMs = Math.min(nowMs, finite(books[0]?.timestamp) ?? normalized.at(-1)?.ts ?? nowMs);
  return Object.freeze({
    observedAtMs,
    ...flow,
    bidDepth,
    askDepth,
    orderbookImbalance: totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0,
    openInterestChangePercent: null,
    provenance: 'upbit-public-trades+orderbook',
  });
}

async function collectFuturesMarketState(symbol: string, signal?: AbortSignal) {
  const payload = await fetchJson<BitgetEnvelope<BitgetTickerRow[]>>(
    `${BITGET_BASE}/api/v2/mix/market/tickers?productType=${BITGET_PRODUCT_TYPE}`,
    signal,
  );
  if (text(payload.code) !== '00000' || !Array.isArray(payload.data)) {
    throw new Error(`OWNER_SELECTED_BITGET_TICKER_${text(payload.code) || 'INVALID'}`);
  }
  const row = payload.data.find((item) => text(item.symbol).toUpperCase() === symbol.toUpperCase());
  return {
    fundingRate: finite(row?.fundingRate),
    openInterest: finite(row?.holdingAmount),
    observedAtMs: finite(row?.ts),
  };
}

async function collectFuturesFlow(
  symbol: string,
  openInterest: number | null,
  signal?: AbortSignal,
): Promise<OwnerSelectedFlowEvidence | null> {
  const [fills, depth] = await Promise.all([
    fetchJson<BitgetEnvelope<BitgetFillRow[]>>(
      `${BITGET_BASE}/api/v2/mix/market/fills?symbol=${encodeURIComponent(symbol)}&productType=${BITGET_PRODUCT_TYPE}&limit=100`,
      signal,
    ),
    fetchJson<BitgetEnvelope<BitgetDepthRow>>(
      `${BITGET_BASE}/api/v2/mix/market/merge-depth?symbol=${encodeURIComponent(symbol)}&productType=${BITGET_PRODUCT_TYPE}&precision=scale0&limit=15`,
      signal,
    ),
  ]);
  if (text(fills.code) !== '00000' || !Array.isArray(fills.data)
    || text(depth.code) !== '00000' || !depth.data) {
    return null;
  }
  const normalized = fills.data.flatMap((row) => {
    const size = finite(row.size);
    const ts = finite(row.ts);
    const rawSide = text(row.side).toLowerCase();
    const side = rawSide === 'buy' ? 'buy' as const : rawSide === 'sell' ? 'sell' as const : null;
    return side && size != null && size > 0 && ts != null && ts > 0 ? [{ side, size, ts }] : [];
  });
  const flow = signedFlow(normalized);
  const bidDepth = depthQuantity(depth.data.bids);
  const askDepth = depthQuantity(depth.data.asks);
  const totalDepth = bidDepth + askDepth;
  const nowMs = Date.now();
  const observedAtMs = Math.min(nowMs, finite(depth.data.ts) ?? normalized.at(-1)?.ts ?? nowMs);
  return Object.freeze({
    observedAtMs,
    ...flow,
    bidDepth,
    askDepth,
    orderbookImbalance: totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0,
    openInterestChangePercent: openInterestChange(symbol, openInterest, nowMs),
    provenance: 'bitget-public-fills+merge-depth+ticker-open-interest',
  });
}

export async function collectOwnerSelectedCryptoPublicEvidence(input: {
  market: OwnerSelectedCryptoMarket;
  symbol: string;
  signal?: AbortSignal;
}): Promise<OwnerSelectedCryptoPublicEvidence> {
  const market = input.market;
  if (market === 'CRYPTO_SPOT') {
    const [candles, context15m, context60m, flow] = await Promise.all([
      collectSpotCandles(input.symbol, '5m', input.signal),
      collectSpotCandles(input.symbol, '15m', input.signal),
      collectSpotCandles(input.symbol, '60m', input.signal),
      collectSpotFlow(input.symbol, input.signal).catch(() => null),
    ]);
    return Object.freeze({ candles, context15m, context60m, flow, fundingRate: null });
  }

  const marketState = await collectFuturesMarketState(input.symbol, input.signal);
  const [candles, context15m, context60m, flow] = await Promise.all([
    collectFuturesCandles(input.symbol, '5m', input.signal),
    collectFuturesCandles(input.symbol, '15m', input.signal),
    collectFuturesCandles(input.symbol, '60m', input.signal),
    collectFuturesFlow(input.symbol, marketState.openInterest, input.signal).catch(() => null),
  ]);
  return Object.freeze({
    candles,
    context15m,
    context60m,
    flow,
    fundingRate: marketState.fundingRate,
  });
}

function average(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function atr(candles: readonly OwnerSelectedCryptoCandle[], period = 14): number | null {
  if (candles.length < 2) return null;
  const rows = candles.slice(-Math.min(period + 1, candles.length));
  const ranges: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index];
    const previous = rows[index - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  return average(ranges);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function buildOwnerSelectedCryptoPricePlan(input: {
  market: OwnerSelectedCryptoMarket;
  price: number;
  candles: readonly OwnerSelectedCryptoCandle[];
  direction: Exclude<ScannerSignalDirection, 'NEUTRAL'>;
}): Readonly<{ pricePlan: ScannerPricePlan; volatilityPercent: number | null }> {
  const currentAtr = atr(input.candles);
  const empty = Object.freeze({
    pricePlan: Object.freeze({
      entryZone: null,
      invalidation: null,
      stopLoss: null,
      targets: [] as number[],
      riskReward: null,
    }),
    volatilityPercent: currentAtr != null && input.price > 0 ? round(currentAtr / input.price * 100) : null,
  });
  if (currentAtr == null || currentAtr <= 0 || input.candles.length < 20 || input.price <= 0) return empty;

  const recent = input.candles.slice(-20);
  const support = Math.min(...recent.map((row) => row.low));
  const resistance = Math.max(...recent.map((row) => row.high));
  const digits = input.market === 'CRYPTO_SPOT'
    ? input.price >= 1_000 ? 0 : input.price >= 1 ? 4 : 8
    : input.price >= 1 ? 4 : 8;
  const format = (value: number) => round(Math.max(0, value), digits);

  if (input.direction === 'LONG') {
    const stop = Math.min(support - currentAtr * 0.1, input.price - Math.max(currentAtr * 1.25, input.price * 0.008));
    const risk = input.price - stop;
    if (!(risk > 0)) return empty;
    const target1 = Math.max(resistance, input.price + risk * 1.5);
    return Object.freeze({
      pricePlan: Object.freeze({
        entryZone: Object.freeze({ from: format(Math.max(support, input.price - currentAtr * 0.35)), to: format(input.price) }),
        invalidation: format(stop),
        stopLoss: format(stop),
        targets: Object.freeze([format(target1), format(input.price + risk * 2.2)]) as unknown as number[],
        riskReward: round((target1 - input.price) / risk),
      }),
      volatilityPercent: round(currentAtr / input.price * 100),
    });
  }

  const stop = Math.max(resistance + currentAtr * 0.1, input.price + Math.max(currentAtr * 1.25, input.price * 0.008));
  const risk = stop - input.price;
  if (!(risk > 0)) return empty;
  const target1 = Math.min(support, input.price - risk * 1.5);
  return Object.freeze({
    pricePlan: Object.freeze({
      entryZone: Object.freeze({ from: format(input.price), to: format(Math.min(resistance, input.price + currentAtr * 0.35)) }),
      invalidation: format(stop),
      stopLoss: format(stop),
      targets: Object.freeze([format(target1), format(Math.max(0, input.price - risk * 2.2))]) as unknown as number[],
      riskReward: round((input.price - target1) / risk),
    }),
    volatilityPercent: round(currentAtr / input.price * 100),
  });
}

export function resetOwnerSelectedCryptoPublicEvidenceForTests() {
  previousOpenInterest.clear();
}

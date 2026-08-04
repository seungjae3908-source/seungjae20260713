import { createHash, randomUUID } from 'node:crypto';
import { runBoundedWorkPool } from '../lib/bounded-work-pool';
import { applyScannerSignalLifecycle } from './scanner-signal-lifecycle.service';
import type {
  ScannerEvidence,
  ScannerFailure,
  ScannerResponse,
  ScannerSignalCard,
  ScannerSignalDirection,
} from './scanner-signal.types';

const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const DEADLINE_MS = 12_000;
const ITEM_TIMEOUT_MS = 3_500;
const CONCURRENCY = 5;
const MAX_BATCH_SIZE = 40;
const CACHE_TTL_MS = 5 * 60_000;

type CryptoMarket = 'spot' | 'futures';
type CryptoCondition = 'trend' | 'volume' | 'breakout' | 'pullback';
type CryptoTimeframe = '5m' | '15m' | '60m' | '4H' | '1D';

export interface CryptoTicker {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  volume: number;
  tradingValue: number;
  bid: number | null;
  ask: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  timestamp: number | null;
  warning: boolean;
}

export interface CryptoCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number | null;
}

export interface CryptoUniverse {
  rows: CryptoTicker[];
  source: 'upbit-public' | 'bitget-public';
  providerErrorCount: number;
}

export interface CryptoSignalScanRequest {
  memberId: string;
  market: CryptoMarket;
  timeframe: CryptoTimeframe;
  condition: CryptoCondition;
  cursor: number;
  batchSize: number;
  minimumScore?: number;
  maximumRiskScore?: number;
  signal?: AbortSignal;
}

export interface CryptoScannerProviders {
  getUniverse(market: CryptoMarket, signal?: AbortSignal): Promise<CryptoUniverse>;
  getCandles(
    market: CryptoMarket,
    symbol: string,
    timeframe: CryptoTimeframe,
    signal: AbortSignal,
  ): Promise<CryptoCandle[]>;
  getSpread(
    market: CryptoMarket,
    ticker: CryptoTicker,
    signal: AbortSignal,
  ): Promise<{ bid: number | null; ask: number | null }>;
  now(): number;
}

export class CryptoScannerProviderError extends Error {
  readonly code = 'CRYPTO_SCAN_PROVIDER_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'CryptoScannerProviderError';
  }
}

interface UpbitMarketRow {
  market?: unknown;
  korean_name?: unknown;
  market_warning?: unknown;
}

interface UpbitTickerRow {
  market?: unknown;
  trade_price?: unknown;
  signed_change_rate?: unknown;
  acc_trade_volume_24h?: unknown;
  acc_trade_price_24h?: unknown;
  timestamp?: unknown;
}

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

interface UpbitOrderbookUnit {
  bid_price?: unknown;
  ask_price?: unknown;
}

interface UpbitOrderbookRow {
  orderbook_units?: UpbitOrderbookUnit[];
}

interface BitgetTickerRow {
  symbol?: unknown;
  markPrice?: unknown;
  lastPr?: unknown;
  change24h?: unknown;
  baseVolume?: unknown;
  usdtVolume?: unknown;
  bidPr?: unknown;
  askPr?: unknown;
  fundingRate?: unknown;
  holdingAmount?: unknown;
  ts?: unknown;
}

interface BitgetEnvelope<T> {
  code?: unknown;
  data?: T;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('CRYPTO_PROVIDER_TIMEOUT')),
    timeoutMs,
  );
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

async function fetchJson<T>(url: string, signal?: AbortSignal, timeoutMs = ITEM_TIMEOUT_MS): Promise<T> {
  const linked = linkedSignal(signal, timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'seungjae-signal-scanner/1.0' },
      signal: linked.signal,
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json() as T;
  } finally {
    linked.clear();
  }
}

function normalizeCandles(rows: CryptoCandle[], now: number): CryptoCandle[] {
  const futureLimit = now + 60_000;
  const map = new Map<number, CryptoCandle>();
  for (const row of rows) {
    if (!Number.isFinite(row.time) || row.time <= 0 || row.time > futureLimit) continue;
    if (![row.open, row.high, row.low, row.close].every((value) => Number.isFinite(value) && value > 0)) continue;
    if (!Number.isFinite(row.volume) || row.volume < 0) continue;
    map.set(row.time, {
      ...row,
      high: Math.max(row.high, row.open, row.close),
      low: Math.min(row.low, row.open, row.close),
      quoteVolume: row.quoteVolume != null && Number.isFinite(row.quoteVolume) && row.quoteVolume >= 0
        ? row.quoteVolume
        : null,
    });
  }
  return [...map.values()].sort((left, right) => left.time - right.time);
}

function spotCandlePath(symbol: string, timeframe: CryptoTimeframe): string {
  const market = encodeURIComponent(`KRW-${symbol}`);
  if (timeframe === '1D') return `/v1/candles/days?market=${market}&count=200`;
  const unit = timeframe === '4H' ? 240 : timeframe === '60m' ? 60 : timeframe === '15m' ? 15 : 5;
  return `/v1/candles/minutes/${unit}?market=${market}&count=200`;
}

function bitgetGranularity(timeframe: CryptoTimeframe): string {
  return timeframe === '60m' ? '1H' : timeframe;
}

async function defaultSpotUniverse(signal?: AbortSignal): Promise<CryptoUniverse> {
  const markets = await fetchJson<UpbitMarketRow[]>(`${UPBIT_BASE}/v1/market/all?isDetails=true`, signal, 8_000);
  const listed = markets
    .map((row) => ({
      market: text(row.market),
      name: text(row.korean_name),
      warning: text(row.market_warning || 'NONE') !== 'NONE',
    }))
    .filter((row) => row.market.startsWith('KRW-'))
    .map((row) => ({ ...row, symbol: row.market.replace(/^KRW-/, '') }));
  const chunks: Array<typeof listed> = [];
  for (let index = 0; index < listed.length; index += 100) chunks.push(listed.slice(index, index + 100));
  const tickerRows: UpbitTickerRow[] = [];
  let providerErrorCount = 0;
  for (const chunk of chunks) {
    try {
      const rows = await fetchJson<UpbitTickerRow[]>(
        `${UPBIT_BASE}/v1/ticker?markets=${encodeURIComponent(chunk.map((row) => row.market).join(','))}`,
        signal,
        8_000,
      );
      tickerRows.push(...rows);
    } catch (error) {
      if (signal?.aborted) throw error;
      providerErrorCount += 1;
    }
  }
  const names = new Map(listed.map((row) => [row.market, row]));
  const rows = tickerRows
    .map((row): CryptoTicker | null => {
      const market = text(row.market);
      const meta = names.get(market);
      const price = finite(row.trade_price);
      if (!meta || price == null || price <= 0) return null;
      return {
        symbol: meta.symbol,
        name: meta.name || meta.symbol,
        price,
        changePercent: (finite(row.signed_change_rate) ?? 0) * 100,
        volume: finite(row.acc_trade_volume_24h) ?? 0,
        tradingValue: finite(row.acc_trade_price_24h) ?? 0,
        bid: null,
        ask: null,
        fundingRate: null,
        openInterest: null,
        timestamp: finite(row.timestamp),
        warning: meta.warning,
      };
    })
    .filter((row): row is CryptoTicker => row != null)
    .sort((left, right) => right.tradingValue - left.tradingValue || left.symbol.localeCompare(right.symbol));
  if (!rows.length) throw new CryptoScannerProviderError('UPBIT_TICKERS_UNAVAILABLE');
  return { rows, source: 'upbit-public', providerErrorCount };
}

async function defaultFuturesUniverse(signal?: AbortSignal): Promise<CryptoUniverse> {
  const payload = await fetchJson<BitgetEnvelope<BitgetTickerRow[]>>(
    `${BITGET_BASE}/api/v2/mix/market/tickers?productType=${BITGET_PRODUCT_TYPE}`,
    signal,
    8_000,
  );
  if (text(payload.code) !== '00000' || !Array.isArray(payload.data)) {
    throw new CryptoScannerProviderError(`BITGET_${text(payload.code) || 'INVALID'}`);
  }
  const newest = new Map<string, CryptoTicker>();
  for (const row of payload.data) {
    const symbol = text(row.symbol).toUpperCase();
    const price = finite(row.markPrice ?? row.lastPr);
    if (!symbol || price == null || price <= 0) continue;
    const timestamp = finite(row.ts);
    const item: CryptoTicker = {
      symbol,
      name: symbol,
      price,
      changePercent: (finite(row.change24h) ?? 0) * 100,
      volume: finite(row.baseVolume) ?? 0,
      tradingValue: finite(row.usdtVolume) ?? 0,
      bid: finite(row.bidPr),
      ask: finite(row.askPr),
      fundingRate: finite(row.fundingRate),
      openInterest: finite(row.holdingAmount),
      timestamp,
      warning: false,
    };
    const previous = newest.get(symbol);
    if (!previous || (timestamp ?? 0) >= (previous.timestamp ?? 0)) newest.set(symbol, item);
  }
  const rows = [...newest.values()]
    .sort((left, right) => right.tradingValue - left.tradingValue || left.symbol.localeCompare(right.symbol));
  if (!rows.length) throw new CryptoScannerProviderError('BITGET_TICKERS_UNAVAILABLE');
  return { rows, source: 'bitget-public', providerErrorCount: 0 };
}

const defaultProviders: CryptoScannerProviders = {
  async getUniverse(market, signal) {
    return market === 'spot' ? defaultSpotUniverse(signal) : defaultFuturesUniverse(signal);
  },
  async getCandles(market, symbol, timeframe, signal) {
    if (market === 'spot') {
      const rows = await fetchJson<UpbitCandleRow[]>(`${UPBIT_BASE}${spotCandlePath(symbol, timeframe)}`, signal);
      return normalizeCandles(rows.map((row) => ({
        time: finite(row.timestamp) ?? Date.parse(text(row.candle_date_time_utc)),
        open: finite(row.opening_price) ?? Number.NaN,
        high: finite(row.high_price) ?? Number.NaN,
        low: finite(row.low_price) ?? Number.NaN,
        close: finite(row.trade_price) ?? Number.NaN,
        volume: finite(row.candle_acc_trade_volume) ?? Number.NaN,
        quoteVolume: finite(row.candle_acc_trade_price),
      })), Date.now());
    }
    const payload = await fetchJson<BitgetEnvelope<unknown[]>>(
      `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=${BITGET_PRODUCT_TYPE}&granularity=${encodeURIComponent(bitgetGranularity(timeframe))}&limit=200`,
      signal,
    );
    if (text(payload.code) !== '00000' || !Array.isArray(payload.data)) {
      throw new Error(`BITGET_${text(payload.code) || 'INVALID'}`);
    }
    const candles: CryptoCandle[] = [];
    for (const raw of payload.data) {
      if (!Array.isArray(raw)) continue;
      candles.push({
        time: finite(raw[0]) ?? Number.NaN,
        open: finite(raw[1]) ?? Number.NaN,
        high: finite(raw[2]) ?? Number.NaN,
        low: finite(raw[3]) ?? Number.NaN,
        close: finite(raw[4]) ?? Number.NaN,
        volume: finite(raw[5]) ?? Number.NaN,
        quoteVolume: finite(raw[6]),
      });
    }
    return normalizeCandles(candles, Date.now());
  },
  async getSpread(market, ticker, signal) {
    if (market === 'futures') return { bid: ticker.bid, ask: ticker.ask };
    const rows = await fetchJson<UpbitOrderbookRow[]>(
      `${UPBIT_BASE}/v1/orderbook?markets=${encodeURIComponent(`KRW-${ticker.symbol}`)}&level=0`,
      signal,
    );
    const unit = rows[0]?.orderbook_units?.[0];
    return { bid: finite(unit?.bid_price), ask: finite(unit?.ask_price) };
  },
  now: Date.now,
};

function sma(values: number[], period: number): number | null {
  return values.length >= period ? average(values.slice(-period)) : null;
}

function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const difference = values[index] - values[index - 1];
    if (difference >= 0) gain += difference;
    else loss += Math.abs(difference);
  }
  if (loss === 0) return 100;
  const ratio = gain / loss;
  return 100 - 100 / (1 + ratio);
}

function atr(candles: CryptoCandle[], period = 14): number | null {
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

function staleAfter(timeframe: CryptoTimeframe): number {
  if (timeframe === '5m') return 20 * 60_000;
  if (timeframe === '15m') return 45 * 60_000;
  if (timeframe === '60m') return 3 * 60 * 60_000;
  if (timeframe === '4H') return 12 * 60 * 60_000;
  return 3 * 24 * 60 * 60_000;
}

function expiry(timeframe: CryptoTimeframe, now: number): string {
  const ttl = timeframe === '5m'
    ? 15 * 60_000
    : timeframe === '15m'
      ? 45 * 60_000
      : timeframe === '60m'
        ? 3 * 60 * 60_000
        : timeframe === '4H'
          ? 12 * 60 * 60_000
          : 3 * 24 * 60 * 60_000;
  return new Date(now + ttl).toISOString();
}

function pricePlan(
  ticker: CryptoTicker,
  candles: CryptoCandle[],
  direction: ScannerSignalDirection,
  market: CryptoMarket,
) {
  const currentAtr = atr(candles);
  const empty = {
    pricePlan: { entryZone: null, invalidation: null, stopLoss: null, targets: [] as number[], riskReward: null },
    volatilityPercent: currentAtr != null && ticker.price > 0 ? round(currentAtr / ticker.price * 100) : null,
  };
  if (currentAtr == null || currentAtr <= 0 || candles.length < 20 || direction === 'NEUTRAL') return empty;
  const recent = candles.slice(-20);
  const support = Math.min(...recent.map((row) => row.low));
  const resistance = Math.max(...recent.map((row) => row.high));
  const digits = market === 'spot'
    ? ticker.price >= 1_000 ? 0 : ticker.price >= 1 ? 4 : 8
    : ticker.price >= 1 ? 4 : 8;
  const format = (value: number) => round(Math.max(0, value), digits);
  if (direction === 'LONG') {
    const stop = Math.min(support - currentAtr * 0.1, ticker.price - Math.max(currentAtr * 1.25, ticker.price * 0.008));
    const risk = ticker.price - stop;
    if (!(risk > 0)) return empty;
    const target1 = Math.max(resistance, ticker.price + risk * 1.5);
    return {
      pricePlan: {
        entryZone: { from: format(Math.max(support, ticker.price - currentAtr * 0.35)), to: format(ticker.price) },
        invalidation: format(stop),
        stopLoss: format(stop),
        targets: [format(target1), format(ticker.price + risk * 2.2)],
        riskReward: round((target1 - ticker.price) / risk),
      },
      volatilityPercent: round(currentAtr / ticker.price * 100),
    };
  }
  const stop = Math.max(resistance + currentAtr * 0.1, ticker.price + Math.max(currentAtr * 1.25, ticker.price * 0.008));
  const risk = stop - ticker.price;
  if (!(risk > 0)) return empty;
  const target1 = Math.min(support, ticker.price - risk * 1.5);
  return {
    pricePlan: {
      entryZone: { from: format(ticker.price), to: format(Math.min(resistance, ticker.price + currentAtr * 0.35)) },
      invalidation: format(stop),
      stopLoss: format(stop),
      targets: [format(target1), format(Math.max(0, ticker.price - risk * 2.2))],
      riskReward: round((ticker.price - target1) / risk),
    },
    volatilityPercent: round(currentAtr / ticker.price * 100),
  };
}

function signalId(request: CryptoSignalScanRequest, ticker: CryptoTicker, direction: ScannerSignalDirection): string {
  const digest = createHash('sha256')
    .update([request.memberId, request.market, ticker.symbol, direction, request.timeframe, request.condition].join(':'))
    .digest('hex')
    .slice(0, 24);
  return `signal:${digest}`;
}

function analyze(
  request: CryptoSignalScanRequest,
  ticker: CryptoTicker,
  candles: CryptoCandle[],
  spread: { bid: number | null; ask: number | null },
  now: number,
): ScannerSignalCard | null {
  const closes = candles.map((row) => row.close);
  const latest = candles.at(-1);
  if (!latest || closes.length < 5) return null;
  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const currentRsi = rsi(closes);
  const currentAtr = atr(candles);
  const baselineVolume = average(candles.slice(-21, -1).map((row) => row.volume));
  const volumeRatio = baselineVolume != null && baselineVolume > 0 ? latest.volume / baselineVolume : null;
  const prior = candles.slice(-21, -1);
  const resistance = prior.length ? Math.max(...prior.map((row) => row.high)) : null;
  const support = prior.length ? Math.min(...prior.map((row) => row.low)) : null;
  const breakout = resistance != null && ticker.price >= resistance;
  const supportBreak = support != null && ticker.price <= support;
  const pullbackLong = ma20 != null && ma5 != null && ma5 > ma20 && ticker.price >= ma20 * 0.98 && ticker.price <= ma20 * 1.03;
  const pullbackShort = ma20 != null && ma5 != null && ma5 < ma20 && ticker.price <= ma20 * 1.02 && ticker.price >= ma20 * 0.97;
  const mid = spread.bid != null && spread.ask != null && spread.bid > 0 && spread.ask >= spread.bid
    ? (spread.bid + spread.ask) / 2
    : null;
  const spreadPercent = mid != null && spread.ask != null && spread.bid != null
    ? (spread.ask - spread.bid) / mid * 100
    : null;
  const volatilityPercent = currentAtr != null ? currentAtr / ticker.price * 100 : null;
  const stale = now - latest.time > staleAfter(request.timeframe)
    || (ticker.timestamp != null && now - ticker.timestamp > 10 * 60_000);

  let longScore = 35;
  let shortScore = 35;
  const longReasons: string[] = [];
  const shortReasons: string[] = [];
  if (ma20 != null) {
    if (ticker.price > ma20) { longScore += 15; longReasons.push('현재가가 20기간 평균 위'); }
    else { shortScore += 15; shortReasons.push('현재가가 20기간 평균 아래'); }
  }
  if (ma5 != null && ma20 != null) {
    if (ma5 > ma20) { longScore += 12; longReasons.push('단기 평균이 중기 평균 위'); }
    else if (ma5 < ma20) { shortScore += 12; shortReasons.push('단기 평균이 중기 평균 아래'); }
  }
  if (currentRsi != null) {
    if (currentRsi >= 45 && currentRsi <= 68) { longScore += 8; longReasons.push(`RSI ${currentRsi.toFixed(1)} 상승 여유`); }
    if (currentRsi <= 35) { longScore += 6; longReasons.push(`RSI ${currentRsi.toFixed(1)} 과매도 반등 관찰`); }
    if (currentRsi >= 72) { shortScore += 7; shortReasons.push(`RSI ${currentRsi.toFixed(1)} 과열`); }
  }
  if (volumeRatio != null && volumeRatio >= 1.3) {
    if (latest.close >= latest.open) { longScore += 10; longReasons.push(`거래량 ${volumeRatio.toFixed(2)}배 양봉`); }
    else { shortScore += 10; shortReasons.push(`거래량 ${volumeRatio.toFixed(2)}배 음봉`); }
  }
  if (breakout) { longScore += 12; longReasons.push('20기간 고가 돌파'); }
  if (supportBreak) { shortScore += 12; shortReasons.push('20기간 저가 이탈'); }
  if (ticker.changePercent > 0) longScore += Math.min(6, ticker.changePercent / 2);
  if (ticker.changePercent < 0) shortScore += Math.min(6, Math.abs(ticker.changePercent) / 2);
  if (request.market === 'futures' && ticker.fundingRate != null) {
    if (ticker.fundingRate > 0.0006) { shortScore += 4; shortReasons.push('양(+) 펀딩 과열'); }
    if (ticker.fundingRate < -0.0006) { longScore += 4; longReasons.push('음(-) 펀딩 과열'); }
  }
  longScore = Math.round(clamp(longScore));
  shortScore = Math.round(clamp(shortScore));

  const conditionMatched = request.condition === 'volume'
    ? volumeRatio != null && volumeRatio >= 1.3
    : request.condition === 'breakout'
      ? breakout || (request.market === 'futures' && supportBreak)
      : request.condition === 'pullback'
        ? pullbackLong || (request.market === 'futures' && pullbackShort)
        : ma5 != null && ma20 != null && ma5 !== ma20;
  let direction: ScannerSignalDirection = 'NEUTRAL';
  if (request.market === 'spot') {
    if (longScore >= 70 && conditionMatched) direction = 'LONG';
  } else if (conditionMatched) {
    if (longScore >= 70 && longScore - shortScore >= 10) direction = 'LONG';
    else if (shortScore >= 70 && shortScore - longScore >= 10) direction = 'SHORT';
  }

  let dataCompleteness = 0;
  if (request.market === 'spot') {
    dataCompleteness += ticker.price > 0 ? 15 : 0;
    dataCompleteness += candles.length >= 30 ? 30 : Math.min(20, candles.length / 30 * 20);
    dataCompleteness += ticker.volume > 0 && ticker.tradingValue > 0 ? 15 : 0;
    dataCompleteness += !stale ? 15 : 0;
    dataCompleteness += spreadPercent != null ? 15 : 0;
    dataCompleteness += conditionMatched ? 10 : 0;
  } else {
    dataCompleteness += ticker.price > 0 ? 10 : 0;
    dataCompleteness += candles.length >= 30 ? 25 : Math.min(18, candles.length / 30 * 18);
    dataCompleteness += ticker.volume > 0 && ticker.tradingValue > 0 ? 10 : 0;
    dataCompleteness += !stale ? 15 : 0;
    dataCompleteness += spreadPercent != null ? 10 : 0;
    dataCompleteness += ticker.fundingRate != null ? 10 : 0;
    dataCompleteness += ticker.openInterest != null && ticker.openInterest > 0 ? 10 : 0;
    dataCompleteness += conditionMatched ? 10 : 0;
  }
  dataCompleteness = Math.round(clamp(dataCompleteness));

  let riskScore = 0;
  if (spreadPercent == null) riskScore += 20;
  else if (spreadPercent > 0.6) riskScore += 35;
  else if (spreadPercent > 0.25) riskScore += 18;
  if (volatilityPercent == null) riskScore += 15;
  else if (volatilityPercent > 6) riskScore += 30;
  else if (volatilityPercent > 3) riskScore += 15;
  if (Math.abs(ticker.changePercent) > 25) riskScore += 30;
  else if (Math.abs(ticker.changePercent) > 12) riskScore += 15;
  if (ticker.warning) riskScore += 45;
  if (stale) riskScore += 30;
  const liquidityFloor = request.market === 'spot' ? 1_000_000_000 : 5_000_000;
  if (ticker.tradingValue < liquidityFloor) riskScore += 20;
  if (request.market === 'futures' && ticker.fundingRate != null && Math.abs(ticker.fundingRate) > 0.001) riskScore += 15;
  riskScore = Math.round(clamp(riskScore));

  const strongest = Math.max(longScore, shortScore);
  let scoreCap = 100;
  if (dataCompleteness < 50) scoreCap = 49;
  else if (dataCompleteness < 65) scoreCap = 59;
  else if (dataCompleteness < 80) scoreCap = 69;
  if (stale) scoreCap = Math.min(scoreCap, 49);
  if (riskScore > 60) scoreCap = Math.min(scoreCap, 64);
  const score = Math.round(Math.min(strongest, scoreCap));
  const scoreGap = Math.abs(longScore - shortScore);
  const confidence = Math.round(Math.min(
    dataCompleteness,
    scoreGap >= 20 ? 90 : scoreGap >= 10 ? 75 : 55,
    stale ? 49 : 100,
  ));
  const dataState = stale
    ? 'stale' as const
    : candles.length < 20
      ? 'insufficient' as const
      : dataCompleteness < 80
        ? 'partial' as const
        : 'complete' as const;
  const observedTimestamp = Math.max(latest.time, ticker.timestamp ?? 0);
  const observedAt = new Date(observedTimestamp).toISOString();
  const conditionLabel = request.condition === 'volume'
    ? '거래량 증가'
    : request.condition === 'breakout'
      ? '돌파·이탈'
      : request.condition === 'pullback'
        ? '눌림·반등 실패'
        : '추세 일치';
  const evidence: ScannerEvidence[] = [
    {
      key: request.condition,
      label: conditionLabel,
      status: conditionMatched ? 'matched' : 'not_matched',
      source: 'public-candles',
      observedAt,
      reasons: conditionMatched ? ['선택한 기술 조건을 실제 캔들로 확인했습니다.'] : ['선택한 기술 조건을 충족하지 않았습니다.'],
    },
    {
      key: 'volume',
      label: '거래량',
      status: volumeRatio == null ? 'unverified' : volumeRatio >= 1.3 ? 'matched' : 'not_matched',
      source: 'public-candles',
      observedAt,
      reasons: [volumeRatio == null ? '평균 거래량을 계산할 봉이 부족합니다.' : `최근 평균 대비 ${volumeRatio.toFixed(2)}배`],
    },
    {
      key: 'liquidity',
      label: '유동성·거래대금',
      status: ticker.tradingValue > 0 ? 'matched' : 'unverified',
      source: request.market === 'spot' ? 'upbit-public-ticker' : 'bitget-public-ticker',
      observedAt,
      reasons: [ticker.tradingValue > 0 ? `24시간 거래대금 ${round(ticker.tradingValue, 2)}` : '거래대금 데이터가 없습니다.'],
    },
    {
      key: 'spread',
      label: '스프레드',
      status: spreadPercent == null ? 'unverified' : spreadPercent <= 0.25 ? 'matched' : 'not_matched',
      source: request.market === 'spot' ? 'upbit-public-orderbook' : 'bitget-public-ticker',
      observedAt,
      reasons: [spreadPercent == null ? '호가 스프레드를 확인하지 못했습니다.' : `스프레드 ${spreadPercent.toFixed(3)}%`],
    },
    {
      key: 'risk',
      label: '변동성·추격 위험',
      status: riskScore <= 45 ? 'matched' : 'not_matched',
      source: 'deterministic-risk-policy',
      observedAt,
      reasons: [`위험 점수 ${riskScore}`, volatilityPercent == null ? 'ATR 미확인' : `ATR 변동성 ${volatilityPercent.toFixed(2)}%`],
    },
  ];
  if (request.market === 'futures') {
    evidence.push({
      key: 'funding-open-interest',
      label: '펀딩비·미결제약정',
      status: ticker.fundingRate != null && ticker.openInterest != null ? 'matched' : 'unverified',
      source: 'bitget-public-ticker',
      observedAt,
      reasons: [
        ticker.fundingRate == null ? '펀딩비 미확인' : `펀딩비 ${(ticker.fundingRate * 100).toFixed(4)}%`,
        ticker.openInterest == null ? '미결제약정 미확인' : `미결제약정 ${round(ticker.openInterest, 2)}`,
      ],
    });
  }
  const technicalPlan = pricePlan(ticker, candles, direction, request.market);
  const strongSignalEligible = direction !== 'NEUTRAL'
    && conditionMatched
    && score >= 75
    && confidence >= 70
    && dataCompleteness >= 80
    && riskScore <= 45
    && dataState === 'complete'
    && technicalPlan.pricePlan.riskReward != null
    && technicalPlan.pricePlan.riskReward >= 1.5;
  const warnings: string[] = [];
  if (stale) warnings.push('시세 또는 캔들이 오래됐습니다.');
  if (ticker.warning) warnings.push('업비트 유의 종목입니다.');
  if (Math.abs(ticker.changePercent) > 12) warnings.push('24시간 급변으로 추격 위험이 큽니다.');
  if (spreadPercent == null) warnings.push('스프레드 미확인');
  if (request.market === 'spot') warnings.push('현물 Scanner에는 숏·레버리지를 적용하지 않습니다.');
  const selectedReasons = direction === 'SHORT' ? shortReasons : longReasons;

  return {
    signalId: signalId(request, ticker, direction),
    assetClass: request.market === 'spot' ? 'coin_spot' : 'coin_futures',
    market: request.market === 'spot' ? 'UPBIT_KRW' : 'BITGET_USDT_FUTURES',
    exchange: request.market === 'spot' ? 'UPBIT' : 'BITGET',
    symbol: ticker.symbol,
    name: ticker.name,
    currency: request.market === 'spot' ? 'KRW' : 'USDT',
    assetType: request.market === 'spot' ? 'CRYPTO_SPOT' : 'CRYPTO_FUTURES',
    listingStatus: 'LISTED',
    price: ticker.price,
    changePercent: ticker.changePercent,
    direction,
    signalState: strongSignalEligible ? 'WATCHING' : dataState === 'unavailable' ? 'INVALIDATED' : 'DETECTED',
    score,
    confidence,
    dataCompleteness,
    riskScore,
    riskLevel: riskScore >= 60 ? 'HIGH' : riskScore >= 30 ? 'MEDIUM' : 'LOW',
    liquidity: ticker.tradingValue,
    volume: ticker.volume,
    tradingValue: ticker.tradingValue,
    spreadPercent: spreadPercent == null ? null : round(spreadPercent, 4),
    volatilityPercent: technicalPlan.volatilityPercent,
    matched: evidence.filter((item) => item.status === 'matched').map((item) => item.label),
    notMatched: evidence.filter((item) => item.status === 'not_matched').map((item) => item.label),
    unverified: evidence.filter((item) => item.status === 'unverified').map((item) => item.label),
    evidence: evidence.map((item) => item.key === request.condition && selectedReasons.length
      ? { ...item, reasons: selectedReasons.slice(0, 6) }
      : item),
    pricePlan: technicalPlan.pricePlan,
    dataState,
    dataSources: request.market === 'spot'
      ? ['upbit-public-market', 'upbit-public-ticker', 'upbit-public-candles', 'upbit-public-orderbook']
      : ['bitget-public-ticker', 'bitget-public-candles'],
    observedAt,
    expiresAt: expiry(request.timeframe, now),
    strongSignalEligible,
    warnings,
  };
}

function cacheKey(request: CryptoSignalScanRequest): string {
  return [request.memberId, request.market, request.timeframe, request.condition, request.cursor, request.batchSize].join(':');
}

function staleFallback(response: ScannerResponse, message: string, now: number): ScannerResponse {
  return {
    ...response,
    requestId: randomUUID(),
    cards: response.cards.map((card) => ({
      ...card,
      score: Math.min(card.score, 49),
      confidence: Math.min(card.confidence, 49),
      dataState: 'stale',
      signalState: 'WEAKENED',
      strongSignalEligible: false,
      warnings: [...new Set([...card.warnings, '마지막 정상 결과 fallback'])],
    })),
    alerts: [],
    failures: [{ symbol: '*', reason: 'provider_error', message }],
    execution: {
      ...response.execution,
      providerErrorCount: response.execution.providerErrorCount + 1,
      partial: true,
      timedOut: false,
      cancelled: false,
    },
    universe: { ...response.universe, partial: true, stale: true, source: 'last-good-cache' },
    dataState: 'stale',
    message,
    generatedAt: new Date(now).toISOString(),
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

export interface CryptoSignalScanner {
  scan(request: CryptoSignalScanRequest): Promise<ScannerResponse>;
  clearCache(): void;
}

export function createCryptoSignalScannerService(
  providers: CryptoScannerProviders = defaultProviders,
): CryptoSignalScanner {
  const lastGood = new Map<string, { at: number; response: ScannerResponse }>();
  return {
    clearCache() {
      lastGood.clear();
    },
    async scan(request) {
      const startedAt = providers.now();
      const key = cacheKey(request);
      let universe: CryptoUniverse;
      try {
        universe = await providers.getUniverse(request.market, request.signal);
      } catch (error) {
        if (request.signal?.aborted) throw error;
        const cached = lastGood.get(key);
        if (cached && providers.now() - cached.at <= CACHE_TTL_MS) {
          return staleFallback(cached.response, '공급자 오류로 마지막 정상 Scanner 결과를 stale 상태로 표시합니다.', providers.now());
        }
        throw error instanceof CryptoScannerProviderError
          ? error
          : new CryptoScannerProviderError(error instanceof Error ? error.message : 'CRYPTO_UNIVERSE_UNAVAILABLE');
      }

      const batchSize = Math.max(5, Math.min(MAX_BATCH_SIZE, Math.floor(request.batchSize) || 24));
      const cursor = Math.max(0, Math.min(universe.rows.length, Math.floor(request.cursor) || 0));
      const batch = universe.rows.slice(cursor, cursor + batchSize);
      const nextCursor = cursor + batch.length < universe.rows.length ? cursor + batch.length : null;
      const work = await runBoundedWorkPool(
        batch,
        async (ticker, _index, signal) => {
          const [candles, spread] = await Promise.all([
            providers.getCandles(request.market, ticker.symbol, request.timeframe, signal),
            providers.getSpread(request.market, ticker, signal),
          ]);
          return analyze(request, { ...ticker, ...spread }, candles, spread, providers.now());
        },
        {
          concurrency: CONCURRENCY,
          deadlineMs: DEADLINE_MS,
          itemTimeoutMs: ITEM_TIMEOUT_MS,
          signal: request.signal,
          now: providers.now,
        },
      );
      if (request.signal?.aborted || work.aborted) throw request.signal?.reason ?? new Error('CRYPTO_SCAN_ABORTED');

      const failures: ScannerFailure[] = work.outcomes
        .filter((outcome) => outcome.status !== 'fulfilled' || outcome.value == null)
        .map((outcome) => ({
          symbol: batch[outcome.index]?.symbol ?? 'UNKNOWN',
          reason: outcome.status === 'timed_out'
            ? 'timeout' as const
            : outcome.status === 'rejected'
              ? 'provider_error' as const
              : 'invalid_data' as const,
          message: outcome.status === 'timed_out'
            ? `종목별 ${ITEM_TIMEOUT_MS}ms timeout`
            : outcome.reason instanceof Error
              ? outcome.reason.message.slice(0, 180)
              : '유효한 캔들·시세를 만들지 못했습니다.',
        }));
      const cards = work.outcomes
        .filter((outcome): outcome is typeof outcome & { value: ScannerSignalCard } => (
          outcome.status === 'fulfilled' && outcome.value != null
        ))
        .map((outcome) => outcome.value)
        .filter((card) => request.minimumScore == null || card.score >= request.minimumScore)
        .filter((card) => request.maximumRiskScore == null
          || (card.riskScore != null && card.riskScore <= request.maximumRiskScore))
        .sort((left, right) => right.score - left.score
          || right.confidence - left.confidence
          || right.dataCompleteness - left.dataCompleteness
          || (right.tradingValue ?? -1) - (left.tradingValue ?? -1)
          || left.symbol.localeCompare(right.symbol));
      const lifecycle = applyScannerSignalLifecycle(request.memberId, cards, providers.now());
      const partial = work.deadlineReached
        || work.startedCount < batch.length
        || work.rejectedCount > 0
        || work.timedOutCount > 0
        || universe.providerErrorCount > 0;
      const timedOut = work.deadlineReached || work.timedOutCount > 0;
      if (batch.length > 0 && work.fulfilledCount === 0) {
        const cached = lastGood.get(key);
        if (cached && providers.now() - cached.at <= CACHE_TTL_MS) {
          return staleFallback(cached.response, '모든 종목 분석이 실패해 마지막 정상 결과를 stale 상태로 표시합니다.', providers.now());
        }
        throw new CryptoScannerProviderError('CRYPTO_BATCH_UNAVAILABLE');
      }
      const response: ScannerResponse = {
        ok: true,
        requestId: randomUUID(),
        assetClass: request.market === 'spot' ? 'coin_spot' : 'coin_futures',
        market: request.market === 'spot' ? 'UPBIT_KRW' : 'BITGET_USDT_FUTURES',
        timeframe: request.timeframe,
        cards: lifecycle.cards,
        alerts: lifecycle.alerts,
        failures,
        execution: {
          requestedCount: batch.length,
          startedCount: work.startedCount,
          completedCount: work.fulfilledCount,
          excludedCount: Math.max(0, work.fulfilledCount - lifecycle.cards.length),
          providerErrorCount: work.rejectedCount + universe.providerErrorCount,
          timeoutCount: work.timedOutCount,
          partial,
          timedOut,
          cancelled: false,
          duplicate: false,
          elapsedMs: Math.max(work.elapsedMs, providers.now() - startedAt),
          deadlineMs: DEADLINE_MS,
          itemTimeoutMs: ITEM_TIMEOUT_MS,
          maxConcurrency: work.maxConcurrency,
        },
        universe: {
          totalCount: universe.rows.length,
          cursor,
          nextCursor,
          source: universe.source,
          partial: universe.providerErrorCount > 0,
          stale: false,
          listingStatusCoverage: 'listed-or-unknown',
        },
        dataState: partial ? 'partial' : 'complete',
        message: partial
          ? `공개 공급자 일부 지연으로 ${work.fulfilledCount}/${batch.length}종목의 확인된 결과를 표시합니다.`
          : lifecycle.cards.length
            ? `${work.fulfilledCount}종목 공개 데이터 분석을 완료했습니다.`
            : '현재 묶음에서 선택 조건을 충족한 결과가 없습니다.',
        generatedAt: new Date(providers.now()).toISOString(),
        orderSubmitted: false,
        exchangeRequestSent: false,
      };
      if (work.fulfilledCount > 0) lastGood.set(key, { at: providers.now(), response });
      return response;
    },
  };
}

export const CryptoSignalScannerService = createCryptoSignalScannerService();

export function clearCryptoScannerCacheForTests(): void {
  CryptoSignalScannerService.clearCache();
}

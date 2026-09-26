export type BitgetFuturesGranularity = '5m' | '1H' | '1D';

export type BitgetPublicRequest = {
  method: 'GET';
  path: string;
  query: string;
};

export type BitgetPublicCandle = {
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  baseVolume: number;
  quoteVolume: number;
};

export type BitgetFuturesPublicEvidence = {
  provider: 'bitget';
  productType: 'USDT-FUTURES';
  symbol: string;
  lastPrice: number;
  bidPrice: number;
  askPrice: number;
  markPrice: number;
  indexPrice: number;
  tickerTimestampMs: number;
  fundingRate: number;
  fundingIntervalHours: number;
  nextFundingUpdateMs: number;
  openInterest: number;
  openInterestTimestampMs: number;
  minTradeNum: number;
  sizeMultiplier: number;
  minTradeUsdt: number;
  priceStep: number;
  makerFeeRate: number;
  takerFeeRate: number;
  minLeverage: number;
  maxLeverage: number;
  candles5m: BitgetPublicCandle[];
  candles1h: BitgetPublicCandle[];
  benchmarkBtc1h: BitgetPublicCandle[];
  benchmarkBtc1d: BitgetPublicCandle[];
  observedAtMs: number;
  dataQuality: 'ready';
};

const PRODUCT_TYPE = 'USDT-FUTURES';
const GRANULARITY_MS: Record<BitgetFuturesGranularity, number> = {
  '5m': 5 * 60_000,
  '1H': 60 * 60_000,
  '1D': 24 * 60 * 60_000,
};

function finiteNumber(value: unknown, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function positiveNumber(value: unknown, code: string): number {
  const parsed = finiteNumber(value, code);
  if (parsed <= 0) throw new Error(code);
  return parsed;
}

function objectValue(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function successData(envelope: unknown, code: string): unknown {
  const value = objectValue(envelope, code);
  if (value.code !== '00000') throw new Error(`${code}_PROVIDER_ERROR`);
  return value.data;
}

function singleDataObject(envelope: unknown, code: string): Record<string, unknown> {
  const data = successData(envelope, code);
  if (!Array.isArray(data) || data.length !== 1) throw new Error(`${code}_DATA`);
  return objectValue(data[0], `${code}_DATA`);
}

export function normalizeBitgetFuturesSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normalized || !normalized.endsWith('USDT')) throw new Error('BITGET_SYMBOL_INVALID');
  return normalized;
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export function buildBitgetFuturesPublicRequests(symbol: string): Record<string, BitgetPublicRequest> {
  const normalized = normalizeBitgetFuturesSymbol(symbol);
  const candle = (target: string, granularity: BitgetFuturesGranularity, limit: string): BitgetPublicRequest => ({
    method: 'GET',
    path: '/api/v2/mix/market/candles',
    query: query({ symbol: target, productType: PRODUCT_TYPE, granularity, limit }),
  });
  return {
    symbol5m: candle(normalized, '5m', '300'),
    symbol1h: candle(normalized, '1H', '240'),
    benchmarkBtc1h: candle('BTCUSDT', '1H', '240'),
    benchmarkBtc1d: candle('BTCUSDT', '1D', '120'),
    ticker: { method: 'GET', path: '/api/v2/mix/market/ticker', query: query({ symbol: normalized, productType: PRODUCT_TYPE }) },
    funding: { method: 'GET', path: '/api/v2/mix/market/current-fund-rate', query: query({ symbol: normalized, productType: PRODUCT_TYPE }) },
    openInterest: { method: 'GET', path: '/api/v2/mix/market/open-interest', query: query({ symbol: normalized, productType: PRODUCT_TYPE }) },
    contract: { method: 'GET', path: '/api/v2/mix/market/contracts', query: query({ symbol: normalized, productType: PRODUCT_TYPE }) },
  };
}

export function normalizeBitgetCandles(envelope: unknown, granularity: BitgetFuturesGranularity, nowMs: number): BitgetPublicCandle[] {
  const data = successData(envelope, 'BITGET_CANDLES');
  if (!Array.isArray(data)) throw new Error('BITGET_CANDLES_DATA');
  const unique = new Map<number, BitgetPublicCandle>();
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 7) throw new Error('BITGET_CANDLE_ROW');
    const candle: BitgetPublicCandle = {
      timestampMs: positiveNumber(row[0], 'BITGET_CANDLE_TIMESTAMP'),
      open: positiveNumber(row[1], 'BITGET_CANDLE_OPEN'),
      high: positiveNumber(row[2], 'BITGET_CANDLE_HIGH'),
      low: positiveNumber(row[3], 'BITGET_CANDLE_LOW'),
      close: positiveNumber(row[4], 'BITGET_CANDLE_CLOSE'),
      baseVolume: finiteNumber(row[5], 'BITGET_CANDLE_BASE_VOLUME'),
      quoteVolume: finiteNumber(row[6], 'BITGET_CANDLE_QUOTE_VOLUME'),
    };
    if (candle.baseVolume < 0 || candle.quoteVolume < 0) throw new Error('BITGET_CANDLE_VOLUME_NEGATIVE');
    if (candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close) || candle.high < candle.low) {
      throw new Error('BITGET_CANDLE_OHLC_INVALID');
    }
    if (unique.has(candle.timestampMs)) throw new Error('BITGET_CANDLE_DUPLICATE_TIMESTAMP');
    unique.set(candle.timestampMs, candle);
  }
  const durationMs = GRANULARITY_MS[granularity];
  return [...unique.values()]
    .filter((candle) => candle.timestampMs + durationMs <= nowMs)
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

export function buildBitgetFuturesPublicEvidence(input: {
  symbol: string;
  nowMs: number;
  maxRealtimeAgeMs?: number;
  ticker: unknown;
  funding: unknown;
  openInterest: unknown;
  contract: unknown;
  candles5m: unknown;
  candles1h: unknown;
  benchmarkBtc1h: unknown;
  benchmarkBtc1d: unknown;
}): BitgetFuturesPublicEvidence {
  const symbol = normalizeBitgetFuturesSymbol(input.symbol);
  const ticker = singleDataObject(input.ticker, 'BITGET_TICKER');
  if (normalizeBitgetFuturesSymbol(String(ticker.symbol ?? '')) !== symbol) throw new Error('BITGET_TICKER_SYMBOL_MISMATCH');
  const lastPrice = positiveNumber(ticker.lastPr, 'BITGET_TICKER_LAST');
  const bidPrice = positiveNumber(ticker.bidPr, 'BITGET_TICKER_BID');
  const askPrice = positiveNumber(ticker.askPr, 'BITGET_TICKER_ASK');
  if (bidPrice > askPrice) throw new Error('BITGET_TICKER_CROSSED');
  const tickerTimestampMs = positiveNumber(ticker.ts, 'BITGET_TICKER_TIMESTAMP');

  const funding = singleDataObject(input.funding, 'BITGET_FUNDING');
  if (normalizeBitgetFuturesSymbol(String(funding.symbol ?? '')) !== symbol) throw new Error('BITGET_FUNDING_SYMBOL_MISMATCH');

  const oiData = objectValue(successData(input.openInterest, 'BITGET_OPEN_INTEREST'), 'BITGET_OPEN_INTEREST_DATA');
  if (!Array.isArray(oiData.openInterestList) || oiData.openInterestList.length !== 1) throw new Error('BITGET_OPEN_INTEREST_LIST');
  const oi = objectValue(oiData.openInterestList[0], 'BITGET_OPEN_INTEREST_ROW');
  if (normalizeBitgetFuturesSymbol(String(oi.symbol ?? '')) !== symbol) throw new Error('BITGET_OPEN_INTEREST_SYMBOL_MISMATCH');
  const openInterest = finiteNumber(oi.size, 'BITGET_OPEN_INTEREST_SIZE');
  if (openInterest < 0) throw new Error('BITGET_OPEN_INTEREST_SIZE');
  const openInterestTimestampMs = positiveNumber(oiData.ts, 'BITGET_OPEN_INTEREST_TIMESTAMP');

  const contract = singleDataObject(input.contract, 'BITGET_CONTRACT');
  if (normalizeBitgetFuturesSymbol(String(contract.symbol ?? '')) !== symbol) throw new Error('BITGET_CONTRACT_SYMBOL_MISMATCH');
  if (String(contract.symbolStatus ?? '') !== 'normal') throw new Error('BITGET_CONTRACT_NOT_TRADABLE');
  const pricePlace = finiteNumber(contract.pricePlace, 'BITGET_CONTRACT_PRICE_PLACE');
  const priceEndStep = positiveNumber(contract.priceEndStep, 'BITGET_CONTRACT_PRICE_END_STEP');
  const minLeverage = positiveNumber(contract.minLever, 'BITGET_CONTRACT_MIN_LEVERAGE');
  const maxLeverage = positiveNumber(contract.maxLever, 'BITGET_CONTRACT_MAX_LEVERAGE');
  if (maxLeverage < minLeverage) throw new Error('BITGET_CONTRACT_LEVERAGE_RANGE');

  const maxRealtimeAgeMs = input.maxRealtimeAgeMs ?? 30_000;
  if (input.nowMs < tickerTimestampMs || input.nowMs - tickerTimestampMs > maxRealtimeAgeMs) throw new Error('BITGET_TICKER_STALE');
  if (input.nowMs < openInterestTimestampMs || input.nowMs - openInterestTimestampMs > maxRealtimeAgeMs) throw new Error('BITGET_OPEN_INTEREST_STALE');

  const candles5m = normalizeBitgetCandles(input.candles5m, '5m', input.nowMs);
  const candles1h = normalizeBitgetCandles(input.candles1h, '1H', input.nowMs);
  const benchmarkBtc1h = normalizeBitgetCandles(input.benchmarkBtc1h, '1H', input.nowMs);
  const benchmarkBtc1d = normalizeBitgetCandles(input.benchmarkBtc1d, '1D', input.nowMs);
  if (!candles5m.length || !candles1h.length || !benchmarkBtc1h.length || !benchmarkBtc1d.length) throw new Error('BITGET_CLOSED_CANDLE_EVIDENCE_MISSING');

  return {
    provider: 'bitget',
    productType: PRODUCT_TYPE,
    symbol,
    lastPrice,
    bidPrice,
    askPrice,
    markPrice: positiveNumber(ticker.markPrice, 'BITGET_TICKER_MARK'),
    indexPrice: positiveNumber(ticker.indexPrice, 'BITGET_TICKER_INDEX'),
    tickerTimestampMs,
    fundingRate: finiteNumber(funding.fundingRate, 'BITGET_FUNDING_RATE'),
    fundingIntervalHours: positiveNumber(funding.fundingRateInterval, 'BITGET_FUNDING_INTERVAL'),
    nextFundingUpdateMs: positiveNumber(funding.nextUpdate, 'BITGET_FUNDING_NEXT_UPDATE'),
    openInterest,
    openInterestTimestampMs,
    minTradeNum: positiveNumber(contract.minTradeNum, 'BITGET_CONTRACT_MIN_TRADE_NUM'),
    sizeMultiplier: positiveNumber(contract.sizeMultiplier, 'BITGET_CONTRACT_SIZE_MULTIPLIER'),
    minTradeUsdt: positiveNumber(contract.minTradeUSDT, 'BITGET_CONTRACT_MIN_TRADE_USDT'),
    priceStep: priceEndStep * 10 ** (-pricePlace),
    makerFeeRate: finiteNumber(contract.makerFeeRate, 'BITGET_CONTRACT_MAKER_FEE'),
    takerFeeRate: finiteNumber(contract.takerFeeRate, 'BITGET_CONTRACT_TAKER_FEE'),
    minLeverage,
    maxLeverage,
    candles5m,
    candles1h,
    benchmarkBtc1h,
    benchmarkBtc1d,
    observedAtMs: input.nowMs,
    dataQuality: 'ready',
  };
}

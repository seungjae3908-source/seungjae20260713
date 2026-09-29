import { absoluteUpbitCandleTime } from '../lib/upbit-candle-time';
import type { Candle, Timeframe } from '../sample/types';
import {
  atrSeries,
  emaSeries,
  rsiSeries,
  sanitizeClosedCandles,
} from './backtest-indicators.service';
import {
  getFuturesCandles,
  type NormalizedCandle,
} from './futures-market-data.service';
import { MarketDataService } from './market-data.service';

export type AiChatTimeframeMarket = 'KR' | 'US' | 'UPBIT' | 'BITGET';

export type AiChatTimeframeEvidence = {
  schemaVersion: 'ai-chat-timeframe-evidence-v1';
  market: AiChatTimeframeMarket;
  symbol: string;
  timeframe: string;
  status: 'complete' | 'partial' | 'unavailable';
  provider: string | null;
  asOf: string | null;
  freshness: 'current' | 'delayed' | 'stale' | 'unavailable';
  freshnessAgeMs: number | null;
  expectedCandleIntervalMs: number | null;
  candleCount: number;
  lastClosedCandle: {
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null;
  indicators: {
    ema20: number | null;
    ema50: number | null;
    rsi14: number | null;
    atr14: number | null;
  };
  warnings: string[];
  closedCandlesOnly: true;
  publicMarketDataOnly: true;
  orderCapability: false;
};

type UpbitRow = {
  candle_date_time_utc?: unknown;
  candle_date_time_kst?: unknown;
  opening_price?: unknown;
  high_price?: unknown;
  low_price?: unknown;
  trade_price?: unknown;
  candle_acc_trade_volume?: unknown;
};

const TIMEFRAME_MS: Readonly<Record<string, number>> = Object.freeze({
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '60m': 60 * 60_000,
  '1H': 60 * 60_000,
  '4H': 4 * 60 * 60_000,
  '1D': 24 * 60 * 60_000,
});

function timeframeFreshness(
  last: NormalizedCandle | null,
  timeframe: string,
  nowMs: number,
): Pick<AiChatTimeframeEvidence, 'freshness' | 'freshnessAgeMs' | 'expectedCandleIntervalMs'> {
  const interval = TIMEFRAME_MS[timeframe] ?? null;
  if (!last || interval == null) {
    return {
      freshness: last ? 'delayed' : 'unavailable',
      freshnessAgeMs: last ? Math.max(0, nowMs - last.timestamp) : null,
      expectedCandleIntervalMs: interval,
    };
  }
  const closedAt = last.timestamp + interval;
  const ageMs = Math.max(0, nowMs - closedAt);
  const freshness = ageMs <= interval
    ? 'current'
    : ageMs <= interval * 3
      ? 'delayed'
      : 'stale';
  return { freshness, freshnessAgeMs: ageMs, expectedCandleIntervalMs: interval };
}

function number(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 100_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizedSymbol(market: AiChatTimeframeMarket, value: string): string {
  const raw = value.trim().toUpperCase();
  if (market === 'UPBIT') return raw.replace(/^KRW[-_:]?/, '').replace(/[^A-Z0-9]/g, '');
  if (market === 'BITGET') return raw.replace(/[\s/_-]+/g, '');
  if (market === 'KR') return raw.replace(/\D/g, '').slice(0, 6);
  return raw.replace(/[^A-Z0-9.-]/g, '').slice(0, 20);
}

function normalizeStockTimeframe(timeframe: string): Timeframe {
  return (timeframe === '1H' ? '60m' : timeframe) as Timeframe;
}

function toIndicatorCandle(input: {
  time: unknown;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume: unknown;
  timeframe: string;
  symbol: string;
  nowMs: number;
  explicitClosed?: boolean;
  source: string;
}): NormalizedCandle | null {
  const timestamp = timestampMs(input.time);
  const open = number(input.open);
  const high = number(input.high);
  const low = number(input.low);
  const close = number(input.close);
  const volume = number(input.volume);
  const duration = TIMEFRAME_MS[input.timeframe] ?? null;
  if (
    timestamp == null || open == null || high == null || low == null || close == null || volume == null
    || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0
    || high < low || open < low || open > high || close < low || close > high
  ) return null;
  const closed = input.explicitClosed ?? (duration != null && timestamp + duration <= input.nowMs);
  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume,
    quoteVolume: null,
    timeframe: input.timeframe,
    symbol: input.symbol,
    market: 'crypto-futures',
    source: input.source,
    isClosed: closed,
    isDelayed: false,
    updatedAt: new Date(input.nowMs).toISOString(),
  };
}

function stockCandles(
  rows: readonly Candle[],
  market: 'KR' | 'US',
  symbol: string,
  timeframe: string,
  provider: string,
  nowMs: number,
): NormalizedCandle[] {
  return rows
    .map((row) => toIndicatorCandle({
      time: row.time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      timeframe,
      symbol,
      nowMs,
      source: `${market.toLowerCase()}:${provider}`,
    }))
    .filter((row): row is NormalizedCandle => row != null);
}

function upbitPath(symbol: string, timeframe: string): string | null {
  if (timeframe === '1D') {
    return `https://api.upbit.com/v1/candles/days?market=${encodeURIComponent(`KRW-${symbol}`)}&count=200`;
  }
  const unit = timeframe === '1H' || timeframe === '60m'
    ? 60
    : timeframe === '4H'
      ? 240
      : Number(timeframe.replace(/m$/u, ''));
  if (![1, 3, 5, 15, 30, 60, 240].includes(unit)) return null;
  return `https://api.upbit.com/v1/candles/minutes/${unit}?market=${encodeURIComponent(`KRW-${symbol}`)}&count=200`;
}

async function loadUpbitCandles(
  symbol: string,
  timeframe: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<NormalizedCandle[]> {
  const url = upbitPath(symbol, timeframe);
  if (!url) return [];
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'seungjae-investment-app/1.0' },
    signal,
  });
  if (!response.ok) throw new Error(`UPBIT_TIMEFRAME_HTTP_${response.status}`);
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error('UPBIT_TIMEFRAME_RESPONSE_INVALID');
  return (payload as UpbitRow[])
    .slice()
    .reverse()
    .map((row) => toIndicatorCandle({
      time: absoluteUpbitCandleTime(row),
      open: row.opening_price,
      high: row.high_price,
      low: row.low_price,
      close: row.trade_price,
      volume: row.candle_acc_trade_volume,
      timeframe,
      symbol,
      nowMs,
      source: 'upbit-public',
    }))
    .filter((row): row is NormalizedCandle => row != null);
}

function latest<T>(series: readonly (T | null)[]): T | null {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    if (series[index] != null) return series[index] as T;
  }
  return null;
}

export function buildAiChatTimeframeEvidence(input: {
  market: AiChatTimeframeMarket;
  symbol: string;
  timeframe: string;
  provider: string | null;
  asOf: string | null;
  candles: readonly NormalizedCandle[];
  warnings?: readonly string[];
  nowMs?: number;
}): AiChatTimeframeEvidence {
  const sanitized = sanitizeClosedCandles(input.candles);
  const candles = sanitized.data;
  const closes = candles.map((row) => row.close);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const rsi14 = rsiSeries(closes, 14);
  const atr14 = atrSeries(candles, 14);
  const last = candles.at(-1) ?? null;
  const recency = timeframeFreshness(last, input.timeframe, input.nowMs ?? Date.now());
  const warnings = [...new Set([...(input.warnings ?? []), ...sanitized.warnings])];
  if (candles.length < 50) warnings.push('EMA50 계산에 필요한 닫힌 캔들 표본이 부족할 수 있습니다.');
  if (recency.freshness === 'delayed') warnings.push('선택 시간봉 최신성이 지연 상태입니다.');
  if (recency.freshness === 'stale') warnings.push('선택 시간봉 최신성이 오래되어 현재 판단 근거로 사용하면 안 됩니다.');
  const complete = candles.length >= 50
    && latest(ema20) != null
    && latest(ema50) != null
    && latest(rsi14) != null
    && latest(atr14) != null;

  return {
    schemaVersion: 'ai-chat-timeframe-evidence-v1',
    market: input.market,
    symbol: input.symbol,
    timeframe: input.timeframe,
    status: candles.length < 2 ? 'unavailable' : complete ? 'complete' : 'partial',
    provider: input.provider,
    asOf: last ? new Date(last.timestamp).toISOString() : input.asOf,
    freshness: recency.freshness,
    freshnessAgeMs: recency.freshnessAgeMs,
    expectedCandleIntervalMs: recency.expectedCandleIntervalMs,
    candleCount: candles.length,
    lastClosedCandle: last ? {
      time: new Date(last.timestamp).toISOString(),
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      volume: last.volume,
    } : null,
    indicators: {
      ema20: latest(ema20),
      ema50: latest(ema50),
      rsi14: latest(rsi14),
      atr14: latest(atr14),
    },
    warnings,
    closedCandlesOnly: true,
    publicMarketDataOnly: true,
    orderCapability: false,
  };
}

export async function loadAiChatTimeframeEvidence(
  market: AiChatTimeframeMarket,
  rawSymbol: string,
  timeframe: string,
  signal?: AbortSignal,
): Promise<AiChatTimeframeEvidence> {
  const symbol = normalizedSymbol(market, rawSymbol);
  const nowMs = Date.now();
  try {
    if (market === 'KR' || market === 'US') {
      const result = await MarketDataService.getCandlesMeta(symbol, normalizeStockTimeframe(timeframe));
      return buildAiChatTimeframeEvidence({
        market,
        symbol,
        timeframe,
        provider: result.provider,
        asOf: result.fetchedAt,
        candles: stockCandles(result.candles, market, symbol, timeframe, result.provider, nowMs),
        warnings: result.evidence?.completeness === 'partial'
          ? [`시장 데이터 표본이 부분 수집 상태입니다: ${result.evidence.reason}`]
          : [],
        nowMs,
      });
    }

    if (market === 'BITGET') {
      const result = await getFuturesCandles({ symbol, timeframe, limit: 200 });
      return buildAiChatTimeframeEvidence({
        market,
        symbol,
        timeframe,
        provider: 'bitget-public',
        asOf: result.updatedAt,
        candles: result.data,
        warnings: result.warnings,
        nowMs,
      });
    }

    const rows = await loadUpbitCandles(symbol, timeframe, signal);
    return buildAiChatTimeframeEvidence({
      market,
      symbol,
      timeframe,
      provider: 'upbit-public',
      asOf: new Date(nowMs).toISOString(),
      candles: rows,
      nowMs,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return {
      schemaVersion: 'ai-chat-timeframe-evidence-v1',
      market,
      symbol,
      timeframe,
      status: 'unavailable',
      provider: null,
      asOf: null,
      freshness: 'unavailable',
      freshnessAgeMs: null,
      expectedCandleIntervalMs: TIMEFRAME_MS[timeframe] ?? null,
      candleCount: 0,
      lastClosedCandle: null,
      indicators: { ema20: null, ema50: null, rsi14: null, atr14: null },
      warnings: ['선택 시간봉 공개 데이터를 불러오지 못했습니다.'],
      closedCandlesOnly: true,
      publicMarketDataOnly: true,
      orderCapability: false,
    };
  }
}

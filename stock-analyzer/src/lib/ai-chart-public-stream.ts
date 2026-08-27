import {
  chartTimeframeSeconds,
  type NormalizedChartCandle,
} from './chart-candle-normalizer';
import type { UnifiedChartTimeframe } from './unified-chart-data';

export type AiChartPublicStreamMarket = 'UPBIT' | 'BITGET';
export type AiChartPublicStreamStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'LIVE_STREAM'
  | 'RECOVERING'
  | 'FALLBACK_POLLING';

export type AiChartPublicTradeEvent = {
  provider: 'UPBIT_PUBLIC' | 'BITGET_PUBLIC';
  market: AiChartPublicStreamMarket;
  symbol: string;
  eventId: string;
  sequence: number | null;
  eventTimeMs: number;
  receivedAtMs: number;
  price: number;
  volume: number;
  aggressor: 'BUY' | 'SELL' | 'UNKNOWN';
};

export type AiChartStreamReduction = {
  candles: NormalizedChartCandle[];
  duplicate: boolean;
  outOfOrder: boolean;
  sequenceGap: boolean;
  missingBars: number;
  lastEventTimeMs: number | null;
  lastSequence: number | null;
  seenEventIds: string[];
};

export type AiChartPublicStreamSubscription = {
  market: AiChartPublicStreamMarket;
  endpoint: string;
  subscribePayload: string;
  heartbeatPayload: string;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
};

export const AI_CHART_PUBLIC_STREAM_ENDPOINTS = Object.freeze({
  UPBIT: 'wss://api.upbit.com/websocket/v1',
  BITGET: 'wss://ws.bitget.com/v2/ws/public',
} as const);

const MAX_SEEN_EVENT_IDS = 512;
const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_AFTER_MS = 45_000;

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function nonNegative(value: unknown): number | null {
  const parsed = finite(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function normalizeBitgetSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/[-_/]/g, '');
}

function normalizeUpbitCode(symbol: string): string {
  const normalized = symbol.trim().toUpperCase().replace(/^KRW[-_:]?/, '');
  return `KRW-${normalized}`;
}

export function buildAiChartPublicStreamSubscription(input: {
  market: AiChartPublicStreamMarket;
  symbol: string;
  ticket?: string;
}): AiChartPublicStreamSubscription {
  if (input.market === 'UPBIT') {
    const code = normalizeUpbitCode(input.symbol);
    const ticket = input.ticket?.trim() || `ai-chart-${code}`;
    return {
      market: 'UPBIT',
      endpoint: AI_CHART_PUBLIC_STREAM_ENDPOINTS.UPBIT,
      subscribePayload: JSON.stringify([
        { ticket },
        { type: 'trade', codes: [code], is_only_realtime: true },
        { format: 'DEFAULT' },
      ]),
      heartbeatPayload: 'PING',
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      staleAfterMs: STALE_AFTER_MS,
    };
  }

  const symbol = normalizeBitgetSymbol(input.symbol);
  return {
    market: 'BITGET',
    endpoint: AI_CHART_PUBLIC_STREAM_ENDPOINTS.BITGET,
    subscribePayload: JSON.stringify({
      op: 'subscribe',
      args: [{ instType: 'USDT-FUTURES', channel: 'trade', instId: symbol }],
    }),
    heartbeatPayload: 'ping',
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    staleAfterMs: STALE_AFTER_MS,
  };
}

export function parseUpbitPublicTradeMessage(
  payload: unknown,
  receivedAtMs = Date.now(),
): AiChartPublicTradeEvent[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const row = payload as Record<string, unknown>;
  if (row.type !== 'trade') return [];
  const code = String(row.code ?? row.market ?? '').trim().toUpperCase();
  const eventTimeMs = finite(row.trade_timestamp ?? row.timestamp);
  const price = positive(row.trade_price ?? row.price);
  const volume = nonNegative(row.trade_volume ?? row.volume);
  if (!code || eventTimeMs == null || price == null || volume == null) return [];
  const sequenceValue = finite(row.sequential_id);
  const sequence = sequenceValue != null && Number.isSafeInteger(sequenceValue) ? sequenceValue : null;
  const rawEventId = String(row.sequential_id ?? `${eventTimeMs}:${price}:${volume}`).trim();
  const side = String(row.ask_bid ?? '').toUpperCase();
  return [{
    provider: 'UPBIT_PUBLIC',
    market: 'UPBIT',
    symbol: code.replace(/^KRW-/, ''),
    eventId: `UPBIT:${code}:${rawEventId}`,
    sequence,
    eventTimeMs,
    receivedAtMs,
    price,
    volume,
    aggressor: side === 'BID' ? 'BUY' : side === 'ASK' ? 'SELL' : 'UNKNOWN',
  }];
}

export function parseBitgetPublicTradeMessage(
  payload: unknown,
  receivedAtMs = Date.now(),
): AiChartPublicTradeEvent[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const message = payload as Record<string, unknown>;
  const arg = message.arg && typeof message.arg === 'object' && !Array.isArray(message.arg)
    ? message.arg as Record<string, unknown>
    : null;
  if (!arg || arg.channel !== 'trade' || String(arg.instType ?? '').toUpperCase() !== 'USDT-FUTURES') return [];
  const symbol = normalizeBitgetSymbol(String(arg.instId ?? ''));
  if (!symbol || !Array.isArray(message.data)) return [];
  const events: AiChartPublicTradeEvent[] = [];
  for (const raw of message.data) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const eventTimeMs = finite(row.ts);
    const price = positive(row.price);
    const volume = nonNegative(row.size);
    const tradeId = String(row.tradeId ?? '').trim();
    if (eventTimeMs == null || price == null || volume == null || !tradeId) continue;
    const side = String(row.side ?? '').toLowerCase();
    events.push({
      provider: 'BITGET_PUBLIC',
      market: 'BITGET',
      symbol,
      eventId: `BITGET:${symbol}:${tradeId}:${eventTimeMs}`,
      sequence: null,
      eventTimeMs,
      receivedAtMs,
      price,
      volume,
      aggressor: side === 'buy' ? 'BUY' : side === 'sell' ? 'SELL' : 'UNKNOWN',
    });
  }
  return events;
}

export function parseAiChartPublicStreamMessage(
  market: AiChartPublicStreamMarket,
  raw: string,
  receivedAtMs = Date.now(),
): AiChartPublicTradeEvent[] {
  const text = raw.trim();
  if (!text || text === 'pong' || text === 'PONG') return [];
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  return market === 'UPBIT'
    ? parseUpbitPublicTradeMessage(payload, receivedAtMs)
    : parseBitgetPublicTradeMessage(payload, receivedAtMs);
}

function bucketStartSeconds(eventTimeMs: number, timeframe: UnifiedChartTimeframe): number {
  const intervalSeconds = chartTimeframeSeconds(timeframe);
  const eventSeconds = Math.floor(eventTimeMs / 1_000);
  return Math.floor(eventSeconds / intervalSeconds) * intervalSeconds;
}

function trimSeenEventIds(ids: string[]): string[] {
  return ids.length <= MAX_SEEN_EVENT_IDS ? ids : ids.slice(ids.length - MAX_SEEN_EVENT_IDS);
}

export function reduceAiChartPublicTrade(
  previous: AiChartStreamReduction,
  event: AiChartPublicTradeEvent,
  timeframe: UnifiedChartTimeframe,
): AiChartStreamReduction {
  if (previous.seenEventIds.includes(event.eventId)) {
    return { ...previous, duplicate: true, outOfOrder: false, sequenceGap: false, missingBars: 0 };
  }

  const seenEventIds = trimSeenEventIds([...previous.seenEventIds, event.eventId]);
  const lastSequence = previous.lastSequence;
  const sequenceGap = event.sequence != null && lastSequence != null && event.sequence > lastSequence + 1;
  const staleSequence = event.sequence != null && lastSequence != null && event.sequence <= lastSequence;
  const lastEventTimeMs = previous.lastEventTimeMs;
  const outOfOrder = staleSequence || (lastEventTimeMs != null && event.eventTimeMs < lastEventTimeMs);
  if (outOfOrder) {
    return {
      ...previous,
      duplicate: false,
      outOfOrder: true,
      sequenceGap,
      missingBars: 0,
      seenEventIds,
    };
  }

  const intervalSeconds = chartTimeframeSeconds(timeframe);
  const bucket = bucketStartSeconds(event.eventTimeMs, timeframe);
  const candles = previous.candles.map((candle) => ({ ...candle }));
  const last = candles.at(-1);
  let missingBars = 0;

  if (last && bucket < last.time) {
    return {
      ...previous,
      duplicate: false,
      outOfOrder: true,
      sequenceGap,
      missingBars: 0,
      seenEventIds,
    };
  }

  if (last && bucket === last.time) {
    last.high = Math.max(last.high, event.price);
    last.low = Math.min(last.low, event.price);
    last.close = event.price;
    last.volume += event.volume;
    last.isClosed = false;
    last.closeStateSource = 'unknown';
  } else {
    if (last) {
      const elapsed = bucket - last.time;
      missingBars = Math.max(0, Math.floor(elapsed / intervalSeconds) - 1);
      last.isClosed = true;
      last.closeStateSource = 'sequence';
    }
    candles.push({
      time: bucket,
      sourceTime: new Date(bucket * 1_000).toISOString(),
      open: event.price,
      high: event.price,
      low: event.price,
      close: event.price,
      volume: event.volume,
      isClosed: false,
      closeStateSource: 'unknown',
    });
  }

  return {
    candles,
    duplicate: false,
    outOfOrder: false,
    sequenceGap,
    missingBars,
    lastEventTimeMs: event.eventTimeMs,
    lastSequence: event.sequence ?? lastSequence,
    seenEventIds,
  };
}

export function createAiChartStreamReduction(
  candles: NormalizedChartCandle[],
): AiChartStreamReduction {
  return {
    candles: candles.map((candle) => ({ ...candle })),
    duplicate: false,
    outOfOrder: false,
    sequenceGap: false,
    missingBars: 0,
    lastEventTimeMs: null,
    lastSequence: null,
    seenEventIds: [],
  };
}

export function aiChartStreamFreshness(input: {
  status: AiChartPublicStreamStatus;
  lastEventAtMs: number | null;
  nowMs?: number;
  staleAfterMs?: number;
}): 'FRESH' | 'DELAYED' | 'STALE' | 'UNAVAILABLE' {
  if (input.status === 'DISCONNECTED' || input.status === 'FALLBACK_POLLING') return 'UNAVAILABLE';
  if (input.lastEventAtMs == null) return 'UNAVAILABLE';
  const age = Math.max(0, (input.nowMs ?? Date.now()) - input.lastEventAtMs);
  const staleAfterMs = input.staleAfterMs ?? STALE_AFTER_MS;
  if (age > staleAfterMs * 2) return 'STALE';
  if (age > staleAfterMs) return 'DELAYED';
  return 'FRESH';
}

export function nextAiChartReconnectDelayMs(attempt: number): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(30_000, 1_000 * (2 ** Math.min(safeAttempt, 5)));
}

export function shouldFallbackToPolling(input: {
  status: AiChartPublicStreamStatus;
  lastEventAtMs: number | null;
  nowMs?: number;
  staleAfterMs?: number;
  reconnectAttempts: number;
}): boolean {
  if (input.status === 'FALLBACK_POLLING') return true;
  if (input.reconnectAttempts >= 5) return true;
  if (input.lastEventAtMs == null) return input.status === 'DISCONNECTED';
  const staleAfterMs = input.staleAfterMs ?? STALE_AFTER_MS;
  return Math.max(0, (input.nowMs ?? Date.now()) - input.lastEventAtMs) > staleAfterMs * 2;
}

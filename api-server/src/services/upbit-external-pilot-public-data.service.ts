import type { ScannerQualityCandle } from './scanner-data-quality.service';

export type UpbitPilotTimeframe = '5m' | '15m' | '60m';

export type UpbitPilotCandle = ScannerQualityCandle & Readonly<{
  time: number;
  quoteVolume: number;
}>;

export type UpbitPilotTopOfBook = Readonly<{
  observedAtMs: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  totalBidSize: number;
  totalAskSize: number;
  bidLevels: readonly Readonly<{ price: number; size: number }>[];
  askLevels: readonly Readonly<{ price: number; size: number }>[];
}>;

export type UpbitTrendPullbackPublicSnapshot = Readonly<{
  schemaVersion: 'upbit-trend-pullback-public-snapshot-v1';
  symbol: string;
  fetchedAtMs: number;
  candles5m: readonly UpbitPilotCandle[];
  candles15m: readonly UpbitPilotCandle[];
  candles60m: readonly UpbitPilotCandle[];
  orderbook: UpbitPilotTopOfBook;
  provenance: readonly string[];
}>;

type FetchLike = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

type UpbitCandleRow = {
  candle_date_time_utc?: unknown;
  opening_price?: unknown;
  high_price?: unknown;
  low_price?: unknown;
  trade_price?: unknown;
  candle_acc_trade_volume?: unknown;
  candle_acc_trade_price?: unknown;
};

type UpbitOrderbookRow = {
  timestamp?: unknown;
  total_bid_size?: unknown;
  total_ask_size?: unknown;
  orderbook_units?: Array<{
    bid_price?: unknown;
    ask_price?: unknown;
    bid_size?: unknown;
    ask_size?: unknown;
  }>;
};

const UPBIT_PUBLIC_BASE = 'https://api.upbit.com';
const TIMEFRAME_MINUTES: Readonly<Record<UpbitPilotTimeframe, number>> = Object.freeze({
  '5m': 5,
  '15m': 15,
  '60m': 60,
});
const RETRYABLE = new Set([429, 500, 503]);

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function positive(value: unknown): number | null {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function normalizedSymbol(value: string): string {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!/^KRW-[A-Z0-9]{2,15}$/u.test(symbol)) throw new Error('UPBIT_PILOT_SYMBOL_INVALID');
  return symbol;
}

function retryAfterMs(response: Response, attempt: number): number {
  const raw = response.headers.get('retry-after')?.trim();
  const seconds = Number(raw);
  if (raw && Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, seconds * 1_000);
  const date = raw ? Date.parse(raw) : Number.NaN;
  if (Number.isFinite(date)) return Math.max(0, Math.min(10_000, date - Date.now()));
  return Math.min(4_000, 250 * (2 ** (attempt - 1)));
}

function normalizeCandles(
  rows: unknown,
  timeframe: UpbitPilotTimeframe,
  nowMs: number,
): readonly UpbitPilotCandle[] {
  if (!Array.isArray(rows)) throw new Error(`UPBIT_PILOT_${timeframe}_PAYLOAD_INVALID`);
  const durationMs = TIMEFRAME_MINUTES[timeframe] * 60_000;
  const byTime = new Map<number, UpbitPilotCandle>();
  for (const raw of rows) {
    const row = raw as UpbitCandleRow;
    const startMs = typeof row.candle_date_time_utc === 'string'
      ? Date.parse(`${row.candle_date_time_utc}Z`) : Number.NaN;
    const open = positive(row.opening_price);
    const high = positive(row.high_price);
    const low = positive(row.low_price);
    const close = positive(row.trade_price);
    const volume = finite(row.candle_acc_trade_volume);
    const quoteVolume = finite(row.candle_acc_trade_price);
    if (!Number.isFinite(startMs) || startMs <= 0 || startMs + durationMs > nowMs
      || open == null || high == null || low == null || close == null
      || volume == null || volume < 0 || quoteVolume == null || quoteVolume < 0
      || high < Math.max(open, close) || low > Math.min(open, close)) continue;
    byTime.set(startMs, Object.freeze({ time: startMs, open, high, low, close, volume, quoteVolume }));
  }
  const candles = [...byTime.values()].sort((left, right) => left.time - right.time);
  if (candles.length < 80) throw new Error(`UPBIT_PILOT_${timeframe}_CONFIRMED_CANDLES_INSUFFICIENT`);
  return Object.freeze(candles);
}

function normalizeOrderbook(rows: unknown, nowMs: number): UpbitPilotTopOfBook {
  if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== 'object') {
    throw new Error('UPBIT_PILOT_ORDERBOOK_PAYLOAD_INVALID');
  }
  const row = rows[0] as UpbitOrderbookRow;
  const unit = row.orderbook_units?.[0];
  const observedAtMs = finite(row.timestamp);
  const bid = positive(unit?.bid_price);
  const ask = positive(unit?.ask_price);
  const bidSize = positive(unit?.bid_size);
  const askSize = positive(unit?.ask_size);
  const totalBidSize = positive(row.total_bid_size);
  const totalAskSize = positive(row.total_ask_size);
  const bidLevels = (row.orderbook_units ?? []).flatMap((level) => {
    const price = positive(level.bid_price);
    const size = positive(level.bid_size);
    return price == null || size == null ? [] : [Object.freeze({ price, size })];
  });
  const askLevels = (row.orderbook_units ?? []).flatMap((level) => {
    const price = positive(level.ask_price);
    const size = positive(level.ask_size);
    return price == null || size == null ? [] : [Object.freeze({ price, size })];
  });
  if (observedAtMs == null || observedAtMs > nowMs + 2_000 || nowMs - observedAtMs > 30_000
    || bid == null || ask == null || ask < bid || bidSize == null || askSize == null
    || totalBidSize == null || totalAskSize == null || bidLevels.length === 0 || askLevels.length === 0) {
    throw new Error('UPBIT_PILOT_ORDERBOOK_INVALID_OR_STALE');
  }
  return Object.freeze({ observedAtMs, bid, ask, bidSize, askSize, totalBidSize, totalAskSize,
    bidLevels: Object.freeze(bidLevels), askLevels: Object.freeze(askLevels) });
}

export class UpbitExternalPilotPublicDataClient {
  private nextStartAt = 0;
  private scheduleTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => number = Date.now,
    private readonly minimumStartIntervalMs = 140,
  ) {}

  private async scheduled<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.scheduleTail;
    this.scheduleTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, this.nextStartAt - this.now());
      if (waitMs > 0) await this.sleep(waitMs);
      this.nextStartAt = this.now() + this.minimumStartIntervalMs;
      const started = operation();
      release();
      return await started;
    } catch (error) {
      release();
      throw error;
    }
  }

  private async json<T>(path: string, signal?: AbortSignal): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new Error('UPBIT_PILOT_ABORTED');
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason ?? new Error('UPBIT_PILOT_ABORTED'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error('UPBIT_PILOT_TIMEOUT')), 8_000);
      try {
        const response = await this.scheduled(() => this.fetchImpl(`${UPBIT_PUBLIC_BASE}${path}`, {
          signal: controller.signal,
          headers: { accept: 'application/json', 'user-agent': 'investment-platform-external-pilot/1.0' },
        }));
        if (response.ok) return await response.json() as T;
        const status = response.status;
        const detail = (await response.text().catch(() => '')).trim().slice(0, 120);
        lastError = new Error(`UPBIT_PILOT_HTTP_${status}:${detail}`);
        if (!RETRYABLE.has(status) || attempt === 4) throw lastError;
        await this.sleep(retryAfterMs(response, attempt));
      } catch (error) {
        lastError = error;
        if (signal?.aborted || attempt === 4) throw error;
        await this.sleep(Math.min(4_000, 250 * (2 ** (attempt - 1))));
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      }
    }
    throw lastError ?? new Error('UPBIT_PILOT_PUBLIC_REQUEST_FAILED');
  }

  async snapshot(symbolInput: string, signal?: AbortSignal): Promise<UpbitTrendPullbackPublicSnapshot> {
    const symbol = normalizedSymbol(symbolInput);
    const requestedAtMs = this.now();
    const candlePath = (timeframe: UpbitPilotTimeframe) =>
      `/v1/candles/minutes/${TIMEFRAME_MINUTES[timeframe]}?market=${encodeURIComponent(symbol)}&count=200`;
    const [five, fifteen, hourly, orderbook] = await Promise.all([
      this.json<unknown>(candlePath('5m'), signal),
      this.json<unknown>(candlePath('15m'), signal),
      this.json<unknown>(candlePath('60m'), signal),
      this.json<unknown>(`/v1/orderbook?markets=${encodeURIComponent(symbol)}&level=0`, signal),
    ]);
    const fetchedAtMs = this.now();
    if (fetchedAtMs < requestedAtMs) throw new Error('UPBIT_PILOT_CLOCK_REVERSED');
    return Object.freeze({
      schemaVersion: 'upbit-trend-pullback-public-snapshot-v1',
      symbol,
      fetchedAtMs,
      candles5m: normalizeCandles(five, '5m', fetchedAtMs),
      candles15m: normalizeCandles(fifteen, '15m', fetchedAtMs),
      candles60m: normalizeCandles(hourly, '60m', fetchedAtMs),
      orderbook: normalizeOrderbook(orderbook, fetchedAtMs),
      provenance: Object.freeze([
        `${UPBIT_PUBLIC_BASE}${candlePath('5m')}`,
        `${UPBIT_PUBLIC_BASE}${candlePath('15m')}`,
        `${UPBIT_PUBLIC_BASE}${candlePath('60m')}`,
        `${UPBIT_PUBLIC_BASE}/v1/orderbook`,
      ]),
    });
  }
}

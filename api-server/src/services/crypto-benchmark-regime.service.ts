/**
 * Crypto benchmark regime: BTC drawdown from its recent peak.
 *
 * When BTC has fallen sharply from its 24h peak, breakout longs in other coins
 * fail far more often (the whole market is being sold). The risk gate uses this
 * value to block NEW crypto long/buy entries only. Exits, reduce-only orders and
 * shorts are never blocked by it.
 *
 * Fail-open by design: if the benchmark cannot be read, the value is `null` and
 * the gate does not block. Every other existing risk check still applies, so a
 * Bitget candle outage cannot freeze crypto trading through this filter.
 */
import { normalizeBitgetCandles } from './bitget-futures-public-evidence.service';

/** New crypto longs are blocked when BTC is this far (%) below its 24h peak close. */
export const BENCHMARK_DRAWDOWN_LONG_BLOCK_PERCENT = 6;

const BITGET_BASE = 'https://api.bitget.com';
const LOOKBACK_5M_BARS = 288; // 24h of closed 5m candles
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

export function drawdownFromPeakPercent(closes: readonly number[]): number | null {
  const valid = closes.filter((value) => Number.isFinite(value) && value > 0);
  if (valid.length < 2) return null;
  const peak = Math.max(...valid);
  const last = valid[valid.length - 1];
  const percent = Math.max(0, (1 - last / peak) * 100);
  return Math.round(percent * 1e6) / 1e6;
}

export function isNewCryptoLongEntry(plan: {
  exchange: string;
  side: string;
}, riskReducing: boolean): boolean {
  if (riskReducing) return false;
  return (plan.exchange === 'bitget' && plan.side === 'long')
    || (plan.exchange === 'upbit' && plan.side === 'buy');
}

export function benchmarkDrawdownBlocksLong(drawdownPercent: number | null | undefined): boolean {
  return typeof drawdownPercent === 'number'
    && Number.isFinite(drawdownPercent)
    && drawdownPercent >= BENCHMARK_DRAWDOWN_LONG_BLOCK_PERCENT;
}

type FetchJson = (url: string) => Promise<unknown>;

async function defaultFetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`BENCHMARK_HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Cached reader (one Bitget call per minute at most). Returns null on any failure. */
export function createBtcBenchmarkDrawdownReader(fetchJson: FetchJson = defaultFetchJson) {
  let cached: { atMs: number; value: number | null } | null = null;
  return async function readBtcDrawdownPercent(nowMs: number): Promise<number | null> {
    if (cached && nowMs - cached.atMs < CACHE_TTL_MS) return cached.value;
    let value: number | null = null;
    try {
      const url = `${BITGET_BASE}/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES`
        + `&granularity=5m&limit=${LOOKBACK_5M_BARS}`;
      const candles = normalizeBitgetCandles(await fetchJson(url), '5m', nowMs);
      value = drawdownFromPeakPercent(candles.map((candle) => candle.close));
    } catch {
      value = null;
    }
    cached = { atMs: nowMs, value };
    return value;
  };
}

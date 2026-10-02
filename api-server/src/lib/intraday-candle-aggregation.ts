import type { Candle } from '../sample/types';

/** Only complete, clock-aligned bars from consecutive absolute one-minute observations. */
export function aggregateOneMinuteCandles(rows: Candle[], minutes: number, now = Date.now()): Candle[] {
  if (![3, 5, 15, 30].includes(minutes) || !Number.isFinite(now)) return [];
  const width = minutes * 60_000;
  const buckets = new Map<number, Array<{ at: number; candle: Candle }>>();
  for (const candle of rows) {
    // Offset-less timestamps depend on the server timezone and are not absolute evidence.
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(candle.time))) continue;
    const at = Date.parse(String(candle.time));
    if (!Number.isFinite(at) || at % 60_000 !== 0) continue;
    const start = Math.floor(at / width) * width;
    const bucket = buckets.get(start) ?? [];
    bucket.push({ at, candle });
    buckets.set(start, bucket);
  }
  const result: Candle[] = [];
  for (const [start, bucket] of [...buckets].sort(([a], [b]) => a - b)) {
    if (bucket.length !== minutes || start + width > now) continue;
    bucket.sort((a, b) => a.at - b.at);
    if (!bucket.every(({ at, candle }, index) => at === start + index * 60_000
      && [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0)
      && Number.isFinite(candle.volume) && candle.volume >= 0
      && candle.high >= Math.max(candle.open, candle.close, candle.low)
      && candle.low <= Math.min(candle.open, candle.close))) continue;
    result.push({
      time: bucket[0].candle.time,
      open: bucket[0].candle.open,
      high: Math.max(...bucket.map(({ candle }) => candle.high)),
      low: Math.min(...bucket.map(({ candle }) => candle.low)),
      close: bucket[bucket.length - 1].candle.close,
      volume: bucket.reduce((sum, { candle }) => sum + candle.volume, 0),
    });
  }
  return result;
}

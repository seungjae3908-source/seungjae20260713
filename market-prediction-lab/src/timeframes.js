export const TIMEFRAME_MS = Object.freeze({
  "1m": 60 * 1000,
  "3m": 3 * 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
});

export function timeframeToMs(timeframe) {
  const value = TIMEFRAME_MS[timeframe];
  if (!value) throw new RangeError(`unsupported timeframe: ${timeframe}`);
  return value;
}

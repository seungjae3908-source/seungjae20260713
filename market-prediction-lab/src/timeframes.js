export const TIMEFRAME_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
});

export function timeframeToMs(timeframe) {
  const value = TIMEFRAME_MS[timeframe];
  if (!value) throw new RangeError(`unsupported timeframe: ${timeframe}`);
  return value;
}

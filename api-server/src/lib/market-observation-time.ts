export const MARKET_OBSERVATION_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function normalizeMarketObservationTime(
  value: unknown,
  nowMs = Date.now(),
): string | null {
  if (value === null || value === undefined || value === '') return null;

  const parsedMs = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(String(value));

  if (!Number.isFinite(parsedMs) || parsedMs <= 0) return null;
  if (parsedMs > nowMs + MARKET_OBSERVATION_MAX_FUTURE_SKEW_MS) return null;

  return new Date(parsedMs).toISOString();
}

export function normalizeUnixSecondsObservationTime(
  value: unknown,
  nowMs = Date.now(),
): string | null {
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  return normalizeMarketObservationTime(seconds * 1000, nowMs);
}

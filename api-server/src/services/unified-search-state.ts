export type UnifiedSearchState = 'FULL' | 'PARTIAL' | 'DEGRADED' | 'EMPTY' | 'ERROR';

export function deriveUnifiedSearchState(input: {
  resultCount: number;
  partial: boolean;
  stale: boolean;
}): Exclude<UnifiedSearchState, 'ERROR'> {
  const resultCount = Number.isFinite(input.resultCount) ? Math.max(0, Math.trunc(input.resultCount)) : 0;
  if (resultCount > 0) {
    if (input.partial) return 'PARTIAL';
    if (input.stale) return 'DEGRADED';
    return 'FULL';
  }
  if (input.partial || input.stale) return 'DEGRADED';
  return 'EMPTY';
}

const SOURCE_FRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * `dataAsOf` is the oldest provider source time, so a recently rebuilt index
 * over an old source listing (e.g. the Nasdaq Trader directory over a weekend)
 * is stale too. The client rejects stale=false with a dataAsOf older than 24h.
 */
export function markStaleWhenSourceIsOld<T extends { stale: boolean; dataAsOf: string | null }>(
  response: T,
  nowMs = Date.now(),
): T {
  if (response.stale || response.dataAsOf == null) return response;
  const sourceAsOf = Date.parse(response.dataAsOf);
  if (!Number.isFinite(sourceAsOf) || nowMs - sourceAsOf <= SOURCE_FRESH_MAX_AGE_MS) return response;
  return { ...response, stale: true };
}

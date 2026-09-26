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

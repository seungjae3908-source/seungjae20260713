export type UnifiedSearchState = 'FULL' | 'PARTIAL' | 'DEGRADED' | 'EMPTY' | 'ERROR';

export function deriveUnifiedSearchState(input: {
  resultCount: number;
  partial: boolean;
  stale: boolean;
}): Exclude<UnifiedSearchState, 'ERROR'> {
  const resultCount = Number.isFinite(input.resultCount) ? Math.max(0, Math.trunc(input.resultCount)) : 0;
  if (input.stale) return 'DEGRADED';
  if (input.partial) return resultCount > 0 ? 'PARTIAL' : 'DEGRADED';
  return resultCount > 0 ? 'FULL' : 'EMPTY';
}

export type ScannerProviderHealthState =
  | 'READY'
  | 'SEARCH_EMPTY'
  | 'PROVIDER_FAILURE'
  | 'DATA_STALE'
  | 'RATE_LIMIT'
  | 'TIMEOUT';

export interface ScannerProviderHealth {
  provider: string;
  state: ScannerProviderHealthState;
  latencyMs: number | null;
  retryCount: number;
  timeout: boolean;
  lastSuccessfulFetch: string | null;
  freshness: 'FRESH' | 'STALE' | 'UNKNOWN';
  failureReason: string | null;
}

export function createScannerProviderHealth(input: Partial<ScannerProviderHealth> & Pick<ScannerProviderHealth, 'provider'>): ScannerProviderHealth {
  return {
    provider: input.provider,
    state: input.state ?? 'PROVIDER_FAILURE',
    latencyMs: input.latencyMs ?? null,
    retryCount: input.retryCount ?? 0,
    timeout: input.timeout ?? false,
    lastSuccessfulFetch: input.lastSuccessfulFetch ?? null,
    freshness: input.freshness ?? 'UNKNOWN',
    failureReason: input.failureReason ?? null,
  };
}

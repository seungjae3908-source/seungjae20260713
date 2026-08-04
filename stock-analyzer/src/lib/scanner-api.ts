import { authorizedFetch } from './auth-fetch';

export interface ScannerApiCard extends Record<string, unknown> {
  ticker?: string;
  market?: string;
}

export interface ScannerApiResult {
  ok: true;
  cards: ScannerApiCard[];
  results: ScannerApiCard[];
  selected: string[];
  supportedIndicators?: string[];
  fetchedAt?: string;
  searchRunId?: string;
  timeframe: string;
  partial: boolean;
  timedOut: boolean;
  completedCount: number;
  providerErrorCount: number;
  timeoutCount: number;
  scanned: number;
  requestedCount: number;
  elapsedMs: number;
  dataState: 'complete' | 'partial';
  message: string;
}

export interface ScannerApiOptions {
  volumeThreshold?: number;
  tradingValueThreshold?: number;
  marketCapThreshold?: number;
  minimumScore?: number;
  maximumRiskScore?: number;
  volumeLookbackDays?: number;
  tradingValueLookbackDays?: number;
  timeframe?: string;
}

export class ScannerProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ScannerProviderError';
  }
}

export async function scanMarket(
  indicators: string[],
  market: 'KR' | 'US',
  options: ScannerApiOptions,
  signal: AbortSignal,
): Promise<ScannerApiResult> {
  const params = new URLSearchParams({
    market,
    indicators: indicators.join(','),
  });
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) params.set(key, String(value));
  }

  const response = await authorizedFetch(`/api/market/scan?${params.toString()}`, {
    method: 'GET',
    cache: 'no-store',
    signal,
    headers: {
      'Cache-Control': 'no-cache, no-store, max-age=0',
    },
  });
  const body = await response.json().catch(() => null) as Partial<ScannerApiResult> & {
    message?: string;
  } | null;
  if (!response.ok || body?.ok !== true) {
    throw new ScannerProviderError(
      body?.message || `조건검색 공급자 요청 실패 (${response.status})`,
      response.status,
    );
  }
  return {
    ...body,
    ok: true,
    cards: Array.isArray(body.cards) ? body.cards : [],
    results: Array.isArray(body.results) ? body.results : [],
    selected: Array.isArray(body.selected) ? body.selected : [],
    timeframe: String(body.timeframe ?? options.timeframe ?? '1D'),
    partial: body.partial === true,
    timedOut: body.timedOut === true,
    completedCount: Number(body.completedCount ?? 0),
    providerErrorCount: Number(body.providerErrorCount ?? 0),
    timeoutCount: Number(body.timeoutCount ?? 0),
    scanned: Number(body.scanned ?? 0),
    requestedCount: Number(body.requestedCount ?? 0),
    elapsedMs: Number(body.elapsedMs ?? 0),
    dataState: body.dataState === 'partial' ? 'partial' : 'complete',
    message: String(body.message ?? ''),
  };
}

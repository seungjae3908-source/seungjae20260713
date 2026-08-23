import { apiGet, type SummaryItem } from '@/lib/api';

export type MarketSummaryDataState = 'ready' | 'partial' | 'provider_error';
export type MarketSummaryErrorCode =
  | 'SUMMARY_PROVIDER_PARTIAL'
  | 'SUMMARY_PROVIDER_UNAVAILABLE';

export interface MarketSummaryResponse {
  items: SummaryItem[];
  ok: boolean;
  available: boolean;
  partial: boolean;
  dataState: MarketSummaryDataState;
  provider: string;
  availableCount: number;
  totalCount: number;
  missingKeys: string[];
  retryable: boolean;
  error: MarketSummaryErrorCode | null;
  errorCode: MarketSummaryErrorCode | null;
  message: string | null;
  updatedAt?: string;
}

function finitePositive(value: unknown): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

export function validMarketSummaryItems(items: SummaryItem[]): SummaryItem[] {
  return items.filter((item) => item.ok === true && finitePositive(item.price));
}

export function getMarketSummary(): Promise<MarketSummaryResponse> {
  return apiGet<MarketSummaryResponse>('/market/summary');
}

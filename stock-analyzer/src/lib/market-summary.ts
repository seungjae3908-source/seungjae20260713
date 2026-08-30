import { apiGet, type SummaryItem } from './api';

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

type MarketSummaryWireResponse = Partial<MarketSummaryResponse> & {
  items?: SummaryItem[];
};

function finitePositive(value: unknown): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function usableMarketSummaryItem(item: SummaryItem): boolean {
  return item.ok === true && finitePositive(item.price);
}

export function validMarketSummaryItems(items: SummaryItem[]): SummaryItem[] {
  return items.filter(usableMarketSummaryItem);
}

export function normalizeMarketSummaryResponse(
  raw: MarketSummaryWireResponse,
): MarketSummaryResponse {
  const items = Array.isArray(raw.items) ? raw.items : [];
  const availableCount = items.filter(usableMarketSummaryItem).length;
  const totalCount = items.length;
  const available = availableCount > 0;
  const partial = available && availableCount < totalCount;
  const dataState: MarketSummaryDataState = !available
    ? 'provider_error'
    : partial
      ? 'partial'
      : 'ready';
  const missingKeys = items
    .filter((item) => !usableMarketSummaryItem(item))
    .map((item) => String(item.key ?? '').trim())
    .filter(Boolean);
  const error: MarketSummaryErrorCode | null = !available
    ? 'SUMMARY_PROVIDER_UNAVAILABLE'
    : partial
      ? 'SUMMARY_PROVIDER_PARTIAL'
      : null;

  return {
    items,
    ok: available,
    available,
    partial,
    dataState,
    provider: String(raw.provider ?? 'market-summary').trim() || 'market-summary',
    availableCount,
    totalCount,
    missingKeys,
    retryable: dataState !== 'ready',
    error,
    errorCode: error,
    message: !available
      ? '시장 요약 데이터를 확인할 수 없습니다.'
      : partial
        ? '일부 시장 요약 데이터가 지연되거나 누락되었습니다.'
        : null,
    ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
  };
}

export async function getMarketSummary(): Promise<MarketSummaryResponse> {
  const raw = await apiGet<MarketSummaryWireResponse>('/market/summary');
  return normalizeMarketSummaryResponse(raw);
}

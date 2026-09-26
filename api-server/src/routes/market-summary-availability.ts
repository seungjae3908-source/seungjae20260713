import { Router, type IRouter } from 'express';

type MarketSummaryDataState = 'ready' | 'partial' | 'provider_error';
type MarketSummaryErrorCode =
  | 'SUMMARY_PROVIDER_PARTIAL'
  | 'SUMMARY_PROVIDER_UNAVAILABLE';

type MarketSummaryItem = {
  key?: unknown;
  label?: unknown;
  price?: unknown;
  changePercent?: unknown;
  spark?: unknown;
  unit?: unknown;
  ok?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAvailableSummaryItem(item: MarketSummaryItem): boolean {
  const price = Number(item.price);
  return item.ok === true && Number.isFinite(price) && price > 0;
}

function summaryKey(item: MarketSummaryItem): string | null {
  const key = String(item.key ?? '').trim().toLowerCase();
  return key || null;
}

export function normalizeMarketSummaryPayload(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;

  const items = body.items.filter(isRecord) as MarketSummaryItem[];
  const availableItems = items.filter(isAvailableSummaryItem);
  const missingKeys = items
    .filter((item) => !isAvailableSummaryItem(item))
    .map(summaryKey)
    .filter((key): key is string => key !== null);

  const totalCount = items.length;
  const availableCount = availableItems.length;
  const dataState: MarketSummaryDataState =
    totalCount > 0 && availableCount === totalCount
      ? 'ready'
      : availableCount > 0
        ? 'partial'
        : 'provider_error';
  const errorCode: MarketSummaryErrorCode | null =
    dataState === 'partial'
      ? 'SUMMARY_PROVIDER_PARTIAL'
      : dataState === 'provider_error'
        ? 'SUMMARY_PROVIDER_UNAVAILABLE'
        : null;
  const message =
    dataState === 'partial'
      ? '일부 시장 지수의 공개 공급자 응답이 지연되고 있습니다.'
      : dataState === 'provider_error'
        ? '시장 지수 공개 공급자의 응답을 확인하지 못했습니다. 실제 가격을 표시하지 않습니다.'
        : null;

  return {
    ...body,
    items: availableItems,
    ok: dataState === 'ready',
    available: availableCount > 0,
    partial: dataState === 'partial',
    dataState,
    provider: 'Yahoo Finance',
    availableCount,
    totalCount,
    missingKeys,
    retryable: dataState !== 'ready',
    error: errorCode,
    errorCode,
    message,
  };
}

const router: IRouter = Router();

router.use((_req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = ((body: unknown) => {
    if (res.statusCode !== 200 && res.statusCode !== 503) {
      return originalJson(body);
    }

    const normalized = normalizeMarketSummaryPayload(body);
    if (!normalized) return originalJson(body);

    if (res.statusCode === 503 && normalized.dataState !== 'provider_error') {
      return originalJson(body);
    }

    // The transport completed successfully; provider availability is carried
    // explicitly in ok/dataState/errorCode. Unexpected backend failures such as
    // 502 remain non-2xx and continue to fail browser/Staging gates.
    res.statusCode = 200;
    return originalJson(normalized);
  }) as typeof res.json;

  next();
});

export default router;

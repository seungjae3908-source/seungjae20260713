import { Router, type IRouter } from 'express';

import coreRouter, {
  normalizeBitgetFuturesOrderbook as normalizeBitgetFuturesOrderbookCore,
  normalizeKiwoomOrderbook as normalizeKiwoomOrderbookCore,
  normalizeUpbitOrderbook as normalizeUpbitOrderbookCore,
  setOrderbookKiwoomLoaderForTests,
  setOrderbookPublicTransportForTests,
  type InstrumentOrderbookPayload as CoreOrderbookPayload,
} from './stock-orderbook-core';

export { setOrderbookKiwoomLoaderForTests, setOrderbookPublicTransportForTests };

export type InstrumentOrderbookStatus = 'ready' | 'partial' | 'stale' | 'unavailable' | 'invalid';
export type InstrumentOrderbookFreshness = 'fresh' | 'stale' | 'unknown';

export type InstrumentOrderbookPayload = Omit<CoreOrderbookPayload, 'status'> & {
  status: InstrumentOrderbookStatus;
  providerTimestamp: string | null;
  spreadPct: number | null;
};

const router: IRouter = Router();
const ALLOWED_STATUSES = new Set<InstrumentOrderbookStatus>([
  'ready',
  'partial',
  'stale',
  'unavailable',
  'invalid',
]);

function canonicalStatus(payload: CoreOrderbookPayload): InstrumentOrderbookStatus {
  if (payload.status === 'provider_error') return 'unavailable';
  if (payload.status === 'ready' && payload.freshness === 'stale') return 'stale';
  if (ALLOWED_STATUSES.has(payload.status as InstrumentOrderbookStatus)) {
    return payload.status as InstrumentOrderbookStatus;
  }
  return 'invalid';
}

function canonicalize(payload: CoreOrderbookPayload): InstrumentOrderbookPayload {
  const status = canonicalStatus(payload);
  const warnings = [...payload.warnings];
  if (payload.status === 'provider_error') {
    warnings.push('공급자 오류를 canonical unavailable 상태로 fail-closed 처리했습니다.');
  }
  if (status === 'stale' && payload.freshness !== 'stale') {
    warnings.push('상태와 최신성 정보가 일치하지 않아 stale로 fail-closed 처리했습니다.');
  }

  return {
    ...payload,
    status,
    providerTimestamp: payload.updatedAt,
    spreadPct: payload.spreadPercent,
    warnings,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function isCorePayload(value: unknown): value is CoreOrderbookPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.assetClass === 'string'
    && typeof row.market === 'string'
    && typeof row.status === 'string'
    && Array.isArray(row.asks)
    && Array.isArray(row.bids)
    && row.orderSubmitted === false
    && row.exchangeRequestSent === false;
}

export function normalizeKiwoomOrderbook(
  ...args: Parameters<typeof normalizeKiwoomOrderbookCore>
): InstrumentOrderbookPayload {
  return canonicalize(normalizeKiwoomOrderbookCore(...args));
}

export function normalizeUpbitOrderbook(
  ...args: Parameters<typeof normalizeUpbitOrderbookCore>
): InstrumentOrderbookPayload {
  return canonicalize(normalizeUpbitOrderbookCore(...args));
}

export function normalizeBitgetFuturesOrderbook(
  ...args: Parameters<typeof normalizeBitgetFuturesOrderbookCore>
): InstrumentOrderbookPayload {
  return canonicalize(normalizeBitgetFuturesOrderbookCore(...args));
}

// The historical core owns only verified public/read-only provider mechanics.
// This adapter is the only mounted surface and rewrites every core response to
// the V4.2 canonical contract before it can leave the API server.
router.use((_req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (isCorePayload(body)) return originalJson(canonicalize(body));
    return originalJson(body);
  }) as typeof res.json;
  next();
});
router.use(coreRouter);

export default router;

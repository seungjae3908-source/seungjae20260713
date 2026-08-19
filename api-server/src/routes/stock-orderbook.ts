import { Router, type IRouter, type Request } from 'express';
import { getTossAccessToken } from '../providers/toss';
import { resolveStockVenue, TossOrderbookProvider } from '../features/toss-orderbook/toss-orderbook.provider';

import coreRouter, {
  normalizeBitgetFuturesOrderbook as normalizeBitgetFuturesOrderbookCore,
  normalizeKiwoomOrderbook as normalizeKiwoomOrderbookCore,
  normalizeUpbitOrderbook as normalizeUpbitOrderbookCore,
  normalizeTossOrderbook as normalizeTossOrderbookCore,
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
const ASSET_CLASSES = new Set(['stock', 'crypto_spot', 'crypto_futures']);
const MARKETS = new Set(['KR', 'US', 'UPBIT', 'BITGET']);
const STOCK_VENUES = new Set(['auto', 'kiwoom', 'toss']);

function tossOrderbookEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.TOSS_ORDERBOOK_READ_ENABLED === 'true';
}

const tossOrderbook = new TossOrderbookProvider(
  { token: (signal) => getTossAccessToken(signal) },
  async ({ path, query, headers, signal }) => {
    const configured = process.env.TOSS_API_BASE_URL?.trim() || 'https://openapi.tossinvest.com';
    const base = new URL(configured);
    if (base.protocol !== 'https:') throw new Error('TOSS_ORDERBOOK_BASE_URL_INVALID');
    const response = await fetch(`${base.toString().replace(/\/$/, '')}${path}?${query}`, {
      method: 'GET', headers, signal,
    });
    let body: unknown = null;
    try { body = await response.json(); } catch { /* normalized below as unavailable */ }
    return { status: response.status, body };
  },
);

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

function canonicalTarget(query: Request['query']): {
  assetClass: 'stock' | 'crypto_spot' | 'crypto_futures';
  market: 'KR' | 'US' | 'UPBIT' | 'BITGET';
  symbol: string;
} | null {
  const assetClassRaw = String(query.assetClass ?? '').trim().toLowerCase();
  const marketRaw = String(query.market ?? '').trim().toUpperCase();
  const symbol = String(query.symbol ?? '').trim().toUpperCase().slice(0, 32);
  if (!ASSET_CLASSES.has(assetClassRaw) || !MARKETS.has(marketRaw) || !symbol) return null;

  const validPair = assetClassRaw === 'stock'
    ? marketRaw === 'KR' || marketRaw === 'US'
    : assetClassRaw === 'crypto_spot'
      ? marketRaw === 'UPBIT'
      : marketRaw === 'BITGET';
  if (!validPair) return null;

  return {
    assetClass: assetClassRaw as 'stock' | 'crypto_spot' | 'crypto_futures',
    market: marketRaw as 'KR' | 'US' | 'UPBIT' | 'BITGET',
    symbol,
  };
}

function invalidTargetResponse(query: Request['query']) {
  const assetClassRaw = String(query.assetClass ?? '').trim().toLowerCase();
  const marketRaw = String(query.market ?? '').trim().toUpperCase();
  const symbol = String(query.symbol ?? '').trim().toUpperCase().slice(0, 32);
  const assetClass = ASSET_CLASSES.has(assetClassRaw) ? assetClassRaw : 'stock';
  const market = MARKETS.has(marketRaw) ? marketRaw : 'US';
  const currency = market === 'KR' || market === 'UPBIT' ? 'KRW' : market === 'BITGET' ? 'USDT' : 'USD';
  return {
    ok: false,
    available: false,
    status: 'invalid' as const,
    assetClass,
    market,
    symbol,
    provider: null,
    providerTimestamp: null,
    receivedAt: new Date().toISOString(),
    freshness: 'unknown' as const,
    asks: [],
    bids: [],
    bestAsk: null,
    bestBid: null,
    spread: null,
    spreadPct: null,
    warnings: ['assetClass, market, symbol 조합이 canonical orderbook target과 일치하지 않습니다.'],
    reason: 'INVALID_ORDERBOOK_TARGET',
    orderSubmitted: false as const,
    exchangeRequestSent: false as const,
  };
}

router.get('/orderbook', async (req, res, next) => {
  const target = canonicalTarget(req.query);
  if (!target || target.assetClass !== 'stock') return next();
  const requested = String(req.query.venue ?? 'auto').trim().toLowerCase();
  if (!STOCK_VENUES.has(requested)) return res.status(400).json(invalidTargetResponse(req.query));
  const venue = resolveStockVenue(target.market as 'KR' | 'US', requested as 'auto' | 'kiwoom' | 'toss');
  if (venue === 'kiwoom') return next();
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (venue === null || !tossOrderbookEnabled()) {
    return res.status(200).json({
      ...invalidTargetResponse(req.query), status: 'unavailable',
      reason: venue === null ? 'STOCK_ORDERBOOK_VENUE_UNSUPPORTED' : 'TOSS_ORDERBOOK_READ_DISABLED',
    });
  }
  const controller = new AbortController();
  const abort = () => controller.abort(); req.once('aborted', abort);
  try {
    const payload = await tossOrderbook.load(target.market as 'KR' | 'US', target.symbol, controller.signal);
    if (!res.writableEnded) return res.status(200).json(payload);
  } catch (error) {
    if (!res.writableEnded) return res.status(200).json({
      ...invalidTargetResponse(req.query), status: 'unavailable',
      reason: error instanceof Error ? error.message : 'TOSS_ORDERBOOK_PROVIDER_UNAVAILABLE',
    });
  } finally { req.removeListener('aborted', abort); }
});

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

export function normalizeTossOrderbook(...args: Parameters<typeof normalizeTossOrderbookCore>): InstrumentOrderbookPayload {
  return canonicalize(normalizeTossOrderbookCore(...args));
}

// Canonical generic route inputs are strict. A mismatched assetClass/market pair
// must never be silently remapped to another provider or market.
router.use((req, res, next) => {
  if (req.method !== 'GET' || req.path !== '/orderbook') {
    next();
    return;
  }
  if (!canonicalTarget(req.query)) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(400).json(invalidTargetResponse(req.query));
    return;
  }
  next();
});

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

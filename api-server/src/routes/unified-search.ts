import { Router, type IRouter } from 'express';
import { requireAdmin } from '../middleware/auth';
import { unifiedSearchRateLimit } from '../middleware/search-rate-limit';
import {
  getUnifiedAssetSearchStatus,
  refreshUnifiedAssetSearchIndex,
  searchUnifiedAssets,
  startUnifiedAssetSearchRefreshTimer,
} from '../services/unified-asset-search.service';
import {
  buildFuturesSearchFallback,
  FUTURES_SEARCH_SOFT_DEADLINE_MS,
} from '../services/unified-futures-search-fallback';
import {
  buildKrSearchFallback,
  KR_SEARCH_SOFT_DEADLINE_MS,
} from '../services/unified-kr-search-fallback';
import {
  buildSpotSearchFallback,
  SPOT_SEARCH_SOFT_DEADLINE_MS,
} from '../services/unified-spot-search-fallback';
import {
  buildUsSearchFallback,
  US_SEARCH_SOFT_DEADLINE_MS,
} from '../services/unified-us-search-fallback';
import { deriveUnifiedSearchState } from '../services/unified-search-state';
import type { UnifiedAssetType, UnifiedSearchMarket } from '../lib/search-normalization';

const router: IRouter = Router();
const EXACT_CODE_METADATA_DEADLINE_MS = 350;
const SEARCH_HARD_DEADLINE_MS = 4_000;
const SEARCH_DEADLINE = Symbol('SEARCH_DEADLINE');

startUnifiedAssetSearchRefreshTimer();
router.use('/search', unifiedSearchRateLimit);

function parseAsset(value: unknown): 'all' | UnifiedAssetType | null {
  const normalized = String(value ?? 'all').toLowerCase();
  return normalized === 'all' || normalized === 'stock' || normalized === 'coin' ? normalized : null;
}

function parseMarket(value: unknown): UnifiedSearchMarket | null | 'invalid' {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (normalized === 'KR' || normalized === 'US' || normalized === 'spot' || normalized === 'futures') return normalized;
  return 'invalid';
}

function canUseSpotMetadataFallback(asset: 'all' | UnifiedAssetType, market: UnifiedSearchMarket | null) {
  return (asset === 'all' || asset === 'coin') && market === 'spot';
}

function canUseFuturesMetadataFallback(asset: 'all' | UnifiedAssetType, market: UnifiedSearchMarket | null) {
  return (asset === 'all' || asset === 'coin') && market === 'futures';
}

function canUseKrMetadataFallback(asset: 'all' | UnifiedAssetType, market: UnifiedSearchMarket | null) {
  return (asset === 'all' || asset === 'stock') && market === 'KR';
}

function canUseUsMetadataFallback(asset: 'all' | UnifiedAssetType, market: UnifiedSearchMarket | null) {
  return (asset === 'all' || asset === 'stock') && market === 'US';
}

function buildMetadataFallback(
  q: string,
  asset: 'all' | UnifiedAssetType,
  market: UnifiedSearchMarket | null,
  limit: number,
) {
  if (canUseKrMetadataFallback(asset, market)) return buildKrSearchFallback(q, limit);
  if (canUseUsMetadataFallback(asset, market)) return buildUsSearchFallback(q, limit);
  if (canUseSpotMetadataFallback(asset, market)) return buildSpotSearchFallback(q, limit);
  if (canUseFuturesMetadataFallback(asset, market)) return buildFuturesSearchFallback(q, limit);
  return null;
}

function metadataFallbackSoftDeadlineMs(
  asset: 'all' | UnifiedAssetType,
  market: UnifiedSearchMarket | null,
) {
  if (canUseKrMetadataFallback(asset, market)) return KR_SEARCH_SOFT_DEADLINE_MS;
  if (canUseUsMetadataFallback(asset, market)) return US_SEARCH_SOFT_DEADLINE_MS;
  if (canUseSpotMetadataFallback(asset, market)) return SPOT_SEARCH_SOFT_DEADLINE_MS;
  if (canUseFuturesMetadataFallback(asset, market)) return FUTURES_SEARCH_SOFT_DEADLINE_MS;
  return null;
}

async function raceSearchAgainstDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T | typeof SEARCH_DEADLINE> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const deadline = new Promise<typeof SEARCH_DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(SEARCH_DEADLINE), deadlineMs);
      timer.unref?.();
    });
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function searchDeadlineError() {
  const error = new Error('Unified search exceeded its terminal response budget.');
  error.name = 'SEARCH_TERMINAL_DEADLINE';
  return error;
}

async function searchWithMetadataSoftDeadline(input: {
  q: string;
  asset: 'all' | UnifiedAssetType;
  market: UnifiedSearchMarket | null;
  limit: number;
}) {
  const searchPromise = searchUnifiedAssets(input);
  const metadataFallback = buildMetadataFallback(input.q, input.asset, input.market, input.limit);
  const configuredSoftDeadlineMs = metadataFallbackSoftDeadlineMs(input.asset, input.market);
  const exactCodeFallback = metadataFallback?.results.some((result) => result.matchType === 'code_exact') === true;
  const firstDeadlineMs = exactCodeFallback
    ? EXACT_CODE_METADATA_DEADLINE_MS
    : configuredSoftDeadlineMs;

  if (firstDeadlineMs != null) {
    const response = await raceSearchAgainstDeadline(searchPromise, firstDeadlineMs);
    if (response !== SEARCH_DEADLINE) {
      if (response.count > 0) return response;
      return metadataFallback ?? response;
    }
    if (metadataFallback) return metadataFallback;
  }

  const elapsedBudgetMs = firstDeadlineMs ?? 0;
  const remainingBudgetMs = Math.max(1, SEARCH_HARD_DEADLINE_MS - elapsedBudgetMs);
  const terminalResponse = await raceSearchAgainstDeadline(searchPromise, remainingBudgetMs);
  if (terminalResponse !== SEARCH_DEADLINE) return terminalResponse;
  throw searchDeadlineError();
}

router.get('/search/suggest', async (req, res) => {
  const q = String(req.query.q ?? '').normalize('NFKC').trim();
  if (!q) {
    res.status(400).json({ ok: false, state: 'ERROR', error: 'SEARCH_QUERY_REQUIRED', results: [], count: 0 });
    return;
  }
  if (q.length > 100) {
    res.status(400).json({ ok: false, state: 'ERROR', error: 'SEARCH_QUERY_TOO_LONG', results: [], count: 0 });
    return;
  }
  const asset = parseAsset(req.query.asset);
  const market = parseMarket(req.query.market);
  if (!asset || market === 'invalid') {
    res.status(400).json({ ok: false, state: 'ERROR', error: 'SEARCH_FILTER_INVALID', results: [], count: 0 });
    return;
  }
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(req.query.limit ?? 25)) || 25));
  try {
    const response = await searchWithMetadataSoftDeadline({ q, asset, market, limit });
    const state = deriveUnifiedSearchState({
      resultCount: response.count,
      partial: response.partial,
      stale: response.stale,
    });
    res.setHeader('Cache-Control', 'private, max-age=15, stale-while-revalidate=60');
    res.json({ ok: true, state, q, asset, market, ...response });
  } catch (error) {
    console.error('[unified-search] suggest failed:', error instanceof Error ? error.message : 'unknown');
    const fallback = buildMetadataFallback(q, asset, market, limit);
    if (fallback) {
      const state = deriveUnifiedSearchState({ resultCount: fallback.count, partial: true, stale: true });
      res.setHeader('Cache-Control', 'private, max-age=15, stale-while-revalidate=60');
      res.json({ ok: true, state, q, asset, market, ...fallback });
      return;
    }
    const timedOut = error instanceof Error && error.name === 'SEARCH_TERMINAL_DEADLINE';
    res.status(503).json({
      ok: false,
      state: 'ERROR',
      error: timedOut ? 'SEARCH_PROVIDER_TIMEOUT' : 'SEARCH_INDEX_UNAVAILABLE',
      results: [],
      count: 0,
      message: timedOut
        ? '검색 제공기관 응답이 지연되어 제한 시간 안에 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.'
        : '검색 인덱스를 준비하지 못했습니다. 이전 정상 인덱스도 없습니다.',
    });
  }
});

router.get('/search/index/status', async (_req, res) => {
  try {
    res.json(await getUnifiedAssetSearchStatus());
  } catch {
    res.status(503).json({ ok: false, count: 0, stale: true, partial: true, providers: [], error: 'SEARCH_INDEX_UNAVAILABLE' });
  }
});

router.post('/search/index/refresh', requireAdmin, async (_req, res) => {
  try {
    const refreshed = await refreshUnifiedAssetSearchIndex();
    res.json({
      ok: refreshed.documents.length > 0,
      count: refreshed.documents.length,
      dataAsOf: refreshed.builtAt,
      providers: refreshed.providers,
    });
  } catch {
    res.status(502).json({ ok: false, error: 'SEARCH_INDEX_REFRESH_FAILED' });
  }
});

export default router;
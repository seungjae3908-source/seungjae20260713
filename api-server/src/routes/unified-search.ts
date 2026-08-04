import { Router, type IRouter } from 'express';
import { requireAdmin } from '../middleware/auth';
import { unifiedSearchRateLimit } from '../middleware/search-rate-limit';
import {
  getUnifiedAssetSearchStatus,
  refreshUnifiedAssetSearchIndex,
  searchUnifiedAssets,
  startUnifiedAssetSearchRefreshTimer,
} from '../services/unified-asset-search.service';
import type { UnifiedAssetType, UnifiedSearchMarket } from '../lib/search-normalization';

const router: IRouter = Router();

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

router.get('/search/suggest', async (req, res) => {
  const q = String(req.query.q ?? '').normalize('NFKC').trim();
  if (!q) {
    res.status(400).json({ ok: false, error: 'SEARCH_QUERY_REQUIRED', results: [], count: 0 });
    return;
  }
  if (q.length > 100) {
    res.status(400).json({ ok: false, error: 'SEARCH_QUERY_TOO_LONG', results: [], count: 0 });
    return;
  }
  const asset = parseAsset(req.query.asset);
  const market = parseMarket(req.query.market);
  if (!asset || market === 'invalid') {
    res.status(400).json({ ok: false, error: 'SEARCH_FILTER_INVALID', results: [], count: 0 });
    return;
  }
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(req.query.limit ?? 25)) || 25));
  try {
    const response = await searchUnifiedAssets({ q, asset, market, limit });
    res.setHeader('Cache-Control', 'private, max-age=15, stale-while-revalidate=60');
    res.json({ ok: true, q, asset, market, ...response });
  } catch (error) {
    console.error('[unified-search] suggest failed:', error instanceof Error ? error.message : 'unknown');
    res.status(503).json({
      ok: false,
      error: 'SEARCH_INDEX_UNAVAILABLE',
      results: [],
      count: 0,
      message: '검색 인덱스를 준비하지 못했습니다. 이전 정상 인덱스도 없습니다.',
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

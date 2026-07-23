import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { getSupabase, getUserSupabase, hasSupabaseServerKey } from '../lib/supabase';
import { WatchlistService, type WatchlistInput } from '../services/watchlist.service';

const router: IRouter = Router();

function db(req: AuthenticatedRequest) {
  return hasSupabaseServerKey() ? getSupabase() : getUserSupabase(req.accessToken!);
}

function parseItem(body: unknown): WatchlistInput | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.ticker !== 'string' || raw.ticker.trim() === '') return null;
  const targetPrice =
    typeof raw.targetPrice === 'number' && Number.isFinite(raw.targetPrice) && raw.targetPrice > 0
      ? raw.targetPrice
      : null;
  return {
    ticker: raw.ticker.trim(),
    name: typeof raw.name === 'string' ? raw.name : undefined,
    market: typeof raw.market === 'string' ? raw.market : null,
    currency: typeof raw.currency === 'string' ? raw.currency : null,
    targetPrice,
  };
}

router.get('/watchlist', async (req: AuthenticatedRequest, res) => {
  try {
    const items = await WatchlistService.list(db(req), req.member!.id);
    return res.json({ items });
  } catch (error) {
    console.error('[watchlist] list error:', error);
    return res.status(502).json({ error: 'WATCHLIST_STORE_ERROR' });
  }
});

router.post('/watchlist/sync', async (req: AuthenticatedRequest, res) => {
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!rawItems) return res.status(400).json({ error: 'INVALID_ITEMS' });
  const items = rawItems
    .map((item: unknown) => parseItem(item))
    .filter((item: WatchlistInput | null): item is WatchlistInput => item !== null);

  try {
    const saved = await WatchlistService.syncReplace(db(req), req.member!.id, items);
    return res.json({ items: saved });
  } catch (error) {
    console.error('[watchlist] sync error:', error);
    return res.status(502).json({ error: 'WATCHLIST_STORE_ERROR' });
  }
});

router.put('/watchlist/:ticker', async (req: AuthenticatedRequest, res) => {
  const item = parseItem({ ...req.body, ticker: String(req.params.ticker) });
  if (!item) return res.status(400).json({ error: 'INVALID_ITEM' });
  try {
    await WatchlistService.upsert(db(req), req.member!.id, item);
    return res.json({ ok: true });
  } catch (error) {
    console.error('[watchlist] upsert error:', error);
    return res.status(502).json({ error: 'WATCHLIST_STORE_ERROR' });
  }
});

router.delete('/watchlist/:ticker', async (req: AuthenticatedRequest, res) => {
  try {
    await WatchlistService.remove(db(req), req.member!.id, String(req.params.ticker));
    return res.json({ ok: true });
  } catch (error) {
    console.error('[watchlist] delete error:', error);
    return res.status(502).json({ error: 'WATCHLIST_STORE_ERROR' });
  }
});

export default router;

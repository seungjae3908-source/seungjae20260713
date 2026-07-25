// Watchlist + target-price API backed by Supabase.
// Honest 503 SUPABASE_NOT_CONFIGURED until a server (secret) key is present;
// the frontend keeps working from localStorage and syncs when this comes up.
import { Router, type IRouter } from 'express';
import { type AuthenticatedRequest } from '../middleware/auth';
import {
	WatchlistService,
	type WatchlistInput,
} from '../services/watchlist.service';

const router: IRouter = Router();

function guard(res: { status: (code: number) => { json: (body: unknown) => unknown } }): boolean {
	if (WatchlistService.isAvailable()) return true;
	res.status(503).json({ error: 'SUPABASE_NOT_CONFIGURED' });
	return false;
}

function parseItem(body: unknown): WatchlistInput | null {
	if (!body || typeof body !== 'object') return null;
	const raw = body as Record<string, unknown>;
	if (typeof raw.ticker !== 'string' || raw.ticker.trim() === '') return null;
	const targetPrice =
		typeof raw.targetPrice === 'number' && Number.isFinite(raw.targetPrice) && raw.targetPrice > 0
			? raw.targetPrice
			: null;
	const assetType = ['stockKR', 'stockUS', 'coinSpot', 'coinFutures'].includes(
		String(raw.assetType),
	)
		? String(raw.assetType)
		: String(raw.market).toUpperCase() === 'US'
			? 'stockUS'
			: 'stockKR';
	return {
		ticker: raw.ticker.trim(),
		name: typeof raw.name === 'string' ? raw.name : undefined,
		assetType,
		market: typeof raw.market === 'string' ? raw.market : null,
		currency: typeof raw.currency === 'string' ? raw.currency : null,
		targetPrice,
	};
}

// GET /api/watchlist
// 인증 미들웨어가 확인한 회원 ID만 저장 키로 사용한다.
router.get('/watchlist', async (req: AuthenticatedRequest, res) => {
	if (!guard(res)) return;
	try {
		const items = await WatchlistService.list(req.member!.id);
		return res.json({ items, ownerId: req.member!.id });
	} catch (error) {
		console.error('[watchlist] list error:', error);
		return res.status(502).json({ error: 'WATCHLIST_STORE_ERROR' });
	}
});

// POST /api/watchlist/sync  { items: WatchlistInput[] }
// 현재 회원의 목록을 교체하고 정규화된 목록을 반환한다.
router.post('/watchlist/sync', async (req: AuthenticatedRequest, res) => {
	if (!guard(res)) return;
	const body = (req.body ?? {}) as Record<string, unknown>;
	const rawItems = Array.isArray(body.items) ? body.items : null;
	if (!rawItems) return res.status(400).json({ error: 'INVALID_ITEMS' });

	const items = rawItems
		.map((item) => parseItem(item))
		.filter((item): item is WatchlistInput => item !== null);

	try {
		const saved = await WatchlistService.syncReplace(
			req.member!.id,
			items,
		);
		return res.json({ items: saved, ownerId: req.member!.id });
	} catch (error) {
		console.error('[watchlist] sync error:', error);
		return res.status(502).json({ error: 'WATCHLIST_STORE_ERROR' });
	}
});

// PUT /api/watchlist/:ticker  { name?, market?, currency?, targetPrice? }
router.put('/watchlist/:ticker', async (req: AuthenticatedRequest, res) => {
	if (!guard(res)) return;
	const body = (req.body ?? {}) as Record<string, unknown>;
	const item = parseItem({ ...body, ticker: req.params.ticker });
	if (!item) return res.status(400).json({ error: 'INVALID_ITEM' });

	try {
		await WatchlistService.upsert(req.member!.id, item);
		return res.json({ ok: true });
	} catch (error) {
		console.error('[watchlist] upsert error:', error);
		return res.status(502).json({ error: 'WATCHLIST_STORE_ERROR' });
	}
});

// DELETE /api/watchlist/:ticker
router.delete('/watchlist/:ticker', async (req: AuthenticatedRequest, res) => {
	if (!guard(res)) return;
	try {
		await WatchlistService.remove(
			req.member!.id,
			String(req.params.ticker ?? ''),
			typeof req.query.asset === 'string' ? req.query.asset : undefined,
		);
		return res.json({ ok: true });
	} catch (error) {
		console.error('[watchlist] delete error:', error);
		return res.status(502).json({ error: 'WATCHLIST_STORE_ERROR' });
	}
});

export default router;

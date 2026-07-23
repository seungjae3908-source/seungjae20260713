// Watchlist + target-price API backed by Supabase.
// Honest 503 SUPABASE_NOT_CONFIGURED until a server (secret) key is present;
// the frontend keeps working from localStorage and syncs when this comes up.
import { Router, type IRouter } from 'express';
import {
	WatchlistService,
	type WatchlistInput,
} from '../services/watchlist.service';

const router: IRouter = Router();

function deviceIdOf(value: unknown): string {
	const id = typeof value === 'string' ? value.trim() : '';
	return id.length > 0 && id.length <= 128 ? id : 'default';
}

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
	return {
		ticker: raw.ticker.trim(),
		name: typeof raw.name === 'string' ? raw.name : undefined,
		market: typeof raw.market === 'string' ? raw.market : null,
		currency: typeof raw.currency === 'string' ? raw.currency : null,
		targetPrice,
	};
}

// GET /api/watchlist?deviceId=...
router.get('/watchlist', async (req, res) => {
	if (!guard(res)) return;
	try {
		const items = await WatchlistService.list(deviceIdOf(req.query.deviceId));
		return res.json({ items });
	} catch (error) {
		console.error('[watchlist] list error:', error);
		return res.status(502).json({ error: 'WATCHLIST_STORE_ERROR' });
	}
});

// POST /api/watchlist/sync  { deviceId, items: WatchlistInput[] }
// Replaces the device's set and returns the canonical list.
router.post('/watchlist/sync', async (req, res) => {
	if (!guard(res)) return;
	const body = (req.body ?? {}) as Record<string, unknown>;
	const rawItems = Array.isArray(body.items) ? body.items : null;
	if (!rawItems) return res.status(400).json({ error: 'INVALID_ITEMS' });

	const items = rawItems
		.map((item) => parseItem(item))
		.filter((item): item is WatchlistInput => item !== null);

	try {
		const saved = await WatchlistService.syncReplace(
			deviceIdOf(body.deviceId),
			items,
		);
		return res.json({ items: saved });
	} catch (error) {
		console.error('[watchlist] sync error:', error);
		return res.status(502).json({ error: 'WATCHLIST_STORE_ERROR' });
	}
});

// PUT /api/watchlist/:ticker  { deviceId, name?, market?, currency?, targetPrice? }
router.put('/watchlist/:ticker', async (req, res) => {
	if (!guard(res)) return;
	const body = (req.body ?? {}) as Record<string, unknown>;
	const item = parseItem({ ...body, ticker: req.params.ticker });
	if (!item) return res.status(400).json({ error: 'INVALID_ITEM' });

	try {
		await WatchlistService.upsert(deviceIdOf(body.deviceId), item);
		return res.json({ ok: true });
	} catch (error) {
		console.error('[watchlist] upsert error:', error);
		return res.status(502).json({ error: 'WATCHLIST_STORE_ERROR' });
	}
});

// DELETE /api/watchlist/:ticker?deviceId=...
router.delete('/watchlist/:ticker', async (req, res) => {
	if (!guard(res)) return;
	try {
		await WatchlistService.remove(
			deviceIdOf(req.query.deviceId),
			req.params.ticker,
		);
		return res.json({ ok: true });
	} catch (error) {
		console.error('[watchlist] delete error:', error);
		return res.status(502).json({ error: 'WATCHLIST_STORE_ERROR' });
	}
});

export default router;

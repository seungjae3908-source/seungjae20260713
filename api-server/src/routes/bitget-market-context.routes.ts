import { Router, type IRouter } from 'express';
import { requireAdmin } from '../middleware/auth';
import {
  collectBitgetMarketContextOnce,
  getBitgetMarketContextStatus,
  getLatestBitgetMarketContext,
  readBitgetMarketContextHistory,
} from '../services/bitget-market-context.service';

const router: IRouter = Router();

function safeSymbol(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 30);
}

router.get('/status', async (_req, res) => {
  const latest = await getLatestBitgetMarketContext();
  return res.json({
    ok: true,
    exchange: 'BITGET',
    mode: 'PUBLIC_MARKET_DATA_ONLY',
    realOrdersEnabled: false,
    collector: getBitgetMarketContextStatus(),
    latest,
    updatedAt: new Date().toISOString(),
  });
});

router.get('/latest', async (req, res) => {
  const symbol = safeSymbol(req.query.symbol);
  const snapshots = await getLatestBitgetMarketContext(symbol || null);
  return res.json({
    ok: true,
    exchange: 'BITGET',
    mode: 'PUBLIC_MARKET_DATA_ONLY',
    realOrdersEnabled: false,
    symbol: symbol || null,
    snapshots,
    count: snapshots.length,
    updatedAt: new Date().toISOString(),
  });
});

router.get('/history', async (req, res) => {
  const symbol = safeSymbol(req.query.symbol);
  if (!symbol) {
    return res.status(400).json({
      ok: false,
      error: 'SYMBOL_REQUIRED',
      snapshots: [],
    });
  }
  const limit = Number(req.query.limit ?? 500);
  const snapshots = await readBitgetMarketContextHistory(symbol, {
    from: String(req.query.from ?? '').trim() || null,
    to: String(req.query.to ?? '').trim() || null,
    limit: Number.isFinite(limit) ? limit : 500,
  });
  return res.json({
    ok: true,
    exchange: 'BITGET',
    mode: 'PUBLIC_MARKET_DATA_ONLY',
    realOrdersEnabled: false,
    symbol,
    snapshots,
    count: snapshots.length,
    updatedAt: new Date().toISOString(),
  });
});

router.post('/collect', requireAdmin, async (req, res) => {
  const requested = Array.isArray(req.body?.symbols)
    ? req.body.symbols.map(safeSymbol).filter(Boolean)
    : [];
  const result = await collectBitgetMarketContextOnce(requested.length ? requested : undefined);
  return res.status(result.failures.length && !result.collected.length ? 502 : 200).json({
    ok: result.collected.length > 0 || result.failures.length === 0,
    exchange: 'BITGET',
    mode: 'PUBLIC_MARKET_DATA_ONLY',
    realOrdersEnabled: false,
    ...result,
    collector: getBitgetMarketContextStatus(),
    updatedAt: new Date().toISOString(),
  });
});

export default router;

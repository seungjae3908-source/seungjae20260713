import { Router } from 'express';
import { requireMember } from '../middleware/auth';
import { getKiwoomDomesticOrderbook } from '../providers/kiwoom';

const router = Router();
router.use(requireMember);

const CACHE_TTL_MS = 2_500;
const STALE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; payload: DepthResponse }>();

type DepthLevel = {
  askPrice: number | null;
  askSize: number | null;
  bidPrice: number | null;
  bidSize: number | null;
};

type DepthResponse = {
  ok: boolean;
  available: boolean;
  readOnly: true;
  asset: string;
  market: string;
  symbol: string;
  provider: string;
  levels: DepthLevel[];
  timestamp: string;
  stale?: boolean;
  reason?: string;
};

function finite(value: unknown): number | null {
  const normalized = Number(String(value ?? '').replace(/,/g, '').replace(/^\+/, ''));
  return Number.isFinite(normalized) ? Math.abs(normalized) : null;
}

function symbol(value: unknown) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, '').slice(0, 24);
}

async function json<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json', 'User-Agent': 'seungjae-investment-app/2.0' },
    });
    if (!response.ok) throw new Error(`DEPTH_HTTP_${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

async function coinSpot(sym: string): Promise<DepthResponse> {
  const rows = await json<any[]>(`https://api.upbit.com/v1/orderbook?markets=${encodeURIComponent(`KRW-${sym}`)}&level=0`);
  const item = rows?.[0];
  const units = Array.isArray(item?.orderbook_units) ? item.orderbook_units : [];
  return {
    ok: true, available: units.length > 0, readOnly: true, asset: 'coin', market: 'spot', symbol: sym,
    provider: 'UPBIT', timestamp: new Date(Number(item?.timestamp) || Date.now()).toISOString(),
    levels: units.slice(0, 15).map((unit: any) => ({
      askPrice: finite(unit.ask_price), askSize: finite(unit.ask_size),
      bidPrice: finite(unit.bid_price), bidSize: finite(unit.bid_size),
    })),
  };
}

async function coinFutures(sym: string): Promise<DepthResponse> {
  const normalized = sym.endsWith('USDT') ? sym : `${sym}USDT`;
  const payload = await json<any>(`https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${encodeURIComponent(normalized)}&productType=USDT-FUTURES&precision=scale0&limit=15`);
  if (String(payload?.code ?? '') !== '00000') throw new Error('BITGET_DEPTH_UNAVAILABLE');
  const asks = Array.isArray(payload?.data?.asks) ? payload.data.asks : [];
  const bids = Array.isArray(payload?.data?.bids) ? payload.data.bids : [];
  const length = Math.max(asks.length, bids.length);
  return {
    ok: true, available: length > 0, readOnly: true, asset: 'coin', market: 'futures', symbol: sym,
    provider: 'BITGET', timestamp: new Date(Number(payload?.requestTime) || Date.now()).toISOString(),
    levels: Array.from({ length: Math.min(length, 15) }, (_, index) => ({
      askPrice: finite(asks[index]?.[0]), askSize: finite(asks[index]?.[1]),
      bidPrice: finite(bids[index]?.[0]), bidSize: finite(bids[index]?.[1]),
    })),
  };
}

function pick(raw: Record<string, unknown>, prefixes: string[], level: number) {
  for (const prefix of prefixes) {
    const value = finite(raw[`${prefix}${level}`] ?? raw[`${prefix}_${level}`] ?? raw[`${prefix}${level}th`]);
    if (value != null) return value;
  }
  return null;
}

async function stockKr(sym: string): Promise<DepthResponse> {
  const raw = await getKiwoomDomesticOrderbook(sym) as Record<string, unknown>;
  const levels = Array.from({ length: 10 }, (_, index) => {
    const level = index + 1;
    return {
      askPrice: pick(raw, ['sel_pre', 'sel_pric', 'ask_pric'], level),
      askSize: pick(raw, ['sel_req', 'sel_qty', 'ask_qty'], level),
      bidPrice: pick(raw, ['buy_pre', 'buy_pric', 'bid_pric'], level),
      bidSize: pick(raw, ['buy_req', 'buy_qty', 'bid_qty'], level),
    };
  }).filter((row) => row.askPrice != null || row.bidPrice != null);
  return {
    ok: true, available: levels.length > 0, readOnly: true, asset: 'stock', market: 'KR', symbol: sym,
    provider: 'KIWOOM', timestamp: new Date().toISOString(), levels,
    ...(levels.length ? {} : { reason: 'ORDERBOOK_FIELDS_UNAVAILABLE' }),
  };
}

router.get('/market/depth', async (req, res) => {
  const asset = String(req.query.asset ?? 'stock').toLowerCase();
  const market = String(req.query.market ?? 'KR');
  const sym = symbol(req.query.symbol);
  if (!sym) return res.status(400).json({ error: 'INVALID_SYMBOL' });
  const key = `${asset}:${market}:${sym}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.json(hit.payload);

  try {
    let payload: DepthResponse;
    if (asset === 'coin' && market.toLowerCase() === 'spot') payload = await coinSpot(sym);
    else if (asset === 'coin' && market.toLowerCase() === 'futures') payload = await coinFutures(sym);
    else if (asset === 'stock' && market.toUpperCase() === 'KR') payload = await stockKr(sym);
    else payload = {
      ok: true, available: false, readOnly: true, asset, market, symbol: sym,
      provider: 'NONE', timestamp: new Date().toISOString(), levels: [],
      reason: 'LEVEL2_PROVIDER_NOT_AVAILABLE',
    };
    cache.set(key, { at: Date.now(), payload });
    return res.json(payload);
  } catch (error) {
    if (hit && Date.now() - hit.at < STALE_TTL_MS) {
      return res.json({ ...hit.payload, stale: true });
    }
    console.error('[market-depth] read-only lookup failed:', error instanceof Error ? error.message : String(error));
    return res.status(502).json({
      ok: false, available: false, readOnly: true, asset, market, symbol: sym,
      provider: 'UNAVAILABLE', timestamp: new Date().toISOString(), levels: [], reason: 'MARKET_DEPTH_UNAVAILABLE',
    });
  }
});

export default router;

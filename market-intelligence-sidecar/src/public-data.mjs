const BITGET_BASE = 'https://api.bitget.com';
const UPBIT_BASE = 'https://api.upbit.com';

function cleanSymbol(value) {
  return String(value ?? '').trim().toUpperCase();
}

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function fetchJson(url, { timeoutMs = 3_000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('PUBLIC_DATA_TIMEOUT')), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'investment-market-intelligence-sidecar/1.0',
        ...headers,
      },
    });
    if (!response.ok) throw new Error(`PUBLIC_HTTP_${response.status}:${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function assertBitget(payload, label) {
  if (!payload || payload.code !== '00000') {
    throw new Error(`BITGET_${label}_FAILED:${String(payload?.code ?? 'NO_CODE')}:${String(payload?.msg ?? 'NO_MSG')}`);
  }
  return payload.data;
}

export async function fetchBitgetFuturesEvidence(symbolInput) {
  const symbol = cleanSymbol(symbolInput);
  if (!/^[A-Z0-9]{4,30}$/u.test(symbol)) throw new Error('INVALID_BITGET_SYMBOL');
  const q = encodeURIComponent(symbol);
  const category = 'USDT-FUTURES';
  const [bookRaw, fillsRaw, oiRaw, fundingRaw, longShortRaw, liquidationsRaw] = await Promise.all([
    fetchJson(`${BITGET_BASE}/api/v3/market/orderbook?category=${category}&symbol=${q}&limit=50`),
    fetchJson(`${BITGET_BASE}/api/v3/market/fills?category=${category}&symbol=${q}&limit=100`),
    fetchJson(`${BITGET_BASE}/api/v3/market/open-interest?category=${category}&symbol=${q}`),
    fetchJson(`${BITGET_BASE}/api/v3/market/current-fund-rate?category=${category}&symbol=${q}`),
    fetchJson(`${BITGET_BASE}/api/v3/market/futures-long-short?symbol=${q}&period=5m`, { timeoutMs: 4_000 }),
    fetchJson(`${BITGET_BASE}/api/v3/market/liquidations?category=${category}&symbol=${q}&limit=100`, { timeoutMs: 4_000 }),
  ]);

  const book = assertBitget(bookRaw, 'ORDERBOOK');
  const fills = assertBitget(fillsRaw, 'FILLS');
  const oi = assertBitget(oiRaw, 'OI');
  const funding = assertBitget(fundingRaw, 'FUNDING');
  const longShort = assertBitget(longShortRaw, 'LONG_SHORT');
  const liquidations = assertBitget(liquidationsRaw, 'LIQUIDATIONS');

  const liquidationRows = Array.isArray(liquidations?.list) ? liquidations.list : [];
  let longLiquidationNotional = 0;
  let shortLiquidationNotional = 0;
  for (const row of liquidationRows) {
    const notional = Math.max(0, finite(row?.price, 0) * finite(row?.amount, 0));
    if (String(row?.side).toLowerCase() === 'buy') longLiquidationNotional += notional;
    if (String(row?.side).toLowerCase() === 'sell') shortLiquidationNotional += notional;
  }

  const oiRow = Array.isArray(oi?.list) ? oi.list.find((row) => cleanSymbol(row?.symbol) === symbol) ?? oi.list[0] : null;
  const fundingRow = Array.isArray(funding) ? funding.find((row) => cleanSymbol(row?.symbol) === symbol) ?? funding[0] : null;
  const longShortRow = Array.isArray(longShort) ? longShort[0] : null;

  return {
    market: 'CRYPTO_FUTURES',
    symbol,
    asOf: finite(book?.ts, Date.now()),
    orderBook: {
      ts: finite(book?.ts),
      bids: Array.isArray(book?.b) ? book.b : [],
      asks: Array.isArray(book?.a) ? book.a : [],
    },
    trades: (Array.isArray(fills) ? fills : []).map((row) => ({
      side: row.side,
      price: finite(row.price),
      size: finite(row.size),
      ts: finite(row.ts),
    })),
    derivatives: {
      openInterest: finite(oiRow?.openInterest),
      fundingRate: finite(fundingRow?.fundingRate),
      longShortRatio: finite(longShortRow?.longShortRatio, 1),
      longLiquidationNotional,
      shortLiquidationNotional,
    },
    provenance: {
      provider: 'BITGET_PUBLIC_UTA_V3',
      privateApiUsed: false,
      endpoints: [
        '/api/v3/market/orderbook',
        '/api/v3/market/fills',
        '/api/v3/market/open-interest',
        '/api/v3/market/current-fund-rate',
        '/api/v3/market/futures-long-short',
        '/api/v3/market/liquidations',
      ],
    },
  };
}

export async function fetchUpbitSpotEvidence(marketInput) {
  const symbol = cleanSymbol(marketInput);
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/u.test(symbol)) throw new Error('INVALID_UPBIT_MARKET');
  const q = encodeURIComponent(symbol);
  const [bookRaw, tradesRaw] = await Promise.all([
    fetchJson(`${UPBIT_BASE}/v1/orderbook?markets=${q}&count=30`),
    fetchJson(`${UPBIT_BASE}/v1/trades/ticks?market=${q}&count=100`),
  ]);
  const book = Array.isArray(bookRaw) ? bookRaw[0] : null;
  if (!book || !Array.isArray(book.orderbook_units)) throw new Error('UPBIT_ORDERBOOK_INVALID');
  if (!Array.isArray(tradesRaw)) throw new Error('UPBIT_TRADES_INVALID');

  return {
    market: 'CRYPTO_SPOT',
    symbol,
    asOf: finite(book.timestamp, Date.now()),
    orderBook: {
      ts: finite(book.timestamp),
      bids: book.orderbook_units.map((row) => [finite(row.bid_price), finite(row.bid_size)]),
      asks: book.orderbook_units.map((row) => [finite(row.ask_price), finite(row.ask_size)]),
    },
    trades: tradesRaw.map((row) => ({
      ask_bid: row.ask_bid,
      trade_price: finite(row.trade_price),
      trade_volume: finite(row.trade_volume),
      timestamp: finite(row.timestamp),
    })),
    provenance: {
      provider: 'UPBIT_PUBLIC',
      privateApiUsed: false,
      endpoints: ['/v1/orderbook', '/v1/trades/ticks'],
    },
  };
}

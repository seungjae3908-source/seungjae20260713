const BITGET_BASE = 'https://api.bitget.com';
const UPBIT_BASE = 'https://api.upbit.com';

function cleanSymbol(value) {
  return String(value ?? '').trim().toUpperCase();
}

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function fetchJsonFrame(url, {
  timeoutMs = 3_000,
  headers = {},
  fetchImpl = fetch,
  clock = Date.now,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('PUBLIC_DATA_TIMEOUT')), timeoutMs);
  const requestStartedAtMs = clock();
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'investment-market-intelligence-sidecar/1.0',
        ...headers,
      },
    });
    if (!response.ok) throw new Error(`PUBLIC_HTTP_${response.status}:${url}`);
    const payload = await response.json();
    return {
      payload,
      requestStartedAtMs,
      receiveTimestampMs: clock(),
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}) {
  return (await fetchJsonFrame(url, options)).payload;
}

function assertBitget(payload, label) {
  if (!payload || payload.code !== '00000') {
    throw new Error(`BITGET_${label}_FAILED:${String(payload?.code ?? 'NO_CODE')}:${String(payload?.msg ?? 'NO_MSG')}`);
  }
  return payload.data;
}

function positive(value, code) {
  const parsed = finite(value);
  if (!(parsed > 0)) throw new Error(code);
  return parsed;
}

function timestamp(value, code) {
  const parsed = positive(value, code);
  return Math.trunc(parsed);
}

function normalizeBookLevels(rows, side) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`BITGET_PUBLIC_BOOK_${side}_MISSING`);
  const levels = rows.map((row) => {
    if (!Array.isArray(row) || row.length < 2) throw new Error(`BITGET_PUBLIC_BOOK_${side}_ROW_INVALID`);
    return Object.freeze({
      price: positive(row[0], `BITGET_PUBLIC_BOOK_${side}_PRICE_INVALID`),
      quantity: positive(row[1], `BITGET_PUBLIC_BOOK_${side}_QUANTITY_INVALID`),
    });
  });
  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1].price;
    const current = levels[index].price;
    if ((side === 'ASKS' && current < previous) || (side === 'BIDS' && current > previous)) {
      throw new Error(`BITGET_PUBLIC_BOOK_${side}_ORDER_INVALID`);
    }
  }
  return Object.freeze(levels);
}

export function normalizeBitgetPublicOrderBookFrame({
  symbol,
  payload,
  requestStartedAtMs,
  receiveTimestampMs,
  endpoint = '/api/v3/market/orderbook',
  query = '',
  maxFrameAgeMs = 10_000,
  maxFutureSkewMs = 5_000,
}) {
  const normalizedSymbol = cleanSymbol(symbol);
  const data = assertBitget(payload, 'PUBLIC_ORDERBOOK');
  const marketTimestampMs = timestamp(data?.ts, 'BITGET_PUBLIC_BOOK_TIMESTAMP_MISSING');
  const receivedAt = timestamp(receiveTimestampMs, 'BITGET_PUBLIC_BOOK_RECEIVE_TIMESTAMP_MISSING');
  const requestedAt = timestamp(requestStartedAtMs, 'BITGET_PUBLIC_BOOK_REQUEST_TIMESTAMP_MISSING');
  if (requestedAt > receivedAt) throw new Error('BITGET_PUBLIC_BOOK_LOCAL_TIMESTAMP_ORDER_INVALID');
  if (marketTimestampMs > receivedAt + maxFutureSkewMs) throw new Error('BITGET_PUBLIC_BOOK_FUTURE_TIMESTAMP');
  if (receivedAt - marketTimestampMs > maxFrameAgeMs) throw new Error('BITGET_PUBLIC_BOOK_STALE');
  const bids = normalizeBookLevels(data?.b, 'BIDS');
  const asks = normalizeBookLevels(data?.a, 'ASKS');
  if (bids[0].price >= asks[0].price) throw new Error('BITGET_PUBLIC_BOOK_CROSSED');
  return Object.freeze({
    provider: 'BITGET_PUBLIC_UTA_V3',
    market: 'CRYPTO_FUTURES',
    symbol: normalizedSymbol,
    endpoint,
    query,
    requestStartedAtMs: requestedAt,
    receiveTimestampMs: receivedAt,
    marketTimestampMs,
    bids,
    asks,
    rawPayload: payload,
    privateApiUsed: false,
  });
}

export function normalizeBitgetPublicTradesFrame({
  symbol,
  payload,
  requestStartedAtMs,
  receiveTimestampMs,
  endpoint = '/api/v3/market/fills',
  query = '',
  maxFutureSkewMs = 5_000,
}) {
  const normalizedSymbol = cleanSymbol(symbol);
  const data = assertBitget(payload, 'PUBLIC_FILLS');
  if (!Array.isArray(data) || data.length === 0) throw new Error('BITGET_PUBLIC_FILLS_MISSING');
  const receivedAt = timestamp(receiveTimestampMs, 'BITGET_PUBLIC_FILL_RECEIVE_TIMESTAMP_MISSING');
  const requestedAt = timestamp(requestStartedAtMs, 'BITGET_PUBLIC_FILL_REQUEST_TIMESTAMP_MISSING');
  if (requestedAt > receivedAt) throw new Error('BITGET_PUBLIC_FILL_LOCAL_TIMESTAMP_ORDER_INVALID');
  const trades = data.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('BITGET_PUBLIC_FILL_ROW_INVALID');
    const side = String(row.side ?? '').trim().toLowerCase();
    if (!['buy', 'sell'].includes(side)) throw new Error('BITGET_PUBLIC_FILL_SIDE_INVALID');
    const eventTimestampMs = timestamp(row.ts, 'BITGET_PUBLIC_FILL_TIMESTAMP_MISSING');
    if (eventTimestampMs > receivedAt + maxFutureSkewMs) throw new Error('BITGET_PUBLIC_FILL_FUTURE_TIMESTAMP');
    const execId = String(row.execId ?? '').trim();
    if (!execId) throw new Error('BITGET_PUBLIC_FILL_ID_MISSING');
    return Object.freeze({
      execId,
      execLinkId: String(row.execLinkId ?? '').trim() || null,
      price: positive(row.price, 'BITGET_PUBLIC_FILL_PRICE_INVALID'),
      quantity: positive(row.size, 'BITGET_PUBLIC_FILL_QUANTITY_INVALID'),
      providerTradeSide: side,
      eventTimestampMs,
      isRpi: String(row.isRPI ?? '').trim().toUpperCase() || null,
      raw: row,
    });
  });
  return Object.freeze({
    provider: 'BITGET_PUBLIC_UTA_V3',
    market: 'CRYPTO_FUTURES',
    symbol: normalizedSymbol,
    endpoint,
    query,
    requestStartedAtMs: requestedAt,
    receiveTimestampMs: receivedAt,
    trades: Object.freeze(trades),
    rawPayload: payload,
    privateApiUsed: false,
  });
}

export async function fetchBitgetPublicOrderBookFrame(symbolInput, options = {}) {
  const symbol = cleanSymbol(symbolInput);
  if (!/^[A-Z0-9]{4,30}$/u.test(symbol)) throw new Error('INVALID_BITGET_SYMBOL');
  const endpoint = '/api/v3/market/orderbook';
  const query = new URLSearchParams({ category: 'USDT-FUTURES', symbol, limit: String(options.limit ?? 50) }).toString();
  const frame = await fetchJsonFrame(`${BITGET_BASE}${endpoint}?${query}`, options);
  return normalizeBitgetPublicOrderBookFrame({ ...frame, symbol, endpoint, query, maxFrameAgeMs: options.maxFrameAgeMs });
}

export async function fetchBitgetPublicTradesFrame(symbolInput, options = {}) {
  const symbol = cleanSymbol(symbolInput);
  if (!/^[A-Z0-9]{4,30}$/u.test(symbol)) throw new Error('INVALID_BITGET_SYMBOL');
  const endpoint = '/api/v3/market/fills';
  const query = new URLSearchParams({ category: 'USDT-FUTURES', symbol, limit: String(options.limit ?? 100) }).toString();
  const frame = await fetchJsonFrame(`${BITGET_BASE}${endpoint}?${query}`, options);
  return normalizeBitgetPublicTradesFrame({ ...frame, symbol, endpoint, query });
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

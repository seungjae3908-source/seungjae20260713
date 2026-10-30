// Bitget Public Data Adapter (category 파라미터 필수)
const BITGET_BASE = 'https://api.bitget.com';

async function fetchJsonFrame(url, { timeoutMs = 3000, clock = Date.now } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('PUBLIC_DATA_TIMEOUT')), timeoutMs);
  const requestStartedAtMs = clock();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'smart-grid-engine/1.0' },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PUBLIC_HTTP_${response.status}:${url} - ${text}`);
    }
    const payload = await response.json();
    return { payload, requestStartedAtMs, receiveTimestampMs: clock() };
  } finally {
    clearTimeout(timer);
  }
}

function positive(value, code) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(code);
  return n;
}

function normalizeBookLevels(rows, side) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`BITGET_PUBLIC_BOOK_${side}_MISSING`);
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length < 2) throw new Error(`BITGET_PUBLIC_BOOK_${side}_ROW_INVALID`);
    return {
      price: positive(row[0], `BITGET_PUBLIC_BOOK_${side}_PRICE_INVALID`),
      quantity: positive(row[1], `BITGET_PUBLIC_BOOK_${side}_QUANTITY_INVALID`),
    };
  });
}

export async function fetchLiveOrderBook(symbol, category = 'USDT-FUTURES') {
  const url = `${BITGET_BASE}/api/v3/market/orderbook?category=${category}&symbol=${symbol}&limit=15`;
  const frame = await fetchJsonFrame(url);
  const payload = frame.payload;
  if (!payload || payload.code !== '00000' || !payload.data) {
    throw new Error(`BITGET_PUBLIC_ORDERBOOK_FAILED:${payload?.code ?? 'NO_CODE'}`);
  }
  const data = payload.data;
  const bids = normalizeBookLevels(data.b, 'BIDS');
  const asks = normalizeBookLevels(data.a, 'ASKS');
  if (bids[0].price >= asks[0].price) throw new Error('BITGET_PUBLIC_BOOK_CROSSED');
  return { symbol, bids, asks, marketTimestampMs: Number(data.ts) };
}

export function getCurrentPrice(orderBook) {
  return (orderBook.bids[0].price + orderBook.asks[0].price) / 2;
}

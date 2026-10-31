// Bitget Public Data Adapter v2.1 - V3 /api/v3/market/instruments 적용
const BITGET_BASE = 'https://api.bitget.com';

async function fetchJson(url, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) { const t = await res.text(); throw new Error(`HTTP_${res.status}:${url}:${t.slice(0,200)}`); }
    return await res.json();
  } finally { clearTimeout(timer); }
}

// [FIX] V2 /contracts → V3 /instruments (필드명 매핑 포함)
export async function fetchContractInfo(symbol, category = 'USDT-FUTURES') {
  const url = `${BITGET_BASE}/api/v3/market/instruments?category=${category}&symbol=${symbol}`;
  const json = await fetchJson(url);
  if (json.code !== '00000' || !json.data?.[0]) throw new Error(`CONTRACT_INFO_FAILED:${json.code}:${json.msg}`);
  const c = json.data[0];
  // V3 필드 → 내부 표준 필드 매핑
  return {
    symbol: c.symbol,
    minTradeNum: Number(c.minOrderQty),           // V3: minOrderQty
    minTradeUSDT: Number(c.minOrderAmount),        // V3: minOrderAmount
    pricePlace: Number(c.pricePrecision),          // V3: pricePrecision
    volumePlace: Number(c.quantityPrecision),      // V3: quantityPrecision
    priceEndStep: Number(c.priceMultiplier),       // V3: priceMultiplier
    maxLever: Number(c.maxLeverage || '125'),      // V3: maxLeverage
    fundInterval: Number(c.fundInterval || '8'),
    status: c.status,                              // V3: 'online' | 'listed' | 'offline'
  };
}

export async function fetchLiveOrderBook(symbol, category = 'USDT-FUTURES') {
  const url = `${BITGET_BASE}/api/v3/market/orderbook?category=${category}&symbol=${symbol}&limit=15`;
  const json = await fetchJson(url);
  if (json.code !== '00000' || !json.data) throw new Error(`ORDERBOOK_FAILED:${json.code}`);
  const d = json.data;
  const bids = d.b.map(r => ({ price: Number(r[0]), quantity: Number(r[1]) }));
  const asks = d.a.map(r => ({ price: Number(r[0]), quantity: Number(r[1]) }));
  if (bids[0].price >= asks[0].price) throw new Error('CROSSED_BOOK');
  return { symbol, bids, asks, ts: Number(d.ts) };
}

export function getCurrentPrice(ob) { return (ob.bids[0].price + ob.asks[0].price) / 2; }

export async function fetchCandles(symbol, interval = '1H', startTime, endTime, limit = 1000, category = 'USDT-FUTURES') {
  let url = `${BITGET_BASE}/api/v3/market/candles?category=${category}&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  if (startTime) url += `&startTime=${startTime}`;
  if (endTime) url += `&endTime=${endTime}`;
  const json = await fetchJson(url);
  if (json.code !== '00000' || !Array.isArray(json.data)) throw new Error(`CANDLES_FAILED:${json.code}:${json.msg}`);
  return json.data.map(row => ({
    ts: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
    low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
  })).sort((a, b) => a.ts - b.ts);
}

export async function fetchFundingRateHistory(symbol, category = "USDT-FUTURES") {
  const url = `${BITGET_BASE}/api/v3/market/history-fund-rate?category=${category}&symbol=${symbol}&pageSize=100`;
  const json = await fetchJson(url);
  if (json.code !== "00000") throw new Error(`FUNDING_FAILED:${json.code}:${json.msg}`);
  const list = json.data?.resultList;
  if (!Array.isArray(list)) throw new Error("FUNDING_NO_RESULTLIST:" + JSON.stringify(json.data).slice(0,100));
  return list.map(r => ({
    symbol: r.symbol,
    fundingRate: Number(r.fundingRate),
    fundingTime: Number(r.fundingRateTimestamp),
  })).sort((a, b) => a.fundingTime - b.fundingTime);
}

export async function fetchKrwUsdtRate() {
  const res = await fetch('https://api.upbit.com/v1/ticker?markets=KRW-USDT', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`FX_RATE_FAILED:${res.status}`);
  const data = await res.json();
  if (!data[0]?.trade_price) throw new Error('FX_RATE_INVALID');
  return { rate: Number(data[0].trade_price), source: 'upbit-public', ts: Number(data[0].timestamp) };
}

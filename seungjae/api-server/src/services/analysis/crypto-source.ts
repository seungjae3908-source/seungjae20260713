// 3차 작업 코인 데이터 소스 헬퍼.
// routes/crypto.ts 의 upbit/bitget fetch 패턴을 서비스에서 직접 재사용한다.
// 주문 전송/자동매매 코드는 절대 호출하지 않는다 (조회 전용).

import type { Bar } from './candle-math';

const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'seungjae-investment-app/1.0',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export interface UpbitTicker {
  symbol: string;
  price: number | null;
  changePercent: number | null;
  volume24h: number | null;
  tradingValue24h: number | null;
}

export async function fetchUpbitTopTickers(limit = 40): Promise<UpbitTicker[]> {
  const master = await fetchJson<any[]>(`${UPBIT_BASE}/v1/market/all?isDetails=false`);
  const markets = master
    .filter((item) => String(item.market ?? '').startsWith('KRW-'))
    .map((item) => String(item.market));
  const chunks: string[][] = [];
  for (let i = 0; i < markets.length; i += 100) chunks.push(markets.slice(i, i + 100));
  const payloads = await Promise.all(
    chunks.map((chunk) =>
      fetchJson<any[]>(`${UPBIT_BASE}/v1/ticker?markets=${encodeURIComponent(chunk.join(','))}`),
    ),
  );
  const tickers = payloads.flat().map((item) => ({
    symbol: String(item.market).replace(/^KRW-/, ''),
    price: finite(item.trade_price),
    changePercent:
      finite(item.signed_change_rate) == null ? null : Number(item.signed_change_rate) * 100,
    volume24h: finite(item.acc_trade_volume_24h),
    tradingValue24h: finite(item.acc_trade_price_24h),
  }));
  return tickers
    .filter((t) => t.tradingValue24h != null && t.price != null)
    .sort((a, b) => (b.tradingValue24h ?? 0) - (a.tradingValue24h ?? 0))
    .slice(0, limit);
}

export async function fetchAllUpbitTickers(): Promise<UpbitTicker[]> {
  return fetchUpbitTopTickers(500);
}

export async function fetchUpbitCandles(symbol: string, count = 200, tf = '1D'): Promise<Bar[]> {
  const tfPath = tf === '1D' ? 'days' : tf === '1W' ? 'weeks' : tf === '1M' ? 'months' : null;
  const url = tfPath
    ? `${UPBIT_BASE}/v1/candles/${tfPath}?market=${encodeURIComponent(`KRW-${symbol}`)}&count=${count}`
    : `${UPBIT_BASE}/v1/candles/minutes/${encodeURIComponent(String(tf).replace(/[^0-9]/g, '') || '15')}?market=${encodeURIComponent(`KRW-${symbol}`)}&count=${count}`;
  const rows = await fetchJson<any[]>(url);
  return rows
    .slice()
    .reverse()
    .map((row) => ({
      time: String(row.candle_date_time_kst),
      open: Number(row.opening_price),
      high: Number(row.high_price),
      low: Number(row.low_price),
      close: Number(row.trade_price),
      volume: Number(row.candle_acc_trade_volume ?? 0),
    }))
    .filter((b) => Number.isFinite(b.open) && Number.isFinite(b.close));
}

export interface BitgetTicker {
  symbol: string;
  price: number | null;
  changePercent: number | null;
  volume24h: number | null;
  tradingValue24h: number | null;
  fundingRatePercent: number | null;
  openInterest: number | null;
}

export async function fetchBitgetTickers(): Promise<BitgetTicker[]> {
  const payload = await fetchJson<any>(
    `${BITGET_BASE}/api/v2/mix/market/tickers?productType=${BITGET_PRODUCT_TYPE}`,
  );
  if (String(payload?.code ?? '') !== '00000' || !Array.isArray(payload?.data)) {
    throw new Error(`BITGET_${String(payload?.code ?? 'INVALID')}`);
  }
  return payload.data.map((item: any) => {
    const changeRate = finite(item.change24h);
    const funding = finite(item.fundingRate);
    return {
      symbol: String(item.symbol ?? ''),
      price: finite(item.lastPr),
      changePercent: changeRate == null ? null : changeRate * 100,
      volume24h: finite(item.baseVolume),
      tradingValue24h: finite(item.usdtVolume),
      fundingRatePercent: funding == null ? null : funding * 100,
      openInterest: finite(item.holdingAmount),
    };
  });
}

export async function fetchBitgetTopTickers(limit = 40): Promise<BitgetTicker[]> {
  const tickers = await fetchBitgetTickers();
  return tickers
    .filter((t) => t.price != null && t.tradingValue24h != null && t.symbol.endsWith('USDT'))
    .sort((a, b) => (b.tradingValue24h ?? 0) - (a.tradingValue24h ?? 0))
    .slice(0, limit);
}

export async function fetchBitgetCandles(symbol: string, limit = 200, granularity = '1D'): Promise<Bar[]> {
  const payload = await fetchJson<any>(
    `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=${BITGET_PRODUCT_TYPE}&granularity=${encodeURIComponent(granularity)}&limit=${limit}`,
  );
  if (String(payload?.code ?? '') !== '00000' || !Array.isArray(payload?.data)) {
    throw new Error(`BITGET_${String(payload?.code ?? 'INVALID')}`);
  }
  return payload.data
    .slice()
    .map((row: any[]) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5] ?? 0),
    }))
    .filter((b: Bar) => Number.isFinite(b.open) && Number.isFinite(b.close))
    .sort((a: Bar, b: Bar) => Number(a.time) - Number(b.time));
}

export async function fetchPublicJson<T>(url: string): Promise<T> {
  return fetchJson<T>(url);
}

const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const PUBLIC_REQUEST_TIMEOUT_MS = 3_500;
const SERVER_CACHE_MS = 30_000;
const MAX_FEED_ITEMS = 120;
const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60_000;
const EXPIRES_AFTER_MS = 60 * 60_000;

export type CoinSpecialFeedMarket = 'spot' | 'futures';
export type CoinSpecialFeedTone = 'positive' | 'negative' | 'neutral';

export type CoinSpecialFeedRow = {
  symbol: string;
  name: string;
  price: number | null;
  changePercent: number | null;
  tradingValue24h: number | null;
  timestamp: number | null;
};

export type CoinSpecialFeedItem = {
  id: string;
  asset: 'coin';
  kind: 'signal';
  tone: CoinSpecialFeedTone;
  ticker: string;
  name: string;
  market: CoinSpecialFeedMarket;
  currency: 'KRW' | 'USDT';
  title: string;
  summary: string;
  source: 'Upbit public ticker' | 'Bitget public ticker';
  url: null;
  timeframe: '24h';
  price: number | null;
  changePercent: number | null;
  sourceAt: string | null;
  detectedAt: string;
  archiveAt: string;
  expiresAt: string;
};

export type CoinSpecialFeedResponse = {
  ok: true;
  asset: 'coin';
  market: CoinSpecialFeedMarket;
  items: CoinSpecialFeedItem[];
  count: number;
  catalogSize: number;
  scannedNow: number;
  updatedAt: string;
  refreshSeconds: 30;
  note: string;
};

type CacheState = {
  expiresAt: number;
  rows: CoinSpecialFeedRow[] | null;
  inFlight: Promise<CoinSpecialFeedRow[]> | null;
};

const cache: Record<CoinSpecialFeedMarket, CacheState> = {
  spot: { expiresAt: 0, rows: null, inFlight: null },
  futures: { expiresAt: 0, rows: null, inFlight: null },
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceIso(timestamp: number | null): string | null {
  if (timestamp == null || timestamp <= 0) return null;
  const millis = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function signedPercent(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatTradingValue(value: number | null, currency: 'KRW' | 'USDT'): string {
  if (value == null || value < 0) return '거래대금 미제공';
  return `${value.toLocaleString('ko-KR', { maximumFractionDigits: 0 })} ${currency}`;
}

function toneFor(changePercent: number): CoinSpecialFeedTone {
  if (changePercent > 0) return 'positive';
  if (changePercent < 0) return 'negative';
  return 'neutral';
}

export function buildCoinSpecialFeedItems(
  market: CoinSpecialFeedMarket,
  rows: CoinSpecialFeedRow[],
  limit: number,
  nowMs = Date.now(),
): CoinSpecialFeedItem[] {
  const safeLimit = Math.max(1, Math.min(MAX_FEED_ITEMS, Math.trunc(limit) || 1));
  const currency = market === 'spot' ? 'KRW' as const : 'USDT' as const;
  const source = market === 'spot' ? 'Upbit public ticker' as const : 'Bitget public ticker' as const;
  const detectedAt = new Date(nowMs).toISOString();
  const archiveAt = new Date(nowMs + ARCHIVE_AFTER_MS).toISOString();
  const expiresAt = new Date(nowMs + EXPIRES_AFTER_MS).toISOString();

  return rows
    .filter((row) => Boolean(row.symbol) && row.changePercent != null && Number.isFinite(row.changePercent))
    .sort((left, right) => {
      const byMove = Math.abs(right.changePercent ?? 0) - Math.abs(left.changePercent ?? 0);
      if (byMove !== 0) return byMove;
      return (right.tradingValue24h ?? -1) - (left.tradingValue24h ?? -1);
    })
    .slice(0, safeLimit)
    .map((row, index) => {
      const changePercent = row.changePercent ?? 0;
      const rank = index + 1;
      return {
        id: `coin:${market}:${row.symbol}:24h-move:${rank}`,
        asset: 'coin',
        kind: 'signal',
        tone: toneFor(changePercent),
        ticker: row.symbol,
        name: row.name || row.symbol,
        market,
        currency,
        title: `24시간 변동 상위 ${rank}위 · ${signedPercent(changePercent)}`,
        summary: `${source} 기준 24시간 등락률 ${signedPercent(changePercent)}, ${formatTradingValue(row.tradingValue24h, currency)}. 절대 등락률 순위이며 투자 추천이나 AI 판단이 아닙니다.`,
        source,
        url: null,
        timeframe: '24h',
        price: row.price,
        changePercent,
        sourceAt: sourceIso(row.timestamp),
        detectedAt,
        archiveAt,
        expiresAt,
      };
    });
}

async function fetchPublicJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUBLIC_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'seungjae-investment-app/1.0',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`PUBLIC_HTTP_${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUpbitRows(): Promise<CoinSpecialFeedRow[]> {
  const master = await fetchPublicJson<any[]>(`${UPBIT_BASE}/v1/market/all?isDetails=true`);
  if (!Array.isArray(master)) throw new Error('UPBIT_MARKET_MASTER_INVALID');

  const krwMarkets = master.filter((row) => String(row?.market ?? '').startsWith('KRW-'));
  if (!krwMarkets.length) throw new Error('UPBIT_KRW_MARKETS_EMPTY');

  const nameByMarket = new Map<string, string>();
  for (const row of krwMarkets) {
    const market = String(row.market);
    nameByMarket.set(market, String(row.korean_name ?? row.english_name ?? market));
  }

  const marketNames = krwMarkets.map((row) => String(row.market));
  const chunks: string[][] = [];
  for (let index = 0; index < marketNames.length; index += 100) {
    chunks.push(marketNames.slice(index, index + 100));
  }

  const payloads = await Promise.all(
    chunks.map((chunk) => fetchPublicJson<any[]>(
      `${UPBIT_BASE}/v1/ticker?markets=${encodeURIComponent(chunk.join(','))}`,
    )),
  );

  return payloads.flat().map((row) => {
    const market = String(row?.market ?? '');
    const rate = finite(row?.signed_change_rate);
    return {
      symbol: market.replace(/^KRW-/, ''),
      name: nameByMarket.get(market) ?? market.replace(/^KRW-/, ''),
      price: finite(row?.trade_price),
      changePercent: rate == null ? null : rate * 100,
      tradingValue24h: finite(row?.acc_trade_price_24h),
      timestamp: finite(row?.timestamp),
    };
  });
}

async function fetchBitgetRows(): Promise<CoinSpecialFeedRow[]> {
  const payload = await fetchPublicJson<any>(
    `${BITGET_BASE}/api/v2/mix/market/tickers?productType=${BITGET_PRODUCT_TYPE}`,
  );
  if (String(payload?.code ?? '') !== '00000' || !Array.isArray(payload?.data)) {
    throw new Error(`BITGET_TICKERS_${String(payload?.code ?? 'INVALID')}`);
  }

  return payload.data.map((row: any) => {
    const rate = finite(row?.change24h);
    const symbol = String(row?.symbol ?? '').trim().toUpperCase();
    return {
      symbol,
      name: symbol,
      price: finite(row?.lastPr),
      changePercent: rate == null ? null : rate * 100,
      tradingValue24h: finite(row?.usdtVolume),
      timestamp: finite(row?.ts),
    };
  });
}

async function loadRows(market: CoinSpecialFeedMarket): Promise<CoinSpecialFeedRow[]> {
  const state = cache[market];
  const now = Date.now();
  if (state.rows && state.expiresAt > now) return state.rows;
  if (state.inFlight) return state.inFlight;

  const loader = market === 'spot' ? fetchUpbitRows : fetchBitgetRows;
  state.inFlight = loader()
    .then((rows) => {
      state.rows = rows;
      state.expiresAt = Date.now() + SERVER_CACHE_MS;
      return rows;
    })
    .finally(() => {
      state.inFlight = null;
    });

  return state.inFlight;
}

export class CoinSpecialFeedService {
  static async getFeed(
    market: CoinSpecialFeedMarket,
    requestedLimit = MAX_FEED_ITEMS,
  ): Promise<CoinSpecialFeedResponse> {
    const rows = await loadRows(market);
    const safeLimit = Math.max(1, Math.min(MAX_FEED_ITEMS, Math.trunc(requestedLimit) || MAX_FEED_ITEMS));
    const now = Date.now();
    const items = buildCoinSpecialFeedItems(market, rows, safeLimit, now);
    return {
      ok: true,
      asset: 'coin',
      market,
      items,
      count: items.length,
      catalogSize: rows.length,
      scannedNow: rows.length,
      updatedAt: new Date(now).toISOString(),
      refreshSeconds: 30,
      note: 'Upbit/Bitget 공개 ticker의 24시간 절대 등락률 순위입니다. 뉴스·AI 판단·매매 추천을 생성하지 않습니다.',
    };
  }
}

import type { FxQuote } from '../modules/portfolio/intelligence-v2.ts';
import { marketNumber, quoteTimeEvidence } from '../providers/market-evidence';

type FetchLike = typeof fetch;

function finitePositive(value: unknown): number | null {
  const number = marketNumber(value);
  return number !== null && number > 0 ? number : null;
}

async function fetchJsonWithTimeout(fetchImpl: FetchLike, url: string, timeoutMs = 4_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'seungjae-portfolio-intelligence/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`FX_HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadUsdKrw(fetchImpl: FetchLike, now: Date): Promise<FxQuote> {
  const payload = await fetchJsonWithTimeout(
    fetchImpl,
    'https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1m&range=1d',
  ) as { chart?: { result?: Array<{ meta?: { symbol?: string; currency?: string; regularMarketPrice?: number; regularMarketTime?: number } }> } };
  const meta = payload.chart?.result?.[0]?.meta;
  const rate = finitePositive(meta?.regularMarketPrice);
  const time = quoteTimeEvidence(meta?.regularMarketTime, 'unix-seconds', now.getTime());
  if (payload.chart?.result?.length !== 1 || meta?.symbol !== 'KRW=X' || meta.currency !== 'KRW' || rate == null || !time.updatedAt) throw new Error('USD_KRW_FX_UNAVAILABLE');
  return {
    currency: 'USD',
    krwRate: rate,
    source: 'yahoo-public:KRW=X',
    asOf: time.updatedAt,
    quality: time.freshness.status === 'STALE' ? 'STALE' : 'DELAYED',
  };
}

async function loadUsdtKrw(fetchImpl: FetchLike, now: Date): Promise<FxQuote> {
  const payload = await fetchJsonWithTimeout(
    fetchImpl,
    'https://api.upbit.com/v1/ticker?markets=KRW-USDT',
  ) as Array<{ market?: string; trade_price?: number; timestamp?: number }>;
  const ticker = payload[0];
  const rate = finitePositive(ticker?.trade_price);
  const timestamp = ticker?.timestamp;
  const iso = typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp >= 1e12 && timestamp <= now.getTime()
    ? new Date(timestamp).toISOString() : null;
  const time = quoteTimeEvidence(iso, 'iso', now.getTime());
  if (!Array.isArray(payload) || payload.length !== 1 || ticker?.market !== 'KRW-USDT' || rate == null || !time.updatedAt) throw new Error('USDT_KRW_FX_UNAVAILABLE');
  return {
    currency: 'USDT',
    krwRate: rate,
    source: 'upbit-public:KRW-USDT',
    asOf: time.updatedAt,
    quality: time.freshness.status === 'STALE' ? 'STALE' : 'DELAYED',
  };
}

export async function loadFreePublicFxQuotes(fetchImpl: FetchLike = fetch, now = new Date()): Promise<{
  quotes: FxQuote[];
  missing: string[];
}> {
  const settled = await Promise.allSettled([loadUsdKrw(fetchImpl, now), loadUsdtKrw(fetchImpl, now)]);
  const quotes: FxQuote[] = [];
  const missing: string[] = [];
  const names = ['USD_KRW', 'USDT_KRW'] as const;
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      quotes.push(result.value);
      if (result.value.quality === 'STALE') missing.push(`FX:${names[index]}:STALE`);
    }
    else missing.push(`FX:${names[index]}:UNAVAILABLE`);
  });
  return { quotes, missing };
}

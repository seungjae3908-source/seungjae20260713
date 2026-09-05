import type { FxQuote } from '../modules/portfolio/intelligence-v2.ts';

type FetchLike = typeof fetch;

function finitePositive(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
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

async function loadUsdKrw(fetchImpl: FetchLike): Promise<FxQuote> {
  const payload = await fetchJsonWithTimeout(
    fetchImpl,
    'https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1m&range=1d',
  ) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; regularMarketTime?: number } }> } };
  const meta = payload.chart?.result?.[0]?.meta;
  const rate = finitePositive(meta?.regularMarketPrice);
  const marketTime = finitePositive(meta?.regularMarketTime);
  if (rate == null || marketTime == null) throw new Error('USD_KRW_FX_UNAVAILABLE');
  return {
    currency: 'USD',
    krwRate: rate,
    source: 'yahoo-public:KRW=X',
    asOf: new Date(marketTime * 1000).toISOString(),
    quality: 'DELAYED',
  };
}

async function loadUsdtKrw(fetchImpl: FetchLike): Promise<FxQuote> {
  const payload = await fetchJsonWithTimeout(
    fetchImpl,
    'https://api.upbit.com/v1/ticker?markets=KRW-USDT',
  ) as Array<{ trade_price?: number; timestamp?: number }>;
  const ticker = payload[0];
  const rate = finitePositive(ticker?.trade_price);
  const timestamp = finitePositive(ticker?.timestamp);
  if (rate == null || timestamp == null) throw new Error('USDT_KRW_FX_UNAVAILABLE');
  return {
    currency: 'USDT',
    krwRate: rate,
    source: 'upbit-public:KRW-USDT',
    asOf: new Date(timestamp).toISOString(),
    quality: 'DELAYED',
  };
}

export async function loadFreePublicFxQuotes(fetchImpl: FetchLike = fetch): Promise<{
  quotes: FxQuote[];
  missing: string[];
}> {
  const settled = await Promise.allSettled([loadUsdKrw(fetchImpl), loadUsdtKrw(fetchImpl)]);
  const quotes: FxQuote[] = [];
  const missing: string[] = [];
  const names = ['USD_KRW', 'USDT_KRW'] as const;
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') quotes.push(result.value);
    else missing.push(`FX:${names[index]}:UNAVAILABLE`);
  });
  return { quotes, missing };
}

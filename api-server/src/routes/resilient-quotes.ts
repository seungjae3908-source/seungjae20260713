import { Router, type IRouter } from 'express';
import * as naver from '../providers/naver';
import * as yahoo from '../providers/yahoo';
import {
  MarketDataService,
  type QuoteRow,
} from '../services/market-data.service';
import {
  ApiResilienceError,
  resilientCall,
  type ResilientCallResult,
} from '../lib/api-resilience';

const router: IRouter = Router();

type ConcreteMarket = 'KR' | 'US';

type BasicStock = {
  ticker: string;
  name: string;
  market: ConcreteMarket;
  currency: 'KRW' | 'USD';
};

type QuoteWithMeta = QuoteRow & {
  source: string;
  isStale: boolean;
  staleAgeMs: number;
  fetchedAt: string;
};

const KNOWN_STOCKS: BasicStock[] = [
  { ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW' },
  { ticker: '000660', name: 'SK하이닉스', market: 'KR', currency: 'KRW' },
  { ticker: '005380', name: '현대차', market: 'KR', currency: 'KRW' },
  { ticker: '000270', name: '기아', market: 'KR', currency: 'KRW' },
  { ticker: '035420', name: 'NAVER', market: 'KR', currency: 'KRW' },
  { ticker: '035720', name: '카카오', market: 'KR', currency: 'KRW' },
  { ticker: 'AAPL', name: 'Apple', market: 'US', currency: 'USD' },
  { ticker: 'MSFT', name: 'Microsoft', market: 'US', currency: 'USD' },
  { ticker: 'NVDA', name: 'NVIDIA', market: 'US', currency: 'USD' },
  { ticker: 'AMZN', name: 'Amazon', market: 'US', currency: 'USD' },
  { ticker: 'META', name: 'Meta Platforms', market: 'US', currency: 'USD' },
  { ticker: 'TSLA', name: 'Tesla', market: 'US', currency: 'USD' },
];

function normalizeTicker(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function uniqueTickers(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => normalizeTicker(value)).filter(Boolean)),
  ).slice(0, 50);
}

function isKrTicker(ticker: string): boolean {
  return /^\d{6}$/.test(ticker);
}

function stockMeta(ticker: string): BasicStock {
  const clean = normalizeTicker(ticker);
  return (
    KNOWN_STOCKS.find((stock) => stock.ticker === clean) ?? {
      ticker: clean,
      name: clean,
      market: isKrTicker(clean) ? 'KR' : 'US',
      currency: isKrTicker(clean) ? 'KRW' : 'USD',
    }
  );
}

function quotePrice(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const quote = value as Record<string, unknown>;
  return Number(
    quote.price ??
      quote.currentPrice ??
      quote.regularMarketPrice ??
      0,
  );
}

function validProviderQuote(value: unknown): boolean {
  const price = quotePrice(value);
  return Number.isFinite(price) && price > 0;
}

function providerQuoteToRow(
  providerQuote: any,
  stock: BasicStock,
  provider: 'naver' | 'yahoo',
  meta: ResilientCallResult<any>,
): QuoteWithMeta {
  const price = quotePrice(providerQuote);
  const previousClose = Number(
    providerQuote.previousClose ?? providerQuote.prevClose ?? price,
  );
  const changeAmount = Number(
    providerQuote.changeAmount ??
      providerQuote.change ??
      price - previousClose,
  );
  const changePercent = Number(
    providerQuote.changePercent ??
      providerQuote.regularMarketChangePercent ??
      (previousClose ? (changeAmount / previousClose) * 100 : 0),
  );
  const volume = Number(providerQuote.volume ?? 0);
  const tradingValue = Number(
    providerQuote.tradingValue ?? price * volume,
  );

  return {
    ticker: stock.ticker,
    name: String(providerQuote.name ?? stock.name),
    market: stock.market,
    currency: stock.currency,
    assetType: 'stock' as any,
    price,
    changeAmount,
    changePercent,
    volume,
    tradingValue,
    open: Number(providerQuote.open ?? 0),
    high: Number(providerQuote.high ?? 0),
    low: Number(providerQuote.low ?? 0),
    previousClose,
    updatedAt: String(providerQuote.updatedAt ?? meta.fetchedAt),
    rating: {
      score: Math.max(1, Math.min(100, 50 + changePercent * 3)),
      rating:
        changePercent > 3 ? 'BUY' : changePercent < -3 ? 'SELL' : 'HOLD',
    } as any,
    reason:
      meta.isStale
        ? `${provider} 마지막 정상 시세입니다.`
        : `${provider} 실제 시세입니다.`,
    source: `${provider}-${meta.source}`,
    isStale: meta.isStale,
    staleAgeMs: meta.staleAgeMs,
    fetchedAt: meta.fetchedAt,
  };
}

function validServiceQuote(value: QuoteRow | null | undefined): value is QuoteRow {
  if (!value || !Number.isFinite(Number(value.price)) || Number(value.price) <= 0) {
    return false;
  }

  const reason = String(value.reason ?? '').toLowerCase();
  return (
    value.price !== 3800 &&
    !reason.includes('fallback') &&
    value.name !== value.ticker
  );
}

async function loadProviderQuote(
  ticker: string,
): Promise<QuoteWithMeta | null> {
  const stock = stockMeta(ticker);

  if (stock.market === 'KR') {
    try {
      const response = await resilientCall({
        provider: 'naver',
        key: `quote:${stock.ticker}`,
        operation: () => naver.getQuote(stock.ticker),
        timeoutMs: 4_500,
        retries: 1,
        retryBaseDelayMs: 150,
        cacheTtlMs: 3_000,
        staleTtlMs: 120_000,
        circuitFailureThreshold: 4,
        circuitResetMs: 30_000,
        validate: validProviderQuote,
      });
      return providerQuoteToRow(response.value, stock, 'naver', response);
    } catch (error) {
      if (!(error instanceof ApiResilienceError)) {
        console.error('[resilient-quotes] naver error:', error);
      }
    }
  }

  try {
    const response = await resilientCall({
      provider: 'yahoo',
      key: `quote:${stock.ticker}`,
      operation: () => yahoo.getQuote(stock.ticker),
      timeoutMs: 5_000,
      retries: 1,
      retryBaseDelayMs: 200,
      cacheTtlMs: 3_000,
      staleTtlMs: 120_000,
      circuitFailureThreshold: 4,
      circuitResetMs: 30_000,
      validate: validProviderQuote,
    });
    return providerQuoteToRow(response.value, stock, 'yahoo', response);
  } catch (error) {
    if (!(error instanceof ApiResilienceError)) {
      console.error('[resilient-quotes] yahoo error:', error);
    }
  }

  try {
    const response = await resilientCall({
      provider: 'market-data',
      key: `quote:${stock.ticker}`,
      operation: () => MarketDataService.getQuoteRow(stock.ticker),
      timeoutMs: 5_000,
      retries: 0,
      cacheTtlMs: 3_000,
      staleTtlMs: 120_000,
      circuitFailureThreshold: 4,
      circuitResetMs: 30_000,
      validate: validServiceQuote,
    });

    const row = response.value;
    if (!validServiceQuote(row)) return null;

    return {
      ...row,
      reason: response.isStale
        ? '마지막 정상 시세입니다.'
        : row.reason,
      source: `market-data-${response.source}`,
      isStale: response.isStale,
      staleAgeMs: response.staleAgeMs,
      fetchedAt: response.fetchedAt,
    };
  } catch (error) {
    if (!(error instanceof ApiResilienceError)) {
      console.error('[resilient-quotes] market-data error:', error);
    }
  }

  return null;
}

router.get('/quotes', async (req, res) => {
  const raw =
    req.query.tickers ??
    req.query.symbols ??
    req.query.symbol ??
    req.query.ticker ??
    '';
  const tickers = uniqueTickers(String(raw).split(','));

  if (tickers.length === 0) {
    res.status(400).json({
      ok: false,
      error: 'TICKERS_REQUIRED',
      quotes: [],
      unavailable: [],
    });
    return;
  }

  const settled = await Promise.allSettled(
    tickers.map(async (ticker) => ({
      ticker,
      quote: await loadProviderQuote(ticker),
    })),
  );

  const quotes: QuoteWithMeta[] = [];
  const unavailable: Array<{
    ticker: string;
    price: null;
    reason: string;
  }> = [];

  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    const ticker = tickers[index];

    if (result.status === 'fulfilled' && result.value.quote) {
      quotes.push(result.value.quote);
      continue;
    }

    unavailable.push({
      ticker,
      price: null,
      reason: '실제 시세와 마지막 정상 시세를 모두 조회하지 못했습니다.',
    });
  }

  res.status(quotes.length > 0 ? 200 : 503).json({
    ok: quotes.length > 0,
    partial: unavailable.length > 0,
    quotes,
    unavailable,
    requested: tickers.length,
    succeeded: quotes.length,
    failed: unavailable.length,
    updatedAt: new Date().toISOString(),
  });
});

export default router;

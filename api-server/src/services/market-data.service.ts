// MarketDataService — quotes, candlesticks, company profiles and global search.

import {
  CATALOG,
  getCatalogEntry,
  registerDynamicEntry,
  type CatalogEntry,
  type Market,
  type Currency,
} from '../data/catalog';
import { classifyAssetType, type AssetType } from '../data/asset-type';
import * as market from '../sample/market';
import { getCompanyProfile as getSampleCompanyProfile } from '../sample/company';
import { computeScores } from '../sample/scores';
import { scoreToRating } from '../sample/rating';
import * as yahoo from '../providers/yahoo';
import * as naver from '../providers/naver';
import * as finnhub from '../providers/finnhub';
import { getKrUniverse } from '../providers/krx';
import { providerStatus } from '../lib/config';
import { getKiwoomChartCandles } from '../kiwoom-chart';
import { cached, TTL } from '../lib/cache';
import type {
  Candle,
  CompanyProfile,
  Quote,
  RatingResult,
  Timeframe,
} from '../sample/types';

export interface SearchResult {
  ticker: string;
  name: string;
  market: string;
  currency: string;
  assetType: AssetType;
  aliases?: string[];
}

export interface QuoteRow {
  ticker: string;
  name: string;
  market: string;
  currency: string;
  assetType: AssetType;
  price: number;
  changeAmount: number;
  changePercent: number;
  volume: number;
  tradingValue: number;
  high?: number;
  low?: number;
  open?: number;
  previousClose?: number;
  updatedAt: string;
  rating: RatingResult;
  reason?: string;
  rank?: number;
}

type LooseQuote = Partial<Quote> & {
  ticker?: string;
  symbol?: string;
  name?: string;
  price?: number;
  close?: number;
  currentPrice?: number;
  regularMarketPrice?: number;
  change?: number;
  changeAmount?: number;
  changePercent?: number;
  regularMarketChangePercent?: number;
  percent?: number;
  volume?: number;
  tradingValue?: number;
  marketCap?: number;
  open?: number;
  high?: number;
  low?: number;
  previousClose?: number;
  prevClose?: number;
  updatedAt?: string;
};

const EXTRA_ALIASES: Record<
  string,
  {
    ticker: string;
    name: string;
    market: Market;
    currency: Currency;
    aliases: string[];
  }
> = {
  삼성전자: {
    ticker: '005930',
    name: '삼성전자',
    market: 'KR',
    currency: 'KRW',
    aliases: ['삼성', '삼전', 'samsung electronics', 'samsung'],
  },
  삼전: {
    ticker: '005930',
    name: '삼성전자',
    market: 'KR',
    currency: 'KRW',
    aliases: ['삼성전자', '삼성', 'samsung'],
  },
  sk하이닉스: {
    ticker: '000660',
    name: 'SK하이닉스',
    market: 'KR',
    currency: 'KRW',
    aliases: ['하이닉스', 'sk hynix', 'hynix'],
  },
  하이닉스: {
    ticker: '000660',
    name: 'SK하이닉스',
    market: 'KR',
    currency: 'KRW',
    aliases: ['sk하이닉스', 'sk hynix'],
  },
  현대차: {
    ticker: '005380',
    name: '현대차',
    market: 'KR',
    currency: 'KRW',
    aliases: ['현대자동차', 'hyundai motor'],
  },
  기아: {
    ticker: '000270',
    name: '기아',
    market: 'KR',
    currency: 'KRW',
    aliases: ['kia'],
  },
  네이버: {
    ticker: '035420',
    name: 'NAVER',
    market: 'KR',
    currency: 'KRW',
    aliases: ['naver'],
  },
  카카오: {
    ticker: '035720',
    name: '카카오',
    market: 'KR',
    currency: 'KRW',
    aliases: ['kakao'],
  },
  엔비디아: {
    ticker: 'NVDA',
    name: 'NVIDIA',
    market: 'US',
    currency: 'USD',
    aliases: ['nvidia', 'nvda'],
  },
  nvda: {
    ticker: 'NVDA',
    name: 'NVIDIA',
    market: 'US',
    currency: 'USD',
    aliases: ['엔비디아', 'nvidia'],
  },
  애플: {
    ticker: 'AAPL',
    name: 'Apple',
    market: 'US',
    currency: 'USD',
    aliases: ['apple', 'aapl'],
  },
  테슬라: {
    ticker: 'TSLA',
    name: 'Tesla',
    market: 'US',
    currency: 'USD',
    aliases: ['tesla', 'tsla'],
  },
  마이크로소프트: {
    ticker: 'MSFT',
    name: 'Microsoft',
    market: 'US',
    currency: 'USD',
    aliases: ['msft', 'microsoft'],
  },
  아마존: {
    ticker: 'AMZN',
    name: 'Amazon',
    market: 'US',
    currency: 'USD',
    aliases: ['amazon', 'amzn'],
  },
  구글: {
    ticker: 'GOOGL',
    name: 'Alphabet A',
    market: 'US',
    currency: 'USD',
    aliases: ['google', 'alphabet', 'googl', 'goog'],
  },
  메타: {
    ticker: 'META',
    name: 'Meta Platforms',
    market: 'US',
    currency: 'USD',
    aliases: ['meta', 'facebook'],
  },
  브로드컴: {
    ticker: 'AVGO',
    name: 'Broadcom',
    market: 'US',
    currency: 'USD',
    aliases: ['broadcom', 'avgo'],
  },
  amd: {
    ticker: 'AMD',
    name: 'AMD',
    market: 'US',
    currency: 'USD',
    aliases: ['advanced micro devices'],
  },
  인텔: {
    ticker: 'INTC',
    name: 'Intel',
    market: 'US',
    currency: 'USD',
    aliases: ['intel', 'intc'],
  },
  리게티: {
    ticker: 'RGTI',
    name: 'Rigetti Computing',
    market: 'US',
    currency: 'USD',
    aliases: ['rigetti', 'rgti'],
  },
  아이온큐: {
    ticker: 'IONQ',
    name: 'IonQ',
    market: 'US',
    currency: 'USD',
    aliases: ['ionq'],
  },
};

const FALLBACK_CATALOG: CatalogEntry[] = [
  createEntry('005930', '삼성전자', 'KR', 'KRW', ['삼성', '삼전']),
  createEntry('000660', 'SK하이닉스', 'KR', 'KRW', ['하이닉스']),
  createEntry('005380', '현대차', 'KR', 'KRW', ['현대자동차']),
  createEntry('000270', '기아', 'KR', 'KRW', ['kia']),
  createEntry('035420', 'NAVER', 'KR', 'KRW', ['네이버']),
  createEntry('035720', '카카오', 'KR', 'KRW', ['kakao']),
  createEntry('373220', 'LG에너지솔루션', 'KR', 'KRW', ['lg엔솔']),
  createEntry('207940', '삼성바이오로직스', 'KR', 'KRW', ['삼바']),
  createEntry('068270', '셀트리온', 'KR', 'KRW', []),
  createEntry('051910', 'LG화학', 'KR', 'KRW', []),
  createEntry('006400', '삼성SDI', 'KR', 'KRW', []),
  createEntry('005490', 'POSCO홀딩스', 'KR', 'KRW', ['포스코']),
  createEntry('003670', '포스코퓨처엠', 'KR', 'KRW', []),
  createEntry('012330', '현대모비스', 'KR', 'KRW', []),
  createEntry('028260', '삼성물산', 'KR', 'KRW', []),
  createEntry('055550', '신한지주', 'KR', 'KRW', []),
  createEntry('105560', 'KB금융', 'KR', 'KRW', []),
  createEntry('086790', '하나금융지주', 'KR', 'KRW', []),
  createEntry('316140', '우리금융지주', 'KR', 'KRW', []),
  createEntry('066570', 'LG전자', 'KR', 'KRW', []),
  createEntry('096770', 'SK이노베이션', 'KR', 'KRW', []),
  createEntry('017670', 'SK텔레콤', 'KR', 'KRW', []),
  createEntry('030200', 'KT', 'KR', 'KRW', []),
  createEntry('032830', '삼성생명', 'KR', 'KRW', []),
  createEntry('000810', '삼성화재', 'KR', 'KRW', []),
  createEntry('033780', 'KT&G', 'KR', 'KRW', []),
  createEntry('015760', '한국전력', 'KR', 'KRW', []),
  createEntry('034020', '두산에너빌리티', 'KR', 'KRW', []),
  createEntry('010130', '고려아연', 'KR', 'KRW', []),
  createEntry('009540', 'HD한국조선해양', 'KR', 'KRW', []),
  createEntry('010140', '삼성중공업', 'KR', 'KRW', []),
  createEntry('329180', 'HD현대중공업', 'KR', 'KRW', []),
  createEntry('000720', '현대건설', 'KR', 'KRW', []),
  createEntry('006360', 'GS건설', 'KR', 'KRW', []),
  createEntry('047040', '대우건설', 'KR', 'KRW', []),
  createEntry('003490', '대한항공', 'KR', 'KRW', []),
  createEntry('089590', '제주항공', 'KR', 'KRW', []),
  createEntry('086520', '에코프로', 'KR', 'KRW', []),
  createEntry('247540', '에코프로비엠', 'KR', 'KRW', []),
  createEntry('196170', '알테오젠', 'KR', 'KRW', []),
  createEntry('028300', 'HLB', 'KR', 'KRW', []),
  createEntry('277810', '레인보우로보틱스', 'KR', 'KRW', []),
  createEntry('042700', '한미반도체', 'KR', 'KRW', []),
  createEntry('352820', '하이브', 'KR', 'KRW', []),
  createEntry('259960', '크래프톤', 'KR', 'KRW', []),
  createEntry('036570', '엔씨소프트', 'KR', 'KRW', []),
  createEntry('251270', '넷마블', 'KR', 'KRW', []),
  createEntry('011200', 'HMM', 'KR', 'KRW', []),
  createEntry('018260', '삼성에스디에스', 'KR', 'KRW', []),
  createEntry('090430', '아모레퍼시픽', 'KR', 'KRW', []),
  createEntry('004020', '현대제철', 'KR', 'KRW', []),
  createEntry('011070', 'LG이노텍', 'KR', 'KRW', []),

  createEntry('AAPL', 'Apple', 'US', 'USD', ['애플']),
  createEntry('MSFT', 'Microsoft', 'US', 'USD', ['마이크로소프트']),
  createEntry('NVDA', 'NVIDIA', 'US', 'USD', ['엔비디아']),
  createEntry('GOOGL', 'Alphabet A', 'US', 'USD', ['구글', '알파벳']),
  createEntry('GOOG', 'Alphabet C', 'US', 'USD', ['구글']),
  createEntry('AMZN', 'Amazon', 'US', 'USD', ['아마존']),
  createEntry('META', 'Meta Platforms', 'US', 'USD', ['메타', '페이스북']),
  createEntry('TSLA', 'Tesla', 'US', 'USD', ['테슬라']),
  createEntry('AVGO', 'Broadcom', 'US', 'USD', ['브로드컴']),
  createEntry('NFLX', 'Netflix', 'US', 'USD', ['넷플릭스']),
  createEntry('AMD', 'AMD', 'US', 'USD', []),
  createEntry('INTC', 'Intel', 'US', 'USD', ['인텔']),
  createEntry('PLTR', 'Palantir', 'US', 'USD', ['팔란티어']),
  createEntry('SOFI', 'SoFi', 'US', 'USD', []),
  createEntry('COIN', 'Coinbase', 'US', 'USD', ['코인베이스']),
  createEntry('UBER', 'Uber', 'US', 'USD', ['우버']),
  createEntry('AAL', 'American Airlines', 'US', 'USD', []),
  createEntry('DAL', 'Delta Air Lines', 'US', 'USD', []),
  createEntry('UAL', 'United Airlines', 'US', 'USD', []),
  createEntry('JPM', 'JPMorgan Chase', 'US', 'USD', []),
  createEntry('BAC', 'Bank of America', 'US', 'USD', []),
  createEntry('XOM', 'Exxon Mobil', 'US', 'USD', []),
  createEntry('CVX', 'Chevron', 'US', 'USD', []),
  createEntry('LLY', 'Eli Lilly', 'US', 'USD', []),
  createEntry('UNH', 'UnitedHealth', 'US', 'USD', []),
  createEntry('WMT', 'Walmart', 'US', 'USD', []),
  createEntry('COST', 'Costco', 'US', 'USD', []),
  createEntry('ORCL', 'Oracle', 'US', 'USD', []),
  createEntry('ADBE', 'Adobe', 'US', 'USD', []),
  createEntry('CRM', 'Salesforce', 'US', 'USD', []),
  createEntry('TXN', 'Texas Instruments', 'US', 'USD', []),
  createEntry('QCOM', 'Qualcomm', 'US', 'USD', []),
  createEntry('AMAT', 'Applied Materials', 'US', 'USD', []),
  createEntry('MU', 'Micron', 'US', 'USD', []),
  createEntry('SMCI', 'Super Micro Computer', 'US', 'USD', []),
  createEntry('ARM', 'Arm Holdings', 'US', 'USD', []),
  createEntry('TSM', 'TSMC', 'US', 'USD', []),
  createEntry('ASML', 'ASML', 'US', 'USD', []),
  createEntry('NVO', 'Novo Nordisk', 'US', 'USD', []),
  createEntry('MRNA', 'Moderna', 'US', 'USD', []),
  createEntry('PFE', 'Pfizer', 'US', 'USD', []),
  createEntry('JNJ', 'Johnson & Johnson', 'US', 'USD', []),
  createEntry('BA', 'Boeing', 'US', 'USD', []),
  createEntry('DIS', 'Disney', 'US', 'USD', []),
  createEntry('NKE', 'Nike', 'US', 'USD', []),
  createEntry('SHOP', 'Shopify', 'US', 'USD', []),
  createEntry('CRWD', 'CrowdStrike', 'US', 'USD', []),
  createEntry('SNOW', 'Snowflake', 'US', 'USD', []),
  createEntry('RGTI', 'Rigetti Computing', 'US', 'USD', ['리게티']),
  createEntry('IONQ', 'IonQ', 'US', 'USD', ['아이온큐']),
];

function createEntry(
  ticker: string,
  name: string,
  marketValue: Market,
  currency: Currency,
  aliases: string[],
): CatalogEntry {
  return {
    ticker,
    name,
    market: marketValue,
    currency,
    aliases,
  } as CatalogEntry;
}

function safeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, ''));

    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function cleanTicker(ticker: string): string {
  return String(ticker ?? '').trim().toUpperCase();
}

function normalizeText(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()［］\[\]{}·.,_\-]/g, '');
}

function isKrTicker(ticker: string): boolean {
  return /^\d/.test(ticker);
}

function normalizeMarketValue(value: unknown, ticker: string): Market {
  const text = String(value ?? '').toUpperCase();

  if (text.includes('KR') || text.includes('KOSPI') || text.includes('KOSDAQ')) {
    return 'KR' as Market;
  }

  if (text.includes('US') || text.includes('NASDAQ') || text.includes('NYSE')) {
    return 'US' as Market;
  }

  return (isKrTicker(ticker) ? 'KR' : 'US') as Market;
}

function normalizeCurrencyValue(value: unknown, marketValue: Market): Currency {
  const text = String(value ?? '').toUpperCase();

  if (text === 'KRW' || text === 'USD') return text as Currency;

  return (marketValue === 'KR' ? 'KRW' : 'USD') as Currency;
}

function catalogArray(): CatalogEntry[] {
  const base = Array.isArray(CATALOG) ? CATALOG : [];

  return dedupeEntries([...base, ...FALLBACK_CATALOG]);
}

function dedupeEntries(entries: CatalogEntry[]): CatalogEntry[] {
  const map = new Map<string, CatalogEntry>();

  for (const entry of entries) {
    const ticker = cleanTicker((entry as any).ticker);

    if (!ticker) continue;

    const prev = map.get(ticker);

    map.set(ticker, {
      ...(prev as any),
      ...(entry as any),
      ticker,
      name: (entry as any).name || (prev as any)?.name || ticker,
      market: normalizeMarketValue((entry as any).market, ticker),
      currency: normalizeCurrencyValue(
        (entry as any).currency,
        normalizeMarketValue((entry as any).market, ticker),
      ),
      aliases: Array.from(
        new Set([
          ...(((prev as any)?.aliases ?? []) as string[]),
          ...(((entry as any).aliases ?? []) as string[]),
        ]),
      ),
    } as CatalogEntry);
  }

  return Array.from(map.values());
}

function toSearchResult(entry: CatalogEntry): SearchResult {
  const ticker = cleanTicker((entry as any).ticker);
  const marketValue = normalizeMarketValue((entry as any).market, ticker);
  const currency = normalizeCurrencyValue((entry as any).currency, marketValue);

  return {
    ticker,
    name: String((entry as any).name ?? ticker),
    market: String(marketValue),
    currency: String(currency),
    assetType: classifyAssetType(entry),
    aliases: ((entry as any).aliases ?? []) as string[],
  };
}

function searchScore(entry: CatalogEntry, query: string): number {
  const q = normalizeText(query);
  const ticker = normalizeText((entry as any).ticker);
  const name = normalizeText((entry as any).name);
  const aliases = (((entry as any).aliases ?? []) as string[]).map(normalizeText);

  if (!q) return 1;
  if (ticker === q) return 1000;
  if (name === q) return 950;
  if (aliases.some((alias) => alias === q)) return 900;
  if (ticker.startsWith(q)) return 800;
  if (name.startsWith(q)) return 700;
  if (aliases.some((alias) => alias.startsWith(q))) return 650;
  if (ticker.includes(q)) return 500;
  if (name.includes(q)) return 450;
  if (aliases.some((alias) => alias.includes(q))) return 400;

  return 0;
}

function fallbackEntryFor(ticker: string): CatalogEntry {
  const clean = cleanTicker(ticker);
  const marketValue = normalizeMarketValue(undefined, clean);
  const currency = normalizeCurrencyValue(undefined, marketValue);

  return createEntry(clean, clean, marketValue, currency, []);
}

function resolveEntry(ticker: string): CatalogEntry {
  const clean = cleanTicker(ticker);

  const fromCatalog = getCatalogEntry(clean);

  if (fromCatalog) return fromCatalog;

  const fromFallback = catalogArray().find(
    (entry) => cleanTicker((entry as any).ticker) === clean,
  );

  if (fromFallback) return fromFallback;

  return fallbackEntryFor(clean);
}

function quotePrice(q: LooseQuote): number {
  return safeNumber(
    q.price ??
      q.currentPrice ??
      q.regularMarketPrice ??
      q.close ??
      q.previousClose ??
      q.prevClose,
    0,
  );
}

function quotePreviousClose(q: LooseQuote, price: number): number {
  return safeNumber(q.previousClose ?? q.prevClose, price);
}

function quoteChangeAmount(
  q: LooseQuote,
  price: number,
  previousClose: number,
) {
  const direct = safeNumber(q.changeAmount ?? q.change, Number.NaN);

  if (Number.isFinite(direct)) return direct;

  return price - previousClose;
}

function quoteChangePercent(
  q: LooseQuote,
  price: number,
  previousClose: number,
  changeAmount: number,
) {
  const direct = safeNumber(
    q.changePercent ??
      q.regularMarketChangePercent ??
      q.percent,
    Number.NaN,
  );

  if (Number.isFinite(direct)) return direct;

  if (previousClose === 0) return 0;

  return (changeAmount / previousClose) * 100;
}

function defaultRating(): RatingResult {
  return scoreToRating(50);
}

function ratingFromQuote(
  quote: LooseQuote,
  entry: CatalogEntry,
): RatingResult {
  try {
    const scores = computeScores({
      quote,
      entry,
    } as any);

    if (typeof scores === 'number') {
      return scoreToRating(scores);
    }

    if (typeof (scores as any)?.total === 'number') {
      return scoreToRating((scores as any).total);
    }

    if (typeof (scores as any)?.score === 'number') {
      return scoreToRating((scores as any).score);
    }

    return defaultRating();
  } catch {
    return defaultRating();
  }
}

function toQuoteRow(
  entry: CatalogEntry,
  quote: LooseQuote,
): QuoteRow {
  const ticker = cleanTicker((entry as any).ticker);
  const marketValue = normalizeMarketValue(
    (entry as any).market,
    ticker,
  );
  const currency = normalizeCurrencyValue(
    (entry as any).currency,
    marketValue,
  );
  const price = quotePrice(quote);
  const previousClose = quotePreviousClose(quote, price);
  const changeAmount = quoteChangeAmount(
    quote,
    price,
    previousClose,
  );
  const changePercent = quoteChangePercent(
    quote,
    price,
    previousClose,
    changeAmount,
  );
  const volume = safeNumber(quote.volume, 0);
  const tradingValue =
    safeNumber(quote.tradingValue, 0) ||
    Math.max(price * volume, 0);

  return {
    ticker,
    name: String(
      (entry as any).name ??
        quote.name ??
        ticker,
    ),
    market: String(marketValue),
    currency: String(currency),
    assetType: classifyAssetType(entry),
    price,
    changeAmount,
    changePercent,
    volume,
    tradingValue,
    high: safeNumber(quote.high, 0),
    low: safeNumber(quote.low, 0),
    open: safeNumber(quote.open, 0),
    previousClose,
    updatedAt: String(
      quote.updatedAt ??
        new Date().toISOString(),
    ),
    rating: ratingFromQuote(quote, entry),
  };
}

function sampleQuoteFor(
  entry: CatalogEntry,
): LooseQuote {
  const ticker = cleanTicker(
    (entry as any).ticker,
  );

  const base =
    isKrTicker(ticker)
      ? 5000 +
        ((Number(ticker.slice(-3)) || 100) *
          100)
      : 20 +
        ticker.charCodeAt(0) *
          3;

  const seed = [...ticker].reduce(
    (sum, char) =>
      sum +
      char.charCodeAt(0),
    0,
  );

  const changePercent = Number(
    (((seed % 1800) - 900) / 100).toFixed(2),
  );

  const price = Math.max(
    1,
    Math.round(
      base *
        (1 +
          changePercent /
            100),
    ),
  );

  const previousClose =
    price /
    (1 +
      changePercent /
        100);

  const volume =
    100_000 +
    seed *
      1377;

  return {
    ticker,
    name: String(
      (entry as any).name ??
        ticker,
    ),
    price,
    previousClose,
    changeAmount:
      price -
      previousClose,
    changePercent,
    volume,
    tradingValue:
      price *
      volume,
    open: previousClose,
    high:
      Math.max(
        price,
        previousClose,
      ) *
      1.02,
    low:
      Math.min(
        price,
        previousClose,
      ) *
      0.98,
    updatedAt:
      new Date().toISOString(),
  };
}

async function tryQuoteProvider(
  entry: CatalogEntry,
): Promise<LooseQuote | null> {
  const providers = providerStatus();

  const marketValue =
    normalizeMarketValue(
      (entry as any).market,
      (entry as any).ticker,
    );

  const attempts: Array<
    () => Promise<unknown>
  > = [];

  if (marketValue === 'KR') {
    attempts.push(
      () =>
        (naver as any).getQuote?.(
          entry,
        ),
    );

    attempts.push(
      () =>
        (naver as any).quote?.(
          entry,
        ),
    );
  }

  attempts.push(
    () =>
      (yahoo as any).getQuote?.(
        entry,
      ),
  );

  attempts.push(
    () =>
      (yahoo as any).quote?.(
        entry,
      ),
  );

  if (providers.finnhub) {
    attempts.push(
      () =>
        (finnhub as any).getQuote?.(
          entry,
        ),
    );

    attempts.push(
      () =>
        (finnhub as any).quote?.(
          entry,
        ),
    );
  }

  attempts.push(
    () =>
      (market as any).getQuote?.(
        (entry as any).ticker,
      ),
  );

  attempts.push(
    () =>
      (market as any).quote?.(
        (entry as any).ticker,
      ),
  );

  for (const attempt of attempts) {
    try {
      const result =
        await attempt();

      if (
        result &&
        typeof result === 'object'
      ) {
        const quote =
          result as LooseQuote;

        const price =
          quotePrice(quote);

        if (
          price > 0 ||
          quote.changePercent != null ||
          quote.volume != null
        ) {
          return quote;
        }
      }
    } catch {
      // Try next provider.
    }
  }

  return null;
}

async function tryCandlesProvider(
  entry: CatalogEntry,
  timeframe: Timeframe,
): Promise<Candle[]> {
  const ticker = cleanTicker(
    (entry as any).ticker,
  );

  const marketValue =
    normalizeMarketValue(
      (entry as any).market,
      ticker,
    );

  const timeframeText =
    String(
      timeframe ??
        '1D',
    );

  /*
   * 국내 종목은 키움증권 차트 API를 가장 먼저 사용합니다.
   * kiwoom-chart.ts가 cont-yn / next-key를 끝까지 따라가므로
   * 일봉과 전체 차트는 상장일부터 현재까지의 데이터를 받을 수 있습니다.
   */
  if (marketValue === 'KR') {
    try {
      const kiwoomRows =
        await getKiwoomChartCandles(
          ticker,
          timeframeText,
        );

      if (
        kiwoomRows.length >= 2
      ) {
        return kiwoomRows as Candle[];
      }
    } catch (error) {
      console.error(
        `kiwoom chart provider failed: ticker=${ticker}, timeframe=${timeframeText}`,
        error,
      );
    }
  }

  const attempts: Array<
    () => Promise<unknown>
  > = [
    () =>
      (yahoo as any).getCandles?.(
        entry,
        timeframe,
      ),

    () =>
      (yahoo as any).candles?.(
        entry,
        timeframe,
      ),

    () =>
      (naver as any).getCandles?.(
        entry,
        timeframe,
      ),

    () =>
      (naver as any).candles?.(
        entry,
        timeframe,
      ),

    () =>
      (finnhub as any).getCandles?.(
        entry,
        timeframe,
      ),

    () =>
      (finnhub as any).candles?.(
        entry,
        timeframe,
      ),

    () =>
      (market as any).getCandles?.(
        (entry as any).ticker,
        timeframe,
      ),

    () =>
      (market as any).candles?.(
        (entry as any).ticker,
        timeframe,
      ),
  ];

  for (const attempt of attempts) {
    try {
      const result =
        await attempt();

      if (
        Array.isArray(result) &&
        result.length >= 2
      ) {
        return result as Candle[];
      }
    } catch {
      // Try next provider.
    }
  }

  /*
   * 실제 금융 차트에 가짜 봉을 표시하지 않습니다.
   * 제공처가 모두 실패하면 빈 배열을 반환합니다.
   */
  return [];
}

async function tryProfileProvider(
  entry: CatalogEntry,
): Promise<CompanyProfile> {
  const attempts: Array<
    () => Promise<unknown>
  > = [
    () =>
      (finnhub as any).getCompanyProfile?.(
        entry,
      ),

    () =>
      (finnhub as any).companyProfile?.(
        entry,
      ),

    () =>
      (yahoo as any).getCompanyProfile?.(
        entry,
      ),

    () =>
      (yahoo as any).companyProfile?.(
        entry,
      ),

    () =>
      getSampleCompanyProfile(
        (entry as any).ticker,
      ),
  ];

  for (const attempt of attempts) {
    try {
      const result =
        await attempt();

      if (
        result &&
        typeof result === 'object'
      ) {
        return result as CompanyProfile;
      }
    } catch {
      // Try next provider.
    }
  }

  return {
    ticker: cleanTicker(
      (entry as any).ticker,
    ),

    name: String(
      (entry as any).name ??
        (entry as any).ticker,
    ),

    market: String(
      (entry as any).market ??
        '',
    ),

    currency: String(
      (entry as any).currency ??
        '',
    ),

    description:
      '기업 정보를 확인 중입니다.',

    sector: '',
    industry: '',
    website: '',
  } as CompanyProfile;
}

async function buildKrUniverseEntries(): Promise<
  CatalogEntry[]
> {
  try {
    const rows =
      await getKrUniverse();

    if (!Array.isArray(rows)) {
      return [];
    }

    return rows
      .map((row: any) => {
        const ticker =
          cleanTicker(
            row.ticker ??
              row.code ??
              row.symbol,
          );

        const name =
          String(
            row.name ??
              row.companyName ??
              ticker,
          );

        if (!ticker) {
          return null;
        }

        return createEntry(
          ticker,
          name,
          'KR' as Market,
          'KRW' as Currency,
          [name],
        );
      })
      .filter(
        (
          entry,
        ): entry is CatalogEntry =>
          Boolean(entry),
      );
  } catch {
    return [];
  }
}

export class MarketDataService {
  static async search(
    q: string,
    limit = 80,
  ): Promise<SearchResult[]> {
    const query =
      String(
        q ??
          '',
      ).trim();

    const aliasEntries =
      Object.entries(
        EXTRA_ALIASES,
      ).map(
        (
          [
            ,
            value,
          ],
        ) =>
          createEntry(
            value.ticker,
            value.name,
            value.market,
            value.currency,
            value.aliases,
          ),
      );

    const entries =
      dedupeEntries([
        ...catalogArray(),

        ...aliasEntries,

        ...(query.length >= 2
          ? await buildKrUniverseEntries()
          : []),
      ]);

    for (const entry of entries) {
      try {
        registerDynamicEntry(
          entry,
        );
      } catch {
        // Dynamic registration is optional.
      }
    }

    const scored = entries
      .map((entry) => ({
        entry,

        score:
          searchScore(
            entry,
            query,
          ),
      }))
      .filter(
        (item) =>
          query
            ? item.score > 0
            : true,
      )
      .sort((a, b) => {
        if (
          b.score !==
          a.score
        ) {
          return (
            b.score -
            a.score
          );
        }

        return String(
          (a.entry as any).ticker,
        ).localeCompare(
          String(
            (b.entry as any).ticker,
          ),
        );
      })
      .slice(
        0,
        limit,
      )
      .map(
        (item) =>
          toSearchResult(
            item.entry,
          ),
      );

    return scored;
  }

  static async getQuote(
    ticker: string,
  ): Promise<Quote> {
    const entry =
      resolveEntry(
        ticker,
      );

    return cached(
      `quote:${cleanTicker(ticker)}`,

      TTL.quote,

      async () => {
        const providerQuote =
          await tryQuoteProvider(
            entry,
          );

        const quote =
          providerQuote ??
          sampleQuoteFor(
            entry,
          );

        return {
          ...quote,

          ticker:
            cleanTicker(
              (entry as any).ticker,
            ),

          name: String(
            (entry as any).name ??
              (entry as any).ticker,
          ),
        } as Quote;
      },
    );
  }

  static async getQuoteRow(
    ticker: string,
  ): Promise<QuoteRow | null> {
    const entry =
      resolveEntry(
        ticker,
      );

    try {
      const quote =
        await this.getQuote(
          ticker,
        );

      return toQuoteRow(
        entry,
        quote as LooseQuote,
      );
    } catch {
      try {
        return toQuoteRow(
          entry,
          sampleQuoteFor(
            entry,
          ),
        );
      } catch {
        return null;
      }
    }
  }

  static async getQuotes(
    tickers: string[],
  ): Promise<QuoteRow[]> {
    const rows =
      await Promise.all(
        tickers.map(
          (ticker) =>
            this.getQuoteRow(
              ticker,
            ),
        ),
      );

    return rows.filter(
      (
        row,
      ): row is QuoteRow =>
        Boolean(row),
    );
  }

  static async getCandles(
    ticker: string,
    timeframe: Timeframe =
      '1D' as Timeframe,
  ): Promise<Candle[]> {
    const entry =
      resolveEntry(
        ticker,
      );

    return cached(
      `candles:${cleanTicker(ticker)}:${String(timeframe)}`,

      TTL.candles ??
        TTL.quote,

      async () =>
        tryCandlesProvider(
          entry,
          timeframe,
        ),
    );
  }

  static async getCompanyProfile(
    ticker: string,
  ): Promise<CompanyProfile> {
    const entry =
      resolveEntry(
        ticker,
      );

    return cached(
      `company:${cleanTicker(ticker)}`,

      TTL.profile ??
        TTL.quote,

      async () =>
        tryProfileProvider(
          entry,
        ),
    );
  }

  static async getProfile(
    ticker: string,
  ): Promise<CompanyProfile> {
    return this.getCompanyProfile(
      ticker,
    );
  }

  static async getRating(
    ticker: string,
  ): Promise<RatingResult> {
    const quote =
      await this.getQuoteRow(
        ticker,
      );

    return (
      quote?.rating ??
      defaultRating()
    );
  }

  static async getCatalogEntry(
    ticker: string,
  ): Promise<CatalogEntry> {
    return resolveEntry(
      ticker,
    );
  }

  static async getUniverse(
    marketValue?:
      | 'ALL'
      | 'KR'
      | 'US',
  ): Promise<SearchResult[]> {
    const entries =
      dedupeEntries([
        ...catalogArray(),

        ...(await buildKrUniverseEntries()),
      ]);

    const filtered =
      entries.filter(
        (entry) => {
          if (
            !marketValue ||
            marketValue ===
              'ALL'
          ) {
            return true;
          }

          const ticker =
            cleanTicker(
              (entry as any).ticker,
            );

          const entryMarket =
            normalizeMarketValue(
              (entry as any).market,
              ticker,
            );

          return (
            String(
              entryMarket,
            ) ===
            marketValue
          );
        },
      );

    return filtered.map(
      toSearchResult,
    );
  }
}

export default MarketDataService;
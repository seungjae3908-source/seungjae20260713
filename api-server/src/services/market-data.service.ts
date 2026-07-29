// MarketDataService — quotes, candlesticks, company profiles and global search.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CATALOG,
  getCatalogEntry,
  registerDynamicEntry,
  type CatalogEntry,
  type Market,
  type Currency,
} from '../data/catalog';
import { classifyAssetType, type AssetType } from '../data/asset-type';
import { computeScores } from '../sample/scores';
import { scoreToRating } from '../sample/rating';
import * as yahoo from '../providers/yahoo';
import * as naver from '../providers/naver';
import * as finnhub from '../providers/finnhub';
import { getKrUniverse } from '../providers/krx';
import { providerStatus } from '../lib/config';
import {
  LastGoodCache,
  OperationTimeoutError,
  SingleFlight,
  withTimeout,
} from '../lib/async-control';
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
  exchange?: string;
  signals?: string[];
  entry?: number;
  take1?: number;
  take2?: number;
  stop?: number;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
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

interface CandleDiskCache {
  version: 'v3';
  savedAt: number;
  ticker: string;
  timeframe: string;
  candles: Candle[];
  provider?: string;
}

export interface MarketSearchResult {
  results: SearchResult[];
  partial: boolean;
  warnings: string[];
}

const CANDLE_CACHE_VERSION = 'v3' as const;
const DAILY_AGGREGATE_SIZES: Record<string, number> = {
  '3D': 3,
  '5D': 5,
  '10D': 10,
  '20D': 20,
};

function candleCacheDirectory(): string {
  const configured = process.env.KIWOOM_CHART_CACHE_DIR?.trim();
  if (configured) return path.resolve(configured);

  const cwd = process.cwd();
  const apiRoot = path.basename(cwd) === 'api-server'
    ? cwd
    : path.join(cwd, 'api-server');
  return path.join(apiRoot, 'data', 'chart-cache');
}

function candleCachePath(ticker: string, timeframe: string): string {
  const safeTicker = cleanTicker(ticker).replace(/[^0-9A-Z_-]/g, '');
  const safeTimeframe = String(timeframe).replace(/[^0-9A-Z]/gi, '');
  return path.join(
    candleCacheDirectory(),
    `${CANDLE_CACHE_VERSION}-${safeTicker}-${safeTimeframe}.json`,
  );
}

function candleCacheTtl(timeframe: string): number {
  return /m|H/.test(timeframe)
    ? 2 * 60 * 1000
    : 12 * 60 * 60 * 1000;
}

async function readCandleDiskCache(
  ticker: string,
  timeframe: string,
): Promise<{ candles: Candle[]; fresh: boolean; provider: string; savedAt: number } | null> {
  try {
    const raw = await readFile(candleCachePath(ticker, timeframe), 'utf8');
    const parsed = JSON.parse(raw) as CandleDiskCache;
    if (parsed.version !== CANDLE_CACHE_VERSION) return null;
    if (!Array.isArray(parsed.candles) || parsed.candles.length < 2) return null;
    return {
      candles: parsed.candles,
      provider: parsed.provider ?? 'unknown',
      savedAt: Number(parsed.savedAt ?? 0),
      fresh: Date.now() - Number(parsed.savedAt ?? 0) <= candleCacheTtl(timeframe),
    };
  } catch {
    return null;
  }
}

async function writeCandleDiskCache(
  ticker: string,
  timeframe: string,
  candles: Candle[],
  provider?: string,
): Promise<void> {
  if (candles.length < 2) return;
  try {
    await mkdir(candleCacheDirectory(), { recursive: true });
    const payload: CandleDiskCache = {
      version: CANDLE_CACHE_VERSION,
      savedAt: Date.now(),
      ticker: cleanTicker(ticker),
      timeframe,
      candles,
      provider,
    };
    await writeFile(
      candleCachePath(ticker, timeframe),
      JSON.stringify(payload),
      'utf8',
    );
  } catch (error) {
    console.warn('chart disk cache write failed:', error);
  }
}

function candleTimeValue(value: Candle['time']): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  const text = String(value ?? '').trim();
  const compactDate = text.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compactDate) {
    return Date.UTC(
      Number(compactDate[1]),
      Number(compactDate[2]) - 1,
      Number(compactDate[3]),
    );
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortCandles(rows: Candle[]): Candle[] {
  return [...rows].sort(
    (a, b) => candleTimeValue(a.time) - candleTimeValue(b.time),
  );
}

function aggregateCandleChunk(chunk: Candle[]): Candle {
  return {
    time: chunk[0].time,
    open: chunk[0].open,
    high: Math.max(...chunk.map((item) => item.high)),
    low: Math.min(...chunk.map((item) => item.low)),
    close: chunk[chunk.length - 1].close,
    volume: chunk.reduce((sum, item) => sum + item.volume, 0),
  };
}

function aggregateCachedCandles(
  rows: Candle[],
  size: number,
): Candle[] {
  const sortedRows = sortCandles(rows);
  if (size <= 1 || sortedRows.length <= 1) return sortedRows;

  const result: Candle[] = [];
  for (let index = 0; index < sortedRows.length; index += size) {
    const chunk = sortedRows.slice(index, index + size);
    if (chunk.length === 0) continue;

    result.push(aggregateCandleChunk(chunk));
  }

  return result;
}

function calendarCandleKey(candle: Candle, timeframe: string): string {
  const date = new Date(candleTimeValue(candle.time));

  if (timeframe === '1Y') return String(date.getUTCFullYear());
  if (timeframe === '1M') return date.toISOString().slice(0, 7);

  const monday = new Date(date);
  const daysFromMonday = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - daysFromMonday);
  return monday.toISOString().slice(0, 10);
}

function aggregateCalendarCandles(
  rows: Candle[],
  timeframe: '1W' | '1M' | '1Y',
): Candle[] {
  const groups = sortCandles(rows).reduce((map, candle) => {
    const key = calendarCandleKey(candle, timeframe);
    const group = map.get(key) ?? [];
    group.push(candle);
    map.set(key, group);
    return map;
  }, new Map<string, Candle[]>());

  return [...groups.values()].map(aggregateCandleChunk);
}

function aggregateDailyProviderCandles(
  rows: Candle[],
  timeframe: string,
): Candle[] {
  const aggregateSize = DAILY_AGGREGATE_SIZES[timeframe];
  if (aggregateSize) return aggregateCachedCandles(rows, aggregateSize);

  if (timeframe === '1W' || timeframe === '1M' || timeframe === '1Y') {
    return aggregateCalendarCandles(rows, timeframe);
  }

  return sortCandles(rows);
}

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
    assetType: classifyAssetType(String((entry as any).name ?? ticker), marketValue as Market, String((entry as any).assetType ?? "")),
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
    assetType: classifyAssetType(String((entry as any).name ?? ticker), marketValue as Market, String((entry as any).assetType ?? "")),
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

async function tryQuoteProvider(
  entry: CatalogEntry,
): Promise<LooseQuote | null> {
  const providers = providerStatus();
  const marketValue = normalizeMarketValue(
    (entry as any).market,
    (entry as any).ticker,
  );

  const attempts: Array<() => Promise<unknown>> = [];

  if (marketValue === 'KR') {
    attempts.push(() => naver.getQuote(entry));
    attempts.push(() => yahoo.getQuote(entry));
  } else {
    attempts.push(() => yahoo.getQuote(entry));
    if (providers.finnhub) attempts.push(() => finnhub.getQuote(entry));
  }

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (!result || typeof result !== 'object') continue;
      const quote = result as LooseQuote;
      const price = quotePrice(quote);
      if (price > 0 || quote.changePercent != null || quote.volume != null) {
        return quote;
      }
    } catch {
      // Try the next live provider.
    }
  }

  return null;
}

async function tryCandlesProvider(
  entry: CatalogEntry,
  timeframe: Timeframe,
): Promise<{ candles: Candle[]; provider: string }> {
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
  const isIntradayTimeframe = ['1m', '3m', '5m', '15m', '30m', '60m', '1H', '4H'].includes(timeframeText);
  const minimumUsefulCandles = ['1D', '3D', '5D', '10D', '20D', 'ALL'].includes(timeframeText) ? 30 : 2;

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
        kiwoomRows.length >= minimumUsefulCandles
      ) {
        return { candles: kiwoomRows as Candle[], provider: 'kiwoom' };
      }
    } catch (error) {
      console.error(
        `kiwoom chart provider failed: ticker=${ticker}, timeframe=${timeframeText}`,
        error,
      );
    }

    if (isIntradayTimeframe) {
      return { candles: [], provider: 'none' };
    }
  }

  const attempts: Array<{ name: string; run: () => Promise<unknown> }> =
    marketValue === 'KR'
      ? [
          {
            name: 'naver',
            run: async () => {
              if (timeframeText === 'ALL') return [];
              const rows = await naver.getCandles(entry);
              return aggregateDailyProviderCandles(rows, timeframeText);
            },
          },
          { name: 'yahoo', run: () => yahoo.getCandles(entry, String(timeframe)) },
        ]
      : [{ name: 'yahoo', run: () => yahoo.getCandles(entry, String(timeframe)) }];

  for (const attempt of attempts) {
    try {
      const result =
        await attempt.run();

      if (
        Array.isArray(result) &&
        result.length >= minimumUsefulCandles
      ) {
        return { candles: result as Candle[], provider: attempt.name };
      }
    } catch {
      // Try next provider.
    }
  }

  /*
   * 실제 금융 차트에 가짜 봉을 표시하지 않습니다.
   * 제공처가 모두 실패하면 빈 배열을 반환합니다.
   */
  return { candles: [], provider: 'none' };
}

async function tryProfileProvider(
  entry: CatalogEntry,
): Promise<CompanyProfile> {
  const attempts: Array<() => Promise<unknown>> = [
    () => finnhub.getProfile(entry),
    () => yahoo.getCompanyProfile(entry),
    () => naver.getCompanyProfile(entry),
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
    country: String((entry as any).market === 'KR' ? '대한민국' : '미국'),
    mainBusiness: '',
    competitors: [],
  } as CompanyProfile;
}

interface KrUniverseResult {
  entries: CatalogEntry[];
  partial: boolean;
  warning?: string;
}

const krUniverseFlights = new SingleFlight<string, CatalogEntry[]>();
const krUniverseLastGood = new LastGoodCache<string, CatalogEntry[]>();
const KR_UNIVERSE_LAST_GOOD_MS = 24 * 60 * 60_000;

function krUniverseTimeoutMs(): number {
  const configured = Number(process.env.SEARCH_UNIVERSE_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return 1_800;
  return Math.max(500, Math.min(5_000, Math.trunc(configured)));
}

function toKrUniverseEntries(rows: unknown): CatalogEntry[] {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row: any) => {
      const ticker = cleanTicker(row.ticker ?? row.code ?? row.symbol);
      const name = String(row.name ?? row.companyName ?? ticker);
      if (!ticker) return null;

      return createEntry(
        ticker,
        name,
        'KR' as Market,
        'KRW' as Currency,
        [name],
      );
    })
    .filter((entry): entry is CatalogEntry => Boolean(entry));
}

async function loadKrUniverseEntries(): Promise<CatalogEntry[]> {
  const entries = toKrUniverseEntries(await getKrUniverse());
  if (entries.length > 0) {
    krUniverseLastGood.set('KR', entries);
  }
  return entries;
}

async function buildKrUniverseEntries(): Promise<KrUniverseResult> {
  const pending = krUniverseFlights.run('KR', loadKrUniverseEntries);

  try {
    const entries = await withTimeout(
      pending,
      krUniverseTimeoutMs(),
      'KR search universe',
    );
    if (entries.length > 0) {
      return { entries, partial: false };
    }

    const cached = krUniverseLastGood.get('KR', KR_UNIVERSE_LAST_GOOD_MS);
    return {
      entries: cached?.value ?? [],
      partial: true,
      warning: cached
        ? 'KR_UNIVERSE_EMPTY_LAST_GOOD'
        : 'KR_UNIVERSE_EMPTY_CATALOG_FALLBACK',
    };
  } catch (error) {
    const cached = krUniverseLastGood.get('KR', KR_UNIVERSE_LAST_GOOD_MS);
    const reason =
      error instanceof OperationTimeoutError
        ? 'KR_UNIVERSE_TIMEOUT'
        : 'KR_UNIVERSE_PROVIDER_ERROR';
    return {
      entries: cached?.value ?? [],
      partial: true,
      warning: `${reason}_${cached ? 'LAST_GOOD' : 'CATALOG_FALLBACK'}`,
    };
  }
}

function aliasCatalogEntries(): CatalogEntry[] {
  return Object.values(EXTRA_ALIASES).map((value) =>
    createEntry(
      value.ticker,
      value.name,
      value.market,
      value.currency,
      value.aliases,
    ),
  );
}

function searchCatalogEntries(
  query: string,
  limit: number,
  extras: CatalogEntry[] = [],
): SearchResult[] {
  const entries = dedupeEntries([
    ...catalogArray(),
    ...aliasCatalogEntries(),
    ...extras,
  ]);

  for (const entry of entries) {
    try {
      registerDynamicEntry(entry);
    } catch {
      // Dynamic registration is optional.
    }
  }

  return entries
    .map((entry) => ({ entry, score: searchScore(entry, query) }))
    .filter((item) => (query ? item.score > 0 : true))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String((a.entry as any).ticker).localeCompare(
        String((b.entry as any).ticker),
      );
    })
    .slice(0, limit)
    .map((item) => toSearchResult(item.entry));
}

function shouldLoadKrUniverse(query: string): boolean {
  const compact = query.replace(/\s+/g, '');
  return /[가-힣]/u.test(compact) || /^\d{2,6}$/.test(compact);
}

export class MarketDataService {
  static searchLocal(q: string, limit = 80): SearchResult[] {
    const query = String(q ?? '').trim();
    return searchCatalogEntries(query, limit);
  }

  static async searchWithMeta(
    q: string,
    limit = 80,
  ): Promise<MarketSearchResult> {
    const query = String(q ?? '').trim();
    if (query.length < 2 || !shouldLoadKrUniverse(query)) {
      return {
        results: searchCatalogEntries(query, limit),
        partial: false,
        warnings: [],
      };
    }

    const universe = await buildKrUniverseEntries();
    return {
      results: searchCatalogEntries(query, limit, universe.entries),
      partial: universe.partial,
      warnings: universe.warning ? [universe.warning] : [],
    };
  }

  static async search(
    q: string,
    limit = 80,
  ): Promise<SearchResult[]> {
    return (await this.searchWithMeta(q, limit)).results;
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

        if (!providerQuote) {
          throw new Error(`QUOTE_UNAVAILABLE:${cleanTicker(ticker)}`);
        }

        const quote = providerQuote;

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
      return null;
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
    const meta = await MarketDataService.getCandlesMeta(ticker, timeframe);
    return meta.candles;
  }

  /**
   * 캔들과 함께 실제 데이터 공급자 이름과 조회 시각을 반환합니다.
   * 디스크 캐시에서 읽은 경우 캐시에 기록된 공급자와 저장 시각을 사용합니다.
   */
  static async getCandlesMeta(
    ticker: string,
    timeframe: Timeframe =
      '1D' as Timeframe,
  ): Promise<{ candles: Candle[]; provider: string; fetchedAt: string }> {
    const entry =
      resolveEntry(
        ticker,
      );
    const timeframeText = String(timeframe);
    // v3: 잘못된 시간 프레임 매핑으로 저장된 메모리·디스크 캐시와 분리합니다.
    const cacheKey = `candles:${CANDLE_CACHE_VERSION}:${cleanTicker(ticker)}:${timeframeText}`;
    const disk = await readCandleDiskCache(ticker, timeframeText);

    if (disk?.fresh) {
      return {
        candles: disk.candles,
        provider: disk.provider,
        fetchedAt: new Date(disk.savedAt).toISOString(),
      };
    }

    const aggregateDays = DAILY_AGGREGATE_SIZES[timeframeText];

    if (!disk && aggregateDays) {
      const dailyDisk = await readCandleDiskCache(ticker, '1D');
      if (dailyDisk?.candles.length) {
        const aggregated = aggregateCachedCandles(dailyDisk.candles, aggregateDays);
        await writeCandleDiskCache(ticker, timeframeText, aggregated, dailyDisk.provider);
        return {
          candles: aggregated,
          provider: dailyDisk.provider,
          fetchedAt: new Date(dailyDisk.savedAt).toISOString(),
        };
      }
    }

    const load = async () => {
      const result = await tryCandlesProvider(entry, timeframe);
      await writeCandleDiskCache(ticker, timeframeText, result.candles, result.provider);
      return result;
    };

    if (disk?.candles.length) {
      void cached(cacheKey, candleCacheTtl(timeframeText), load).catch((error) => {
        console.error('chart background refresh failed:', error);
      });
      return {
        candles: disk.candles,
        provider: disk.provider,
        fetchedAt: new Date(disk.savedAt).toISOString(),
      };
    }

    const result = await cached(cacheKey, candleCacheTtl(timeframeText), load);
    // 방어: 혹시 구버전 캐시(Candle[])가 남아 있으면 감싸서 반환한다.
    if (Array.isArray(result)) {
      return {
        candles: result as Candle[],
        provider: 'unknown',
        fetchedAt: new Date().toISOString(),
      };
    }
    return {
      candles: result.candles,
      provider: result.provider,
      fetchedAt: new Date().toISOString(),
    };
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

        ...(await buildKrUniverseEntries()).entries,
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

import type { CatalogEntry } from '../data/catalog';
import type { Candle, Quote } from '../sample/types';

type YahooChartQuote = {
  open?: Array<number | null>;
  high?: Array<number | null>;
  low?: Array<number | null>;
  close?: Array<number | null>;
  volume?: Array<number | null>;
};

type YahooChartResult = {
  meta?: {
    symbol?: string;
    currency?: string;
    regularMarketPrice?: number;
    previousClose?: number;
    chartPreviousClose?: number;
  };
  timestamp?: number[];
  indicators?: {
    quote?: YahooChartQuote[];
  };
};

export interface YahooIndexQuote {
  price: number;
  changeAmount: number;
  changePercent: number;
  spark: number[];
  updatedAt: string;
}

function cleanTicker(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function safeNumber(value: unknown, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[,\s$%]/g, ''));

    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function isKrTicker(ticker: string) {
  return /^\d{6}$/.test(ticker);
}

function getTickerFromEntry(entryOrTicker: CatalogEntry | string) {
  if (typeof entryOrTicker === 'string') return cleanTicker(entryOrTicker);

  return cleanTicker((entryOrTicker as any).ticker);
}

function getNameFromEntry(entryOrTicker: CatalogEntry | string, fallback: string) {
  if (typeof entryOrTicker === 'string') return fallback;

  return String((entryOrTicker as any).name ?? fallback);
}

function yahooSymbol(ticker: string) {
  const clean = cleanTicker(ticker);

  if (isKrTicker(clean)) return `${clean}.KS`;

  return clean;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      accept: 'application/json,text/plain,*/*',
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`YAHOO_CHART_HTTP_${res.status}`);
  }

  return (await res.json()) as T;
}

async function fetchYahooChart(
  symbol: string,
  params?: { range: string; interval: string },
): Promise<YahooChartResult> {
  const encoded = encodeURIComponent(symbol);

  const query = params
    ? [
        params.range
          ? `range=${params.range}&interval=${params.interval}`
          : `period1=0&period2=9999999999&interval=${params.interval}`,
      ]
    : ['range=5d&interval=1d', 'range=1mo&interval=1d'];

  const urls = query.flatMap((q) => [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?${q}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?${q}`,
  ]);

  const errors: string[] = [];

  for (const url of urls) {
    try {
      const data = await fetchJson<any>(url);
      const result = data?.chart?.result?.[0];

      if (result?.indicators?.quote?.[0]) {
        return result as YahooChartResult;
      }

      errors.push(`EMPTY_RESULT:${url}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`YAHOO_PROVIDER_MARKER_20260711_FAILED:${symbol}:${errors.join('|')}`);
}

function lastValidIndex(values: Array<number | null | undefined>) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];

    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return index;
    }
  }

  return -1;
}

export async function getQuote(
  entryOrTicker: CatalogEntry | string,
): Promise<Partial<Quote>> {
  const ticker = getTickerFromEntry(entryOrTicker);
  const symbol = yahooSymbol(ticker);
  const result = await fetchYahooChart(symbol);
  const quote = result.indicators?.quote?.[0];

  if (!quote?.close?.length) {
    throw new Error(`YAHOO_PROVIDER_MARKER_20260711_NO_CLOSE:${symbol}`);
  }

  const index = lastValidIndex(quote.close);

  if (index < 0) {
    throw new Error(`YAHOO_PROVIDER_MARKER_20260711_NO_VALID_PRICE:${symbol}`);
  }

  const price =
    safeNumber(result.meta?.regularMarketPrice) ||
    safeNumber(quote.close[index]);

  if (!price) {
    throw new Error(`YAHOO_PROVIDER_MARKER_20260711_ZERO_PRICE:${symbol}`);
  }

  let previousClose =
    safeNumber(result.meta?.previousClose) ||
    safeNumber(result.meta?.chartPreviousClose);

  if (!previousClose) {
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = safeNumber(quote.close[i]);

      if (candidate > 0) {
        previousClose = candidate;
        break;
      }
    }
  }

  if (!previousClose) previousClose = price;

  const changeAmount = price - previousClose;
  const changePercent = previousClose ? (changeAmount / previousClose) * 100 : 0;
  const volume = safeNumber(quote.volume?.[index]);
  const tradingValue = price * volume;

  return {
    ticker,
    symbol,
    name: getNameFromEntry(entryOrTicker, ticker),
    price,
    currentPrice: price,
    regularMarketPrice: price,
    close: price,
    previousClose,
    prevClose: previousClose,
    change: changeAmount,
    changeAmount,
    changePercent,
    regularMarketChangePercent: changePercent,
    volume,
    tradingValue,
    open: safeNumber(quote.open?.[index]),
    high: safeNumber(quote.high?.[index]),
    low: safeNumber(quote.low?.[index]),
    updatedAt: new Date().toISOString(),
  } as Partial<Quote>;
}

export const quote = getQuote;

interface YahooChartParams {
  range: string;
  interval: string;
  aggregateSize?: number;
  aggregatePeriod?: 'day' | 'year';
}

// 시간프레임별 야후 차트 range/interval 매핑 (차트용 장기 데이터).
function chartParams(tf?: string): YahooChartParams {
  // 주의: range=max는 야후가 굵은 버킷(약 168개)으로 뭉개서 반환한다.
  // period1/period2 명시가 전체 이력을 올바른 간격으로 준다.
  switch (String(tf ?? '1D')) {
    case '1m':
      return { range: '7d', interval: '1m' };
    case '3m':
      return { range: '7d', interval: '1m', aggregateSize: 3, aggregatePeriod: 'day' };
    case '5m':
      return { range: '1mo', interval: '5m' };
    case '15m':
      return { range: '2mo', interval: '15m' };
    case '30m':
      return { range: '2mo', interval: '30m' };
    case '60m':
    case '1H':
      return { range: '2y', interval: '1h' };
    case '4H':
      return { range: '2y', interval: '1h', aggregateSize: 4, aggregatePeriod: 'day' };
    case '8H':
      return { range: '2y', interval: '1h', aggregateSize: 8 };
    case '12H':
      return { range: '2y', interval: '1h', aggregateSize: 12 };
    case '1D':
      return { range: '10y', interval: '1d' };
    case '3D':
      return { range: '10y', interval: '1d', aggregateSize: 3 };
    case '5D':
      return { range: '10y', interval: '1d', aggregateSize: 5 };
    case '15D':
      return { range: '10y', interval: '1d', aggregateSize: 15 };
    case '10D':
      return { range: '10y', interval: '1d', aggregateSize: 10 };
    case '20D':
      return { range: '10y', interval: '1d', aggregateSize: 20 };
    case '1W':
      return { range: '', interval: '1wk' };
    case '1M':
      return { range: '', interval: '1mo' };
    case '3M':
      return { range: '', interval: '1mo', aggregateSize: 3 };
    case '6M':
      return { range: '', interval: '1mo', aggregateSize: 6 };
    case '1Y':
      return { range: '', interval: '1mo', aggregateSize: 12, aggregatePeriod: 'year' };
    case 'ALL':
      return { range: '', interval: '1d' };
    default:
      return { range: '10y', interval: '1d' };
  }
}

function candleTimeValue(value: Candle['time']): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function aggregateCandles(
  rows: Candle[],
  size: number,
  period?: 'day' | 'year',
): Candle[] {
  const sortedRows = [...rows].sort(
    (a, b) => candleTimeValue(a.time) - candleTimeValue(b.time),
  );

  if (size <= 1 || sortedRows.length <= 1) return sortedRows;

  const groups = period
    ? [...sortedRows.reduce((map, row) => {
        const date = new Date(candleTimeValue(row.time));
        const key = period === 'year'
          ? String(date.getUTCFullYear())
          : date.toISOString().slice(0, 10);
        const group = map.get(key) ?? [];
        group.push(row);
        map.set(key, group);
        return map;
      }, new Map<string, Candle[]>()).values()]
    : [sortedRows];
  const result: Candle[] = [];

  for (const group of groups) {
    for (let index = 0; index < group.length; index += size) {
      const chunk = group.slice(index, index + size);
      if (chunk.length === 0) continue;

      result.push({
        time: chunk[0].time,
        open: chunk[0].open,
        high: Math.max(...chunk.map((item) => item.high)),
        low: Math.min(...chunk.map((item) => item.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((sum, item) => sum + item.volume, 0),
      });
    }
  }

  return result;
}

export async function getCandles(
  entryOrTicker: CatalogEntry | string,
  timeframe?: string,
): Promise<Candle[]> {
  const ticker = getTickerFromEntry(entryOrTicker);
  const symbol = yahooSymbol(ticker);
  const params = chartParams(timeframe);
  const result = await fetchYahooChart(symbol, params);
  const quote = result.indicators?.quote?.[0];

  if (!result.timestamp?.length || !quote) return [];

  const rows = result.timestamp
    .map((timestamp, index) => {
      const close = safeNumber(quote.close?.[index]);
      const open = safeNumber(quote.open?.[index], close);
      const high = safeNumber(quote.high?.[index], close);
      const low = safeNumber(quote.low?.[index], close);

      return {
        time: new Date(timestamp * 1000).toISOString(),
        open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close,
        volume: safeNumber(quote.volume?.[index]),
      } as Candle;
    })
    .filter((candle) => candle.close > 0);

  return aggregateCandles(
    rows,
    params.aggregateSize ?? 1,
    params.aggregatePeriod,
  );
}

export const candles = getCandles;

export async function getIndexQuote(symbol: string): Promise<YahooIndexQuote> {
  const clean = cleanTicker(symbol);
  const result = await fetchYahooChart(clean);
  const quote = result.indicators?.quote?.[0];

  if (!quote?.close?.length) {
    throw new Error(`YAHOO_INDEX_NO_CLOSE:${clean}`);
  }

  const index = lastValidIndex(quote.close);
  if (index < 0) {
    throw new Error(`YAHOO_INDEX_NO_VALID_PRICE:${clean}`);
  }

  const price =
    safeNumber(result.meta?.regularMarketPrice) || safeNumber(quote.close[index]);
  let previousClose =
    safeNumber(result.meta?.previousClose) ||
    safeNumber(result.meta?.chartPreviousClose);

  if (!previousClose) {
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = safeNumber(quote.close[i]);
      if (candidate > 0) {
        previousClose = candidate;
        break;
      }
    }
  }

  if (!price || !previousClose) {
    throw new Error(`YAHOO_INDEX_INCOMPLETE:${clean}`);
  }

  const changeAmount = price - previousClose;
  return {
    price,
    changeAmount,
    changePercent: (changeAmount / previousClose) * 100,
    spark: quote.close
      .map((value) => safeNumber(value))
      .filter((value) => value > 0),
    updatedAt: new Date().toISOString(),
  };
}

export async function getCompanyProfile(
  entryOrTicker: CatalogEntry | string,
): Promise<any> {
  const ticker = getTickerFromEntry(entryOrTicker);

  return {
    ticker,
    name: getNameFromEntry(entryOrTicker, ticker),
    market: isKrTicker(ticker) ? 'KR' : 'US',
    currency: isKrTicker(ticker) ? 'KRW' : 'USD',
    description: `${getNameFromEntry(entryOrTicker, ticker)} 기업 정보입니다.`,
    sector: '',
    industry: '',
    website: '',
  };
}

export const companyProfile = getCompanyProfile;

// Fetch the Yahoo `assetProfile.sector` for a US ticker (best-effort, single
// call). Returns the raw English sector string (e.g. "Technology") or null when
// unavailable. Never throws.
export async function getYahooSector(ticker: string): Promise<string | null> {
  const clean = cleanTicker(ticker);
  if (!clean || isKrTicker(clean)) return null;

  const encoded = encodeURIComponent(clean);
  const urls = [
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=assetProfile`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=assetProfile`,
  ];

  for (const url of urls) {
    try {
      const data = await fetchJson<any>(url);
      const sector = data?.quoteSummary?.result?.[0]?.assetProfile?.sector;
      const value = String(sector ?? '').trim();
      if (value) return value;
    } catch {
      // best-effort — try next host / give up silently
    }
  }

  return null;
}

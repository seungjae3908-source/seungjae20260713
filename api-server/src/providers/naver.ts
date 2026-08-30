import type { CatalogEntry } from '../data/catalog';
import type { Candle, Quote } from '../sample/types';
import { parseFinancialAmount } from './financial-evidence';
import { requireMarketNumber, requireSourceTime } from './market-evidence';

type NaverChartItem = {
  localDate?: string;
  closePrice?: number | string;
  openPrice?: number | string;
  highPrice?: number | string;
  lowPrice?: number | string;
  accumulatedTradingVolume?: number | string;
};

function cleanTicker(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function onlyDigits(value: string) {
  return value.replace(/\D/g, '');
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

function dateToIso(localDate: string) {
  if (!/^\d{8}$/.test(localDate)) throw new Error('NAVER_CANDLE_DATE_INVALID');

  const yyyy = localDate.slice(0, 4);
  const mm = localDate.slice(4, 6);
  const dd = localDate.slice(6, 8);

  const time = requireSourceTime(`${yyyy}-${mm}-${dd}T00:00:00+09:00`);
  if (!time.updatedAt) throw new Error('NAVER_CANDLE_DATE_MISSING');
  return time.updatedAt;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      referer: 'https://finance.naver.com/',
    },
  });

  if (!res.ok) {
    throw new Error(`NAVER_HTTP_${res.status}`);
  }

  return (await res.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      referer: 'https://finance.naver.com/',
    },
  });

  if (!res.ok) {
    throw new Error(`NAVER_HTML_HTTP_${res.status}`);
  }

  return await res.text();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseNaverPollQuote(input: unknown, code: string) {
  const item = record(input);
  const identity = item.itemCode ?? item.symbolCode;
  if (identity !== code || (item.symbolCode != null && item.symbolCode !== code)
    || (record(item.currencyType).code != null && record(item.currencyType).code !== 'KRW')) {
    throw new Error('NAVER_IDENTITY_MISMATCH:' + code);
  }
  const price = requireMarketNumber(item.closePriceRaw ?? item.closePrice, 'naver.price', Number.MIN_VALUE);
  const changeAmount = requireMarketNumber(item.compareToPreviousClosePriceRaw ?? item.compareToPreviousClosePrice, 'naver.changeAmount');
  const changePercent = requireMarketNumber(item.fluctuationsRatioRaw ?? item.fluctuationsRatio, 'naver.changePercent');
  const previousClose = requireMarketNumber(item.previousClosePrice ?? price - changeAmount, 'naver.previousClose', Number.MIN_VALUE);
  return {
    ticker: code, name: typeof item.stockName === 'string' ? item.stockName : code,
    price, currentPrice: price, regularMarketPrice: price, close: price,
    previousClose, prevClose: previousClose, change: changeAmount, changeAmount,
    changePercent, regularMarketChangePercent: changePercent,
    volume: requireMarketNumber(item.accumulatedTradingVolumeRaw ?? item.accumulatedTradingVolume, 'naver.volume', 0),
    // The formatted field contains Korean magnitude units. Only the provider's
    // raw KRW field proves turnover; do not replace it with last-price * volume.
    tradingValue: requireMarketNumber(item.accumulatedTradingValueRaw, 'naver.tradingValue', 0),
    tradingValueSource: 'PROVIDER_REPORTED' as const,
    open: requireMarketNumber(item.openPriceRaw ?? item.openPrice, 'naver.open', Number.MIN_VALUE),
    high: requireMarketNumber(item.highPriceRaw ?? item.highPrice, 'naver.high', Number.MIN_VALUE),
    low: requireMarketNumber(item.lowPriceRaw ?? item.lowPrice, 'naver.low', Number.MIN_VALUE),
    ...requireSourceTime(item.localTradedAt), source: 'naver' as const,
  };
}

export async function getQuote(entryOrTicker: CatalogEntry | string): Promise<Partial<Quote>> {
  const ticker = getTickerFromEntry(entryOrTicker);
  const code = onlyDigits(ticker);
  if (!isKrTicker(ticker)) throw new Error('NAVER_ONLY_SUPPORTS_KR_TICKER:' + ticker);
  const urls = [
    'https://polling.finance.naver.com/api/realtime/domestic/stock/' + code,
    'https://api.stock.naver.com/stock/' + code + '/basic',
  ];
  const failures: string[] = [];
  for (const url of urls) {
    try {
      const data = record(await fetchJson<unknown>(url));
      const items = data.datas;
      const item = Array.isArray(items) ? items[0] : data;
      return parseNaverPollQuote(item, code);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'NAVER_RESPONSE_INVALID');
    }
  }
  // Yahoo remains the service-level fallback. Loose HTML number extraction can
  // interpret dates/links as prices and therefore is not quote evidence.
  throw new Error('NAVER_QUOTE_UNAVAILABLE:' + code + ':' + failures.join('|'));
}

export const quote = getQuote;

export async function getCandles(
  entryOrTicker: CatalogEntry | string,
): Promise<Candle[]> {
  const ticker = getTickerFromEntry(entryOrTicker);
  const code = onlyDigits(ticker);

  if (!isKrTicker(code)) {
    throw new Error(`NAVER_ONLY_SUPPORTS_KR_TICKER:${ticker}`);
  }

  const now = new Date();
  const endDate = now.toISOString().slice(0, 10).replace(/-/g, '');
  const start = new Date(now);
  start.setDate(start.getDate() - 180);
  const startDate = start.toISOString().slice(0, 10).replace(/-/g, '');

  const url = `https://api.stock.naver.com/chart/domestic/item/${code}/day?startDateTime=${startDate}&endDateTime=${endDate}`;

  const data = await fetchJson<any>(url);
  const rows: NaverChartItem[] = Array.isArray(data) ? data : data?.data ?? [];

  return rows
    .map((row) => {
      const time = dateToIso(String(row.localDate ?? ''));

      return {
        time,
        open: requireMarketNumber(row.openPrice, 'naver.candle.open', Number.MIN_VALUE),
        high: requireMarketNumber(row.highPrice, 'naver.candle.high', Number.MIN_VALUE),
        low: requireMarketNumber(row.lowPrice, 'naver.candle.low', Number.MIN_VALUE),
        close: requireMarketNumber(row.closePrice, 'naver.candle.close', Number.MIN_VALUE),
        volume: requireMarketNumber(row.accumulatedTradingVolume, 'naver.candle.volume', 0),
      } as Candle;
    })
    .filter((candle) => candle.close > 0);
}

export const candles = getCandles;

export async function getCompanyProfile(
  entryOrTicker: CatalogEntry | string,
): Promise<any> {
  const ticker = getTickerFromEntry(entryOrTicker);
  const code = onlyDigits(ticker);
  const name = getNameFromEntry(entryOrTicker, code);

  return {
    ticker: code,
    name,
    market: 'KR',
    currency: 'KRW',
    description: `${name} 기업 정보입니다.`,
    sector: '',
    industry: '',
    website: '',
  };
}

export const companyProfile = getCompanyProfile;
export interface NaverRatios {
  eps: number;
  per: number;
  pbr: number;
  bps: number | null;
}

export function parseNaverRatios(html: string): NaverRatios {
  const value = (key: 'eps' | 'per' | 'pbr' | 'bps'): number => {
    const matches = [...html.matchAll(new RegExp(`<em\\b[^>]*\\bid=["']_${key}["'][^>]*>([^<]*)</em>`, 'gi'))];
    // Only the exact provider field is evidence. Nearby dates, links and other
    // ratio values must never become a substitute for a missing field.
    return parseFinancialAmount(matches.length === 1 ? matches[0][1] : undefined, 'naver', key);
  };
  return {
    eps: value('eps'), per: value('per'), pbr: value('pbr'),
    bps: /\bid=["']_bps["']/.test(html) ? value('bps') : null,
  };
}

export async function getRatios(
  entryOrTicker: CatalogEntry | string,
): Promise<NaverRatios> {
  const ticker = getTickerFromEntry(entryOrTicker);
  const code = onlyDigits(ticker);

  if (!isKrTicker(code)) {
    throw new Error(`NAVER_ONLY_SUPPORTS_KR_TICKER:${ticker}`);
  }

  const html = await fetchText(`https://finance.naver.com/item/main.naver?code=${code}`);
  return parseNaverRatios(html);
}

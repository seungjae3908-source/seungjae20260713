import type { CatalogEntry } from '../data/catalog';
import type { Candle, Quote } from '../sample/types';

type NaverPollItem = {
  cd?: string;
  nm?: string;
  nv?: number | string;
  cv?: number | string;
  cr?: number | string;
  aq?: number | string;
  aa?: number | string;
  hv?: number | string;
  lv?: number | string;
  ov?: number | string;
  pcv?: number | string;
};

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

function safeNumber(value: unknown, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[,\s%원]/g, ''));

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

function dateToIso(localDate: string) {
  if (!/^\d{8}$/.test(localDate)) return new Date().toISOString();

  const yyyy = localDate.slice(0, 4);
  const mm = localDate.slice(4, 6);
  const dd = localDate.slice(6, 8);

  return new Date(`${yyyy}-${mm}-${dd}T00:00:00+09:00`).toISOString();
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

function stripHtml(value: string) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumberNear(label: string, html: string) {
  const index = html.indexOf(label);

  if (index < 0) return 0;

  const sliced = html.slice(index, index + 1500);
  const match = sliced.match(/[-+]?\d[\d,]*(?:\.\d+)?%?/);

  return safeNumber(match?.[0]);
}

function parseByClass(className: string, html: string) {
  const regex = new RegExp(
    `<[^>]+class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    'i',
  );

  const match = html.match(regex);

  if (!match?.[1]) return '';

  return stripHtml(match[1]);
}

function parseNameFromHtml(html: string, fallback: string) {
  const nameByWrap = html.match(/<div\s+class=["']wrap_company["'][\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/i);

  if (nameByWrap?.[1]) {
    const parsed = stripHtml(nameByWrap[1]);

    if (parsed) return parsed;
  }

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  if (title?.[1]) {
    const parsed = stripHtml(title[1])
      .replace(/: 네이버페이 증권.*/g, '')
      .replace(/종목분석.*/g, '')
      .trim();

    if (parsed) return parsed;
  }

  return fallback;
}

function parseNaverHtmlQuote(code: string, html: string, fallbackName: string): Partial<Quote> {
  const noToday = parseByClass('no_today', html);
  const price = safeNumber(noToday) || parseNumberNear('현재가', html);

  const previousClose = parseNumberNear('전일', html) || parseNumberNear('전일가', html);
  const open = parseNumberNear('시가', html);
  const high = parseNumberNear('고가', html);
  const low = parseNumberNear('저가', html);
  const volume = parseNumberNear('거래량', html);
  const tradingValue = parseNumberNear('거래대금', html) * 1_000_000;

  let changeAmount = 0;
  let changePercent = 0;

  const rateMatch =
    html.match(/rate_info[\s\S]*?([-+]?\d+(?:\.\d+)?)\s*%/i) ??
    html.match(/전일대비[\s\S]*?([-+]?\d+(?:\.\d+)?)\s*%/i);

  if (rateMatch?.[1]) {
    changePercent = safeNumber(rateMatch[1]);
  }

  if (previousClose > 0 && price > 0) {
    changeAmount = price - previousClose;

    if (!changePercent) {
      changePercent = (changeAmount / previousClose) * 100;
    }
  }

  return {
    ticker: code,
    name: parseNameFromHtml(html, fallbackName),
    price,
    currentPrice: price,
    regularMarketPrice: price,
    close: price,
    previousClose: previousClose || price - changeAmount,
    prevClose: previousClose || price - changeAmount,
    change: changeAmount,
    changeAmount,
    changePercent,
    regularMarketChangePercent: changePercent,
    volume,
    tradingValue: tradingValue || price * volume,
    open,
    high,
    low,
    updatedAt: new Date().toISOString(),
  } as Partial<Quote>;
}

async function fetchNaverPoll(code: string): Promise<NaverPollItem | null> {
  const cleanCode = onlyDigits(code);

  if (!isKrTicker(cleanCode)) return null;

  const urls = [
    `https://polling.finance.naver.com/api/realtime/domestic/stock/${cleanCode}`,
    `https://api.stock.naver.com/stock/${cleanCode}/basic`,
  ];

  for (const url of urls) {
    try {
      const data = await fetchJson<any>(url);

      const item =
        data?.datas?.[0] ??
        data?.areas?.[0]?.datas?.[0] ??
        data?.result?.areas?.[0]?.datas?.[0] ??
        data?.result?.datas?.[0] ??
        data;

      if (!item) continue;

      return {
        cd: cleanCode,
        nm: item.nm ?? item.stockName ?? item.name,
        nv: item.nv ?? item.closePrice ?? item.nowPrice,
        cv: item.cv ?? item.compareToPreviousClosePrice ?? item.changePrice,
        cr: item.cr ?? item.fluctuationsRatio ?? item.changeRate,
        aq: item.aq ?? item.accumulatedTradingVolume,
        aa: item.aa ?? item.accumulatedTradingValue,
        hv: item.hv ?? item.highPrice,
        lv: item.lv ?? item.lowPrice,
        ov: item.ov ?? item.openPrice,
        pcv: item.pcv ?? item.previousClosePrice,
      };
    } catch {
      // try next
    }
  }

  return null;
}

export async function getQuote(
  entryOrTicker: CatalogEntry | string,
): Promise<Partial<Quote>> {
  const ticker = getTickerFromEntry(entryOrTicker);
  const code = onlyDigits(ticker);
  const fallbackName = getNameFromEntry(entryOrTicker, code);

  if (!isKrTicker(code)) {
    throw new Error(`NAVER_ONLY_SUPPORTS_KR_TICKER:${ticker}`);
  }

  const item = await fetchNaverPoll(code);

  if (item) {
    const price = safeNumber(item.nv);

    if (price > 0) {
      const changeAmount = safeNumber(item.cv);
      const changePercent = safeNumber(item.cr);
      const previousClose =
        safeNumber(item.pcv) || (changePercent === -100 ? price : price - changeAmount);
      const volume = safeNumber(item.aq);
      const tradingValue = safeNumber(item.aa) || price * volume;

      return {
        ticker: code,
        name: String(item.nm ?? fallbackName),
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
        open: safeNumber(item.ov),
        high: safeNumber(item.hv),
        low: safeNumber(item.lv),
        updatedAt: new Date().toISOString(),
      } as Partial<Quote>;
    }
  }

  const html = await fetchText(`https://finance.naver.com/item/main.naver?code=${code}`);
  const parsed = parseNaverHtmlQuote(code, html, fallbackName);

  if (!safeNumber((parsed as any).price)) {
    throw new Error(`NAVER_PRICE_PARSE_FAILED:${code}`);
  }

  return parsed;
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
        open: safeNumber(row.openPrice),
        high: safeNumber(row.highPrice),
        low: safeNumber(row.lowPrice),
        close: safeNumber(row.closePrice),
        volume: safeNumber(row.accumulatedTradingVolume),
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
  bps: number;
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
  const eps = parseNumberNear('EPS', html);
  const per = parseNumberNear('PER', html);
  const pbr = parseNumberNear('PBR', html);
  const bps = parseNumberNear('BPS', html);

  if (![eps, per, pbr, bps].some((value) => Number.isFinite(value) && value !== 0)) {
    throw new Error(`NAVER_RATIO_PARSE_FAILED:${code}`);
  }

  return { eps, per, pbr, bps };
}

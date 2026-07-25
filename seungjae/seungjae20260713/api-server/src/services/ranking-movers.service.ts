import { cached, TTL } from '../lib/cache';
import { computeScores } from '../sample/scores';
import { scoreToRating } from '../sample/rating';
import { classifyAssetType, type AssetType } from '../data/asset-type';
import { getKiwoomRankings, isKiwoomConfigured, type KiwoomRankingRow } from '../providers/kiwoom';
import type {
  MarketKey,
  MarketListings,
} from './market-listing.service';
import type { QuoteRow } from './market-data.service';

type NaverMarketCode = 'KOSPI' | 'KOSDAQ' | 'ETF' | 'ETN';

interface NaverRankingResponse {
  totalCount?: number;
  stocks?: NaverStockRow[];
}

interface NaverStockRow {
  itemCode?: string;
  stockName?: string;
  closePrice?: string | number;
  fluctuationsRatio?: string | number;
  accumulatedTradingVolume?: string | number;
  marketValue?: string | number;
}

interface YahooScreenerResponse {
  finance?: {
    result?: {
      quotes?: YahooQuoteRow[];
    }[];
  };
}

interface YahooQuoteRow {
  symbol?: string;
  shortName?: string;
  longName?: string;
  quoteType?: string;
  exchange?: string;
  fullExchangeName?: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
}

const MAX = 100;
const NAVER_PAGE_SIZE = 100;
const NAVER_MAX_PAGES = 80;
const YAHOO_COUNT = 250;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
  }

  return (await res.json()) as T;
}

function num(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  const text = String(value ?? '')
    .replace(/,/g, '')
    .replace(/%/g, '')
    .replace(/\+/g, '')
    .replace(/−/g, '-')
    .replace(/▲/g, '')
    .replace(/▼/g, '-')
    .trim();

  const n = Number(text);

  return Number.isFinite(n) ? n : 0;
}

function ratingFor(ticker: string) {
  const { overall } = computeScores(ticker);

  return scoreToRating(overall);
}

function reasonFor(
  row: QuoteRow,
  kind: 'popular' | 'gainer' | 'loser' | 'reco',
): string {
  const pct = row.changePercent;

  const move =
    pct >= 3
      ? `급상승 +${pct.toFixed(2)}%`
      : pct > 0
        ? `상승 +${pct.toFixed(2)}%`
        : pct <= -3
          ? `급하락 ${pct.toFixed(2)}%`
          : pct < 0
            ? `하락 ${pct.toFixed(2)}%`
            : '보합권';

  if (kind === 'gainer') return `${move} · 키움/시장 랭킹 기반`;
  if (kind === 'loser') return `${move} · 키움/시장 랭킹 기반`;
  if (kind === 'reco') return `${move} · AI 점수 ${row.rating.score}점`;

  return `${move} · 변동성 상위`;
}

function withReason(
  rows: QuoteRow[],
  kind: 'popular' | 'gainer' | 'loser' | 'reco',
): QuoteRow[] {
  return rows.map((row) => ({
    ...row,
    reason: reasonFor(row, kind),
  }));
}

function uniqueRows(rows: QuoteRow[]): QuoteRow[] {
  const seen = new Set<string>();
  const out: QuoteRow[] = [];

  for (const row of rows) {
    const key = `${row.market}:${row.ticker.toUpperCase()}`;

    if (seen.has(key)) continue;

    seen.add(key);
    out.push(row);
  }

  return out;
}

function buildListings(market: MarketKey, rows: QuoteRow[]): MarketListings {
  const unique = uniqueRows(rows);

  const gainersBase = [...unique]
    .filter((row) => row.changePercent > 0)
    .sort((a, b) => b.changePercent - a.changePercent)
    .slice(0, MAX);

  const losersBase = [...unique]
    .filter((row) => row.changePercent < 0)
    .sort((a, b) => a.changePercent - b.changePercent)
    .slice(0, MAX);

  const popularValue = (row: QuoteRow): number => {
    const tv = row.tradingValue ?? 0;
    if (tv > 0) return tv;

    const vol = row.volume ?? 0;
    if (vol > 0) return vol * (row.price || 1);

    // No volume/trading-value data available — fall back to variability so the
    // list still surfaces the most active-looking names rather than an empty set.
    return Math.abs(row.changePercent);
  };

  const popularBase = [...unique]
    .sort((a, b) => popularValue(b) - popularValue(a))
    .slice(0, MAX);

  const recommendedBase = [...unique]
    .sort((a, b) => b.rating.score - a.rating.score)
    .slice(0, MAX);

  return {
    market,
    popular: withReason(popularBase, 'popular'),
    gainers: withReason(gainersBase, 'gainer'),
    losers: withReason(losersBase, 'loser'),
    recommended: withReason(recommendedBase, 'reco'),
  };
}

function domesticMarketsFor(market: MarketKey): NaverMarketCode[] {
  if (market === 'KRX') return ['KOSPI', 'KOSDAQ'];
  if (market === 'KOSPI') return ['KOSPI'];
  if (market === 'KOSDAQ') return ['KOSDAQ'];
  if (market === 'KR_ETF') return ['ETF'];
  if (market === 'KR_ETN') return ['ETN'];

  return [];
}

function naverRowToQuote(row: NaverStockRow, exchange: string): QuoteRow | null {
  const ticker = String(row.itemCode ?? '').trim();
  const name = String(row.stockName ?? '').trim();

  if (!ticker || !name) return null;

  const price = num(row.closePrice);
  const changePercent = num(row.fluctuationsRatio);

  if (!price) return null;

  const assetType = classifyAssetType(name, 'KR');
  const volume = num(row.accumulatedTradingVolume);
  const tradingValue = num(row.marketValue) || volume * price;

  return {
    ticker,
    name,
    market: 'KR',
    currency: 'KRW',
    assetType,
    price,
    changeAmount: 0,
    changePercent,
    updatedAt: new Date().toISOString(),
    rating: ratingFor(ticker),
    exchange,
    volume,
    tradingValue,
  };
}

async function getNaverDomesticRankingRows(
  market: MarketKey,
): Promise<QuoteRow[]> {
  const markets = domesticMarketsFor(market);

  if (!markets.length) return [];

  const allRows: QuoteRow[] = [];

  for (const naverMarket of markets) {
    let page = 1;
    let totalCount = Number.POSITIVE_INFINITY;

    while ((page - 1) * NAVER_PAGE_SIZE < totalCount && page <= NAVER_MAX_PAGES) {
      const url = `https://m.stock.naver.com/api/stocks/marketValue/${naverMarket}?page=${page}&pageSize=${NAVER_PAGE_SIZE}`;

      try {
        const json = await fetchJson<NaverRankingResponse>(url);
        const stocks = Array.isArray(json.stocks) ? json.stocks : [];

        totalCount = Number(json.totalCount ?? stocks.length);

        for (const stock of stocks) {
          const quote = naverRowToQuote(stock, naverMarket);

          if (quote) {
            allRows.push(quote);
          }
        }

        if (!stocks.length) break;

        page += 1;
      } catch (error) {
        console.error(
          '[ranking-movers] naver ranking failed:',
          naverMarket,
          page,
          error,
        );
        break;
      }
    }
  }

  return allRows;
}

function normalizeYahooExchange(
  exchange?: string,
): 'NASDAQ' | 'NYSE' | 'AMEX' | 'US' {
  const v = String(exchange ?? '').toUpperCase();

  if (
    v === 'NMS' ||
    v === 'NGM' ||
    v === 'NCM' ||
    v === 'NAS' ||
    v === 'NASDAQ'
  ) {
    return 'NASDAQ';
  }

  if (v === 'NYQ' || v === 'NYSE') {
    return 'NYSE';
  }

  if (v === 'ASE' || v === 'AMEX' || v === 'PCX' || v === 'ARCX') {
    return 'AMEX';
  }

  return 'US';
}

function detectUsAssetType(row: YahooQuoteRow): AssetType {
  const quoteType = String(row.quoteType ?? '').toUpperCase();
  const name = `${row.shortName ?? ''} ${row.longName ?? ''}`.toLowerCase();

  if (quoteType === 'ETF' || name.includes(' etf') || name.includes('fund')) {
    if (name.includes('2x') || name.includes('3x') || name.includes('bull')) {
      return 'LEVERAGED_ETF';
    }

    if (
      name.includes('inverse') ||
      name.includes('short') ||
      name.includes('bear')
    ) {
      return 'INVERSE_ETF';
    }

    return 'ETF';
  }

  if (name.includes(' etn')) return 'ETN';
  if (name.includes('reit')) return 'REIT';
  if (name.includes(' adr')) return 'ADR';

  return 'STOCK';
}

function yahooRowToQuote(row: YahooQuoteRow): QuoteRow | null {
  const ticker = String(row.symbol ?? '').trim().toUpperCase();
  const name = String(row.shortName || row.longName || ticker).trim();

  if (!ticker || !name) return null;
  if (ticker.includes('.') || ticker.includes('/') || ticker.includes(' ')) {
    return null;
  }

  const price = Number(row.regularMarketPrice ?? 0);
  const changePercent = Number(row.regularMarketChangePercent ?? 0);

  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(changePercent)) return null;

  const assetType = detectUsAssetType(row);
  const volume = Number.isFinite(row.regularMarketVolume)
    ? Number(row.regularMarketVolume)
    : 0;
  const tradingValue = volume * price;

  return {
    ticker,
    name,
    market: 'US',
    currency: 'USD',
    assetType,
    price,
    changeAmount: 0,
    changePercent,
    updatedAt: new Date().toISOString(),
    rating: ratingFor(ticker),
    exchange: normalizeYahooExchange(row.exchange),
    volume,
    tradingValue,
  };
}

function includeUsRow(row: QuoteRow, market: MarketKey): boolean {
  if (market === 'NASDAQ') {
    return row.exchange === 'NASDAQ' && row.assetType !== 'ETF' && row.assetType !== 'ETN';
  }

  if (market === 'NYSE') {
    return row.exchange === 'NYSE' && row.assetType !== 'ETF' && row.assetType !== 'ETN';
  }

  if (market === 'AMEX') {
    return row.exchange === 'AMEX' && row.assetType !== 'ETF' && row.assetType !== 'ETN';
  }

  if (market === 'US_ETF') {
    return (
      row.assetType === 'ETF' ||
      row.assetType === 'LEVERAGED_ETF' ||
      row.assetType === 'INVERSE_ETF'
    );
  }

  if (market === 'US_ETN') {
    return (
      row.assetType === 'ETN' ||
      row.assetType === 'LEVERAGED_ETN' ||
      row.assetType === 'INVERSE_ETN'
    );
  }

  return false;
}

// Yahoo's query1/query2 hosts intermittently rate-limit or 5xx. Retry across
// both hosts with a short backoff before giving up on a screener.
const YAHOO_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchYahooScreener(scrId: string): Promise<QuoteRow[]> {
  const suffix =
    `/v1/finance/screener/predefined/saved` +
    `?scrIds=${encodeURIComponent(scrId)}` +
    `&count=${YAHOO_COUNT}` +
    `&start=0` +
    `&lang=en-US` +
    `&region=US`;

  let lastError: unknown = null;

  for (let attempt = 0; attempt < YAHOO_HOSTS.length * 2; attempt += 1) {
    const host = YAHOO_HOSTS[attempt % YAHOO_HOSTS.length];

    try {
      const json = await fetchJson<YahooScreenerResponse>(`${host}${suffix}`);
      const quotes = json.finance?.result?.[0]?.quotes ?? [];

      return quotes
        .map(yahooRowToQuote)
        .filter((row): row is QuoteRow => row !== null);
    } catch (error) {
      lastError = error;
      await sleep(250 * (attempt + 1));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`yahoo screener ${scrId} failed`);
}

// Screener ids chosen for the broadest mover coverage. Stocks/ETFs are pulled
// from the same wide lists and then narrowed per market by includeUsRow().
const YAHOO_STOCK_SCREENERS = [
  'day_gainers',
  'day_losers',
  'most_actives',
  'small_cap_gainers',
];

const YAHOO_ETF_SCREENERS = [
  'day_gainers',
  'day_losers',
  'most_actives',
  'portfolio_anchors',
];

async function getYahooUsRankingRows(market: MarketKey): Promise<QuoteRow[]> {
  const isEtf = market === 'US_ETF' || market === 'US_ETN';
  const screeners = isEtf ? YAHOO_ETF_SCREENERS : YAHOO_STOCK_SCREENERS;

  const settled = await Promise.allSettled(
    screeners.map((scrId) => fetchYahooScreener(scrId)),
  );

  const rows: QuoteRow[] = [];

  settled.forEach((result: PromiseSettledResult<QuoteRow[]>, i: number) => {
    if (result.status === 'fulfilled') {
      rows.push(...result.value);
    } else {
      console.error(
        '[ranking-movers] yahoo screener failed:',
        screeners[i],
        result.reason,
      );
    }
  });

  return uniqueRows(rows).filter((row) => includeUsRow(row, market));
}

function kiwoomAssetTypeForName(name: string, market: 'KR' | 'US'): AssetType {
  return classifyAssetType(name, market);
}

function kiwoomRowsToQuotes(rows: KiwoomRankingRow[]): QuoteRow[] {
  return rows
    .filter((row) => row.price != null && row.changePercent != null)
    .map((row) => ({
      ticker: row.ticker,
      name: row.name,
      market: row.market,
      currency: row.currency,
      assetType: kiwoomAssetTypeForName(row.name, row.market),
      price: Number(row.price),
      changeAmount: 0,
      changePercent: Number(row.changePercent),
      volume: Number(row.volume ?? 0),
      tradingValue: Number(row.tradingValue ?? 0),
      updatedAt: new Date().toISOString(),
      rating: ratingFor(row.ticker),
      reason: row.reason,
      rank: row.rank,
    }));
}

async function getKiwoomDomesticRows(market: MarketKey): Promise<QuoteRow[]> {
  if (!isKiwoomConfigured()) return [];

  // The Kiwoom ranking endpoint returns the full domestic universe.
  // KOSPI/KOSDAQ-specific lists continue through the market-specific Naver source.
  if (market !== 'KRX') return [];

  try {
    const [upRows, downRows] = await Promise.all([
      getKiwoomRankings('KR', 'gainers', MAX),
      getKiwoomRankings('KR', 'losers', MAX),
    ]);
    const quotes = kiwoomRowsToQuotes([...upRows, ...downRows]);
    console.log('[ranking-movers] kiwoom domestic:', market, quotes.length);
    return quotes;
  } catch (error) {
    console.error('[ranking-movers] kiwoom domestic failed:', market, error);
    return [];
  }
}

// Which upstream produced the rows we returned. Surfaced in the
// /api/market/movers?debug=1 response.
//   kiwoom         = 국내 키움 REST (ka10027 전일대비등락률상위)
//   naver-fallback = 국내, 키움 0건/실패 시 네이버
//   yahoo          = 해외(미국) 정식 소스 (키움 REST는 해외 미지원)
export type MoverSource = 'kiwoom' | 'naver-fallback' | 'yahoo' | 'empty';

// Human-readable ranking basis for each list, surfaced to the UI so users know
// how each column is ordered. Identical for KR and US markets because the sort
// keys below are identical: popular=tradingValue, gainers/losers=changePercent,
// recommended=rating.score. (US data comes from Yahoo, never Kiwoom.)
export interface RankingSource {
  popular: string;
  gainers: string;
  losers: string;
  recommended: string;
}

export const RANKING_SOURCE: RankingSource = {
  popular: '거래대금 기준',
  gainers: '등락률 기준',
  losers: '등락률 기준',
  recommended: 'AI 점수 기준',
};

export interface RankedListings {
  listings: MarketListings;
  source: MoverSource;
  rankingSource: RankingSource;
}

async function getDomesticRankingRows(
  market: MarketKey,
): Promise<{ rows: QuoteRow[]; source: MoverSource }> {
  const kiwoomRows = await getKiwoomDomesticRows(market);

  if (kiwoomRows.length > 0) {
    return { rows: kiwoomRows, source: 'kiwoom' };
  }

  console.warn('[ranking-movers] domestic fallback to naver:', market);

  return {
    rows: await getNaverDomesticRankingRows(market),
    source: 'naver-fallback',
  };
}

// Kiwoom's public REST API does not provide overseas (US) ranking data, so
// Yahoo Finance is the official source for US movers.
async function getUsRankingRows(
  market: MarketKey,
): Promise<{ rows: QuoteRow[]; source: MoverSource }> {
  const rows = await getYahooUsRankingRows(market);

  return { rows, source: 'yahoo' };
}

async function getMarketListings(market: MarketKey): Promise<RankedListings> {
  return cached(`ranking-movers:kiwoom:v5:${market}`, TTL.quote, async () => {
    const isDomestic =
      market === 'KRX' ||
      market === 'KOSPI' ||
      market === 'KOSDAQ' ||
      market === 'KR_ETF' ||
      market === 'KR_ETN';

    const isUs =
      market === 'NASDAQ' ||
      market === 'NYSE' ||
      market === 'AMEX' ||
      market === 'US_ETF' ||
      market === 'US_ETN';

    let rows: QuoteRow[] = [];
    let source: MoverSource = 'empty';

    if (isDomestic) {
      const result = await getDomesticRankingRows(market);
      rows = result.rows;
      source = result.rows.length > 0 ? result.source : 'empty';
    } else if (isUs) {
      const result = await getUsRankingRows(market);
      rows = result.rows;
      source = result.rows.length > 0 ? result.source : 'empty';
    }

    console.log(
      '[ranking-movers] final market:',
      market,
      'rows:',
      rows.length,
      'source:',
      source,
    );

    return {
      listings: buildListings(market, rows),
      source,
      rankingSource: RANKING_SOURCE,
    };
  });
}

async function healthCheck() {
  return {
    configured: isKiwoomConfigured(),
    token: null,
    baseUrl: process.env.KIWOOM_BASE_URL ?? 'https://api.kiwoom.com',
    message: isKiwoomConfigured()
      ? '키움 환경변수가 설정되어 있습니다. 실제 토큰 상태는 /api/kiwoom/status에서 확인합니다.'
      : '키움 App Key 또는 App Secret이 설정되지 않았습니다.',
  };
}

export const RankingMoversService = {
  getMarketListings,
  healthCheck,
};
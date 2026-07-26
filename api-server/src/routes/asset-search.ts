import { Router, type IRouter } from 'express';
import { MarketDataService } from '../services/market-data.service';

const router: IRouter = Router();
type Market = 'ALL' | 'KR' | 'US';
type Row = {
  ticker: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  assetType?: string;
  exchange?: string;
  aliases?: string[];
};

function marketOf(value: unknown): Market {
  const text = String(value ?? 'ALL').toUpperCase();
  return text === 'KR' || text === 'US' ? text : 'ALL';
}

function norm(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()［］\[\]{}·.,_\-]/g, '');
}

function score(row: Row, query: string): number {
  const q = norm(query);
  const ticker = norm(row.ticker);
  const name = norm(row.name);
  const aliases = (row.aliases ?? []).map(norm);
  if (!q) return 1;
  if (ticker === q) return 1000;
  if (name === q) return 950;
  if (aliases.some((value) => value === q)) return 900;
  if (ticker.startsWith(q)) return 820;
  if (name.startsWith(q)) return 760;
  if (aliases.some((value) => value.startsWith(q))) return 720;
  if (ticker.includes(q)) return 620;
  if (name.includes(q)) return 580;
  if (aliases.some((value) => value.includes(q))) return 540;
  return 0;
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'User-Agent': 'Mozilla/5.0 Chrome/120 seungjae-stock-app/1.0',
      },
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function naverSearch(query: string): Promise<Row[]> {
  try {
    const data = await fetchJson(
      `https://ac.stock.naver.com/ac?q=${encodeURIComponent(query)}&target=stock`,
    );
    const items = Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.result?.items)
        ? data.result.items
        : Array.isArray(data?.stocks)
          ? data.stocks
          : [];
    return items
      .map((item: any): Row | null => {
        const ticker = String(
          item.code ?? item.stockCode ?? item.localCode ?? item.symbol ?? '',
        )
          .replace(/\D/g, '')
          .slice(-6);
        const name = String(
          item.name ?? item.stockName ?? item.koreanName ?? item.label ?? '',
        ).trim();
        if (!/^\d{6}$/.test(ticker) || !name) return null;
        const exchange = String(
          item.typeCode ?? item.typeName ?? item.market ?? item.exchange ?? '',
        ).toUpperCase();
        return {
          ticker,
          name,
          market: 'KR',
          currency: 'KRW',
          assetType: exchange.includes('ETF')
            ? 'ETF'
            : exchange.includes('ETN')
              ? 'ETN'
              : 'STOCK',
          exchange: exchange.includes('KOSDAQ') ? 'KOSDAQ' : 'KOSPI',
          aliases: [],
        };
      })
      .filter((row: Row | null): row is Row => Boolean(row));
  } catch {
    return [];
  }
}

async function yahooSearch(query: string): Promise<Row[]> {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  for (const host of hosts) {
    try {
      const data = await fetchJson(
        `https://${host}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=80&newsCount=0&listsCount=0&enableFuzzyQuery=true`,
      );
      const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
      const rows = quotes
        .map((item: any): Row | null => {
          const quoteType = String(item.quoteType ?? '').toUpperCase();
          if (quoteType !== 'EQUITY' && quoteType !== 'ETF') return null;
          const exchange = String(
            item.exchange ?? item.exchDisp ?? item.fullExchangeName ?? '',
          ).toUpperCase();
          const region = String(item.region ?? '').toUpperCase();
          const ticker = String(item.symbol ?? '')
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9.\-]/g, '')
            .slice(0, 24);
          const us =
            region === 'US' ||
            /NASDAQ|NYSE|AMEX|NMS|NYQ|NCM|NGM|ASE|PCX|BTS/.test(exchange);
          if (!ticker || !us || /\.(KS|KQ)$/.test(ticker)) return null;
          const name = String(
            item.longname ?? item.shortname ?? item.name ?? ticker,
          ).trim();
          return {
            ticker,
            name: name || ticker,
            market: 'US',
            currency: 'USD',
            assetType: quoteType === 'ETF' ? 'ETF' : 'STOCK',
            exchange: String(item.exchDisp ?? item.exchange ?? ''),
            aliases: [item.shortname, item.longname]
              .map((value) => String(value ?? '').trim())
              .filter(Boolean),
          };
        })
        .filter((row: Row | null): row is Row => Boolean(row));
      if (rows.length) return rows;
    } catch {
      // 다음 Yahoo 호스트를 시도한다.
    }
  }
  return [];
}

function dedupe(rows: Row[], query: string, market: Market): Row[] {
  const map = new Map<string, Row>();
  for (const row of rows) {
    if (market !== 'ALL' && row.market !== market) continue;
    const key = `${row.market}:${row.ticker}`;
    const previous = map.get(key);
    map.set(key, {
      ...previous,
      ...row,
      aliases: Array.from(
        new Set([...(previous?.aliases ?? []), ...(row.aliases ?? [])]),
      ),
    });
  }
  return [...map.values()]
    .map((row) => ({ row, score: score(row, query) }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.row.name.localeCompare(right.row.name, 'ko'),
    )
    .map((item) => item.row);
}

async function quoteRow(row: Row): Promise<Record<string, unknown>> {
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), 3500),
  );
  const quote = await Promise.race([
    MarketDataService.getQuoteRow(row.ticker),
    timeout,
  ]).catch(() => null);
  return quote
    ? { ...quote, ...row, name: row.name || quote.name }
    : {
        ...row,
        price: null,
        changeAmount: null,
        changePercent: null,
        volume: null,
        tradingValue: null,
        marketCap: null,
        rating: null,
        updatedAt: null,
      };
}

router.get('/search/quotes', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const market = marketOf(req.query.market);
  const limit = Math.max(
    1,
    Math.min(50, Math.trunc(Number(req.query.limit ?? 30)) || 30),
  );
  if (!q) return res.json({ q, market, results: [], count: 0 });

  try {
    const [catalog, kr, us] = await Promise.allSettled([
      MarketDataService.search(q, 120),
      market === 'US' ? Promise.resolve([]) : naverSearch(q),
      market === 'KR' ? Promise.resolve([]) : yahooSearch(q),
    ]);
    const catalogRows: Row[] =
      catalog.status === 'fulfilled'
        ? catalog.value.map((row: any) => ({
            ticker: String(row.ticker ?? '').trim().toUpperCase(),
            name: String(row.name ?? row.ticker ?? '').trim(),
            market: String(row.market).toUpperCase() === 'US' ? 'US' : 'KR',
            currency:
              String(row.market).toUpperCase() === 'US' ? 'USD' : 'KRW',
            assetType: String(row.assetType ?? 'STOCK'),
            exchange: String(row.exchange ?? ''),
            aliases: Array.isArray(row.aliases)
              ? row.aliases.map((value: unknown) => String(value))
              : [],
          }))
        : [];
    const rows = dedupe(
      [
        ...catalogRows,
        ...(kr.status === 'fulfilled' ? kr.value : []),
        ...(us.status === 'fulfilled' ? us.value : []),
      ],
      q,
      market,
    ).slice(0, limit);
    const results = await Promise.all(rows.map(quoteRow));
    return res.json({ q, market, results, count: results.length });
  } catch (error) {
    console.error('unified stock search error:', error);
    return res.status(502).json({
      q,
      market,
      results: [],
      count: 0,
      error: 'ASSET_SEARCH_UNAVAILABLE',
    });
  }
});

export default router;

import { Router, type IRouter } from 'express';
import { MarketDataService, type QuoteRow } from '../services/market-data.service';
import {
  MarketListingService,
  type MarketKey,
} from '../services/market-listing.service';
import { ThemesService } from '../services/themes.service';

const router: IRouter = Router();

type MarketScope = 'ALL' | 'KR' | 'US';

function normalizeMarket(value: unknown): MarketScope {
  const raw = String(value ?? 'ALL').toUpperCase();
  if (raw === 'KR') return 'KR';
  if (raw === 'US') return 'US';
  return 'ALL';
}

function normalizeTicker(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function uniqueTickers(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeTicker).filter(Boolean)));
}

function uniqueRows(rows: QuoteRow[]): QuoteRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.market}:${row.ticker}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Number.isFinite(row.price) && row.price > 0;
  });
}

function rankByTradingValue(rows: QuoteRow[]): QuoteRow[] {
  return [...rows].sort(
    (a, b) => Number(b.tradingValue ?? 0) - Number(a.tradingValue ?? 0),
  );
}

function rankByVolume(rows: QuoteRow[]): QuoteRow[] {
  return [...rows].sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0));
}

function rankByChange(rows: QuoteRow[], direction: 'asc' | 'desc'): QuoteRow[] {
  return [...rows].sort((a, b) =>
    direction === 'desc'
      ? Number(b.changePercent ?? 0) - Number(a.changePercent ?? 0)
      : Number(a.changePercent ?? 0) - Number(b.changePercent ?? 0),
  );
}

function rankByScore(rows: QuoteRow[]): QuoteRow[] {
  return [...rows].sort(
    (a, b) => Number(b.rating?.score ?? 0) - Number(a.rating?.score ?? 0),
  );
}

function marketKeys(scope: MarketScope): MarketKey[] {
  if (scope === 'KR') return ['KRX'];
  if (scope === 'US') return ['NASDAQ', 'NYSE'];
  return ['KRX', 'NASDAQ', 'NYSE'];
}

async function liveListings(scope: MarketScope): Promise<QuoteRow[]> {
  const settled = await Promise.allSettled(
    marketKeys(scope).map((market) => MarketListingService.getMarketListings(market)),
  );
  const rows: QuoteRow[] = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    rows.push(
      ...result.value.popular,
      ...result.value.gainers,
      ...result.value.losers,
      ...result.value.recommended,
    );
  }
  return uniqueRows(rows);
}

router.get('/config', (_req, res) => {
  res.json({
    ok: true,
    service: 'seungjae-stock-api',
    time: new Date().toISOString(),
    providers: {
      kiwoom: Boolean(process.env.KIWOOM_APP_KEY && process.env.KIWOOM_APP_SECRET),
      naver: true,
      yahoo: true,
      upbit: Boolean(process.env.UPBIT_ACCESS_KEY && process.env.UPBIT_SECRET_KEY),
      bitget: Boolean(
        process.env.BITGET_API_KEY &&
          process.env.BITGET_SECRET_KEY &&
          process.env.BITGET_PASSPHRASE,
      ),
    },
  });
});

router.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  try {
    const results = await MarketDataService.search(q, q ? 100 : 500);
    return res.json({ q, results, count: results.length, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('market search error:', error);
    return res.status(502).json({ q, results: [], count: 0, error: 'SEARCH_PROVIDER_ERROR' });
  }
});

router.get('/search/quotes', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  try {
    const matches = await MarketDataService.search(q, 100);
    const quotes = await MarketDataService.getQuotes(matches.map((item) => item.ticker));
    const rows = uniqueRows(quotes);
    return res.json({ q, results: rows, count: rows.length, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('market quote search error:', error);
    return res.status(502).json({ q, results: [], count: 0, error: 'QUOTE_SEARCH_PROVIDER_ERROR' });
  }
});

router.get('/quotes', async (req, res) => {
  const raw =
    req.query.tickers ?? req.query.symbols ?? req.query.symbol ?? req.query.ticker ?? '';
  const tickers = uniqueTickers(String(raw).split(','));
  const quotes = await MarketDataService.getQuotes(tickers);
  return res.json({
    quotes: uniqueRows(quotes),
    requested: tickers.length,
    available: quotes.length,
    updatedAt: new Date().toISOString(),
  });
});

router.get('/market/movers', async (req, res) => {
  const scope = normalizeMarket(req.query.market);
  try {
    const rows = await liveListings(scope);
    if (!rows.length) {
      return res.status(503).json({
        market: scope,
        popular: [],
        volume: [],
        recommended: [],
        gainers: [],
        losers: [],
        risky: [],
        error: 'MARKET_DATA_UNAVAILABLE',
        updatedAt: new Date().toISOString(),
      });
    }

    const popular = rankByTradingValue(rows).slice(0, 30);
    const volume = rankByVolume(rows).slice(0, 30);
    const gainers = rankByChange(rows, 'desc').slice(0, 30);
    const losers = rankByChange(rows, 'asc').slice(0, 30);
    const recommended = rankByScore(rows).slice(0, 30);

    return res.json({
      market: scope,
      provider: 'live-market-providers',
      popular,
      volume,
      recommended,
      gainers,
      losers,
      risky: losers,
      rankingSource: {
        popular: '실제 거래대금 기준',
        gainers: '실제 등락률 기준',
        losers: '실제 등락률 기준',
        recommended: '실제 데이터 기반 종합점수 기준',
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('market movers error:', error);
    return res.status(502).json({
      market: scope,
      popular: [],
      volume: [],
      recommended: [],
      gainers: [],
      losers: [],
      risky: [],
      error: 'MARKET_MOVERS_PROVIDER_ERROR',
    });
  }
});

router.get('/market/home', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const rows = await MarketListingService.getMarketSummary();
    const indices = rows
      .filter((row) => ['kospi', 'kosdaq', 'nasdaq'].includes(row.key) && row.ok)
      .map((row) => ({
        key: row.key.toUpperCase(),
        label: row.label,
        value: row.price,
        price: row.price,
        changeAmount: null,
        changePercent: row.changePercent,
        direction: row.changePercent > 0 ? 'up' : row.changePercent < 0 ? 'down' : 'flat',
        spark: row.spark,
        provider: 'Yahoo Finance',
        updatedAt: new Date().toISOString(),
      }));
    return res.status(indices.length ? 200 : 503).json({
      ok: indices.length > 0,
      indices,
      sectorBriefings: [],
      updatedAt: new Date().toISOString(),
      ...(!indices.length ? { message: '실시간 지수 제공기관의 응답이 지연되고 있습니다.' } : {}),
    });
  } catch (error) {
    console.error('market home error:', error);
    return res.status(502).json({ ok: false, indices: [], sectorBriefings: [], error: 'INDEX_PROVIDER_ERROR' });
  }
});

router.get('/market/summary', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const items = await MarketListingService.getMarketSummary();
    const available = items.filter((item) => item.ok);
    return res.status(available.length ? 200 : 503).json({
      items,
      ok: available.length > 0,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('market summary error:', error);
    return res.status(502).json({ ok: false, items: [], error: 'SUMMARY_PROVIDER_ERROR' });
  }
});

router.get('/market/briefing', async (_req, res) => {
  try {
    const briefing = await MarketListingService.getBriefing();
    return res.json(briefing);
  } catch (error) {
    console.error('market briefing error:', error);
    return res.status(502).json({
      asOf: new Date().toISOString(),
      mood: 'neutral',
      headline: '실제 시장 브리핑 데이터를 불러오지 못했습니다.',
      lines: [],
      strongSectors: [],
      weakSectors: [],
      positiveNews: [],
      negativeNews: [],
      disclosureRisks: [],
      gainers: [],
      losers: [],
      picks: [],
      error: 'BRIEFING_PROVIDER_ERROR',
    });
  }
});

router.get('/market/themes', async (req, res) => {
  const market = String(req.query.market ?? 'KR').toUpperCase() === 'US' ? 'US' : 'KR';
  try {
    return res.json(await ThemesService.getThemes(market));
  } catch (error) {
    console.error('market themes route error:', error);
    return res.status(502).json({ market, themes: [], error: 'MARKET_THEMES_PROVIDER_ERROR' });
  }
});

router.get('/market/scan', async (req, res) => {
  const scope = normalizeMarket(req.query.market);
  try {
    const rows = rankByScore(await liveListings(scope)).slice(0, 100);
    return res.status(rows.length ? 200 : 503).json({
      market: scope,
      results: rows,
      cards: rows,
      updatedAt: new Date().toISOString(),
      ...(!rows.length ? { error: 'SCAN_DATA_UNAVAILABLE' } : {}),
    });
  } catch (error) {
    console.error('market scan error:', error);
    return res.status(502).json({ market: scope, results: [], cards: [], error: 'SCAN_PROVIDER_ERROR' });
  }
});

router.get('/market/alerts', async (req, res) => {
  const scope = normalizeMarket(req.query.market);
  try {
    const rows = rankByChange(await liveListings(scope), 'desc').slice(0, 20);
    const alerts = rows.map((row, index) => ({
      id: `${row.market}:${row.ticker}:movement`,
      ticker: row.ticker,
      name: row.name,
      market: row.market,
      kind: Number(row.changePercent ?? 0) >= 0 ? 'positive' : 'negative',
      category: '시세 변동',
      title: `${row.name} ${Number(row.changePercent ?? 0) >= 0 ? '상승' : '하락'} ${Math.abs(Number(row.changePercent ?? 0)).toFixed(2)}%`,
      importance: index < 5 ? 'high' : index < 12 ? 'medium' : 'low',
      time: row.updatedAt,
      url: null,
    }));
    return res.json({ market: scope, positive: alerts.filter((item) => item.kind === 'positive'), negative: alerts.filter((item) => item.kind === 'negative'), alerts, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('market alerts error:', error);
    return res.status(502).json({ market: scope, positive: [], negative: [], alerts: [], error: 'ALERT_PROVIDER_ERROR' });
  }
});

router.get('/market/undervalued', async (req, res) => {
  const raw = String(req.query.market ?? 'KRX').toUpperCase();
  const market: MarketKey = raw === 'US' ? 'NASDAQ' : raw === 'KR' ? 'KRX' : (raw as MarketKey);
  try {
    return res.json(await MarketListingService.getUndervalued(market));
  } catch (error) {
    console.error('market undervalued error:', error);
    return res.status(502).json({ market, cards: [], error: 'UNDERVALUED_PROVIDER_ERROR' });
  }
});

export default router;

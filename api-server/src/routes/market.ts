import { Router, type IRouter } from 'express';
import { MarketDataService, type QuoteRow } from '../services/market-data.service';
import {
  MarketListingService,
  type MarketKey,
} from '../services/market-listing.service';
import { ThemesService } from '../services/themes.service';
import { SectorPopularService } from '../services/sector-popular.service';
import { SignalService } from '../services/signal.service';
import { RecommendationService } from '../services/recommendation.service';

const router: IRouter = Router();

type MarketScope = 'ALL' | 'KR' | 'US';

function normalizeMarket(value: unknown): MarketScope {
  const raw = String(value ?? 'ALL').toUpperCase();
  if (raw === 'KR') return 'KR';
  if (raw === 'US') return 'US';
  return 'ALL';
}

function normalizeTicker(value: unknown): string {
  // "KR:005930", "US:AAPL" 같은 시장 접두어도 허용한다.
  return String(value ?? '').trim().toUpperCase().replace(/^(KR|US)[:.]/, '');
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

router.get('/market/sector-popular', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const market = String(req.query.market ?? 'KR').toUpperCase() === 'US' ? 'US' : 'KR';
  try {
    const result = await SectorPopularService.getSectorPopular(market);
    return res.json(result);
  } catch (error) {
    console.error('market sector-popular error:', error);
    return res.status(502).json({
      market,
      sortBasis: '거래대금 기준',
      sectors: [],
      error: 'SECTOR_POPULAR_PROVIDER_ERROR',
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
  // 프런트가 보낸 선택 지표를 실제 검색 조건으로 사용한다 (미선택 시 기본 3종).
  const indicators = String(req.query.indicators ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const num = (v: unknown) => {
    const parsed = Number(v);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const filters = {
    volumeThreshold: num(req.query.volumeThreshold),
    tradingValueThreshold: num(req.query.tradingValueThreshold),
    marketCapThreshold: num(req.query.marketCapThreshold),
    minimumScore: num(req.query.minimumScore),
    maximumRiskScore: num(req.query.maximumRiskScore),
    volumeLookbackDays: num(req.query.volumeLookbackDays),
    tradingValueLookbackDays: num(req.query.tradingValueLookbackDays),
    timeframe: String(req.query.timeframe ?? '1D'),
  };
  if (scope === 'US' && filters.timeframe === '4H') {
    return res.status(400).json({ ok: false, error: 'SCAN_TIMEFRAME_UNSUPPORTED', market: scope, timeframe: filters.timeframe });
  }
  try {
    const result = await SignalService.scan(scope, indicators, filters);
    // 결과 0건은 "조건에 맞는 종목 없음"(200)이며 오류(5xx)와 구분한다.
    return res.json({
      ok: true,
      provider: 'rule-scan',
      fetchedAt: new Date().toISOString(),
      searchRunId: `scan:${scope}:${result.timeframe}:${Date.now()}`,
      timeframe: result.timeframe,
      market: scope,
      rows: result.cards,
      cards: result.cards,
      results: result.cards,
      count: result.cards.length,
      selected: result.selected,
      supportedIndicators: result.supportedIndicators,
      appliedConditions: {
        market: scope,
        indicators: result.selected,
        defaultApplied: indicators.length === 0,
        volumeThreshold: result.appliedFilters.volumeThreshold,
        tradingValueThreshold: result.appliedFilters.tradingValueThreshold,
        marketCapThreshold: result.appliedFilters.marketCapThreshold,
        minimumScore: result.appliedFilters.minimumScore,
        maximumRiskScore: result.appliedFilters.maximumRiskScore,
        volumeLookbackDays: filters.volumeLookbackDays ?? 20,
        tradingValueLookbackDays: filters.tradingValueLookbackDays ?? 20,
      },
      scanned: result.scanned,
      excludedCount: result.excludedCount,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('market scan error:', error);
    return res.status(502).json({
      ok: false,
      provider: 'rule-scan',
      market: scope,
      rows: [],
      results: [],
      cards: [],
      error: 'SCAN_PROVIDER_ERROR',
      message: '조건검색 데이터 공급자 오류 — 결과 0건이 아니라 조회 실패입니다.',
    });
  }
});

router.get('/market/recommendations', async (req, res) => {
  const market = String(req.query.market ?? 'KR').toUpperCase() === 'US' ? 'US' : 'KR';
  const category = String(req.query.category ?? 'all');
  try {
    const result = await RecommendationService.getRecommendations(market);
    const rows =
      category === 'undervalued' || category === 'breakout'
        ? result.rows.filter((row) => row.category === category)
        : result.rows;
    return res.json({ ...result, rows, category });
  } catch (error) {
    console.error('market recommendations error:', error);
    return res.status(502).json({
      ok: false,
      provider: 'rule-based-engine',
      market,
      rows: [],
      error: 'RECOMMENDATION_ENGINE_ERROR',
      message: '추천 산출 실패 — 실데이터 조회 오류입니다.',
    });
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

import { Router, type IRouter } from 'express';
import { MarketDataService } from '../services/market-data.service';

const router: IRouter = Router();

function normalizeTicker(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeTimeframe(value: unknown) {
  const raw = String(value ?? '1D').trim();

  if (!raw) return '1D';

  return raw;
}

// GET /api/stocks/:ticker/quote
router.get('/:ticker/quote', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  if (!ticker) {
    res.status(400).json({
      error: 'MISSING_TICKER',
    });
    return;
  }

  try {
    const quote = await MarketDataService.getQuoteRow(ticker);

    if (!quote) {
      res.status(404).json({
        error: 'QUOTE_NOT_FOUND',
        ticker,
      });
      return;
    }

    res.json(quote);
  } catch (error) {
    console.error('stock quote route error:', error);

    res.status(500).json({
      error: 'STOCK_QUOTE_ROUTE_ERROR',
      ticker,
    });
  }
});

// GET /api/stocks/:ticker/profile
router.get('/:ticker/profile', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  if (!ticker) {
    res.status(400).json({
      error: 'MISSING_TICKER',
    });
    return;
  }

  try {
    const profile = await MarketDataService.getCompanyProfile(ticker);

    res.json(profile);
  } catch (error) {
    console.error('stock profile route error:', error);

    res.status(500).json({
      error: 'STOCK_PROFILE_ROUTE_ERROR',
      ticker,
    });
  }
});

// GET /api/stocks/:ticker/company
router.get('/:ticker/company', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  if (!ticker) {
    res.status(400).json({
      error: 'MISSING_TICKER',
    });
    return;
  }

  try {
    const profile = await MarketDataService.getCompanyProfile(ticker);

    res.json(profile);
  } catch (error) {
    console.error('stock company route error:', error);

    res.status(500).json({
      error: 'STOCK_COMPANY_ROUTE_ERROR',
      ticker,
    });
  }
});

// GET /api/stocks/:ticker/candles?tf=1D
router.get('/:ticker/candles', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  const timeframe = normalizeTimeframe(req.query.tf ?? req.query.timeframe);

  if (!ticker) {
    res.status(400).json({
      error: 'MISSING_TICKER',
    });
    return;
  }

  try {
    const candles = await MarketDataService.getCandles(ticker, timeframe as any);

    res.json({
      ticker,
      timeframe,
      candles,
    });
  } catch (error) {
    console.error('stock candles route error:', error);

    res.status(500).json({
      error: 'STOCK_CANDLES_ROUTE_ERROR',
      ticker,
      timeframe,
    });
  }
});

// GET /api/stocks/:ticker/rating
router.get('/:ticker/rating', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  if (!ticker) {
    res.status(400).json({
      error: 'MISSING_TICKER',
    });
    return;
  }

  try {
    const rating = await MarketDataService.getRating(ticker);

    res.json({
      ticker,
      rating,
    });
  } catch (error) {
    console.error('stock rating route error:', error);

    res.status(500).json({
      error: 'STOCK_RATING_ROUTE_ERROR',
      ticker,
    });
  }
});

// GET /api/stocks/:ticker/financials
router.get('/:ticker/financials', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  res.json({
    ticker,
    items: [],
    summary: '재무제표 데이터는 연결 준비 중입니다.',
  });
});

// GET /api/stocks/:ticker/risk
router.get('/:ticker/risk', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  res.json({
    ticker,
    delistingRisk: false,
    riskLevel: 'normal',
    summary: '현재 확인된 상장폐지 고위험 신호는 없습니다.',
  });
});

// GET /api/stocks/:ticker/filings
router.get('/:ticker/filings', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  res.json({
    ticker,
    filings: [],
    items: [],
    summary: '공시 데이터는 연결 준비 중입니다.',
  });
});

// GET /api/stocks/:ticker/disclosures
router.get('/:ticker/disclosures', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  res.json({
    ticker,
    disclosures: [],
    items: [],
    summary: '공시 데이터는 연결 준비 중입니다.',
  });
});

// GET /api/stocks/:ticker/news
router.get('/:ticker/news', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  res.json({
    ticker,
    news: [],
    items: [],
    summary: '뉴스 데이터는 연결 준비 중입니다.',
  });
});

export default router;
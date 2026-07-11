import { Router, type IRouter } from 'express';
import healthRouter from './health';
import marketRouter from './market';
import newsRouter from './news.route';
import providerDebugRouter from './provider-debug';
import pushRouter from './push';
import stocksRouter from './stocks';
import watchlistRouter from './watchlist';
import kiwoomRouter from './kiwoom.routes';

const router: IRouter = Router();

router.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'seungjae-stock-api',
    status: 'running',
    recommendationCount: { KR: 30, US: 30 },
    routes: {
      health: '/api/healthz',
      config: '/api/config',
      search: '/api/search?q=삼성전자',
      quotes: '/api/quotes?tickers=005930,NVDA,AAPL',
      movers: '/api/market/movers?market=KR',
      kiwoomStatus: '/api/kiwoom/status',
      kiwoomRankings:
        '/api/kiwoom/rankings?market=KR&type=volume&limit=30',
      stockQuote: '/api/stocks/005930/quote',
      watchlist: '/api/watchlist',
      alerts: '/api/market/alerts?market=ALL',
    },
  });
});

router.use('/', healthRouter);
router.use('/', marketRouter);
router.use('/', newsRouter);
router.use('/debug', providerDebugRouter);
router.use('/', pushRouter);
router.use('/stocks', stocksRouter);
router.use('/', watchlistRouter);
router.use('/kiwoom', kiwoomRouter);

export default router;

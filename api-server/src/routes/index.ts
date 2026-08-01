import { Router, type IRouter } from 'express';
import healthRouter from './health';
import marketRouter from './market';
import newsRouter from './news.route';
import providerDebugRouter from './provider-debug';
import pushRouter from './push';
import stocksRouter from './stocks';
import watchlistRouter from './watchlist';
import kiwoomRouter from './kiwoom.routes';
import adminRouter from './admin';
import secRouter from './sec.routes';
import cryptoRouter from './crypto';
import futuresMarketDataRouter from './futures-market-data';
import tradingRiskRouter from './trading-risk';
import backupRouter from './backup';
import { requireAdmin, requireMember } from '../middleware/auth';

const router: IRouter = Router();

// -------------------------------------------------------------------
// Public routes (no auth required)
// -------------------------------------------------------------------
router.get('/', (_req, res) => {
  res.json({ ok: true, service: 'seungjae-stock-api' });
});

router.use('/', healthRouter);
router.use('/', marketRouter);
router.use('/', newsRouter);
router.use('/kiwoom', kiwoomRouter);
router.use('/', futuresMarketDataRouter);
router.use('/', cryptoRouter);

// -------------------------------------------------------------------
// Admin routes (auth + admin role required — checked inside adminRouter)
// -------------------------------------------------------------------
router.use('/admin', adminRouter);

// -------------------------------------------------------------------
// Authenticated routes (login required)
// -------------------------------------------------------------------
router.use(requireMember);
router.use('/', tradingRiskRouter);
router.use('/debug', requireAdmin, providerDebugRouter);
router.use('/', pushRouter);
router.use('/', watchlistRouter);
router.use('/stocks', stocksRouter);
router.use('/', secRouter);
router.use('/backup', backupRouter);

export default router;

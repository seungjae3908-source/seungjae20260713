import { Router, type IRouter } from 'express';
import healthRouter from './health';
import marketRouter from './market';
import marketDashboardRouter from './market-dashboard';
import marketDepthRouter from './market-depth';
import strategyLabRouter from './strategy-lab';
import assetSearchRouter from './asset-search';
import stocksRanking100Router from './stocks-ranking-100';
import newsRouter from './news.route';
import providerDebugRouter from './provider-debug';
import pushRouter from './push';
import stocksRouter from './stocks';
import watchlistRouter from './watchlist';
import kiwoomRouter from './kiwoom.routes';
import adminRouter from './admin';
import adminUiLayoutsRouter from './admin-ui-layouts';
import uiLayoutsRouter from './ui-layouts';
import aiRepairRouter from './ai-repair';
import secRouter from './sec.routes';
import cryptoRouter from './crypto';
import cryptoSpotAutoRouter from './crypto-spot-auto';
import backupRouter from './backup';
import authRouter from './auth';
import analysisRouter from './analysis';
import portfolioRouter from './portfolio';
import {
  requireAdmin,
  requireFullMember,
  requireMember,
} from '../middleware/auth';

const router: IRouter = Router();

router.get('/', (_req, res) => {
  res.json({ ok: true, service: 'seungjae-stock-api' });
});

router.use('/', healthRouter);
router.use('/auth', authRouter);

// 승인된 준회원 이상은 일반 시장·분석·정보 기능을 사용할 수 있습니다.
// 관리자 작업만 별도 관리자 게이트를 유지합니다.
router.use('/market/themes/rebuild', requireMember, requireAdmin);
router.use('/market/themes/review', requireMember, requireAdmin);
router.use('/market/sector-popular', requireMember);
router.use('/market/briefing', requireMember);
router.use('/market/themes', requireMember);
router.use('/market/scan', requireMember);
router.use('/market/undervalued', requireMember);
router.use('/', stocksRanking100Router);
router.use('/', assetSearchRouter);
router.use('/', marketRouter);
router.use('/', marketDashboardRouter);
router.use('/', marketDepthRouter);
router.use('/', strategyLabRouter);

router.use('/', newsRouter);
router.use('/kiwoom', kiwoomRouter);

router.use(
  '/crypto/spot/auto',
  requireMember,
  requireAdmin,
  cryptoSpotAutoRouter,
);
router.use('/crypto/futures/auto', requireMember, requireFullMember, requireAdmin);
router.use('/crypto/futures', requireMember, requireFullMember);
router.use('/', cryptoRouter);
router.use('/', analysisRouter);
router.use('/', portfolioRouter);
router.use('/admin/ai-repair', requireMember, requireAdmin, aiRepairRouter);
router.use('/admin/ui-layouts', adminUiLayoutsRouter);
router.use('/ui-layouts', uiLayoutsRouter);
router.use('/admin', adminRouter);
router.use(requireMember);
router.use('/debug', requireAdmin, providerDebugRouter);
router.use('/stocks/auto-trade', requireAdmin);
router.use('/', pushRouter);
router.use('/', watchlistRouter);
router.use('/stocks', stocksRouter);
router.use('/', secRouter);
router.use('/backup', backupRouter);

export default router;

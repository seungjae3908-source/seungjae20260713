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
import backtestsRouter from './backtests';
import paperTradingRouter from './paper-trading';
import paperJournalRouter from './paper-journal';
import backupRouter from './backup';
import aiChatRouter from './ai-chat';
import tradeAutomationRouter from './trade-automation';
import tradeSignalApprovalRouter from './trade-signal-approval';
import {
  requireAdmin,
  requireAuthenticated,
  requireCapability,
} from '../middleware/auth';

const router: IRouter = Router();

router.get('/', (_req, res) => {
  res.json({ ok: true, service: 'seungjae-stock-api' });
});

// Health/config probes remain public. Every data or analysis route below this
// point resolves the current database profile before checking capabilities.
router.use('/', healthRouter);

// Admin routes perform their own authenticated + admin capability checks.
router.use('/admin', adminRouter);

router.use(requireAuthenticated);

const privateExchangeDisabled = (_req: unknown, res: any) => res.status(403).json({
  ok: false,
  error: 'PRIVATE_EXCHANGE_API_DISABLED',
  orderSubmitted: false,
  exchangeRequestSent: false,
  message: 'Release Candidate에서는 거래소 비공개 계좌·포지션·주문 API를 호출하지 않습니다.',
});

// Explicitly block every existing private/actual-trading path before the
// legacy crypto router can reach it. crypto-auto.ts itself remains untouched.
router.use('/crypto/futures/auto', privateExchangeDisabled);
router.get('/crypto/spot/accounts', privateExchangeDisabled);
router.get('/crypto/futures/account', privateExchangeDisabled);
router.get('/crypto/futures/positions', privateExchangeDisabled);
// Legacy stock auto-order endpoints include US live-order support and a shared
// execution key. They stay blocked; the member-scoped trade-automation router
// below is the only supported integration surface.
router.use('/stocks/auto-trade', privateExchangeDisabled);

router.use('/crypto/spot', requireCapability('canAccessSpot'));
router.use('/crypto/futures', requireCapability('canAccessFutures'));
router.use('/crypto', requireCapability('canAccessBasicInfo'));
router.use('/', cryptoRouter);

router.use('/futures', requireCapability('canAccessFutures'));
router.use('/crypto/futures', requireCapability('canAccessFutures'));
router.use('/', futuresMarketDataRouter);

router.use('/trading-risk', requireCapability('canAccessRiskPreview'));
router.use('/', tradingRiskRouter);
router.use('/backtests', requireCapability('canAccessBacktests'));
router.use('/', backtestsRouter);
router.use('/paper-trading', requireCapability('canAccessPaperTrading'));
router.use('/', paperTradingRouter);
router.use('/paper-journal', requireCapability('canAccessJournalSync'));
router.use('/', paperJournalRouter);
router.use('/trade-automation', requireCapability('canAccessPaperTrading'));
router.use('/trade-automation', tradeAutomationRouter);
router.use('/trade-automation', tradeSignalApprovalRouter);

router.use(requireCapability('canAccessBasicInfo'));
router.use('/', aiChatRouter);
router.use('/', marketRouter);
router.use('/', newsRouter);
router.use('/kiwoom', kiwoomRouter);
router.use('/debug', requireAdmin, providerDebugRouter);
router.use('/', pushRouter);
router.use('/', watchlistRouter);
router.use('/stocks', stocksRouter);
router.use('/', secRouter);
router.use('/backup', backupRouter);

export default router;

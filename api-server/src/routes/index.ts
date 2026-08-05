import { Router, type IRouter, type Response } from 'express';
import healthRouter from './health';
import marketRouter from './market';
import newsRouter from './news.route';
import providerDebugRouter from './provider-debug';
import pushRouter from './push';
import stocksRouter from './stocks';
import watchlistRouter from './watchlist';
import kiwoomRouter from './kiwoom.routes';
import kiwoomRankingsSafeRouter from './kiwoom-rankings-safe';
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
import tradeSignalAlertsRouter from './trade-signal-alerts';
import scannerApprovalRouter from './scanner-approval';
import boundedMarketScanRouter from './bounded-market-scan';
import cryptoSignalScanRouter from './crypto-signal-scan';
import {
  requireAdmin,
  requireAuthenticated,
  requireCapability,
} from '../middleware/auth';

const router: IRouter = Router();

router.get('/', (_req, res) => {
  res.json({ ok: true, service: 'seungjae-stock-api' });
});

router.use('/', healthRouter);
router.use('/admin', adminRouter);
router.use(requireAuthenticated);

router.use('/market/scan', boundedMarketScanRouter);
router.use('/scanner/crypto', cryptoSignalScanRouter);

const privateExchangeDisabled = (_req: unknown, res: Response) => res.status(403).json({
  ok: false,
  error: 'PRIVATE_EXCHANGE_API_DISABLED',
  orderSubmitted: false,
  exchangeRequestSent: false,
  message: 'Release Candidate에서는 거래소 비공개 계좌·포지션·주문 API를 호출하지 않습니다.',
});

router.use('/crypto/futures/auto', privateExchangeDisabled);
router.get('/crypto/spot/accounts', privateExchangeDisabled);
router.get('/crypto/futures/account', privateExchangeDisabled);
router.get('/crypto/futures/positions', privateExchangeDisabled);
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
// Scanner approvals must be intercepted before the generic execution route.
// Non-scanner plans call next() and keep the existing execution path.
router.use('/trade-automation', scannerApprovalRouter);
router.use('/trade-automation', tradeAutomationRouter);
router.use('/trade-automation', tradeSignalApprovalRouter);
router.use('/trade-automation', tradeSignalAlertsRouter);

router.use(requireCapability('canAccessBasicInfo'));
router.use('/', aiChatRouter);
router.use('/', marketRouter);
router.use('/', newsRouter);
router.use('/kiwoom', kiwoomRankingsSafeRouter);
router.use('/kiwoom', kiwoomRouter);
router.use('/debug', requireAdmin, providerDebugRouter);
router.use('/', pushRouter);
router.use('/', watchlistRouter);

router.get('/stocks/special-feed', (req, res, next) => {
  const asset = String(req.query.asset ?? 'stock').trim().toLowerCase();
  if (asset !== 'coin') {
    next();
    return;
  }

  const market = String(req.query.market ?? 'spot').trim().toLowerCase() === 'futures'
    ? 'futures'
    : 'spot';

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({
    ok: false,
    asset: 'coin',
    market,
    items: [],
    count: 0,
    updatedAt: new Date().toISOString(),
    message: '코인 특이정보 피드는 아직 연결되지 않았습니다.',
  });
});

router.use('/stocks/:ticker/financials', (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const payload = body && typeof body === 'object'
      ? body as Record<string, unknown>
      : null;

    if (res.statusCode !== 503 || payload?.code !== 'FINANCIAL_PROVIDER_DELAY') {
      return originalJson(body);
    }

    const ticker = String(payload.ticker ?? req.params.ticker ?? '').trim().toUpperCase();
    const unavailableFinancials = {
      annual: [],
      yearly: [],
      quarterly: [],
      quarters: [],
      ratios: {},
      source: null,
      updatedAt: new Date().toISOString(),
    };

    res.statusCode = 200;
    return originalJson({
      ...payload,
      ok: false,
      available: false,
      ticker,
      financials: unavailableFinancials,
      ...unavailableFinancials,
      items: [],
      summary: '재무 데이터 제공기관의 응답이 지연되고 있습니다.',
    });
  }) as typeof res.json;

  next();
});

router.use('/stocks', stocksRouter);
router.use('/', secRouter);
router.use('/backup', backupRouter);

export default router;

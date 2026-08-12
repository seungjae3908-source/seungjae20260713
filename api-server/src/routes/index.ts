import { Router, type IRouter } from 'express';
import healthRouter from './health';
import marketRouter from './market';
import marketInformationRouter from './market-information';
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
import boundedMarketScanRouter from './bounded-market-scan';
import cryptoSignalScanRouter from './crypto-signal-scan';
import unifiedSearchRouter from './unified-search';
import accountConnectionsRouter from './account-connections';
import { telegramWebhookRouter, userBrokerTelegramRouter } from './user-broker-telegram';
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

// Telegram webhook is the only unauthenticated integration endpoint. It accepts
// only Telegram-secret-authenticated /start updates containing a short-lived,
// one-time, user-bound token; it never trusts a browser-supplied chat id.
router.use('/telegram/webhook', telegramWebhookRouter);

// Admin routes perform their own authenticated + admin capability checks.
router.use('/admin', adminRouter);

router.use(requireAuthenticated);

// Brokerage/exchange account connectivity is intentionally read-only and
// admin-only because credentials are server-scoped. Existing order/cancel/
// transfer endpoints remain blocked below and are not reachable through this
// router.
router.use('/account-connections', requireAdmin, accountConnectionsRouter);

// Canonical AI Scanner routes must be registered before the legacy market
// router. This makes /api/market/scan authenticated, capability protected,
// bounded and cancellation aware. The legacy handler is no longer reachable.
router.use('/market/scan', boundedMarketScanRouter);
router.use('/scanner/crypto', cryptoSignalScanRouter);

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

// Market information rooms are read-only and capability-scoped. The service
// itself only permits whitelisted public GET endpoints; private exchange paths
// are neither imported nor reachable from this router.
router.use('/market-information/coins-spot', requireCapability('canAccessSpot'));
router.use('/market-information/coins-futures', requireCapability('canAccessFutures'));
router.use('/market-information', requireCapability('canAccessBasicInfo'), marketInformationRouter);

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
router.use('/trade-automation', requireCapability('canPlaceOrders'));
router.use('/trade-automation', tradeAutomationRouter);
router.use('/user-integrations', requireCapability('canPlaceOrders'));
router.use('/user-integrations', userBrokerTelegramRouter);

router.use(requireCapability('canAccessBasicInfo'));
router.use('/', unifiedSearchRouter);
router.use('/', aiChatRouter);
router.use('/', marketRouter);
router.use('/', newsRouter);
// The safe rankings route must run before the legacy Kiwoom router. It keeps
// the strict primary provider contract, but serves explicitly marked real-data
// fallback rows when the optional Kiwoom provider is unavailable.
router.use('/kiwoom', kiwoomRankingsSafeRouter);
router.use('/kiwoom', kiwoomRouter);
router.use('/debug', requireAdmin, providerDebugRouter);
router.use('/', pushRouter);
router.use('/', watchlistRouter);

// The coin special-feed provider is optional. A disconnected provider is an
// empty, non-fatal feature state rather than a browser-visible HTTP failure.
// This handler remains behind authentication and canAccessBasicInfo.
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

// Financial statements are an optional detail panel backed by public upstream
// providers. Preserve every successful response, but convert only the exact
// provider-delay contract from this one endpoint into an explicit unavailable
// state. Other endpoints and all other 4xx/5xx responses remain untouched.
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
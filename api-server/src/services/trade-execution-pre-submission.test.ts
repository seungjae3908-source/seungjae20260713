import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { TradeExecutionService } from './trade-execution.service';
import { encryptTradingCredentials } from './trade-credential-vault.service';
import {
  marketIntelligenceNotAvailable,
  tradingMarket,
  type MarketIntelligenceSummary,
} from './market-intelligence-client.service';
import {
  marketIntelligenceSymbolForTradingPlan,
  setTradingPlanMarketIntelligenceRunnerForTests,
} from './trade-market-intelligence.service';
import {
  DEFAULT_TRADING_POLICY,
  type TradingMarketSnapshot,
  type TradingPlanInput,
} from './trade-automation.types';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const nativeFetch = globalThis.fetch;

function marketSnapshot(now: Date): TradingMarketSnapshot {
  return {
    observedAt: now.toISOString(),
    riskObservedAt: now.toISOString(),
    dataDelayMs: 0,
    oneMinuteMovePercent: 0,
    spreadPercent: 0.1,
    orderbookGapPercent: 0.1,
    halted: false,
    availableBalance: 1_000_000,
    accountValueKrw: 5_000_000,
    dailyPnlPercent: 0,
    assetExposurePercent: 0,
    openPositionCount: 0,
    dailyOrderCount: 0,
    consecutiveLosses: 0,
    currentPrice: 100_000,
    plannedPrice: 100_000,
    marketStatus: 'OPEN',
    providerTimeOffsetMs: 0,
    source: 'approval-snapshot',
    availableLiquidityKrw: 1_000_000,
    estimatedSlippagePercent: 0.1,
    estimatedFeePercent: 0.05,
    correlatedExposurePercent: 0,
    signalState: 'entry_ready',
    signalObservedAt: now.toISOString(),
  };
}

function planInput(now: Date): TradingPlanInput {
  return {
    exchange: 'upbit',
    accountMode: 'live',
    strategyId: 'breakout-v1',
    signalId: `signal-${now.getTime()}`,
    symbol: 'BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'market',
    quantity: 1,
    quoteAmount: 20_000,
    limitPrice: null,
    estimatedKrw: 20_000,
    stopPrice: 95_000,
    targetPrices: [110_000],
    splitRatios: [100],
    signalReasons: ['trend'],
    estimatedSlippagePercent: 0.1,
    averageSpreadPercent: 0.1,
    economics: {
      sampleSize: 100,
      winProbability: 0.6,
      averageWinR: 1.5,
      averageLossR: 1,
      estimatedCostsR: 0.05,
      profitFactor: 1.5,
      maxDrawdownPercent: 10,
      marketRegime: 'bull',
      calibratedAt: now.toISOString(),
    },
    marketSnapshot: marketSnapshot(now),
  };
}

async function eligibleMarketIntelligence(
  input: Pick<TradingPlanInput, 'exchange' | 'market' | 'symbol'>,
): Promise<MarketIntelligenceSummary> {
  const unavailable = marketIntelligenceNotAvailable(
    tradingMarket(input),
    marketIntelligenceSymbolForTradingPlan(input),
    'TEST_MARKET_INTELLIGENCE_FIXTURE',
  );
  return {
    ...unavailable,
    status: 'READY',
    reason: null,
    warnings: [],
    autoTrading: {
      ...unavailable.autoTrading,
      mode: 'ELIGIBLE_FOR_PARENT_GATE',
      evidenceReady: true,
      parentEligibilityReady: true,
    },
  };
}

async function setup() {
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  process.env.ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
  process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';
  setTradingPlanMarketIntelligenceRunnerForTests(eligibleMarketIntelligence);
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER_ID, {
    ...DEFAULT_TRADING_POLICY,
    pilotStage: 'limited-50',
  });
  await repository.saveConnection({
    userId: USER_ID,
    exchange: 'upbit',
    accountMode: 'live',
    configured: true,
    encryptedCredentials: encryptTradingCredentials({ accessKey: 'access', secretKey: 'secret' }),
    lastVerifiedAt: new Date().toISOString(),
    lastErrorCode: null,
    updatedAt: new Date().toISOString(),
  });
  const automation = new TradeAutomationService(repository);
  const input = planInput(new Date());
  const policy = await repository.getPolicy(USER_ID);
  const created = await automation.createPlan(USER_ID, input, policy, false);
  assert.ok(created.plan);
  const approved = await automation.approvePlan(USER_ID, created.plan.id);
  const orderResult = await automation.createOrder(USER_ID, approved);
  return { repository, approved, order: orderResult.order };
}

function installUpbitMock(currentPrice: number) {
  let actualOrderPosts = 0;
  let orderTestPosts = 0;
  let totalProviderRequests = 0;
  globalThis.fetch = (async (input, init) => {
    totalProviderRequests += 1;
    const url = new URL(String(input));
    const now = Date.now();
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
    if (url.pathname === '/v1/accounts') {
      return json({ data: [
        { currency: 'KRW', balance: '1000000', locked: '0' },
        { currency: 'BTC', balance: '0', locked: '0' },
      ] });
    }
    if (url.pathname === '/v1/orders/chance') {
      return json({
        market: { state: 'active' },
        bid: { min_total: '5000' },
        ask: { min_total: '5000' },
        bid_fee: '0.0005',
        ask_fee: '0.0005',
      });
    }
    if (url.pathname === '/v1/ticker') {
      return json({ data: [{ market: 'KRW-BTC', trade_price: currentPrice, timestamp: now }] });
    }
    if (url.pathname === '/v1/orderbook') {
      return json({ data: [{
        market: 'KRW-BTC',
        timestamp: now,
        orderbook_units: [
          { ask_price: currentPrice, ask_size: 10, bid_price: currentPrice - 100, bid_size: 10 },
          { ask_price: currentPrice + 10, ask_size: 10, bid_price: currentPrice - 110, bid_size: 10 },
          { ask_price: currentPrice + 20, ask_size: 10, bid_price: currentPrice - 120, bid_size: 10 },
        ],
      }] });
    }
    if (url.pathname === '/v1/orders/test') {
      orderTestPosts += 1;
      return json({ accepted: true });
    }
    if (url.pathname === '/v1/orders' && (init?.method ?? 'GET') === 'POST') {
      actualOrderPosts += 1;
      return json({ uuid: 'exchange-order-1' });
    }
    if (url.pathname === '/v1/order') {
      return json({
        uuid: 'exchange-order-1',
        identifier: url.searchParams.get('identifier'),
        state: 'wait',
      });
    }
    return json({ error: { name: 'unexpected_path', message: url.pathname } }, 500);
  }) as typeof fetch;
  return {
    counts: () => ({ actualOrderPosts, orderTestPosts, totalProviderRequests }),
  };
}

function resetEnvironment() {
  globalThis.fetch = nativeFetch;
  setTradingPlanMarketIntelligenceRunnerForTests(null);
  delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
  delete process.env.ORDER_EXECUTION_ENABLED;
  delete process.env.LIVE_TRADING_ACTIVATION_APPROVED;
  delete process.env.UPBIT_LIVE_ORDER_ENABLED;
}

test.afterEach(resetEnvironment);

test('two concurrent executions produce one provider order POST behind one atomic intent', async () => {
  const { repository, approved, order } = await setup();
  const provider = installUpbitMock(100_000);
  const execution = new TradeExecutionService(repository);

  await Promise.all([
    execution.execute(USER_ID, approved, order),
    execution.execute(USER_ID, approved, order),
  ]);

  const finalOrder = await repository.getOrder(USER_ID, order.id);
  assert.ok(finalOrder);
  assert.equal(finalOrder.state, 'ACCEPTED');
  assert.ok(finalOrder.submissionStartedAt);
  assert.ok(finalOrder.submissionAttemptId);
  assert.equal(finalOrder.preSubmissionDecision?.allowed, true);
  assert.equal(provider.counts().actualOrderPosts, 1);
  assert.equal(provider.counts().orderTestPosts, 1);

  const replay = await execution.execute(USER_ID, approved, order);
  assert.equal(replay.state, 'ACCEPTED');
  assert.equal(provider.counts().actualOrderPosts, 1);
});

test('approval price drift blocks before order test, intent, and actual order POST', async () => {
  const { repository, approved, order } = await setup();
  const provider = installUpbitMock(103_000);
  const execution = new TradeExecutionService(repository);

  const result = await execution.execute(USER_ID, approved, order);
  assert.equal(result.state, 'REJECTED');
  assert.equal(result.lastErrorCode, 'PRE_SUBMISSION_RISK_RECHECK_FAILED');
  assert.equal(result.submissionStartedAt ?? null, null);
  assert.ok(result.preSubmissionDecision?.blockCodes.includes('APPROVAL_PRICE_DRIFT_EXCEEDED'));
  assert.equal(provider.counts().orderTestPosts, 0);
  assert.equal(provider.counts().actualOrderPosts, 0);
  const expiredPlan = await repository.getPlan(USER_ID, approved.id);
  assert.equal(expiredPlan?.state, 'EXPIRED');
});
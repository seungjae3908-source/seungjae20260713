import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { TradeExecutionService } from './trade-execution.service';
import { isRiskReducingExitPlan, liveConnectionVerificationAllowsReducingExit, liveConnectionVerificationFresh } from './live-connection-verification.service';
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
import { allowServerProfitabilityAttestationForTests } from './trade-profitability-attestation.test-fixture';
import { setTradeProfitabilityAttestationRunnerForTests } from './trade-profitability-attestation.service';
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
  process.env.SPOT_LIVE_LIMITED_ACTIVATION_APPROVED = 'true';
  process.env.REAL_ORDER_ENABLED = 'true';
  process.env.PRIVATE_TRADING_API_ALLOWED = 'true';
  process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';
  process.env.LIVE_TRADING = 'true';
  process.env.executionAuthority = 'SPOT_LIVE_LIMITED';
  process.env.SPOT_LIVE_CAPABILITY_ALLOWLIST = 'BALANCE_READ,POSITION_READ,OPEN_ORDER_READ,ORDER_CREATE,ORDER_CANCEL,ORDER_AMEND';
  process.env.SPOT_LIVE_MARKET_ALLOWLIST = 'KR_STOCK,US_STOCK,CRYPTO_SPOT';
  setTradingPlanMarketIntelligenceRunnerForTests(eligibleMarketIntelligence);
  setTradeProfitabilityAttestationRunnerForTests(allowServerProfitabilityAttestationForTests);
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

function installUpbitMock(currentPrice: number, openOrders: Record<string, unknown>[] = []) {
  let actualOrderPosts = 0;
  let orderTestPosts = 0;
  let totalProviderRequests = 0;
  let openOrderReads = 0;
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
    if (url.pathname === '/v1/orders/open') {
      openOrderReads += 1;
      const requestedState = url.searchParams.get('state');
      return json(openOrders.filter((item) => String(item.state ?? 'wait') === requestedState));
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
    counts: () => ({ actualOrderPosts, orderTestPosts, totalProviderRequests, openOrderReads }),
  };
}

function resetEnvironment() {
  globalThis.fetch = nativeFetch;
  setTradingPlanMarketIntelligenceRunnerForTests(null);
  setTradeProfitabilityAttestationRunnerForTests(null);
  delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
  delete process.env.ORDER_EXECUTION_ENABLED;
  delete process.env.LIVE_TRADING_ACTIVATION_APPROVED;
  delete process.env.SPOT_LIVE_LIMITED_ACTIVATION_APPROVED;
  delete process.env.REAL_ORDER_ENABLED;
  delete process.env.PRIVATE_TRADING_API_ALLOWED;
  delete process.env.UPBIT_LIVE_ORDER_ENABLED;
  delete process.env.LIVE_TRADING;
  delete process.env.executionAuthority;
  delete process.env.SPOT_LIVE_CAPABILITY_ALLOWLIST;
  delete process.env.SPOT_LIVE_MARKET_ALLOWLIST;
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
  assert.equal(provider.counts().openOrderReads, 2);

  const replay = await execution.execute(USER_ID, approved, order);
  assert.equal(replay.state, 'ACCEPTED');
  assert.equal(provider.counts().actualOrderPosts, 1);
});

test('orphan Upbit open order blocks before order test, submission intent, and actual POST', async () => {
  const { repository, approved, order } = await setup();
  const provider = installUpbitMock(100_000, [{
    uuid: 'external-exchange-order',
    identifier: 'external-client-order',
    state: 'wait',
  }]);
  const execution = new TradeExecutionService(repository);

  const result = await execution.execute(USER_ID, approved, order);
  assert.equal(result.state, 'REJECTED');
  assert.equal(result.lastErrorCode, 'ORPHAN_EXCHANGE_ORDER_DETECTED');
  assert.equal(result.submissionStartedAt ?? null, null);
  assert.equal(provider.counts().openOrderReads, 2);
  assert.equal(provider.counts().orderTestPosts, 0);
  assert.equal(provider.counts().actualOrderPosts, 0);
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


test('saved live credential verification expires and rejects future timestamps', () => {
  const now = Date.parse('2026-10-08T00:00:00.000Z');
  const connection = {
    configured: true, accountMode: 'live' as const, lastErrorCode: null,
    lastVerifiedAt: new Date(now - 60_000).toISOString(),
  };
  assert.equal(liveConnectionVerificationFresh(connection, now), true);
  assert.equal(liveConnectionVerificationFresh({ ...connection, lastVerifiedAt: new Date(now - 31 * 24 * 60 * 60_000).toISOString() }, now), false);
  assert.equal(liveConnectionVerificationFresh({ ...connection, lastVerifiedAt: new Date(now + 6_000).toISOString() }, now), false);
  assert.equal(liveConnectionVerificationFresh({ ...connection, lastErrorCode: 'REVOKED' }, now), false);
  assert.equal(liveConnectionVerificationFresh({ ...connection, lastVerifiedAt: 'bad-date' }, now), false);
});

test('stale credential verification blocks live order before any provider request', async () => {
  const { repository, approved, order } = await setup();
  const configured = await repository.getConnection(USER_ID, 'upbit');
  assert.ok(configured);
  await repository.saveConnection({
    ...configured,
    lastVerifiedAt: new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString(),
  });
  const provider = installUpbitMock(100_000);
  const execution = new TradeExecutionService(repository);
  const result = await execution.execute(USER_ID, approved, order);
  assert.equal(result.state, 'REJECTED');
  assert.equal(result.lastErrorCode, 'LIVE_EXECUTION_CONNECTION_NOT_VERIFIED');
  assert.equal(provider.counts().actualOrderPosts, 0);
  assert.equal(provider.counts().orderTestPosts, 0);
  assert.equal(provider.counts().openOrderReads, 0);
});


test('expired entry verification cannot prevent a risk-reducing exit with still-valid credentials', () => {
  const now = Date.parse('2026-10-08T00:00:00.000Z');
  const verified = {
    configured: true, accountMode: 'live' as const,
    lastErrorCode: null,
    lastVerifiedAt: new Date(now - 45 * 24 * 60 * 60_000).toISOString(),
  };
  assert.equal(liveConnectionVerificationFresh(verified, now), false);
  assert.equal(liveConnectionVerificationAllowsReducingExit(verified, now), true);
  assert.equal(liveConnectionVerificationAllowsReducingExit({ ...verified, lastErrorCode: 'REVOKED' }, now), false);
  assert.equal(liveConnectionVerificationAllowsReducingExit({ ...verified, lastVerifiedAt: null }, now), false);
});


test('stale verification exception cannot be used by a reduceOnly cash BUY', () => {
  assert.equal(isRiskReducingExitPlan({ reduceOnly: true, exchange: 'upbit', side: 'buy' }), false);
  assert.equal(isRiskReducingExitPlan({ reduceOnly: true, exchange: 'upbit', side: 'sell' }), true);
  assert.equal(isRiskReducingExitPlan({ reduceOnly: true, exchange: 'kiwoom', side: 'sell' }), true);
  assert.equal(isRiskReducingExitPlan({ reduceOnly: false, exchange: 'bitget', side: 'short' }), false);
  assert.equal(isRiskReducingExitPlan({ reduceOnly: true, exchange: 'bitget', side: 'short' }), true);
});


test('automatic-origin live entry is rejected after AUTO policy is disabled even if manual authority is enabled', async () => {
  const { repository, approved, order } = await setup();
  const automatic = {
    ...approved,
    executionMode: 'automatic' as const,
    signalReasons: [...approved.signalReasons, 'CANONICAL_LIVE_AUTO_HANDOFF'],
  };
  await repository.savePlan(automatic);
  const provider = installUpbitMock(100_000);
  const result = await new TradeExecutionService(repository).execute(USER_ID, automatic, order);
  assert.equal(result.state, 'REJECTED');
  assert.equal(result.lastErrorCode, 'AUTOMATIC_ENTRY_POLICY_REVOKED');
  assert.equal(result.submissionStartedAt ?? null, null);
  assert.equal(provider.counts().actualOrderPosts, 0);
  assert.equal(provider.counts().orderTestPosts, 0);
  assert.equal(provider.counts().openOrderReads, 0);
});


test('persisted invalid reduce-only cash BUY is rejected before private provider reads or order POST', async () => {
  const { repository, approved, order } = await setup();
  const unsafe = { ...approved, side: 'buy' as const, reduceOnly: true };
  await repository.savePlan(unsafe);
  const provider = installUpbitMock(100_000);
  const result = await new TradeExecutionService(repository).execute(USER_ID, unsafe, order);
  assert.equal(result.state, 'REJECTED');
  assert.equal(result.lastErrorCode, 'REDUCE_ONLY_SIDE_INVALID');
  assert.equal(result.submissionStartedAt ?? null, null);
  assert.equal(provider.counts().openOrderReads, 0);
  assert.equal(provider.counts().orderTestPosts, 0);
  assert.equal(provider.counts().actualOrderPosts, 0);
});


test('Bitget automatic entry with a missing Arm cannot mutate margin/leverage before order intent', async () => {
  const previousFetch = globalThis.fetch;
  const envNames = [
    'TRADING_EMERGENCY_STOP', 'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
    'AUTO_TRADING', 'LIVE_AUTOMATIC_TRADING_ENABLED', 'LIVE_TRADING',
    'REAL_ORDER_ENABLED', 'PRIVATE_TRADING_API_ALLOWED',
    'DEPLOY_SHA', 'MEMBER_AUTO_TRADING_LIVE_ENTRY_ARM_PATH',
  ] as const;
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER_ID, {
    ...DEFAULT_TRADING_POLICY, mode: 'automatic', automaticEnabled: true,
  });
  const now = new Date();
  const futuresPlan = {
    ...planInput(now),
    exchange: 'bitget' as const,
    symbol: 'BTCUSDT', market: 'USDT-FUTURES', side: 'long' as const,
    quantity: 1, quoteAmount: null, leverage: 2, marginMode: 'isolated' as const,
    reduceOnly: false, executionMode: 'automatic' as const,
    id: 'bitget-pre-arm-plan', userId: USER_ID, idempotencyKey: 'bitget-pre-arm-plan-key',
    state: 'SUBMITTED' as const, version: 1, approvedAt: now.toISOString(),
    approvalExpiresAt: new Date(now.getTime() + 600_000).toISOString(),
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  const futuresOrder = {
    id: 'bitget-pre-arm-order', userId: USER_ID,
    clientOrderId: 'bitget-pre-arm-order-oid', exchange: 'bitget' as const,
    planId: futuresPlan.id, state: 'SUBMITTED' as const,
  };
  let reads = 0;
  let mutations = 0;
  let riskEvaluated = false;
  const executor = new TradeExecutionService(repository);
  Object.assign(executor, {
    riskService: {
      async evaluate(input: { snapshot: TradingMarketSnapshot }) {
        riskEvaluated = true;
        return { plan: futuresPlan, snapshot: input.snapshot,
          checkedAt: now.toISOString(), priceDriftPercent: 0,
          allowed: true, blockCodes: [], warnings: [] };
      },
    },
  });
  const privateBitget = executor as unknown as {
    executeBitget(userId: string, plan: unknown, order: unknown, credentials: unknown): Promise<unknown>;
  };
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      mutations += 1;
      throw new Error('MUTATING_BITGET_CALL_MUST_NOT_HAPPEN');
    }
    reads += 1;
    const data = url.pathname.endsWith('/account/accounts')
      ? [{ marginCoin: 'USDT', available: '1000', accountEquity: '1000', posMode: 'one_way_mode' }]
      : url.pathname.endsWith('/position/all-position') ? []
      : url.pathname.endsWith('/order/orders-pending') ? { entrustedList: [] }
      : url.pathname.endsWith('/market/contracts')
        ? [{ symbol: 'BTCUSDT', minTradeNum: '0.001', sizeMultiplier: '0.001', symbolStatus: 'normal', minTradeUSDT: '5' }]
        : url.pathname.endsWith('/market/ticker')
          ? [{ symbol: 'BTCUSDT', markPrice: '100', ts: Date.now(), lastPr: '100' }]
          : url.pathname.endsWith('/market/merge-depth')
            ? [{ bids: [['99', '100']], asks: [['101', '100']], ts: Date.now() }]
            : null;
    if (data === null) throw new Error('UNEXPECTED_BITGET_READ:' + url.pathname);
    return new Response(JSON.stringify({ code: '00000', data }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    process.env.TRADING_EMERGENCY_STOP = 'false';
    for (const key of envNames.slice(1, 7)) process.env[key] = 'true';
    process.env.DEPLOY_SHA = 'a'.repeat(40);
    process.env.MEMBER_AUTO_TRADING_LIVE_ENTRY_ARM_PATH = '/nonexistent-arm-boundary/auto-entry-arm.json';
    const credentials = { apiKey: 'ci-key', secretKey: 'ci-secret', passphrase: 'ci-pass' };
    await assert.rejects(
      () => privateBitget.executeBitget(USER_ID, futuresPlan, futuresOrder, credentials),
      /AUTOMATIC_LIVE_ENTRY_ARM_NOT_READY/,
    );
    assert.equal(riskEvaluated, true, 'preflight reached post-risk provider mutation boundary');
    assert.equal(reads, 6, 'only six read-only Bitget preflight requests');
    assert.equal(mutations, 0, 'neither margin mode nor leverage nor order is mutated');

    await repository.savePolicy(USER_ID, {
      ...DEFAULT_TRADING_POLICY, mode: 'approval', automaticEnabled: false,
    });
    await assert.rejects(
      () => privateBitget.executeBitget(USER_ID, futuresPlan, futuresOrder, credentials),
      /AUTOMATIC_ENTRY_POLICY_REVOKED/,
    );
    assert.equal(mutations, 0, 'AUTO OFF cannot mutate provider margin or leverage');
  } finally {
    globalThis.fetch = previousFetch;
    for (const name of envNames) {
      const prior = previousEnv[name];
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }
});
test('member cap tightening after preflight is enforced again before provider mutation', async () => {
  const repo = new InMemoryTradingRepository();
  const now = new Date();
  const entry = {
    ...planInput(now), accountMode: 'live' as const,
    executionMode: 'automatic' as const,
    id: 'cap-recheck-live-plan', userId: USER_ID, idempotencyKey: 'cap-recheck',
    state: 'SUBMITTED' as const, version: 1,
    approvedAt: now.toISOString(),
    approvalExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  const execute = new TradeExecutionService(repo) as unknown as {
    assertAutomaticLiveEntryAuthorized(userId: string, plan: typeof entry): Promise<void>;
  };
  const previousStop = process.env.TRADING_EMERGENCY_STOP;
  try {
    process.env.TRADING_EMERGENCY_STOP = 'false';
    await repo.savePolicy(USER_ID, {
      ...DEFAULT_TRADING_POLICY, mode: 'automatic', automaticEnabled: true,
      totalCapitalKrw: 500_000, maxOrderKrw: 10_000,
    });
    await assert.rejects(
      execute.assertAutomaticLiveEntryAuthorized(USER_ID, entry),
      /BACKGROUND_PILOT_DYNAMIC_CAP_POLICY_REVOKED/,
      'a stale 20k plan cannot survive a new 10k member cap',
    );
    await repo.savePolicy(USER_ID, {
      ...DEFAULT_TRADING_POLICY, mode: 'automatic', automaticEnabled: true,
      totalCapitalKrw: 500_000, maxOrderKrw: 500_000, maxInstrumentKrw: 10_000,
    });
    await assert.rejects(
      execute.assertAutomaticLiveEntryAuthorized(USER_ID, entry),
      /AUTOMATIC_ENTRY_POLICY_CAP_REVOKED/,
      'a tightened per-instrument cap must block before the Arm/provider mutation',
    );
    assert.equal((await repo.listOrders(USER_ID)).length, 0);
  } finally {
    if (previousStop == null) delete process.env.TRADING_EMERGENCY_STOP;
    else process.env.TRADING_EMERGENCY_STOP = previousStop;
  }
});

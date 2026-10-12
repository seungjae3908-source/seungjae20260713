import './paper-futures-funding-certificate.service.test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import {
  paperSimulatedCostAmount, serverPaperFillCostEvidence,
  protectedAutomaticPaperCostPolicyV1,
  TradeExecutionService,
} from './trade-execution.service';
import { tradeAutomationJournalPayloadsFromSnapshot } from './trade-automation-unified-journal-adapter';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
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

test('stopped worker generation cannot execute any provider, inspect credentials or claim a real order', async () => {
  const repository = new InMemoryTradingRepository();
  let calls = 0;
  repository.getPlan = async () => { calls += 1; throw new Error('NO_DATABASE_EXECUTION'); };
  const service = new TradeExecutionService(repository, undefined, undefined, undefined, () => false);
  for (const exchange of ['bitget', 'upbit', 'kiwoom', 'toss'] as const) {
    await assert.rejects(service.execute(USER_ID, { exchange, accountMode: 'live', executionMode: 'automatic' } as TradingPlan,
      { userId: USER_ID, exchange } as TradingOrder), /AUTOMATIC_WORKER_GENERATION_STOPPED/u);
  }
  assert.equal(calls, 0);
});

test('late successful ownership reads cannot restore a stopped worker generation', async () => {
  let active = true;
  const service = new TradeExecutionService(new InMemoryTradingRepository(), undefined, undefined, undefined, () => active);
  Object.assign(service, { async assertAutomaticLiveEntryControls() {},
    async assertAutomaticLivePositionIsolation() { active = false; } });
  const boundary = service as unknown as {
    assertAutomaticLiveEntryAuthorized(userId: string, plan: TradingPlan): Promise<void>;
  };
  await assert.rejects(boundary.assertAutomaticLiveEntryAuthorized(USER_ID, {
    accountMode: 'live', executionMode: 'automatic', reduceOnly: false } as TradingPlan), /AUTOMATIC_WORKER_GENERATION_STOPPED/u);
});

test('AUTO authority revoked during the ownership read blocks at the final provider boundary', async () => {
  const execution = new TradeExecutionService(new InMemoryTradingRepository());
  const events: string[] = [];
  Object.assign(execution, {
    async assertAutomaticLiveEntryControls() {
      events.push('controls');
      if (events.length > 1) throw new Error('AUTOMATIC_ENTRY_POLICY_REVOKED');
    },
    async assertAutomaticLivePositionIsolation() { events.push('isolation'); },
  });
  const boundary = execution as unknown as {
    assertAutomaticLiveEntryAuthorized(userId: string, plan: TradingPlan): Promise<void>;
  };
  await assert.rejects(boundary.assertAutomaticLiveEntryAuthorized(USER_ID, {
    ...planInput(new Date()), executionMode: 'automatic', reduceOnly: false,
  } as TradingPlan), /AUTOMATIC_ENTRY_POLICY_REVOKED/);
  assert.deepEqual(events, ['controls', 'isolation', 'controls']);
});

test('provider mutation boundary re-reads manual ownership with execution vault and never mutates protected assets', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.TRADING_CREDENTIAL_MASTER_KEY;
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  const repository = new InMemoryTradingRepository();
  await repository.saveConnection({ userId: USER_ID, exchange: 'upbit', accountMode: 'live',
    configured: true, encryptedCredentials: encryptTradingCredentials({ accessKey: 'test', secretKey: 'test' }),
    lastVerifiedAt: new Date().toISOString(), lastErrorCode: null, updatedAt: new Date().toISOString() });
  const execution = new TradeExecutionService(repository) as unknown as {
    assertAutomaticLivePositionIsolation(userId: string, plan: TradingPlan): Promise<void>;
  };
  const plan = { ...planInput(new Date()), symbol: 'KRW-SOL', executionMode: 'automatic',
    userId: USER_ID, signalReasons: ['CANONICAL_LIVE_AUTO_HANDOFF'] } as TradingPlan;
  let acquiredSolManually = false;
  let reads = 0;
  let mutations = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (String(init?.method ?? 'GET') !== 'GET') { mutations += 1; throw new Error('MUTATION_FORBIDDEN'); }
    reads += 1;
    if (url.pathname === '/v1/accounts') return Response.json([
      { currency: 'KRW', balance: '1000000', locked: '0', avg_buy_price: '0', unit_currency: 'KRW' },
      { currency: 'BTC', balance: '0.2', locked: '0', avg_buy_price: '1', unit_currency: 'KRW' },
      ...(acquiredSolManually ? [{ currency: 'SOL', balance: '1', locked: '0', avg_buy_price: '1', unit_currency: 'KRW' }] : []),
    ]);
    if (url.pathname === '/v1/orders/open') return Response.json([]);
    throw new Error('UNEXPECTED_READ_PATH');
  }) as typeof fetch;
  try {
    await execution.assertAutomaticLivePositionIsolation(USER_ID, plan);
    acquiredSolManually = true;
    await assert.rejects(execution.assertAutomaticLivePositionIsolation(USER_ID, plan), /MANUAL_ASSET_PROTECTED/);
    await assert.rejects(execution.assertAutomaticLivePositionIsolation(USER_ID,
      { ...plan, side: 'sell', reduceOnly: true, signalReasons: ['AUTO_EXIT_ENTRY_PLAN:unproven'] }), /MANUAL_ASSET_PROTECTED/);
    assert.ok(reads >= 3, 'each boundary performed a fresh private read');
    assert.equal(mutations, 0);
    assert.equal((await repository.listOrders(USER_ID)).length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
    else process.env.TRADING_CREDENTIAL_MASTER_KEY = previousKey;
  }
});

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

test('Paper simulated costs require explicit finite fee policy; missing never becomes zero', () => {
  assert.equal(paperSimulatedCostAmount(100, 2, 0), 0);
  assert.equal(paperSimulatedCostAmount(100, 2, 0.05), 0.1);
  for (const missing of [null, undefined, NaN, Infinity, -0.01, 100.01]) {
    assert.equal(paperSimulatedCostAmount(100, 2, missing), null);
  }
  assert.equal(paperSimulatedCostAmount(100, 0, 0), null);
  assert.equal(paperSimulatedCostAmount(0, 2, 0), null);
  assert.equal(paperSimulatedCostAmount(Number.MAX_VALUE, 2, 100), null);
});

test('server native Paper quote is recorded while unissued tax and missing fees remain unknown', async () => {
  const nowMs=Date.parse('2026-10-11T00:00:00.000Z');
  const p:TradingPlan={...planInput(new Date(nowMs)), accountMode:'paper',
    id:'native-paper-1',userId:USER_ID,idempotencyKey:'native-paper',
    state:'SUBMITTED',version:1,approvalExpiresAt:null,
    approvedAt:new Date(nowMs).toISOString(),createdAt:new Date(nowMs).toISOString(),
    updatedAt:new Date(nowMs).toISOString()};
  const result=await serverPaperFillCostEvidence(p,100,2,null,{},nowMs);
  assert.equal(result.feeAmount,null);
  assert.equal(result.taxAmount,null);
  assert.equal(result.taxCurrency,null);
  assert.equal(result.trustedPaperCostPolicyId,null);
  assert.equal(result.feeCurrency,'KRW');
  assert.deepEqual(result.settlementFxEvidence,{
    krwPerQuoteCurrency:1,source:'NATIVE_KRW',observedAt:new Date(nowMs).toISOString(),
  });
});

test('server-owned versioned tax cost policy and fresh FX can be issued for an actual Paper fill', async () => {
  const nowMs=Date.parse('2026-10-11T00:00:00.000Z');
  const p:TradingPlan={...planInput(new Date(nowMs)),
    exchange:'bitget',market:'USDT-FUTURES',accountMode:'paper',
    id:'bitget-cost-policy',userId:USER_ID,idempotencyKey:'bitget-paper',
    state:'SUBMITTED',version:1,approvalExpiresAt:null,
    approvedAt:new Date(nowMs).toISOString(),createdAt:new Date(nowMs).toISOString(),
    updatedAt:new Date(nowMs).toISOString()};
  const sources={
    async fxQuote(){
      return {market:'CRYPTO_FUTURES' as const,source:'UPBIT:KRW-USDT',
        krwPerQuoteCurrency:1375,observedAt:new Date(nowMs-1_000).toISOString(),
        stale:false as const};
    },
    async costPolicy(){
      return {source:'SERVER_PAPER_COST_POLICY_V1' as const,
        policyId:'server-paper-cost-v1:unit-commission-tax',
        market:'CRYPTO_FUTURES' as const,exchange:'bitget' as const,
        feeRatePercent:0.1,taxRatePercent:0.2,
        effectiveAt:new Date(nowMs-86_400_000).toISOString(),
        expiresAt:new Date(nowMs+86_400_000).toISOString()};
    },
  };
  const receipt=await serverPaperFillCostEvidence(p,100,2,90,sources,nowMs);
  assert.equal(receipt.feeAmount,0.2);
  assert.equal(receipt.taxAmount,0.4);
  assert.equal(receipt.taxCurrency,'USDT');
  assert.equal(receipt.trustedPaperCostPolicyId,'server-paper-cost-v1:unit-commission-tax');
  assert.equal(receipt.settlementFxEvidence?.krwPerQuoteCurrency,1375);
  assert.equal(receipt.settlementFxEvidence?.source,'UPBIT:KRW-USDT');
});

test('wrong-source or stale server quotes and invalid cost policies cannot mint settlement receipts', async () => {
  const nowMs=Date.parse('2026-10-11T00:00:00.000Z');
  const p:TradingPlan={...planInput(new Date(nowMs)),accountMode:'paper',
    exchange:'kiwoom',market:'US',stockExchange:'NASDAQ',
    id:'us-equity-policy',userId:USER_ID,idempotencyKey:'us-paper',
    state:'SUBMITTED',version:1,approvalExpiresAt:null,
    approvedAt:new Date(nowMs).toISOString(),createdAt:new Date(nowMs).toISOString(),
    updatedAt:new Date(nowMs).toISOString()};
  const invalidPolicy={
    source:'SERVER_PAPER_COST_POLICY_V1' as const,
    policyId:'server-paper-cost-v1:unit-us',
    market:'US_STOCK' as const,exchange:'kiwoom' as const,
    feeRatePercent:0.1,taxRatePercent:0.1,
    effectiveAt:new Date(nowMs-1000).toISOString(),
    expiresAt:new Date(nowMs-1).toISOString(),
  };
  const result=await serverPaperFillCostEvidence(p,100,1,0.15,{
    async fxQuote() {return {
      market:'US_STOCK' as const,source:'UPBIT:KRW-USDT',
      krwPerQuoteCurrency:1400,observedAt:new Date(nowMs-1_000).toISOString(),
      stale:false as const};},
    async costPolicy() {return invalidPolicy;},
  },nowMs);
  assert.equal(result.taxAmount,null);
  assert.equal(result.trustedPaperCostPolicyId,null);
  assert.equal(result.feeCurrency,'USD');
  assert.equal(result.feeAmount,0.15);
  assert.equal(result.settlementFxEvidence,null);
  const stale=await serverPaperFillCostEvidence(p,100,1,0.15,{
    async fxQuote() {return {
      market:'US_STOCK' as const,source:'YAHOO:USDKRW=X',
      krwPerQuoteCurrency:1400,observedAt:new Date(nowMs-86_400_001).toISOString(),
      stale:false as const};},
  },nowMs);
  assert.equal(stale.settlementFxEvidence,null);
  assert.equal(stale.taxAmount,null);
  // A generic US Paper API request is not allowed to make any unsolicited
  // external FX requests. Only the server's previously verified worker quote
  // may be used for a foreign-currency Paper settlement.
  const noImplicitPublicFx=await serverPaperFillCostEvidence(p,100,1,0.15,{},nowMs);
  assert.equal(noImplicitPublicFx.settlementFxEvidence,null);
});

test('Paper fill transition persists server-issued tax and FX in canonical order and Journal; other modes cannot', async () => {
  const repository=new InMemoryTradingRepository();
  const now=new Date();
  const plan:TradingPlan={...planInput(now),accountMode:'paper',
    executionMode:'automatic',id:'persist-paper-plan',userId:USER_ID,
    idempotencyKey:'persist-paper-idempotency',state:'SUBMITTED',version:1,
    approvalExpiresAt:null,approvedAt:now.toISOString(),
    createdAt:now.toISOString(),updatedAt:now.toISOString()};
  const order:TradingOrder={
    id:'persist-paper-fill',userId:USER_ID,planId:plan.id,exchange:'upbit',
    clientOrderId:'persist-client',exchangeOrderId:null,state:'ACCEPTED',
    version:1,requestedQuantity:2,remainingQuantity:2,filledQuantity:0,
    averageFillPrice:null,retryCount:0,lastErrorCode:null,
    createdAt:now.toISOString(),updatedAt:now.toISOString(),
  };
  await repository.savePlan(plan);await repository.saveOrder(order);
  const canonical=new TradeAutomationService(repository);
  const verified={
    taxAmount:0,taxCurrency:'KRW',
    trustedPaperCostPolicyId:'server-paper-cost-v1:unit',
    settlementFxEvidence:{
      source:'NATIVE_KRW',krwPerQuoteCurrency:1,observedAt:now.toISOString()},
  };
  await canonical.transition(order,'FILLED','PAPER_BROKER_FILLED',{
    filledQuantity:2,averageFillPrice:100,feeAmount:0.1,feeCurrency:'KRW',...verified,
  });
  const stored=await repository.getOrder(USER_ID,order.id);
  assert.equal(stored?.taxAmount,0);
  assert.equal(stored?.taxCurrency,'KRW');
  assert.equal(stored?.settlementFxEvidence?.source,'NATIVE_KRW');
  const rows=tradeAutomationJournalPayloadsFromSnapshot(USER_ID,[stored!],[plan]);
  assert.equal(rows[0]?.tax,0);
  assert.equal(rows[0]?.fees,0.1);
  const otherRepository=new InMemoryTradingRepository();
  const livePlan={...plan,id:'persist-live-plan',accountMode:'live' as const};
  const liveOrder={...order,id:'persist-live-fill',planId:livePlan.id,state:'ACCEPTED' as const,
    filledQuantity:0,averageFillPrice:null,taxAmount:null,settlementFxEvidence:null};
  await otherRepository.savePlan(livePlan);await otherRepository.saveOrder(liveOrder);
  await new TradeAutomationService(otherRepository).transition(
    liveOrder,'FILLED','PAPER_BROKER_FILLED',{
      filledQuantity:2,averageFillPrice:100,feeAmount:0.1,feeCurrency:'KRW',...verified,
    });
  const ignored=await otherRepository.getOrder(USER_ID,liveOrder.id);
  assert.equal(ignored?.taxAmount??null,null);
  assert.equal(ignored?.settlementFxEvidence??null,null);
});

test('untrusted Paper tax or mismatched FX denomination is never certified on transition', async () => {
  const now=new Date();
  const p:TradingPlan={...planInput(now),accountMode:'paper',
    id:'paper-invalid-cost',userId:USER_ID,idempotencyKey:'paper-invalid',
    state:'SUBMITTED',version:1,approvalExpiresAt:null,approvedAt:now.toISOString(),
    createdAt:now.toISOString(),updatedAt:now.toISOString()};
  const order:TradingOrder={id:'invalid-cost-fill',userId:USER_ID,planId:p.id,
    exchange:'upbit',clientOrderId:'invalid-cost-client',exchangeOrderId:null,
    state:'ACCEPTED',version:1,requestedQuantity:1,filledQuantity:0,
    averageFillPrice:null,retryCount:0,lastErrorCode:null,
    createdAt:now.toISOString(),updatedAt:now.toISOString()};
  const repo=new InMemoryTradingRepository();
  await repo.savePlan(p);await repo.saveOrder(order);
  await new TradeAutomationService(repo).transition(order,'FILLED','PAPER_BROKER_FILLED',{
    filledQuantity:1,averageFillPrice:100,
    feeAmount:0.1,feeCurrency:'KRW',
    taxAmount:0,taxCurrency:'KRW',
    settlementFxEvidence:{source:'YAHOO:USDKRW=X',krwPerQuoteCurrency:1400,
      observedAt:now.toISOString()},
  });
  const stored=await repo.getOrder(USER_ID,order.id);
  assert.equal(stored?.taxAmount??null,null,'missing trusted issuer is never a zero tax receipt');
  assert.equal(stored?.settlementFxEvidence??null,null,'wrong market FX source cannot be signed');
});


test('protected 4-market automatic Paper cost rules are exact, expiring, and never inherited by Live/manual', async () => {
  const nowMs = Date.parse('2026-10-11T03:00:00.000Z');
  const paper: TradingPlan = {
    ...planInput(new Date(nowMs)), accountMode: 'paper',
    executionMode: 'automatic', id: 'cost-server-issuer',
    userId: USER_ID, idempotencyKey: 'cost-server-issuer',
    state: 'SUBMITTED', version: 1, approvalExpiresAt: null,
    approvedAt: new Date(nowMs).toISOString(),
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  };
  const rule = (market: string, exchange: string, fee = 0.05, tax = 0) => ({
    market, exchange, policyId: 'server-paper-cost-v1:validated-' + market + '-' + exchange,
    feeRatePercent: fee, taxRatePercent: tax,
    effectiveAt: '2026-10-10T00:00:00.000Z',
    expiresAt: '2026-10-12T00:00:00.000Z',
  });
  const rules = [
    rule('KR_STOCK', 'toss'), rule('KR_STOCK', 'kiwoom'),
    rule('US_STOCK', 'kiwoom'), rule('CRYPTO_SPOT', 'upbit'),
    rule('CRYPTO_FUTURES', 'bitget'),
  ];
  const encode = (rows: unknown[]) => JSON.stringify({
    contract: 'member-auto-paper-cost-rules/v1', rules: rows,
  });
  const valid = encode(rules);
  assert.equal(protectedAutomaticPaperCostPolicyV1(paper, nowMs, ''), null);
  assert.equal(protectedAutomaticPaperCostPolicyV1(paper, nowMs, 'not-json'), null);
  assert.equal(protectedAutomaticPaperCostPolicyV1({...paper, accountMode:'live'}, nowMs, valid), null);
  assert.equal(protectedAutomaticPaperCostPolicyV1({...paper, executionMode:'manual'}, nowMs, valid), null);
  assert.equal(protectedAutomaticPaperCostPolicyV1(paper, nowMs + 172_800_000, valid), null);
  assert.equal(protectedAutomaticPaperCostPolicyV1(paper, nowMs, encode([...rules, rules[3]])),
    null, 'duplicate market/exchange must fail closed');
  assert.equal(protectedAutomaticPaperCostPolicyV1(paper, nowMs, encode([
    ...rules.slice(0, 3), rule('CRYPTO_SPOT', 'upbit', 0.05, NaN), rules[4],
  ])), null, 'missing tax cannot become zero');
  assert.equal(protectedAutomaticPaperCostPolicyV1(paper, nowMs, encode([
    ...rules.slice(0, 3), rule('CRYPTO_SPOT', 'bitget'), rules[4],
  ])), null, 'wrong exchange cannot issue spot tax');
  assert.equal(protectedAutomaticPaperCostPolicyV1(paper, nowMs, encode([
    ...rules.slice(0, 3), {...rules[3], policyId: rules[2].policyId}, rules[4],
  ])), null, 'one policy ID cannot certify two different market rules');
  const issuer = protectedAutomaticPaperCostPolicyV1(paper, nowMs, valid);
  assert.ok(issuer);
  assert.equal(issuer.market, 'CRYPTO_SPOT');
  assert.equal(issuer.exchange, 'upbit');
  assert.equal(issuer.taxRatePercent, 0, 'explicit zero is allowed, never a default');
  const result = await serverPaperFillCostEvidence(paper, 100, 2, null, {
    costPolicy: async (plan, at) => protectedAutomaticPaperCostPolicyV1(plan, at, valid),
  }, nowMs);
  assert.equal(result.feeAmount, 0.1);
  assert.equal(result.taxAmount, 0);
  assert.equal(result.trustedPaperCostPolicyId, issuer.policyId);
  assert.equal(result.settlementFxEvidence?.source, 'NATIVE_KRW');
  const missing = await serverPaperFillCostEvidence(paper, 100, 2, null, {
    costPolicy: async (plan, at) => protectedAutomaticPaperCostPolicyV1(plan, at, ''),
  }, nowMs);
  assert.equal(missing.feeAmount, null);
  assert.equal(missing.taxAmount, null);
  assert.equal(missing.trustedPaperCostPolicyId, null);
});

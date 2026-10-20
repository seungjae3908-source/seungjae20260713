import './paper-futures-funding-certificate.service.test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import {
  TradeAutomationService,
  liveFillFxQuoteAcceptable,
  resolveLiveFillFxWitness,
  setLiveFillFxWitnessForTests,
} from './trade-automation.service';
import {
  paperSimulatedCostAmount, serverPaperFillCostEvidence,
  protectedAutomaticPaperCostPolicyV1,
  TradeExecutionService,
} from './trade-execution.service';
import { tradeAutomationJournalPayloadsFromSnapshot } from './trade-automation-unified-journal-adapter';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import { TradePreSubmissionRiskError } from './trade-pre-submission-risk.service';
import type { fetchPublicMarketJson } from './public-market-http';
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
  PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
  PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW,
  type TradingMarketSnapshot,
  type TradingPlanInput,
} from './trade-automation.types';
import {
  buildMarketCapitalAllocation,
  evaluateTradingPlan,
  finalAllowedEntryKrw,
  marketCapitalEntryBlockCodes,
  normalizeTradingPolicy,
  projectMarketLedger,
  requestedEntryExceedsAllowed,
} from './trade-automation-risk.service';
import { currentLiveMemberAccessMatchesBatch } from './member-auto-trading-background-worker.service';
import {
  buildBitgetSignature,
  prepareBitgetPendingProtection,
  prepareBitgetSinglePosition,
  upbitKrwAmountString,
  upbitMinimumOrderTotal,
  upbitVolumeString,
} from './trade-exchange-adapters.service';

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

test('current membership revocation or an unknown DB read blocks every AUTO provider before credentials or claims', async () => {
  for (const exchange of ['bitget', 'upbit', 'kiwoom', 'toss'] as const) {
    for (const unavailable of [false, true]) {
      const repository = new InMemoryTradingRepository();
      const now = new Date();
      const plan: TradingPlan = { ...planInput(now), id: 'revoked-plan', userId: USER_ID, exchange,
        executionMode: 'automatic', signalReasons: [], reduceOnly: false, state: 'SUBMITTED', version: 0,
        idempotencyKey: 'revoked-plan', approvedAt: now.toISOString(), approvalExpiresAt: null,
        createdAt: now.toISOString(), updatedAt: now.toISOString() };
      const order = { id: 'revoked-order', userId: USER_ID, planId: plan.id, exchange,
        state: 'SUBMITTED', submissionStartedAt: null } as TradingOrder;
      repository.getOrder = async () => order;
      let credentialReads = 0;
      repository.getConnection = async () => { credentialReads += 1; throw new Error('UNEXPECTED_CREDENTIAL_READ'); };
      const service = new TradeExecutionService(repository, undefined, undefined, undefined, () => true,
        async (userId) => { assert.equal(userId, USER_ID);
          if (unavailable) throw new Error('RAW_DB_ACCOUNT_SECRET'); return false; });
      await assert.rejects(service.execute(USER_ID, plan, order),
        (error: unknown) => error instanceof Error && error.message === 'AUTOMATIC_LIVE_MEMBER_ACCESS_REVOKED_OR_UNVERIFIED');
      assert.equal(credentialReads, 0);
      assert.equal((await repository.listOrders(USER_ID)).length, 0);
    }
  }
});

test('membership revoked during private account reads is rechecked before any financial mutation', async () => {
  let allowed = true; let checks = 0;
  const service = new TradeExecutionService(new InMemoryTradingRepository(), undefined, undefined, undefined, () => true,
    async () => { checks += 1; return allowed; });
  Object.assign(service, { async assertAutomaticLiveEntryControls() {},
    async assertAutomaticLivePositionIsolation() { allowed = false; } });
  const boundary = service as unknown as { assertAutomaticLiveEntryAuthorized(userId: string, plan: TradingPlan): Promise<void> };
  const now = new Date();
  const plan: TradingPlan = { ...planInput(now), id: 'late-revoked-plan', userId: USER_ID,
    executionMode: 'automatic', signalReasons: [], reduceOnly: false, state: 'SUBMITTED', version: 0,
    idempotencyKey: 'late-revoked-plan', approvedAt: now.toISOString(), approvalExpiresAt: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString() };
  await assert.rejects(boundary.assertAutomaticLiveEntryAuthorized(USER_ID,
    plan),
  /MEMBER_ACCESS_REVOKED_OR_UNVERIFIED/);
  assert.equal(checks, 2);
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

type UpbitMockOverride = (input: { pathname: string; method: string; json: (body: unknown, status?: number) => Response }) =>
  Response | Promise<Response> | undefined;

/** Fake Upbit with the REAL response shapes: /v1/accounts, /v1/ticker and
 * /v1/orderbook are top-level arrays and the order minimum is nested under
 * market.bid|ask.min_total, exactly as api.upbit.com returns them. */
function installUpbitMock(currentPrice: number, openOrders: Record<string, unknown>[] = [], override?: UpbitMockOverride) {
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
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (url.pathname === '/v1/orders' && method === 'POST') actualOrderPosts += 1;
    const overridden = override ? await override({ pathname: url.pathname, method, json }) : undefined;
    if (overridden) return overridden;
    if (url.pathname === '/v1/accounts') {
      return json([
        { currency: 'KRW', balance: '1000000', locked: '0', avg_buy_price: '0', unit_currency: 'KRW' },
        { currency: 'BTC', balance: '0', locked: '0', avg_buy_price: '0', unit_currency: 'KRW' },
      ]);
    }
    if (url.pathname === '/v1/orders/chance') {
      return json({
        bid_fee: '0.0005',
        ask_fee: '0.0005',
        maker_bid_fee: '0.0005',
        maker_ask_fee: '0.0005',
        market: {
          id: 'KRW-BTC', name: 'BTC/KRW', order_types: ['limit'], order_sides: ['ask', 'bid'],
          bid: { currency: 'KRW', min_total: '5000' },
          ask: { currency: 'BTC', min_total: '5000' },
          max_total: '1000000000', state: 'active',
        },
        bid_account: { currency: 'KRW', balance: '1000000', locked: '0' },
        ask_account: { currency: 'BTC', balance: '0', locked: '0' },
      });
    }
    if (url.pathname === '/v1/orders/open') {
      openOrderReads += 1;
      const requestedState = url.searchParams.get('state');
      return json(openOrders.filter((item) => String(item.state ?? 'wait') === requestedState));
    }
    if (url.pathname === '/v1/ticker') {
      return json([{ market: 'KRW-BTC', trade_price: currentPrice, timestamp: now, trade_timestamp: now }]);
    }
    if (url.pathname === '/v1/orderbook') {
      return json([{
        market: 'KRW-BTC',
        timestamp: now,
        orderbook_units: [
          { ask_price: currentPrice, ask_size: 10, bid_price: currentPrice - 100, bid_size: 10 },
          { ask_price: currentPrice + 10, ask_size: 10, bid_price: currentPrice - 110, bid_size: 10 },
          { ask_price: currentPrice + 20, ask_size: 10, bid_price: currentPrice - 120, bid_size: 10 },
        ],
      }]);
    }
    if (url.pathname === '/v1/orders/test') {
      orderTestPosts += 1;
      return json({ accepted: true });
    }
    if (url.pathname === '/v1/orders' && method === 'POST') {
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
  // The mocked account (1,000 USDT at price 100, 2x) is worth 200,000 KRW for
  // this plan; the futures fund ledger must declare no more than that, or the
  // ledger drift gate (tested separately below) rejects before the Arm boundary.
  await repository.savePolicy(USER_ID, {
    ...DEFAULT_TRADING_POLICY, mode: 'automatic', automaticEnabled: true,
    maxAssetClassKrw: { ...DEFAULT_TRADING_POLICY.maxAssetClassKrw, crypto_futures: 200_000 },
  });
  const now = new Date();
  const futuresPlan = {
    ...planInput(now),
    exchange: 'bitget' as const,
    symbol: 'BTCUSDT', market: 'USDT-FUTURES', side: 'long' as const,
    quantity: 1, quoteAmount: null, leverage: 2, marginMode: 'isolated' as const,
    // Valid Futures protection reaches the Arm boundary instead of using the
    // unrelated Upbit KRW protection inherited from planInput.
    entryPrice: 100, stopPrice: 95, targetPrices: [110],
    marketSnapshot: { ...marketSnapshot(now), currentPrice: 100, plannedPrice: 100 },
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
      maxAssetClassKrw: { ...DEFAULT_TRADING_POLICY.maxAssetClassKrw, crypto_futures: 200_000 },
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

test('the exchange minimum read from the real nested market.bid.min_total rejects a small buy before any POST', async () => {
  const { repository, approved, order } = await setup();
  const provider = installUpbitMock(100_000, [], ({ pathname, json }) => pathname === '/v1/orders/chance' ? json({
    bid_fee: '0.0005', ask_fee: '0.0005',
    market: { id: 'KRW-BTC', state: 'active', bid: { currency: 'KRW', min_total: '50000' }, ask: { currency: 'BTC', min_total: '50000' } },
  }) : undefined);
  const result = await new TradeExecutionService(repository).execute(USER_ID, approved, order);
  assert.equal(result.state, 'REJECTED');
  assert.equal(result.lastErrorCode, 'UPBIT_MINIMUM_ORDER');
  assert.equal(result.submissionStartedAt ?? null, null);
  assert.equal(provider.counts().orderTestPosts, 0);
  assert.equal(provider.counts().actualOrderPosts, 0);
});

test('a 401 on the private account read rejects before the order test, the intent and any POST', async () => {
  const { repository, approved, order } = await setup();
  const provider = installUpbitMock(100_000, [], ({ pathname, json }) => pathname === '/v1/accounts'
    ? json({ error: { name: 'invalid_access_key', message: 'unauthorized' } }, 401) : undefined);
  const result = await new TradeExecutionService(repository).execute(USER_ID, approved, order);
  assert.equal(result.state, 'REJECTED');
  assert.equal(result.lastErrorCode, 'UPBIT_AUTH_FAILED');
  assert.equal(result.submissionStartedAt ?? null, null);
  assert.equal(provider.counts().orderTestPosts, 0);
  assert.equal(provider.counts().actualOrderPosts, 0);
});

test('an order POST that times out with an unknown result parks the order for reconciliation and is never resent', async () => {
  const { repository, approved, order } = await setup();
  const provider = installUpbitMock(100_000, [], ({ pathname, method }) => {
    if (pathname === '/v1/orders' && method === 'POST') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return undefined;
  });
  const execution = new TradeExecutionService(repository);
  const result = await execution.execute(USER_ID, approved, order);
  assert.equal(result.state, 'RECOVERY_REQUIRED');
  assert.equal(result.lastErrorCode, 'UPBIT_TIMEOUT');
  assert.ok(result.submissionStartedAt, 'the write-ahead intent survives the unknown result');
  assert.equal(provider.counts().actualOrderPosts, 1);

  const replay = await execution.execute(USER_ID, approved, result);
  assert.equal(provider.counts().actualOrderPosts, 1, 'a replay looks the order up instead of blindly resending');
  assert.notEqual(replay.state, 'SUBMITTED');
});

test('a 429 on the order POST is an unknown result too: parked for reconciliation, one POST, no retry', async () => {
  const { repository, approved, order } = await setup();
  const provider = installUpbitMock(100_000, [], ({ pathname, method, json }) => pathname === '/v1/orders' && method === 'POST'
    ? json({ error: { name: 'too_many_requests', message: 'rate limited' } }, 429) : undefined);
  const execution = new TradeExecutionService(repository);
  const result = await execution.execute(USER_ID, approved, order);
  assert.equal(result.state, 'RECOVERY_REQUIRED');
  assert.equal(result.lastErrorCode, 'UPBIT_RATE_LIMITED');
  assert.equal(provider.counts().actualOrderPosts, 1);
  await execution.execute(USER_ID, approved, result);
  assert.equal(provider.counts().actualOrderPosts, 1);
});

test('a persistence failure right after the exchange accepted the order never leads to a second POST', async () => {
  const { repository, approved, order } = await setup();
  const provider = installUpbitMock(100_000);
  const original = repository.transitionOrderAtomic.bind(repository);
  let failures = 0;
  repository.transitionOrderAtomic = (async (...args: Parameters<typeof original>) => {
    if (args[3].reason === 'EXCHANGE_ACCEPTED' && failures === 0) {
      failures += 1; throw new Error('DISK_FULL_ORDER_WRITE_FAILED');
    }
    return original(...args);
  }) as typeof original;
  const execution = new TradeExecutionService(repository);
  const result = await execution.execute(USER_ID, approved, order);
  assert.equal(provider.counts().actualOrderPosts, 1);
  assert.equal(failures, 1);
  assert.equal(result.state, 'RECOVERY_REQUIRED');
  assert.equal(result.lastErrorCode, 'DISK_FULL_ORDER_WRITE_FAILED');
  const stored = await repository.getOrder(USER_ID, order.id);
  assert.equal(stored?.state, 'RECOVERY_REQUIRED');
  assert.ok(stored?.submissionStartedAt);
  await execution.execute(USER_ID, approved, stored!);
  assert.equal(provider.counts().actualOrderPosts, 1, 'restart recovery reads the exchange, it does not resend');
});

test('a zero or missing ticker price rejects before the intent and any POST', async () => {
  const { repository, approved, order } = await setup();
  const provider = installUpbitMock(100_000, [], ({ pathname, json }) => pathname === '/v1/ticker'
    ? json([{ market: 'KRW-BTC', trade_price: 0, timestamp: Date.now() }]) : undefined);
  const result = await new TradeExecutionService(repository).execute(USER_ID, approved, order);
  assert.equal(result.state, 'REJECTED');
  assert.equal(result.submissionStartedAt ?? null, null);
  assert.equal(provider.counts().actualOrderPosts, 0);
});

// ---------------------------------------------------------------------------
// Per-market capital ledger, role caps, Bitget read signing and Upbit precision

function ledgerPlan(overrides: Partial<TradingPlanInput> = {}): TradingPlanInput {
  const observedAt = new Date().toISOString();
  return {
    exchange: 'upbit', accountMode: 'live', strategyId: 'breakout-v1', signalId: 'signal-1',
    symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'market', quantity: null,
    quoteAmount: 100_000, limitPrice: null, estimatedKrw: 100_000, stopPrice: 90_000,
    targetPrices: [110_000], splitRatios: [100], leverage: null, marginMode: null,
    reduceOnly: false, invalidateAction: 'hold', signalReasons: ['trend', 'volume'],
    marketSnapshot: {
      observedAt, riskObservedAt: observedAt, dataDelayMs: 0, oneMinuteMovePercent: 0.5,
      spreadPercent: 0.1, orderbookGapPercent: 0.2, halted: false, availableBalance: 1_000_000,
      accountValueKrw: 2_000_000, dailyPnlPercent: 0, assetExposurePercent: 5,
      openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
      currentPrice: 100_000, plannedPrice: 100_000, marketStatus: 'OPEN',
      availableLiquidityKrw: 1_000_000, estimatedSlippagePercent: 0.1, estimatedFeePercent: 0.05,
      correlatedExposurePercent: 0, signalState: 'entry_ready', signalObservedAt: observedAt,
    },
    ...overrides,
  };
}

const cryptoOnly = {
  marketEnabled: { domestic_stock: false, us_stock: false, crypto_spot: true, crypto_futures: true },
};

test('Bitget 1,000,000 + Upbit 1,000,000 inside a 2,000,000 total is a consistent two-ledger allocation', () => {
  const policy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY, ...cryptoOnly, totalCapitalKrw: 2_000_000,
    maxAssetClassKrw: { domestic_stock: 5_000, us_stock: 5_000, crypto_spot: 1_000_000, crypto_futures: 1_000_000 },
  }, PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW);
  const allocation = buildMarketCapitalAllocation(policy);
  assert.equal(allocation.status, 'CONSISTENT');
  assert.equal(allocation.enabledAllocatedKrw, 2_000_000);
  assert.equal(allocation.overAllocatedKrw, 0);
  assert.deepEqual(allocation.blockCodes, []);
  assert.deepEqual(allocation.markets.filter((row) => row.enabled).map((row) => [row.market, row.allocatedKrw]),
    [['crypto_spot', 1_000_000], ['crypto_futures', 1_000_000]]);
  const decision = evaluateTradingPlan(ledgerPlan(), policy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.equal(decision.blockCodes.includes('MARKET_CAPITAL_OVER_ALLOCATED'), false);
});

test('two markets allocated the same KRW (1M + 1M above a 1.5M total) block every live entry but never an exit', () => {
  const policy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY, ...cryptoOnly, totalCapitalKrw: 1_500_000,
    maxAssetClassKrw: { domestic_stock: 5_000, us_stock: 5_000, crypto_spot: 1_000_000, crypto_futures: 1_000_000 },
  }, PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW);
  const allocation = buildMarketCapitalAllocation(policy);
  assert.equal(allocation.status, 'OVER_ALLOCATED');
  assert.equal(allocation.overAllocatedKrw, 500_000);
  assert.deepEqual(allocation.blockCodes, ['MARKET_CAPITAL_OVER_ALLOCATED']);

  const live = evaluateTradingPlan(ledgerPlan(), policy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.ok(live.blockCodes.includes('MARKET_CAPITAL_OVER_ALLOCATED'));
  assert.equal(live.allowed, false);

  const exit = evaluateTradingPlan(ledgerPlan({ side: 'sell', reduceOnly: true, quantity: 0.5, quoteAmount: null,
    signalReasons: ['AUTO_EXIT_ENTRY_PLAN:test'] }), policy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.equal(exit.blockCodes.includes('MARKET_CAPITAL_OVER_ALLOCATED'), false);

  const paper = evaluateTradingPlan(ledgerPlan({ accountMode: 'paper' }), policy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.equal(paper.blockCodes.includes('MARKET_CAPITAL_OVER_ALLOCATED'), false);
  assert.deepEqual(marketCapitalEntryBlockCodes({ accountMode: 'live' }, policy, { riskReducing: true }), []);
});

test('the stored default policy declares no per-market base funds: it is reported as a shared pool, not blocked', () => {
  const allocation = buildMarketCapitalAllocation(normalizeTradingPolicy(DEFAULT_TRADING_POLICY));
  assert.equal(allocation.status, 'SHARED_POOL');
  assert.equal(allocation.totalCapitalKrw, 1_000_000);
  // three enabled markets each capped at the whole 1,000,000 total
  assert.equal(allocation.enabledAllocatedKrw, 3_000_000);
  assert.deepEqual(allocation.blockCodes, []);
});

test('a market ledger spends only its own allocation: reservations, margin, losses and costs reduce it; reserve is never added', () => {
  const clean = projectMarketLedger({ market: 'crypto_spot', allocatedKrw: 1_000_000, openOrderReservedKrw: 0,
    positionMarginKrw: 0, realizedPnlKrw: null, costsKrw: null, exchangeAvailableKrw: null });
  assert.equal(clean.availableKrw, 1_000_000);
  assert.equal(clean.driftStatus, 'UNVERIFIED');
  assert.equal(clean.realizedPnlKrw, null, 'unproven realized PnL stays null, never 0');
  assert.equal(clean.costsKrw, null, 'unverified costs stay null, never 0');

  const busy = projectMarketLedger({ market: 'crypto_futures', allocatedKrw: 1_000_000, openOrderReservedKrw: 200_000,
    positionMarginKrw: 300_000, realizedPnlKrw: -50_000, costsKrw: 1_500, exchangeAvailableKrw: 448_500 });
  assert.equal(busy.availableKrw, 1_000_000 - 200_000 - 300_000 - 50_000 - 1_500);
  assert.equal(busy.driftKrw, 0);
  assert.equal(busy.driftStatus, 'WITHIN_TOLERANCE');
  assert.deepEqual(busy.blockCodes, []);

  const profit = projectMarketLedger({ market: 'crypto_spot', allocatedKrw: 1_000_000, openOrderReservedKrw: 0,
    positionMarginKrw: 0, realizedPnlKrw: 80_000, costsKrw: 400, exchangeAvailableKrw: 5_000_000 });
  assert.equal(profit.availableKrw, 1_079_600);
  assert.equal(profit.driftStatus, 'WITHIN_TOLERANCE', 'extra reserve on the exchange is not drift');
});

test('an exchange balance short of the ledger beyond tolerance blocks new entries until resolved', () => {
  const short = projectMarketLedger({ market: 'crypto_spot', allocatedKrw: 1_000_000, openOrderReservedKrw: 0,
    positionMarginKrw: 0, realizedPnlKrw: 0, costsKrw: 0, exchangeAvailableKrw: 900_000 });
  assert.equal(short.driftKrw, -100_000);
  assert.equal(short.driftStatus, 'DRIFT_UNRESOLVED');
  assert.deepEqual(short.blockCodes, ['MARKET_LEDGER_EXCHANGE_DRIFT_UNRESOLVED']);
  const inside = projectMarketLedger({ market: 'crypto_spot', allocatedKrw: 1_000_000, openOrderReservedKrw: 0,
    positionMarginKrw: 0, realizedPnlKrw: 0, costsKrw: 0, exchangeAvailableKrw: 999_500 });
  assert.equal(inside.driftStatus, 'WITHIN_TOLERANCE');
});

test('the final allowed entry is the strictest of role cap, policy, market allocation, ledger, exchange balance and exchange max', () => {
  const base = { roleCapKrw: PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW, policyMaxOrderKrw: 1_000_000,
    marketAllocatedKrw: 1_000_000, ledgerAvailableKrw: 1_000_000, exchangeAvailableKrw: 1_000_000,
    exchangeMinimumKrw: 5_000, exchangeMaximumKrw: null };
  assert.deepEqual(finalAllowedEntryKrw(base), { allowedKrw: 1_000_000, bindingLimit: 'ROLE_CAP', blockCodes: [] });
  assert.equal(finalAllowedEntryKrw({ ...base, roleCapKrw: PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW }).allowedKrw, 500_000);
  assert.equal(finalAllowedEntryKrw({ ...base, ledgerAvailableKrw: 120_000 }).bindingLimit, 'LEDGER_AVAILABLE');
  assert.equal(finalAllowedEntryKrw({ ...base, exchangeAvailableKrw: 90_000 }).allowedKrw, 90_000);
  assert.equal(finalAllowedEntryKrw({ ...base, exchangeMaximumKrw: 70_000 }).bindingLimit, 'EXCHANGE_MAXIMUM');
  const tiny = finalAllowedEntryKrw({ ...base, ledgerAvailableKrw: 4_000 });
  assert.deepEqual(tiny.blockCodes, ['ALLOWED_ENTRY_BELOW_EXCHANGE_MINIMUM']);
  assert.deepEqual(finalAllowedEntryKrw({ ...base, ledgerAvailableKrw: 0 }).blockCodes,
    ['ALLOWED_ENTRY_BELOW_EXCHANGE_MINIMUM', 'ALLOWED_ENTRY_ZERO']);
  const member = finalAllowedEntryKrw({ ...base, roleCapKrw: PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW });
  assert.equal(requestedEntryExceedsAllowed(500_000, member), false);
  assert.equal(requestedEntryExceedsAllowed(500_001, member), true);
  assert.equal(requestedEntryExceedsAllowed(Number.NaN, member), true);
});

test('a member cannot obtain the administrator 1,000,000 cap through the policy body or a cached batch ceiling', () => {
  for (const requested of [999_999, 1_000_001, 5_000_000, Number.NaN, -1]) {
    const policy = normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, totalCapitalKrw: 5_000_000, maxOrderKrw: 1_000_000 }, requested);
    assert.equal(policy.maxOrderKrw, PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW, `requested cap ${requested} is not the administrator cap`);
    assert.ok(evaluateTradingPlan(ledgerPlan({ quoteAmount: 500_001, estimatedKrw: 500_001 }), policy,
      { emergencyStopped: false, serverLiveEnabled: true }).blockCodes.includes('MAX_ORDER_AMOUNT'));
  }
  const member = { membership_level: 'regular', role: 'user', status: 'approved', is_active: true };
  const spot = { exchange: 'upbit', accountMode: 'live', leverage: null } as const;
  assert.equal(currentLiveMemberAccessMatchesBatch(member, PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW, spot), false,
    'a member batch cached with the administrator ceiling is rejected');
  const admin = { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true };
  const adminPolicy = normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, totalCapitalKrw: 5_000_000, maxOrderKrw: 1_000_000 },
    PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW);
  assert.ok(evaluateTradingPlan(ledgerPlan({ quoteAmount: 1_000_001, estimatedKrw: 1_000_001 }), adminPolicy,
    { emergencyStopped: false, serverLiveEnabled: true }).blockCodes.includes('MAX_ORDER_AMOUNT'));
  assert.equal(currentLiveMemberAccessMatchesBatch(admin, PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW, spot), false,
    'an administrator batch cached with the member ceiling is stale and rejected');
});

test('Bitget private reads sign path?query exactly once even when the caller passes a ?-prefixed query', () => {
  const credentials = { apiKey: 'k', secretKey: 's', passphrase: 'p' };
  const position = prepareBitgetSinglePosition(credentials, 'BTCUSDT', '1700000000000');
  assert.ok(position.query.startsWith('?'), 'the fixed-path readonly transport still receives the ?-prefixed query');
  assert.equal(position.headers['ACCESS-SIGN'], buildBitgetSignature('s', '1700000000000', 'GET',
    '/api/v2/mix/position/single-position', 'productType=USDT-FUTURES&symbol=BTCUSDT&marginCoin=USDT', ''));
  assert.notEqual(position.headers['ACCESS-SIGN'], buildBitgetSignature('s', '1700000000000', 'GET',
    '/api/v2/mix/position/single-position', '?productType=USDT-FUTURES&symbol=BTCUSDT&marginCoin=USDT', ''));
  const pending = prepareBitgetPendingProtection(credentials, 'BTCUSDT', '123', '1700000000000');
  assert.equal(pending.headers['ACCESS-SIGN'], buildBitgetSignature('s', '1700000000000', 'GET',
    '/api/v2/mix/order/orders-plan-pending', 'planType=profit_loss&productType=USDT-FUTURES&symbol=BTCUSDT&orderId=123', ''));
});

test('Upbit order fields are rounded DOWN to exchange precision and the real nested min_total is read', () => {
  assert.equal(upbitVolumeString(0.123456789), '0.12345678');
  assert.equal(upbitVolumeString(1), '1');
  assert.equal(upbitVolumeString(0.01), '0.01');
  assert.equal(upbitVolumeString(0.1 + 0.2), '0.3');
  assert.throws(() => upbitVolumeString(0.000000001), /UPBIT_ORDER_VOLUME_BELOW_PRECISION/u);
  assert.throws(() => upbitVolumeString(0), /UPBIT_ORDER_VOLUME_INVALID/u);
  assert.throws(() => upbitVolumeString('abc'), /UPBIT_ORDER_VOLUME_INVALID/u);
  assert.equal(upbitKrwAmountString(20_000.7), '20000');
  assert.equal(upbitKrwAmountString(100_000), '100000');
  assert.throws(() => upbitKrwAmountString(0.4), /UPBIT_ORDER_AMOUNT_BELOW_PRECISION/u);
  assert.throws(() => upbitKrwAmountString(null), /UPBIT_ORDER_AMOUNT_INVALID/u);
  assert.equal(upbitMinimumOrderTotal({ market: { bid: { min_total: '5000' }, ask: { min_total: '5000' } } }, 'buy'), 5_000);
  assert.equal(upbitMinimumOrderTotal({ market: { bid: { min_total: '5000' }, ask: { min_total: '7000' } } }, 'sell'), 7_000);
  assert.equal(upbitMinimumOrderTotal({ bid: { min_total: '5000' } }, 'buy'), 5_000, 'flat legacy fixture shape');
  assert.equal(upbitMinimumOrderTotal({ market: { state: 'active' } }, 'buy'), null, 'unknown minimum is null, never 0');
});

function bitgetPreflightFetch(counters: { reads: number; mutations: number }, availableUsdt: string): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      counters.mutations += 1;
      throw new Error('MUTATING_BITGET_CALL_MUST_NOT_HAPPEN');
    }
    counters.reads += 1;
    const data = url.pathname.endsWith('/account/accounts')
      ? [{ marginCoin: 'USDT', available: availableUsdt, accountEquity: availableUsdt, posMode: 'one_way_mode' }]
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
}

test('Bitget live entry whose exchange balance falls short of the market fund ledger is rejected before any margin/leverage mutation', async () => {
  const previousFetch = globalThis.fetch;
  const envNames = [
    'TRADING_EMERGENCY_STOP', 'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
    'AUTO_TRADING', 'LIVE_AUTOMATIC_TRADING_ENABLED', 'LIVE_TRADING',
    'REAL_ORDER_ENABLED', 'PRIVATE_TRADING_API_ALLOWED',
    'DEPLOY_SHA', 'MEMBER_AUTO_TRADING_LIVE_ENTRY_ARM_PATH',
  ] as const;
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const repository = new InMemoryTradingRepository();
  // Policy declares a 1,000,000 KRW futures fund; the account only covers 200,000 KRW of it.
  await repository.savePolicy(USER_ID, { ...DEFAULT_TRADING_POLICY, mode: 'automatic', automaticEnabled: true });
  const now = new Date();
  const futuresPlan = {
    ...planInput(now),
    exchange: 'bitget' as const,
    symbol: 'BTCUSDT', market: 'USDT-FUTURES', side: 'long' as const,
    quantity: 1, quoteAmount: null, leverage: 2, marginMode: 'isolated' as const,
    entryPrice: 100, stopPrice: 95, targetPrices: [110],
    marketSnapshot: { ...marketSnapshot(now), currentPrice: 100, plannedPrice: 100 },
    reduceOnly: false, executionMode: 'automatic' as const,
    id: 'bitget-ledger-plan', userId: USER_ID, idempotencyKey: 'bitget-ledger-plan-key',
    state: 'SUBMITTED' as const, version: 1, approvedAt: now.toISOString(),
    approvalExpiresAt: new Date(now.getTime() + 600_000).toISOString(),
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  await repository.savePlan(futuresPlan as unknown as TradingPlan);
  const futuresOrder = {
    id: 'bitget-ledger-order', userId: USER_ID,
    clientOrderId: 'bitget-ledger-order-oid', exchange: 'bitget' as const,
    planId: futuresPlan.id, state: 'SUBMITTED' as const,
  };
  const counters = { reads: 0, mutations: 0 };
  const executor = new TradeExecutionService(repository);
  Object.assign(executor, {
    riskService: {
      async evaluate(input: { expectedPlan: TradingPlan; snapshot: TradingMarketSnapshot }) {
        return { plan: input.expectedPlan, snapshot: input.snapshot,
          checkedAt: now.toISOString(), priceDriftPercent: 0,
          allowed: true, blockCodes: [], warnings: [] };
      },
    },
  });
  const privateBitget = executor as unknown as {
    executeBitget(userId: string, plan: unknown, order: unknown, credentials: unknown): Promise<unknown>;
  };
  globalThis.fetch = bitgetPreflightFetch(counters, '1000');
  try {
    process.env.TRADING_EMERGENCY_STOP = 'false';
    for (const key of envNames.slice(1, 7)) process.env[key] = 'true';
    process.env.DEPLOY_SHA = 'a'.repeat(40);
    process.env.MEMBER_AUTO_TRADING_LIVE_ENTRY_ARM_PATH = '/nonexistent-arm-boundary/auto-entry-arm.json';
    const credentials = { apiKey: 'ci-key', secretKey: 'ci-secret', passphrase: 'ci-pass' };
    await assert.rejects(
      () => privateBitget.executeBitget(USER_ID, futuresPlan, futuresOrder, credentials),
      (error: unknown) => error instanceof TradePreSubmissionRiskError
        && error.result.blockCodes.includes('MARKET_LEDGER_EXCHANGE_DRIFT_UNRESOLVED'),
    );
    assert.equal(counters.reads, 6, 'only the six read-only preflight requests ran');
    assert.equal(counters.mutations, 0, 'drift blocks before margin mode, leverage or order POST');

    // Declaring the fund the account actually holds clears the drift; the next
    // boundary (the exact-SHA Arm) then decides, still without any mutation.
    await repository.savePolicy(USER_ID, {
      ...DEFAULT_TRADING_POLICY, mode: 'automatic', automaticEnabled: true,
      maxAssetClassKrw: { ...DEFAULT_TRADING_POLICY.maxAssetClassKrw, crypto_futures: 200_000 },
    });
    await assert.rejects(
      () => privateBitget.executeBitget(USER_ID, futuresPlan, futuresOrder, credentials),
      /AUTOMATIC_LIVE_ENTRY_ARM_NOT_READY/,
    );
    assert.equal(counters.mutations, 0);

    // A request above the strictest cap (here the 200,000 KRW fund) is rejected, never trimmed.
    await assert.rejects(
      () => privateBitget.executeBitget(USER_ID, { ...futuresPlan, estimatedKrw: 250_000 }, futuresOrder, credentials),
      (error: unknown) => error instanceof TradePreSubmissionRiskError
        && error.result.blockCodes.includes('ALLOWED_ENTRY_EXCEEDED'),
    );
    assert.equal(counters.mutations, 0);
  } finally {
    globalThis.fetch = previousFetch;
    for (const name of envNames) {
      const prior = previousEnv[name];
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }
});

async function seedLiveBitgetAcceptedOrder(repository: InMemoryTradingRepository, id: string, fillAt: Date, overrides: Partial<TradingPlan> = {}) {
  const createdAt = new Date(fillAt.getTime() - 60_000).toISOString();
  await repository.savePlan({
    id: `${id}-plan`, userId: USER_ID, idempotencyKey: `${id}-key`, state: 'SUBMITTED', version: 1,
    accountMode: 'live', executionMode: 'automatic', exchange: 'bitget', strategyId: 'stat-arb-v1',
    signalId: `${id}-signal`, symbol: 'BTCUSDT', market: 'USDT-FUTURES', side: 'long', orderType: 'market', quantity: 0.01,
    quoteAmount: null, limitPrice: null, estimatedKrw: 100_000, entryPrice: 100_000, stopPrice: 95_000,
    targetPrices: [110_000], splitRatios: [100], leverage: 1, marginMode: 'isolated', reduceOnly: false,
    invalidateAction: 'hold', signalReasons: ['CANONICAL_LIVE_AUTO_HANDOFF'],
    marketSnapshot: { observedAt: createdAt }, approvedAt: createdAt, approvalExpiresAt: null,
    createdAt, updatedAt: createdAt, ...overrides,
  } as never);
  const order = {
    id, userId: USER_ID, planId: `${id}-plan`, exchange: overrides.exchange ?? 'bitget', clientOrderId: `${id}-client`,
    exchangeOrderId: `${id}-exchange`, state: 'ACCEPTED', version: 1, requestedQuantity: 0.01,
    filledQuantity: 0, averageFillPrice: null, retryCount: 0, lastErrorCode: null,
    exchangeUpdatedAt: fillAt.toISOString(),
    createdAt, updatedAt: createdAt,
  } as unknown as TradingOrder;
  await repository.saveOrder(order);
  return (await repository.getOrder(USER_ID, id))!;
}

test('a live Bitget fill reported by exchange reconciliation gets a server-read fill-time KRW-USDT witness; outage or window miss leaves it unverified', async () => {
  const repository = new InMemoryTradingRepository();
  const automation = new TradeAutomationService(repository);
  const fillAt = new Date('2026-10-20T04:12:40.000Z');
  const calls: Array<{ currency: string; fillAtMs: number }> = [];
  try {
    setLiveFillFxWitnessForTests(async (input) => {
      calls.push(input);
      return { krwPerQuoteCurrency: 1_390.5, source: 'UPBIT:KRW-USDT',
        observedAt: new Date(input.fillAtMs - 40_000).toISOString() };
    });
    const filled = await automation.transition(await seedLiveBitgetAcceptedOrder(repository, 'live-fill-fx', fillAt), 'FILLED',
      'EXCHANGE_ORDER_RECONCILED', { filledQuantity: 0.01, averageFillPrice: 100_000 });
    assert.equal(filled.state, 'FILLED');
    assert.deepEqual(filled.settlementFxEvidence, {
      krwPerQuoteCurrency: 1_390.5, source: 'UPBIT:KRW-USDT', observedAt: '2026-10-20T04:12:00.000Z',
    });
    assert.deepEqual(calls, [{ currency: 'USDT', fillAtMs: fillAt.getTime() }]);
    assert.deepEqual((await repository.getOrder(USER_ID, 'live-fill-fx'))?.settlementFxEvidence, filled.settlementFxEvidence,
      'the witness is persisted with the fill, where the live budget ledger reads it');

    // A partial fill carries the witness too, and a later full fill keeps a still-valid one.
    const partial = await automation.transition(await seedLiveBitgetAcceptedOrder(repository, 'live-partial-fx', fillAt), 'PARTIALLY_FILLED',
      'EXCHANGE_ORDER_RECONCILED', { filledQuantity: 0.005, averageFillPrice: 100_000 });
    assert.equal(partial.settlementFxEvidence?.source, 'UPBIT:KRW-USDT');
    calls.length = 0;
    const completed = await automation.transition(partial, 'FILLED', 'EXCHANGE_ORDER_RECONCILED',
      { filledQuantity: 0.01, averageFillPrice: 100_000 });
    assert.equal(completed.settlementFxEvidence?.observedAt, '2026-10-20T04:12:00.000Z');
    assert.equal(calls.length, 0, 'a witness still inside the fill window is not re-read');

    // Outage: the fill is still recorded, FX stays null (the budget ledger remains fail-closed).
    setLiveFillFxWitnessForTests(async () => { throw new Error('UPBIT_PUBLIC_UNAVAILABLE'); });
    const outage = await automation.transition(await seedLiveBitgetAcceptedOrder(repository, 'live-fill-outage', fillAt), 'FILLED',
      'EXCHANGE_ORDER_RECONCILED', { filledQuantity: 0.01, averageFillPrice: 100_000 });
    assert.equal(outage.state, 'FILLED');
    assert.equal(outage.settlementFxEvidence ?? null, null);

    // A quote older than the 10-minute USDT window, after the fill, or from another source is never attached.
    for (const quote of [
      { krwPerQuoteCurrency: 1_390, source: 'UPBIT:KRW-USDT', observedAt: new Date(fillAt.getTime() - 11 * 60_000).toISOString() },
      { krwPerQuoteCurrency: 1_390, source: 'UPBIT:KRW-USDT', observedAt: new Date(fillAt.getTime() + 6_000).toISOString() },
      { krwPerQuoteCurrency: 1_390, source: 'YAHOO:USDKRW=X', observedAt: new Date(fillAt.getTime() - 1_000).toISOString() },
      { krwPerQuoteCurrency: 0, source: 'UPBIT:KRW-USDT', observedAt: new Date(fillAt.getTime() - 1_000).toISOString() },
    ]) {
      assert.equal(liveFillFxQuoteAcceptable(quote, 'USDT', fillAt.getTime()), false, JSON.stringify(quote));
    }
    setLiveFillFxWitnessForTests(async () => ({ krwPerQuoteCurrency: 1_390, source: 'UPBIT:KRW-USDT',
      observedAt: new Date(fillAt.getTime() - 11 * 60_000).toISOString() }));
    const stale = await automation.transition(await seedLiveBitgetAcceptedOrder(repository, 'live-fill-stale', fillAt), 'FILLED',
      'EXCHANGE_ORDER_RECONCILED', { filledQuantity: 0.01, averageFillPrice: 100_000 });
    assert.equal(stale.settlementFxEvidence ?? null, null);

    // Native-KRW (Upbit) and Paper fills never consult the witness.
    calls.length = 0;
    setLiveFillFxWitnessForTests(async (input) => { calls.push(input); return null; });
    await automation.transition(await seedLiveBitgetAcceptedOrder(repository, 'live-fill-krw', fillAt,
      { exchange: 'upbit', symbol: 'KRW-BTC', market: 'KRW', side: 'buy', leverage: null, marginMode: null } as Partial<TradingPlan>),
    'FILLED', 'EXCHANGE_ORDER_RECONCILED', { filledQuantity: 0.01, averageFillPrice: 100_000 });
    await automation.transition(await seedLiveBitgetAcceptedOrder(repository, 'paper-fill', fillAt,
      { accountMode: 'paper' } as Partial<TradingPlan>),
    'FILLED', 'EXCHANGE_ORDER_RECONCILED', { filledQuantity: 0.01, averageFillPrice: 100_000 });
    assert.equal(calls.length, 0);
  } finally {
    setLiveFillFxWitnessForTests(null);
  }
});

test('resolveLiveFillFxWitness reads the public Upbit KRW-USDT minute candle that opened at or before the fill', async () => {
  const fillAtMs = Date.parse('2026-10-20T04:12:40.000Z');
  const requested: string[] = [];
  const publicJson = (async (url: string | URL) => {
    requested.push(String(url));
    return [{ market: 'KRW-USDT', candle_date_time_utc: '2026-10-20T04:12:00', opening_price: 1390.5, trade_price: 1391 }];
  }) as unknown as typeof fetchPublicMarketJson;
  const quote = await resolveLiveFillFxWitness({ currency: 'USDT', fillAtMs }, { publicJson });
  assert.deepEqual(quote, { krwPerQuoteCurrency: 1390.5, source: 'UPBIT:KRW-USDT', observedAt: '2026-10-20T04:12:00.000Z' });
  assert.equal(requested.length, 1);
  const url = new URL(requested[0]!);
  assert.equal(url.pathname, '/v1/candles/minutes/1');
  assert.equal(url.searchParams.get('market'), 'KRW-USDT');
  assert.equal(url.searchParams.get('count'), '1');
  assert.equal(url.searchParams.get('to'), '2026-10-20T04:12:41.000Z');

  // A candle that opened after the fill, a non-positive price or an empty payload yields no witness.
  for (const payload of [
    [{ candle_date_time_utc: '2026-10-20T04:13:00', opening_price: 1390.5 }],
    [{ candle_date_time_utc: '2026-10-20T04:12:00', opening_price: 0 }],
    [],
    null,
  ]) {
    const miss = await resolveLiveFillFxWitness({ currency: 'USDT', fillAtMs },
      { publicJson: (async () => payload) as unknown as typeof fetchPublicMarketJson });
    assert.equal(miss, null, JSON.stringify(payload));
  }
  // USD fills have no fill-time public witness here: nothing is fetched, FX stays unverified.
  requested.length = 0;
  assert.equal(await resolveLiveFillFxWitness({ currency: 'USD', fillAtMs }, { publicJson }), null);
  assert.equal(requested.length, 0);
});

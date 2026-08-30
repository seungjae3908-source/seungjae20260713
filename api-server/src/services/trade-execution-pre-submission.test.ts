import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { TradeExecutionService } from './trade-execution.service';
import { buildBitgetExecutionSnapshot, buildUpbitExecutionSnapshot } from './trade-execution-snapshot.service';
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

test('execution snapshot rejects wrong identity and malformed positions instead of assuming an empty account', async () => {
  const { approved } = await setup();
  const now = Date.now();
  const input = {
    plan: { ...approved, exchange: 'bitget' as const, market: 'USDT-FUTURES', symbol: 'BTCUSDT', leverage: 2 },
    accounts: [{ marginCoin: 'USDT', available: '10000', accountEquity: '100000' }],
    positions: [] as Record<string, unknown>[],
    ticker: [{ symbol: 'BTCUSDT', markPrice: '100000', ts: now }],
    depth: { bids: [[99999, 10], [99998, 10]], asks: [[100001, 10], [100002, 10]], ts: now },
    contract: { symbol: 'BTCUSDT', takerFeeRate: '0.0005' },
    fxQuote: { currency: 'USDT' as const, krwRate: 1400, source: 'isolated-FX-fixture', asOf: new Date(now).toISOString(), quality: 'DELAYED' as const },
    signal: null,
  };
  assert.equal(buildBitgetExecutionSnapshot(input).openPositionCount, 0);
  const snapshot = buildBitgetExecutionSnapshot(input);
  assert.equal(snapshot.availableBalance, 14_000_000);
  assert.equal(snapshot.accountValueKrw, 140_000_000);
  assert.equal(snapshot.availableLiquidityKrw, 2_800_042_000);
  assert.deepEqual(snapshot.currencyConversion, { pair: 'USDT/KRW', krwRate: 1400, source: 'isolated-FX-fixture', asOf: new Date(now).toISOString() });
  for (const estimatedKrw of [1, 1_000_000_000]) {
    const changed = buildBitgetExecutionSnapshot({ ...input, plan: { ...input.plan, estimatedKrw } });
    assert.equal(changed.availableBalance, snapshot.availableBalance);
    assert.equal(changed.accountValueKrw, snapshot.accountValueKrw);
    assert.equal(changed.availableLiquidityKrw, snapshot.availableLiquidityKrw);
  }
  for (const fxQuote of [undefined, { ...input.fxQuote, currency: 'USD' as const }, { ...input.fxQuote, source: '' },
    { ...input.fxQuote, krwRate: NaN }, { ...input.fxQuote, krwRate: 0 }, { ...input.fxQuote, quality: 'STALE' as const },
    { ...input.fxQuote, asOf: new Date(now - 300_001).toISOString() }, { ...input.fxQuote, asOf: new Date(now + 60_000).toISOString() }]) {
    assert.throws(() => buildBitgetExecutionSnapshot({ ...input, fxQuote }), /FX_UNAVAILABLE/);
  }
  assert.throws(() => buildBitgetExecutionSnapshot({ ...input, fxQuote: { ...input.fxQuote, krwRate: Number.MAX_VALUE } }), /OVERFLOW/);
  assert.equal(buildBitgetExecutionSnapshot({ ...input, positions: [
    { symbol: 'ETHUSDT', total: '1', holdSide: 'long' },
    { symbol: 'SOLUSDT', total: '2', holdSide: 'short' },
  ] }).openPositionCount, 2);
  for (const positions of [undefined, null, {}, [null], [{ symbol: 'BTCUSDT', total: true }], [{ symbol: 'BTCUSDT', total: '-1' }]]) {
    assert.throws(() => buildBitgetExecutionSnapshot({ ...input, positions }), /EXECUTION_/);
  }
  assert.throws(() => buildBitgetExecutionSnapshot({ ...input, ticker: [{ symbol: 'ETHUSDT', markPrice: '100000', ts: now }] }), /IDENTITY/);
  assert.throws(() => buildBitgetExecutionSnapshot({ ...input, accounts: [{ marginCoin: 'USDC', available: '10000' }] }), /IDENTITY/);
  assert.throws(() => buildBitgetExecutionSnapshot({ ...input, accounts: [{ marginCoin: 'USDT', available: true, accountEquity: '100000' }] }), /EVIDENCE/);
  assert.throws(() => buildBitgetExecutionSnapshot({ ...input, accounts: [{ marginCoin: 'USDT', available: '10000' }] }), /EQUITY/);
  assert.throws(() => buildBitgetExecutionSnapshot({ ...input, contract: { symbol: 'ETHUSDT' } }), /IDENTITY/);
  for (const ts of [null, undefined, true, Math.floor(now / 1000), now + 60_000]) {
    const result = buildBitgetExecutionSnapshot({ ...input, depth: { ...input.depth, ts } });
    assert.equal(result.observedAt, '');
    assert.equal(result.dataDelayMs, Infinity);
  }
});

test('Upbit snapshot keeps locked holdings in exposure and validates both quote and orderbook identity', async () => {
  const { approved } = await setup();
  const now = Date.now();
  const input = {
    plan: approved,
    accounts: { data: [{ currency: 'KRW', balance: '1000000', locked: '0' }, { currency: 'BTC', balance: '0', locked: '1' }] },
    chance: { market: { state: 'active' }, bid_fee: '0.0005' },
    ticker: { data: [{ market: 'KRW-BTC', trade_price: 100_000, timestamp: now }] },
    orderbook: { data: [{ market: 'KRW-BTC', timestamp: now, orderbook_units: [
      { bid_price: 99999, bid_size: 10, ask_price: 100001, ask_size: 10 },
      { bid_price: 99998, bid_size: 10, ask_price: 100002, ask_size: 10 },
    ] }] },
    signal: null,
  };
  const snapshot = buildUpbitExecutionSnapshot(input);
  assert.equal(snapshot.availableLiquidityKrw, 2_000_030);
  assert.equal(buildUpbitExecutionSnapshot({ ...input, plan: { ...approved, estimatedKrw: 1 } }).availableLiquidityKrw, 2_000_030);
  assert.equal(snapshot.openPositionCount, 1);
  assert.equal(snapshot.assetExposurePercent, 2);
  assert.equal(buildUpbitExecutionSnapshot({ ...input, chance: {} }).marketStatus, 'UNKNOWN');
  assert.throws(() => buildUpbitExecutionSnapshot({ ...input, ticker: { data: [{ market: 'KRW-ETH', trade_price: 100_000, timestamp: now }] } }), /IDENTITY/);
  assert.throws(() => buildUpbitExecutionSnapshot({ ...input, orderbook: { data: [{ ...input.orderbook.data[0], market: 'KRW-ETH' }] } }), /IDENTITY/);
  for (const accounts of [{}, { data: [null] }, { data: [{ currency: 'KRW', balance: true, locked: '0' }] }]) {
    assert.throws(() => buildUpbitExecutionSnapshot({ ...input, accounts }), /EXECUTION_/);
  }
  assert.equal(buildUpbitExecutionSnapshot({ ...input, ticker: { data: [{ market: 'KRW-BTC', trade_price: 100_000 }] } }).observedAt, '');
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

async function setup(overrides: Partial<TradingPlanInput> = {}) {
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  process.env.ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
  process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';
  process.env.BITGET_LIVE_ORDER_ENABLED = 'true';
  setTradingPlanMarketIntelligenceRunnerForTests(eligibleMarketIntelligence);
  setTradeProfitabilityAttestationRunnerForTests(allowServerProfitabilityAttestationForTests);
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER_ID, {
    ...DEFAULT_TRADING_POLICY,
    pilotStage: 'limited-50',
  });
  const input = { ...planInput(new Date()), ...overrides };
  await repository.saveConnection({
    userId: USER_ID,
    exchange: input.exchange,
    accountMode: 'live',
    configured: true,
    encryptedCredentials: encryptTradingCredentials(input.exchange === 'bitget'
      ? { apiKey: 'isolated-fixture', secretKey: 'isolated-fixture', passphrase: 'isolated-fixture' }
      : { accessKey: 'access', secretKey: 'secret' }),
    lastVerifiedAt: new Date().toISOString(),
    lastErrorCode: null,
    updatedAt: new Date().toISOString(),
  });
  const automation = new TradeAutomationService(repository);
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
  delete process.env.UPBIT_LIVE_ORDER_ENABLED;
  delete process.env.BITGET_LIVE_ORDER_ENABLED;
}

test.afterEach(resetEnvironment);

test('Bitget execution obtains server FX and rejects unavailable or stale conversion before any exchange mutation', async () => {
  for (const fxState of ['unavailable', 'stale'] as const) {
    const { repository, approved, order } = await setup({ exchange: 'bitget', market: 'USDT-FUTURES', symbol: 'BTCUSDT',
      side: 'long', quantity: 0.00014, quoteAmount: null, leverage: 2, marginMode: 'isolated' });
    let mutations = 0;
    let fxReads = 0;
    globalThis.fetch = async (request, init) => {
      const url = new URL(String(request));
      if ((init?.method ?? 'GET') !== 'GET') { mutations++; throw new Error('UNEXPECTED_MUTATION'); }
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      const now = Date.now();
      if (url.hostname === 'api.upbit.com' && url.pathname === '/v1/ticker' && url.searchParams.get('markets') === 'KRW-USDT') {
        fxReads++;
        return fxState === 'unavailable' ? json({}, 503) : json([{ market: 'KRW-USDT', trade_price: 1400, timestamp: now - 600_000 }]);
      }
      assert.equal(url.hostname, 'api.bitget.com');
      const data: Record<string, unknown> = {
        '/api/v2/mix/account/accounts': [{ marginCoin: 'USDT', available: '10000', accountEquity: '100000', posMode: 'one_way_mode' }],
        '/api/v2/mix/position/all-position': [], '/api/v2/mix/order/orders-pending': { entrustedList: [] },
        '/api/v2/mix/market/contracts': [{ symbol: 'BTCUSDT', minTradeNum: '0.00001', sizeMultiplier: '0.00001', minTradeUSDT: '5',
          quoteCoin: 'USDT', supportMarginCoins: ['USDT'], minLever: '1', maxLever: '100',
          symbolStatus: 'normal', takerFeeRate: '0.0005', maxMarketOrderQty: '10' }],
        '/api/v2/mix/market/ticker': [{ symbol: 'BTCUSDT', markPrice: '100000', ts: now }],
        '/api/v2/mix/market/merge-depth': { bids: [[99999, 10], [99998, 10]], asks: [[100001, 10], [100002, 10]], ts: now },
      };
      assert.ok(Object.hasOwn(data, url.pathname), `unexpected isolated fixture request: ${url.pathname}`);
      return json({ code: '00000', data: data[url.pathname] });
    };
    const result = await new TradeExecutionService(repository).execute(USER_ID, approved, order);
    assert.equal(result.state, 'REJECTED');
    assert.match(result.lastErrorCode ?? '', /FX_/);
    assert.equal(fxReads, 1);
    assert.equal(mutations, 0);
    assert.equal(result.submissionStartedAt ?? null, null);
  }
});

test('Bitget invalid contract or quote evidence blocks all exchange mutations before submission intent', async () => {
  const contract = { symbol: 'BTCUSDT', quoteCoin: 'USDT', supportMarginCoins: ['USDT'], minLever: '1', maxLever: '100',
    minTradeNum: '0.00001', sizeMultiplier: '0.00001', minTradeUSDT: '5',
    symbolStatus: 'normal', takerFeeRate: '0.0005', maxMarketOrderQty: '10' };
  const cases = [
    { contracts: [{ ...contract, minTradeUSDT: undefined }], code: /BITGET_CONTRACT_RULES_UNAVAILABLE/ },
    { contracts: [{ ...contract, maxMarketOrderQty: true }], code: /BITGET_CONTRACT_RULES_UNAVAILABLE/ },
    { contracts: [contract, contract], code: /BITGET_CONTRACT_RULES_UNAVAILABLE/ },
    { contracts: [{ ...contract, symbol: 'ETHUSDT' }], code: /BITGET_CONTRACT_RULES_UNAVAILABLE/ },
    { contracts: [{ ...contract, symbolStatus: 'maintain' }], code: /BITGET_CONTRACT_NOT_TRADABLE/ },
    { ticker: [{ symbol: 'ETHUSDT', markPrice: '100000' }], code: /BITGET_TICKER_IDENTITY_INVALID/ },
    { ticker: [{ symbol: 'BTCUSDT', markPrice: '100000' }, { symbol: 'BTCUSDT', markPrice: '100000' }], code: /BITGET_TICKER_IDENTITY_INVALID/ },
    { ticker: [{ symbol: 'BTCUSDT', markPrice: true }], code: /BITGET_REFERENCE_PRICE_INVALID/ },
  ];
  for (const invalid of cases) {
    const { repository, approved, order } = await setup({ exchange: 'bitget', market: 'USDT-FUTURES', symbol: 'BTCUSDT',
      side: 'long', quantity: 0.00014, quoteAmount: null, leverage: 2, marginMode: 'isolated' });
    let mutations = 0;
    globalThis.fetch = async (request, init) => {
      const url = new URL(String(request));
      if ((init?.method ?? 'GET') !== 'GET') { mutations++; throw new Error('UNEXPECTED_MUTATION'); }
      const json = (body: unknown) => new Response(JSON.stringify(body));
      const now = Date.now();
      if (url.hostname === 'api.upbit.com' && url.pathname === '/v1/ticker' && url.searchParams.get('markets') === 'KRW-USDT') {
        return json([{ market: 'KRW-USDT', trade_price: 1400, timestamp: now }]);
      }
      assert.equal(url.hostname, 'api.bitget.com');
      const data: Record<string, unknown> = {
        '/api/v2/mix/account/accounts': [{ marginCoin: 'USDT', available: '10000', accountEquity: '100000', posMode: 'one_way_mode' }],
        '/api/v2/mix/position/all-position': [], '/api/v2/mix/order/orders-pending': { entrustedList: [] },
        '/api/v2/mix/market/contracts': invalid.contracts ?? [contract],
        '/api/v2/mix/market/ticker': invalid.ticker ?? [{ symbol: 'BTCUSDT', markPrice: '100000', ts: now }],
        '/api/v2/mix/market/merge-depth': { bids: [[99999, 10]], asks: [[100001, 10]], ts: now },
      };
      assert.ok(Object.hasOwn(data, url.pathname), `unexpected isolated fixture request: ${url.pathname}`);
      return json({ code: '00000', data: data[url.pathname] });
    };
    const result = await new TradeExecutionService(repository).execute(USER_ID, approved, order);
    assert.equal(result.state, 'REJECTED');
    assert.match(result.lastErrorCode ?? '', invalid.code);
    assert.equal(result.submissionStartedAt ?? null, null);
    assert.equal(mutations, 0);
  }
});

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

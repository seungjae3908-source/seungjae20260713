import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeExecutionCoordinator } from './trade-execution-coordinator.service';
import { encryptTradingCredentials } from './trade-credential-vault.service';
import type { ExchangeConnection, TradingOrder, TradingPlan } from './trade-automation.types';

const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MASTER_KEY = Buffer.alloc(32, 23).toString('base64');
const ENV_KEYS = [
  'TRADING_CREDENTIAL_MASTER_KEY',
  'ORDER_EXECUTION_ENABLED',
  'LIVE_TRADING_ACTIVATION_APPROVED',
  'UPBIT_LIVE_ORDER_ENABLED',
  'BITGET_LIVE_ORDER_ENABLED',
  'KIWOOM_MOCK_ORDER_ENABLED',
  'KIWOOM_ALLOW_OFF_HOURS',
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnvironment() {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function basePlan(overrides: Partial<TradingPlan> = {}): TradingPlan {
  const now = new Date().toISOString();
  return {
    id: '90000000-0000-0000-0000-000000000001',
    userId: USER,
    idempotencyKey: 'ambiguous-response-plan',
    exchange: 'upbit',
    accountMode: 'live',
    strategyId: 'response-safety',
    signalId: 'response-safety-signal',
    symbol: 'BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'market',
    quantity: null,
    quoteAmount: 50_000,
    limitPrice: null,
    estimatedKrw: 50_000,
    stopPrice: 90_000,
    targetPrices: [110_000],
    splitRatios: [100],
    leverage: null,
    marginMode: null,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: ['test'],
    marketSnapshot: {
      observedAt: now,
      dataDelayMs: 0,
      oneMinuteMovePercent: 0,
      spreadPercent: 0.05,
      orderbookGapPercent: 0.05,
      halted: false,
      availableBalance: 1_000_000,
      accountValueKrw: 1_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 0,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
      currentPrice: 100_000,
      correlatedExposurePercent: 0,
    },
    signalState: 'confirmed',
    signalExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    entryPrice: 100_000,
    entryZoneLow: 99_000,
    entryZoneHigh: 101_000,
    estimatedSlippagePercent: 0.05,
    averageSpreadPercent: 0.05,
    economics: null,
    state: 'SUBMITTED',
    approvalExpiresAt: null,
    approvedAt: now,
    createdAt: now,
    updatedAt: now,
    riskAssessment: null,
    ...overrides,
  };
}

function baseOrder(plan: TradingPlan, overrides: Partial<TradingOrder> = {}): TradingOrder {
  const now = new Date().toISOString();
  return {
    id: '91000000-0000-0000-0000-000000000001',
    userId: USER,
    planId: plan.id,
    exchange: plan.exchange,
    clientOrderId: `sj-${plan.exchange}-ambiguous-response`,
    exchangeOrderId: null,
    state: 'SUBMITTED',
    requestedQuantity: plan.quantity ?? null,
    filledQuantity: 0,
    averageFillPrice: null,
    retryCount: 0,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function seed(
  repository: InMemoryTradingRepository,
  plan: TradingPlan,
  order: TradingOrder,
  credentials: Record<string, string>,
) {
  await repository.insertPlan(plan);
  await repository.insertOrder(order);
  const connection: ExchangeConnection = {
    userId: USER,
    exchange: plan.exchange,
    accountMode: plan.accountMode,
    configured: true,
    encryptedCredentials: encryptTradingCredentials(credentials),
    lastVerifiedAt: null,
    lastErrorCode: null,
    updatedAt: new Date().toISOString(),
  };
  await repository.saveConnection(connection);
}

function enableLive(exchange: 'upbit' | 'bitget') {
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  process.env.ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
  process.env[exchange === 'upbit' ? 'UPBIT_LIVE_ORDER_ENABLED' : 'BITGET_LIVE_ORDER_ENABLED'] = 'true';
}

test.afterEach(() => {
  restoreEnvironment();
});

async function runAmbiguousUpbitPlacement(
  placementResponse: () => Promise<Response> | Response,
) {
  enableLive('upbit');
  const repository = new InMemoryTradingRepository();
  const plan = basePlan();
  const order = baseOrder(plan);
  await seed(repository, plan, order, { accessKey: 'access', secretKey: 'secret' });
  const coordinator = new TradeExecutionCoordinator(repository);
  const nativeFetch = globalThis.fetch;
  let placements = 0;
  let queries = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    if (url.includes('/v1/accounts')) return json([{ currency: 'KRW', balance: '1000000' }]);
    if (url.includes('/v1/orders/chance')) return json({ market: { state: 'active' }, bid: { min_total: '5000' } });
    if (url.endsWith('/v1/orders/test') && method === 'POST') return json({ accepted: true });
    if (url.endsWith('/v1/orders') && method === 'POST') {
      placements += 1;
      return placementResponse();
    }
    if (url.includes('/v1/order?') && method === 'GET') {
      queries += 1;
      return json({ identifier: order.clientOrderId, state: 'unknown' });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const result = await coordinator.execute(USER, plan, order);
    assert.equal(result.state, 'RECOVERY_REQUIRED');
    assert.equal(placements, 1);
    assert.equal(queries, 1);
    const reasons = (await repository.listEvents(USER)).map((event) => event.reason);
    assert.ok(reasons.includes('AMBIGUOUS_EXCHANGE_SUBMISSION_RESPONSE'));
    assert.ok(reasons.includes('RECONCILIATION_QUERY_UNRESOLVED'));
    return { result, reasons };
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

for (const scenario of [
  { name: 'empty response', response: () => new Response('', { status: 200 }) },
  { name: 'invalid JSON', response: () => new Response('{not-json', { status: 200 }) },
  { name: 'missing uuid and exact identifier', response: () => json({}) },
  { name: 'HTTP 502', response: () => json({ error: 'gateway' }, 502) },
]) {
  test(`Upbit ${scenario.name} after one placement stays recovery-required without resubmission`, async () => {
    await runAmbiguousUpbitPlacement(scenario.response);
  });
}

test('Bitget missing success code after one placement stays recovery-required and reuses clientOid for query', async () => {
  enableLive('bitget');
  const repository = new InMemoryTradingRepository();
  const plan = basePlan({
    id: '90000000-0000-0000-0000-000000000002',
    idempotencyKey: 'bitget-invalid-response',
    exchange: 'bitget',
    symbol: 'BTCUSDT',
    market: 'USDT-FUTURES',
    side: 'long',
    quantity: 1,
    quoteAmount: null,
    leverage: 2,
    marginMode: 'isolated',
  });
  const order = baseOrder(plan, {
    id: '91000000-0000-0000-0000-000000000002',
    clientOrderId: 'sj-bitget-exact-client-oid',
    requestedQuantity: 1,
  });
  await seed(repository, plan, order, { apiKey: 'key', secretKey: 'secret', passphrase: 'pass' });
  const coordinator = new TradeExecutionCoordinator(repository);
  const nativeFetch = globalThis.fetch;
  let placements = 0;
  let detailQueries = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    if (url.includes('/api/v2/mix/account/accounts')) {
      return json({ code: '00000', data: [{ marginCoin: 'USDT', available: '1000000', posMode: 'one_way_mode' }] });
    }
    if (url.includes('/api/v2/mix/position/all-position')) return json({ code: '00000', data: [] });
    if (url.includes('/api/v2/mix/order/orders-pending')) return json({ code: '00000', data: { entrustedList: [] } });
    if (url.includes('/api/v2/mix/market/contracts')) {
      return json({ code: '00000', data: [{ symbol: 'BTCUSDT', minTradeNum: '0.001', sizeMultiplier: '0.001', symbolStatus: 'normal' }] });
    }
    if (url.includes('/api/v2/mix/market/ticker')) return json({ code: '00000', data: [{ symbol: 'BTCUSDT', markPrice: '100' }] });
    if (url.includes('/api/v2/mix/account/set-margin-mode')) return json({ code: '00000', data: {} });
    if (url.includes('/api/v2/mix/account/set-leverage')) return json({ code: '00000', data: {} });
    if (url.includes('/api/v2/mix/order/place-order') && method === 'POST') {
      placements += 1;
      return json({ data: { orderId: 'must-not-be-trusted' } });
    }
    if (url.includes('/api/v2/mix/order/detail') && method === 'GET') {
      detailQueries += 1;
      assert.ok(url.includes('clientOid=sj-bitget-exact-client-oid'));
      return json({ code: '00000', data: { clientOid: order.clientOrderId, state: 'unknown' } });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const result = await coordinator.execute(USER, plan, order);
    assert.equal(result.state, 'RECOVERY_REQUIRED');
    assert.equal(placements, 1);
    assert.equal(detailQueries, 1);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

for (const scenario of [
  { name: 'missing response code', orderResponse: {} },
  { name: 'missing exact order number', orderResponse: { return_code: 0 } },
]) {
  test(`Kiwoom ${scenario.name} stops without heuristic recovery, resubmission, or cancel`, async () => {
    process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
    process.env.KIWOOM_MOCK_ORDER_ENABLED = 'true';
    process.env.KIWOOM_ALLOW_OFF_HOURS = 'true';
    const repository = new InMemoryTradingRepository();
    const plan = basePlan({
      id: `90000000-0000-0000-0000-00000000000${scenario.name === 'missing response code' ? '3' : '4'}`,
      idempotencyKey: `kiwoom-${scenario.name}`,
      exchange: 'kiwoom',
      accountMode: 'mock',
      symbol: '005930',
      market: 'KRX',
      side: 'buy',
      quantity: 1,
      quoteAmount: null,
      estimatedKrw: 100_000,
    });
    const order = baseOrder(plan, {
      id: `91000000-0000-0000-0000-00000000000${scenario.name === 'missing response code' ? '3' : '4'}`,
      clientOrderId: `sj-kiwoom-${scenario.name}`,
      requestedQuantity: 1,
    });
    await seed(repository, plan, order, { appKey: 'app', secretKey: 'secret' });
    const coordinator = new TradeExecutionCoordinator(repository);
    const nativeFetch = globalThis.fetch;
    let orderPosts = 0;
    let cancelPosts = 0;
    let postSubmissionQueries = 0;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const apiId = new Headers(init?.headers).get('api-id') ?? '';
      if (url.endsWith('/oauth2/token')) return json({ return_code: 0, token: 'token' });
      if (apiId === 'kt00010' || apiId === 'ka10075') {
        if (orderPosts > 0) postSubmissionQueries += 1;
        return json({ return_code: 0, data: [] });
      }
      if (apiId === 'kt10000') {
        orderPosts += 1;
        return json(scenario.orderResponse);
      }
      if (apiId === 'kt10003') {
        cancelPosts += 1;
        return json({ return_code: 0 });
      }
      throw new Error(`unexpected request: ${String(init?.method ?? 'GET')} ${url} ${apiId}`);
    }) as typeof fetch;

    try {
      const result = await coordinator.execute(USER, plan, order);
      assert.equal(result.state, 'RECOVERY_REQUIRED');
      assert.equal(result.exchangeOrderId, null);
      assert.equal(orderPosts, 1);
      assert.equal(postSubmissionQueries, 0);
      assert.equal(cancelPosts, 0);
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeExecutionCoordinator } from './trade-execution-coordinator.service';
import { encryptTradingCredentials } from './trade-credential-vault.service';
import type {
  ExchangeConnection,
  TradingOrder,
  TradingOrderState,
  TradingPlan,
} from './trade-automation.types';

const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MASTER_KEY = Buffer.alloc(32, 17).toString('base64');
const ORIGINAL_ENV = {
  ORDER_EXECUTION_ENABLED: process.env.ORDER_EXECUTION_ENABLED,
  LIVE_TRADING_ACTIVATION_APPROVED: process.env.LIVE_TRADING_ACTIVATION_APPROVED,
  UPBIT_LIVE_ORDER_ENABLED: process.env.UPBIT_LIVE_ORDER_ENABLED,
  TRADING_CREDENTIAL_MASTER_KEY: process.env.TRADING_CREDENTIAL_MASTER_KEY,
};

function restoreEnvironment() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function plan(overrides: Partial<TradingPlan> = {}): TradingPlan {
  const now = new Date().toISOString();
  return {
    id: '10000000-0000-0000-0000-000000000001',
    userId: USER,
    idempotencyKey: 'reconciliation-plan-key',
    exchange: 'upbit',
    accountMode: 'live',
    strategyId: 'reconciliation-test',
    signalId: 'reconciliation-signal',
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

function order(planValue: TradingPlan, state: TradingOrderState = 'SUBMITTED', overrides: Partial<TradingOrder> = {}): TradingOrder {
  const now = new Date().toISOString();
  return {
    id: '20000000-0000-0000-0000-000000000001',
    userId: USER,
    planId: planValue.id,
    exchange: planValue.exchange,
    clientOrderId: `sj-${planValue.exchange}-reconciliation`,
    exchangeOrderId: null,
    state,
    requestedQuantity: planValue.quantity ?? null,
    filledQuantity: 0,
    averageFillPrice: null,
    retryCount: 0,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function seed(
  repository: InMemoryTradingRepository,
  planValue: TradingPlan,
  orderValue: TradingOrder,
  credentials: Record<string, string>,
) {
  await repository.insertPlan(planValue);
  await repository.insertOrder(orderValue);
  const connection: ExchangeConnection = {
    userId: USER,
    exchange: planValue.exchange,
    accountMode: planValue.accountMode,
    configured: true,
    encryptedCredentials: encryptTradingCredentials(credentials),
    lastVerifiedAt: null,
    lastErrorCode: null,
    updatedAt: new Date().toISOString(),
  };
  await repository.saveConnection(connection);
}

function enableUpbitLiveForTest() {
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  process.env.ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
  process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';
}

test.afterEach(() => {
  restoreEnvironment();
});

test('ambiguous Upbit submission is queried once and resolves without resubmission', async () => {
  enableUpbitLiveForTest();
  const repository = new InMemoryTradingRepository();
  const planValue = plan();
  const orderValue = order(planValue);
  await seed(repository, planValue, orderValue, { accessKey: 'access', secretKey: 'secret' });
  const coordinator = new TradeExecutionCoordinator(repository);
  const nativeFetch = globalThis.fetch;
  let placementCount = 0;
  let queryCount = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    if (url.includes('/v1/accounts')) return jsonResponse([{ currency: 'KRW', balance: '1000000' }]);
    if (url.includes('/v1/orders/chance')) return jsonResponse({ market: { state: 'active' }, bid: { min_total: '5000' } });
    if (url.endsWith('/v1/orders/test') && method === 'POST') return jsonResponse({ accepted: true });
    if (url.endsWith('/v1/orders') && method === 'POST') {
      placementCount += 1;
      throw new TypeError('simulated network loss after submission');
    }
    if (url.includes('/v1/order?') && method === 'GET') {
      queryCount += 1;
      return jsonResponse({
        uuid: 'upbit-order-1',
        identifier: orderValue.clientOrderId,
        state: 'done',
        executed_volume: '0.5',
        trades: [{ volume: '0.5', funds: '50000' }],
      });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const result = await coordinator.execute(USER, planValue, orderValue);
    assert.equal(result.state, 'FILLED');
    assert.equal(result.exchangeOrderId, 'upbit-order-1');
    assert.equal(result.filledQuantity, 0.5);
    assert.equal(result.averageFillPrice, 100_000);
    assert.equal(result.retryCount, 1);
    assert.equal(result.lastErrorCode, null);
    assert.equal(placementCount, 1);
    assert.equal(queryCount, 1);
    const reasons = (await repository.listEvents(USER)).map((event) => event.reason);
    assert.ok(reasons.includes('AMBIGUOUS_EXCHANGE_SUBMISSION_RESPONSE'));
    assert.ok(reasons.includes('RECONCILIATION_QUERY_RESOLVED'));
    assert.ok(reasons.includes('UPBIT_ORDER_RECONCILED'));
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('unresolved query remains recovery-required and a later query never resubmits', async () => {
  enableUpbitLiveForTest();
  const repository = new InMemoryTradingRepository();
  const planValue = plan({ id: '10000000-0000-0000-0000-000000000002', idempotencyKey: 'reconciliation-plan-two' });
  const orderValue = order(planValue, 'SUBMITTED', {
    id: '20000000-0000-0000-0000-000000000002',
    clientOrderId: 'sj-upbit-reconciliation-two',
  });
  await seed(repository, planValue, orderValue, { accessKey: 'access', secretKey: 'secret' });
  const coordinator = new TradeExecutionCoordinator(repository);
  const nativeFetch = globalThis.fetch;
  let placementCount = 0;
  let queryCount = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    if (url.includes('/v1/accounts')) return jsonResponse([{ currency: 'KRW', balance: '1000000' }]);
    if (url.includes('/v1/orders/chance')) return jsonResponse({ market: { state: 'active' }, bid: { min_total: '5000' } });
    if (url.endsWith('/v1/orders/test') && method === 'POST') return jsonResponse({ accepted: true });
    if (url.endsWith('/v1/orders') && method === 'POST') {
      placementCount += 1;
      throw new TypeError('network socket closed after submission');
    }
    if (url.includes('/v1/order?') && method === 'GET') {
      queryCount += 1;
      if (queryCount === 1) return jsonResponse({ error: { name: 'temporary_unavailable' } }, 503);
      return jsonResponse({
        uuid: 'upbit-order-2',
        identifier: orderValue.clientOrderId,
        state: 'wait',
        executed_volume: '0.2',
        trades: [{ volume: '0.2', funds: '20000' }],
      });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const first = await coordinator.execute(USER, planValue, orderValue);
    assert.equal(first.state, 'RECOVERY_REQUIRED');
    assert.equal(first.retryCount, 1);
    assert.equal(placementCount, 1);
    assert.equal(queryCount, 1);

    const second = await coordinator.reconcileOrder(USER, planValue, first);
    assert.equal(second.order.state, 'PARTIALLY_FILLED');
    assert.equal(second.order.exchangeOrderId, 'upbit-order-2');
    assert.equal(second.order.filledQuantity, 0.2);
    assert.equal(second.order.retryCount, 2);
    assert.equal(placementCount, 1);
    assert.equal(queryCount, 2);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('recovery scan issues only an order-status query for existing recovery orders', async () => {
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  const repository = new InMemoryTradingRepository();
  const planValue = plan({ id: '10000000-0000-0000-0000-000000000003', idempotencyKey: 'recovery-scan-plan' });
  const orderValue = order(planValue, 'RECOVERY_REQUIRED', {
    id: '20000000-0000-0000-0000-000000000003',
    clientOrderId: 'sj-upbit-recovery-scan',
    lastErrorCode: 'EXCHANGE_TIMEOUT',
  });
  await seed(repository, planValue, orderValue, { accessKey: 'access', secretKey: 'secret' });
  const coordinator = new TradeExecutionCoordinator(repository);
  const nativeFetch = globalThis.fetch;
  const requests: Array<{ method: string; url: string }> = [];

  globalThis.fetch = (async (input, init) => {
    const request = { method: String(init?.method ?? 'GET'), url: String(input) };
    requests.push(request);
    return jsonResponse({
      uuid: 'upbit-order-3',
      identifier: orderValue.clientOrderId,
      state: 'wait',
      executed_volume: '0',
      trades: [],
    });
  }) as typeof fetch;

  try {
    const result = await coordinator.reconcileRecoverableOrders(USER);
    assert.equal(result.resolved, 1);
    assert.equal(result.unresolved, 0);
    assert.equal(result.queriesSent, 1);
    assert.equal(result.orders[0].state, 'ACCEPTED');
    assert.deepEqual(requests.map((request) => request.method), ['GET']);
    assert.ok(requests[0].url.includes('/v1/order?'));
    assert.equal(requests.some((request) => request.url.endsWith('/v1/orders')), false);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('Kiwoom recovery without an exact exchange order number stays blocked without heuristic matching', async () => {
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  const repository = new InMemoryTradingRepository();
  const planValue = plan({
    id: '10000000-0000-0000-0000-000000000004',
    idempotencyKey: 'kiwoom-recovery-plan',
    exchange: 'kiwoom',
    accountMode: 'mock',
    symbol: '005930',
    market: 'KRX',
    side: 'buy',
    quantity: 1,
    quoteAmount: null,
    estimatedKrw: 100_000,
  });
  const orderValue = order(planValue, 'RECOVERY_REQUIRED', {
    id: '20000000-0000-0000-0000-000000000004',
    clientOrderId: 'sj-kiwoom-recovery',
    requestedQuantity: 1,
    exchangeOrderId: null,
  });
  await seed(repository, planValue, orderValue, { appKey: 'app', secretKey: 'secret' });
  const coordinator = new TradeExecutionCoordinator(repository);
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => {
    outbound += 1;
    return jsonResponse({ return_code: 0, data: [{ stk_cd: '005930', ord_qty: '1' }] });
  }) as typeof fetch;

  try {
    const result = await coordinator.reconcileOrder(USER, planValue, orderValue);
    assert.equal(result.resolved, false);
    assert.equal(result.querySent, false);
    assert.equal(result.order.state, 'RECOVERY_REQUIRED');
    assert.equal(result.order.lastErrorCode, 'KIWOOM_EXCHANGE_ORDER_ID_UNKNOWN');
    assert.equal(result.order.retryCount, 1);
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('Bitget recovery resolves by clientOid using a GET query only', async () => {
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  const repository = new InMemoryTradingRepository();
  const planValue = plan({
    id: '10000000-0000-0000-0000-000000000005',
    idempotencyKey: 'bitget-recovery-plan',
    exchange: 'bitget',
    accountMode: 'live',
    symbol: 'BTCUSDT',
    market: 'USDT-FUTURES',
    side: 'long',
    quantity: 1,
    quoteAmount: null,
    leverage: 2,
    marginMode: 'isolated',
  });
  const orderValue = order(planValue, 'RECOVERY_REQUIRED', {
    id: '20000000-0000-0000-0000-000000000005',
    clientOrderId: 'sj-bitget-recovery',
    requestedQuantity: 1,
  });
  await seed(repository, planValue, orderValue, { apiKey: 'key', secretKey: 'secret', passphrase: 'pass' });
  const coordinator = new TradeExecutionCoordinator(repository);
  const nativeFetch = globalThis.fetch;
  const methods: string[] = [];

  globalThis.fetch = (async (input, init) => {
    methods.push(String(init?.method ?? 'GET'));
    assert.ok(String(input).includes('clientOid=sj-bitget-recovery'));
    return jsonResponse({
      code: '00000',
      data: { state: 'filled', orderId: 'bitget-order-5', baseVolume: '1', priceAvg: '100000' },
    });
  }) as typeof fetch;

  try {
    const result = await coordinator.reconcileOrder(USER, planValue, orderValue);
    assert.equal(result.order.state, 'FILLED');
    assert.equal(result.order.exchangeOrderId, 'bitget-order-5');
    assert.equal(result.order.filledQuantity, 1);
    assert.equal(result.order.averageFillPrice, 100_000);
    assert.deepEqual(methods, ['GET']);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('confirmed exchange rejection remains rejected and does not enter reconciliation', async () => {
  enableUpbitLiveForTest();
  const repository = new InMemoryTradingRepository();
  const planValue = plan({ id: '10000000-0000-0000-0000-000000000006', idempotencyKey: 'confirmed-rejection-plan' });
  const orderValue = order(planValue, 'SUBMITTED', {
    id: '20000000-0000-0000-0000-000000000006',
    clientOrderId: 'sj-upbit-confirmed-rejection',
  });
  await seed(repository, planValue, orderValue, { accessKey: 'access', secretKey: 'secret' });
  const coordinator = new TradeExecutionCoordinator(repository);
  const nativeFetch = globalThis.fetch;
  let queryCount = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    if (url.includes('/v1/accounts')) return jsonResponse([{ currency: 'KRW', balance: '1000000' }]);
    if (url.includes('/v1/orders/chance')) return jsonResponse({ market: { state: 'active' }, bid: { min_total: '5000' } });
    if (url.endsWith('/v1/orders/test') && method === 'POST') return jsonResponse({ accepted: true });
    if (url.endsWith('/v1/orders') && method === 'POST') {
      return jsonResponse({ error: { name: 'insufficient_funds_bid' } });
    }
    if (url.includes('/v1/order?')) queryCount += 1;
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const result = await coordinator.execute(USER, planValue, orderValue);
    assert.equal(result.state, 'REJECTED');
    assert.equal(result.lastErrorCode, 'UPBIT_ORDER_REJECTED');
    assert.equal(result.retryCount, 0);
    assert.equal(queryCount, 0);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

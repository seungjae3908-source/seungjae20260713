import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeExecutionCoordinator } from './trade-execution-coordinator.service';
import { encryptTradingCredentials } from './trade-credential-vault.service';
import type { ExchangeConnection, TradingOrder, TradingPlan } from './trade-automation.types';

const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MASTER_KEY = Buffer.alloc(32, 29).toString('base64');
const ORIGINAL_KEY = process.env.TRADING_CREDENTIAL_MASTER_KEY;

function plan(id: string): TradingPlan {
  const now = new Date().toISOString();
  return {
    id,
    userId: USER,
    idempotencyKey: `process-recovery-${id}`,
    exchange: 'upbit',
    accountMode: 'live',
    strategyId: 'process-recovery',
    signalId: `signal-${id}`,
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
    signalReasons: ['restart-contract'],
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
  };
}

function order(planValue: TradingPlan, id: string, state: TradingOrder['state'] = 'SUBMITTED'): TradingOrder {
  const now = new Date().toISOString();
  return {
    id,
    userId: USER,
    planId: planValue.id,
    exchange: 'upbit',
    clientOrderId: `sj-upbit-${id}`,
    exchangeOrderId: null,
    state,
    requestedQuantity: null,
    filledQuantity: 0,
    averageFillPrice: null,
    retryCount: 0,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function seed(repository: InMemoryTradingRepository, planValue: TradingPlan, orderValue: TradingOrder) {
  await repository.insertPlan(planValue);
  await repository.insertOrder(orderValue);
  const connection: ExchangeConnection = {
    userId: USER,
    exchange: 'upbit',
    accountMode: 'live',
    configured: true,
    encryptedCredentials: encryptTradingCredentials({ accessKey: 'access', secretKey: 'secret' }),
    lastVerifiedAt: null,
    lastErrorCode: null,
    updatedAt: new Date().toISOString(),
  };
  await repository.saveConnection(connection);
}

test.beforeEach(() => {
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
});

test.afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
  else process.env.TRADING_CREDENTIAL_MASTER_KEY = ORIGINAL_KEY;
});

test('restart after execution claim but before exchange request performs status lookup only', async () => {
  const repository = new InMemoryTradingRepository();
  const planValue = plan('92000000-0000-0000-0000-000000000001');
  const orderValue = order(planValue, '93000000-0000-0000-0000-000000000001');
  await seed(repository, planValue, orderValue);

  const restarted = new TradeExecutionCoordinator(repository);
  const nativeFetch = globalThis.fetch;
  const requests: Array<{ method: string; url: string }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ method: String(init?.method ?? 'GET'), url: String(input) });
    return json({ error: { name: 'order_not_found' } }, 404);
  }) as typeof fetch;

  try {
    const result = await restarted.reconcileRecoverableOrders(USER);
    assert.equal(result.unresolved, 1);
    assert.equal(result.orders[0].state, 'RECOVERY_REQUIRED');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.ok(requests[0].url.includes('/v1/order?'));
    assert.equal(requests.some((request) => request.url.endsWith('/v1/orders')), false);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('restart after exchange response but before database save reconciles the existing order without placement', async () => {
  const repository = new InMemoryTradingRepository();
  const planValue = plan('92000000-0000-0000-0000-000000000002');
  const orderValue = order(planValue, '93000000-0000-0000-0000-000000000002');
  await seed(repository, planValue, orderValue);

  const restarted = new TradeExecutionCoordinator(repository);
  const nativeFetch = globalThis.fetch;
  let placements = 0;
  let queries = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    if (url.endsWith('/v1/orders') && method === 'POST') placements += 1;
    if (url.includes('/v1/order?') && method === 'GET') {
      queries += 1;
      return json({
        uuid: 'upbit-existing-order',
        identifier: orderValue.clientOrderId,
        state: 'done',
        executed_volume: '0.5',
        trades: [{ volume: '0.5', funds: '50000' }],
      });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const result = await restarted.reconcileRecoverableOrders(USER);
    assert.equal(result.resolved, 1);
    assert.equal(result.orders[0].state, 'FILLED');
    assert.equal(result.orders[0].exchangeOrderId, 'upbit-existing-order');
    assert.equal(placements, 0);
    assert.equal(queries, 1);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('restart scan never re-executes a terminal order', async () => {
  const repository = new InMemoryTradingRepository();
  const planValue = plan('92000000-0000-0000-0000-000000000003');
  const orderValue = order(planValue, '93000000-0000-0000-0000-000000000003', 'FILLED');
  orderValue.exchangeOrderId = 'upbit-terminal-order';
  orderValue.filledQuantity = 0.5;
  await seed(repository, planValue, orderValue);

  const restarted = new TradeExecutionCoordinator(repository);
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => {
    outbound += 1;
    throw new Error('terminal order must not call exchange');
  }) as typeof fetch;

  try {
    const result = await restarted.reconcileRecoverableOrders(USER);
    assert.equal(result.orders.length, 0);
    assert.equal(result.resolved, 0);
    assert.equal(result.unresolved, 0);
    assert.equal(outbound, 0);
    assert.equal((await repository.getOrder(USER, orderValue.id))?.state, 'FILLED');
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

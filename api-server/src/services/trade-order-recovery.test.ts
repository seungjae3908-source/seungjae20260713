import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeExecutionService } from './trade-execution.service';
import { encryptTradingCredentials } from './trade-credential-vault.service';
import type {
  TradingAccountMode,
  TradingExchange,
  TradingOrder,
  TradingOrderState,
  TradingPlan,
} from './trade-automation.types';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const MASTER_KEY = Buffer.alloc(32, 12).toString('base64');

function plan(exchange: TradingExchange, accountMode: TradingAccountMode): TradingPlan {
  const now = new Date().toISOString();
  return {
    id: `plan-${exchange}-${accountMode}`,
    userId: USER_ID,
    idempotencyKey: `key-${exchange}-${accountMode}`,
    exchange,
    accountMode,
    strategyId: 'recovery-test',
    signalId: `signal-${exchange}`,
    symbol: exchange === 'kiwoom' ? '005930' : exchange === 'bitget' ? 'BTCUSDT' : 'BTC',
    market: exchange === 'bitget' ? 'USDT-FUTURES' : exchange === 'kiwoom' ? 'KR' : 'KRW',
    side: exchange === 'bitget' ? 'long' : 'buy',
    orderType: 'market',
    quantity: exchange === 'upbit' ? 0.001 : 1,
    quoteAmount: exchange === 'upbit' ? 100_000 : null,
    limitPrice: null,
    estimatedKrw: 100_000,
    stopPrice: 90_000,
    targetPrices: [110_000],
    splitRatios: [100],
    leverage: exchange === 'bitget' ? 2 : null,
    marginMode: exchange === 'bitget' ? 'isolated' : null,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: ['recovery'],
    marketSnapshot: {
      observedAt: now,
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
    },
    state: 'SUBMITTED',
    version: 1,
    approvalExpiresAt: null,
    approvedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function order(planValue: TradingPlan, state: TradingOrderState = 'RECOVERY_REQUIRED'): TradingOrder {
  const now = new Date().toISOString();
  return {
    id: `order-${planValue.exchange}-${planValue.accountMode}`,
    userId: USER_ID,
    planId: planValue.id,
    exchange: planValue.exchange,
    clientOrderId: `client-${planValue.exchange}`,
    exchangeOrderId: null,
    state,
    version: 1,
    requestedQuantity: planValue.quantity ?? null,
    remainingQuantity: planValue.quantity ?? null,
    filledQuantity: 0,
    averageFillPrice: null,
    fills: [],
    feeAmount: null,
    feeCurrency: null,
    retryCount: 0,
    nextRetryAt: null,
    lastReconciledAt: null,
    lastErrorCode: null,
    manualReviewRequired: false,
    createdAt: now,
    updatedAt: now,
  };
}

async function setup(
  exchange: TradingExchange,
  accountMode: TradingAccountMode,
  credentials: Record<string, string>,
  state: TradingOrderState = 'RECOVERY_REQUIRED',
) {
  const repository = new InMemoryTradingRepository();
  const planValue = plan(exchange, accountMode);
  const orderValue = order(planValue, state);
  await repository.savePlan(planValue);
  await repository.saveOrder(orderValue);
  await repository.saveConnection({
    userId: USER_ID,
    exchange,
    accountMode,
    configured: true,
    encryptedCredentials: encryptTradingCredentials(credentials, MASTER_KEY),
    lastVerifiedAt: null,
    lastErrorCode: null,
    updatedAt: new Date().toISOString(),
  });
  return { repository, planValue, orderValue };
}

test.before(() => {
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
});

test.after(() => {
  delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
});

test('Upbit uncertain execution performs identifier lookup only and reconciles a fill', async () => {
  const { repository, planValue, orderValue } = await setup('upbit', 'live', {
    accessKey: 'upbit-access', secretKey: 'upbit-secret',
  });
  const nativeFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    requests.push({ url, method });
    assert.match(url, /\/v1\/order\?identifier=client-upbit/);
    assert.equal(method, 'GET');
    return new Response(JSON.stringify({
      uuid: 'upbit-order-1', identifier: 'client-upbit', state: 'done',
      volume: '0.001', remaining_volume: '0', executed_volume: '0.001', paid_fee: '50',
      created_at: '2026-08-05T03:30:00.000Z',
      trades: [{ uuid: 'fill-1', price: '100000000', volume: '0.001', created_at: '2026-08-05T03:30:01.000Z' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const recovered = await new TradeExecutionService(repository).execute(USER_ID, planValue, orderValue);
    assert.equal(recovered.state, 'FILLED');
    assert.equal(recovered.exchangeOrderId, 'upbit-order-1');
    assert.equal(recovered.filledQuantity, 0.001);
    assert.equal(recovered.averageFillPrice, 100_000_000);
    assert.equal(recovered.manualReviewRequired, false);
    assert.equal(requests.length, 1);
    assert.equal(requests.some((request) => request.method === 'POST' || /\/v1\/orders(?:\?|$)/.test(request.url)), false);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('Bitget uncertain execution performs clientOid detail lookup only and preserves partial fill', async () => {
  const { repository, planValue, orderValue } = await setup('bitget', 'live', {
    apiKey: 'bitget-key', secretKey: 'bitget-secret', passphrase: 'bitget-pass',
  });
  const nativeFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    requests.push({ url, method });
    assert.match(url, /\/api\/v2\/mix\/order\/detail\?clientOid=client-bitget/);
    assert.equal(method, 'GET');
    return new Response(JSON.stringify({
      code: '00000',
      data: {
        orderId: 'bitget-order-1', clientOid: 'client-bitget', status: 'partially_filled',
        size: '1', baseVolume: '0.4', priceAvg: '50000', cTime: '1785891000000', uTime: '1785891001000',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const recovered = await new TradeExecutionService(repository).execute(USER_ID, planValue, orderValue);
    assert.equal(recovered.state, 'PARTIALLY_FILLED');
    assert.equal(recovered.exchangeOrderId, 'bitget-order-1');
    assert.equal(recovered.filledQuantity, 0.4);
    assert.equal(recovered.remainingQuantity, 0.6);
    assert.equal(requests.length, 1);
    assert.equal(requests.some((request) => request.method === 'POST' || request.url.includes('/place-order')), false);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('lookup failure schedules bounded retries and never replays the order POST', async () => {
  const { repository, planValue, orderValue } = await setup('upbit', 'live', {
    accessKey: 'upbit-access', secretKey: 'upbit-secret',
  });
  const nativeFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    requests.push({ url, method });
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const service = new TradeExecutionService(repository);
    let recovered = await service.execute(USER_ID, planValue, orderValue);
    assert.equal(recovered.state, 'RECOVERY_REQUIRED');
    assert.equal(recovered.retryCount, 1);
    assert.ok(recovered.nextRetryAt);
    assert.equal(recovered.manualReviewRequired, false);

    recovered = await service.execute(USER_ID, planValue, recovered);
    assert.equal(requests.length, 1, 'future nextRetryAt must suppress immediate duplicate lookup');

    recovered.nextRetryAt = new Date(Date.now() - 1).toISOString();
    await repository.saveOrder(recovered);
    recovered = await service.execute(USER_ID, planValue, recovered);
    assert.equal(recovered.retryCount, 2);
    recovered.nextRetryAt = new Date(Date.now() - 1).toISOString();
    await repository.saveOrder(recovered);
    recovered = await service.execute(USER_ID, planValue, recovered);
    assert.equal(recovered.retryCount, 3);
    assert.equal(recovered.manualReviewRequired, true);
    assert.equal(recovered.nextRetryAt, null);
    assert.equal(requests.length, 3);
    assert.equal(requests.some((request) => request.method === 'POST' || /\/v1\/orders(?:\?|$)/.test(request.url)), false);
    const events = await repository.listEvents(USER_ID);
    assert.equal(events.at(-1)?.reason, 'EXCHANGE_RECONCILIATION_MANUAL_REVIEW');
    assert.equal(events.every((event) => event.metadata.orderSubmissionAttempted === false), true);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('Kiwoom recovery uses token and unfilled inquiry but never sends a stock order', async () => {
  const { repository, planValue, orderValue } = await setup('kiwoom', 'mock', {
    appKey: 'kiwoom-app', secretKey: 'kiwoom-secret',
  });
  const nativeFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; apiId: string | null }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const apiId = headers.get('api-id');
    requests.push({ url, method, apiId });
    if (url.endsWith('/oauth2/token')) {
      return new Response(JSON.stringify({ return_code: 0, token: 'mock-token' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    assert.equal(apiId, 'ka10075');
    return new Response(JSON.stringify({ return_code: 0, data: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const recovered = await new TradeExecutionService(repository).execute(USER_ID, planValue, orderValue);
    assert.equal(recovered.state, 'RECOVERY_REQUIRED');
    assert.equal(recovered.manualReviewRequired, true);
    assert.equal(recovered.lastErrorCode, 'KIWOOM_ORDER_ID_REQUIRED_FOR_RECOVERY');
    assert.equal(requests.length, 2);
    assert.equal(requests.some((request) => request.url.includes('/api/dostk/ordr')), false);
    assert.equal(requests.some((request) => request.apiId === 'kt10000' || request.apiId === 'kt10001'), false);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('non-submitted orders cannot enter the exchange execution path', async () => {
  const { repository, planValue, orderValue } = await setup('upbit', 'live', {
    accessKey: 'upbit-access', secretKey: 'upbit-secret',
  }, 'FILLED');
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => {
    outbound += 1;
    throw new Error('unexpected outbound');
  }) as typeof fetch;
  try {
    const result = await new TradeExecutionService(repository).execute(USER_ID, planValue, orderValue);
    assert.equal(result.state, 'FILLED');
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

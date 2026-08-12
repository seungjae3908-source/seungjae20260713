import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeCancelReconciliationService } from './trade-cancel-reconciliation.service';
import { TradeOrderRecoveryService } from './trade-order-recovery.service';
import { encryptTradingCredentials } from './trade-credential-vault.service';
import type { TradingOrder, TradingOrderState, TradingPlan } from './trade-automation.types';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const MASTER_KEY = Buffer.alloc(32, 17).toString('base64');

function fixtures(id: string, state: TradingOrderState = 'ACCEPTED') {
  const now = new Date().toISOString();
  const plan: TradingPlan = {
    id: `cancel-plan-${id}`,
    userId: USER_ID,
    idempotencyKey: `cancel-key-${id}`,
    exchange: 'upbit',
    accountMode: 'live',
    strategyId: 'cancel-race',
    signalId: `cancel-signal-${id}`,
    symbol: 'BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'market',
    quantity: 1,
    quoteAmount: 100_000,
    limitPrice: null,
    estimatedKrw: 100_000,
    stopPrice: 90_000,
    targetPrices: [110_000],
    splitRatios: [100],
    leverage: null,
    marginMode: null,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: ['cancel-race'],
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
  const order: TradingOrder = {
    id: `cancel-order-${id}`,
    userId: USER_ID,
    planId: plan.id,
    exchange: 'upbit',
    clientOrderId: `cancel-client-${id}`,
    exchangeOrderId: `upbit-order-${id}`,
    state,
    version: 0,
    requestedQuantity: 1,
    remainingQuantity: 1,
    filledQuantity: 0,
    averageFillPrice: null,
    fills: [],
    feeAmount: null,
    feeCurrency: null,
    cancelable: true,
    providerStatusCode: 'wait',
    retryCount: 0,
    nextRetryAt: null,
    lastReconciledAt: null,
    lastErrorCode: null,
    manualReviewRequired: false,
    createdAt: now,
    updatedAt: now,
  };
  return { plan, order };
}

async function setup(id: string, state: TradingOrderState = 'ACCEPTED') {
  const repository = new InMemoryTradingRepository();
  const { plan, order } = fixtures(id, state);
  await repository.savePlan(plan);
  await repository.saveOrder(order);
  await repository.saveConnection({
    userId: USER_ID,
    exchange: 'upbit',
    accountMode: 'live',
    configured: true,
    encryptedCredentials: encryptTradingCredentials({
      accessKey: `upbit-access-${id}`,
      secretKey: `upbit-secret-${id}`,
    }, MASTER_KEY),
    lastVerifiedAt: null,
    lastErrorCode: null,
    updatedAt: new Date().toISOString(),
  });
  return { repository, plan, order };
}

function upbitResponse(
  state: 'wait' | 'done' | 'cancel',
  filled: number,
  time: string,
  identifier: string,
) {
  const remaining = Math.max(0, 1 - filled);
  return {
    uuid: identifier.replace(/^cancel-client-/, 'upbit-order-'),
    identifier,
    market: 'KRW-BTC',
    state,
    volume: '1',
    remaining_volume: String(remaining),
    executed_volume: String(filled),
    paid_fee: filled > 0 ? '25' : '0',
    created_at: '2026-08-05T04:00:00.000Z',
    trades: filled > 0 ? [{
      uuid: `fill-${state}-${filled}`,
      price: '100000000',
      volume: String(filled),
      created_at: time,
    }] : [],
  };
}

test.before(() => {
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  process.env.ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
  process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';
});

test.after(() => {
  delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
  delete process.env.ORDER_EXECUTION_ENABLED;
  delete process.env.LIVE_TRADING_ACTIVATION_APPROVED;
  delete process.env.UPBIT_LIVE_ORDER_ENABLED;
});

test('two concurrent cancel requests submit one exchange cancel and a concurrent fill wins', async () => {
  const { repository, plan, order } = await setup('duplicate-fill');
  const firstCandidate = await repository.getOrder(USER_ID, order.id);
  const secondCandidate = await repository.getOrder(USER_ID, order.id);
  assert.ok(firstCandidate && secondCandidate);

  let cancelCalls = 0;
  let lookupCalls = 0;
  let cancelStartedResolve!: () => void;
  let cancelReleaseResolve!: () => void;
  const cancelStarted = new Promise<void>((resolve) => { cancelStartedResolve = resolve; });
  const cancelRelease = new Promise<void>((resolve) => { cancelReleaseResolve = resolve; });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method === 'DELETE') {
      cancelCalls += 1;
      cancelStartedResolve();
      await cancelRelease;
      return new Response(JSON.stringify(upbitResponse(
        'cancel', 0, '2026-08-05T04:00:01.000Z', 'cancel-client-duplicate-fill',
      )), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    lookupCalls += 1;
    assert.match(url, /\/v1\/order\?identifier=cancel-client-duplicate-fill/);
    return new Response(JSON.stringify(upbitResponse(
      'done', 1, '2026-08-05T04:00:03.000Z', 'cancel-client-duplicate-fill',
    )), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const service = new TradeCancelReconciliationService(repository);
    const first = service.cancel(USER_ID, plan, firstCandidate);
    await cancelStarted;
    const second = await service.cancel(USER_ID, plan, secondCandidate);
    assert.equal(second.state, 'CANCEL_REQUESTED');
    cancelReleaseResolve();
    const firstResult = await first;
    const stored = await repository.getOrder(USER_ID, order.id);
    assert.equal(firstResult.state, 'FILLED');
    assert.equal(stored?.state, 'FILLED');
    assert.equal(stored?.filledQuantity, 1);
    assert.equal(cancelCalls, 1);
    assert.equal(lookupCalls, 1);
    const events = await repository.listEvents(USER_ID);
    assert.equal(events.filter((event) => event.reason === 'EXCHANGE_CANCEL_CLAIMED').length, 1);
    assert.equal(events.some((event) => event.toState === 'CANCELED'), false);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('partial fill remains recorded when the remaining quantity is canceled', async () => {
  const { repository, plan, order } = await setup('partial-cancel');
  const nativeFetch = globalThis.fetch;
  let cancelCalls = 0;
  let lookupCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method === 'DELETE') {
      cancelCalls += 1;
      return new Response(JSON.stringify(upbitResponse(
        'cancel', 0.4, '2026-08-05T04:01:01.000Z', 'cancel-client-partial-cancel',
      )), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    lookupCalls += 1;
    return new Response(JSON.stringify(upbitResponse(
      'cancel', 0.4, '2026-08-05T04:01:02.000Z', 'cancel-client-partial-cancel',
    )), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await new TradeCancelReconciliationService(repository).cancel(USER_ID, plan, order);
    assert.equal(result.state, 'CANCELED');
    assert.equal(result.filledQuantity, 0.4);
    assert.equal(result.remainingQuantity, 0.6);
    assert.equal(result.fills?.length, 1);
    assert.equal(cancelCalls, 1);
    assert.equal(lookupCalls, 1);
    const events = await repository.listEvents(USER_ID);
    const reconciled = events.find((event) => event.reason === 'EXCHANGE_ORDER_RECONCILED');
    assert.equal(reconciled?.metadata.partialFillPreserved, true);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('uncertain cancel never resends DELETE and later recovery performs lookup only', async () => {
  const { repository, plan, order } = await setup('uncertain');
  const nativeFetch = globalThis.fetch;
  let cancelCalls = 0;
  let lookupCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method === 'DELETE') {
      cancelCalls += 1;
      return new Response('{}', { status: 504, headers: { 'content-type': 'application/json' } });
    }
    lookupCalls += 1;
    return new Response(JSON.stringify(upbitResponse(
      'wait', 0, '2026-08-05T04:02:00.000Z', 'cancel-client-uncertain',
    )), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const service = new TradeCancelReconciliationService(repository);
    let result = await service.cancel(USER_ID, plan, order);
    assert.equal(result.state, 'RECOVERY_REQUIRED');
    assert.ok(result.cancelRequestClaimId);
    assert.equal(cancelCalls, 1);
    assert.equal(lookupCalls, 1);

    result.nextRetryAt = new Date(Date.now() - 1).toISOString();
    await repository.saveOrder(result);
    result = await service.cancel(USER_ID, plan, result);
    assert.equal(result.state, 'RECOVERY_REQUIRED');
    assert.equal(cancelCalls, 1, 'cancel endpoint must never be replayed after a claim exists');
    assert.equal(lookupCalls, 2);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('newer full fill corrects a stale canceled winner from a concurrent recovery worker', async () => {
  const { repository, plan, order } = await setup('terminal-correction', 'RECOVERY_REQUIRED');
  order.cancelRequestClaimId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  order.cancelRequestedAt = '2026-08-05T04:03:00.000Z';
  order.cancelSubmittedAt = '2026-08-05T04:03:00.000Z';
  order.cancelAcknowledgedAt = '2026-08-05T04:03:01.000Z';
  await repository.saveOrder(order);
  const firstCandidate = await repository.getOrder(USER_ID, order.id);
  const secondCandidate = await repository.getOrder(USER_ID, order.id);
  assert.ok(firstCandidate && secondCandidate);

  let requestIndex = 0;
  let firstLookupStartedResolve!: () => void;
  let releaseFirstLookupResolve!: () => void;
  const firstLookupStarted = new Promise<void>((resolve) => { firstLookupStartedResolve = resolve; });
  const releaseFirstLookup = new Promise<void>((resolve) => { releaseFirstLookupResolve = resolve; });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    requestIndex += 1;
    if (requestIndex === 1) {
      firstLookupStartedResolve();
      await releaseFirstLookup;
      return new Response(JSON.stringify(upbitResponse(
        'done', 1, '2026-08-05T04:03:05.000Z', 'cancel-client-terminal-correction',
      )), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(upbitResponse(
      'cancel', 0.4, '2026-08-05T04:03:03.000Z', 'cancel-client-terminal-correction',
    )), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const recovery = new TradeOrderRecoveryService(repository);
    const first = recovery.reconcile(USER_ID, plan, firstCandidate);
    await firstLookupStarted;
    const second = await recovery.reconcile(USER_ID, plan, secondCandidate);
    assert.equal(second.state, 'CANCELED');
    releaseFirstLookupResolve();
    const firstResult = await first;
    const stored = await repository.getOrder(USER_ID, order.id);
    assert.equal(firstResult.state, 'FILLED');
    assert.equal(stored?.state, 'FILLED');
    assert.equal(stored?.filledQuantity, 1);
    const events = await repository.listEvents(USER_ID);
    assert.equal(events.some((event) => event.reason === 'EXCHANGE_FILL_CORRECTED_AFTER_CANCEL_RACE'), true);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('terminal cancellation requests perform no outbound request', async () => {
  const { repository, plan, order } = await setup('terminal-no-outbound', 'FILLED');
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => {
    outbound += 1;
    throw new Error('unexpected outbound');
  }) as typeof fetch;
  try {
    const result = await new TradeCancelReconciliationService(repository).cancel(USER_ID, plan, order);
    assert.equal(result.state, 'FILLED');
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

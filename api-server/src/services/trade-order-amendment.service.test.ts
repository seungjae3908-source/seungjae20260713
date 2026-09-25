import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { encryptTradingCredentials } from './trade-credential-vault.service';
import { TradeOrderAmendmentService } from './trade-order-amendment.service';
import type { TradingOrder, TradingPlan } from './trade-automation.types';

const USER = '11111111-1111-1111-1111-111111111111';
const KEY = Buffer.alloc(32, 4).toString('base64');
const nativeFetch = globalThis.fetch;

function plan(): TradingPlan {
  const now = new Date();
  return {
    id: '22222222-2222-2222-2222-222222222222',
    userId: USER,
    idempotencyKey: 'amend-plan',
    state: 'SUBMITTED',
    version: 1,
    approvalExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    approvedAt: now.toISOString(),
    exchange: 'upbit',
    accountMode: 'live',
    stockBroker: null,
    strategyId: 's1',
    signalId: 'sig1',
    symbol: 'BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'limit',
    quantity: 1,
    quoteAmount: null,
    limitPrice: 100_000,
    estimatedKrw: 100_000,
    stopPrice: 95_000,
    targetPrices: [110_000],
    splitRatios: [100],
    signalReasons: ['test'],
    marketSnapshot: {
      observedAt: now.toISOString(), dataDelayMs: 0, oneMinuteMovePercent: 0,
      spreadPercent: 0.1, orderbookGapPercent: 0.1, halted: false,
      availableBalance: 1_000_000, accountValueKrw: 1_000_000, dailyPnlPercent: 0,
      assetExposurePercent: 0, openPositionCount: 0, dailyOrderCount: 0,
      consecutiveLosses: 0, currentPrice: 100_000, plannedPrice: 100_000,
      marketStatus: 'OPEN', source: 'test',
    },
    riskEnvelope: {
      version: 1, investmentKrw: 100_000, maxLossKrw: 5_000, maxSlippagePercent: 5,
      maxSplitCount: 1, allowCancelUnfilled: true, stopMethod: 'fixed_stop',
      emergencyExitScope: 'cancel_unfilled_and_reduce_only',
      approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    },
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
}

function order(p: TradingPlan): TradingOrder {
  const now = new Date().toISOString();
  return {
    id: '33333333-3333-3333-3333-333333333333',
    userId: USER, planId: p.id, exchange: 'upbit', stockBroker: null,
    clientOrderId: 'sj-upbit-original', exchangeOrderId: 'exchange-original',
    state: 'ACCEPTED', version: 1, requestedQuantity: 1, remainingQuantity: 1,
    currentLimitPrice: 100_000, filledQuantity: 0, averageFillPrice: null,
    retryCount: 0, lastErrorCode: null, cancelable: true,
    manualReviewRequired: false, approvedPlanVersion: 1,
    amendments: [], lastAmendRequestId: null,
    createdAt: now, updatedAt: now,
  };
}

async function setup() {
  process.env.TRADING_CREDENTIAL_MASTER_KEY = KEY;
  process.env.ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
  process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';
  const repository = new InMemoryTradingRepository();
  const p = plan();
  const o = order(p);
  await repository.savePlan(p);
  await repository.saveOrder(o);
  await repository.saveConnection({
    userId: USER, exchange: 'upbit', accountMode: 'live', configured: true,
    encryptedCredentials: encryptTradingCredentials({ accessKey: 'a', secretKey: 'b' }, KEY),
    lastVerifiedAt: new Date().toISOString(), lastErrorCode: null, updatedAt: new Date().toISOString(),
  });
  return { repository, p, o, service: new TradeOrderAmendmentService(repository) };
}

test.afterEach(() => {
  globalThis.fetch = nativeFetch;
  for (const key of ['TRADING_CREDENTIAL_MASTER_KEY','ORDER_EXECUTION_ENABLED','LIVE_TRADING_ACTIVATION_APPROVED','UPBIT_LIVE_ORDER_ENABLED']) {
    delete process.env[key];
  }
});

test('same amend request mutates provider once and replay is local-only', async () => {
  const { p, o, service } = await setup();
  let mutations = 0;
  let reads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/orders/cancel_and_new') {
      mutations += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string,string>;
      return new Response(JSON.stringify({ uuid: 'exchange-new', identifier: body.new_identifier, state: 'wait' }), { status: 200 });
    }
    if (url.pathname === '/v1/order') {
      reads += 1;
      return new Response(JSON.stringify({ uuid: 'exchange-new', identifier: url.searchParams.get('identifier'), state: 'wait' }), { status: 200 });
    }
    throw new Error('UNEXPECTED_NETWORK_PATH');
  }) as typeof fetch;

  const first = await service.amend(USER, o, p, { requestId: 'amend-request-01', price: 101_000, quantity: 1 });
  assert.equal(first.order.state, 'ACCEPTED');
  assert.equal(first.order.amendments?.[0]?.status, 'ACKNOWLEDGED');
  assert.equal(first.order.currentLimitPrice, 101_000);
  assert.equal(mutations, 1);
  assert.equal(reads, 1);

  const replay = await service.amend(USER, first.order, p, { requestId: 'amend-request-01', price: 101_000, quantity: 1 });
  assert.equal(replay.replayed, true);
  assert.equal(replay.recoveryRequired, false);
  assert.equal(mutations, 1);
  assert.equal(reads, 1);
});

test('interrupted amend intent is recovery-required without another provider request', async () => {
  const { repository, p, o, service } = await setup();
  o.amendments = [{
    requestId: 'amend-request-02', revision: 1, status: 'INTENT_RECORDED',
    previousClientOrderId: o.clientOrderId, nextClientOrderId: 'sj-upbit-next',
    previousExchangeOrderId: o.exchangeOrderId, nextExchangeOrderId: null,
    requestedQuantity: 1, requestedPrice: 101_000, requestedAt: new Date().toISOString(),
    acknowledgedAt: null, errorCode: null,
  }];
  o.lastAmendRequestId = 'amend-request-02';
  await repository.saveOrder(o);
  let outbound = 0;
  globalThis.fetch = (async () => { outbound += 1; throw new Error('NO_NETWORK'); }) as typeof fetch;

  const result = await service.amend(USER, o, p, { requestId: 'amend-request-02', price: 101_000, quantity: 1 });
  assert.equal(result.replayed, true);
  assert.equal(result.recoveryRequired, true);
  assert.equal(result.order.state, 'RECOVERY_REQUIRED');
  assert.equal(result.order.manualReviewRequired, true);
  assert.equal(result.order.amendments?.[0]?.status, 'RECOVERY_REQUIRED');
  assert.equal(outbound, 0);
});

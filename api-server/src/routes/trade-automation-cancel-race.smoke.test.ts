import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import router, { setTradeAutomationRepositoryFactoryForTests } from './trade-automation';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';
import { encryptTradingCredentials } from '../services/trade-credential-vault.service';
import type { AuthenticatedRequest } from '../middleware/auth';
import type { TradingOrder, TradingPlan } from '../services/trade-automation.types';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const MASTER_KEY = Buffer.alloc(32, 19).toString('base64');

function fixtures() {
  const now = new Date().toISOString();
  const plan: TradingPlan = {
    id: 'route-cancel-race-plan', userId: USER_ID, idempotencyKey: 'route-cancel-race-key',
    exchange: 'upbit', accountMode: 'live', strategyId: 'route-cancel-race', signalId: 'route-cancel-race-signal',
    symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'market', quantity: 1,
    quoteAmount: 100_000, limitPrice: null, estimatedKrw: 100_000, stopPrice: 90_000,
    targetPrices: [110_000], splitRatios: [100], leverage: null, marginMode: null,
    reduceOnly: false, invalidateAction: 'hold', signalReasons: ['cancel-route-race'],
    marketSnapshot: {
      observedAt: now, dataDelayMs: 0, oneMinuteMovePercent: 0, spreadPercent: 0.1,
      orderbookGapPercent: 0.1, halted: false, availableBalance: 1_000_000,
      accountValueKrw: 5_000_000, dailyPnlPercent: 0, assetExposurePercent: 0,
      openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
    },
    state: 'SUBMITTED', version: 1, approvalExpiresAt: null, approvedAt: now,
    createdAt: now, updatedAt: now,
  };
  const order: TradingOrder = {
    id: 'route-cancel-race-order', userId: USER_ID, planId: plan.id, exchange: 'upbit',
    clientOrderId: 'route-cancel-race-client', exchangeOrderId: 'route-cancel-race-exchange',
    state: 'ACCEPTED', version: 0, requestedQuantity: 1, remainingQuantity: 1,
    filledQuantity: 0, averageFillPrice: null, fills: [], feeAmount: null, feeCurrency: null,
    cancelable: true, providerStatusCode: 'wait', retryCount: 0, nextRetryAt: null,
    lastReconciledAt: null, lastErrorCode: null, manualReviewRequired: false,
    createdAt: now, updatedAt: now,
  };
  return { plan, order };
}

async function startServer(repository: InMemoryTradingRepository) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const authenticated = request as AuthenticatedRequest;
    authenticated.member = {
      id: USER_ID,
      login_name: 'cancel-race-test',
      display_name: 'Cancel Race Test',
      role: 'regular',
      status: 'approved',
      membership_level: 'regular',
      is_active: true,
    };
    authenticated.accessToken = 'test-token';
    next();
  });
  setTradeAutomationRepositoryFactoryForTests(() => repository);
  app.use('/api/trade-automation', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: import('node:http').Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('concurrent HTTP cancel requests submit one provider cancel and reconcile the fill', async () => {
  const repository = new InMemoryTradingRepository();
  const { plan, order } = fixtures();
  await repository.savePlan(plan);
  await repository.saveOrder(order);
  await repository.saveConnection({
    userId: USER_ID, exchange: 'upbit', accountMode: 'live', configured: true,
    encryptedCredentials: encryptTradingCredentials({ accessKey: 'route-cancel-access', secretKey: 'route-cancel-secret' }, MASTER_KEY),
    lastVerifiedAt: null, lastErrorCode: null, updatedAt: new Date().toISOString(),
  });
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  process.env.ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
  process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';

  const { server, baseUrl } = await startServer(repository);
  const nativeFetch = globalThis.fetch;
  let cancelCalls = 0;
  let lookupCalls = 0;
  let cancelStartedResolve!: () => void;
  let releaseCancelResolve!: () => void;
  const cancelStarted = new Promise<void>((resolve) => { cancelStartedResolve = resolve; });
  const releaseCancel = new Promise<void>((resolve) => { releaseCancelResolve = resolve; });

  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(baseUrl)) return nativeFetch(input, init);
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method === 'DELETE') {
      cancelCalls += 1;
      cancelStartedResolve();
      await releaseCancel;
      return new Response(JSON.stringify({ uuid: 'route-cancel-race-exchange', state: 'cancel' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    lookupCalls += 1;
    assert.equal(method, 'GET');
    assert.match(url, /\/v1\/order\?identifier=route-cancel-race-client/);
    return new Response(JSON.stringify({
      uuid: 'route-cancel-race-exchange', identifier: 'route-cancel-race-client', state: 'done', volume: '1',
      remaining_volume: '0', executed_volume: '1', paid_fee: '25',
      created_at: '2026-08-05T04:10:00.000Z',
      trades: [{ uuid: 'route-cancel-race-fill', price: '100000000', volume: '1', created_at: '2026-08-05T04:10:02.000Z' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const endpoint = `${baseUrl}/api/trade-automation/orders/${order.id}/cancel`;
    const firstRequest = globalThis.fetch(endpoint, { method: 'POST' });
    await cancelStarted;
    const secondResponse = await globalThis.fetch(endpoint, { method: 'POST' });
    assert.equal(secondResponse.status, 200);
    const secondBody = await secondResponse.json() as {
      order: TradingOrder;
      exchangeCancelSubmittedAtMostOnce: boolean;
    };
    assert.equal(secondBody.order.state, 'CANCEL_REQUESTED');
    assert.equal(secondBody.exchangeCancelSubmittedAtMostOnce, true);

    releaseCancelResolve();
    const firstResponse = await firstRequest;
    assert.equal(firstResponse.status, 200);
    const firstBody = await firstResponse.json() as { order: TradingOrder };
    assert.equal(firstBody.order.state, 'FILLED');

    const stored = await repository.getOrder(USER_ID, order.id);
    assert.equal(stored?.state, 'FILLED');
    assert.equal(stored?.filledQuantity, 1);
    assert.equal(cancelCalls, 1);
    assert.equal(lookupCalls, 1);
  } finally {
    globalThis.fetch = nativeFetch;
    delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
    delete process.env.ORDER_EXECUTION_ENABLED;
    delete process.env.LIVE_TRADING_ACTIVATION_APPROVED;
    delete process.env.UPBIT_LIVE_ORDER_ENABLED;
    setTradeAutomationRepositoryFactoryForTests(null);
    await close(server);
  }
});
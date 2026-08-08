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
const MASTER_KEY = Buffer.alloc(32, 13).toString('base64');

function fixtures() {
  const now = new Date().toISOString();
  const plan: TradingPlan = {
    id: 'route-recovery-plan', userId: USER_ID, idempotencyKey: 'route-recovery-key',
    exchange: 'upbit', accountMode: 'live', strategyId: 'route-recovery', signalId: 'route-recovery-signal',
    symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'market', quantity: 0.001,
    quoteAmount: 100_000, limitPrice: null, estimatedKrw: 100_000, stopPrice: 90_000,
    targetPrices: [110_000], splitRatios: [100], leverage: null, marginMode: null,
    reduceOnly: false, invalidateAction: 'hold', signalReasons: ['recovery-route'],
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
    id: 'route-recovery-order', userId: USER_ID, planId: plan.id, exchange: 'upbit',
    clientOrderId: 'route-recovery-client', exchangeOrderId: null, state: 'ACCEPTED', version: 1,
    requestedQuantity: 0.001, remainingQuantity: 0.001, filledQuantity: 0,
    averageFillPrice: null, fills: [], feeAmount: null, feeCurrency: null,
    retryCount: 0, nextRetryAt: null, lastReconciledAt: null, lastErrorCode: null,
    manualReviewRequired: false, createdAt: now, updatedAt: now,
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
      login_name: 'recovery-test',
      display_name: 'Recovery Test',
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

test('recovery scan marks open order, queries provider once, and submits no exchange order', async () => {
  const repository = new InMemoryTradingRepository();
  const { plan, order } = fixtures();
  await repository.savePlan(plan);
  await repository.saveOrder(order);
  await repository.saveConnection({
    userId: USER_ID, exchange: 'upbit', accountMode: 'live', configured: true,
    encryptedCredentials: encryptTradingCredentials({ accessKey: 'route-access', secretKey: 'route-secret' }, MASTER_KEY),
    lastVerifiedAt: null, lastErrorCode: null, updatedAt: new Date().toISOString(),
  });
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  const { server, baseUrl } = await startServer(repository);
  const nativeFetch = globalThis.fetch;
  const externalRequests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(baseUrl)) return nativeFetch(input, init);
    const method = String(init?.method ?? 'GET').toUpperCase();
    externalRequests.push({ url, method });
    assert.match(url, /\/v1\/order\?identifier=route-recovery-client/);
    assert.equal(method, 'GET');
    return new Response(JSON.stringify({
      uuid: 'route-upbit-order', identifier: 'route-recovery-client', state: 'done',
      volume: '0.001', remaining_volume: '0', executed_volume: '0.001', paid_fee: '25',
      created_at: '2026-08-05T03:35:00.000Z',
      trades: [{ uuid: 'route-fill', price: '100000000', volume: '0.001', created_at: '2026-08-05T03:35:01.000Z' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const response = await globalThis.fetch(`${baseUrl}/api/trade-automation/recovery/scan`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      recoveryRequired: number;
      reconciled: number;
      pending: number;
      manualReviewRequired: number;
      exchangeOrdersSubmitted: boolean;
      orders: TradingOrder[];
    };
    assert.equal(body.recoveryRequired, 1);
    assert.equal(body.reconciled, 1);
    assert.equal(body.pending, 0);
    assert.equal(body.manualReviewRequired, 0);
    assert.equal(body.exchangeOrdersSubmitted, false);
    assert.equal(body.orders[0]?.state, 'FILLED');
    assert.equal(externalRequests.length, 1);
    assert.equal(externalRequests.some((request) => request.method === 'POST' || /\/v1\/orders(?:\?|$)/.test(request.url)), false);
    const events = await repository.listEvents(USER_ID);
    assert.equal(events.some((event) => event.reason === 'SERVER_RESTART_RECONCILIATION_REQUIRED'), true);
    assert.equal(events.some((event) => event.reason === 'EXCHANGE_ORDER_RECONCILED'), true);
  } finally {
    globalThis.fetch = nativeFetch;
    delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
    setTradeAutomationRepositoryFactoryForTests(null);
    await close(server);
  }
});

// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import router, { setTradeAutomationRepositoryFactoryForTests } from './trade-automation';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';
import { normalizeTradingPolicy } from '../services/trade-automation-risk.service';
import { TradeAutomationService } from '../services/trade-automation.service';
import { DEFAULT_TRADING_POLICY } from '../services/trade-automation.types';

const USER = '22222222-2222-2222-2222-222222222222';

async function serverFor(repository: InMemoryTradingRepository) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.member = {
      id: USER, login_name: 'queue-test', display_name: 'queue-test', role: 'regular',
      membership_level: 'regular', status: 'approved', is_active: true,
    };
    req.accessToken = 'test';
    next();
  });
  setTradeAutomationRepositoryFactoryForTests(() => repository);
  app.use('/api/trade-automation', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: import('node:http').Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setTradeAutomationRepositoryFactoryForTests(null);
}

function paperPlan() {
  return {
    exchange: 'upbit', accountMode: 'paper', strategyId: 'breakout-v1', signalId: 'queue-signal',
    symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'market', quoteAmount: 40_000,
    quantity: null, limitPrice: null, estimatedKrw: 40_000, stopPrice: 98_000,
    targetPrices: [104_000], splitRatios: [100], signalReasons: ['trend'],
    signalState: 'confirmed', signalExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    entryPrice: 100_000, entryZoneLow: 99_000, entryZoneHigh: 101_000,
    estimatedSlippagePercent: 0.1, averageSpreadPercent: 0.1,
    economics: {
      sampleSize: 80, winProbability: 0.55, averageWinR: 1.5, averageLossR: 1,
      estimatedCostsR: 0.05, profitFactor: 1.4, maxDrawdownPercent: 8,
      marketRegime: 'bull', calibratedAt: new Date().toISOString(),
    },
    marketSnapshot: {
      observedAt: new Date().toISOString(), dataDelayMs: 100, oneMinuteMovePercent: 0,
      spreadPercent: 0.1, orderbookGapPercent: 0.1, halted: false, availableBalance: 1_000_000,
      accountValueKrw: 1_000_000, dailyPnlPercent: 0, assetExposurePercent: 0,
      openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
      currentPrice: 100_000, correlatedExposurePercent: 0,
    },
  };
}

test('plan queue is owner scoped, redacted, filterable, and never submits an order', async () => {
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, normalizeTradingPolicy(DEFAULT_TRADING_POLICY));
  const { server, baseUrl } = await serverFor(repository);
  try {
    const created = await fetch(`${baseUrl}/api/trade-automation/plans`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(paperPlan()),
    });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.equal(createdBody.plan.state, 'APPROVAL_PENDING');
    assert.equal(createdBody.plan.userId, undefined);
    assert.equal(createdBody.plan.idempotencyKey, undefined);

    const listed = await fetch(`${baseUrl}/api/trade-automation/plans`);
    assert.equal(listed.status, 200);
    const text = await listed.text();
    assert.doesNotMatch(text, /idempotencyKey|userId/);
    const body = JSON.parse(text);
    assert.equal(body.plans.length, 1);
    assert.equal(body.plans[0].internalIdentityExposed, false);
    assert.equal(body.actualOrderSubmittedByListRequest, false);
    assert.equal((await repository.listOrders(USER)).length, 0);

    const filtered = await fetch(`${baseUrl}/api/trade-automation/plans?state=FILLED`);
    assert.equal((await filtered.json()).plans.length, 0);
  } finally { await close(server); }
});

test('concurrent plan creation and approval produce one paper order and no exchange request', async () => {
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, normalizeTradingPolicy(DEFAULT_TRADING_POLICY));
  await repository.saveConnection({
    userId: USER, exchange: 'upbit', accountMode: 'paper', configured: true,
    encryptedCredentials: 'paper-test-only', lastVerifiedAt: null, lastErrorCode: null,
    updatedAt: new Date().toISOString(),
  });
  const { server, baseUrl } = await serverFor(repository);
  const nativeFetch = globalThis.fetch;
  const externalRequests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(baseUrl)) externalRequests.push(url);
    return nativeFetch(input, init);
  };
  try {
    const createResults = await Promise.all([0, 1].map(async () => {
      const response = await fetch(`${baseUrl}/api/trade-automation/plans`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(paperPlan()),
      });
      return { status: response.status, body: await response.json() };
    }));
    assert.deepEqual(createResults.map((item) => item.status), [200, 200]);
    assert.equal(new Set(createResults.map((item) => item.body.plan.id)).size, 1);
    assert.equal(createResults.filter((item) => item.body.duplicate === true).length, 1);
    assert.equal((await repository.listPlans(USER)).length, 1);

    const planId = createResults[0].body.plan.id;
    const approveResults = await Promise.all([0, 1].map(async () => {
      const response = await fetch(`${baseUrl}/api/trade-automation/plans/${planId}/approve`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved: true }),
      });
      return { status: response.status, body: await response.json() };
    }));
    assert.deepEqual(approveResults.map((item) => item.status).sort((a, b) => a - b), [200, 400]);
    const approved = approveResults.find((item) => item.status === 200);
    const rejected = approveResults.find((item) => item.status === 400);
    assert.equal(approved?.body.order.state, 'FILLED');
    assert.equal(rejected?.body.error, 'TRADE_PLAN_NOT_APPROVAL_PENDING');

    const orders = await repository.listOrders(USER);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].state, 'FILLED');
    const reasons = (await repository.listEvents(USER)).map((event) => event.reason);
    for (const reason of ['ORDER_CREATED', 'PAPER_BROKER_ACCEPTED', 'PAPER_BROKER_FILLED']) {
      assert.equal(reasons.filter((value) => value === reason).length, 1, reason);
    }
    assert.equal(externalRequests.length, 0);
  } finally {
    globalThis.fetch = nativeFetch;
    await close(server);
  }
});

test('separate service instances sharing one repository create one plan and one order', async () => {
  const repository = new InMemoryTradingRepository();
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  await repository.savePolicy(USER, policy);

  const firstService = new TradeAutomationService(repository);
  const secondService = new TradeAutomationService(repository);
  const createResults = await Promise.all([
    firstService.createPlan(USER, paperPlan(), policy, false),
    secondService.createPlan(USER, paperPlan(), policy, false),
  ]);

  assert.equal(createResults.filter((result) => result.duplicate).length, 1);
  assert.equal(new Set(createResults.map((result) => result.plan?.id)).size, 1);
  assert.equal((await repository.listPlans(USER)).length, 1);

  const planId = createResults[0].plan.id;
  const approvalResults = await Promise.allSettled([
    firstService.approvePlan(USER, planId),
    secondService.approvePlan(USER, planId),
  ]);
  assert.equal(approvalResults.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(approvalResults.filter((result) => result.status === 'rejected').length, 1);
  const rejected = approvalResults.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason?.message, 'TRADE_PLAN_NOT_APPROVAL_PENDING');

  const approvedPlan = approvalResults.find((result) => result.status === 'fulfilled').value;
  const orderResults = await Promise.all([
    firstService.createOrder(USER, approvedPlan),
    secondService.createOrder(USER, approvedPlan),
  ]);
  assert.equal(orderResults.filter((result) => result.duplicate).length, 1);
  assert.equal(new Set(orderResults.map((result) => result.order.id)).size, 1);
  assert.equal((await repository.listOrders(USER)).length, 1);

  const orderCreatedEvents = (await repository.listEvents(USER))
    .filter((event) => event.reason === 'ORDER_CREATED');
  assert.equal(orderCreatedEvents.length, 1);
});

test('service recreation does not recreate or recover a completed order', async () => {
  const repository = new InMemoryTradingRepository();
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  await repository.savePolicy(USER, policy);

  const originalService = new TradeAutomationService(repository);
  const created = await originalService.createPlan(USER, paperPlan(), policy, false);
  const approvedPlan = await originalService.approvePlan(USER, created.plan.id);
  const createdOrder = await originalService.createOrder(USER, approvedPlan);
  await originalService.transition(createdOrder.order, 'ACCEPTED', 'PAPER_BROKER_ACCEPTED');
  await originalService.transition(createdOrder.order, 'FILLED', 'PAPER_BROKER_FILLED', {
    filledQuantity: createdOrder.order.requestedQuantity ?? 0,
    averageFillPrice: approvedPlan.entryPrice,
  });

  const eventsBeforeRestart = await repository.listEvents(USER);
  const restartedService = new TradeAutomationService(repository);
  const duplicate = await restartedService.createOrder(USER, approvedPlan);
  const recoverable = await restartedService.recoverOpenOrders(USER);

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.order.id, createdOrder.order.id);
  assert.equal(duplicate.order.state, 'FILLED');
  assert.deepEqual(recoverable, []);
  assert.equal((await repository.listOrders(USER)).length, 1);
  assert.equal((await repository.listEvents(USER)).length, eventsBeforeRestart.length);
});

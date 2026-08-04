// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import router, { setTradeSignalApprovalRepositoryFactoryForTests } from './trade-signal-approval';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';
import { TradeAutomationService } from '../services/trade-automation.service';
import { normalizeTradingPolicy } from '../services/trade-automation-risk.service';
import { DEFAULT_TRADING_POLICY } from '../services/trade-automation.types';

const USER = '11111111-1111-1111-1111-111111111111';
const MONITOR_TOKEN = 'test-signal-monitor-token';
process.env.SIGNAL_MONITOR_TOKEN = MONITOR_TOKEN;

async function startServer(repository: InMemoryTradingRepository, authenticated = true) {
  const app = express();
  app.use(express.json());
  if (authenticated) app.use((req, _res, next) => {
    req.member = {
      id: USER,
      login_name: 'test',
      display_name: 'test',
      role: 'regular',
      membership_level: 'regular',
      status: 'approved',
      is_active: true,
    };
    req.accessToken = 'test';
    next();
  });
  setTradeSignalApprovalRepositoryFactoryForTests(() => repository);
  app.use('/api/trade-automation', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

async function close(server: import('node:http').Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function planInput(signalId: string) {
  const now = new Date().toISOString();
  return {
    exchange: 'upbit',
    accountMode: 'paper',
    strategyId: 'scanner-v1',
    signalId,
    symbol: 'BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'market',
    quantity: 10,
    quoteAmount: 100_000,
    limitPrice: null,
    estimatedKrw: 100_000,
    stopPrice: 90_000,
    targetPrices: [110_000],
    splitRatios: [50, 30, 20],
    invalidateAction: 'hold',
    signalReasons: ['trend', 'volume'],
    signalScore: 82,
    signalConfidence: 78,
    minimumSignalScore: 70,
    minimumSignalConfidence: 65,
    minimumRiskReward: 1.5,
    signalRiskReward: 2,
    signalCoreConditionsMaintained: true,
    signalExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    marketSnapshot: {
      observedAt: now,
      dataDelayMs: 100,
      oneMinuteMovePercent: 0.5,
      spreadPercent: 0.1,
      orderbookGapPercent: 0.2,
      halted: false,
      availableBalance: 1_000_000,
      accountValueKrw: 5_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 5,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
    },
  };
}

test.after(() => {
  setTradeSignalApprovalRepositoryFactoryForTests(null);
  delete process.env.SIGNAL_MONITOR_TOKEN;
});

test('approval status endpoint requires authentication', async () => {
  const repository = new InMemoryTradingRepository();
  const { server, baseUrl } = await startServer(repository, false);
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/plans/missing/approval-status`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).approvalEnabled, false);
  } finally {
    await close(server);
  }
});

test('approval queue returns safe plan summaries without account balances or credentials', async () => {
  const repository = new InMemoryTradingRepository();
  const automation = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  await repository.savePolicy(USER, policy);
  const created = await automation.createPlan(USER, planInput('queue-safe-shape'), policy, false);
  assert.ok(created.plan);

  const { server, baseUrl } = await startServer(repository);
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/approval-queue`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /availableBalance|accountValueKrw|idempotencyKey|userId|encryptedCredentials|accessKey|secretKey/);
    const body = JSON.parse(text);
    assert.equal(body.count, 1);
    assert.equal(body.items[0].id, created.plan.id);
    assert.equal(body.items[0].approval.approvalEnabled, true);
    assert.equal(body.accountBalancesExposed, false);
    assert.equal(body.credentialsExposed, false);
    assert.equal(body.orderSubmitted, false);
  } finally {
    await close(server);
  }
});

test('untrusted clients cannot forge signal revalidation', async () => {
  const repository = new InMemoryTradingRepository();
  const automation = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  await repository.savePolicy(USER, policy);
  const created = await automation.createPlan(USER, planInput('route-forgery-block'), policy, false);
  const { server, baseUrl } = await startServer(repository);
  try {
    const now = new Date().toISOString();
    const response = await fetch(`${baseUrl}/api/trade-automation/plans/${created.plan.id}/revalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signal-monitor-token': 'wrong-token' },
      body: JSON.stringify({
        score: 100,
        confidence: 100,
        coreConditionsMaintained: true,
        riskReward: 10,
        dataTimestamp: now,
        marketSnapshot: { ...created.plan.marketSnapshot, observedAt: now },
      }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'SIGNAL_MONITOR_UNAUTHORIZED');
    const stored = await repository.getPlan(USER, created.plan.id);
    assert.equal(stored.signalScore, 82);
    assert.equal(stored.signalConfidence, 78);
  } finally {
    await close(server);
  }
});

test('weakening disables approval without submitting an order', async () => {
  const repository = new InMemoryTradingRepository();
  const automation = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  await repository.savePolicy(USER, policy);
  const created = await automation.createPlan(USER, planInput('route-weakening'), policy, false);
  const { server, baseUrl } = await startServer(repository);
  try {
    const status = await fetch(`${baseUrl}/api/trade-automation/plans/${created.plan.id}/approval-status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).approval.approvalEnabled, true);

    const now = new Date().toISOString();
    const response = await fetch(`${baseUrl}/api/trade-automation/plans/${created.plan.id}/revalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signal-monitor-token': MONITOR_TOKEN },
      body: JSON.stringify({
        score: 68,
        confidence: 63,
        coreConditionsMaintained: true,
        riskReward: 2,
        reasons: ['volume weakened'],
        dataTimestamp: now,
        marketSnapshot: { ...created.plan.marketSnapshot, observedAt: now },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.plan.signalState, 'WEAKENED');
    assert.equal(body.plan.state, 'APPROVAL_PENDING');
    assert.equal(body.approvalButtonDisabled, true);
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.order, null);
  } finally {
    await close(server);
  }
});

test('condition invalidation cancels only the unfilled remainder and preserves fills', async () => {
  const repository = new InMemoryTradingRepository();
  const automation = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  await repository.savePolicy(USER, policy);
  const created = await automation.createPlan(USER, planInput('route-partial'), policy, false);
  const approved = await automation.approvePlan(USER, created.plan.id);
  const { order } = await automation.createOrder(USER, approved);
  await automation.transition(order, 'ACCEPTED', 'TEST_ACCEPTED');
  await automation.transition(order, 'PARTIALLY_FILLED', 'TEST_PARTIAL', { filledQuantity: 4 });

  const { server, baseUrl } = await startServer(repository);
  try {
    const now = new Date().toISOString();
    const response = await fetch(`${baseUrl}/api/trade-automation/plans/${created.plan.id}/revalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signal-monitor-token': MONITOR_TOKEN },
      body: JSON.stringify({
        score: 80,
        confidence: 80,
        coreConditionsMaintained: false,
        riskReward: 2,
        reasons: ['support lost'],
        invalidationReason: 'SUPPORT_LEVEL_BROKEN',
        dataTimestamp: now,
        marketSnapshot: { ...created.plan.marketSnapshot, observedAt: now },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.plan.signalState, 'INVALIDATED');
    assert.equal(body.approvalButtonDisabled, true);
    assert.equal(body.followUpEntriesCancelled, true);
    assert.equal(body.filledQuantityPreserved, 4);
    assert.equal(body.order.state, 'CANCELED');
    assert.equal(body.immediateMarketLiquidation, false);
    assert.equal(body.orderSubmitted, false);
  } finally {
    await close(server);
  }
});

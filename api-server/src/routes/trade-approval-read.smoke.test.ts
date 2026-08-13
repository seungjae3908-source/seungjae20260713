import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import router, { setTradeApprovalReadRepositoryFactoryForTests } from './trade-approval-read';
import type { AuthenticatedRequest } from '../middleware/auth';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';
import type { TradingPlan } from '../services/trade-automation.types';

const USER = '91919191-9191-4919-8919-919191919191';

async function startServer(repository: InMemoryTradingRepository) {
  const app = express();
  app.use((req, _res, next) => {
    const authReq = req as AuthenticatedRequest;
    authReq.member = {
      id: USER,
      login_name: 'trade-read-test',
      display_name: 'trade-read-test',
      role: 'regular',
      membership_level: 'regular',
      status: 'approved',
      is_active: true,
    };
    authReq.accessToken = 'test-token';
    next();
  });
  setTradeApprovalReadRepositoryFactoryForTests(() => repository);
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
  setTradeApprovalReadRepositoryFactoryForTests(null);
}

function plan(overrides: Partial<TradingPlan> = {}): TradingPlan {
  const now = new Date().toISOString();
  return {
    id: '92929292-9292-4929-8929-929292929292',
    userId: USER,
    idempotencyKey: 'approval-read-smoke',
    state: 'APPROVAL_PENDING',
    version: 0,
    approvalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvedAt: null,
    createdAt: now,
    updatedAt: now,
    exchange: 'upbit',
    accountMode: 'paper',
    strategyId: 'smoke-strategy',
    signalId: 'smoke-signal',
    symbol: 'BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'market',
    quantity: null,
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
    signalReasons: ['trend'],
    marketSnapshot: {
      observedAt: now,
      riskObservedAt: now,
      dataDelayMs: 0,
      oneMinuteMovePercent: 0,
      spreadPercent: 0.1,
      orderbookGapPercent: 0.1,
      halted: false,
      availableBalance: 1_000_000,
      accountValueKrw: 1_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 0,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
      signalState: 'entry_ready',
      signalObservedAt: now,
    },
    ...overrides,
  };
}

test('approval queue and approval status are GET-only read models', async () => {
  const repository = new InMemoryTradingRepository();
  const fixture = plan();
  await repository.savePlan(fixture);
  const { server, baseUrl } = await startServer(repository);
  try {
    const queueResponse = await fetch(`${baseUrl}/api/trade-automation/approval-queue`);
    assert.equal(queueResponse.status, 200);
    const queue = await queueResponse.json() as {
      items: Array<{ id: string; approval: { approvalEnabled: boolean }; order: unknown }>;
      orderSubmitted: boolean;
      orderCanceled: boolean;
      privateTradingRequestSent: boolean;
    };
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0]?.id, fixture.id);
    assert.equal(queue.items[0]?.approval.approvalEnabled, true);
    assert.equal(queue.items[0]?.order, null);
    assert.equal(queue.orderSubmitted, false);
    assert.equal(queue.orderCanceled, false);
    assert.equal(queue.privateTradingRequestSent, false);

    const statusResponse = await fetch(`${baseUrl}/api/trade-automation/plans/${fixture.id}/approval-status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json() as {
      approval: { approvalEnabled: boolean; signalState: string; planState: string };
      orderSubmitted: boolean;
    };
    assert.equal(status.approval.approvalEnabled, true);
    assert.equal(status.approval.signalState, 'READY_FOR_APPROVAL');
    assert.equal(status.approval.planState, 'APPROVAL_PENDING');
    assert.equal(status.orderSubmitted, false);
  } finally {
    await close(server);
  }
});

test('live account plans remain approval locked in the read model', async () => {
  const repository = new InMemoryTradingRepository();
  const fixture = plan({
    id: '93939393-9393-4939-8939-939393939393',
    idempotencyKey: 'approval-read-live-locked',
    accountMode: 'live',
  });
  await repository.savePlan(fixture);
  const { server, baseUrl } = await startServer(repository);
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/plans/${fixture.id}/approval-status`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      approval: { approvalEnabled: boolean; reasonCode: string | null };
      orderSubmitted: boolean;
      privateTradingRequestSent: boolean;
    };
    assert.equal(body.approval.approvalEnabled, false);
    assert.equal(body.approval.reasonCode, 'LIVE_APPROVAL_LOCKED');
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.privateTradingRequestSent, false);
  } finally {
    await close(server);
  }
});

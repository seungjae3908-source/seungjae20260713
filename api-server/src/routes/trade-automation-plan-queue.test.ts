// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import router, { setTradeAutomationRepositoryFactoryForTests } from './trade-automation';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';
import { normalizeTradingPolicy } from '../services/trade-automation-risk.service';
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

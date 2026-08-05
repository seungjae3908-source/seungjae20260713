import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { normalizeTradingPolicy } from '../services/trade-automation-risk.service';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';
import { TradeAutomationService } from '../services/trade-automation.service';
import { DEFAULT_TRADING_POLICY, type TradingPlanInput } from '../services/trade-automation.types';
import router, { setTradeSignalAlertRepositoryFactoryForTests } from './trade-signal-alerts';

const USER = '11111111-1111-1111-1111-111111111111';

type ApprovalAlert = {
  id: string;
  kind: string;
  currentSignalState: string;
};
type ApprovalAlertsResponse = {
  alerts: ApprovalAlert[];
  orderSubmitted: boolean;
  credentialsExposed: boolean;
};

async function startServer(repository: InMemoryTradingRepository, authenticated = true) {
  const app = express();
  if (authenticated) {
    app.use((req, _res, next) => {
      const authenticatedRequest = req as AuthenticatedRequest;
      authenticatedRequest.member = {
        id: USER,
        login_name: 'test',
        display_name: 'test',
        role: 'regular',
        membership_level: 'regular',
        status: 'approved',
        is_active: true,
      };
      authenticatedRequest.accessToken = 'test';
      next();
    });
  }
  setTradeSignalAlertRepositoryFactoryForTests(() => repository);
  app.use('/api/trade-automation', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function input(signalId: string): TradingPlanInput {
  const now = new Date().toISOString();
  return {
    exchange: 'kiwoom',
    accountMode: 'paper',
    strategyId: 'scanner-1d',
    signalId,
    symbol: '005930',
    market: 'KR',
    side: 'buy',
    orderType: 'market',
    quantity: 1,
    quoteAmount: null,
    limitPrice: null,
    estimatedKrw: 70_000,
    stopPrice: 67_000,
    targetPrices: [74_500],
    splitRatios: [100],
    signalReasons: ['trend'],
    signalWarnings: [],
    signalScore: 84,
    signalConfidence: 79,
    minimumSignalScore: 70,
    minimumSignalConfidence: 60,
    minimumRiskReward: 1.5,
    signalRiskReward: 1.8,
    signalCoreConditionsMaintained: true,
    signalExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    marketSnapshot: {
      observedAt: now,
      dataDelayMs: 0,
      oneMinuteMovePercent: 0,
      spreadPercent: 0.01,
      orderbookGapPercent: 0.01,
      halted: false,
      availableBalance: 1_000_000,
      accountValueKrw: 1_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 0,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
    },
  };
}

test.after(() => setTradeSignalAlertRepositoryFactoryForTests(null));

test('approval alerts require authentication', async () => {
  const repository = new InMemoryTradingRepository();
  const { server, baseUrl } = await startServer(repository, false);
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/approval-alerts`);
    assert.equal(response.status, 401);
    const body = await response.json() as ApprovalAlertsResponse;
    assert.deepEqual(body.alerts, []);
  } finally {
    await close(server);
  }
});

test('approval alerts are member scoped, deterministic, and expose no credentials', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  await repository.savePolicy(USER, policy);
  const created = await service.createPlan(USER, input('alert-plan'), policy, false);
  assert.ok(created.plan);
  await service.revalidatePlan(USER, created.plan.id, {
    score: 84,
    confidence: 79,
    coreConditionsMaintained: true,
    riskReward: 1.8,
    reasons: ['trend'],
    dataTimestamp: new Date().toISOString(),
    marketSnapshot: { ...created.plan.marketSnapshot, observedAt: new Date().toISOString() },
  });

  const { server, baseUrl } = await startServer(repository);
  try {
    const first = await fetch(`${baseUrl}/api/trade-automation/approval-alerts`);
    const second = await fetch(`${baseUrl}/api/trade-automation/approval-alerts`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const firstText = await first.text();
    const secondBody = await second.json() as ApprovalAlertsResponse;
    assert.doesNotMatch(firstText, /userId|idempotencyKey|marketSnapshot|availableBalance|encryptedCredentials/);
    const firstBody = JSON.parse(firstText) as ApprovalAlertsResponse;
    assert.deepEqual(firstBody.alerts.map((item) => item.id), secondBody.alerts.map((item) => item.id));
    assert.equal(firstBody.alerts.filter((item) => item.kind === 'CONDITION_MET').length, 1);
    assert.equal(firstBody.alerts.filter((item) => item.kind === 'CONDITION_MAINTAINED').length, 1);
    assert.ok(firstBody.alerts.every((item) => item.currentSignalState === 'READY_FOR_APPROVAL'));
    assert.equal(firstBody.orderSubmitted, false);
    assert.equal(firstBody.credentialsExposed, false);
  } finally {
    await close(server);
  }
});

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { normalizeTradingPolicy } from '../services/trade-automation-risk.service';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';
import { TradeAutomationService } from '../services/trade-automation.service';
import type { ScannerApprovalPlanRequest } from '../services/scanner-approval-plan.service';
import {
  DEFAULT_TRADING_POLICY,
  type TradingPlan,
  type TradingPlanInput,
  type TradingSignalValidationInput,
} from '../services/trade-automation.types';
import router, { setScannerApprovalFactoriesForTests } from './scanner-approval';

const USER = '11111111-1111-1111-1111-111111111111';
type ScannerServiceFactory = NonNullable<Parameters<typeof setScannerApprovalFactoriesForTests>[1]>;

type ErrorBody = { error: string };
type ApprovalBody = {
  order: { state: string; filledQuantity: number };
  paperOrderCreated: boolean;
  liveOrderSubmitted: boolean;
  exchangeRequestSent: boolean;
};

function validRevalidation(plan: TradingPlan): TradingSignalValidationInput {
  const now = new Date().toISOString();
  return {
    score: 84,
    confidence: 79,
    coreConditionsMaintained: true,
    riskReward: 1.5,
    reasons: ['server revalidated'],
    warnings: [],
    dataTimestamp: now,
    marketSnapshot: { ...plan.marketSnapshot, observedAt: now },
  };
}

async function startServer(
  repository: InMemoryTradingRepository,
  serviceFactory: ScannerServiceFactory = () => ({
    createPaperPlan: async (_userId, _request) => ({
      plan: { id: 'server-plan', accountMode: 'paper', state: 'APPROVAL_PENDING' },
      approval: { approvalEnabled: true },
      duplicate: false,
      serverVerified: true,
      liveOrderEnabled: false,
    }),
    revalidatePaperPlan: async (_userId, plan) => validRevalidation(plan),
  }),
  authenticated = true,
) {
  const app = express();
  app.use(express.json());
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
  setScannerApprovalFactoriesForTests(() => repository, serviceFactory);
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

async function close(server: Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function paperPlanInput(signalId: string): TradingPlanInput {
  const now = new Date().toISOString();
  return {
    exchange: 'kiwoom',
    accountMode: 'paper',
    strategyId: 'scanner-1d-test',
    signalId,
    symbol: '005930',
    market: 'KR',
    side: 'buy',
    orderType: 'market',
    quantity: 4,
    quoteAmount: null,
    limitPrice: null,
    estimatedKrw: 280_000,
    stopPrice: 67_000,
    targetPrices: [74_500, 77_500],
    splitRatios: [40, 30, 30],
    signalReasons: ['server verified'],
    signalWarnings: [],
    signalScore: 84,
    signalConfidence: 79,
    minimumSignalScore: 70,
    minimumSignalConfidence: 60,
    minimumRiskReward: 1.5,
    signalRiskReward: 1.5,
    signalCoreConditionsMaintained: true,
    signalExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    scannerContext: {
      market: 'KR',
      timeframe: '1D',
      selectedConditions: ['거래량 증가', '5일선 돌파'],
      volumeThreshold: null,
      tradingValueThreshold: null,
      marketCapThreshold: null,
      volumeLookbackDays: 20,
      tradingValueLookbackDays: 20,
      minimumScore: 70,
      minimumConfidence: 60,
      maximumRiskScore: 50,
      maxEntryDriftPercent: 2.5,
    },
    marketSnapshot: {
      observedAt: now,
      dataDelayMs: 0,
      oneMinuteMovePercent: 0.2,
      spreadPercent: 0.02,
      orderbookGapPercent: 0.02,
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

test.after(() => setScannerApprovalFactoriesForTests(null, null));

test('scanner plan route requires authentication', async () => {
  const repository = new InMemoryTradingRepository();
  const { server, baseUrl } = await startServer(repository, undefined, false);
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/scanner/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 401);
  } finally {
    await close(server);
  }
});

test('scanner plan route allowlists inputs and ignores forged price or score fields', async () => {
  const repository = new InMemoryTradingRepository();
  const received: ScannerApprovalPlanRequest[] = [];
  const factory: ScannerServiceFactory = () => ({
    createPaperPlan: async (_userId, request) => {
      received.push(request);
      return {
        plan: { id: 'server-plan', accountMode: 'paper', state: 'APPROVAL_PENDING' },
        approval: { approvalEnabled: true },
        duplicate: false,
        serverVerified: true,
        liveOrderEnabled: false,
      };
    },
    revalidatePaperPlan: async (_userId, plan) => validRevalidation(plan),
  });
  const { server, baseUrl } = await startServer(repository, factory);
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/scanner/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        market: 'KR',
        symbol: '005930',
        timeframe: '1D',
        selectedConditions: ['거래량 증가', '5일선 돌파'],
        requestedInvestmentKrw: 200_000,
        score: 100,
        confidence: 100,
        price: 1,
        stopPrice: 0,
        targetPrices: [999999999],
        marketSnapshot: { availableBalance: 999999999999 },
      }),
    });
    assert.equal(response.status, 201);
    const body = await response.json() as {
      serverVerified: boolean;
      liveOrderEnabled: boolean;
      orderSubmitted: boolean;
      exchangeRequestSent: boolean;
    };
    assert.equal(body.serverVerified, true);
    assert.equal(body.liveOrderEnabled, false);
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.exchangeRequestSent, false);
    const captured = received[0];
    assert.ok(captured);
    assert.equal(captured.symbol, '005930');
    assert.equal(captured.requestedInvestmentKrw, 200_000);
    assert.equal(Object.prototype.hasOwnProperty.call(captured, 'score'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(captured, 'price'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(captured, 'marketSnapshot'), false);
  } finally {
    await close(server);
  }
});

test('paper approval requires explicit confirmation, server revalidation, and fills without exchange connection', async () => {
  const repository = new InMemoryTradingRepository();
  const policy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    totalCapitalKrw: 1_000_000,
    maxOrderKrw: 500_000,
    maxAssetPercent: 30,
  });
  await repository.savePolicy(USER, policy);
  const automation = new TradeAutomationService(repository);
  const created = await automation.createPlan(USER, paperPlanInput('paper-route'), policy, false);
  assert.ok(created.plan);
  const planId = created.plan.id;
  let revalidationCalls = 0;
  const factory: ScannerServiceFactory = () => ({
    createPaperPlan: async () => { throw new Error('not used'); },
    revalidatePaperPlan: async (_userId, plan) => {
      revalidationCalls += 1;
      return validRevalidation(plan);
    },
  });
  const { server, baseUrl } = await startServer(repository, factory);
  try {
    const denied = await fetch(`${baseUrl}/api/trade-automation/plans/${planId}/approve-paper`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json() as ErrorBody).error, 'EXPLICIT_APPROVAL_REQUIRED');
    assert.equal(revalidationCalls, 0);

    const nativeFetch = globalThis.fetch;
    let outbound = 0;
    const guardedFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith(baseUrl)) {
        outbound += 1;
        throw new Error('external blocked');
      }
      return nativeFetch(input, init);
    };
    globalThis.fetch = guardedFetch;
    try {
      const approved = await globalThis.fetch(`${baseUrl}/api/trade-automation/plans/${planId}/approve-paper`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      assert.equal(approved.status, 200);
      const body = await approved.json() as ApprovalBody;
      assert.equal(revalidationCalls, 1);
      assert.equal(body.order.state, 'FILLED');
      assert.equal(body.order.filledQuantity, 4);
      assert.equal(body.paperOrderCreated, true);
      assert.equal(body.liveOrderSubmitted, false);
      assert.equal(body.exchangeRequestSent, false);
      assert.equal(outbound, 0);
    } finally {
      globalThis.fetch = nativeFetch;
    }
  } finally {
    await close(server);
  }
});

test('condition break at final approval expires the plan and creates zero orders', async () => {
  const repository = new InMemoryTradingRepository();
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  await repository.savePolicy(USER, policy);
  const automation = new TradeAutomationService(repository);
  const created = await automation.createPlan(USER, paperPlanInput('final-revalidation-break'), policy, false);
  assert.ok(created.plan);
  const planId = created.plan.id;
  const factory: ScannerServiceFactory = () => ({
    createPaperPlan: async () => { throw new Error('not used'); },
    revalidatePaperPlan: async (_userId, plan) => ({
      ...validRevalidation(plan),
      score: 40,
      confidence: 40,
      coreConditionsMaintained: false,
      invalidationReason: 'SCANNER_AND_CONDITIONS_NOT_MAINTAINED',
    }),
  });
  const { server, baseUrl } = await startServer(repository, factory);
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/plans/${planId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as ErrorBody).error, 'TRADE_PLAN_SIGNAL_NOT_APPROVABLE');
    const stored = await repository.getPlan(USER, planId);
    assert.ok(stored);
    assert.equal(stored.state, 'EXPIRED');
    assert.equal(stored.signalState, 'INVALIDATED');
    assert.equal((await repository.listOrders(USER)).length, 0);
  } finally {
    await close(server);
  }
});

test('paper approval cannot be used for a non-scanner or live plan', async () => {
  const repository = new InMemoryTradingRepository();
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  await repository.savePolicy(USER, policy);
  const automation = new TradeAutomationService(repository);
  const created = await automation.createPlan(USER, {
    ...paperPlanInput('non-scanner'),
    strategyId: 'manual-plan',
  }, policy, false);
  assert.ok(created.plan);
  const { server, baseUrl } = await startServer(repository);
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/plans/${created.plan.id}/approve-paper`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as ErrorBody).error, 'SCANNER_PAPER_APPROVAL_ONLY');
  } finally {
    await close(server);
  }
});

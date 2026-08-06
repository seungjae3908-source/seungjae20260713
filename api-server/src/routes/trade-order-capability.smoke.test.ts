import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import router from './index';
import type { AuthenticatedRequest, MemberProfile } from '../middleware/auth';
import { setScannerApprovalFactoriesForTests } from './scanner-approval';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';
import { TradeAutomationService } from '../services/trade-automation.service';
import { normalizeTradingPolicy } from '../services/trade-automation-risk.service';
import {
  DEFAULT_TRADING_POLICY,
  type TradingPlan,
  type TradingPlanInput,
  type TradingSignalValidationInput,
} from '../services/trade-automation.types';

const USER = '11111111-1111-1111-1111-111111111111';

function profile(
  membershipLevel: MemberProfile['membership_level'],
  status: MemberProfile['status'] = 'approved',
  isActive = true,
): MemberProfile {
  return {
    id: USER,
    login_name: `test-${membershipLevel}`,
    display_name: `test-${membershipLevel}`,
    role: membershipLevel === 'admin' ? 'admin' : String(membershipLevel),
    membership_level: membershipLevel,
    status,
    is_active: isActive,
  };
}

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

function paperPlanInput(signalId: string): TradingPlanInput {
  const now = new Date().toISOString();
  return {
    exchange: 'kiwoom',
    accountMode: 'paper',
    strategyId: 'scanner-1d-capability',
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
      selectedConditions: ['거래량 증가'],
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

async function startServer(
  repository: InMemoryTradingRepository,
  member: MemberProfile,
  createCalls: { value: number },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const authenticated = req as AuthenticatedRequest;
    authenticated.member = member;
    authenticated.accessToken = 'test-access-token';
    next();
  });
  setScannerApprovalFactoriesForTests(
    () => repository,
    () => ({
      createPaperPlan: async () => {
        createCalls.value += 1;
        return {
          plan: { id: 'server-plan', accountMode: 'paper', state: 'APPROVAL_PENDING' },
          approval: { approvalEnabled: true },
          duplicate: false,
          serverVerified: true,
          liveOrderEnabled: false,
        };
      },
      revalidatePaperPlan: async (_userId, plan) => validRevalidation(plan),
    }),
  );
  app.use('/api', router);
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

async function postJson(baseUrl: string, path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createStoredPaperPlan(repository: InMemoryTradingRepository, signalId: string) {
  const policy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    totalCapitalKrw: 1_000_000,
    maxOrderKrw: 500_000,
    maxAssetPercent: 30,
  });
  await repository.savePolicy(USER, policy);
  const result = await new TradeAutomationService(repository).createPlan(
    USER,
    paperPlanInput(signalId),
    policy,
    false,
  );
  assert.ok(result.plan);
  return result.plan;
}

test.after(() => setScannerApprovalFactoriesForTests(null, null));

for (const denied of [
  profile('associate'),
  profile('regular'),
  profile('admin', 'suspended'),
  profile('admin', 'approved', false),
]) {
  test(`${denied.membership_level} ${denied.status} cannot create or approve paper orders`, async () => {
    const repository = new InMemoryTradingRepository();
    const plan = await createStoredPaperPlan(repository, `denied-${denied.membership_level}-${denied.status}-${String(denied.is_active)}`);
    const createCalls = { value: 0 };
    const { server, baseUrl } = await startServer(repository, denied, createCalls);
    try {
      const createResponse = await postJson(baseUrl, '/api/trade-automation/scanner/plans', {
        mode: 'approval',
        accountMode: 'paper',
        adapter: 'paper',
        market: 'KR',
        symbol: '005930',
        timeframe: '1D',
        selectedConditions: ['거래량 증가'],
      });
      assert.equal(createResponse.status, 403);
      const createBody = await createResponse.json() as { error: string; capability: string };
      assert.equal(createBody.error, 'CAPABILITY_REQUIRED');
      assert.equal(createBody.capability, 'canPlaceOrders');
      assert.equal(createCalls.value, 0);

      const approveResponse = await postJson(baseUrl, `/api/trade-automation/plans/${plan.id}/approve-paper`, {
        approved: true,
        mode: 'approval',
        accountMode: 'paper',
        adapter: 'paper',
      });
      assert.equal(approveResponse.status, 403);
      assert.equal((await approveResponse.json() as { error: string }).error, 'CAPABILITY_REQUIRED');
      assert.equal((await repository.listOrders(USER)).length, 0);
      assert.equal((await repository.listEvents(USER)).length, 0);
      assert.equal((await repository.getPlan(USER, plan.id))?.state, 'APPROVAL_PENDING');
    } finally {
      await close(server);
    }
  });
}

test('active admin can explicitly approve a paper plan with zero external request', async () => {
  const repository = new InMemoryTradingRepository();
  const plan = await createStoredPaperPlan(repository, 'active-admin-paper');
  const createCalls = { value: 0 };
  const { server, baseUrl } = await startServer(repository, profile('admin'), createCalls);
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(baseUrl)) {
      outbound += 1;
      throw new Error('external request blocked');
    }
    return nativeFetch(input, init);
  };
  try {
    const response = await postJson(baseUrl, `/api/trade-automation/plans/${plan.id}/approve-paper`, {
      approved: true,
      mode: 'approval',
      accountMode: 'paper',
      adapter: 'paper',
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      order: { state: string; filledQuantity: number };
      liveOrderSubmitted: boolean;
      exchangeRequestSent: boolean;
    };
    assert.equal(body.order.state, 'FILLED');
    assert.equal(body.order.filledQuantity, 4);
    assert.equal(body.liveOrderSubmitted, false);
    assert.equal(body.exchangeRequestSent, false);
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = nativeFetch;
    await close(server);
  }
});

test('active admin scanner endpoint rejects live, automatic and wrong adapters before persistence', async () => {
  const repository = new InMemoryTradingRepository();
  const createCalls = { value: 0 };
  const { server, baseUrl } = await startServer(repository, profile('admin'), createCalls);
  try {
    const cases = [
      [{ mode: 'approval', accountMode: 'live', adapter: 'paper' }, 'LIVE_MODE_FORBIDDEN'],
      [{ mode: 'automatic', accountMode: 'paper', adapter: 'paper' }, 'AUTOMATIC_MODE_FORBIDDEN'],
      [{ mode: 'approval', accountMode: 'paper', adapter: 'bitget-live' }, 'PAPER_ADAPTER_REQUIRED'],
      [{ mode: 'approval', accountMode: 'sandbox', adapter: 'paper' }, 'PAPER_ACCOUNT_MODE_REQUIRED'],
    ] as const;
    for (const [tamper, expectedError] of cases) {
      const response = await postJson(baseUrl, '/api/trade-automation/scanner/plans', {
        ...tamper,
        market: 'KR',
        symbol: '005930',
        timeframe: '1D',
        selectedConditions: ['거래량 증가'],
      });
      assert.equal(response.status, 409);
      const body = await response.json() as {
        error: string;
        orderSubmitted: boolean;
        exchangeRequestSent: boolean;
      };
      assert.equal(body.error, expectedError);
      assert.equal(body.orderSubmitted, false);
      assert.equal(body.exchangeRequestSent, false);
    }
    assert.equal(createCalls.value, 0);
    assert.equal((await repository.listPlans(USER)).length, 0);
    assert.equal((await repository.listOrders(USER)).length, 0);
    assert.equal((await repository.listEvents(USER)).length, 0);
  } finally {
    await close(server);
  }
});

test('live-enabled environment cannot elevate scanner paper approval', async () => {
  const repository = new InMemoryTradingRepository();
  const plan = await createStoredPaperPlan(repository, 'live-env-paper');
  const createCalls = { value: 0 };
  const { server, baseUrl } = await startServer(repository, profile('admin'), createCalls);
  const previous = {
    ORDER_EXECUTION_ENABLED: process.env.ORDER_EXECUTION_ENABLED,
    LIVE_TRADING_ACTIVATION_APPROVED: process.env.LIVE_TRADING_ACTIVATION_APPROVED,
    KIWOOM_LIVE_ORDER_ENABLED: process.env.KIWOOM_LIVE_ORDER_ENABLED,
  };
  process.env.ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
  process.env.KIWOOM_LIVE_ORDER_ENABLED = 'true';
  try {
    const rejected = await postJson(baseUrl, `/api/trade-automation/plans/${plan.id}/approve-paper`, {
      approved: true,
      mode: 'approval',
      accountMode: 'live',
      adapter: 'kiwoom-live',
    });
    assert.equal(rejected.status, 409);
    const body = await rejected.json() as { error: string; exchangeRequestSent: boolean };
    assert.equal(body.error, 'LIVE_MODE_FORBIDDEN');
    assert.equal(body.exchangeRequestSent, false);
    assert.equal((await repository.listOrders(USER)).length, 0);
    assert.equal((await repository.listEvents(USER)).length, 0);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await close(server);
  }
});

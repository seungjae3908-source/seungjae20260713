import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import router, { setTradeAutomationRepositoryFactoryForTests } from './trade-automation';
import type { AuthenticatedRequest } from '../middleware/auth';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';
import { marketIntelligenceNotAvailable, tradingMarket } from '../services/market-intelligence-client.service';
import {
  marketIntelligenceSymbolForTradingPlan,
  setTradingPlanMarketIntelligenceRunnerForTests,
} from '../services/trade-market-intelligence.service';
import type { TradingPlanInput } from '../services/trade-automation.types';

const USER = '11111111-1111-1111-1111-111111111111';
const repository = new InMemoryTradingRepository();
const MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

async function unavailableMarketIntelligence(
  input: Pick<TradingPlanInput, 'exchange' | 'market' | 'symbol'>,
) {
  return marketIntelligenceNotAvailable(
    tradingMarket(input),
    marketIntelligenceSymbolForTradingPlan(input),
    'TEST_MARKET_INTELLIGENCE_UNAVAILABLE',
  );
}

async function startServer(authenticated = true, role: 'regular' | 'admin' = 'regular') {
  const app = express();
  app.use(express.json());
  if (authenticated) app.use((req, _res, next) => {
    const authenticatedRequest = req as AuthenticatedRequest;
    authenticatedRequest.member = {
      id: USER, login_name: 'test', display_name: 'test', role, membership_level: role,
      status: 'approved', is_active: true,
    };
    authenticatedRequest.accessToken = 'test';
    next();
  });
  app.use('/api/trade-automation', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: import('node:http').Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test.beforeEach(async () => {
  setTradeAutomationRepositoryFactoryForTests(() => repository);
  setTradingPlanMarketIntelligenceRunnerForTests(unavailableMarketIntelligence);
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  await repository.setGlobalEmergencyStop(false, USER);
});
test.after(() => {
  setTradeAutomationRepositoryFactoryForTests(null);
  setTradingPlanMarketIntelligenceRunnerForTests(null);
  delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
});

test('status is authenticated, defaults off, and never returns credential values', async () => {
  const unauthenticated = await startServer(false);
  try {
    const response = await fetch(`${unauthenticated.baseUrl}/api/trade-automation/status`);
    assert.equal(response.status, 401);
  } finally { await close(unauthenticated.server); }

  const authenticated = await startServer();
  try {
    const response = await fetch(`${authenticated.baseUrl}/api/trade-automation/status`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /encryptedCredentials|accessKey|secretKey|passphrase/);
    const body = JSON.parse(text) as {
      policy: { mode: string; automaticEnabled: boolean };
      actualOrderSubmittedByStatusRequest: boolean;
    };
    assert.equal(body.policy.mode, 'approval');
    assert.equal(body.policy.automaticEnabled, false);
    assert.equal(body.actualOrderSubmittedByStatusRequest, false);
  } finally { await close(authenticated.server); }
});

test('automatic policy cannot be enabled without explicit final confirmation', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/policy`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'automatic',
        automaticEnabled: true,
        exchangeEnabled: { upbit: true },
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { error: string };
    assert.equal(body.error, 'AUTOMATIC_TRADING_CONFIRMATION_REQUIRED');
  } finally { await close(server); }
});

test('persistent global emergency stop requires admin capability and exact confirmation', async () => {
  const regular = await startServer(true, 'regular');
  try {
    const denied = await fetch(`${regular.baseUrl}/api/trade-automation/admin/emergency-stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stopped: true, confirmation: 'STOP_ALL_TRADING' }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as { error: string }).error, 'ADMIN_REQUIRED');
  } finally { await close(regular.server); }

  const admin = await startServer(true, 'admin');
  try {
    const missingConfirmation = await fetch(`${admin.baseUrl}/api/trade-automation/admin/emergency-stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stopped: true }),
    });
    assert.equal(missingConfirmation.status, 409);

    const stopped = await fetch(`${admin.baseUrl}/api/trade-automation/admin/emergency-stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stopped: true, confirmation: 'STOP_ALL_TRADING' }),
    });
    assert.equal(stopped.status, 200);
    const stoppedBody = await stopped.json() as {
      persistentGlobalEmergencyStopped: boolean;
      automaticTradingEnabledByThisRequest: boolean;
    };
    assert.equal(stoppedBody.persistentGlobalEmergencyStopped, true);
    assert.equal(stoppedBody.automaticTradingEnabledByThisRequest, false);

    const status = await fetch(`${admin.baseUrl}/api/trade-automation/status`);
    const statusBody = await status.json() as { emergencyStopSources: { persistentGlobal: boolean } };
    assert.equal(statusBody.emergencyStopSources.persistentGlobal, true);

    const resumed = await fetch(`${admin.baseUrl}/api/trade-automation/admin/emergency-stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stopped: false, confirmation: 'RESUME_NEW_ORDER_EVALUATION' }),
    });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json() as { automaticTradingEnabledByThisRequest: boolean }).automaticTradingEnabledByThisRequest, false);
  } finally { await close(admin.server); }
});

test('connection registration rejects withdrawal permission and does not echo secrets', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const rejected = await fetch(`${baseUrl}/api/trade-automation/connections/upbit`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credentials: { accessKey: 'access-secret', secretKey: 'signing-secret' },
        permissions: ['orders', 'withdrawal'],
      }),
    });
    assert.equal(rejected.status, 400);
    assert.doesNotMatch(await rejected.text(), /access-secret|signing-secret/);

    const accepted = await fetch(`${baseUrl}/api/trade-automation/connections/upbit`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credentials: { accessKey: 'access-secret', secretKey: 'signing-secret' },
        permissions: ['orders'],
        accountMode: 'paper',
      }),
    });
    assert.equal(accepted.status, 200);
    const text = await accepted.text();
    assert.doesNotMatch(text, /access-secret|signing-secret/);
    const body = JSON.parse(text) as { credentialsReturned: boolean; accountMode: string };
    assert.equal(body.credentialsReturned, false);
    assert.equal(body.accountMode, 'paper');
  } finally { await close(server); }
});

test('approval route blocks unapproved calls and paper execution makes no external request', async () => {
  const { server, baseUrl } = await startServer();
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  try {
    const observedAt = new Date().toISOString();
    const body = {
      exchange: 'upbit', accountMode: 'paper', strategyId: 'breakout-v1', signalId: 'api-signal',
      symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'market', quoteAmount: 100000,
      quantity: null, limitPrice: null, estimatedKrw: 100000, stopPrice: 90000, targetPrices: [110000],
      splitRatios: [100], signalReasons: ['trend'], marketSnapshot: {
        observedAt, riskObservedAt: observedAt, dataDelayMs: 0, oneMinuteMovePercent: 0,
        spreadPercent: 0.1, orderbookGapPercent: 0.1, halted: false, availableBalance: 1000000,
        accountValueKrw: 5000000, dailyPnlPercent: 0, assetExposurePercent: 0,
        openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
        currentPrice: 100000, plannedPrice: 100000, marketStatus: 'OPEN',
        availableLiquidityKrw: 1000000, estimatedSlippagePercent: 0.1, estimatedFeePercent: 0.05,
        signalState: 'entry_ready', signalObservedAt: observedAt,
      },
    };
    const planned = await nativeFetch(`${baseUrl}/api/trade-automation/plans`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(planned.status, 200);
    const plannedBody = await planned.json() as { plan: { id: string; state: string; riskEnvelope?: unknown } };
    const planId = plannedBody.plan.id;
    assert.equal(plannedBody.plan.state, 'APPROVAL_PENDING');
    assert.equal(plannedBody.plan.riskEnvelope, undefined);

    const queueResponse = await nativeFetch(`${baseUrl}/api/trade-automation/approval-queue`);
    assert.equal(queueResponse.status, 200);
    const queueBody = await queueResponse.json() as {
      items: Array<{ id: string; approval: { approvalEnabled: boolean }; order: unknown }>;
      orderSubmitted: boolean;
      orderCanceled: boolean;
      privateTradingRequestSent: boolean;
    };
    const queuedPlan = queueBody.items.find((item) => item.id === planId);
    assert.equal(queuedPlan?.approval.approvalEnabled, true);
    assert.equal(queuedPlan?.order, null);
    assert.equal(queueBody.orderSubmitted, false);
    assert.equal(queueBody.orderCanceled, false);
    assert.equal(queueBody.privateTradingRequestSent, false);

    const approvalStatusResponse = await nativeFetch(`${baseUrl}/api/trade-automation/plans/${planId}/approval-status`);
    assert.equal(approvalStatusResponse.status, 200);
    const approvalStatusBody = await approvalStatusResponse.json() as {
      approval: { approvalEnabled: boolean; signalState: string; planState: string };
      orderSubmitted: boolean;
      orderCanceled: boolean;
      privateTradingRequestSent: boolean;
    };
    assert.equal(approvalStatusBody.approval.approvalEnabled, true);
    assert.equal(approvalStatusBody.approval.signalState, 'READY_FOR_APPROVAL');
    assert.equal(approvalStatusBody.approval.planState, 'APPROVAL_PENDING');
    assert.equal(approvalStatusBody.orderSubmitted, false);
    assert.equal(approvalStatusBody.orderCanceled, false);
    assert.equal(approvalStatusBody.privateTradingRequestSent, false);

    const denied = await nativeFetch(`${baseUrl}/api/trade-automation/plans/${planId}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(denied.status, 409);

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith(baseUrl)) { outbound += 1; throw new Error('external blocked'); }
      return nativeFetch(input, init);
    };
    const approved = await globalThis.fetch(`${baseUrl}/api/trade-automation/plans/${planId}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved: true }),
    });
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json() as {
      plan: { riskEnvelope: { version: number; investmentKrw: number; maxSplitCount: number } };
      order: { state: string };
    };
    assert.equal(approvedBody.plan.riskEnvelope.version, 1);
    assert.equal(approvedBody.plan.riskEnvelope.investmentKrw, 100000);
    assert.equal(approvedBody.plan.riskEnvelope.maxSplitCount, 1);
    assert.equal(approvedBody.order.state, 'FILLED');
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = nativeFetch; await close(server); }
});
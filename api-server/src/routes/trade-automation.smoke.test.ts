// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import router, { setTradeAutomationRepositoryFactoryForTests } from './trade-automation';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';
import { normalizeTradingPolicy } from '../services/trade-automation-risk.service';
import { DEFAULT_TRADING_POLICY } from '../services/trade-automation.types';

const USER = '11111111-1111-1111-1111-111111111111';
const repository = new InMemoryTradingRepository();
const MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

async function startServer(authenticated = true, role: 'regular' | 'admin' = 'regular') {
  const app = express();
  app.use(express.json());
  if (authenticated) app.use((req, _res, next) => {
    req.member = {
      id: USER, login_name: 'test', display_name: 'test', role, membership_level: role,
      status: 'approved', is_active: true,
    };
    req.accessToken = 'test';
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
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  await repository.setGlobalEmergencyStop(false, USER);
  await repository.savePolicy(USER, normalizeTradingPolicy(DEFAULT_TRADING_POLICY));
});
test.after(() => {
  setTradeAutomationRepositoryFactoryForTests(null);
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
    const body = JSON.parse(text);
    assert.equal(body.policy.automaticEnabled, false);
    assert.equal(body.actualOrderSubmittedByStatusRequest, false);
  } finally { await close(authenticated.server); }
});

test('automatic policy cannot be enabled without explicit final confirmation', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/policy`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'automatic', automaticEnabled: true, exchangeEnabled: { upbit: true } }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'AUTOMATIC_TRADING_CONFIRMATION_REQUIRED');
  } finally { await close(server); }
});

test('member settings cannot weaken safety, advance pilot, or silently clear emergency stop', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const weakened = await fetch(`${baseUrl}/api/trade-automation/policy`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...DEFAULT_TRADING_POLICY,
        pilotStage: 'validated', riskOptimizationEnabled: false,
        riskPerTradePercent: { bitget: 1, upbit: 1, kiwoom: 1 },
        totalDailyLossLimitPercent: 2, minExpectedValueR: 0, minStrategySampleSize: 20,
        minProfitFactor: 1, maxStrategyDrawdownPercent: 50,
        maxEstimatedSlippagePercent: 2, maxAverageSpreadPercent: 2,
        maxCorrelatedExposurePercent: 100, maxEconomicsAgeHours: 168,
      }),
    });
    assert.equal(weakened.status, 200);
    const weakenedBody = await weakened.json();
    assert.equal(weakenedBody.policy.pilotStage, 'approval-20');
    assert.equal(weakenedBody.policy.riskOptimizationEnabled, true);
    assert.deepEqual(weakenedBody.policy.riskPerTradePercent, { bitget: 0.1, upbit: 0.2, kiwoom: 0.25 });
    assert.equal(weakenedBody.policy.minExpectedValueR, 0.15);
    assert.equal(weakenedBody.policy.maxEstimatedSlippagePercent, 0.25);
    assert.equal(weakenedBody.safetyDowngradeAllowed, false);
    assert.equal(weakenedBody.pilotStageManagedSeparately, true);

    const stopped = await fetch(`${baseUrl}/api/trade-automation/emergency-stop`, { method: 'POST' });
    assert.equal(stopped.status, 200);
    const ordinarySave = await fetch(`${baseUrl}/api/trade-automation/policy`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...DEFAULT_TRADING_POLICY, emergencyStopped: false }),
    });
    assert.equal((await ordinarySave.json()).policy.emergencyStopped, true);

    const deniedResume = await fetch(`${baseUrl}/api/trade-automation/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(deniedResume.status, 409);
    const resumed = await fetch(`${baseUrl}/api/trade-automation/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'RESUME_NEW_ORDER_EVALUATION' }),
    });
    assert.equal(resumed.status, 200);
    const resumedBody = await resumed.json();
    assert.equal(resumedBody.policy.emergencyStopped, false);
    assert.equal(resumedBody.policy.mode, 'approval');
    assert.equal(resumedBody.automaticTradingEnabledByThisRequest, false);
    assert.deepEqual(resumedBody.policy.exchangeEnabled, { bitget: false, upbit: false, kiwoom: false });
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
    assert.equal((await denied.json()).error, 'ADMIN_REQUIRED');
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
    const stoppedBody = await stopped.json();
    assert.equal(stoppedBody.persistentGlobalEmergencyStopped, true);
    assert.equal(stoppedBody.automaticTradingEnabledByThisRequest, false);

    const status = await fetch(`${admin.baseUrl}/api/trade-automation/status`);
    assert.equal((await status.json()).emergencyStopSources.persistentGlobal, true);

    const resumed = await fetch(`${admin.baseUrl}/api/trade-automation/admin/emergency-stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stopped: false, confirmation: 'RESUME_NEW_ORDER_EVALUATION' }),
    });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).automaticTradingEnabledByThisRequest, false);
  } finally { await close(admin.server); }
});

test('connection registration rejects withdrawal permission and does not echo secrets', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const rejected = await fetch(`${baseUrl}/api/trade-automation/connections/upbit`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: { accessKey: 'access-secret', secretKey: 'signing-secret' }, permissions: ['orders', 'withdrawal'] }),
    });
    assert.equal(rejected.status, 400);
    assert.doesNotMatch(await rejected.text(), /access-secret|signing-secret/);

    const accepted = await fetch(`${baseUrl}/api/trade-automation/connections/upbit`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: { accessKey: 'access-secret', secretKey: 'signing-secret' }, permissions: ['orders'], accountMode: 'paper' }),
    });
    assert.equal(accepted.status, 200);
    const text = await accepted.text();
    assert.doesNotMatch(text, /access-secret|signing-secret/);
    assert.equal(JSON.parse(text).credentialsReturned, false);
  } finally { await close(server); }
});

test('approval route blocks unapproved calls and paper execution makes no external request', async () => {
  const { server, baseUrl } = await startServer();
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  try {
    const body = {
      exchange: 'upbit', accountMode: 'paper', strategyId: 'breakout-v1', signalId: 'api-signal',
      symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'market', quoteAmount: 100000,
      quantity: null, limitPrice: null, estimatedKrw: 100000, stopPrice: 90000, targetPrices: [110000],
      splitRatios: [100], signalReasons: ['trend'], marketSnapshot: {
        observedAt: new Date().toISOString(), dataDelayMs: 100, oneMinuteMovePercent: 0,
        spreadPercent: 0.1, orderbookGapPercent: 0.1, halted: false, availableBalance: 1000000,
        accountValueKrw: 5000000, dailyPnlPercent: 0, assetExposurePercent: 0,
        openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
      },
    };
    const planned = await nativeFetch(`${baseUrl}/api/trade-automation/plans`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(planned.status, 200);
    const planId = (await planned.json()).plan.id;
    const denied = await nativeFetch(`${baseUrl}/api/trade-automation/plans/${planId}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(denied.status, 409);

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.startsWith(baseUrl)) { outbound += 1; throw new Error('external blocked'); }
      return nativeFetch(input, init);
    }) as typeof fetch;
    const approved = await globalThis.fetch(`${baseUrl}/api/trade-automation/plans/${planId}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved: true }),
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).order.state, 'FILLED');
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = nativeFetch; await close(server); }
});

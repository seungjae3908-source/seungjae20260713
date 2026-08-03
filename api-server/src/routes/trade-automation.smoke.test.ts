// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import router, { setTradeAutomationRepositoryFactoryForTests } from './trade-automation';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';

const USER = '11111111-1111-1111-1111-111111111111';
const repository = new InMemoryTradingRepository();
const MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

async function startServer(authenticated = true) {
  const app = express();
  app.use(express.json());
  if (authenticated) app.use((req, _res, next) => { req.member = { id: USER }; req.accessToken = 'test'; next(); });
  app.use('/api/trade-automation', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: import('node:http').Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test.beforeEach(() => {
  setTradeAutomationRepositoryFactoryForTests(() => repository);
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
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

// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import router, { setScannerApprovalRepositoryFactoryForTests } from './scanner-approval';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';

const USER = '44444444-4444-4444-4444-444444444444';
let repository: InMemoryTradingRepository;

function candidate(overrides = {}) {
  const observedAt = new Date().toISOString();
  return {
    market: 'KR', symbol: '005930', displayName: '삼성전자', timeframe: '1D', currentPrice: 70_000,
    score: 78, confidence: 74, riskScore: 30,
    selectedConditions: ['거래량 증가', '5일선 돌파', 'AI 점수 상위'],
    matchedSignals: ['거래량 증가', '5일선 돌파', 'AI 점수 상위'],
    reasons: ['거래량 증가', '단기 추세 회복'], dataTimestamp: observedAt,
    marketSnapshot: {
      observedAt, dataDelayMs: 100, oneMinuteMovePercent: 0.4,
      spreadPercent: 0.1, orderbookGapPercent: 0.2, halted: false,
    },
    ...overrides,
  };
}

async function startServer(authenticated = true) {
  const app = express();
  app.use(express.json());
  if (authenticated) app.use((req, _res, next) => {
    req.member = {
      id: USER, login_name: 'scanner-test', display_name: 'scanner-test', role: 'regular',
      membership_level: 'regular', status: 'approved', is_active: true,
    };
    req.accessToken = 'test';
    next();
  });
  app.use('/api/trade-automation/scanner', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: import('node:http').Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test.beforeEach(async () => {
  repository = new InMemoryTradingRepository();
  setScannerApprovalRepositoryFactoryForTests(() => repository);
  await repository.setGlobalEmergencyStop(false, USER);
});

test.after(() => setScannerApprovalRepositoryFactoryForTests(null));

test('scanner approval requires authentication and creates only an approval-pending paper plan', async () => {
  const unauthenticated = await startServer(false);
  try {
    const denied = await fetch(`${unauthenticated.baseUrl}/api/trade-automation/scanner/signals`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidate: candidate() }),
    });
    assert.equal(denied.status, 401);
  } finally { await close(unauthenticated.server); }

  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/scanner/signals`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidate: candidate() }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.signal.state, 'APPROVAL_SENT');
    assert.equal(body.guard.enabled, true);
    assert.equal(body.plan.state, 'APPROVAL_PENDING');
    assert.equal(body.plan.accountMode, 'paper');
    assert.equal(body.liveOrderEnabled, false);
    assert.equal(body.exchangeRequestSent, false);
  } finally { await close(server); }
});

test('explicit approval revalidates and fills a paper order with zero external requests', async () => {
  const { server, baseUrl } = await startServer();
  const nativeFetch = globalThis.fetch;
  let externalRequests = 0;
  try {
    const planned = await nativeFetch(`${baseUrl}/api/trade-automation/scanner/signals`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidate: candidate() }),
    });
    const plannedBody = await planned.json();
    const planId = plannedBody.plan.id;
    const approvalToken = plannedBody.approvalToken;

    const missingApproval = await nativeFetch(`${baseUrl}/api/trade-automation/scanner/signals/${planId}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidate: candidate() }),
    });
    assert.equal(missingApproval.status, 409);

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.startsWith(baseUrl)) { externalRequests += 1; throw new Error('external request blocked'); }
      return nativeFetch(input, init);
    }) as typeof fetch;
    const approved = await globalThis.fetch(`${baseUrl}/api/trade-automation/scanner/signals/${planId}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true, approvalToken, candidate: candidate() }),
    });
    assert.equal(approved.status, 200);
    const body = await approved.json();
    assert.equal(body.signal.state, 'APPROVED');
    assert.equal(body.order.state, 'FILLED');
    assert.equal(body.paperOrderCreated, true);
    assert.equal(body.liveOrderEnabled, false);
    assert.equal(body.exchangeRequestSent, false);
    assert.equal(externalRequests, 0);
  } finally { globalThis.fetch = nativeFetch; await close(server); }
});

test('condition invalidation revokes approval and cancels remaining entry legs', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const planned = await fetch(`${baseUrl}/api/trade-automation/scanner/signals`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidate: candidate() }),
    });
    const planId = (await planned.json()).plan.id;
    const observedAt = new Date().toISOString();
    const invalidated = await fetch(`${baseUrl}/api/trade-automation/scanner/signals/${planId}/revalidate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidate: candidate({
        score: 38, confidence: 35, riskScore: 95, riskLevel: 'BLOCKED', matchedSignals: [],
        dataTimestamp: observedAt,
        marketSnapshot: { observedAt, dataDelayMs: 100, oneMinuteMovePercent: -7, spreadPercent: 0.2, orderbookGapPercent: 0.3, halted: false },
      }) }),
    });
    assert.equal(invalidated.status, 200);
    const body = await invalidated.json();
    assert.equal(body.signal.state, 'INVALIDATED');
    assert.equal(body.guard.enabled, false);
    assert.equal(body.approvalRevoked, true);
    assert.equal(body.followUpEntriesCancelled, true);
    const stored = await repository.getPlan(USER, planId);
    assert.equal(stored?.state, 'EXPIRED');
  } finally { await close(server); }
});

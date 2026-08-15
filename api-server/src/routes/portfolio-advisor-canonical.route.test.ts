// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import '../services/investment-copilot-tools.service.test.ts';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createPaperJournalRouter } from './paper-journal';

const USER = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-08-12T03:00:00.000Z');

function openCanonicalOrder(overrides = {}) {
  return {
    schemaVersion: 1,
    recordType: 'unified_trade_order',
    source: 'APP_PAPER',
    broker: 'APP',
    accountIdMasked: 'APP-****-paper',
    market: 'US_STOCK',
    symbol: 'AAPL',
    side: 'BUY',
    positionSide: 'LONG',
    positionEffect: 'OPEN',
    clientOrderId: null,
    brokerOrderId: 'portfolio-route-buy-1',
    fillId: null,
    orderedAt: '2026-08-12T02:58:00.000Z',
    filledAt: '2026-08-12T02:58:30.000Z',
    observedAt: '2026-08-12T02:58:31.000Z',
    quantity: 2,
    filledQuantity: 2,
    remainingQuantity: 0,
    averageFillPrice: 100,
    fees: 0,
    tax: 0,
    currency: 'USD',
    status: 'FILLED',
    strategy: 'paper-test',
    timeframe: '15m',
    stopLossPrice: 90,
    targetPrice: 120,
    ruleViolation: false,
    warnings: [],
    technicalSnapshot: {
      snapshotId: 'snapshot-open-1',
      contextSource: 'PRE_TRADE_SNAPSHOT',
      capturedAt: '2026-08-12T02:59:00.000Z',
      timeframe: '15m',
      price: 110,
      rsi: null,
      macd: null,
      macdSignal: null,
      movingAverageFast: null,
      movingAverageSlow: null,
      support: null,
      resistance: null,
      volumeRatio: null,
      volatilityPercent: null,
      signalScore: null,
      marketRegime: null,
      marketStructure: null,
      signalReasons: [],
    },
    ...overrides,
  };
}

function repository(payloads = [openCanonicalOrder()]) {
  let requestedUserId = null;
  return {
    get requestedUserId() { return requestedUserId; },
    async getRecord() { return null; },
    async upsertRecord(_user, record, serverTime) { return { ...record, createdAt: serverTime, serverUpdatedAt: serverTime }; },
    async listSnapshot() { return []; },
    async getIdempotentResponse() { return null; },
    async saveIdempotentResponse() {},
    async saveConflict() {},
    async getConflict() { return null; },
    async markConflictResolved() {},
    async listJournalPayloads(userId) { requestedUserId = userId; return structuredClone(payloads); },
    async deleteAll() { return { account: 0, order: 0, position: 0, fill: 0, journal: 0, syncState: 0 }; },
  };
}

async function start(repo = repository()) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (request, _response, next) => {
    request.member = { id: USER, membership_level: 'regular', status: 'approved', is_active: true };
    request.accessToken = 'test-token';
    next();
  });
  app.use('/api', createPaperJournalRouter({
    repositoryFactory: () => repo,
    now: () => NOW,
    reviewProvider: null,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address() as AddressInfo;
  return { server, repo, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function json(response) {
  const raw = await response.text();
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
  assert.doesNotMatch(raw, /(?:access_token|refresh_token|authorization|bearer\s|client_secret|api_key|telegram.*secret)/i);
  return JSON.parse(raw);
}

test('portfolio advisor preview derives state only from authenticated canonical journal', async () => {
  const { server, repo, baseUrl } = await start();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/portfolio-advisor/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(repo.requestedUserId, USER);
    assert.equal(body.mode, 'portfolio-advisor-preview');
    assert.equal(body.externalAiCalled, false);
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.exchangeRequestSent, false);
    assert.equal(body.privateTradingApiRequests, 0);
    assert.equal(body.orderAuthority, 'none');
    assert.equal(body.result.sourceOfTruth, 'PAPER_JOURNAL_UNIFIED_LEDGER');
    assert.equal(body.result.canonicalJournalSource, true);
    assert.equal(body.result.independentPortfolioStorage, false);
    assert.equal(body.result.duplicatePortfolioEngine, false);
    assert.equal(body.result.duplicateAiRoute, false);
    assert.equal(body.result.positions.length, 1);
    assert.equal(body.result.positions[0].symbol, 'AAPL');
    assert.equal(body.result.positions[0].currentPrice, 110);
    assert.equal(body.result.analytics.cashValue.status, 'insufficient');
    assert.equal(body.result.scenario.returnScenarioStatus, 'INSUFFICIENT_EVIDENCE');
    assert.equal(body.result.advisor.orderAuthority, 'none');
  } finally { await close(server); }
});

test('client positions, cash, user identity and private account state cannot replace canonical journal', async () => {
  const { server, baseUrl } = await start();
  try {
    for (const forbidden of [
      { positions: [{ symbol: 'FAKE', quantity: 999 }] },
      { cash: 999999999 },
      { nested: { userId: 'other-user' } },
      { account: { balance: 100 } },
    ]) {
      const response = await fetch(`${baseUrl}/api/paper-journal/portfolio-advisor/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forbidden),
      });
      const body = await json(response);
      assert.equal(response.status, 400);
      assert.equal(body.code, 'CLIENT_PORTFOLIO_STATE_FORBIDDEN');
      assert.equal(body.privateTradingApiRequests, 0);
    }
  } finally { await close(server); }
});

test('recursive advisor privacy rejection blocks nested secrets before portfolio context construction', async () => {
  const { server, baseUrl } = await start();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/portfolio-advisor/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harmless: { deeper: { accessToken: 'test-only-secret-value' } } }),
    });
    const body = await json(response);
    assert.equal(response.status, 400);
    assert.equal(body.code, 'ADVISOR_PRIVATE_DATA_FORBIDDEN');
    assert.equal(body.externalAiCalled, false);
  } finally { await close(server); }
});

test('stale journal price remains insufficient at the canonical route boundary', async () => {
  const repo = repository([openCanonicalOrder({
    technicalSnapshot: { ...openCanonicalOrder().technicalSnapshot, capturedAt: '2026-08-12T02:50:00.000Z', price: 777 },
  })]);
  const { server, baseUrl } = await start(repo);
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/portfolio-advisor/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(body.result.positions[0].currentPrice, null);
    assert.equal(body.result.analytics.totalValue.status, 'insufficient');
    assert.equal(body.result.stateEvidence.priceEvidence[0].status, 'insufficient');
  } finally { await close(server); }
});

test('portfolio advisor preview performs zero outbound AI, broker or exchange calls', async () => {
  const { server, baseUrl } = await start();
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.startsWith(baseUrl)) { outbound += 1; throw new Error('unexpected outbound'); }
      return nativeFetch(input, init);
    }) as typeof fetch;
    const response = await globalThis.fetch(`${baseUrl}/api/paper-journal/portfolio-advisor/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = nativeFetch; await close(server); }
});

// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createPaperJournalRouter } from './paper-journal';

const USER = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-08-12T03:00:00.000Z');

function repository(payloads = []) {
  return {
    async getRecord() { return null; },
    async upsertRecord(_user, record, serverTime) { return { ...record, createdAt: serverTime, serverUpdatedAt: serverTime }; },
    async listSnapshot() { return []; },
    async getIdempotentResponse() { return null; },
    async saveIdempotentResponse() {},
    async saveConflict() {},
    async getConflict() { return null; },
    async markConflictResolved() {},
    async listJournalPayloads() { return structuredClone(payloads); },
    async deleteAll() { return { account: 0, order: 0, position: 0, fill: 0, journal: 0, syncState: 0 }; },
  };
}

async function start(options = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (request, _response, next) => {
    request.member = { id: USER, membership_level: 'regular', status: 'approved', is_active: true };
    request.accessToken = 'test-token';
    next();
  });
  app.use('/api', createPaperJournalRouter({
    repositoryFactory: () => options.repository ?? repository(),
    now: () => NOW,
    reviewProvider: null,
    allowTossContractPreview: options.allowTossContractPreview === true,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function json(response) {
  const raw = await response.text();
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
  assert.doesNotMatch(raw, /(?:client_secret|access_token|refresh_token|authorization|bearer\s|service_role|account-number-raw)/i);
  return JSON.parse(raw);
}

function paperTrade(index) {
  return {
    id: `paper-${index}`, status: 'closed', source: index % 2 ? 'APP_SHADOW' : 'APP_PAPER',
    market: index % 2 ? 'US_STOCK' : 'CRYPTO_FUTURES', symbol: index % 2 ? 'AAPL' : 'BTCUSDT', side: 'long',
    currency: index % 2 ? 'USD' : 'USDT', filledAt: `2026-08-${String(index + 1).padStart(2, '0')}T01:00:00.000Z`,
    closedAt: `2026-08-${String(index + 1).padStart(2, '0')}T02:00:00.000Z`, entryPrice: 100, exitPrice: 110,
    initialQuantity: 1, closedQuantity: 1, remainingQuantity: 0, grossPnl: 10, netPnl: 9, fees: 1,
    strategy: index % 2 ? 'swing' : 'breakout', timeframe: index % 2 ? '1d' : '15m', stopLossPrice: 90,
  };
}

const tossFixture = {
  orderId: 'toss-route-order', symbol: '005930', side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', status: 'FILLED',
  price: '70000', quantity: '10', orderAmount: null, currency: 'KRW', orderedAt: '2026-03-28T09:30:00+09:00', canceledAt: null,
  execution: { filledQuantity: '10', averageFilledPrice: '70000', filledAmount: '700000', commission: '1400', tax: '0', filledAt: '2026-03-28T09:31:15+09:00', settlementDate: '2026-03-30' },
};

test('unified journal status is free-only, analysis-only, and mutation-free', async () => {
  const { server, baseUrl } = await start();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/unified-ledger/status`);
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(body.mode, 'analysis-only');
    assert.equal(body.externalAiCalled, false);
    assert.equal(body.result.toss.liveReadIntegration, 'BLOCKED_BY_FREE_STATUS_UNVERIFIED');
    assert.equal(body.result.toss.livePrivateRequests, 0);
    assert.equal(body.result.safety.finalCostDelta, '0_KRW');
    assert.deepEqual([
      body.result.safety.actualOrderRequests,
      body.result.safety.cancelRequests,
      body.result.safety.amendRequests,
      body.result.safety.transferRequests,
      body.result.safety.withdrawalRequests,
      body.result.safety.privateBrokerRequests,
    ], [0, 0, 0, 0, 0, 0]);
  } finally { await close(server); }
});

test('unified ledger uses only authenticated user journal payloads and applies filters', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => paperTrade(index));
  const { server, baseUrl } = await start({ repository: repository(rows) });
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/unified-ledger?range=ALL&market=US_STOCK&source=APP_SHADOW&broker=APP&account=APP-****-LOCAL&strategy=swing&timeframe=1d`);
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(body.mode, 'analysis-only');
    assert.equal(body.externalAiCalled, false);
    assert.equal(body.result.trades.length, 3);
    assert.ok(body.result.trades.every((trade) => trade.market === 'US_STOCK' && trade.source === 'APP_SHADOW' && trade.broker === 'APP' && trade.accountIdMasked === 'APP-****-LOCAL'));
    assert.equal(body.result.aiReviewStatus, 'AI_EXTERNAL_REVIEW_DISABLED_FREE_ONLY');
    assert.equal(body.result.integrationBaseSha, '868734a1ef2120cdafebb4a518ba8dd0a7d40e0f');
  } finally { await close(server); }
});

test('unified ledger rejects invalid filter values without leaking internals', async () => {
  const { server, baseUrl } = await start();
  try {
    for (const query of ['range=FOREVER', 'market=OPTIONS', 'source=UNKNOWN', 'broker=UNKNOWN', 'account=1234567890', 'grade=Z']) {
      const response = await fetch(`${baseUrl}/api/paper-journal/unified-ledger?${query}`);
      assert.equal(response.status, 400);
      const body = await json(response);
      assert.match(body.code, /^INVALID_JOURNAL_/);
    }
  } finally { await close(server); }
});

test('Toss contract preview is disabled by default before fee status is verified', async () => {
  const { server, baseUrl } = await start();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/unified-ledger/toss-contract-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountAlias: 'mock', orders: [tossFixture] }),
    });
    const body = await json(response);
    assert.equal(response.status, 503);
    assert.equal(body.code, 'BLOCKED_BY_FREE_STATUS_UNVERIFIED');
    assert.equal(body.safety.privateBrokerRequests, 0);
  } finally { await close(server); }
});

test('test-only Toss contract preview normalizes fixtures, masks aliases, stores nothing, and sends no private request', async () => {
  const { server, baseUrl } = await start({ allowTossContractPreview: true });
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.startsWith(baseUrl)) { outbound += 1; throw new Error('unexpected outbound'); }
      return nativeFetch(input, init);
    }) as typeof fetch;
    const alias = 'account-number-raw';
    const response = await globalThis.fetch(`${baseUrl}/api/paper-journal/unified-ledger/toss-contract-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountAlias: alias, orders: [tossFixture] }),
    });
    const raw = await response.text();
    assert.doesNotMatch(raw, new RegExp(alias));
    const body = JSON.parse(raw);
    assert.equal(response.status, 200);
    assert.equal(body.records.length, 1);
    assert.match(body.records[0].accountIdMasked, /^TOSS-\*\*\*\*-/);
    assert.equal(body.records[0].idempotencyBasis, 'aggregate-cumulative');
    assert.equal(body.privateBrokerRequests, 0);
    assert.equal(body.stored, false);
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = nativeFetch; await close(server); }
});

test('Toss contract preview rejects nested client identity, secrets, and full account numbers before normalization', async () => {
  const { server, baseUrl } = await start({ allowTossContractPreview: true });
  try {
    for (const forbidden of [
      { userId: 'other' },
      { clientSecret: 'value' },
      { accountNumber: '12345678' },
      { orders: [{ ...tossFixture, metadata: { accessToken: 'test-only-secret-value' } }] },
    ]) {
      const response = await fetch(`${baseUrl}/api/paper-journal/unified-ledger/toss-contract-preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountAlias: 'mock', orders: [tossFixture], ...forbidden }),
      });
      const body = await json(response);
      assert.equal(response.status, 400);
      assert.equal(body.code, 'SENSITIVE_TOSS_INPUT_FORBIDDEN');
    }
  } finally { await close(server); }
});

test('unified journal endpoints perform zero external AI, broker, and exchange requests', async () => {
  const { server, baseUrl } = await start({ repository: repository([paperTrade(0)]) });
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.startsWith(baseUrl)) { outbound += 1; throw new Error('unexpected outbound'); }
      return nativeFetch(input, init);
    }) as typeof fetch;
    await globalThis.fetch(`${baseUrl}/api/paper-journal/unified-ledger/status`);
    await globalThis.fetch(`${baseUrl}/api/paper-journal/unified-ledger?range=ALL`);
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = nativeFetch; await close(server); }
});

// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createPaperJournalRouter } from './paper-journal';
import type { PaperJournalRepository } from '../services/paper-journal.types';

const NOW = new Date('2026-08-02T05:00:00.000Z');
const USER = '11111111-1111-1111-1111-111111111111';

function createRepository(): PaperJournalRepository {
  const records = new Map();
  const requests = new Map();
  const conflicts = new Map();
  const journalPayloads = Array.from({ length: 10 }, (_, index) => ({
    id: `trade-${index}`, tradeId: `trade-${index}`, status: 'closed', side: index % 2 ? 'short' : 'long', symbol: 'BTCUSDT',
    strategyName: 'manual', filledAt: new Date(NOW.getTime() + index * 60_000).toISOString(),
    closedAt: new Date(NOW.getTime() + index * 60_000 + 30_000).toISOString(), netPnl: index % 3 ? 10 : -5,
    grossPnl: index % 3 ? 11 : -4, rMultiple: index % 3 ? 1 : -1, notionalValue: 1000, leverage: 2,
    riskPercent: 0.5, stopLossPrice: 90, takeProfitPrice1: 110, exitReason: index % 3 ? 'take_profit' : 'stop_loss',
    dataStatusAtEntry: 'live', marketRegimeAtEntry: 'trend', entryFee: 0.2, exitFee: 0.2, slippageCost: 0.2,
    fundingCost: 0.1, warnings: [], ruleViolation: false, note: 'private note', email: 'private@example.com',
  }));
  return {
    async getRecord(user, kind, id) { return structuredClone(records.get(`${user}:${kind}:${id}`) ?? null); },
    async upsertRecord(user, record, serverTime) {
      const stored = { ...structuredClone(record), createdAt: serverTime, serverUpdatedAt: serverTime };
      records.set(`${user}:${record.kind}:${record.id}`, stored); return structuredClone(stored);
    },
    async listSnapshot(user) { return [...records.entries()].filter(([key]) => key.startsWith(`${user}:`)).map(([, value]) => structuredClone(value)); },
    async getIdempotentResponse(user, key) { return structuredClone(requests.get(`${user}:${key}`) ?? null); },
    async saveIdempotentResponse(user, key, result) { requests.set(`${user}:${key}`, structuredClone(result)); },
    async saveConflict(user, conflict) { conflicts.set(`${user}:${conflict.id}`, structuredClone(conflict)); },
    async getConflict(user, id) { return structuredClone(conflicts.get(`${user}:${id}`) ?? null); },
    async markConflictResolved(user, id) { const item = conflicts.get(`${user}:${id}`); if (item) conflicts.set(`${user}:${id}`, { ...item, status: 'resolved' }); },
    async listJournalPayloads() { return structuredClone(journalPayloads); },
    async deleteAll() { records.clear(); requests.clear(); conflicts.clear(); return { account: 0, order: 0, position: 0, fill: 0, journal: 0, syncState: 0 }; },
  };
}

async function startServer(options: { authenticated?: boolean; repository?: PaperJournalRepository; throwFactory?: boolean } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  if (options.authenticated !== false) app.use('/api', (req: any, _res, next) => { req.member = { id: USER }; req.accessToken = 'test-token'; next(); });
  const repository = options.repository ?? createRepository();
  app.use('/api', createPaperJournalRouter({
    repositoryFactory: () => {
      if (options.throwFactory) throw new Error('secret database connection stack');
      if (options.authenticated === false) throw Object.assign(new Error('login'), { code: 'LOGIN_REQUIRED' });
      return repository;
    },
    now: () => NOW,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, repository };
}

async function safeJson(response: Response) {
  const text = await response.text();
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
  assert.doesNotMatch(text, /(?:stack|database connection|api[_-]?key|secret|authorization|bearer|service_role|crypto-auto|place-order)/i);
  return JSON.parse(text);
}

const syncBody = {
  idempotencyKey: 'phase7-smoke-0001', clientTime: NOW.toISOString(),
  records: [{ kind: 'journal', id: 'trade-smoke', version: 1, updatedAt: NOW.toISOString(), deletedAt: null, payload: { id: 'trade-smoke', status: 'closed', netPnl: 10 } }],
};

test('sync endpoint returns journal-sync-only safety contract', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(syncBody) });
    assert.equal(response.status, 200);
    const body = await safeJson(response);
    assert.equal(body.ok, true); assert.equal(body.mode, 'journal-sync-only');
    assert.equal(body.orderSubmitted, false); assert.equal(body.exchangeRequestSent, false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('sync endpoint rejects body user_id', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...syncBody, user_id: 'other' }) });
    assert.equal(response.status, 400);
    assert.equal((await safeJson(response)).code, 'CLIENT_USER_ID_FORBIDDEN');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('sync endpoint rejects oversized body before repository work', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...syncBody, padding: 'x'.repeat(530_000) }) });
    assert.equal(response.status, 413);
    assert.equal((await safeJson(response)).code, 'REQUEST_TOO_LARGE');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('snapshot endpoint returns paginated safety contract', async () => {
  const { server, baseUrl } = await startServer();
  try {
    await fetch(`${baseUrl}/api/paper-journal/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(syncBody) });
    const response = await fetch(`${baseUrl}/api/paper-journal/snapshot?limit=10`);
    const body = await safeJson(response);
    assert.equal(body.mode, 'journal-sync-only'); assert.equal(body.records.length, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('conflict endpoint rejects unknown conflict without silent discard', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/conflicts/conflict:missing/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice: 'server' }) });
    assert.equal(response.status, 404);
    assert.equal((await safeJson(response)).code, 'CONFLICT_NOT_FOUND');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('delete all requires explicit confirmation string', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/all`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'delete' }) });
    assert.equal(response.status, 400);
    assert.equal((await safeJson(response)).code, 'DELETE_CONFIRMATION_REQUIRED');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('delete all succeeds with exact confirmation and no-order contract', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/all`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'DELETE MY PAPER JOURNAL' }) });
    const body = await safeJson(response);
    assert.equal(body.ok, true); assert.equal(body.orderSubmitted, false); assert.equal(body.exchangeRequestSent, false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('analytics endpoint returns analysis-only without external AI', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/analytics`);
    const body = await safeJson(response);
    assert.equal(body.ok, true); assert.equal(body.mode, 'analysis-only'); assert.equal(body.externalAiCalled, false);
    assert.equal(body.result.sampleSize, 10);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('review dataset excludes email and original memo', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/review-dataset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const text = await response.text();
    assert.doesNotMatch(text, /private@example\.com|private note/);
    const body = JSON.parse(text);
    assert.equal(body.mode, 'analysis-only'); assert.equal(body.externalAiCalled, false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('review dataset rejects client user identity', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/review-dataset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'other' }) });
    assert.equal(response.status, 400);
    assert.equal((await safeJson(response)).code, 'CLIENT_USER_ID_FORBIDDEN');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('unexpected repository error is generalized', async () => {
  const { server, baseUrl } = await startServer({ throwFactory: true });
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/analytics`);
    assert.equal(response.status, 500);
    const body = await safeJson(response);
    assert.equal(body.code, 'JOURNAL_ANALYTICS_FAILED');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('journal routes perform zero external AI or exchange network calls', async () => {
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  const { server, baseUrl } = await startServer();
  try {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (!url.startsWith(baseUrl)) { outbound += 1; throw new Error('outbound blocked'); }
      return nativeFetch(input, init);
    }) as typeof fetch;
    await globalThis.fetch(`${baseUrl}/api/paper-journal/review-dataset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await globalThis.fetch(`${baseUrl}/api/paper-journal/analytics`);
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = nativeFetch; await new Promise<void>((resolve) => server.close(() => resolve())); }
});

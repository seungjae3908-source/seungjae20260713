// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createPaperJournalRouter } from './paper-journal';
import type { PaperJournalRepository } from '../services/paper-journal.types';
import type { TradingReviewProvider } from '../services/trading-review-provider';

const NOW = new Date('2026-08-02T05:00:00.000Z');
const USER = '11111111-1111-1111-1111-111111111111';

function createRepository(): PaperJournalRepository {
  const records = new Map();
  const requests = new Map();
  const conflicts = new Map();
  const journalPayloads = Array.from({ length: 10 }, (_, index) => ({
    id: `trade-${index}`, tradeId: `trade-${index}`, status: 'closed', side: index % 2 ? 'short' : 'long', symbol: 'BTCUSDT',
    strategyName: 'manual', filledAt: new Date(NOW.getTime() - (index + 1) * 60_000).toISOString(),
    closedAt: new Date(NOW.getTime() - (index + 1) * 60_000 + 30_000).toISOString(), netPnl: index % 3 ? 10 : -5,
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

const reviewProvider: TradingReviewProvider = { async generateReview(input) {
  return { providerRequestId: 'mock-phase9', model: 'mock', generatedAt: NOW.toISOString(), usage: { inputUnits: 1, outputUnits: 1 }, result: {
    summary: `모의거래 ${input.dataset.sampleSize}건 복기`, strengths: [], riskPatterns: [], costObservations: [], ruleCompliance: [],
    practiceActions: [], nextTradeChecklist: ['계획 확인'], limitations: ['과거 모의거래 데이터'], disclaimer: '학습용이며 투자 조언이 아닙니다.',
  } };
} };

async function startServer(options: { authenticated?: boolean; repository?: PaperJournalRepository; throwFactory?: boolean; reviewProvider?: TradingReviewProvider | null; memberTier?: string } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  if (options.authenticated !== false) app.use('/api', (req: any, _res, next) => { req.member = { id: USER, membership_level: options.memberTier ?? 'regular', status: 'approved', is_active: true }; req.accessToken = 'test-token'; next(); });
  const repository = options.repository ?? createRepository();
  app.use('/api', createPaperJournalRouter({
    repositoryFactory: () => {
      if (options.throwFactory) throw new Error('secret database connection stack');
      if (options.authenticated === false) throw Object.assign(new Error('login'), { code: 'LOGIN_REQUIRED' });
      return repository;
    },
    now: () => NOW,
    reviewProvider: options.reviewProvider === undefined ? reviewProvider : options.reviewProvider,
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

test('signal performance GET returns zero-sample N/A without execution authority', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/signal-performance?source=PAPER`);
    const body = await safeJson(response);
    assert.equal(response.status, 200); assert.equal(body.mode, 'analysis-only'); assert.equal(body.externalAiCalled, false);
    assert.equal(body.result.source, 'PAPER'); assert.equal(body.result.sampleSize, 0); assert.equal(body.result.hitRate, null);
    assert.equal(body.result.profitFactor, null); assert.equal(body.result.evidenceState, 'INSUFFICIENT_SAMPLE');
    assert.equal(body.result.executionAuthority, 'NONE'); assert.equal(body.profitabilityClaimAllowed, false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('signal performance GET rejects unknown stage', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/signal-performance?source=LIVE`);
    assert.equal(response.status, 400); assert.equal((await safeJson(response)).code, 'INVALID_PERFORMANCE_SOURCE');
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

test('AI review preview regenerates a privacy-safe server dataset without outbound AI', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/ai-review/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const raw = await response.text();
    const body = JSON.parse(raw);
    assert.equal(response.status, 200); assert.equal(body.mode, 'ai-review-preview'); assert.equal(body.externalAiCalled, false);
    assert.deepEqual(body.providerCall, { attempted: false, completed: false, reused: false }); assert.equal(body.rateLimitScope, 'process');
    assert.equal(body.orderSubmitted, false); assert.equal(body.exchangeRequestSent, false); assert.equal(body.result.dataset.sampleSize, 10);
    assert.doesNotMatch(raw, /private@example\.com|private note/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('AI review generate requires explicit consent', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/ai-review/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'phase9:smoke:no-consent' }) });
    const body = await safeJson(response);
    assert.equal(response.status, 400); assert.equal(body.error.code, 'AI_REVIEW_CONSENT_REQUIRED'); assert.equal(body.externalAiCalled, false);
    assert.deepEqual(body.providerCall, { attempted: false, completed: false, reused: false }); assert.equal(body.rateLimitScope, 'process');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('AI review generate calls only the injected provider and keeps the no-order contract', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/ai-review/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true, idempotencyKey: 'phase9:smoke:generate', locale: 'ko-KR' }) });
    const body = await safeJson(response);
    assert.equal(response.status, 200); assert.equal(body.mode, 'ai-review-only'); assert.equal(body.externalAiCalled, true);
    assert.deepEqual(body.providerCall, { attempted: true, completed: true, reused: false }); assert.equal(body.rateLimitScope, 'process');
    assert.equal(body.orderSubmitted, false); assert.equal(body.exchangeRequestSent, false); assert.equal(body.result.model, 'mock');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('AI review provider unavailable is a preflight failure', async () => {
  const { server, baseUrl } = await startServer({ reviewProvider: null });
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/ai-review/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true, idempotencyKey: 'phase9:smoke:unavailable' }) });
    const body = await safeJson(response);
    assert.equal(response.status, 503); assert.equal(body.externalAiCalled, false); assert.deepEqual(body.providerCall, { attempted: false, completed: false, reused: false });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('AI review permission rejection occurs before provider call', async () => {
  let calls = 0;
  const counting: TradingReviewProvider = { async generateReview(input) { calls += 1; return reviewProvider.generateReview(input, AbortSignal.timeout(1000)); } };
  const { server, baseUrl } = await startServer({ memberTier: 'associate', reviewProvider: counting });
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/ai-review/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true, idempotencyKey: 'phase9:smoke:permission' }) });
    const body = await safeJson(response);
    assert.equal(response.status, 403); assert.equal(calls, 0); assert.equal(body.externalAiCalled, false); assert.deepEqual(body.providerCall, { attempted: false, completed: false, reused: false });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('AI review generate rejects client-supplied identity and dataset', async () => {
  const { server, baseUrl } = await startServer();
  try {
    for (const body of [{ user_id: 'other' }, { dataset: { sampleSize: 999 } }]) {
      const response = await fetch(`${baseUrl}/api/paper-journal/ai-review/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true, idempotencyKey: 'phase9:smoke:forbidden', ...body }) });
      assert.equal(response.status, 400); assert.equal((await safeJson(response)).error.code, 'CLIENT_DATASET_FORBIDDEN');
    }
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

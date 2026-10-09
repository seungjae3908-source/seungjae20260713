// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createPaperJournalRouter } from './paper-journal';
import type { PaperJournalRepository } from '../services/paper-journal.types';
import type { TradingReviewProvider } from '../services/trading-review-provider';
import { DEFAULT_TRADING_POLICY } from '../services/trade-automation.types';
import { normalizeTradingPolicy } from '../services/trade-automation-risk.service';
import {
  ADMIN_FOUR_PAPER_MARKETS, ADMIN_MARKET_INITIAL_KRW,
  ADMIN_WALLET_CONFIRMATION, adminPaperWalletId,
} from '../services/admin-four-market-paper-capital.service';

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

async function startServer(options: {
  authenticated?: boolean; repository?: PaperJournalRepository; throwFactory?: boolean;
  reviewProvider?: TradingReviewProvider | null; memberTier?: string;
  automaticPaperHistory?: { orders: any[]; plans: any[] };
  adminPolicyReader?: (req: unknown, owner: string) => Promise<any>;
  adminPolicyWriter?: (req: unknown, owner: string, policy: any) => Promise<void>;
  adminFourMarketInsert?: (req: unknown, owner: string, records: any[]) => Promise<any[]>;
} = {}) {
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
    automaticPaperHistoryReader: async () => options.automaticPaperHistory ?? { orders: [], plans: [] },
    ...(options.adminPolicyReader ? { adminPolicyReader: options.adminPolicyReader } : {}),
    ...(options.adminPolicyWriter ? { adminPolicyWriter: options.adminPolicyWriter } : {}),
    ...(options.adminFourMarketInsert ? { adminFourMarketInsert: options.adminFourMarketInsert } : {}),
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


function automaticPaperWalletSetup() {
  return {
    idempotencyKey: 'paper-wallet-500k-once-001',
    clientTime: NOW.toISOString(),
    records: [{
      kind: 'account', id: 'automatic-paper-account-v1', version: 1,
      updatedAt: NOW.toISOString(), deletedAt: null,
      payload: {
        id: 'automatic-paper-account-v1', initialBalance: 500_000,
        cashBalance: 500_000, equity: 500_000,
        realizedPnl: 0, unrealizedPnl: 0, usedMargin: 0,
        availableMargin: 500_000, createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    }],
  };
}

test('automatic 500k wallet preflight is owner-scoped, read-only and consistent with fresh creation', async () => {
  const { server, baseUrl, repository } = await startServer();
  try {
    const read = async () => {
      const response = await fetch(baseUrl + '/api/paper-journal/automatic-wallet-readiness');
      assert.equal(response.status, 200);
      return safeJson(response);
    };
    const before = await read();
    assert.equal(before.ok, true);
    assert.equal(before.readOnlyProbe, true);
    assert.equal(before.mode, 'paper-wallet-readiness-only');
    assert.equal(before.initialCapitalKrw, 500_000);
    assert.equal(before.state, 'READY_FRESH');
    assert.equal(before.safeToPrepare, true);
    assert.equal(before.requiresHistoryPreservationConfirmation, false);
    assert.deepEqual(before.blockers, []);
    assert.equal(before.financialMutationCount, 0);
    assert.equal(before.privateProviderRequests, 0);
    assert.equal(before.orderSubmitted, false);
    assert.equal(before.exchangeRequestSent, false);
    assert.equal(await repository.getRecord(USER, 'account', 'automatic-paper-account-v1'), null);
    const created = await fetch(baseUrl + '/api/paper-journal/sync', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(automaticPaperWalletSetup()),
    });
    assert.equal(created.status, 200);
    const after = await read();
    assert.equal(after.state, 'ALREADY_EXISTS');
    assert.equal(after.safeToPrepare, false);
    assert.ok(after.blockers.includes('AUTOMATIC_PAPER_WALLET_ALREADY_EXISTS'));
    assert.equal((await repository.getRecord(USER, 'account', 'automatic-paper-account-v1'))?.payload?.equity, 500_000);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('automatic wallet preflight rejects unauthorized members and never reads another user wallet', async () => {
  const { server, baseUrl } = await startServer({ memberTier: 'associate' });
  try {
    const response = await fetch(baseUrl + '/api/paper-journal/automatic-wallet-readiness');
    assert.equal(response.status, 403);
    const body = await safeJson(response);
    assert.equal(body.ok, false);
    assert.equal(body.orderSubmitted, false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('server permits only a fresh exact 500k Paper wallet and refuses tampered reset', async () => {
  const { server, baseUrl, repository } = await startServer();
  try {
    const valid = automaticPaperWalletSetup();
    const created = await fetch(`${baseUrl}/api/paper-journal/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(valid),
    });
    assert.equal(created.status, 200);
    const result = await safeJson(created);
    assert.equal(result.orderSubmitted, false);
    assert.equal(result.exchangeRequestSent, false);
    assert.equal(result.uploaded.length, 1);
    const record = await repository.getRecord(USER, 'account', 'automatic-paper-account-v1');
    assert.equal(record.payload.initialBalance, 500_000);

    const invalid = {
      ...valid, idempotencyKey: 'paper-wallet-reset-blocked-001',
      records: [{ ...valid.records[0], version: 2, payload: {
        ...valid.records[0].payload, equity: 1_000_000,
      } }],
    };
    const reset = await fetch(`${baseUrl}/api/paper-journal/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalid),
    });
    assert.equal(reset.status, 409);
    const refused = await safeJson(reset);
    assert.equal(refused.code, 'AUTOMATIC_PAPER_WALLET_BASELINE_INVALID');
    assert.equal(refused.orderSubmitted, false);
    assert.equal((await repository.getRecord(USER, 'account', 'automatic-paper-account-v1')).payload.equity, 500_000);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('historical FILLED automatic Paper orders cannot be overwritten by fresh baseline sync', async () => {
  const canonical = {
    plans: [{ id: 'existing-paper-plan', accountMode: 'paper', executionMode: 'automatic' }],
    orders: [{ id: 'existing-paper-fill', planId: 'existing-paper-plan', state: 'FILLED', filledQuantity: 1 }],
  };
  const { server, baseUrl, repository } = await startServer({ automaticPaperHistory: canonical });
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(automaticPaperWalletSetup()),
    });
    assert.equal(response.status, 409);
    const body = await safeJson(response);
    assert.equal(body.code, 'AUTOMATIC_PAPER_WALLET_HISTORY_RECONCILIATION_REQUIRED');
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.exchangeRequestSent, false);
    assert.equal((await repository.listSnapshot(USER)).length, 0);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('manual synced Paper history prevents automatic Paper wallet refilling', async () => {
  const repository = createRepository();
  await repository.upsertRecord(USER, {
    kind: 'journal', id: 'manual-position', version: 1,
    updatedAt: NOW.toISOString(), deletedAt: null,
    payload: { id: 'manual-position', source: 'APP_PAPER', status: 'OPEN' },
  }, NOW.toISOString());
  const { server, baseUrl } = await startServer({ repository });
  try {
    const response = await fetch(`${baseUrl}/api/paper-journal/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(automaticPaperWalletSetup()),
    });
    assert.equal(response.status, 409);
    const body = await safeJson(response);
    assert.equal(body.code, 'AUTOMATIC_PAPER_WALLET_HISTORY_RECONCILIATION_REQUIRED');
    assert.equal(await repository.getRecord(USER, 'account', 'automatic-paper-account-v1'), null);
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

test('associate AI review is allowed and pending permission rejection occurs before provider call', async () => {
  let calls = 0;
  const counting: TradingReviewProvider = { async generateReview(input) { calls += 1; return reviewProvider.generateReview(input, AbortSignal.timeout(1000)); } };

  const associate = await startServer({ memberTier: 'associate', reviewProvider: counting });
  try {
    const response = await fetch(`${associate.baseUrl}/api/paper-journal/ai-review/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true, idempotencyKey: 'phase9:smoke:associate-allowed' }) });
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    const body = await safeJson(response);
    assert.equal(body.externalAiCalled, true);
    assert.deepEqual(body.providerCall, { attempted: true, completed: true, reused: false });
  } finally { await new Promise<void>((resolve) => associate.server.close(() => resolve())); }

  const pending = await startServer({ memberTier: 'pending', reviewProvider: counting });
  try {
    const response = await fetch(`${pending.baseUrl}/api/paper-journal/ai-review/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true, idempotencyKey: 'phase9:smoke:pending-denied' }) });
    const body = await safeJson(response);
    assert.equal(response.status, 403);
    assert.equal(calls, 1);
    assert.equal(body.externalAiCalled, false);
    assert.deepEqual(body.providerCall, { attempted: false, completed: false, reused: false });
  } finally { await new Promise<void>((resolve) => pending.server.close(() => resolve())); }
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

test('historic Paper-only QA data requires explicit new epoch acknowledgment and remains unchanged', async () => {
  const earlier = new Date(NOW.getTime() - 3 * 60_000).toISOString();
  const repository = createRepository();
  await repository.upsertRecord(USER, {
    kind: 'journal', id: 'historic-qa-entry', version: 1,
    updatedAt: earlier, deletedAt: null,
    payload: { source: 'APP_PAPER', status: 'FILLED', positionEffect: 'OPEN' },
  }, earlier);
  const history = {
    plans: [{ id: 'historic-qa-plan', userId: USER,
      accountMode: 'paper', executionMode: 'automatic',
      reduceOnly: false, createdAt: earlier }],
    orders: [{ id: 'historic-qa-fill', userId: USER,
      planId: 'historic-qa-plan', state: 'FILLED',
      filledQuantity: 0, feeAmount: null, createdAt: earlier }],
  };
  const { server, baseUrl } = await startServer({ repository, automaticPaperHistory: history });
  try {
    const send = async (body: unknown) => fetch(baseUrl + '/api/paper-journal/sync', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const readinessResponse = await fetch(baseUrl + '/api/paper-journal/automatic-wallet-readiness');
    assert.equal(readinessResponse.status, 200);
    const preflight = await safeJson(readinessResponse);
    assert.equal(preflight.state, 'READY_ISOLATE_LEGACY');
    assert.equal(preflight.safeToPrepare, true);
    assert.equal(preflight.requiresHistoryPreservationConfirmation, true);
    assert.equal(preflight.historical.missingFilledQuantityEvidence, 1);
    assert.equal(preflight.financialMutationCount, 0);
    assert.equal(preflight.orderSubmitted, false);

    const blocked = await send(automaticPaperWalletSetup());
    assert.equal(blocked.status, 409);
    assert.equal(await repository.getRecord(USER, 'account', 'automatic-paper-account-v1'), null);
    const request = {
      ...automaticPaperWalletSetup(),
      idempotencyKey: 'isolated-paper-campaign-01',
      legacyEpochConfirmation: 'START_NEW_500K_PAPER_EPOCH_PRESERVE_HISTORY',
    };
    const created = await send(request);
    assert.equal(created.status, 200);
    const first = await safeJson(created);
    assert.equal(first.orderSubmitted, false);
    assert.equal(first.exchangeRequestSent, false);
    assert.equal(first.uploaded.length, 1);
    assert.ok(await repository.getRecord(USER, 'journal', 'historic-qa-entry'));
    const second = await send({ ...request, idempotencyKey: 'isolated-paper-campaign-02' });
    assert.equal(second.status, 409);
    assert.ok(await repository.getRecord(USER, 'journal', 'historic-qa-entry'));
    const afterResponse = await fetch(baseUrl + '/api/paper-journal/automatic-wallet-readiness');
    const after = await safeJson(afterResponse);
    assert.equal(after.state, 'ALREADY_EXISTS');
    assert.equal(after.safeToPrepare, false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('automatic wallet preflight blocks manual journal contamination instead of mislabeling isolation as safe', async () => {
  const repository = createRepository();
  await repository.upsertRecord(USER, {
    kind: 'journal', id: 'manual-history', version: 1, updatedAt: NOW.toISOString(),
    deletedAt: null, payload: { source: 'MANUAL', status: 'FILLED' },
  }, NOW.toISOString());
  const { server, baseUrl } = await startServer({ repository });
  try {
    const preflightResponse = await fetch(baseUrl + '/api/paper-journal/automatic-wallet-readiness');
    const preflight = await safeJson(preflightResponse);
    assert.equal(preflight.state, 'BLOCKED');
    assert.equal(preflight.safeToPrepare, false);
    assert.ok(preflight.blockers.includes('AUTOMATIC_PAPER_EPOCH_HISTORY_REQUIRED'));
    const attempted = await fetch(baseUrl + '/api/paper-journal/sync', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...automaticPaperWalletSetup(),
        legacyEpochConfirmation: 'START_NEW_500K_PAPER_EPOCH_PRESERVE_HISTORY',
      }),
    });
    assert.equal(attempted.status, 409);
    assert.equal(await repository.getRecord(USER, 'account', 'automatic-paper-account-v1'), null);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('four independent admin 1m wallets are protected from non-admin and direct generic sync', async () => {
  const regular = await startServer({ memberTier: 'regular' });
  try {
    const response = await fetch(regular.baseUrl + '/api/paper-journal/admin-four-market/status');
    assert.equal(response.status, 403);
    const denied = await safeJson(response);
    assert.equal(denied.code, 'CAPABILITY_REQUIRED');
    const direct = await fetch(regular.baseUrl + '/api/paper-journal/sync', {
      method: 'POST', headers: { 'content-type':'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'attempt-admin-wallet-sync',
        clientTime: NOW.toISOString(),
        records: [{
          kind:'account',id:adminPaperWalletId('us_stock'),version:1,
          deletedAt:null,updatedAt:NOW.toISOString(),payload:{ initialBalance:1_000_000 },
        }],
      }),
    });
    assert.equal(direct.status, 403);
    assert.equal((await safeJson(direct)).code, 'ADMIN_MARKET_WALLET_SERVER_ONLY');
  } finally { await new Promise<void>((resolve) => regular.server.close(() => resolve())); }
});

test('admin Paper-only 4x1m setup: explicit policy step + single four-row insert, no live authority', async () => {
  let current = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY, mode: 'automatic', automaticEnabled: true,
    totalCapitalKrw: 100_000, maxOrderKrw: 30_000,
    maxInstrumentKrw: 100_000,
    maxAssetClassKrw: {
      domestic_stock:100_000,us_stock:100_000,crypto_spot:100_000,crypto_futures:100_000,
    },
  });
  const repository = createRepository();
  let insertBatches = 0;
  let savedPolicies = 0;
  const fixture = await startServer({
    memberTier: 'admin', repository,
    adminPolicyReader: async () => current,
    adminPolicyWriter: async (_req, _owner, next) => {
      current = next; savedPolicies += 1;
    },
    adminFourMarketInsert: async (_req, owner, records) => {
      assert.equal(owner,USER);
      insertBatches += 1;
      assert.equal(records.length,4);
      const snapshot = await repository.listSnapshot(owner);
      assert.equal(snapshot.filter((r) => r.kind==='account').length,0);
      const result = [];
      for (const record of records) {
        result.push(await repository.upsertRecord(owner, record, NOW.toISOString()));
      }
      return result;
    },
  });
  const prefix=fixture.baseUrl+'/api/paper-journal/admin-four-market';
  const post = (suffix, confirmation) => fetch(prefix+suffix, {
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({confirmation}),
  });
  try {
    const beforeResponse=await fetch(prefix+'/status');
    assert.equal(beforeResponse.status,200);
    const before=await safeJson(beforeResponse);
    assert.equal(before.ok,true);
    assert.equal(before.canCreate,false);
    assert.ok(before.creationBlockers.includes('ADMIN_PAPER_POLICY_1M_REQUIRED'));
    assert.equal(before.financialMutationCount,0);
    assert.equal(insertBatches,0);

    const noConfirm=await post('/prepare-policy','UNKNOWN');
    assert.equal(noConfirm.status,409);
    assert.equal(savedPolicies,0);
    const change=await post('/prepare-policy','SET_ADMIN_FOUR_MARKETS_1M_PAPER_POLICY');
    assert.equal(change.status,200);
    const applied=await safeJson(change);
    assert.equal(applied.savedPolicyCapitalKrw,ADMIN_MARKET_INITIAL_KRW);
    assert.equal(applied.liveTradingEnabledByThisRequest,false);
    assert.equal(applied.automaticTradingEnabledByThisRequest,false);
    assert.equal(current.maxOrderKrw,30_000);
    assert.equal(current.maxInstrumentKrw,100_000);
    assert.equal(current.maxAssetClassKrw.us_stock,100_000);
    assert.equal(savedPolicies,1);
    const created=await post('/bootstrap',ADMIN_WALLET_CONFIRMATION);
    assert.equal(created.status,200);
    const outcome=await safeJson(created);
    assert.equal(outcome.ready,true);
    assert.equal(outcome.initialCapitalKrw,4_000_000);
    assert.equal(outcome.realOrderAuthorityGranted,false);
    assert.equal(outcome.automaticWithdrawalEnabled,false);
    assert.equal(outcome.orderSubmitted,false);
    assert.equal(insertBatches,1);
    assert.equal((await repository.listSnapshot(USER)).filter((r)=>r.kind==='account').length,4);
    assert.deepEqual(ADMIN_FOUR_PAPER_MARKETS.map((market)=>
      outcome.marketWallets[market].equityKrw),[1_000_000,1_000_000,1_000_000,1_000_000]);
    const repeated=await post('/bootstrap',ADMIN_WALLET_CONFIRMATION);
    assert.equal(repeated.status,409);
    assert.equal(insertBatches,1);
    const erase=await fetch(fixture.baseUrl+'/api/paper-journal/all',{
      method:'DELETE', headers:{'content-type':'application/json'},
      body:JSON.stringify({confirmation:'DELETE MY PAPER JOURNAL'}),
    });
    assert.equal(erase.status,409);
    assert.equal((await safeJson(erase)).code,'ADMIN_PAPER_CAMPAIGN_DELETE_FORBIDDEN');
  } finally { await new Promise<void>((resolve)=>fixture.server.close(()=>resolve())); }
});

test('legacy Paper historical fills cannot be replaced by admin wallet start', async () => {
  const earlier=new Date(NOW.getTime()-10*60_000).toISOString();
  const repository=createRepository();
  const plan={ id:'historic-admin-plan',userId:USER,accountMode:'paper',executionMode:'automatic',
    reduceOnly:false,createdAt:earlier };
  const order={ id:'historic-admin-fill',userId:USER,planId:plan.id,state:'FILLED',
    filledQuantity:0,feeAmount:null,createdAt:earlier };
  await repository.upsertRecord(USER,{
    kind:'journal',id:'historic-admin-paper',version:1,deletedAt:null,updatedAt:earlier,
    payload:{source:'APP_PAPER',status:'FILLED'},
  },earlier);
  const fixture=await startServer({
    memberTier:'admin', repository,
    automaticPaperHistory:{ plans:[plan],orders:[order] },
    adminPolicyReader:async ()=>normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY,totalCapitalKrw:1_000_000 }),
    adminFourMarketInsert:async (_req,owner,records)=>{
      assert.equal(records.length,4);
      return Promise.all(records.map((row)=>repository.upsertRecord(owner,row,NOW.toISOString())));
    },
  });
  const url=fixture.baseUrl+'/api/paper-journal/admin-four-market';
  try {
    const before=await safeJson(await fetch(url+'/status'));
    assert.equal(before.canCreate,true);
    assert.equal(before.requiresLegacyHistoryConfirmation,true);
    assert.equal(before.historical.orders,1);
    const created=await fetch(url+'/bootstrap',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({confirmation:ADMIN_WALLET_CONFIRMATION}),
    });
    assert.equal(created.status,200);
    const after=await safeJson(created);
    assert.equal(after.preservedHistoricOrders,1);
    assert.equal(after.preservedHistoricJournalRows,1);
    assert.ok(await repository.getRecord(USER,'journal','historic-admin-paper'));
    assert.equal((await repository.listSnapshot(USER)).filter((r)=>r.kind==='account').length,4);
  } finally { await new Promise<void>((resolve)=>fixture.server.close(()=>resolve())); }
});

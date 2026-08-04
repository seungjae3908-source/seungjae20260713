import test from 'node:test';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createPaperJournalRouter } from './paper-journal';
import { requireCapability, type AuthenticatedRequest, type MemberProfile } from '../middleware/auth';
import {
  PaperJournalError,
  type PaperJournalConflict,
  type PaperJournalRecordKind,
  type PaperJournalRepository,
  type PaperJournalSyncRecord,
  type PaperJournalSyncResult,
  type StoredPaperJournalRecord,
} from '../services/paper-journal.types';
import type { TradingReviewProvider } from '../services/trading-review-provider';

const NOW = new Date('2026-08-05T00:00:00.000Z');
const REGULAR_USER = '11111111-1111-1111-1111-111111111111';
const ADMIN_USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
type Tier = 'pending' | 'associate' | 'regular' | 'admin';

type StartOptions = {
  authenticated?: boolean;
  tier?: Tier;
  payloads?: Record<string, unknown>[];
  storageUnavailable?: boolean;
};

type RunningServer = {
  baseUrl: string;
  providerCalls: () => number;
  close: () => Promise<void>;
};

function memberFor(tier: Tier): MemberProfile {
  return {
    id: tier === 'admin' ? ADMIN_USER : REGULAR_USER,
    login_name: `preview-${tier}`,
    display_name: `Preview ${tier}`,
    role: tier === 'admin' ? 'admin' : 'user',
    status: tier === 'pending' ? 'pending' : 'approved',
    membership_level: tier,
    is_active: true,
  };
}

function storedRecord(
  kind: PaperJournalRecordKind,
  record: PaperJournalSyncRecord,
  serverTime: string,
): StoredPaperJournalRecord {
  return {
    ...record,
    kind,
    createdAt: serverTime,
    serverUpdatedAt: serverTime,
  };
}

function repositoryFor(options: StartOptions): PaperJournalRepository {
  const payloads = structuredClone(options.payloads ?? []);
  const unavailable = () => {
    throw new PaperJournalError(
      'JOURNAL_STORAGE_UNAVAILABLE',
      '거래일지 저장소를 처리하지 못했습니다.',
      503,
    );
  };

  return {
    async getRecord() { return null; },
    async upsertRecord(_userId, record, serverTime) {
      return storedRecord(record.kind, record, serverTime);
    },
    async listSnapshot() { return []; },
    async getIdempotentResponse() { return null; },
    async saveIdempotentResponse(
      _userId: string,
      _idempotencyKey: string,
      _result: PaperJournalSyncResult,
      _serverTime: string,
    ) {},
    async saveConflict(_userId: string, _conflict: PaperJournalConflict) {},
    async getConflict() { return null; },
    async markConflictResolved() {},
    async listJournalPayloads() {
      if (options.storageUnavailable) return unavailable();
      return structuredClone(payloads);
    },
    async deleteAll() {
      return { account: 0, order: 0, position: 0, fill: 0, journal: 0, syncState: 0 };
    },
  };
}

function oneClosedTrade(): Record<string, unknown> {
  return {
    id: 'trade-owned-1',
    tradeId: 'trade-owned-1',
    status: 'closed',
    side: 'long',
    symbol: 'BTCUSDT',
    strategyName: 'paper-breakout',
    filledAt: '2026-08-04T00:00:00.000Z',
    closedAt: '2026-08-04T01:00:00.000Z',
    netPnl: 10,
    grossPnl: 11,
    rMultiple: 1,
    notionalValue: 100,
    leverage: 2,
    riskPercent: 0.5,
    stopLossPrice: 95,
    takeProfitPrice1: 110,
    exitReason: 'take_profit',
    dataStatusAtEntry: 'live',
    marketRegimeAtEntry: 'trend',
    entryFee: 0.1,
    exitFee: 0.1,
    slippageCost: 0.1,
    fundingCost: 0,
    warnings: [],
    ruleViolation: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function assertSafetyEnvelope(body: Record<string, unknown>) {
  assert.equal(body.externalAiCalled, false);
  assert.equal(body.orderSubmitted, false);
  assert.equal(body.exchangeRequestSent, false);
  assert.deepEqual(body.providerCall, { attempted: false, completed: false, reused: false });
}

async function readJson(response: globalThis.Response) {
  const contentType = response.headers.get('content-type') ?? '';
  assert.match(contentType, /application\/json/i);
  return asRecord(await response.json() as unknown);
}

async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  if (options.authenticated !== false) {
    app.use('/api', (request: Request, _response: Response, next: NextFunction) => {
      const authenticated = request as AuthenticatedRequest;
      const member = memberFor(options.tier ?? 'regular');
      authenticated.member = member;
      authenticated.accessToken = 'test-only-access-token';
      authenticated.membershipLevel = member.membership_level ?? 'pending';
      next();
    });
  }

  app.use('/api/paper-journal', requireCapability('canAccessJournalSync'));
  let providerCalls = 0;
  const provider: TradingReviewProvider = {
    async generateReview() {
      providerCalls += 1;
      return {
        providerRequestId: 'must-not-run-for-preview',
        model: 'test-only',
        generatedAt: NOW.toISOString(),
        usage: { inputUnits: 0, outputUnits: 0 },
        result: {
          summary: '테스트 전용',
          strengths: [],
          riskPatterns: [],
          costObservations: [],
          ruleCompliance: [],
          practiceActions: [],
          nextTradeChecklist: [],
          limitations: [],
          disclaimer: '학습용이며 투자 조언이 아닙니다.',
        },
      };
    },
  };

  const repository = repositoryFor(options);
  app.use('/api', createPaperJournalRouter({
    repositoryFactory: () => repository,
    now: () => NOW,
    reviewProvider: provider,
  }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    providerCalls: () => providerCalls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function postPreview(baseUrl: string, body: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/paper-journal/ai-review/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('regular empty journal returns deterministic 200 preview without fake trades', async () => {
  const running = await startServer({ tier: 'regular', payloads: [] });
  try {
    const response = await postPreview(running.baseUrl, {});
    assert.equal(response.status, 200);
    const body = await readJson(response);
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'ai-review-preview');
    assertSafetyEnvelope(body);
    const result = asRecord(body.result);
    const dataset = asRecord(result.dataset);
    assert.equal(dataset.sampleSize, 0);
    assert.deepEqual(dataset.representativeTrades, []);
    assert.equal(running.providerCalls(), 0);
  } finally {
    await running.close();
  }
});

test('regular preview uses one owned journal record and never calls external AI', async () => {
  const running = await startServer({ tier: 'regular', payloads: [oneClosedTrade()] });
  try {
    const response = await postPreview(running.baseUrl, {});
    assert.equal(response.status, 200);
    const body = await readJson(response);
    assertSafetyEnvelope(body);
    const result = asRecord(body.result);
    const dataset = asRecord(result.dataset);
    assert.equal(dataset.sampleSize, 1);
    const representative = dataset.representativeTrades;
    assert.ok(Array.isArray(representative));
    assert.equal(representative.length, 1);
    assert.equal(running.providerCalls(), 0);
  } finally {
    await running.close();
  }
});

for (const tier of ['pending', 'associate'] as const) {
  test(`${tier} cannot access AI preview`, async () => {
    const running = await startServer({ tier });
    try {
      const response = await postPreview(running.baseUrl, {});
      assert.equal(response.status, 403);
      const body = await readJson(response);
      assert.equal(body.error, 'CAPABILITY_REQUIRED');
      assert.equal(running.providerCalls(), 0);
    } finally {
      await running.close();
    }
  });
}

test('admin retains own-data AI preview contract', async () => {
  const running = await startServer({ tier: 'admin', payloads: [oneClosedTrade()] });
  try {
    const response = await postPreview(running.baseUrl, {});
    assert.equal(response.status, 200);
    const body = await readJson(response);
    assertSafetyEnvelope(body);
    const result = asRecord(body.result);
    assert.equal(asRecord(result.dataset).sampleSize, 1);
    assert.equal(running.providerCalls(), 0);
  } finally {
    await running.close();
  }
});

test('unauthenticated preview is rejected with 401 before repository work', async () => {
  const running = await startServer({ authenticated: false });
  try {
    const response = await postPreview(running.baseUrl, {});
    assert.equal(response.status, 401);
    const body = await readJson(response);
    assert.equal(body.error, 'LOGIN_REQUIRED');
    assert.equal(running.providerCalls(), 0);
  } finally {
    await running.close();
  }
});

test('storage unavailable remains explicit safe 503 and is not converted to empty success', async () => {
  const running = await startServer({ tier: 'regular', storageUnavailable: true });
  try {
    const response = await postPreview(running.baseUrl, {});
    assert.equal(response.status, 503);
    const body = await readJson(response);
    assert.equal(body.ok, false);
    assertSafetyEnvelope(body);
    const error = asRecord(body.error);
    assert.equal(error.code, 'JOURNAL_STORAGE_UNAVAILABLE');
    assert.equal(error.message, '거래일지 저장소를 처리하지 못했습니다.');
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /(?:stack|sql|authorization|bearer|service_role|password|secret|api[_-]?key)/i);
    assert.equal(running.providerCalls(), 0);
  } finally {
    await running.close();
  }
});

test('empty object preview contract remains stable for 25 consecutive requests', async () => {
  const running = await startServer({ tier: 'regular', payloads: [] });
  try {
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const response = await postPreview(running.baseUrl, {});
      assert.equal(response.status, 200, `iteration ${iteration + 1}`);
      const body = await readJson(response);
      assertSafetyEnvelope(body);
      const result = asRecord(body.result);
      assert.equal(asRecord(result.dataset).sampleSize, 0);
    }
    assert.equal(running.providerCalls(), 0);
  } finally {
    await running.close();
  }
});

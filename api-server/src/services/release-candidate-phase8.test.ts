import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  getPaperJournalSnapshot,
  resolvePaperJournalConflict,
  syncPaperJournal,
  validatePaperJournalSyncRequest,
} from './paper-journal-sync.service';
import { calculatePaperJournalAnalytics, createTradingReviewDataset } from './paper-journal-analytics.service';
import {
  MAX_SYNC_RECORDS,
  PaperJournalError,
  type PaperJournalConflict,
  type PaperJournalRecordKind,
  type PaperJournalRepository,
  type PaperJournalSyncRecord,
  type PaperJournalSyncResult,
  type StoredPaperJournalRecord,
} from './paper-journal.types';

const NOW = new Date('2026-08-02T10:00:00.000Z');
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const keyOf = (user: string, kind: string, id: string) => `${user}:${kind}:${id}`;

function syncRecord(index: number, overrides: Partial<PaperJournalSyncRecord> = {}): PaperJournalSyncRecord {
  return {
    kind: 'journal', id: `trade-${index}`, version: 1, updatedAt: NOW.toISOString(), deletedAt: null,
    payload: { id: `trade-${index}`, tradeId: `trade-${index}`, status: 'closed', netPnl: index % 3 ? 10 : -5 },
    ...overrides,
  };
}

function request(records: PaperJournalSyncRecord[], key = 'phase8-idempotency') {
  return { idempotencyKey: key, clientTime: NOW.toISOString(), records };
}

function trade(index: number, overrides: Record<string, unknown> = {}) {
  const filledAt = new Date(NOW.getTime() + index * 60_000).toISOString();
  return {
    id: `internal-${index}`, tradeId: `trade-${index}`, status: 'closed', side: index % 2 ? 'short' : 'long',
    symbol: index % 2 ? 'ETHUSDT' : 'BTCUSDT', strategyName: index % 2 ? 'pullback' : 'breakout',
    filledAt, closedAt: new Date(Date.parse(filledAt) + 30_000).toISOString(),
    netPnl: index % 3 ? 10 : -5, grossPnl: index % 3 ? 11 : -4, rMultiple: index % 3 ? 1 : -1,
    notionalValue: 1_000, leverage: index % 2 ? 5 : 2, riskPercent: index % 2 ? 0.75 : 0.5,
    stopLossPrice: 90, takeProfitPrice1: 110, exitReason: index % 3 ? 'take_profit' : 'stop_loss',
    dataStatusAtEntry: 'live', marketRegimeAtEntry: index % 2 ? 'range' : 'trend',
    entryFee: 0.1, exitFee: 0.1, slippageCost: 0.1, fundingCost: 0.1,
    warnings: [], ruleViolation: false, note: `<img src=x onerror=alert(${index})>`, email: `private${index}@example.com`,
    ...overrides,
  };
}

class MemoryRepository implements PaperJournalRepository {
  records = new Map<string, StoredPaperJournalRecord>();
  requests = new Map<string, PaperJournalSyncResult>();
  conflicts = new Map<string, PaperJournalConflict>();
  failIds = new Set<string>();
  upsertCount = 0;
  idempotencyDelayMs = 0;

  async getRecord(userId: string, kind: PaperJournalRecordKind, id: string) {
    return structuredClone(this.records.get(keyOf(userId, kind, id)) ?? null);
  }
  async upsertRecord(userId: string, record: PaperJournalSyncRecord, serverTime: string) {
    if (this.failIds.has(record.id)) throw new Error('database connection secret');
    this.upsertCount += 1;
    const existing = this.records.get(keyOf(userId, record.kind, record.id));
    const stored: StoredPaperJournalRecord = { ...structuredClone(record), createdAt: existing?.createdAt ?? serverTime, serverUpdatedAt: serverTime };
    this.records.set(keyOf(userId, record.kind, record.id), stored);
    return structuredClone(stored);
  }
  async listSnapshot(userId: string) {
    return [...this.records.entries()].filter(([key]) => key.startsWith(`${userId}:`)).map(([, value]) => structuredClone(value));
  }
  async getIdempotentResponse(userId: string, idempotencyKey: string) {
    if (this.idempotencyDelayMs) await new Promise((resolve) => setTimeout(resolve, this.idempotencyDelayMs));
    return structuredClone(this.requests.get(`${userId}:${idempotencyKey}`) ?? null);
  }
  async saveIdempotentResponse(userId: string, idempotencyKey: string, result: PaperJournalSyncResult) {
    this.requests.set(`${userId}:${idempotencyKey}`, structuredClone(result));
  }
  async saveConflict(userId: string, conflict: PaperJournalConflict) { this.conflicts.set(`${userId}:${conflict.id}`, structuredClone(conflict)); }
  async getConflict(userId: string, id: string) { return structuredClone(this.conflicts.get(`${userId}:${id}`) ?? null); }
  async markConflictResolved(userId: string, id: string) {
    const found = this.conflicts.get(`${userId}:${id}`);
    if (found) this.conflicts.set(`${userId}:${id}`, { ...found, status: 'resolved' });
  }
  async listJournalPayloads(userId: string) {
    return [...this.records.entries()].filter(([key, value]) => key.startsWith(`${userId}:journal:`) && value.deletedAt == null).map(([, value]) => structuredClone(value.payload));
  }
  async deleteAll(userId: string) {
    const count = { account: 0, order: 0, position: 0, fill: 0, journal: 0, syncState: 0 };
    for (const key of [...this.records.keys()]) {
      if (!key.startsWith(`${userId}:`)) continue;
      const kind = key.split(':')[1] as PaperJournalRecordKind;
      this.records.delete(key); count[kind] += 1;
    }
    return count;
  }
}

async function measure<T>(name: string, action: () => T | Promise<T>) {
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = await action();
  const elapsedMs = performance.now() - started;
  const heapDeltaBytes = process.memoryUsage().heapUsed - before;
  const metric = { name, elapsedMs: Number(elapsedMs.toFixed(3)), heapDeltaBytes, failed: false, timeout: false };
  console.log(`[phase8-performance] ${JSON.stringify(metric)}`);
  assert.equal(Number.isFinite(elapsedMs), true);
  assert.equal(elapsedMs < 15_000, true, `${name} blocked too long: ${elapsedMs}ms`);
  return { result, metric };
}

test('analyzes 100 journal records without timeout', async () => {
  const { result } = await measure('analytics-100', () => calculatePaperJournalAnalytics(Array.from({ length: 100 }, (_, index) => trade(index))));
  assert.equal(result.sampleSize, 100);
  assert.equal(Number.isFinite(result.netPnl), true);
});

test('analyzes 500 journal records without timeout', async () => {
  const { result } = await measure('analytics-500', () => calculatePaperJournalAnalytics(Array.from({ length: 500 }, (_, index) => trade(index))));
  assert.equal(result.sampleSize, 500);
});

test('creates privacy-safe review dataset for 500 records', async () => {
  const { result } = await measure('review-dataset-500', () => createTradingReviewDataset(Array.from({ length: 500 }, (_, index) => trade(index))));
  const json = JSON.stringify(result);
  assert.equal(result.sampleSize, 500);
  assert.doesNotMatch(json, /private\d+@example\.com|onerror=|internal-/);
  assert.equal(result.representativeTrades.length, 12);
});

test('synchronizes 100 records without timeout', async () => {
  const repository = new MemoryRepository();
  const { result } = await measure('sync-100', () => syncPaperJournal(repository, USER_A, request(Array.from({ length: 100 }, (_, index) => syncRecord(index)), 'phase8-sync-100'), NOW));
  assert.equal(result.uploaded.length, 100);
  assert.equal(repository.records.size, 100);
});

test('synchronizes maximum 500 records without timeout', async () => {
  const repository = new MemoryRepository();
  const { result } = await measure('sync-500', () => syncPaperJournal(repository, USER_A, request(Array.from({ length: 500 }, (_, index) => syncRecord(index)), 'phase8-sync-500'), NOW));
  assert.equal(result.uploaded.length, 500);
  assert.equal(repository.records.size, 500);
});

test('reads a 500-record snapshot in five pages', async () => {
  const repository = new MemoryRepository();
  await syncPaperJournal(repository, USER_A, request(Array.from({ length: 500 }, (_, index) => syncRecord(index)), 'phase8-snapshot-seed'), NOW);
  const { result: pages } = await measure('snapshot-five-pages', async () => {
    const collected: StoredPaperJournalRecord[] = [];
    let cursor: string | null = null;
    let count = 0;
    do {
      const page = await getPaperJournalSnapshot(repository, USER_A, cursor, 100, NOW);
      collected.push(...page.records); cursor = page.nextCursor; count += 1;
    } while (cursor);
    return { collected, count };
  });
  assert.equal(pages.count, 5);
  assert.equal(pages.collected.length, 500);
});

test('creates 100 explicit same-version conflicts without discarding either version', async () => {
  const repository = new MemoryRepository();
  await syncPaperJournal(repository, USER_A, request(Array.from({ length: 100 }, (_, index) => syncRecord(index, { payload: { value: 'server' } })), 'phase8-conflict-server'), NOW);
  const { result } = await measure('conflicts-100', () => syncPaperJournal(repository, USER_A, request(Array.from({ length: 100 }, (_, index) => syncRecord(index, { payload: { value: 'device' } })), 'phase8-conflict-device'), NOW));
  assert.equal(result.conflicts.length, 100);
  assert.equal(result.uploaded.length, 0);
  assert.equal(repository.conflicts.size, 100);
});

test('tombstone and edit at same version creates a conflict', async () => {
  const repository = new MemoryRepository();
  await syncPaperJournal(repository, USER_A, request([syncRecord(1, { payload: { value: 'server' } })], 'phase8-tombstone-server'), NOW);
  const result = await syncPaperJournal(repository, USER_A, request([syncRecord(1, { deletedAt: NOW.toISOString(), payload: {} })], 'phase8-tombstone-device'), NOW);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0]?.differenceSummary.join(' ') ?? '', /삭제/);
});

test('higher version wins over lower version independent of client time', async () => {
  const repository = new MemoryRepository();
  await syncPaperJournal(repository, USER_A, request([syncRecord(1, { version: 3, payload: { value: 'new' } })], 'phase8-version-new'), NOW);
  const result = await syncPaperJournal(repository, USER_A, { ...request([syncRecord(1, { version: 2, payload: { value: 'old' } })], 'phase8-version-old'), clientTime: new Date(NOW.getTime() + 3_600_000).toISOString() }, NOW);
  assert.equal(result.downloaded[0]?.version, 3);
  assert.equal(result.warnings.length, 1);
});

test('simultaneous identical idempotency requests share one execution', async () => {
  const repository = new MemoryRepository();
  repository.idempotencyDelayMs = 15;
  const input = request([syncRecord(1)], 'phase8-concurrent-idempotency');
  const results = await Promise.all(Array.from({ length: 10 }, () => syncPaperJournal(repository, USER_A, input, NOW)));
  assert.equal(repository.upsertCount, 1);
  assert.equal(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0])), true);
});

test('same idempotency key is isolated by authenticated user', async () => {
  const repository = new MemoryRepository();
  await Promise.all([
    syncPaperJournal(repository, USER_A, request([syncRecord(1)], 'phase8-user-scoped-key'), NOW),
    syncPaperJournal(repository, USER_B, request([syncRecord(1)], 'phase8-user-scoped-key'), NOW),
  ]);
  assert.equal(repository.records.size, 2);
});

test('partial failure preserves successful records and hides database details', async () => {
  const repository = new MemoryRepository();
  repository.failIds.add('trade-2');
  const result = await syncPaperJournal(repository, USER_A, request([syncRecord(1), syncRecord(2)], 'phase8-partial-failure'), NOW);
  assert.equal(result.uploaded.length, 1);
  assert.equal(result.failed.length, 1);
  assert.doesNotMatch(result.failed[0]?.message ?? '', /database|secret/i);
});

test('oversized sync is rejected with 413 error code', () => {
  const records = Array.from({ length: MAX_SYNC_RECORDS + 1 }, (_, index) => syncRecord(index));
  assert.throws(() => validatePaperJournalSyncRequest(request(records)), (cause: unknown) => cause instanceof PaperJournalError && cause.statusCode === 413);
});

test('client user_id injection is rejected', () => {
  assert.throws(() => validatePaperJournalSyncRequest({ ...request([]), user_id: USER_B }), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'CLIENT_USER_ID_FORBIDDEN');
});

test('SQL injection shaped record id is rejected', () => {
  assert.throws(() => validatePaperJournalSyncRequest(request([syncRecord(1, { id: "x' OR 1=1 --" })])), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'INVALID_RECORD_ID');
});

test('SQL injection shaped note remains inert data', () => {
  const value = "'; drop table paper_journal_entries; --";
  const parsed = validatePaperJournalSyncRequest(request([syncRecord(1, { payload: { note: value } })]));
  assert.equal(parsed.records[0]?.payload.note, value);
});

test('prototype pollution __proto__ key is rejected', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => validatePaperJournalSyncRequest(request([syncRecord(1, { payload })])), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'UNSAFE_PAYLOAD_KEY');
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('prototype and constructor keys are rejected', () => {
  for (const key of ['prototype', 'constructor']) {
    assert.throws(() => validatePaperJournalSyncRequest(request([syncRecord(1, { payload: { [key]: { polluted: true } } })])), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'UNSAFE_PAYLOAD_KEY');
  }
});

test('XSS memo is never copied to review dataset', () => {
  const dataset = createTradingReviewDataset(Array.from({ length: 10 }, (_, index) => trade(index)));
  assert.doesNotMatch(JSON.stringify(dataset), /<img|onerror|alert\(/i);
});

test('secret-like nested keys remain rejected', () => {
  assert.throws(() => validatePaperJournalSyncRequest(request([syncRecord(1, { payload: { nested: { Authorization: 'Bearer secret' } } })])), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'SECRET_FIELD_FORBIDDEN');
});

test('invalid cursor is rejected without stack detail', async () => {
  await assert.rejects(getPaperJournalSnapshot(new MemoryRepository(), USER_A, 'not-a-cursor', 100, NOW), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'INVALID_CURSOR' && !cause.message.includes('stack'));
});

test('invalid conflict id is rejected', async () => {
  await assert.rejects(resolvePaperJournalConflict(new MemoryRepository(), USER_A, '../other-user', 'server', NOW), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'INVALID_CONFLICT_ID');
});

test('all load-test responses preserve no-order and no-exchange contract', async () => {
  const result = await syncPaperJournal(new MemoryRepository(), USER_A, request([syncRecord(1)], 'phase8-safety-envelope'), NOW);
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
});

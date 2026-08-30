import test from 'node:test';
import assert from 'node:assert/strict';
import './signal-performance-persistence.service.test';
import './paper-journal-supabase.repository.test';
import { paperJournalFixture } from './paper-journal-test-fixture';
import { createPaperTradingState } from './paper-trading-engine.service';
import { buildPaperResearchCurrencyLedger, PAPER_RESEARCH_LEDGER_MARKETS } from './paper-research-currency-ledger.service';
import { buildPaperResearchLedgerSyncRecord } from './paper-research-persistent-ledger.service';
import {
  deleteAllPaperJournalData,
  getPaperJournalSnapshot,
  resolvePaperJournalConflict,
  syncPaperJournal,
  validatePaperJournalSyncRequest,
} from './paper-journal-sync.service';
import {
  DELETE_ALL_CONFIRMATION,
  MAX_SYNC_RECORDS,
  PaperJournalError,
  type PaperJournalConflict,
  type PaperJournalRecordKind,
  type PaperJournalRepository,
  type PaperJournalSyncRecord,
  type PaperJournalSyncResult,
  type StoredPaperJournalRecord,
} from './paper-journal.types';

const NOW = new Date('2026-08-02T04:00:00.000Z');
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const keyOf = (user: string, kind: string, id: string) => `${user}:${kind}:${id}`;

function record(overrides: Partial<PaperJournalSyncRecord> = {}): PaperJournalSyncRecord {
  const id = overrides.id ?? 'trade-1';
  const payload = { ...paperJournalFixture(id, NOW.toISOString()), ...overrides.payload };
  return {
    kind: 'journal',
    id: 'trade-1',
    version: 1,
    updatedAt: NOW.toISOString(),
    deletedAt: null,
    ...overrides,
    payload: overrides.deletedAt ? {} : payload,
  };
}

function request(records: PaperJournalSyncRecord[], idempotencyKey = 'sync-request-0001') {
  return { idempotencyKey, clientTime: NOW.toISOString(), records };
}

class MemoryRepository implements PaperJournalRepository {
  records = new Map<string, StoredPaperJournalRecord>();
  requests = new Map<string, PaperJournalSyncResult>();
  conflicts = new Map<string, PaperJournalConflict>();
  failIds = new Set<string>();
  journalPayloads: Record<string, unknown>[] = [];
  claims = new Map<string, string>();

  async claimSyncRequest(user: string, key: string, fingerprint: string) {
    const id = `${user}:${key}`;
    if (this.claims.has(id)) throw new PaperJournalError('SYNC_REQUEST_IN_PROGRESS', 'pending', 409);
    this.claims.set(id, fingerprint);
    return null;
  }

  async getRecord(userId: string, kind: PaperJournalRecordKind, id: string) {
    return structuredClone(this.records.get(keyOf(userId, kind, id)) ?? null);
  }

  async upsertRecord(userId: string, next: PaperJournalSyncRecord, serverTime: string, expectedVersion?: number | null) {
    if (this.failIds.has(next.id)) throw new Error('database secret detail');
    const existing = this.records.get(keyOf(userId, next.kind, next.id));
    if (expectedVersion !== undefined && (existing?.version ?? null) !== expectedVersion) throw new PaperJournalError('JOURNAL_VERSION_CHANGED', 'changed', 409);
    const stored: StoredPaperJournalRecord = {
      ...structuredClone(next),
      createdAt: existing?.createdAt ?? serverTime,
      serverUpdatedAt: serverTime,
    };
    this.records.set(keyOf(userId, next.kind, next.id), stored);
    return structuredClone(stored);
  }

  async listSnapshot(userId: string) {
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(`${userId}:`))
      .map(([, value]) => structuredClone(value));
  }

  async getIdempotentResponse(userId: string, idempotencyKey: string) {
    return structuredClone(this.requests.get(`${userId}:${idempotencyKey}`) ?? null);
  }

  async saveIdempotentResponse(userId: string, idempotencyKey: string, result: PaperJournalSyncResult) {
    this.requests.set(`${userId}:${idempotencyKey}`, structuredClone(result));
  }

  async saveConflict(userId: string, conflict: PaperJournalConflict) {
    this.conflicts.set(`${userId}:${conflict.id}`, structuredClone(conflict));
  }

  async getConflict(userId: string, conflictId: string) {
    return structuredClone(this.conflicts.get(`${userId}:${conflictId}`) ?? null);
  }

  async markConflictResolved(userId: string, conflictId: string) {
    const found = this.conflicts.get(`${userId}:${conflictId}`);
    if (found) this.conflicts.set(`${userId}:${conflictId}`, { ...found, status: 'resolved' });
  }

  async listJournalPayloads() { return structuredClone(this.journalPayloads); }

  async deleteAll(userId: string) {
    const counts = { account: 0, order: 0, position: 0, fill: 0, journal: 0, syncState: 0 };
    for (const key of [...this.records.keys()]) {
      if (!key.startsWith(`${userId}:`)) continue;
      const kind = key.split(':')[1] as PaperJournalRecordKind;
      this.records.delete(key);
      counts[kind] += 1;
    }
    for (const key of [...this.requests.keys()]) if (key.startsWith(`${userId}:`)) { this.requests.delete(key); counts.syncState += 1; }
    for (const key of [...this.conflicts.keys()]) if (key.startsWith(`${userId}:`)) { this.conflicts.delete(key); counts.syncState += 1; }
    return counts;
  }
}

test('manual snapshot discloses separate research and broker domains without restoring their rows', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record());
  const ledger = buildPaperResearchCurrencyLedger({ initialCapitalKrw: 1_000_000, markets: PAPER_RESEARCH_LEDGER_MARKETS, fxEvidence: [],
    entries: [{ id: 'cash', bucket: 'CASH', nativeAmount: 1000, quoteCurrency: 'KRW', observedAtMs: NOW.getTime(), source: 'synthetic-paper', provenance: 'fixture', version: 'v1', quality: 'DELAYED' }],
  }, NOW.getTime());
  await seed(repository, USER_A, buildPaperResearchLedgerSyncRecord(ledger, { version: 1, updatedAt: NOW.toISOString() }));
  await seed(repository, USER_A, { ...record(), id: 'signal-performance:event:signal-a', payload: { schemaVersion: 'signal-performance-event-v1', ownerId: USER_A, signalId: 'signal-a' } });
  await seed(repository, USER_A, { ...record(), id: `broker-exec-${'a'.repeat(32)}`, payload: { schemaVersion: 1, recordType: 'unified_trade_order' } });
  const result = await getPaperJournalSnapshot(repository, USER_A, null, 100, NOW);
  assert.equal(result.scope, 'manual-paper-trading');
  assert.deepEqual(result.records.map((r) => r.id), ['trade-1']);
  assert.deepEqual(result.excludedNamespaces, [
    { namespace: 'broker-execution', count: 1 }, { namespace: 'currency-research', count: 1 }, { namespace: 'signal-performance', count: 1 },
  ]);
  assert.equal((await repository.listSnapshot(USER_A)).length, 4, 'excluded records remain untouched in their owning ledger');
});

test('reserved research namespaces cannot be written through the manual sync endpoint', () => {
  for (const item of [record({ id: 'signal-performance:event:fake' }), record({ id: `broker-exec-${'a'.repeat(32)}` }),
    record({ payload: { schemaVersion: 'signal-performance-event-v1' } })]) {
    assert.throws(() => validatePaperJournalSyncRequest(request([item]), NOW), (error: unknown) => error instanceof PaperJournalError && error.code === 'INVALID_RECORD_EVIDENCE');
  }
});

test('namespace mismatch cannot silently hide an invalid manual record', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record({ payload: { schemaVersion: 'signal-performance-event-v1', ownerId: USER_A, signalId: 'signal-a' } }));
  await assert.rejects(getPaperJournalSnapshot(repository, USER_A, null, 100, NOW), (error: unknown) => error instanceof PaperJournalError && error.code === 'INVALID_RECORD_NAMESPACE');
});

async function seed(repository: MemoryRepository, userId: string, next: PaperJournalSyncRecord, serverTime = NOW.toISOString()) {
  return repository.upsertRecord(userId, next, serverTime);
}

const rejectionCases: Array<[string, unknown, string]> = [
  ['rejects missing request', null, 'INVALID_SYNC_REQUEST'],
  ['rejects client user_id', { ...request([]), user_id: USER_B }, 'CLIENT_USER_ID_FORBIDDEN'],
  ['rejects client userId', { ...request([]), userId: USER_B }, 'CLIENT_USER_ID_FORBIDDEN'],
  ['rejects short idempotency key', request([], 'short'), 'INVALID_IDEMPOTENCY_KEY'],
  ['rejects invalid client time', { ...request([]), clientTime: 'bad' }, 'INVALID_CLIENT_TIME'],
  ['rejects non-array records', { ...request([]), records: {} }, 'INVALID_SYNC_RECORDS'],
  ['rejects invalid kind', request([{ ...record(), kind: 'unknown' as PaperJournalRecordKind }]), 'INVALID_RECORD_KIND'],
  ['rejects invalid id', request([record({ id: 'bad id' })]), 'INVALID_RECORD_ID'],
  ['rejects zero version', request([record({ version: 0 })]), 'INVALID_RECORD_VERSION'],
  ['rejects fractional version', request([record({ version: 1.5 })]), 'INVALID_RECORD_VERSION'],
  ['rejects invalid updatedAt', request([record({ updatedAt: 'bad' })]), 'INVALID_RECORD_TIMESTAMP'],
  ['rejects invalid deletedAt', request([record({ deletedAt: 'bad' })]), 'INVALID_TOMBSTONE_TIMESTAMP'],
  ['rejects secret field', request([record({ payload: { apiKey: 'x' } })]), 'SECRET_FIELD_FORBIDDEN'],
  ['rejects nested token field', request([record({ payload: { nested: { access_token: 'x' } } })]), 'SECRET_FIELD_FORBIDDEN'],
  ['rejects payload user_id', request([record({ payload: { user_id: USER_B } })]), 'CLIENT_USER_ID_FORBIDDEN'],
  ['rejects duplicate records', request([record(), record()]), 'DUPLICATE_SYNC_RECORD'],
];

for (const [name, input, code] of rejectionCases) {
  test(name, () => {
    assert.throws(() => validatePaperJournalSyncRequest(input), (cause: unknown) => cause instanceof PaperJournalError && cause.code === code);
  });
}

test('rejects more than maximum sync records', () => {
  const records = Array.from({ length: MAX_SYNC_RECORDS + 1 }, (_, index) => record({ id: `trade-${index}` }));
  assert.throws(() => validatePaperJournalSyncRequest(request(records)), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'TOO_MANY_SYNC_RECORDS');
});

test('uploads a new record', async () => {
  const repository = new MemoryRepository();
  const result = await syncPaperJournal(repository, USER_A, request([record()]), NOW);
  assert.equal(result.uploaded.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal((await repository.getRecord(USER_A, 'journal', 'trade-1'))?.version, 1);
});

test('incomplete financial rows and future evidence fail before any repository write', async () => {
  const invalidRecords = [
    record({ payload: { id: 'different-record' } }), record({ payload: { netPnl: Number.NaN } }),
    record({ payload: { entryFee: undefined } }), record({ payload: { filledAt: '2099-01-01T00:00:00Z' } }),
    record({ updatedAt: '2026-02-30T00:00:00Z' }), record({ updatedAt: new Date(NOW.getTime() + 1).toISOString() }),
    { ...record(), deletedAt: NOW.toISOString() },
  ];
  for (const invalid of invalidRecords) {
    const repository = new MemoryRepository();
    await assert.rejects(syncPaperJournal(repository, USER_A, request([invalid]), NOW), PaperJournalError);
    assert.equal(repository.records.size, 0);
    assert.equal(repository.requests.size, 0);
    assert.equal(repository.conflicts.size, 0);
  }
});

test('deeply nested sync payload is bounded before recursive field inspection', () => {
  let nested: Record<string, unknown> = {};
  for (let index = 0; index < 100; index++) nested = { child: nested };
  assert.throws(() => validatePaperJournalSyncRequest(request([record({ payload: { extra: nested } })]), NOW), (error: unknown) => error instanceof PaperJournalError && error.code === 'PAYLOAD_TOO_DEEP');
});

test('malformed stored rows never become a successful snapshot or download', async () => {
  const repository = new MemoryRepository();
  const corrupted = { ...record({ version: 3 }), payload: { id: 'trade-1', netPnl: 999 } };
  await seed(repository, USER_A, corrupted);
  await assert.rejects(getPaperJournalSnapshot(repository, USER_A, null, 20, NOW), (error: unknown) => error instanceof PaperJournalError && error.code === 'INVALID_RECORD_EVIDENCE');
  const result = await syncPaperJournal(repository, USER_A, request([record()]), NOW);
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.uploaded.length, 0);
  assert.equal(result.failed[0]?.code, 'INVALID_RECORD_EVIDENCE');
  assert.deepEqual((await repository.getRecord(USER_A, 'journal', 'trade-1'))?.payload, corrupted.payload);
});

test('downloads higher server version', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record({ version: 3, payload: { value: 'server' } }));
  const result = await syncPaperJournal(repository, USER_A, request([record({ version: 2, payload: { value: 'device' } })]), NOW);
  assert.equal(result.downloaded[0]?.version, 3);
  assert.equal(result.uploaded.length, 0);
});

test('higher device version replaces server record', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record({ version: 1, payload: { value: 'server' } }));
  const result = await syncPaperJournal(repository, USER_A, request([record({ version: 2, payload: { value: 'device' } })]), NOW);
  assert.equal(result.uploaded[0]?.version, 2);
  assert.equal(result.uploaded[0]?.payload.value, 'device');
});

test('same version and same content is unchanged', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record());
  const result = await syncPaperJournal(repository, USER_A, request([record()]), NOW);
  assert.deepEqual(result.unchanged, [{ kind: 'journal', id: 'trade-1', version: 1 }]);
});

test('canonical key order does not create false conflict', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record({ payload: { b: 2, a: 1 } }));
  const result = await syncPaperJournal(repository, USER_A, request([record({ payload: { a: 1, b: 2 } })]), NOW);
  assert.equal(result.unchanged.length, 1);
});

test('same version and different content creates explicit conflict', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record({ payload: { value: 'server' } }));
  const result = await syncPaperJournal(repository, USER_A, request([record({ payload: { value: 'device' } })]), NOW);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0]?.differenceSummary[0] ?? '', /value/);
});

test('different tombstone state creates conflict at same version', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record());
  const result = await syncPaperJournal(repository, USER_A, request([record({ deletedAt: NOW.toISOString() })]), NOW);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0]?.differenceSummary.join(' ' ) ?? '', /삭제/);
});

test('higher version tombstone is uploaded', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record({ version: 1 }));
  const result = await syncPaperJournal(repository, USER_A, request([record({ version: 2, deletedAt: NOW.toISOString(), payload: {} })]), NOW);
  assert.equal(result.uploaded[0]?.deletedAt, NOW.toISOString());
});

test('same idempotency request returns cached response without duplicate write', async () => {
  const repository = new MemoryRepository();
  const input = request([record()]);
  const first = await syncPaperJournal(repository, USER_A, input, NOW);
  const second = await syncPaperJournal(repository, USER_A, input, new Date(NOW.getTime() + 60_000));
  assert.deepEqual(second, first);
  assert.equal(repository.records.size, 1);
});

test('same idempotency key is isolated per user', async () => {
  const repository = new MemoryRepository();
  await syncPaperJournal(repository, USER_A, request([record()]), NOW);
  const other = await syncPaperJournal(repository, USER_B, request([record({ payload: { owner: 'b' } })]), NOW);
  assert.equal(other.uploaded.length, 1);
  assert.equal(repository.records.size, 2);
});

test('partial failures do not discard successful records', async () => {
  const repository = new MemoryRepository();
  repository.failIds.add('trade-fail');
  const result = await syncPaperJournal(repository, USER_A, request([record(), record({ id: 'trade-fail' })]), NOW);
  assert.equal(result.uploaded.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.code, 'SYNC_ITEM_FAILED');
  assert.doesNotMatch(result.failed[0]?.message ?? '', /database|secret/i);
});

test('large positive clock skew emits warning', async () => {
  const repository = new MemoryRepository();
  const result = await syncPaperJournal(repository, USER_A, { ...request([]), clientTime: new Date(NOW.getTime() + 600_000).toISOString() }, NOW);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.clockSkewMs, 600_000);
});

test('small clock skew emits no warning', async () => {
  const repository = new MemoryRepository();
  const result = await syncPaperJournal(repository, USER_A, { ...request([]), clientTime: new Date(NOW.getTime() + 30_000).toISOString() }, NOW);
  assert.equal(result.warnings.length, 0);
});

test('sync response always preserves no-order contract', async () => {
  const result = await syncPaperJournal(new MemoryRepository(), USER_A, request([]), NOW);
  assert.equal(result.mode, 'journal-sync-only');
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
});

test('server conflict choice keeps server record', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record({ payload: { value: 'server' } }));
  const sync = await syncPaperJournal(repository, USER_A, request([record({ payload: { value: 'device' } })]), NOW);
  const resolved = await resolvePaperJournalConflict(repository, USER_A, sync.conflicts[0]?.id, 'server', NOW);
  assert.equal(resolved.records[0]?.payload.value, 'server');
});

test('device conflict choice creates a higher version', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record({ version: 2, payload: { value: 'server' } }));
  const sync = await syncPaperJournal(repository, USER_A, request([record({ version: 2, payload: { value: 'device' } })]), NOW);
  const resolved = await resolvePaperJournalConflict(repository, USER_A, sync.conflicts[0]?.id, 'device', NOW);
  assert.equal(resolved.records[0]?.version, 3);
  assert.equal(resolved.records[0]?.payload.value, 'device');
});

test('preserve both conflict choice creates a copy', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record({ payload: { value: 'server' } }));
  const sync = await syncPaperJournal(repository, USER_A, request([record({ payload: { value: 'device' } })]), NOW);
  const resolved = await resolvePaperJournalConflict(repository, USER_A, sync.conflicts[0]?.id, 'preserve_both', NOW);
  assert.equal(resolved.records.length, 2);
  assert.match(resolved.records[1]?.id ?? '', /trade-1-copy-/);
  assert.equal(resolved.records[1]?.version, 1);
  assert.equal(resolved.records[1]?.payload.id, resolved.records[1]?.id);
  assert.equal(resolved.records[1]?.payload.conflictCopyOf, 'trade-1');
  assert.equal(resolved.records[1]?.payload.researchEvidenceEligible, false);
});

test('same idempotency key cannot acknowledge different financial content', async () => {
  const repository = new MemoryRepository();
  await syncPaperJournal(repository, USER_A, request([record()]), NOW);
  await assert.rejects(syncPaperJournal(repository, USER_A, request([record({ payload: { netPnl: 999 } })]), NOW), (error: unknown) => error instanceof PaperJournalError && error.code === 'IDEMPOTENCY_CONTEXT_MISMATCH');
  assert.equal((await repository.getRecord(USER_A, 'journal', 'trade-1'))?.payload.netPnl, 0.8);
});

test('concurrent different content cannot reuse an in-flight sync key', async () => {
  let release = () => {};
  class DeferredRepository extends MemoryRepository {
    override async getIdempotentResponse() {
      await new Promise<void>((resolve) => { release = resolve; });
      return null;
    }
  }
  const repository = new DeferredRepository();
  const first = syncPaperJournal(repository, USER_A, request([record()]), NOW);
  await assert.rejects(syncPaperJournal(repository, USER_A, request([record({ payload: { netPnl: 999 } })]), NOW), (error: unknown) => error instanceof PaperJournalError && error.code === 'IDEMPOTENCY_CONTEXT_MISMATCH');
  release();
  await first;
  assert.equal(repository.records.size, 1);
});

test('stored acknowledgement must match the requested financial record', async () => {
  class WrongAcknowledgementRepository extends MemoryRepository {
    override async upsertRecord(userId: string, next: PaperJournalSyncRecord, serverTime: string, expectedVersion?: number | null) {
      const written = await super.upsertRecord(userId, next, serverTime, expectedVersion);
      return { ...written, payload: { ...written.payload, netPnl: 999 } };
    }
  }
  const repository = new WrongAcknowledgementRepository();
  const result = await syncPaperJournal(repository, USER_A, request([record()]), NOW);
  assert.equal(result.uploaded.length, 0);
  assert.equal(result.failed[0]?.code, 'INVALID_RECORD_ACKNOWLEDGEMENT');
});

test('corrupt cached financial response is revalidated on retry', async () => {
  const repository = new MemoryRepository();
  const result = await syncPaperJournal(repository, USER_A, request([record()]), NOW);
  repository.requests.set(`${USER_A}:sync-request-0001`, { ...result, uploaded: [{ ...result.uploaded[0], payload: { id: 'trade-1' } }] });
  await assert.rejects(syncPaperJournal(repository, USER_A, request([record()]), NOW), (error: unknown) => error instanceof PaperJournalError && error.code === 'INVALID_RECORD_EVIDENCE');
});

test('long conflict IDs keep a distinct suffix and matching payload ID', async () => {
  const repository = new MemoryRepository();
  const id = 'j'.repeat(160);
  await seed(repository, USER_A, record({ id, payload: { note: 'server' } }));
  const sync = await syncPaperJournal(repository, USER_A, request([record({ id, payload: { note: 'device' } })]), NOW);
  const result = await resolvePaperJournalConflict(repository, USER_A, sync.conflicts[0]?.id, 'preserve_both', NOW);
  assert.notEqual(result.records[1].id, id);
  assert.equal(result.records[1].id.length, 160);
  assert.equal(result.records[1].payload.id, result.records[1].id);
});

test('account conflict cannot create a second executable account record', async () => {
  const repository = new MemoryRepository();
  const account = createPaperTradingState(10_000, NOW).account;
  const serverRecord: PaperJournalSyncRecord = { kind: 'account', id: account.id, version: 1, updatedAt: NOW.toISOString(), deletedAt: null, payload: { ...account } };
  await seed(repository, USER_A, serverRecord);
  const result = await syncPaperJournal(repository, USER_A, request([{ ...serverRecord, payload: { ...account, cashBalance: 9000 } }]), NOW);
  await assert.rejects(resolvePaperJournalConflict(repository, USER_A, result.conflicts[0]?.id, 'preserve_both', NOW), (error: unknown) => error instanceof PaperJournalError && error.code === 'CONFLICT_COPY_UNSAFE');
  assert.equal(repository.records.size, 1);
});

test('outdated conflict cannot overwrite a later server edit', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record({ payload: { note: 'original server' } }));
  const sync = await syncPaperJournal(repository, USER_A, request([record({ payload: { note: 'device edit' } })]), NOW);
  await seed(repository, USER_A, record({ version: 2, payload: { note: 'later server edit' } }));
  await assert.rejects(resolvePaperJournalConflict(repository, USER_A, sync.conflicts[0]?.id, 'device', NOW), (error: unknown) => error instanceof PaperJournalError && error.code === 'CONFLICT_STALE');
  assert.equal((await repository.getRecord(USER_A, 'journal', 'trade-1'))?.payload.note, 'later server edit');
});

test('resolved conflict cannot be resolved twice', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record({ payload: { value: 'server' } }));
  const sync = await syncPaperJournal(repository, USER_A, request([record({ payload: { value: 'device' } })]), NOW);
  await resolvePaperJournalConflict(repository, USER_A, sync.conflicts[0]?.id, 'server', NOW);
  await assert.rejects(resolvePaperJournalConflict(repository, USER_A, sync.conflicts[0]?.id, 'server', NOW), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'CONFLICT_NOT_FOUND');
});

test('other user cannot resolve conflict', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record({ payload: { value: 'server' } }));
  const sync = await syncPaperJournal(repository, USER_A, request([record({ payload: { value: 'device' } })]), NOW);
  await assert.rejects(resolvePaperJournalConflict(repository, USER_B, sync.conflicts[0]?.id, 'server', NOW), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'CONFLICT_NOT_FOUND');
});

test('invalid conflict choice is rejected', async () => {
  await assert.rejects(resolvePaperJournalConflict(new MemoryRepository(), USER_A, 'conflict:valid', 'silent-discard', NOW), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'INVALID_CONFLICT_CHOICE');
});

test('snapshot returns own records only', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record());
  await seed(repository, USER_B, record({ id: 'trade-b' }));
  const snapshot = await getPaperJournalSnapshot(repository, USER_A, null, 50, NOW);
  assert.deepEqual(snapshot.records.map((item) => item.id), ['trade-1']);
});

test('snapshot paginates with opaque cursor', async () => {
  const repository = new MemoryRepository();
  for (let index = 0; index < 3; index += 1) await seed(repository, USER_A, record({ id: `trade-${index}` }), new Date(NOW.getTime() + index).toISOString());
  const snapshotTime = new Date(NOW.getTime() + 3);
  const first = await getPaperJournalSnapshot(repository, USER_A, null, 2, snapshotTime);
  const second = await getPaperJournalSnapshot(repository, USER_A, first.nextCursor, 2, snapshotTime);
  assert.equal(first.records.length, 2);
  assert.equal(second.records.length, 1);
  assert.equal(second.nextCursor, null);
});

test('snapshot rejects invalid cursor', async () => {
  await assert.rejects(getPaperJournalSnapshot(new MemoryRepository(), USER_A, 'not-base64', 20, NOW), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'INVALID_CURSOR');
});

test('snapshot cursor cannot silently omit or duplicate records after a concurrent update', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record({ id: 'trade-1' }));
  await seed(repository, USER_A, record({ id: 'trade-2' }));
  const first = await getPaperJournalSnapshot(repository, USER_A, null, 1, NOW);
  await seed(repository, USER_A, record({ id: 'trade-1', version: 2, payload: { note: 'changed between pages' } }));
  await assert.rejects(getPaperJournalSnapshot(repository, USER_A, first.nextCursor, 1, NOW), (error: unknown) => error instanceof PaperJournalError && error.code === 'SNAPSHOT_CHANGED');
});

test('snapshot rejects zero page size', async () => {
  await assert.rejects(getPaperJournalSnapshot(new MemoryRepository(), USER_A, null, 0, NOW), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'INVALID_PAGE_SIZE');
});

test('delete all requires exact confirmation string', async () => {
  await assert.rejects(deleteAllPaperJournalData(new MemoryRepository(), USER_A, 'delete'), (cause: unknown) => cause instanceof PaperJournalError && cause.code === 'DELETE_CONFIRMATION_REQUIRED');
});

test('delete all removes only the authenticated user rows', async () => {
  const repository = new MemoryRepository();
  await seed(repository, USER_A, record());
  await seed(repository, USER_B, record({ id: 'trade-b' }));
  const result = await deleteAllPaperJournalData(repository, USER_A, DELETE_ALL_CONFIRMATION);
  assert.equal(result.deleted.journal, 1);
  assert.equal(await repository.getRecord(USER_A, 'journal', 'trade-1'), null);
  assert.notEqual(await repository.getRecord(USER_B, 'journal', 'trade-b'), null);
});

test('delete all response preserves no-order contract', async () => {
  const result = await deleteAllPaperJournalData(new MemoryRepository(), USER_A, DELETE_ALL_CONFIRMATION);
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { paperJournalFixture, paperOrderFixture } from './paper-journal-test-fixture';
import {
  LEGACY_OWNER_KEY,
  applyConflictResolution,
  applyJournalSnapshot,
  applyJournalSyncResult,
  clearUserJournalNamespace,
  createUserPaperStorage,
  loadJournalSyncMetadata,
  markJournalSyncOffline,
  namespacedPaperStorageKey,
  paperOwnerNamespace,
  prepareJournalSync,
  saveJournalSyncMetadata,
  syncMetadataStorageKey,
} from './paper-journal-sync-storage';
import { createLocalPaperState, PAPER_STORAGE_KEY, savePaperState, type StorageLike } from './paper-trading-storage';
import type { ConflictResolutionResult, JournalSnapshotResult, JournalSyncResult, StoredJournalSyncRecord, JournalConflict } from './paper-journal-sync';

const NOW = new Date('2026-08-02T06:00:00.000Z');
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

function stored(overrides: Partial<StoredJournalSyncRecord> = {}): StoredJournalSyncRecord {
  return {
    kind: 'journal', id: 'journal-1', version: 1, updatedAt: NOW.toISOString(), deletedAt: null,
    payload: { ...paperJournalFixture('journal-1', NOW.toISOString()) }, createdAt: NOW.toISOString(), serverUpdatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function syncResult(overrides: Partial<JournalSyncResult> = {}): JournalSyncResult {
  return {
    ok: true, mode: 'journal-sync-only', orderSubmitted: false, exchangeRequestSent: false,
    idempotencyKey: 'sync-test-0001', serverTime: NOW.toISOString(), uploaded: [], downloaded: [], unchanged: [], conflicts: [], failed: [], warnings: [], clockSkewMs: 0,
    ...overrides,
  };
}

function conflictFixture(id: string): JournalConflict {
  return { id, kind: 'journal', recordId: 'journal-1', version: 1, serverRecord: stored(), deviceRecord: stored(), differenceSummary: ['note differs'], createdAt: NOW.toISOString(), status: 'open' };
}

test('scoped snapshot preserves the explicit other-ledger notice without changing paper balances', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10000, NOW);
  const snapshot: JournalSnapshotResult = { ok: true, mode: 'journal-sync-only', orderSubmitted: false, exchangeRequestSent: false,
    records: [], serverTime: NOW.toISOString(), nextCursor: null, scope: 'manual-paper-trading', excludedNamespaces: [{ namespace: 'currency-research', count: 1 }] };
  const applied = applyJournalSnapshot(storage, USER_A, state, snapshot);
  assert.deepEqual(applied.state.account, state.account);
  assert.match(applied.metadata.warning, /별도 원장에 보존/);
  assert.throws(() => applyJournalSnapshot(storage, USER_A, state, { ...snapshot, excludedNamespaces: [{ namespace: 'currency-research', count: Number.NaN }] }), /복원 범위/);
});

test('owner namespace is deterministic and hides raw UUID', () => {
  const value = paperOwnerNamespace(USER_A);
  assert.equal(value, paperOwnerNamespace(USER_A));
  assert.doesNotMatch(value, /11111111/);
});

test('different users receive different storage namespaces', () => {
  assert.notEqual(namespacedPaperStorageKey(USER_A), namespacedPaperStorageKey(USER_B));
});

test('first authenticated user cannot claim unowned legacy v1 data', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  savePaperState(storage, state);
  const adapter = createUserPaperStorage(storage, USER_A, NOW);
  assert.equal(adapter.getItem(PAPER_STORAGE_KEY), null);
  assert.notEqual(storage.getItem(PAPER_STORAGE_KEY), null);
  assert.equal(storage.getItem(LEGACY_OWNER_KEY), null);
});

test('reading unowned legacy data does not copy or mutate any storage key', () => {
  const storage = new MemoryStorage();
  savePaperState(storage, createLocalPaperState(10_000, NOW));
  const original = [...storage.map.entries()];
  createUserPaperStorage(storage, USER_A, NOW).getItem(PAPER_STORAGE_KEY);
  assert.deepEqual([...storage.map.entries()], original);
});

test('neither user can inherit unowned legacy data', () => {
  const storage = new MemoryStorage();
  savePaperState(storage, createLocalPaperState(12_345, NOW));
  assert.equal(createUserPaperStorage(storage, USER_A, NOW).getItem(PAPER_STORAGE_KEY), null);
  assert.equal(createUserPaperStorage(storage, USER_B, NOW).getItem(PAPER_STORAGE_KEY), null);
});

test('known 32-bit hash collision cannot share a paper state or recovery namespace', () => {
  const storage = new MemoryStorage();
  const first = createUserPaperStorage(storage, 'costarring');
  const second = createUserPaperStorage(storage, 'liquid');
  first.setItem(PAPER_STORAGE_KEY, 'first-state');
  first.setItem(`${PAPER_STORAGE_KEY}.corrupt:sample`, 'first-recovery');
  assert.equal(second.getItem(PAPER_STORAGE_KEY), null);
  assert.equal(second.getItem(`${PAPER_STORAGE_KEY}.corrupt:sample`), null);
  assert.notEqual(paperOwnerNamespace('costarring'), paperOwnerNamespace('liquid'));
});

test('adapter writes only to user namespace', () => {
  const storage = new MemoryStorage();
  const adapter = createUserPaperStorage(storage, USER_A, NOW);
  adapter.setItem(PAPER_STORAGE_KEY, 'value-a');
  assert.equal(storage.getItem(namespacedPaperStorageKey(USER_A)), 'value-a');
  assert.equal(storage.getItem(PAPER_STORAGE_KEY), null);
});

test('adapter remove does not remove another user namespace', () => {
  const storage = new MemoryStorage();
  storage.setItem(namespacedPaperStorageKey(USER_B), 'value-b');
  const adapter = createUserPaperStorage(storage, USER_A, NOW);
  adapter.setItem(PAPER_STORAGE_KEY, 'value-a');
  adapter.removeItem(PAPER_STORAGE_KEY);
  assert.equal(storage.getItem(namespacedPaperStorageKey(USER_B)), 'value-b');
});

test('new metadata uses schema version two', () => {
  const metadata = loadJournalSyncMetadata(new MemoryStorage(), USER_A, NOW).metadata;
  assert.equal(metadata.schemaVersion, 2);
  assert.equal(metadata.ownerNamespace, paperOwnerNamespace(USER_A));
});

test('corrupt metadata is backed up and recovered', () => {
  const storage = new MemoryStorage();
  storage.setItem(syncMetadataStorageKey(USER_A), '{bad json');
  const result = loadJournalSyncMetadata(storage, USER_A, NOW);
  assert.equal(result.recovered, true);
  assert.match(result.metadata.warning, /복구/);
  assert.equal([...storage.map.keys()].some((key) => key.includes('.corrupt:')), true);
});

test('metadata with wrong owner is recovered', () => {
  const storage = new MemoryStorage();
  storage.setItem(syncMetadataStorageKey(USER_A), JSON.stringify({ ...loadJournalSyncMetadata(new MemoryStorage(), USER_B, NOW).metadata, ownerNamespace: paperOwnerNamespace(USER_B) }));
  const result = loadJournalSyncMetadata(storage, USER_A, NOW);
  assert.equal(result.recovered, true);
  assert.equal(result.metadata.ownerNamespace, paperOwnerNamespace(USER_A));
});

test('metadata secret-looking keys are rejected', () => {
  const storage = new MemoryStorage();
  const metadata = loadJournalSyncMetadata(storage, USER_A, NOW).metadata as any;
  metadata.apiKey = 'secret';
  assert.throws(() => saveJournalSyncMetadata(storage, USER_A, metadata), /Secret/);
});

test('prepare creates account sync record', () => {
  const storage = new MemoryStorage();
  const result = prepareJournalSync(storage, USER_A, createLocalPaperState(10_000, NOW), NOW);
  assert.equal(result.records.filter((item) => item.kind === 'account').length, 1);
  assert.equal(result.records[0]?.version, 1);
});

test('same local data retry keeps same version', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  const first = prepareJournalSync(storage, USER_A, state, NOW);
  const second = prepareJournalSync(storage, USER_A, state, new Date(NOW.getTime() + 60_000));
  assert.equal(first.records[0]?.version, second.records[0]?.version);
});

test('changed local data increments version', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  prepareJournalSync(storage, USER_A, state, NOW);
  state.account.cashBalance = 9_000;
  const next = prepareJournalSync(storage, USER_A, state, new Date(NOW.getTime() + 60_000));
  assert.equal(next.records.find((item) => item.kind === 'account')?.version, 2);
});

test('new order creates independent record version', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  state.orders.push(paperOrderFixture('order-1', NOW.toISOString()));
  const result = prepareJournalSync(storage, USER_A, state, NOW);
  assert.equal(result.records.find((item) => item.kind === 'order')?.version, 1);
});

test('removed order becomes tombstone and is not silently forgotten', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  state.orders.push(paperOrderFixture('order-1', NOW.toISOString()));
  prepareJournalSync(storage, USER_A, state, NOW);
  state.orders = [];
  const result = prepareJournalSync(storage, USER_A, state, new Date(NOW.getTime() + 60_000));
  const tombstone = result.records.find((item) => item.kind === 'order');
  assert.equal(tombstone?.version, 2);
  assert.notEqual(tombstone?.deletedAt, null);
});

test('tombstone retry keeps version until server success', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  state.orders.push(paperOrderFixture('order-1', NOW.toISOString()));
  prepareJournalSync(storage, USER_A, state, NOW);
  state.orders = [];
  const first = prepareJournalSync(storage, USER_A, state, new Date(NOW.getTime() + 60_000));
  const second = prepareJournalSync(storage, USER_A, state, new Date(NOW.getTime() + 120_000));
  assert.equal(first.records.find((item) => item.kind === 'order')?.version, second.records.find((item) => item.kind === 'order')?.version);
});

test('apply sync result downloads server journal', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  const result = applyJournalSyncResult(storage, USER_A, state, syncResult({ downloaded: [stored()] }));
  assert.equal(result.state.journal[0]?.id, 'journal-1');
  assert.equal(result.metadata.downloadedCount, 1);
});

test('apply sync result records partial failure without deleting state', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  state.journal.push(paperJournalFixture('local-journal', NOW.toISOString()));
  const result = applyJournalSyncResult(storage, USER_A, state, syncResult({ failed: [{ kind: 'journal', id: 'local-journal', code: 'FAILED', message: 'retry' }] }));
  assert.equal(result.metadata.status, 'failed');
  assert.equal(result.metadata.failedCount, 1);
  assert.equal(result.state.journal[0]?.id, 'local-journal');
});

test('apply sync result preserves unresolved conflict', () => {
  const storage = new MemoryStorage();
  const conflict = conflictFixture('conflict:1');
  const result = applyJournalSyncResult(storage, USER_A, createLocalPaperState(10_000, NOW), syncResult({ conflicts: [conflict] }));
  assert.equal(result.metadata.status, 'conflict');
  assert.equal(result.metadata.conflicts.length, 1);
});

test('downloaded tombstone removes matching local row', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  state.journal.push(paperJournalFixture('journal-1', NOW.toISOString()));
  const tombstone = stored({ deletedAt: NOW.toISOString(), payload: {} });
  const result = applyJournalSyncResult(storage, USER_A, state, syncResult({ downloaded: [tombstone] }));
  assert.equal(result.state.journal.length, 0);
});

test('snapshot applies downloaded records', () => {
  const storage = new MemoryStorage();
  const snapshot: JournalSnapshotResult = { ok: true, mode: 'journal-sync-only', orderSubmitted: false, exchangeRequestSent: false, records: [stored()], nextCursor: null, serverTime: NOW.toISOString() };
  const result = applyJournalSnapshot(storage, USER_A, createLocalPaperState(10_000, NOW), snapshot);
  assert.equal(result.state.journal.length, 1);
  assert.equal(result.metadata.status, 'completed');
});

test('conflict resolution removes only resolved conflict', () => {
  const storage = new MemoryStorage();
  const metadata = loadJournalSyncMetadata(storage, USER_A, NOW).metadata;
  metadata.conflicts = [conflictFixture('conflict:1'), conflictFixture('conflict:2')];
  saveJournalSyncMetadata(storage, USER_A, metadata);
  const resolution: ConflictResolutionResult = { ok: true, mode: 'journal-sync-only', orderSubmitted: false, exchangeRequestSent: false, conflictId: 'conflict:1', choice: 'server', records: [stored()], serverTime: NOW.toISOString() };
  const result = applyConflictResolution(storage, USER_A, createLocalPaperState(10_000, NOW), resolution);
  assert.deepEqual(result.metadata.conflicts.map((item) => item.id), ['conflict:2']);
});

test('offline marker keeps records and sets retryable state', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  prepareJournalSync(storage, USER_A, state, NOW);
  const metadata = markJournalSyncOffline(storage, USER_A);
  assert.equal(metadata.status, 'offline');
  assert.equal(Object.keys(metadata.records).length > 0, true);
});

test('clear user namespace does not clear another account', () => {
  const storage = new MemoryStorage();
  storage.setItem(namespacedPaperStorageKey(USER_A), 'a');
  storage.setItem(namespacedPaperStorageKey(USER_B), 'b');
  storage.setItem(syncMetadataStorageKey(USER_A), '{}');
  storage.setItem(syncMetadataStorageKey(USER_B), '{}');
  clearUserJournalNamespace(storage, USER_A);
  assert.equal(storage.getItem(namespacedPaperStorageKey(USER_A)), null);
  assert.equal(storage.getItem(namespacedPaperStorageKey(USER_B)), 'b');
  assert.notEqual(storage.getItem(syncMetadataStorageKey(USER_B)), null);
});

test('explicit conflict choice can replace diverged versions while later local edits remain protected', () => {
  for (const choice of ['server', 'device'] as const) {
    const storage = new MemoryStorage();
    const state = createLocalPaperState(10000, NOW);
    state.journal = [paperJournalFixture('journal-1', NOW.toISOString(), { note: 'offline edits' })];
    const prepared = prepareJournalSync(storage, USER_A, state, NOW);
    const device = { ...prepared.records.find(row => row.kind === 'journal')!, version: 7, baseVersion: 1 };
    const server = stored({ version: 3, payload: { ...device.payload, note: 'other device' } });
    const conflict: JournalConflict = { id: 'conflict:ancestry', kind: 'journal', recordId: device.id, version: 7,
      serverRecord: server, deviceRecord: device, differenceSummary: ['note'], status: 'open', createdAt: NOW.toISOString() };
    prepared.metadata.records['journal:journal-1'].version = 7;
    prepared.metadata.records['journal:journal-1'].baseVersion = 1;
    prepared.metadata.conflicts = [conflict];
    saveJournalSyncMetadata(storage, USER_A, prepared.metadata);
    const selected = choice === 'server' ? server : { ...server, payload: device.payload, version: 8 };
    const response: ConflictResolutionResult = { ok: true, mode: 'journal-sync-only', orderSubmitted: false, exchangeRequestSent: false,
      conflictId: conflict.id, choice, records: [selected], serverTime: NOW.toISOString() };
    const resolved = applyConflictResolution(storage, USER_A, state, response);
    assert.equal(resolved.state.journal[0].note, selected.payload.note);
    assert.equal(resolved.metadata.records['journal:journal-1'].baseVersion, selected.version);
    assert.equal(resolved.metadata.conflicts.length, 0);
    prepared.metadata.records['journal:journal-1'].version = 8;
    saveJournalSyncMetadata(storage, USER_A, prepared.metadata);
    assert.throws(() => applyConflictResolution(storage, USER_A, state, response), /로컬 기록이 바뀌었습니다/);
  }
});

test('offline edits retain the last acknowledged base version across retries and reloads', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  const initial = prepareJournalSync(storage, USER_A, state, NOW);
  assert.equal(initial.records[0].baseVersion, null);
  const acknowledged = applyJournalSyncResult(storage, USER_A, state, syncResult({
    uploaded: initial.records.map(row => ({ ...row, createdAt: NOW.toISOString(), serverUpdatedAt: NOW.toISOString() })),
  }));
  saveJournalSyncMetadata(storage, USER_A, acknowledged.metadata);
  for (let edit = 1; edit <= 4; edit++) {
    state.account.cashBalance = 10000 - edit * 100;
    const prepared = prepareJournalSync(storage, USER_A, state, new Date(NOW.getTime() + edit * 1000));
    assert.equal(prepared.records[0].version, edit + 1);
    assert.equal(prepared.records[0].baseVersion, 1);
    assert.equal(loadJournalSyncMetadata(storage, USER_A).metadata.records[`account:${state.account.id}`].baseVersion, 1);
  }
  const final = prepareJournalSync(storage, USER_A, state, new Date(NOW.getTime() + 6000));
  const unchanged = applyJournalSyncResult(storage, USER_A, state, syncResult({
    unchanged: final.records.map(({ kind, id, version }) => ({ kind, id, version })),
  }));
  assert.equal(unchanged.metadata.records[`account:${state.account.id}`].baseVersion, 5);
});

test('legacy metadata does not invent a server base and a newer server snapshot cannot overwrite dirty local content', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  const initial = prepareJournalSync(storage, USER_A, state, NOW);
  const key = `account:${state.account.id}`;
  delete initial.metadata.records[key].baseVersion;
  saveJournalSyncMetadata(storage, USER_A, initial.metadata);
  const prepared = prepareJournalSync(storage, USER_A, state, NOW);
  assert.equal(prepared.records[0].baseVersion, undefined);
  const before = storage.getItem(syncMetadataStorageKey(USER_A));
  const newer = { ...prepared.records[0], version: 9, payload: { ...prepared.records[0].payload, cashBalance: 1 },
    createdAt: NOW.toISOString(), serverUpdatedAt: NOW.toISOString() };
  assert.throws(() => applyJournalSyncResult(storage, USER_A, state, syncResult({ downloaded: [newer] })), /로컬 변경/);
  assert.equal(storage.getItem(syncMetadataStorageKey(USER_A)), before);
  assert.equal(state.account.cashBalance, 10000);
});

test('invalid server records cannot mutate the local state or synchronization acknowledgement', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  loadJournalSyncMetadata(storage, USER_A, NOW);
  const before = [...storage.map.entries()];
  const original = structuredClone(state);
  const invalidRows = [
    stored({ payload: { id: 'journal-1' } }),
    stored({ payload: { ...paperJournalFixture('journal-1', NOW.toISOString()), netPnl: Number.NaN } }),
    stored({ payload: { ...paperJournalFixture('different-id', NOW.toISOString()) } }),
    stored({ version: 0 }), stored({ serverUpdatedAt: '2099-01-01T00:00:00.000Z' }),
  ];
  for (const row of invalidRows) {
    assert.throws(() => applyJournalSyncResult(storage, USER_A, state, syncResult({ downloaded: [row] })), /원장/);
    assert.deepEqual(state, original);
    assert.deepEqual([...storage.map.entries()], before);
  }
  const mixed = syncResult({ downloaded: [stored(), stored({ payload: { ...paperJournalFixture('journal-1', NOW.toISOString()), netPnl: 999 } })] });
  assert.throws(() => applyJournalSyncResult(storage, USER_A, state, mixed), /중복/);
  assert.deepEqual([...storage.map.entries()], before);
});

test('validated results defer durable acknowledgement until the ledger is saved', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  loadJournalSyncMetadata(storage, USER_A, NOW);
  const before = [...storage.map.entries()];
  const result = applyJournalSyncResult(storage, USER_A, state, syncResult({ downloaded: [stored()] }));
  assert.equal(result.metadata.status, 'completed');
  assert.deepEqual([...storage.map.entries()], before);
});

test('older and conflicting server versions cannot overwrite newer local records', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  state.journal.push(paperJournalFixture('journal-1', NOW.toISOString()));
  prepareJournalSync(storage, USER_A, state, NOW);
  state.journal[0].note = 'newer local note';
  prepareJournalSync(storage, USER_A, state, NOW);
  const before = [...storage.map.entries()];
  assert.throws(() => applyJournalSyncResult(storage, USER_A, state, syncResult({ downloaded: [stored()] })), /서버 버전/);
  assert.throws(() => applyJournalSyncResult(storage, USER_A, state, syncResult({ downloaded: [stored({ version: 2 })] })), /서버 버전/);
  assert.deepEqual([...storage.map.entries()], before);
});

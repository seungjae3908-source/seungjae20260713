import test from 'node:test';
import assert from 'node:assert/strict';
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
import type { ConflictResolutionResult, JournalSnapshotResult, JournalSyncResult, StoredJournalSyncRecord } from './paper-journal-sync';

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
    payload: { id: 'journal-1', status: 'closed', note: '' }, createdAt: NOW.toISOString(), serverUpdatedAt: NOW.toISOString(),
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

test('owner namespace is deterministic and hides raw UUID', () => {
  const value = paperOwnerNamespace(USER_A);
  assert.equal(value, paperOwnerNamespace(USER_A));
  assert.doesNotMatch(value, /11111111/);
});

test('different users receive different storage namespaces', () => {
  assert.notEqual(namespacedPaperStorageKey(USER_A), namespacedPaperStorageKey(USER_B));
});

test('first authenticated user migrates legacy v1 without deleting original', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  savePaperState(storage, state);
  const adapter = createUserPaperStorage(storage, USER_A, NOW);
  assert.notEqual(adapter.getItem(PAPER_STORAGE_KEY), null);
  assert.notEqual(storage.getItem(PAPER_STORAGE_KEY), null);
  assert.equal(storage.getItem(LEGACY_OWNER_KEY), paperOwnerNamespace(USER_A));
});

test('legacy migration creates a backup', () => {
  const storage = new MemoryStorage();
  savePaperState(storage, createLocalPaperState(10_000, NOW));
  createUserPaperStorage(storage, USER_A, NOW).getItem(PAPER_STORAGE_KEY);
  assert.equal([...storage.map.keys()].some((key) => key.startsWith(`${PAPER_STORAGE_KEY}.backup:`)), true);
});

test('second user cannot inherit first user legacy data', () => {
  const storage = new MemoryStorage();
  savePaperState(storage, createLocalPaperState(12_345, NOW));
  createUserPaperStorage(storage, USER_A, NOW).getItem(PAPER_STORAGE_KEY);
  assert.equal(createUserPaperStorage(storage, USER_B, NOW).getItem(PAPER_STORAGE_KEY), null);
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
  state.orders.push({ id: 'order-1' } as any);
  const result = prepareJournalSync(storage, USER_A, state, NOW);
  assert.equal(result.records.find((item) => item.kind === 'order')?.version, 1);
});

test('removed order becomes tombstone and is not silently forgotten', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  state.orders.push({ id: 'order-1' } as any);
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
  state.orders.push({ id: 'order-1' } as any);
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
  state.journal.push({ id: 'local-journal' } as any);
  const result = applyJournalSyncResult(storage, USER_A, state, syncResult({ failed: [{ kind: 'journal', id: 'local-journal', code: 'FAILED', message: 'retry' }] }));
  assert.equal(result.metadata.status, 'failed');
  assert.equal(result.metadata.failedCount, 1);
  assert.equal(result.state.journal[0]?.id, 'local-journal');
});

test('apply sync result preserves unresolved conflict', () => {
  const storage = new MemoryStorage();
  const conflict = { id: 'conflict:1', kind: 'journal', recordId: 'journal-1', version: 1, serverRecord: stored(), deviceRecord: stored(), differenceSummary: ['note differs'], createdAt: NOW.toISOString(), status: 'open' } as any;
  const result = applyJournalSyncResult(storage, USER_A, createLocalPaperState(10_000, NOW), syncResult({ conflicts: [conflict] }));
  assert.equal(result.metadata.status, 'conflict');
  assert.equal(result.metadata.conflicts.length, 1);
});

test('downloaded tombstone removes matching local row', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  state.journal.push({ id: 'journal-1' } as any);
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
  metadata.conflicts = [{ id: 'conflict:1' }, { id: 'conflict:2' }] as any;
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

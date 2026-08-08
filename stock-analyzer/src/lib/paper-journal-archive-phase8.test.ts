import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAPER_ARCHIVE_KEY,
  PAPER_STORAGE_KEY,
  clearPaperState,
  createLocalPaperState,
  exportPaperArchive,
  loadPaperArchive,
  loadPaperState,
  savePaperState,
  type StorageLike,
} from './paper-trading-storage';
import {
  createUserPaperStorage,
  namespacedPaperArchiveKey,
  namespacedPaperStorageKey,
  prepareJournalSync,
} from './paper-journal-sync-storage';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-08-02T09:00:00.000Z');

class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

function stateWithJournal(count: number) {
  const state = createLocalPaperState(10_000, NOW);
  state.journal = Array.from({ length: count }, (_, index) => ({
    id: `journal-${index}`,
    orderId: `order-${index}`,
    note: `note-${index}`,
    status: 'closed',
  } as never));
  return state;
}

test('saving 550 journals keeps 500 active and archives 50', () => {
  const root = new MemoryStorage();
  const storage = createUserPaperStorage(root, USER_A, NOW);
  savePaperState(storage, stateWithJournal(550));
  assert.equal(loadPaperState(storage).state.journal.length, 500);
  assert.equal(loadPaperArchive(storage).journal.length, 50);
  assert.equal(loadPaperArchive(storage).journal[0]?.id, 'journal-0');
});

test('archive storage is namespaced without raw user UUID', () => {
  const key = namespacedPaperArchiveKey(USER_A);
  assert.doesNotMatch(key, /11111111/);
  assert.notEqual(key, namespacedPaperArchiveKey(USER_B));
});

test('active storage and archive storage use separate keys', () => {
  assert.notEqual(namespacedPaperStorageKey(USER_A), namespacedPaperArchiveKey(USER_A));
});

test('second account cannot read first account archive', () => {
  const root = new MemoryStorage();
  savePaperState(createUserPaperStorage(root, USER_A, NOW), stateWithJournal(550));
  assert.equal(loadPaperArchive(createUserPaperStorage(root, USER_B, NOW)).journal.length, 0);
});

test('clear active state preserves archive', () => {
  const root = new MemoryStorage();
  const storage = createUserPaperStorage(root, USER_A, NOW);
  savePaperState(storage, stateWithJournal(550));
  clearPaperState(storage);
  assert.equal(storage.getItem(PAPER_STORAGE_KEY), null);
  assert.equal(loadPaperArchive(storage).journal.length, 50);
});

test('archive is included in synchronization preparation', () => {
  const root = new MemoryStorage();
  const storage = createUserPaperStorage(root, USER_A, NOW);
  savePaperState(storage, stateWithJournal(550));
  const active = loadPaperState(storage).state;
  const prepared = prepareJournalSync(root, USER_A, active, NOW);
  assert.equal(prepared.records.filter((record) => record.kind === 'journal').length, 550);
  assert.equal(prepared.archiveCount, 50);
});

test('archive retry does not increment unchanged versions', () => {
  const root = new MemoryStorage();
  const storage = createUserPaperStorage(root, USER_A, NOW);
  savePaperState(storage, stateWithJournal(550));
  const active = loadPaperState(storage).state;
  const first = prepareJournalSync(root, USER_A, active, NOW);
  const second = prepareJournalSync(root, USER_A, active, new Date(NOW.getTime() + 60_000));
  const firstArchive = first.records.find((record) => record.id === 'journal-0');
  const secondArchive = second.records.find((record) => record.id === 'journal-0');
  assert.equal(firstArchive?.version, secondArchive?.version);
});

test('corrupt archive is backed up before recovery', () => {
  const root = new MemoryStorage();
  const storage = createUserPaperStorage(root, USER_A, NOW);
  storage.setItem(PAPER_ARCHIVE_KEY, '{bad json');
  const result = loadPaperArchive(storage);
  assert.equal(result.recovered, true);
  assert.equal(result.journal.length, 0);
  assert.equal([...root.map.keys()].some((key) => key.includes('.corrupt:')), true);
});

test('archive export is explicit and marks archive candidate', () => {
  const root = new MemoryStorage();
  const storage = createUserPaperStorage(root, USER_A, NOW);
  savePaperState(storage, stateWithJournal(550));
  const exported = JSON.parse(exportPaperArchive(storage));
  assert.equal(exported.archiveCandidate, true);
  assert.equal(exported.journal.length, 50);
});

test('saving again deduplicates archived ids', () => {
  const root = new MemoryStorage();
  const storage = createUserPaperStorage(root, USER_A, NOW);
  const state = stateWithJournal(550);
  savePaperState(storage, state);
  savePaperState(storage, state);
  assert.equal(loadPaperArchive(storage).journal.length, 50);
});

test('archive never uses the shared legacy key for authenticated users', () => {
  const root = new MemoryStorage();
  savePaperState(createUserPaperStorage(root, USER_A, NOW), stateWithJournal(550));
  assert.equal(root.getItem(PAPER_ARCHIVE_KEY), null);
  assert.notEqual(root.getItem(namespacedPaperArchiveKey(USER_A)), null);
});

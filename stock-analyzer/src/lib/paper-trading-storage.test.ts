import test from 'node:test';
import assert from 'node:assert/strict';
import './paper-flat-recovery-backend.test';
import { paperJournalFixture, paperOrderFixture, paperFillFixture } from './paper-journal-test-fixture';
import { calculatePaperStatistics } from './paper-statistics';
import {
  PAPER_STORAGE_KEY,
  clearPaperState,
  createLocalPaperState,
  exportPaperState,
  importPaperState,
  loadPaperState,
  repairPaperState,
  savePaperState,
  validatePaperState,
} from './paper-trading-storage';

class MemoryStorage {
  map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

const NOW = new Date('2026-08-02T02:30:00.000Z');

test('creates local version one state', () => assert.equal(createLocalPaperState(10_000, NOW).schemaVersion, 1));

test('conflict preservation copies do not create extra trades or profit in local statistics', () => {
  const trade = paperJournalFixture('original', NOW.toISOString());
  const copy = { ...trade, id: 'original-copy', conflictCopyOf: trade.id, researchEvidenceEligible: false as const };
  const stats = calculatePaperStatistics([trade, copy]);
  assert.equal(stats.totalTrades, 1);
  assert.equal(stats.cumulativeNetPnl, trade.netPnl);
});
test('rejects invalid initial balance', () => assert.throws(() => createLocalPaperState(0, NOW), /초기 자본/));
test('saves and restores state', () => {
  const storage = new MemoryStorage();
  const state = createLocalPaperState(10_000, NOW);
  state.account.cashBalance = 9_900;
  savePaperState(storage, state);
  assert.equal(loadPaperState(storage).state.account.cashBalance, 9_900);
});
test('uses named storage key', () => {
  const storage = new MemoryStorage();
  savePaperState(storage, createLocalPaperState(10_000, NOW));
  assert.ok(storage.getItem(PAPER_STORAGE_KEY));
});
test('restores empty storage with new state', () => assert.equal(loadPaperState(new MemoryStorage()).state.account.initialBalance, 10_000));
test('corrupted JSON is blocked and preserved without replacing the ledger', () => {
  const storage = new MemoryStorage(); storage.setItem(PAPER_STORAGE_KEY, '{bad');
  const result = loadPaperState(storage);
  assert.equal(result.recovered, false); assert.equal(result.blocked, true);
  assert.equal(storage.getItem(PAPER_STORAGE_KEY), '{bad');
  assert.equal(result.rawExport, '{bad');
  assert.throws(() => savePaperState(storage, createLocalPaperState()), /덮어쓰지/);
  assert.equal(storage.getItem(PAPER_STORAGE_KEY), '{bad');
});
test('wrong schema version is blocked without inventing a recovery', () => {
  const storage = new MemoryStorage(); storage.setItem(PAPER_STORAGE_KEY, JSON.stringify({ schemaVersion: 2, state: {} }));
  assert.equal(loadPaperState(storage).blocked, true);
  assert.equal(loadPaperState(storage).recovered, false);
});
test('state validation rejects NaN', () => {
  const state = createLocalPaperState(10_000, NOW); state.account.cashBalance = Number.NaN;
  assert.equal(validatePaperState(state), false);
});
test('state validation rejects secret-looking keys', () => {
  const state = { ...createLocalPaperState(10_000, NOW), apiKey: 'forbidden' };
  assert.equal(validatePaperState(state), false);
});

test('browser storage guard rejects malformed rows and future evidence before import or save', () => {
  const state = createLocalPaperState(10_000, NOW);
  for (const invalid of [
    { ...state, orders: [{ id: 'missing-financial-record' }] },
    { ...state, positions: [null] },
    { ...state, journal: [{ id: 'missing-journal' }] },
    { ...state, account: { ...state.account, equity: '10000' } },
    { ...state, updatedAt: '2099-01-01T00:00:00.000Z' },
    { ...state, processedEventIds: ['same', 'same'] },
  ]) {
    assert.equal(validatePaperState(invalid), false);
    assert.throws(() => importPaperState(JSON.stringify({ schemaVersion: 1, state: invalid })), /올바른/);
  }
});
test('storage preserves pending orders beyond the old display limit', () => {
  const state = createLocalPaperState(10_000, NOW); state.orders = Array.from({ length: 510 }, (_, index) => paperOrderFixture(String(index), NOW.toISOString()));
  const storage = new MemoryStorage();
  savePaperState(storage, state);
  assert.equal(loadPaperState(storage).state.orders.length, 510);
  assert.equal(loadPaperState(storage).state.orders[0]?.id, '0');
});
test('storage preserves fill evidence beyond the old display limit', () => {
  const state = createLocalPaperState(10_000, NOW); state.fills = Array.from({ length: 1010 }, (_, index) => paperFillFixture(String(index), NOW.toISOString()));
  const storage = new MemoryStorage();
  savePaperState(storage, state);
  assert.equal(loadPaperState(storage).state.fills.length, 1010);
});
test('storage preserves the engine event history without a separate truncation', () => {
  const state = createLocalPaperState(10_000, NOW); state.processedEventIds = Array.from({ length: 510 }, (_, index) => String(index));
  assert.equal(repairPaperState(state).processedEventIds.length, 510);
});
test('repair preserves imported journal notes', () => {
  const state = createLocalPaperState(10_000, NOW); state.journal = [paperJournalFixture('note-test', NOW.toISOString(), { note: 'x'.repeat(3000) })];
  assert.equal(repairPaperState(state).journal[0].note.length, 3000);
});
test('exports valid JSON', () => assert.equal(JSON.parse(exportPaperState(createLocalPaperState(10_000, NOW))).schemaVersion, 1));
test('imports exported state', () => {
  const state = createLocalPaperState(12_000, NOW);
  assert.equal(importPaperState(exportPaperState(state)).account.initialBalance, 12_000);
});
test('rejects invalid import', () => assert.throws(() => importPaperState('{"schemaVersion":1,"state":{}}'), /올바른/));
test('rejects import containing secret key', () => {
  const state = { ...createLocalPaperState(10_000, NOW), secret: 'x' };
  assert.throws(() => importPaperState(JSON.stringify({ schemaVersion: 1, state })), /올바른/);
});
test('rejects oversized import', () => assert.throws(() => importPaperState('x'.repeat(2_000_001)), /너무 큽니다/));
test('clear removes state and returns new account', () => {
  const storage = new MemoryStorage(); savePaperState(storage, createLocalPaperState(10_000, NOW));
  const reset = clearPaperState(storage, 20_000);
  assert.equal(storage.getItem(PAPER_STORAGE_KEY), null); assert.equal(reset.account.initialBalance, 20_000);
});

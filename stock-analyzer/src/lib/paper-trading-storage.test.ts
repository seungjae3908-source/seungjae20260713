import test from 'node:test';
import assert from 'node:assert/strict';
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
test('corrupted JSON is recovered and removed', () => {
  const storage = new MemoryStorage(); storage.setItem(PAPER_STORAGE_KEY, '{bad');
  const result = loadPaperState(storage);
  assert.equal(result.recovered, true); assert.equal(storage.getItem(PAPER_STORAGE_KEY), null);
});
test('wrong schema version is recovered', () => {
  const storage = new MemoryStorage(); storage.setItem(PAPER_STORAGE_KEY, JSON.stringify({ schemaVersion: 2, state: {} }));
  assert.equal(loadPaperState(storage).recovered, true);
});
test('state validation rejects NaN', () => {
  const state = createLocalPaperState(10_000, NOW); state.account.cashBalance = Number.NaN;
  assert.equal(validatePaperState(state), false);
});
test('state validation rejects secret-looking keys', () => {
  const state = { ...createLocalPaperState(10_000, NOW), apiKey: 'forbidden' };
  assert.equal(validatePaperState(state), false);
});
test('repair caps order count', () => {
  const state = createLocalPaperState(10_000, NOW); state.orders = Array.from({ length: 510 }, (_, index) => ({ id: String(index) } as any));
  assert.equal(repairPaperState(state).orders.length, 500);
});
test('repair caps fill count', () => {
  const state = createLocalPaperState(10_000, NOW); state.fills = Array.from({ length: 1010 }, (_, index) => ({ id: String(index) } as any));
  assert.equal(repairPaperState(state).fills.length, 1000);
});
test('repair caps processed events', () => {
  const state = createLocalPaperState(10_000, NOW); state.processedEventIds = Array.from({ length: 510 }, (_, index) => String(index));
  assert.equal(repairPaperState(state).processedEventIds.length, 500);
});
test('repair truncates journal notes', () => {
  const state = createLocalPaperState(10_000, NOW); state.journal = [{ note: 'x'.repeat(3000) } as any];
  assert.equal(repairPaperState(state).journal[0].note.length, 2000);
});
test('exports valid JSON', () => assert.equal(JSON.parse(exportPaperState(createLocalPaperState(10_000, NOW))).schemaVersion, 1));
test('imports exported state', () => {
  const state = createLocalPaperState(12_000, NOW);
  assert.equal(importPaperState(exportPaperState(state)).account.initialBalance, 12_000);
});
test('rejects invalid import', () => assert.throws(() => importPaperState('{"schemaVersion":1,"state":{}}'), /올바른/));
test('rejects import containing secret key', () => {
  const state = createLocalPaperState(10_000, NOW) as any; state.secret = 'x';
  assert.throws(() => importPaperState(JSON.stringify({ schemaVersion: 1, state })), /올바른/);
});
test('rejects oversized import', () => assert.throws(() => importPaperState('x'.repeat(2_000_001)), /너무 큽니다/));
test('clear removes state and returns new account', () => {
  const storage = new MemoryStorage(); savePaperState(storage, createLocalPaperState(10_000, NOW));
  const reset = clearPaperState(storage, 20_000);
  assert.equal(storage.getItem(PAPER_STORAGE_KEY), null); assert.equal(reset.account.initialBalance, 20_000);
});

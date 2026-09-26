import test from 'node:test';
import assert from 'node:assert/strict';
import './paper-flat-recovery-backend.test';
import { applyPaperTradingAction, createPaperTradingState } from '../../../api-server/src/services/paper-trading-engine.service';
import { manualCanonicalFixture } from '../../../api-server/src/services/manual-paper-canonical-contract.fixture';
import { manualPaperEvidenceSha256 } from '../../../api-server/src/services/manual-paper-canonical-contract.service';
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
test('existing browser storage round-trips enriched manual settlement without granting genuine evidence (test-only owner stub)', async () => {
  const state = createPaperTradingState(10_000, NOW);
  const f = await manualCanonicalFixture(state);
  const opened = applyPaperTradingAction(state, {
    type: 'place_order', eventId: 'storage-canonical-entry',
    request: { symbol: f.canonicalIdentity.symbol, side: 'long', leverage: f.canonicalIdentity.leverage,
      stopLossPrice: f.evidence.candidate.signal.learningSnapshot.stopLoss, orderType: 'market', canonicalIdentity: f.canonicalIdentity },
    market: { warnings: [] }, contractRules: { warnings: [] }, riskInput: {},
  } as any, f.now, f.evidence);
  const settled = applyPaperTradingAction(opened.state, {
    type: 'close_position', eventId: 'storage-canonical-exit', positionId: opened.position.id,
    market: { symbol: f.canonicalIdentity.symbol, status: 'live', bidPrice: 105,
      updatedAt: f.exitNow.toISOString(), warnings: [] },
  } as any, f.exitNow, { ...f.exitEvidence, paperStateSha256: manualPaperEvidenceSha256(opened.state) });
  const canonical = settled.state.journal[0].canonicalPaper;
  const storage = new MemoryStorage();
  savePaperState(storage, settled.state as any);
  const loaded = loadPaperState(storage);
  assert.equal(loaded.recovered, false);
  for (const record of [loaded.state.positions[0], loaded.state.fills.at(-1), loaded.state.journal[0]] as any[]) {
    assert.deepEqual(record.canonicalPaper.settlement, canonical.settlement);
    assert.deepEqual(record.canonicalPaper.identity, f.canonicalIdentity);
    assert.deepEqual(record.canonicalPaper.fullCost, canonical.fullCost);
    assert.equal(record.canonicalPaper.naturalSampleCredit, 0);
    assert.equal(record.canonicalPaper.executionAuthority, 'NONE');
  }
  assert.match(canonical.settlement.settlementId, /^[0-9a-f]{64}$/);
  assert.equal(loaded.state.journal[0].netPnl, canonical.settlement.netPnl);
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

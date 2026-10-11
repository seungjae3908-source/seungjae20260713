import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import './paper-flat-recovery-backend.test';
import './paper-trade-review.test';
import './four-market-paper-status.test';
import './manual-four-market-paper-status.test';
import { applyPaperTradingAction, createPaperTradingState } from '../../../api-server/src/services/paper-trading-engine.service';
import { manualCanonicalFixture } from '../../../api-server/src/services/manual-paper-canonical-contract.fixture';
import { manualPaperEvidenceSha256 } from '../../../api-server/src/services/manual-paper-canonical-contract.service';
import {
  PAPER_STORAGE_KEY,
  clearPaperState,
  createLocalPaperState,
  PAPER_MANUAL_ROUNDS_KEY,
  MANUAL_PAPER_NEXT_ROUND_CONFIRMATION,
  startNextLocalManualPaperRound,
  getManualPaperRoundSummary,
  exportManualPaperRounds,
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

test('manual local Paper starts a new round only after confirmation and preserves bankrupt snapshot', () => {
  const storage = new MemoryStorage();
  const state=createLocalPaperState(10_000,NOW);
  state.account.cashBalance=0;state.account.equity=0;
  state.account.availableMargin=0;state.account.realizedPnl=-10_000;
  state.journal=[{id:'bankrupt-last-trade',status:'closed',netPnl:-10_000} as any];
  savePaperState(storage,state);
  assert.throws(()=>startNextLocalManualPaperRound(storage,state,''),/명시적으로/);
  assert.equal(storage.getItem(PAPER_MANUAL_ROUNDS_KEY),null);
  const next=startNextLocalManualPaperRound(storage,state,
    MANUAL_PAPER_NEXT_ROUND_CONFIRMATION,new Date(NOW.getTime()+1_000));
  assert.equal(next.account.initialBalance,10_000);
  assert.equal(next.account.equity,10_000);
  assert.notEqual(next.account.id,state.account.id);
  const archive=JSON.parse(exportManualPaperRounds(storage));
  assert.deepEqual(archive.rounds[0].archived.journal,state.journal);
  assert.equal(archive.rounds[0].archived.account.equity,0);
  assert.equal(archive.rounds[0].bankrupt,true);
  const summary=getManualPaperRoundSummary(storage);
  assert.equal(summary.bankruptcies,1);
  assert.equal(summary.totalNet,-10_000);
  assert.equal(summary.totalIssued,10_000);
  assert.equal(summary.issuedCapitalReturnPercent,-100);
});
test('manual second profitable ongoing round cannot hide prior bankruptcy in combined ROI', () => {
  const storage=new MemoryStorage();
  const first=createLocalPaperState(10_000,NOW);
  first.account.cashBalance=0;first.account.equity=0;first.account.availableMargin=0;
  savePaperState(storage,first);
  const second=startNextLocalManualPaperRound(storage,first,
    MANUAL_PAPER_NEXT_ROUND_CONFIRMATION,new Date(NOW.getTime()+1_000));
  second.account.cashBalance=12_000;
  second.account.equity=12_000;
  second.account.availableMargin=12_000;
  savePaperState(storage,second);
  assert.throws(()=>startNextLocalManualPaperRound(storage,second,
    MANUAL_PAPER_NEXT_ROUND_CONFIRMATION,new Date(NOW.getTime()+2_000)),/자본이 남아/);
  const report=getManualPaperRoundSummary(storage, second);
  assert.equal(report.completedRounds,1);
  assert.equal(report.bankruptcies,1);
  assert.equal(report.cumulativeIncludingActive.rounds,2);
  assert.equal(report.cumulativeIncludingActive.totalIssued,20_000);
  assert.equal(report.cumulativeIncludingActive.totalNet,-8_000);
  assert.equal(report.cumulativeIncludingActive.totalReturnPercent,-40);
});

test('manual round refuses open exposure, pending order and forged current account identity', () => {
  const storage=new MemoryStorage();
  const old=createLocalPaperState(10_000,NOW);
  old.account.cashBalance=0; old.account.equity=0; old.account.availableMargin=0;
  savePaperState(storage,old);
  const open={...old,positions:[{status:'open',remainingQuantity:1}] as any};
  assert.throws(()=>startNextLocalManualPaperRound(storage,open,
    MANUAL_PAPER_NEXT_ROUND_CONFIRMATION),/열린 포지션/);
  const pending={...old,orders:[{status:'pending'}] as any};
  assert.throws(()=>startNextLocalManualPaperRound(storage,pending,
    MANUAL_PAPER_NEXT_ROUND_CONFIRMATION),/미체결 주문/);
  const forged=createLocalPaperState(10_000,new Date(NOW.getTime()+5_000));
  forged.account.cashBalance=0;forged.account.equity=0;forged.account.availableMargin=0;
  assert.throws(()=>startNextLocalManualPaperRound(storage,forged,
    MANUAL_PAPER_NEXT_ROUND_CONFIRMATION),/다른 화면에서/);
  assert.equal(getManualPaperRoundSummary(storage).completedRounds,0);
});
test('a failed manual round state write can retry the SAME archived next round without multiplying capital', () => {
  const storage=new MemoryStorage();
  const state=createLocalPaperState(10_000,NOW);
  state.account.cashBalance=0;state.account.equity=0;state.account.availableMargin=0;
  savePaperState(storage,state);
  const original=storage.setItem.bind(storage);
  let failOnce=true;
  storage.setItem=(key,value)=>{
    if(key===PAPER_STORAGE_KEY && failOnce) {
      failOnce=false;throw new Error('simulated quota failure');
    }
    original(key,value);
  };
  assert.throws(()=>startNextLocalManualPaperRound(storage,state,
    MANUAL_PAPER_NEXT_ROUND_CONFIRMATION,new Date(NOW.getTime()+1_000)),/quota/);
  assert.equal(getManualPaperRoundSummary(storage).completedRounds,1);
  const retry=startNextLocalManualPaperRound(storage,state,
    MANUAL_PAPER_NEXT_ROUND_CONFIRMATION,new Date(NOW.getTime()+3_000));
  assert.equal(retry.account.id,getManualPaperRoundSummary(storage).records[0].nextAccountId);
  assert.equal(getManualPaperRoundSummary(storage).completedRounds,1);
});

test('Paper composite page keeps both owner-scoped panels and the original backtest/Paper mode', () => {
  const root = path.basename(process.cwd()) === 'api-server'
    ? path.resolve(process.cwd(), '..') : process.cwd();
  const source = readFileSync(path.join(root, 'stock-analyzer/src/pages/paper-trading.tsx'), 'utf8');
  assert.match(source, /import \{ FourMarketPaperStatusPanel \}/);
  assert.match(source, /import \{ManualFourMarketWalletPanel\}/);
  assert.match(source, /<FourMarketPaperStatusPanel \/>/);
  assert.match(source, /<ManualFourMarketWalletPanel \/>/);
  assert.match(source, /<AutoTradingPage initialMode="paper" \/>/);
  assert.match(source, /<BacktestPaperCandidatePreview imported=\{imported\} \/>/);
  assert.doesNotMatch(source, /initialMode="live"/);
});

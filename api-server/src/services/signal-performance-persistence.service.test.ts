import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createImmutableSignalSnapshot } from './signal-performance-learning.service';
import {
  buildPersistentSignalEvent, buildPersistentSignalOutcome, buildSignalPerformanceReadModel,
  PaperJournalSignalPerformanceRepository, persistSignalEvent, persistSignalOutcome, profitFirstPerformanceEvidence,
  type PersistentSignalEvent, type PersistentSignalOutcome, type SignalPerformanceRepository,
} from './signal-performance-persistence.service';

class MemoryRepository implements SignalPerformanceRepository {
  constructor(private readonly store = { signals: new Map<string, PersistentSignalEvent>(), outcomes: new Map<string, PersistentSignalOutcome>() }) {}
  shared() { return this.store; }
  async getSignal(owner: string, id: string) { return this.store.signals.get(`${owner}:${id}`) ?? null; }
  async insertSignal(value: PersistentSignalEvent) { this.store.signals.set(`${value.ownerId}:${value.signalId}`, value); }
  async getOutcome(owner: string, id: string) { return this.store.outcomes.get(`${owner}:${id}`) ?? null; }
  async insertOutcome(value: PersistentSignalOutcome) { this.store.outcomes.set(`${value.ownerId}:${value.outcomeId}`, value); }
  async listSignals(owner: string) { return [...this.store.signals.entries()].filter(([key]) => key.startsWith(`${owner}:`)).map(([, value]) => value); }
  async listOutcomes(owner: string) { return [...this.store.outcomes.entries()].filter(([key]) => key.startsWith(`${owner}:`)).map(([, value]) => value); }
}

const snapshot = createImmutableSignalSnapshot({ signalId: 'sig-1', timestamp: '2026-08-15T00:00:00.000Z', market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', symbolName: null, strategyHorizon: 'SWING', direction: 'LONG', signalScore: 80, displayConfidence: null, referencePrice: 100, entryPrice: 100, stopLoss: 95, target1: 105, target2: null, riskReward: 1, timeframes: ['1h'], strategyProfileVersion: 'family:v1', indicatorSnapshot: {}, indicatorScores: {}, patternSnapshot: {}, volumeContext: {}, volatilityContext: {}, trendContext: {}, marketRegime: 'SIDEWAYS', liquidityContext: {}, aiValidatorResult: null, riskEngineResult: { status: 'PASS' }, dataProvenance: ['BITGET_PUBLIC'], dataTimestamp: '2026-08-14T23:59:00.000Z' });
const identity = { strategyFamily: 'family', strategyVersion: 'v1', parameterHash: 'params-a', researchCodeSha: 'a'.repeat(40), costPolicyVersion: 'cost-v1', executionPolicyVersion: 'execution-v1' };
function event(ownerId = 'user-a', overrides = {}) { return buildPersistentSignalEvent({ ownerId, signalId: snapshot.signalId, snapshot, identity: { ...identity, ...overrides }, featureCutoffTimestamp: snapshot.dataTimestamp, profitFirstEvidence: null, dataHealth: { status: 'READY' }, providerProvenance: ['BITGET_PUBLIC'], createdAt: '2026-08-15T00:00:01.000Z' }); }
function outcome(source: 'PAPER' | 'SHADOW', status: 'WIN' | 'LOSS' | 'NEUTRAL' | 'EXPIRED' = 'WIN', values: Partial<Omit<PersistentSignalOutcome, 'schemaVersion' | 'executionAuthority'>> = {}) { return buildPersistentSignalOutcome({ ownerId: 'user-a', outcomeId: `${source}-${status}`, signalId: 'sig-1', source, outcome: status, entryTime: '2026-08-15T00:01:00.000Z', exitTime: '2026-08-15T01:01:00.000Z', resolvedAt: '2026-08-15T01:01:01.000Z', resolutionSource: `${source}_CANONICAL`, mfePercent: 6, maePercent: -2, targetBeforeStop: status === 'WIN', grossPnl: 5, totalCost: 1, netPnl: 4, grossReturnPercent: 5, netReturnPercent: 4, holdingDurationMs: 3_600_000, ...values }, event()); }

describe('persistent signal performance learning', () => {
  it('persists signal and outcome exactly once across reconnect', async () => { const first = new MemoryRepository(); const e = event(); assert.equal((await persistSignalEvent(first, e)).inserted, true); assert.equal((await persistSignalEvent(first, e)).inserted, false); const o = outcome('PAPER'); assert.equal((await persistSignalOutcome(first, o)).inserted, true); const reconnect = new MemoryRepository(first.shared()); assert.equal((await persistSignalOutcome(reconnect, o)).inserted, false); assert.equal((await reconnect.listOutcomes('user-a')).length, 1); });
  it('restores records through the canonical Paper Journal repository adapter', async () => {
    const rows = new Map<string, any>();
    const journal: any = {
      async getRecord(user: string, kind: string, id: string) { return structuredClone(rows.get(`${user}:${kind}:${id}`) ?? null); },
      async upsertRecord(user: string, record: any, serverTime: string) { const stored = { ...structuredClone(record), createdAt: serverTime, serverUpdatedAt: serverTime }; rows.set(`${user}:${record.kind}:${record.id}`, stored); return structuredClone(stored); },
      async listSnapshot(user: string) { return [...rows.entries()].filter(([key]) => key.startsWith(`${user}:`)).map(([, value]) => structuredClone(value)); },
    };
    const first = new PaperJournalSignalPerformanceRepository(journal, 'user-a');
    await persistSignalEvent(first, event()); await persistSignalOutcome(first, outcome('PAPER'));
    const reconnect = new PaperJournalSignalPerformanceRepository(journal, 'user-a');
    assert.equal((await reconnect.listSignals('user-a')).length, 1); assert.equal((await reconnect.listOutcomes('user-a')).length, 1);
    await assert.rejects(() => reconnect.listSignals('user-b'), /USER_ISOLATION/);
  });
  it('rejects outcome without signal and conflicting identity', async () => { const repo = new MemoryRepository(); await assert.rejects(() => persistSignalOutcome(repo, outcome('PAPER')), /WITHOUT_EVENT/); await persistSignalEvent(repo, event()); await assert.rejects(() => persistSignalEvent(repo, event('user-a', { parameterHash: 'params-b' })), /IDENTITY_CONFLICT/); });
  it('separates research SHA and parameter dimensions instead of mixing', async () => { const repo = new MemoryRepository(); await persistSignalEvent(repo, event()); const changedSnapshot = { ...snapshot, signalId: 'sig-2' }; await persistSignalEvent(repo, buildPersistentSignalEvent({ ...event(), signalId: 'sig-2', snapshot: changedSnapshot, identity: { ...identity, parameterHash: 'params-b', researchCodeSha: 'b'.repeat(40) } })); assert.equal((await buildSignalPerformanceReadModel(repo, 'user-a', { source: 'PAPER', parameterHash: 'params-a' })).totalSignals, 1); assert.equal((await buildSignalPerformanceReadModel(repo, 'user-a', { source: 'PAPER', researchCodeSha: 'b'.repeat(40) })).totalSignals, 1); });
  it('keeps zero/unresolved sample metrics N/A and Profit-First not evidenced', async () => { const repo = new MemoryRepository(); await persistSignalEvent(repo, event()); const model = await buildSignalPerformanceReadModel(repo, 'user-a', { source: 'PAPER' }); assert.equal(model.unresolvedSignals, 1); assert.equal(model.hitRate, null); assert.equal(model.profitFactor, null); assert.equal(profitFirstPerformanceEvidence(model).status, 'NOT_EVIDENCED'); });
  it('keeps Paper and Shadow outcomes in separate read models', async () => { const repo = new MemoryRepository(); await persistSignalEvent(repo, event()); await persistSignalOutcome(repo, outcome('PAPER')); await persistSignalOutcome(repo, outcome('SHADOW')); assert.equal((await buildSignalPerformanceReadModel(repo, 'user-a', { source: 'PAPER', minimumSampleSize: 1 })).sampleSize, 1); assert.equal((await buildSignalPerformanceReadModel(repo, 'user-a', { source: 'SHADOW', minimumSampleSize: 1 })).sampleSize, 1); });
  it('aggregates WIN LOSS NEUTRAL EXPIRED, costs, MFE/MAE and net-loss after gross win', async () => { const repo = new MemoryRepository(); await persistSignalEvent(repo, event()); for (const row of [outcome('PAPER', 'WIN'), outcome('PAPER', 'LOSS', { outcomeId: 'loss', grossPnl: 2, totalCost: 3, netPnl: -1, grossReturnPercent: 2, netReturnPercent: -1 }), outcome('PAPER', 'NEUTRAL'), outcome('PAPER', 'EXPIRED')]) await persistSignalOutcome(repo, row); const model = await buildSignalPerformanceReadModel(repo, 'user-a', { source: 'PAPER', minimumSampleSize: 4 }); assert.deepEqual([model.wins, model.losses, model.neutral, model.expired], [1, 1, 1, 1]); assert.equal(model.netProfitableRate, 75); assert.equal(model.averageMfe, 6); assert.equal(model.averageMae, -2); assert.equal(model.totalCosts, 6); assert.ok(model.hitRateWilson95); assert.equal(profitFirstPerformanceEvidence(model).status, 'EVIDENCED'); });
  it('enforces user isolation and caller-versioned recent policy', async () => { const repo = new MemoryRepository(); await persistSignalEvent(repo, event('user-a')); await persistSignalEvent(repo, event('user-b')); assert.equal((await repo.listSignals('user-a')).length, 1); const model = await buildSignalPerformanceReadModel(repo, 'user-a', { source: 'PAPER', recentPolicy: { version: 'recent-v1', since: '2026-08-15T00:00:00.000Z' } }); assert.equal(model.recentPolicyVersion, 'recent-v1'); assert.equal(model.totalSignals, 1); });
  it('rejects future leakage and temporal outcome inversion', () => { assert.throws(() => buildPersistentSignalEvent({ ...event(), featureCutoffTimestamp: '2026-08-15T00:01:00.000Z' }), /FUTURE_LEAKAGE/); assert.throws(() => outcome('PAPER', 'WIN', { exitTime: '2026-08-15T00:00:30.000Z' }), /TEMPORAL_ORDER/); });
});

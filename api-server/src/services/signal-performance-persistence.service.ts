import type { PaperJournalRepository, PaperJournalSyncRecord } from './paper-journal.types';
import {
  DEFAULT_MINIMUM_SAMPLE_SIZE,
  SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY,
  type SignalOutcomeStatus,
  type SignalPerformanceDirection,
  type SignalPerformanceHorizon,
  type SignalPerformanceMarket,
  type SignalSnapshot,
} from './signal-performance-learning.service';

export type PersistentPerformanceSource = 'BACKTEST' | 'OOS' | 'WALK_FORWARD' | 'FINAL_HOLDOUT' | 'PAPER' | 'SHADOW' | 'LIVE_RECOMMENDATION';
export type PersistentEvidenceState = 'INSUFFICIENT_SAMPLE' | 'PARTIAL' | 'EVIDENCED';

export type PersistentStrategyIdentity = Readonly<{
  strategyFamily: string;
  strategyVersion: string;
  parameterHash: string;
  researchCodeSha: string;
  costPolicyVersion: string;
  executionPolicyVersion: string;
}>;

export type PersistentSignalEvent = Readonly<{
  schemaVersion: 'signal-performance-event-v1';
  ownerId: string;
  signalId: string;
  snapshot: SignalSnapshot;
  identity: PersistentStrategyIdentity;
  featureCutoffTimestamp: string;
  profitFirstEvidence: Readonly<Record<string, unknown>> | null;
  dataHealth: Readonly<Record<string, unknown>> | null;
  providerProvenance: readonly string[];
  createdAt: string;
  immutable: true;
  executionAuthority: 'NONE';
}>;

export type PersistentSignalOutcome = Readonly<{
  schemaVersion: 'signal-performance-outcome-v1';
  ownerId: string;
  outcomeId: string;
  signalId: string;
  source: PersistentPerformanceSource;
  outcome: SignalOutcomeStatus;
  entryTime: string;
  exitTime: string;
  resolvedAt: string;
  resolutionSource: string;
  mfePercent: number | null;
  maePercent: number | null;
  targetBeforeStop: boolean | null;
  grossPnl: number | null;
  totalCost: number | null;
  netPnl: number | null;
  grossReturnPercent: number | null;
  netReturnPercent: number | null;
  holdingDurationMs: number;
  executionAuthority: 'NONE';
}>;

export interface SignalPerformanceRepository {
  getSignal(ownerId: string, signalId: string): Promise<PersistentSignalEvent | null>;
  insertSignal(event: PersistentSignalEvent): Promise<void>;
  getOutcome(ownerId: string, outcomeId: string): Promise<PersistentSignalOutcome | null>;
  insertOutcome(outcome: PersistentSignalOutcome): Promise<void>;
  listSignals(ownerId: string): Promise<readonly PersistentSignalEvent[]>;
  listOutcomes(ownerId: string): Promise<readonly PersistentSignalOutcome[]>;
}

export type PerformanceQuery = Readonly<{
  source?: PersistentPerformanceSource;
  market?: SignalPerformanceMarket;
  symbol?: string;
  strategyMode?: SignalPerformanceHorizon;
  strategyFamily?: string;
  strategyVersion?: string;
  parameterHash?: string;
  direction?: SignalPerformanceDirection;
  timeframe?: string;
  horizon?: string;
  regime?: string;
  researchCodeSha?: string;
  recentPolicy?: Readonly<{ version: string; since: string }>;
  minimumSampleSize?: number;
}>;

export type SignalPerformanceReadModel = Readonly<{
  source: PersistentPerformanceSource | 'ALL';
  evidenceState: PersistentEvidenceState;
  minimumSampleSize: number;
  totalSignals: number;
  resolvedSignals: number;
  unresolvedSignals: number;
  wins: number;
  losses: number;
  neutral: number;
  expired: number;
  sampleSize: number;
  hitRate: number | null;
  hitRateWilson95: Readonly<{ lower: number; upper: number }> | null;
  tpBeforeSlRate: number | null;
  netProfitableRate: number | null;
  averageGrossReturn: number | null;
  averageNetReturn: number | null;
  medianNetReturn: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  payoffRatio: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  averageMfe: number | null;
  averageMae: number | null;
  totalCosts: number | null;
  averageHoldingDurationMs: number | null;
  recentPolicyVersion: string | null;
  executionAuthority: 'NONE';
}>;

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function parseTime(value: string, code: string) { const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new Error(code); return parsed; }
function immutableSha(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function cloneFreeze<T>(value: T): T { const clone = structuredClone(value); return Object.freeze(clone); }
function round(value: number, digits = 4) { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
function mean(values: readonly number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function median(values: readonly number[]) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const m = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2; }

function validateIdentity(identity: PersistentStrategyIdentity) {
  if (!nonEmpty(identity.strategyFamily) || !nonEmpty(identity.strategyVersion) || !nonEmpty(identity.parameterHash)
    || !immutableSha(identity.researchCodeSha) || !nonEmpty(identity.costPolicyVersion) || !nonEmpty(identity.executionPolicyVersion)) {
    throw new Error('SIGNAL_PERFORMANCE_IDENTITY_INVALID');
  }
}

export function buildPersistentSignalEvent(input: Omit<PersistentSignalEvent, 'schemaVersion' | 'immutable' | 'executionAuthority'>): PersistentSignalEvent {
  if (!nonEmpty(input.ownerId) || input.signalId !== input.snapshot.signalId) throw new Error('SIGNAL_EVENT_IDENTITY_INVALID');
  validateIdentity(input.identity);
  const created = parseTime(input.createdAt, 'SIGNAL_EVENT_CREATED_AT_INVALID');
  const signal = parseTime(input.snapshot.timestamp, 'SIGNAL_EVENT_TIMESTAMP_INVALID');
  const cutoff = parseTime(input.featureCutoffTimestamp, 'SIGNAL_EVENT_CUTOFF_INVALID');
  if (cutoff > signal || signal > created) throw new Error('SIGNAL_EVENT_FUTURE_LEAKAGE');
  return cloneFreeze({ ...input, identity: { ...input.identity, researchCodeSha: input.identity.researchCodeSha.toLowerCase() }, schemaVersion: 'signal-performance-event-v1' as const, immutable: true as const, executionAuthority: SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY });
}

export function buildPersistentSignalOutcome(input: Omit<PersistentSignalOutcome, 'schemaVersion' | 'executionAuthority'>, event: PersistentSignalEvent): PersistentSignalOutcome {
  if (input.ownerId !== event.ownerId || input.signalId !== event.signalId || !nonEmpty(input.outcomeId)) throw new Error('SIGNAL_OUTCOME_SIGNAL_MISMATCH');
  const signalTime = parseTime(event.snapshot.timestamp, 'SIGNAL_EVENT_TIMESTAMP_INVALID');
  const entry = parseTime(input.entryTime, 'SIGNAL_OUTCOME_ENTRY_TIME_INVALID');
  const exit = parseTime(input.exitTime, 'SIGNAL_OUTCOME_EXIT_TIME_INVALID');
  const resolved = parseTime(input.resolvedAt, 'SIGNAL_OUTCOME_RESOLVED_TIME_INVALID');
  if (entry < signalTime || exit < entry || resolved < exit || input.holdingDurationMs !== exit - entry) throw new Error('SIGNAL_OUTCOME_TEMPORAL_ORDER_INVALID');
  if (!nonEmpty(input.resolutionSource) || input.totalCost != null && (!finite(input.totalCost) || input.totalCost < 0)) throw new Error('SIGNAL_OUTCOME_COST_OR_SOURCE_INVALID');
  return cloneFreeze({ ...input, schemaVersion: 'signal-performance-outcome-v1' as const, executionAuthority: SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY });
}

function sameOrConflict(existing: unknown, incoming: unknown, code: string) { if (stable(existing) !== stable(incoming)) throw new Error(code); }

export async function persistSignalEvent(repository: SignalPerformanceRepository, event: PersistentSignalEvent) {
  const existing = await repository.getSignal(event.ownerId, event.signalId);
  if (existing) { sameOrConflict(existing, event, 'SIGNAL_EVENT_IDENTITY_CONFLICT'); return { inserted: false as const, event: existing }; }
  await repository.insertSignal(event);
  return { inserted: true as const, event };
}

export async function persistSignalOutcome(repository: SignalPerformanceRepository, outcome: PersistentSignalOutcome) {
  const event = await repository.getSignal(outcome.ownerId, outcome.signalId);
  if (!event) throw new Error('SIGNAL_OUTCOME_WITHOUT_EVENT');
  const existing = await repository.getOutcome(outcome.ownerId, outcome.outcomeId);
  if (existing) { sameOrConflict(existing, outcome, 'SIGNAL_OUTCOME_IDENTITY_CONFLICT'); return { inserted: false as const, outcome: existing }; }
  await repository.insertOutcome(outcome);
  return { inserted: true as const, outcome };
}

function matches(event: PersistentSignalEvent, query: PerformanceQuery) {
  const i = event.identity; const s = event.snapshot;
  return (!query.market || s.market === query.market) && (!query.symbol || s.symbol === query.symbol)
    && (!query.strategyMode || s.strategyHorizon === query.strategyMode) && (!query.strategyFamily || i.strategyFamily === query.strategyFamily)
    && (!query.strategyVersion || i.strategyVersion === query.strategyVersion) && (!query.parameterHash || i.parameterHash === query.parameterHash)
    && (!query.direction || s.direction === query.direction) && (!query.timeframe || s.timeframes.includes(query.timeframe))
    && (!query.horizon || s.strategyHorizon === query.horizon) && (!query.regime || s.marketRegime === query.regime)
    && (!query.researchCodeSha || i.researchCodeSha === query.researchCodeSha.toLowerCase());
}

function wilson(wins: number, sample: number) {
  if (!sample) return null; const z = 1.959963984540054; const p = wins / sample; const d = 1 + z * z / sample;
  const center = (p + z * z / (2 * sample)) / d; const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * sample)) / sample) / d;
  return Object.freeze({ lower: round(Math.max(0, center - margin) * 100), upper: round(Math.min(1, center + margin) * 100) });
}

export async function buildSignalPerformanceReadModel(repository: SignalPerformanceRepository, ownerId: string, query: PerformanceQuery = {}): Promise<SignalPerformanceReadModel> {
  if (!query.source) throw new Error('PERFORMANCE_SOURCE_REQUIRED');
  const signals = (await repository.listSignals(ownerId)).filter((event) => matches(event, query));
  const signalIds = new Set(signals.map((event) => event.signalId));
  let outcomes = (await repository.listOutcomes(ownerId)).filter((outcome) => signalIds.has(outcome.signalId) && (!query.source || outcome.source === query.source));
  if (query.recentPolicy) { if (!nonEmpty(query.recentPolicy.version)) throw new Error('RECENT_POLICY_VERSION_REQUIRED'); const since = parseTime(query.recentPolicy.since, 'RECENT_POLICY_SINCE_INVALID'); outcomes = outcomes.filter((row) => parseTime(row.resolvedAt, 'SIGNAL_OUTCOME_RESOLVED_TIME_INVALID') >= since); }
  const minimum = query.minimumSampleSize ?? DEFAULT_MINIMUM_SAMPLE_SIZE;
  if (!Number.isInteger(minimum) || minimum <= 0) throw new Error('MINIMUM_SAMPLE_SIZE_INVALID');
  const wins = outcomes.filter((x) => x.outcome === 'WIN').length; const losses = outcomes.filter((x) => x.outcome === 'LOSS').length;
  const neutral = outcomes.filter((x) => x.outcome === 'NEUTRAL').length; const expired = outcomes.filter((x) => x.outcome === 'EXPIRED').length;
  const decisive = wins + losses; const ready = outcomes.length >= minimum; const display = <T>(v: T) => ready ? v : null;
  const netReturns = outcomes.map((x) => x.netReturnPercent).filter((x): x is number => x != null); const grossReturns = outcomes.map((x) => x.grossReturnPercent).filter((x): x is number => x != null);
  const winReturns = netReturns.filter((x) => x > 0); const lossReturns = netReturns.filter((x) => x < 0); const grossProfit = winReturns.reduce((a, b) => a + b, 0); const grossLoss = Math.abs(lossReturns.reduce((a, b) => a + b, 0));
  const tpKnown = outcomes.filter((x) => x.targetBeforeStop != null); const mfe = outcomes.map((x) => x.mfePercent).filter((x): x is number => x != null); const mae = outcomes.map((x) => x.maePercent).filter((x): x is number => x != null);
  const resolvedIds = new Set(outcomes.map((x) => x.signalId));
  return Object.freeze({
    source: query.source, evidenceState: ready ? 'EVIDENCED' : outcomes.length ? 'PARTIAL' : 'INSUFFICIENT_SAMPLE', minimumSampleSize: minimum,
    totalSignals: signals.length, resolvedSignals: resolvedIds.size, unresolvedSignals: signals.length - resolvedIds.size,
    wins, losses, neutral, expired, sampleSize: outcomes.length,
    hitRate: display(decisive ? round(wins / decisive * 100) : null), hitRateWilson95: display(wilson(wins, decisive)),
    tpBeforeSlRate: display(tpKnown.length ? round(tpKnown.filter((x) => x.targetBeforeStop).length / tpKnown.length * 100) : null),
    netProfitableRate: display(netReturns.length ? round(netReturns.filter((x) => x > 0).length / netReturns.length * 100) : null),
    averageGrossReturn: display(mean(grossReturns) == null ? null : round(mean(grossReturns)!)), averageNetReturn: display(mean(netReturns) == null ? null : round(mean(netReturns)!)), medianNetReturn: display(median(netReturns) == null ? null : round(median(netReturns)!)),
    averageWin: display(mean(winReturns) == null ? null : round(mean(winReturns)!)), averageLoss: display(mean(lossReturns) == null ? null : round(mean(lossReturns)!)),
    payoffRatio: display(winReturns.length && lossReturns.length ? round(mean(winReturns)! / Math.abs(mean(lossReturns)!)) : null), expectancy: display(mean(netReturns) == null ? null : round(mean(netReturns)!)), profitFactor: display(grossLoss > 0 ? round(grossProfit / grossLoss) : null),
    averageMfe: display(mean(mfe) == null ? null : round(mean(mfe)!)), averageMae: display(mean(mae) == null ? null : round(mean(mae)!)),
    totalCosts: display(outcomes.every((x) => x.totalCost != null) ? round(outcomes.reduce((sum, x) => sum + x.totalCost!, 0)) : null), averageHoldingDurationMs: display(outcomes.length ? round(outcomes.reduce((sum, x) => sum + x.holdingDurationMs, 0) / outcomes.length) : null),
    recentPolicyVersion: query.recentPolicy?.version ?? null, executionAuthority: SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY,
  });
}

function payload<T>(record: { payload: Record<string, unknown> } | null, schema: string): T | null { if (!record || record.payload.schemaVersion !== schema) return null; return record.payload as T; }

export class PaperJournalSignalPerformanceRepository implements SignalPerformanceRepository {
  constructor(private readonly repository: PaperJournalRepository, private readonly ownerId: string) { if (!nonEmpty(ownerId)) throw new Error('SIGNAL_PERFORMANCE_OWNER_REQUIRED'); }
  private recordId(kind: 'event' | 'outcome', id: string) { return `signal-performance:${kind}:${id}`; }
  async getSignal(ownerId: string, signalId: string) { this.owner(ownerId); return payload<PersistentSignalEvent>(await this.repository.getRecord(ownerId, 'journal', this.recordId('event', signalId)), 'signal-performance-event-v1'); }
  async insertSignal(event: PersistentSignalEvent) { this.owner(event.ownerId); await this.upsert(this.recordId('event', event.signalId), event.createdAt, event as unknown as Record<string, unknown>); }
  async getOutcome(ownerId: string, outcomeId: string) { this.owner(ownerId); return payload<PersistentSignalOutcome>(await this.repository.getRecord(ownerId, 'journal', this.recordId('outcome', outcomeId)), 'signal-performance-outcome-v1'); }
  async insertOutcome(outcome: PersistentSignalOutcome) { this.owner(outcome.ownerId); await this.upsert(this.recordId('outcome', outcome.outcomeId), outcome.resolvedAt, outcome as unknown as Record<string, unknown>); }
  async listSignals(ownerId: string) { this.owner(ownerId); return (await this.repository.listSnapshot(ownerId)).map((r) => payload<PersistentSignalEvent>(r, 'signal-performance-event-v1')).filter((x): x is PersistentSignalEvent => x != null); }
  async listOutcomes(ownerId: string) { this.owner(ownerId); return (await this.repository.listSnapshot(ownerId)).map((r) => payload<PersistentSignalOutcome>(r, 'signal-performance-outcome-v1')).filter((x): x is PersistentSignalOutcome => x != null); }
  private owner(ownerId: string) { if (ownerId !== this.ownerId) throw new Error('SIGNAL_PERFORMANCE_USER_ISOLATION_VIOLATION'); }
  private async upsert(id: string, timestamp: string, payloadValue: Record<string, unknown>) { const record: PaperJournalSyncRecord = { kind: 'journal', id, version: 1, updatedAt: new Date(timestamp).toISOString(), deletedAt: null, payload: structuredClone(payloadValue) }; await this.repository.upsertRecord(this.ownerId, record, new Date(timestamp).toISOString()); }
}

export function profitFirstPerformanceEvidence(model: SignalPerformanceReadModel) {
  if (model.sampleSize === 0) return Object.freeze({ status: 'NOT_EVIDENCED' as const, sampleSize: 0, profitProbability: null, expectedNetEdge: null });
  if (model.evidenceState !== 'EVIDENCED') return Object.freeze({ status: 'INSUFFICIENT_SAMPLE' as const, sampleSize: model.sampleSize, profitProbability: null, expectedNetEdge: null });
  return Object.freeze({ status: 'EVIDENCED' as const, sampleSize: model.sampleSize, profitProbability: model.netProfitableRate, expectedNetEdge: model.expectancy });
}

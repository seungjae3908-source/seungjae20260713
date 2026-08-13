import {
  calculateSignalPerformanceStatistics,
  createImmutableSignalSnapshot,
  evaluateSignalOutcome,
  signalPerformanceDimension,
  type PerformanceDimension,
  type SignalOutcomeBar,
  type SignalOutcomeEvaluation,
  type SignalPerformanceStatistics,
  type SignalSnapshot,
  type SignalSnapshotInput,
} from './signal-performance-learning.service';
import {
  totalTradingCostPercent,
  type ProfitEvidence,
  type TradingCostPolicy,
} from './profit-first-signal.service';

export interface ProfitFirstOutcomeEvaluation extends SignalOutcomeEvaluation {
  targetBeforeStop: boolean | null;
  grossReturnPercent: number | null;
  netReturnPercent: number | null;
  tradingCostPercent: number;
  costPolicyId: string;
}

export interface ProfitFirstPerformanceRecord {
  snapshot: SignalSnapshot;
  outcome: ProfitFirstOutcomeEvaluation;
}

export interface ProfitFirstPerformanceAggregate {
  dimension: PerformanceDimension;
  statistics: SignalPerformanceStatistics;
  executionAuthority: 'NONE';
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function directionSign(direction: SignalSnapshot['direction']): 1 | -1 {
  return direction === 'BUY' || direction === 'LONG' ? 1 : -1;
}

function directionalReturn(entry: number, price: number, direction: SignalSnapshot['direction']): number {
  return ((price - entry) / entry) * 100 * directionSign(direction);
}

export function createProfitFirstRuntimeSnapshot(input: SignalSnapshotInput, evidence: ProfitEvidence): SignalSnapshot {
  if (input.market !== evidence.market) throw new Error('Profit evidence market mismatch');
  if (input.strategyHorizon !== evidence.strategyHorizon) throw new Error('Profit evidence strategy mismatch');
  if (input.direction !== evidence.direction) throw new Error('Profit evidence direction mismatch');
  if (input.strategyProfileVersion !== evidence.strategyVersion) throw new Error('Profit evidence strategy version mismatch');
  return createImmutableSignalSnapshot({
    ...input,
    profitEvidenceStatus: evidence.status,
    profitProbability: evidence.profitProbability,
    targetBeforeStopProbability: evidence.targetBeforeStopProbability,
    lossProbability: evidence.lossProbability,
    expectedGrossReturn: evidence.expectedGrossReturn,
    expectedNetReturn: evidence.expectedNetReturn,
    expectedLoss: evidence.expectedLoss,
    expectedValue: evidence.expectedValue,
    profitSampleSize: evidence.sampleSize,
    profitConfidenceInterval: evidence.confidenceInterval == null
      ? null
      : [evidence.confidenceInterval.lowerPercent, evidence.confidenceInterval.upperPercent],
    tradingCostPolicyId: evidence.costPolicyId,
  });
}

export function trackProfitFirstOutcome(input: {
  snapshot: SignalSnapshot;
  bars: readonly SignalOutcomeBar[];
  evaluationHorizon: string;
  evaluatedAt: string;
  costPolicy: TradingCostPolicy;
  neutralThresholdPercent?: number;
  expiredWhenNoDecisiveHit?: boolean;
}): ProfitFirstOutcomeEvaluation {
  if (input.costPolicy.market !== input.snapshot.market) throw new Error('Trading cost policy market mismatch');
  const base = evaluateSignalOutcome({
    snapshot: input.snapshot,
    bars: input.bars,
    evaluationHorizon: input.evaluationHorizon,
    evaluatedAt: input.evaluatedAt,
    neutralThresholdPercent: input.neutralThresholdPercent,
    expiredWhenNoDecisiveHit: input.expiredWhenNoDecisiveHit,
  });
  const tradingCostPercent = totalTradingCostPercent(input.costPolicy);
  let grossReturnPercent = base.returnPercent;
  if (base.stopLossHit && input.snapshot.stopLoss != null) {
    grossReturnPercent = directionalReturn(input.snapshot.entryPrice, input.snapshot.stopLoss, input.snapshot.direction);
  } else if (base.target1Hit && input.snapshot.target1 != null) {
    grossReturnPercent = directionalReturn(input.snapshot.entryPrice, input.snapshot.target1, input.snapshot.direction);
  }
  const netReturnPercent = grossReturnPercent == null ? null : round(grossReturnPercent - tradingCostPercent);
  return Object.freeze({
    ...base,
    targetBeforeStop: base.target1Hit ? true : base.stopLossHit ? false : null,
    grossReturnPercent: grossReturnPercent == null ? null : round(grossReturnPercent),
    netReturnPercent,
    tradingCostPercent,
    costPolicyId: input.costPolicy.id,
  });
}

function dimensionKey(dimension: PerformanceDimension): string {
  return JSON.stringify([
    dimension.market,
    dimension.horizon,
    dimension.direction,
    dimension.timeframe,
    dimension.marketRegime,
    dimension.strategyProfileVersion,
  ]);
}

export function aggregateProfitFirstPerformance(
  records: readonly ProfitFirstPerformanceRecord[],
  minimumSampleSize = 30,
): readonly ProfitFirstPerformanceAggregate[] {
  const groups = new Map<string, { dimension: PerformanceDimension; outcomes: SignalOutcomeEvaluation[] }>();
  for (const record of records) {
    const dimension = signalPerformanceDimension(record.snapshot);
    const key = dimensionKey(dimension);
    const group = groups.get(key) ?? { dimension, outcomes: [] };
    group.outcomes.push({ ...record.outcome, returnPercent: record.outcome.netReturnPercent });
    groups.set(key, group);
  }
  return Object.freeze([...groups.values()].map((group) => Object.freeze({
    dimension: group.dimension,
    statistics: calculateSignalPerformanceStatistics(group.outcomes, minimumSampleSize),
    executionAuthority: 'NONE' as const,
  })));
}

export class ProfitFirstRuntimeLedger {
  readonly #snapshots = new Map<string, SignalSnapshot>();
  readonly #records: ProfitFirstPerformanceRecord[] = [];

  recordExposure(input: SignalSnapshotInput, evidence: ProfitEvidence): SignalSnapshot {
    const snapshot = createProfitFirstRuntimeSnapshot(input, evidence);
    if (this.#snapshots.has(snapshot.signalId)) throw new Error(`Duplicate signal exposure: ${snapshot.signalId}`);
    this.#snapshots.set(snapshot.signalId, snapshot);
    return snapshot;
  }

  recordOutcome(input: {
    signalId: string;
    bars: readonly SignalOutcomeBar[];
    evaluationHorizon: string;
    evaluatedAt: string;
    costPolicy: TradingCostPolicy;
    neutralThresholdPercent?: number;
    expiredWhenNoDecisiveHit?: boolean;
  }): ProfitFirstOutcomeEvaluation {
    const snapshot = this.#snapshots.get(input.signalId);
    if (!snapshot) throw new Error(`Unknown signal exposure: ${input.signalId}`);
    const outcome = trackProfitFirstOutcome({ snapshot, ...input });
    this.#records.push({ snapshot, outcome });
    return outcome;
  }

  performance(minimumSampleSize = 30): readonly ProfitFirstPerformanceAggregate[] {
    return aggregateProfitFirstPerformance(this.#records, minimumSampleSize);
  }

  snapshot(signalId: string): SignalSnapshot | null {
    return this.#snapshots.get(signalId) ?? null;
  }

  records(): readonly ProfitFirstPerformanceRecord[] {
    return Object.freeze([...this.#records]);
  }
}

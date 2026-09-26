export type SignalPerformanceMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type SignalPerformanceHorizon = 'SCALP' | 'SWING' | 'POSITION';
export type SignalPerformanceDirection = 'BUY' | 'SELL' | 'LONG' | 'SHORT';
export type SignalOutcomeStatus = 'WIN' | 'LOSS' | 'NEUTRAL' | 'EXPIRED';
export type SignalPerformanceSampleStatus = 'READY' | 'INSUFFICIENT_SAMPLE';
export type SignalLearningStage = 'MEASURE_ONLY' | 'RECOMMENDED_WEIGHT' | 'SHADOW_WEIGHT' | 'VALIDATED_WEIGHT';
export type SignalPerformanceSource = 'BACKTEST' | 'PAPER' | 'SHADOW' | 'LIVE_RECOMMENDATION';
export type SignalMarketRegime = 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS' | 'HIGH_VOL' | 'LOW_VOL' | 'UNKNOWN';

export const SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY = 'NONE' as const;
export const DEFAULT_MINIMUM_SAMPLE_SIZE = 30;

export interface SignalSnapshotInput {
  signalId: string;
  timestamp: string;
  market: SignalPerformanceMarket;
  symbol: string;
  symbolName: string | null;
  strategyHorizon: SignalPerformanceHorizon;
  direction: SignalPerformanceDirection;
  signalScore: number;
  displayConfidence: number | null;
  referencePrice: number;
  entryPrice: number;
  stopLoss: number | null;
  target1: number | null;
  target2: number | null;
  riskReward: number | null;
  timeframes: readonly string[];
  strategyProfileVersion: string;
  indicatorSnapshot: Readonly<Record<string, unknown>>;
  indicatorScores: Readonly<Record<string, number | null>>;
  patternSnapshot: Readonly<Record<string, unknown>>;
  volumeContext: Readonly<Record<string, unknown>>;
  volatilityContext: Readonly<Record<string, unknown>>;
  trendContext: Readonly<Record<string, unknown>>;
  marketRegime: SignalMarketRegime;
  liquidityContext: Readonly<Record<string, unknown>>;
  aiValidatorResult: Readonly<Record<string, unknown>> | null;
  riskEngineResult: Readonly<Record<string, unknown>> | null;
  dataProvenance: readonly string[];
  dataTimestamp: string;
}

export type SignalSnapshot = Readonly<SignalSnapshotInput> & Readonly<{
  immutable: true;
  executionAuthority: 'NONE';
}>;

export interface SignalOutcomeBar {
  timestamp: string;
  high: number;
  low: number;
  close: number;
}

export interface SignalOutcomeEvaluation {
  signalId: string;
  evaluationHorizon: string;
  evaluatedAt: string;
  returnPercent: number | null;
  mfePercent: number | null;
  maePercent: number | null;
  target1Hit: boolean;
  target2Hit: boolean;
  stopLossHit: boolean;
  timeToTargetMs: number | null;
  timeToStopMs: number | null;
  outcome: SignalOutcomeStatus;
  usableBars: number;
  rejectedFutureBars: number;
  conservativeIntrabarConflict: boolean;
  executionAuthority: 'NONE';
}

export interface SignalPerformanceStatistics {
  sampleStatus: SignalPerformanceSampleStatus;
  minimumSampleSize: number;
  sampleSize: number;
  wins: number;
  losses: number;
  neutral: number;
  expired: number;
  displayEligible: boolean;
  hitRate: number | null;
  averageReturn: number | null;
  medianReturn: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  payoffRatio: number | null;
  expectedValue: number | null;
  profitFactor: number | null;
  maxDrawdown: number | null;
  averageMfe: number | null;
  averageMae: number | null;
  target1HitRate: number | null;
  target2HitRate: number | null;
  stopHitRate: number | null;
  downsideDeviation: number | null;
  sharpeLike: number | null;
  sortinoLike: number | null;
  executionAuthority: 'NONE';
}

export interface PerformanceDimension {
  market: SignalPerformanceMarket;
  horizon: SignalPerformanceHorizon;
  direction: SignalPerformanceDirection;
  timeframe: string;
  marketRegime: SignalMarketRegime;
  strategyProfileVersion: string;
  signalScoreBucket: string;
  confidenceBucket: string;
}

export interface StagePerformanceInput {
  source: SignalPerformanceSource;
  strategyProfileVersion: string;
  sampleSize: number;
  hitRate: number | null;
  expectedValue: number | null;
  averageReturn: number | null;
}

export interface StagePerformanceComparison {
  strategyProfileVersion: string;
  sources: Readonly<Record<SignalPerformanceSource, StagePerformanceInput | null>>;
  liveVsBacktestHitRateGap: number | null;
  shadowVsBacktestHitRateGap: number | null;
  paperVsBacktestHitRateGap: number | null;
  executionAuthority: 'NONE';
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ISO timestamp: ${value}`);
  return parsed;
}

function validPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function cloneJson<T>(value: T): T {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function standardDeviation(values: readonly number[], downsideOnly = false): number | null {
  const candidate = downsideOnly ? values.filter((value) => value < 0) : [...values];
  if (!candidate.length) return null;
  if (downsideOnly) {
    return Math.sqrt(candidate.reduce((sum, value) => sum + value ** 2, 0) / candidate.length);
  }
  const avg = mean(candidate) ?? 0;
  return Math.sqrt(candidate.reduce((sum, value) => sum + (value - avg) ** 2, 0) / candidate.length);
}

function directionSign(direction: SignalPerformanceDirection): 1 | -1 {
  return direction === 'BUY' || direction === 'LONG' ? 1 : -1;
}

function directionalReturn(entry: number, price: number, direction: SignalPerformanceDirection): number {
  return ((price - entry) / entry) * 100 * directionSign(direction);
}

function scoreBucket(value: number): string {
  if (value >= 90) return '90+';
  if (value >= 80) return '80-89';
  if (value >= 70) return '70-79';
  if (value >= 60) return '60-69';
  return '<60';
}

function confidenceBucket(value: number | null): string {
  if (value == null) return 'UNKNOWN';
  if (value >= 90) return '90+';
  if (value >= 80) return '80-89';
  if (value >= 70) return '70-79';
  if (value >= 60) return '60-69';
  return '<60';
}

export function createImmutableSignalSnapshot(input: SignalSnapshotInput): SignalSnapshot {
  if (!input.signalId.trim()) throw new Error('signalId is required');
  if (!input.symbol.trim()) throw new Error('symbol is required');
  if (!validPrice(input.referencePrice) || !validPrice(input.entryPrice)) throw new Error('referencePrice and entryPrice must be positive');
  if (input.stopLoss != null && !validPrice(input.stopLoss)) throw new Error('stopLoss must be positive');
  if (input.target1 != null && !validPrice(input.target1)) throw new Error('target1 must be positive');
  if (input.target2 != null && !validPrice(input.target2)) throw new Error('target2 must be positive');
  const timestamp = parseTime(input.timestamp);
  const dataTimestamp = parseTime(input.dataTimestamp);
  if (dataTimestamp > timestamp) throw new Error('dataTimestamp cannot be later than signal timestamp (look-ahead guard)');
  const snapshot = {
    ...cloneJson(input),
    immutable: true as const,
    executionAuthority: SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY,
  };
  return deepFreeze(snapshot);
}

function barHitsTarget(bar: SignalOutcomeBar, target: number, direction: SignalPerformanceDirection): boolean {
  return directionSign(direction) === 1 ? bar.high >= target : bar.low <= target;
}

function barHitsStop(bar: SignalOutcomeBar, stop: number, direction: SignalPerformanceDirection): boolean {
  return directionSign(direction) === 1 ? bar.low <= stop : bar.high >= stop;
}

export function evaluateSignalOutcome(input: {
  snapshot: SignalSnapshot;
  bars: readonly SignalOutcomeBar[];
  evaluationHorizon: string;
  evaluatedAt: string;
  neutralThresholdPercent?: number;
  expiredWhenNoDecisiveHit?: boolean;
}): SignalOutcomeEvaluation {
  const signalTime = parseTime(input.snapshot.timestamp);
  const dataTime = parseTime(input.snapshot.dataTimestamp);
  const evaluatedAt = parseTime(input.evaluatedAt);
  if (evaluatedAt < signalTime) throw new Error('evaluatedAt cannot precede the signal timestamp');
  const floorTime = Math.max(signalTime, dataTime);
  let rejectedFutureBars = 0;
  const bars = input.bars
    .filter((bar) => {
      const time = parseTime(bar.timestamp);
      if (time <= floorTime) return false;
      if (time > evaluatedAt) {
        rejectedFutureBars += 1;
        return false;
      }
      return validPrice(bar.high) && validPrice(bar.low) && validPrice(bar.close) && bar.high >= bar.low;
    })
    .sort((a, b) => parseTime(a.timestamp) - parseTime(b.timestamp));

  const entry = input.snapshot.entryPrice;
  let maxFavorable = Number.NEGATIVE_INFINITY;
  let maxAdverse = Number.POSITIVE_INFINITY;
  let target1Hit = false;
  let target2Hit = false;
  let stopLossHit = false;
  let timeToTargetMs: number | null = null;
  let timeToStopMs: number | null = null;
  let conservativeIntrabarConflict = false;
  let decisiveOutcome: SignalOutcomeStatus | null = null;

  for (const bar of bars) {
    const favorablePrice = directionSign(input.snapshot.direction) === 1 ? bar.high : bar.low;
    const adversePrice = directionSign(input.snapshot.direction) === 1 ? bar.low : bar.high;
    maxFavorable = Math.max(maxFavorable, directionalReturn(entry, favorablePrice, input.snapshot.direction));
    maxAdverse = Math.min(maxAdverse, directionalReturn(entry, adversePrice, input.snapshot.direction));

    const stopHit = input.snapshot.stopLoss != null && barHitsStop(bar, input.snapshot.stopLoss, input.snapshot.direction);
    const t1Hit = input.snapshot.target1 != null && barHitsTarget(bar, input.snapshot.target1, input.snapshot.direction);
    const t2Hit = input.snapshot.target2 != null && barHitsTarget(bar, input.snapshot.target2, input.snapshot.direction);
    const barTime = parseTime(bar.timestamp);

    if (stopHit && (t1Hit || t2Hit) && decisiveOutcome == null) {
      conservativeIntrabarConflict = true;
      stopLossHit = true;
      timeToStopMs = barTime - signalTime;
      decisiveOutcome = 'LOSS';
      break;
    }
    if (stopHit && decisiveOutcome == null) {
      stopLossHit = true;
      timeToStopMs = barTime - signalTime;
      decisiveOutcome = 'LOSS';
      break;
    }
    if (t1Hit) {
      target1Hit = true;
      if (timeToTargetMs == null) timeToTargetMs = barTime - signalTime;
      if (decisiveOutcome == null) decisiveOutcome = 'WIN';
    }
    if (t2Hit) {
      target2Hit = true;
      if (timeToTargetMs == null) timeToTargetMs = barTime - signalTime;
      if (decisiveOutcome == null) decisiveOutcome = 'WIN';
    }
  }

  const finalClose = bars.length ? bars[bars.length - 1]!.close : null;
  const returnPercent = finalClose == null ? null : directionalReturn(entry, finalClose, input.snapshot.direction);
  const neutralThreshold = Math.max(0, input.neutralThresholdPercent ?? 0.1);
  let outcome: SignalOutcomeStatus;
  if (decisiveOutcome != null) outcome = decisiveOutcome;
  else if (input.expiredWhenNoDecisiveHit) outcome = 'EXPIRED';
  else if (returnPercent == null || Math.abs(returnPercent) <= neutralThreshold) outcome = 'NEUTRAL';
  else outcome = returnPercent > 0 ? 'WIN' : 'LOSS';

  return {
    signalId: input.snapshot.signalId,
    evaluationHorizon: input.evaluationHorizon,
    evaluatedAt: input.evaluatedAt,
    returnPercent: returnPercent == null ? null : round(returnPercent),
    mfePercent: maxFavorable === Number.NEGATIVE_INFINITY ? null : round(maxFavorable),
    maePercent: maxAdverse === Number.POSITIVE_INFINITY ? null : round(maxAdverse),
    target1Hit,
    target2Hit,
    stopLossHit,
    timeToTargetMs,
    timeToStopMs,
    outcome,
    usableBars: bars.length,
    rejectedFutureBars,
    conservativeIntrabarConflict,
    executionAuthority: SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY,
  };
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? null;
}

function maxDrawdown(returns: readonly number[]): number | null {
  if (!returns.length) return null;
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const value of returns) {
    equity *= 1 + value / 100;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, ((equity - peak) / peak) * 100);
  }
  return round(worst);
}

export function calculateSignalPerformanceStatistics(
  outcomes: readonly SignalOutcomeEvaluation[],
  minimumSampleSize = DEFAULT_MINIMUM_SAMPLE_SIZE,
): SignalPerformanceStatistics {
  const completed = outcomes.filter((item) => item.returnPercent != null);
  const returns = completed.map((item) => item.returnPercent as number);
  const winners = outcomes.filter((item) => item.outcome === 'WIN');
  const losers = outcomes.filter((item) => item.outcome === 'LOSS');
  const neutral = outcomes.filter((item) => item.outcome === 'NEUTRAL').length;
  const expired = outcomes.filter((item) => item.outcome === 'EXPIRED').length;
  const winReturns = winners.map((item) => item.returnPercent).filter((value): value is number => value != null && value > 0);
  const lossReturns = losers.map((item) => item.returnPercent).filter((value): value is number => value != null && value < 0);
  const averageWin = mean(winReturns);
  const averageLoss = mean(lossReturns);
  const grossProfit = winReturns.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(lossReturns.reduce((sum, value) => sum + value, 0));
  const avg = mean(returns);
  const deviation = standardDeviation(returns);
  const downsideDeviation = standardDeviation(returns, true);
  const displayEligible = outcomes.length >= Math.max(1, minimumSampleSize);
  const display = <T>(value: T): T | null => displayEligible ? value : null;
  const decisive = winners.length + losers.length;
  const target1Hits = outcomes.filter((item) => item.target1Hit).length;
  const target2Hits = outcomes.filter((item) => item.target2Hit).length;
  const stopHits = outcomes.filter((item) => item.stopLossHit).length;
  const mfeValues = outcomes.map((item) => item.mfePercent).filter((value): value is number => value != null);
  const maeValues = outcomes.map((item) => item.maePercent).filter((value): value is number => value != null);

  return {
    sampleStatus: displayEligible ? 'READY' : 'INSUFFICIENT_SAMPLE',
    minimumSampleSize,
    sampleSize: outcomes.length,
    wins: winners.length,
    losses: losers.length,
    neutral,
    expired,
    displayEligible,
    hitRate: display(decisive ? round(winners.length / decisive * 100) : null),
    averageReturn: display(avg == null ? null : round(avg)),
    medianReturn: display(median(returns) == null ? null : round(median(returns) as number)),
    averageWin: display(averageWin == null ? null : round(averageWin)),
    averageLoss: display(averageLoss == null ? null : round(averageLoss)),
    payoffRatio: display(averageWin != null && averageLoss != null && averageLoss !== 0 ? round(averageWin / Math.abs(averageLoss)) : null),
    expectedValue: display(avg == null ? null : round(avg)),
    profitFactor: display(grossLoss > 0 ? round(grossProfit / grossLoss) : null),
    maxDrawdown: display(maxDrawdown(returns)),
    averageMfe: display(mean(mfeValues) == null ? null : round(mean(mfeValues) as number)),
    averageMae: display(mean(maeValues) == null ? null : round(mean(maeValues) as number)),
    target1HitRate: display(outcomes.length ? round(target1Hits / outcomes.length * 100) : null),
    target2HitRate: display(outcomes.length ? round(target2Hits / outcomes.length * 100) : null),
    stopHitRate: display(outcomes.length ? round(stopHits / outcomes.length * 100) : null),
    downsideDeviation: display(downsideDeviation == null ? null : round(downsideDeviation)),
    sharpeLike: display(avg != null && deviation != null && deviation > 0 ? round((avg / deviation) * Math.sqrt(Math.max(1, returns.length))) : null),
    sortinoLike: display(avg != null && downsideDeviation != null && downsideDeviation > 0 ? round((avg / downsideDeviation) * Math.sqrt(Math.max(1, returns.length))) : null),
    executionAuthority: SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY,
  };
}

export function signalPerformanceDimension(snapshot: SignalSnapshot, timeframe?: string): PerformanceDimension {
  return {
    market: snapshot.market,
    horizon: snapshot.strategyHorizon,
    direction: snapshot.direction,
    timeframe: timeframe ?? snapshot.timeframes[0] ?? 'UNKNOWN',
    marketRegime: snapshot.marketRegime,
    strategyProfileVersion: snapshot.strategyProfileVersion,
    signalScoreBucket: scoreBucket(snapshot.signalScore),
    confidenceBucket: confidenceBucket(snapshot.displayConfidence),
  };
}

export function buildStagePerformanceComparison(
  strategyProfileVersion: string,
  inputs: readonly StagePerformanceInput[],
): StagePerformanceComparison {
  const sources: Record<SignalPerformanceSource, StagePerformanceInput | null> = {
    BACKTEST: null,
    PAPER: null,
    SHADOW: null,
    LIVE_RECOMMENDATION: null,
  };
  for (const item of inputs) {
    if (item.strategyProfileVersion === strategyProfileVersion) sources[item.source] = { ...item };
  }
  const backtest = sources.BACKTEST?.hitRate ?? null;
  const gap = (source: SignalPerformanceSource): number | null => {
    const value = sources[source]?.hitRate ?? null;
    return backtest == null || value == null ? null : round(value - backtest);
  };
  return deepFreeze({
    strategyProfileVersion,
    sources,
    liveVsBacktestHitRateGap: gap('LIVE_RECOMMENDATION'),
    shadowVsBacktestHitRateGap: gap('SHADOW'),
    paperVsBacktestHitRateGap: gap('PAPER'),
    executionAuthority: SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY,
  });
}

export interface ConfidenceCalibrationBucket {
  bucket: string;
  sampleStatus: SignalPerformanceSampleStatus;
  sampleSize: number;
  statedAverageConfidence: number | null;
  observedHitRate: number | null;
}

export function calibrateSignalConfidence(
  observations: readonly { displayConfidence: number | null; success: boolean }[],
  minimumSampleSize = DEFAULT_MINIMUM_SAMPLE_SIZE,
): readonly ConfidenceCalibrationBucket[] {
  const grouped = new Map<string, Array<{ confidence: number; success: boolean }>>();
  for (const item of observations) {
    if (item.displayConfidence == null || !Number.isFinite(item.displayConfidence)) continue;
    const bucket = confidenceBucket(item.displayConfidence);
    const list = grouped.get(bucket) ?? [];
    list.push({ confidence: item.displayConfidence, success: item.success });
    grouped.set(bucket, list);
  }
  return Object.freeze([...grouped.entries()].map(([bucket, list]) => {
    const ready = list.length >= minimumSampleSize;
    return Object.freeze({
      bucket,
      sampleStatus: ready ? 'READY' as const : 'INSUFFICIENT_SAMPLE' as const,
      sampleSize: list.length,
      statedAverageConfidence: ready ? round(list.reduce((sum, item) => sum + item.confidence, 0) / list.length) : null,
      observedHitRate: ready ? round(list.filter((item) => item.success).length / list.length * 100) : null,
    });
  }));
}

export function nextLearningStage(current: SignalLearningStage): SignalLearningStage | null {
  if (current === 'MEASURE_ONLY') return 'RECOMMENDED_WEIGHT';
  if (current === 'RECOMMENDED_WEIGHT') return 'SHADOW_WEIGHT';
  if (current === 'SHADOW_WEIGHT') return 'VALIDATED_WEIGHT';
  return null;
}
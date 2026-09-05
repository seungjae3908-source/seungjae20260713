export type EvidenceCapitalSource = 'BACKTEST' | 'HOLDOUT' | 'FORWARD_PAPER' | 'FORWARD_SHADOW';
export type EvidenceStrategyHealth = 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'QUARANTINE';

export type EvidenceCapitalBlocker =
  | 'NON_FORWARD_EVIDENCE'
  | 'EXPECTANCY_NOT_POSITIVE'
  | 'PROFIT_FACTOR_NOT_ABOVE_ONE'
  | 'MDD_MISSING_OR_EXCESSIVE'
  | 'INSUFFICIENT_SETTLED_SAMPLES'
  | 'INSUFFICIENT_EFFECTIVE_SAMPLES'
  | 'INSUFFICIENT_REGIME_COVERAGE'
  | 'PREDICTION_COLLAPSE'
  | 'CHAMPION_NOT_VALIDATED'
  | 'STRATEGY_HEALTH_NOT_HEALTHY'
  | 'CALIBRATION_NOT_HEALTHY'
  | 'DATA_NOT_HEALTHY'
  | 'EXECUTION_NOT_FEASIBLE';

export type EvidenceCapitalInput = Readonly<{
  evidenceSource: EvidenceCapitalSource;
  afterCostExpectancyPercent: number | null;
  profitFactor: number | null;
  maximumDrawdownPercent: number | null;
  settledSampleSize: number;
  effectiveSampleSize: number;
  regimeCount: number;
  predictionCollapse: boolean;
  validatedChampion: boolean;
  strategyHealth: EvidenceStrategyHealth;
  calibrationHealthy: boolean;
  dataHealthy: boolean;
  executionFeasible: boolean;
}>;

export type EvidenceCapitalPolicy = Readonly<{
  minimumSettledSamples: number;
  minimumEffectiveSamples: number;
  minimumRegimes: number;
  maximumDrawdownPercent: number;
  maximumPaperCapitalWeight: number;
}>;

export const DEFAULT_EVIDENCE_CAPITAL_POLICY: EvidenceCapitalPolicy = Object.freeze({
  minimumSettledSamples: 100,
  minimumEffectiveSamples: 100,
  minimumRegimes: 3,
  maximumDrawdownPercent: 15,
  maximumPaperCapitalWeight: 0.25,
});

export type EvidenceCapitalDecision = Readonly<{
  status: 'INSUFFICIENT_EVIDENCE' | 'CAPITAL_ELIGIBLE_PAPER_ONLY';
  safeCapitalState: 'CASH_OR_NO_TRADE' | 'PAPER_CAPITAL_ELIGIBLE';
  blockers: readonly EvidenceCapitalBlocker[];
  paperCapitalWeight: number;
  liveCapitalWeight: 0;
  evidenceScore: number;
  liveTradingAllowed: false;
  privateTradingApiAllowed: false;
  orderAuthority: 'none';
}>;

export type AllocatorShadowPair = Readonly<{
  opportunityId: string;
  settled: boolean;
  baselineAfterCostReturnPercent: number | null;
  candidateAfterCostReturnPercent: number | null;
}>;

export type AllocatorShadowPolicy = Readonly<{
  minimumPairedSettledSamples: number;
  minimumIncrementalExpectancyPercent: number;
}>;

export const DEFAULT_ALLOCATOR_SHADOW_POLICY: AllocatorShadowPolicy = Object.freeze({
  minimumPairedSettledSamples: 100,
  minimumIncrementalExpectancyPercent: 0,
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isNumeric(value: number | null): value is number {
  return value != null && !Number.isNaN(value);
}

function addBlocker(blockers: EvidenceCapitalBlocker[], blocker: EvidenceCapitalBlocker): void {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function policyIsValid(policy: EvidenceCapitalPolicy): boolean {
  return Number.isInteger(policy.minimumSettledSamples)
    && policy.minimumSettledSamples > 0
    && Number.isInteger(policy.minimumEffectiveSamples)
    && policy.minimumEffectiveSamples > 0
    && Number.isInteger(policy.minimumRegimes)
    && policy.minimumRegimes > 0
    && Number.isFinite(policy.maximumDrawdownPercent)
    && policy.maximumDrawdownPercent > 0
    && Number.isFinite(policy.maximumPaperCapitalWeight)
    && policy.maximumPaperCapitalWeight > 0
    && policy.maximumPaperCapitalWeight <= 0.25;
}

/**
 * Converts already-settled scientific evidence into PAPER-only capital permission.
 * It is deliberately fail-closed: historical evidence, missing metrics, prediction
 * collapse, unhealthy strategy state or weak forward coverage always map to cash.
 * This function has no broker/exchange side effects and exposes no live authority.
 */
export function evaluateEvidenceWeightedCapital(
  input: EvidenceCapitalInput,
  policy: EvidenceCapitalPolicy = DEFAULT_EVIDENCE_CAPITAL_POLICY,
): EvidenceCapitalDecision {
  if (!policyIsValid(policy)) throw new Error('INVALID_EVIDENCE_CAPITAL_POLICY');

  const blockers: EvidenceCapitalBlocker[] = [];
  if (input.evidenceSource !== 'FORWARD_PAPER' && input.evidenceSource !== 'FORWARD_SHADOW') {
    addBlocker(blockers, 'NON_FORWARD_EVIDENCE');
  }
  if (!isNumeric(input.afterCostExpectancyPercent) || input.afterCostExpectancyPercent <= 0) {
    addBlocker(blockers, 'EXPECTANCY_NOT_POSITIVE');
  }
  if (!isNumeric(input.profitFactor) || input.profitFactor <= 1) {
    addBlocker(blockers, 'PROFIT_FACTOR_NOT_ABOVE_ONE');
  }
  if (!isNumeric(input.maximumDrawdownPercent)
    || !Number.isFinite(input.maximumDrawdownPercent)
    || input.maximumDrawdownPercent < 0
    || input.maximumDrawdownPercent > policy.maximumDrawdownPercent) {
    addBlocker(blockers, 'MDD_MISSING_OR_EXCESSIVE');
  }
  if (!positiveInteger(input.settledSampleSize) || input.settledSampleSize < policy.minimumSettledSamples) {
    addBlocker(blockers, 'INSUFFICIENT_SETTLED_SAMPLES');
  }
  if (!positiveInteger(input.effectiveSampleSize)
    || input.effectiveSampleSize < policy.minimumEffectiveSamples
    || input.effectiveSampleSize > input.settledSampleSize) {
    addBlocker(blockers, 'INSUFFICIENT_EFFECTIVE_SAMPLES');
  }
  if (!positiveInteger(input.regimeCount) || input.regimeCount < policy.minimumRegimes) {
    addBlocker(blockers, 'INSUFFICIENT_REGIME_COVERAGE');
  }
  if (input.predictionCollapse) addBlocker(blockers, 'PREDICTION_COLLAPSE');
  if (!input.validatedChampion) addBlocker(blockers, 'CHAMPION_NOT_VALIDATED');
  if (input.strategyHealth !== 'HEALTHY') addBlocker(blockers, 'STRATEGY_HEALTH_NOT_HEALTHY');
  if (!input.calibrationHealthy) addBlocker(blockers, 'CALIBRATION_NOT_HEALTHY');
  if (!input.dataHealthy) addBlocker(blockers, 'DATA_NOT_HEALTHY');
  if (!input.executionFeasible) addBlocker(blockers, 'EXECUTION_NOT_FEASIBLE');

  if (blockers.length > 0) {
    return Object.freeze({
      status: 'INSUFFICIENT_EVIDENCE',
      safeCapitalState: 'CASH_OR_NO_TRADE',
      blockers: Object.freeze(blockers),
      paperCapitalWeight: 0,
      liveCapitalWeight: 0,
      evidenceScore: 0,
      liveTradingAllowed: false,
      privateTradingApiAllowed: false,
      orderAuthority: 'none',
    });
  }

  const expectancyFactor = clamp((input.afterCostExpectancyPercent ?? 0) / 1, 0, 1);
  const profitFactor = input.profitFactor ?? 0;
  const profitFactorFactor = clamp((profitFactor - 1) / 1, 0, 1);
  const sampleFactor = clamp(input.effectiveSampleSize / (policy.minimumEffectiveSamples * 4), 0, 1);
  const regimeFactor = clamp(input.regimeCount / Math.max(policy.minimumRegimes * 2, 1), 0, 1);
  const drawdown = input.maximumDrawdownPercent ?? policy.maximumDrawdownPercent;
  const drawdownFactor = clamp(1 - drawdown / policy.maximumDrawdownPercent, 0, 1);
  const evidenceScore = Math.min(expectancyFactor, profitFactorFactor, sampleFactor, regimeFactor, drawdownFactor);
  const paperCapitalWeight = clamp(
    policy.maximumPaperCapitalWeight * Math.max(evidenceScore, 0.05),
    0,
    policy.maximumPaperCapitalWeight,
  );

  return Object.freeze({
    status: 'CAPITAL_ELIGIBLE_PAPER_ONLY',
    safeCapitalState: 'PAPER_CAPITAL_ELIGIBLE',
    blockers: Object.freeze([]),
    paperCapitalWeight,
    liveCapitalWeight: 0,
    evidenceScore,
    liveTradingAllowed: false,
    privateTradingApiAllowed: false,
    orderAuthority: 'none',
  });
}

function pairedSettledRows(pairs: readonly AllocatorShadowPair[]): AllocatorShadowPair[] {
  const seen = new Set<string>();
  const rows: AllocatorShadowPair[] = [];
  for (const pair of pairs) {
    if (!pair.settled || seen.has(pair.opportunityId)) continue;
    if (!pair.opportunityId.trim()) continue;
    if (!isNumeric(pair.baselineAfterCostReturnPercent) || !Number.isFinite(pair.baselineAfterCostReturnPercent)) continue;
    if (!isNumeric(pair.candidateAfterCostReturnPercent) || !Number.isFinite(pair.candidateAfterCostReturnPercent)) continue;
    seen.add(pair.opportunityId);
    rows.push(pair);
  }
  return rows;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function profitFactor(values: readonly number[]): number | null {
  const gains = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  if (losses === 0) return gains > 0 ? Number.POSITIVE_INFINITY : null;
  return gains / losses;
}

/**
 * Paired paper/shadow allocator league. Both allocators are scored on the same
 * settled opportunity IDs and after-cost returns. Promotion is PAPER-only and
 * cannot grant live/private trading authority.
 */
export function evaluateAllocatorShadowLeague(
  pairs: readonly AllocatorShadowPair[],
  policy: AllocatorShadowPolicy = DEFAULT_ALLOCATOR_SHADOW_POLICY,
) {
  if (!Number.isInteger(policy.minimumPairedSettledSamples)
    || policy.minimumPairedSettledSamples <= 0
    || !Number.isFinite(policy.minimumIncrementalExpectancyPercent)) {
    throw new Error('INVALID_ALLOCATOR_SHADOW_POLICY');
  }

  const rows = pairedSettledRows(pairs);
  const baselineReturns = rows.map((row) => row.baselineAfterCostReturnPercent as number);
  const candidateReturns = rows.map((row) => row.candidateAfterCostReturnPercent as number);
  const deltas = rows.map((row) => (row.candidateAfterCostReturnPercent as number) - (row.baselineAfterCostReturnPercent as number));
  const baselineExpectancyPercent = mean(baselineReturns);
  const candidateExpectancyPercent = mean(candidateReturns);
  const incrementalExpectancyPercent = mean(deltas);
  const candidateProfitFactor = profitFactor(candidateReturns);
  const sufficientSamples = rows.length >= policy.minimumPairedSettledSamples;
  const candidateAfterCostPositive = candidateExpectancyPercent > 0 && (candidateProfitFactor ?? 0) > 1;
  const candidateBeatsBaseline = incrementalExpectancyPercent > policy.minimumIncrementalExpectancyPercent;
  const promotionEligible = sufficientSamples && candidateAfterCostPositive && candidateBeatsBaseline;

  return Object.freeze({
    baselineAllocator: 'CASH_OR_EXISTING_POLICY' as const,
    candidateAllocator: 'EVIDENCE_WEIGHTED' as const,
    pairedSettledSampleSize: rows.length,
    baselineExpectancyPercent,
    candidateExpectancyPercent,
    incrementalExpectancyPercent,
    candidateProfitFactor,
    status: !sufficientSamples
      ? 'INSUFFICIENT_PAIRED_EVIDENCE' as const
      : promotionEligible
        ? 'PROMOTION_ELIGIBLE_PAPER_ONLY' as const
        : 'NO_PROMOTION' as const,
    promotionEligible,
    liveTradingAllowed: false as const,
    privateTradingApiAllowed: false as const,
    orderAuthority: 'none' as const,
  });
}

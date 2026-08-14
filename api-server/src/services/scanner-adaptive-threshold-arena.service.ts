export type AdaptiveThresholdGrade = 'S' | 'A' | 'B' | 'WATCH';

export type AdaptiveThresholdResearchStage =
  | 'DEVELOPMENT'
  | 'CALIBRATION'
  | 'OOS'
  | 'PURGED_WALK_FORWARD'
  | 'FINAL_HOLDOUT'
  | 'PAPER'
  | 'SHADOW';

export interface MinimalHardGate {
  dataQualityPassed: boolean;
  liquidityPassed: boolean;
  safetyPassed: boolean;
  reasons?: readonly string[];
}

export interface CounterfactualOutcome {
  /**
   * Stable ordering for replay. This must reflect point-in-time signal order and
   * must not be rewritten after outcomes are known.
   */
  sequence: number;
  /** True only after the outcome is resolved. Unresolved observations are excluded from performance metrics. */
  resolved: boolean;
  /**
   * Net change to total equity for this observation, expressed as a decimal.
   * Example: +0.01 means +1% of equity after commission/tax/spread/slippage/funding
   * and the research position-sizing rule have already been applied.
   */
  netEquityReturn: number | null;
}

export interface AdaptiveThresholdObservation {
  id: string;
  market: string;
  strategy: string;
  regime: string;
  /**
   * Threshold selection may only consume DEVELOPMENT/CALIBRATION observations.
   * OOS, walk-forward, final holdout, Paper, and Shadow are evaluation-only and
   * must never feed back into threshold selection.
   */
  stage: AdaptiveThresholdResearchStage;
  softScore: number;
  hardGate: MinimalHardGate;
  outcome?: CounterfactualOutcome;
}

export interface ThresholdResearchConstraints {
  maxDrawdownPercent: number;
  minimumResolvedTrades: number;
}

export interface ThresholdComparisonRow {
  threshold: number;
  hardGatePassCount: number;
  candidateCount: number;
  resolvedTradeCount: number;
  finalEquityKrw: number;
  netReturnPercent: number;
  maxDrawdownPercent: number;
  netProfitableRatePercent: number | null;
  badTradeAvoidedCount: number;
  goodTradeMissedCount: number;
  unresolvedSelectedCount: number;
  constraintPass: boolean;
}

export interface RegimeThresholdSelection {
  regime: string;
  status:
    | 'SELECTED'
    | 'INSUFFICIENT_SAMPLE'
    | 'NO_VALID_THRESHOLD'
    | 'NO_HARD_GATE_CANDIDATES'
    | 'INVALID_SELECTION_STAGE';
  selectedThreshold: number | null;
  selected: ThresholdComparisonRow | null;
  comparisons: ThresholdComparisonRow[];
  paretoThresholds: number[];
}

export interface AdaptiveThresholdResearchResult {
  initialCapitalKrw: number;
  thresholds: number[];
  byRegime: RegimeThresholdSelection[];
}

export interface AdaptiveThresholdGradePolicy {
  sMargin: number;
  aMargin: number;
  nearMissBand: number;
}

export interface AdaptiveThresholdDisplayCandidate extends AdaptiveThresholdObservation {
  grade: AdaptiveThresholdGrade;
  nearMiss: boolean;
  thresholdDistance: number;
  hardGatePassed: boolean;
}

const DEFAULT_INITIAL_CAPITAL_KRW = 1_000_000;
const THRESHOLD_SELECTION_STAGES = new Set<AdaptiveThresholdResearchStage>([
  'DEVELOPMENT',
  'CALIBRATION',
]);

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isThresholdSelectionStage(stage: AdaptiveThresholdResearchStage): boolean {
  return THRESHOLD_SELECTION_STAGES.has(stage);
}

export function passesMinimalHardGate(observation: AdaptiveThresholdObservation): boolean {
  return observation.hardGate.dataQualityPassed
    && observation.hardGate.liquidityPassed
    && observation.hardGate.safetyPassed
    && finite(observation.softScore);
}

function normalizeThresholds(thresholds: readonly number[]): number[] {
  return [...new Set(thresholds.filter(finite).map((value) => round(clamp(value, 0, 100), 4)))]
    .sort((left, right) => left - right);
}

function resolvedOutcomes(observations: readonly AdaptiveThresholdObservation[]): AdaptiveThresholdObservation[] {
  return observations
    .filter((item) => item.outcome?.resolved === true && finite(item.outcome?.netEquityReturn ?? Number.NaN))
    .filter((item) => (item.outcome?.netEquityReturn ?? -1) > -1)
    .sort((left, right) => (left.outcome?.sequence ?? 0) - (right.outcome?.sequence ?? 0)
      || left.id.localeCompare(right.id));
}

function equityMetrics(
  observations: readonly AdaptiveThresholdObservation[],
  initialCapitalKrw: number,
): Pick<ThresholdComparisonRow, 'finalEquityKrw' | 'netReturnPercent' | 'maxDrawdownPercent' | 'netProfitableRatePercent'> {
  let equity = initialCapitalKrw;
  let peak = initialCapitalKrw;
  let maxDrawdownPercent = 0;
  let wins = 0;
  const resolved = resolvedOutcomes(observations);

  for (const observation of resolved) {
    const netReturn = observation.outcome?.netEquityReturn ?? 0;
    equity *= 1 + netReturn;
    if (netReturn > 0) wins += 1;
    peak = Math.max(peak, equity);
    const drawdownPercent = peak > 0 ? (peak - equity) / peak * 100 : 100;
    maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdownPercent);
  }

  return {
    finalEquityKrw: Math.round(equity),
    netReturnPercent: round((equity / initialCapitalKrw - 1) * 100, 4),
    maxDrawdownPercent: round(maxDrawdownPercent, 4),
    netProfitableRatePercent: resolved.length ? round(wins / resolved.length * 100, 4) : null,
  };
}

export function compareAdaptiveThresholds(args: {
  observations: readonly AdaptiveThresholdObservation[];
  thresholds: readonly number[];
  initialCapitalKrw?: number;
  constraints: ThresholdResearchConstraints;
}): ThresholdComparisonRow[] {
  const initialCapitalKrw = finite(args.initialCapitalKrw ?? Number.NaN) && (args.initialCapitalKrw ?? 0) > 0
    ? Math.round(args.initialCapitalKrw ?? DEFAULT_INITIAL_CAPITAL_KRW)
    : DEFAULT_INITIAL_CAPITAL_KRW;
  const hardPassed = args.observations.filter(passesMinimalHardGate);

  return normalizeThresholds(args.thresholds).map((threshold) => {
    const selected = hardPassed.filter((item) => item.softScore >= threshold);
    const rejectedBySoftThreshold = hardPassed.filter((item) => item.softScore < threshold);
    const resolvedSelected = resolvedOutcomes(selected);
    const resolvedRejected = resolvedOutcomes(rejectedBySoftThreshold);
    const metrics = equityMetrics(selected, initialCapitalKrw);
    const goodTradeMissedCount = resolvedRejected.filter((item) => (item.outcome?.netEquityReturn ?? 0) > 0).length;
    const badTradeAvoidedCount = resolvedRejected.filter((item) => (item.outcome?.netEquityReturn ?? 0) < 0).length;

    return {
      threshold,
      hardGatePassCount: hardPassed.length,
      candidateCount: selected.length,
      resolvedTradeCount: resolvedSelected.length,
      unresolvedSelectedCount: selected.length - resolvedSelected.length,
      ...metrics,
      badTradeAvoidedCount,
      goodTradeMissedCount,
      constraintPass: resolvedSelected.length >= Math.max(1, args.constraints.minimumResolvedTrades)
        && metrics.maxDrawdownPercent <= Math.max(0, args.constraints.maxDrawdownPercent),
    };
  });
}

function dominates(left: ThresholdComparisonRow, right: ThresholdComparisonRow): boolean {
  const noWorse = left.finalEquityKrw >= right.finalEquityKrw
    && left.maxDrawdownPercent <= right.maxDrawdownPercent
    && left.goodTradeMissedCount <= right.goodTradeMissedCount;
  const strictlyBetter = left.finalEquityKrw > right.finalEquityKrw
    || left.maxDrawdownPercent < right.maxDrawdownPercent
    || left.goodTradeMissedCount < right.goodTradeMissedCount;
  return noWorse && strictlyBetter;
}

export function findThresholdParetoFrontier(rows: readonly ThresholdComparisonRow[]): number[] {
  return rows
    .filter((row) => !rows.some((other) => other.threshold !== row.threshold && dominates(other, row)))
    .map((row) => row.threshold)
    .sort((left, right) => left - right);
}

function chooseThreshold(rows: readonly ThresholdComparisonRow[]): ThresholdComparisonRow | null {
  const valid = rows.filter((row) => row.constraintPass);
  if (!valid.length) return null;

  return [...valid].sort((left, right) => right.finalEquityKrw - left.finalEquityKrw
    || left.maxDrawdownPercent - right.maxDrawdownPercent
    || left.goodTradeMissedCount - right.goodTradeMissedCount
    || right.resolvedTradeCount - left.resolvedTradeCount
    || right.threshold - left.threshold)[0] ?? null;
}

export function researchRegimeAdaptiveThresholds(args: {
  observations: readonly AdaptiveThresholdObservation[];
  thresholds: readonly number[];
  constraints: ThresholdResearchConstraints;
  initialCapitalKrw?: number;
}): AdaptiveThresholdResearchResult {
  const initialCapitalKrw = finite(args.initialCapitalKrw ?? Number.NaN) && (args.initialCapitalKrw ?? 0) > 0
    ? Math.round(args.initialCapitalKrw ?? DEFAULT_INITIAL_CAPITAL_KRW)
    : DEFAULT_INITIAL_CAPITAL_KRW;
  const thresholds = normalizeThresholds(args.thresholds);
  const regimes = [...new Set(args.observations.map((item) => item.regime).filter(Boolean))].sort();

  const byRegime = regimes.map((regime): RegimeThresholdSelection => {
    const observations = args.observations.filter((item) => item.regime === regime);
    if (observations.some((item) => !isThresholdSelectionStage(item.stage))) {
      return {
        regime,
        status: 'INVALID_SELECTION_STAGE',
        selectedThreshold: null,
        selected: null,
        comparisons: [],
        paretoThresholds: [],
      };
    }

    const hardGatePassCount = observations.filter(passesMinimalHardGate).length;
    const comparisons = compareAdaptiveThresholds({
      observations,
      thresholds,
      initialCapitalKrw,
      constraints: args.constraints,
    });
    const resolvedHardPassed = resolvedOutcomes(observations.filter(passesMinimalHardGate)).length;
    const selected = chooseThreshold(comparisons);

    let status: RegimeThresholdSelection['status'];
    if (hardGatePassCount === 0) status = 'NO_HARD_GATE_CANDIDATES';
    else if (resolvedHardPassed < Math.max(1, args.constraints.minimumResolvedTrades)) status = 'INSUFFICIENT_SAMPLE';
    else if (!selected) status = 'NO_VALID_THRESHOLD';
    else status = 'SELECTED';

    return {
      regime,
      status,
      selectedThreshold: status === 'SELECTED' ? selected?.threshold ?? null : null,
      selected: status === 'SELECTED' ? selected : null,
      comparisons,
      paretoThresholds: findThresholdParetoFrontier(comparisons),
    };
  });

  return { initialCapitalKrw, thresholds, byRegime };
}

export function classifyAdaptiveThresholdCandidates(args: {
  observations: readonly AdaptiveThresholdObservation[];
  threshold: number;
  policy: AdaptiveThresholdGradePolicy;
  limit?: number;
}): AdaptiveThresholdDisplayCandidate[] {
  const threshold = clamp(args.threshold, 0, 100);
  const sMargin = Math.max(args.policy.aMargin, args.policy.sMargin, 0);
  const aMargin = Math.max(0, Math.min(sMargin, args.policy.aMargin));
  const nearMissBand = Math.max(0, args.policy.nearMissBand);

  const candidates = args.observations
    .filter((item) => finite(item.softScore))
    .map((item): AdaptiveThresholdDisplayCandidate => {
      const hardGatePassed = passesMinimalHardGate(item);
      const thresholdDistance = round(item.softScore - threshold, 4);
      let grade: AdaptiveThresholdGrade = 'WATCH';
      if (hardGatePassed && thresholdDistance >= sMargin) grade = 'S';
      else if (hardGatePassed && thresholdDistance >= aMargin) grade = 'A';
      else if (hardGatePassed && thresholdDistance >= 0) grade = 'B';
      const nearMiss = hardGatePassed && thresholdDistance < 0 && thresholdDistance >= -nearMissBand;
      return { ...item, grade, nearMiss, thresholdDistance, hardGatePassed };
    })
    .filter((item) => item.hardGatePassed)
    .sort((left, right) => {
      const gradeRank: Record<AdaptiveThresholdGrade, number> = { S: 4, A: 3, B: 2, WATCH: 1 };
      return gradeRank[right.grade] - gradeRank[left.grade]
        || Number(right.nearMiss) - Number(left.nearMiss)
        || right.softScore - left.softScore
        || left.id.localeCompare(right.id);
    });

  const limit = args.limit == null ? candidates.length : Math.max(0, Math.floor(args.limit));
  return candidates.slice(0, limit);
}

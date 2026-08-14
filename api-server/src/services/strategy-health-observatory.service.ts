import type {
  CapitalLabEvidenceStatus,
  CapitalLabMarket,
} from '../modules/portfolio/autonomous-capital-lab';
import type { TelegramAlertInput } from './telegram-notification.service';

export type StrategyHealthStatus =
  | 'INSUFFICIENT_DATA'
  | 'HEALTHY'
  | 'WATCH'
  | 'DEGRADED'
  | 'CRITICAL';

export interface StrategyHealthBand {
  expectedValueBelow: number;
  profitFactorBelow: number;
  maxDrawdownAtOrAbove: number;
  hitRateGapAtOrBelow: number;
}

export interface StrategyHealthPolicy {
  version: string;
  minimumSampleSize: number;
  watch: StrategyHealthBand;
  degraded: StrategyHealthBand;
  critical: StrategyHealthBand;
}

export interface StrategyHealthInput {
  strategyId: string;
  strategyVersion: string;
  sampleSize: number;
  expectedValue: number | null;
  profitFactor: number | null;
  maxDrawdownPercent: number | null;
  paperVsBacktestHitRateGap: number | null;
  shadowVsBacktestHitRateGap: number | null;
  liveVsBacktestHitRateGap: number | null;
}

export interface StrategyHealthResult {
  strategyId: string;
  strategyVersion: string;
  policyVersion: string;
  status: StrategyHealthStatus;
  sampleSize: number;
  minimumSampleSize: number;
  reasons: string[];
  worstObservedHitRateGap: number | null;
  alertEligible: boolean;
  executionAuthority: 'NONE';
}

export type CounterfactualDecision = 'TAKE' | 'WAIT' | 'WATCH' | 'REJECT';
export type CounterfactualClassification =
  | 'GOOD_TRADE_TAKEN'
  | 'BAD_TRADE_TAKEN'
  | 'BAD_TRADE_AVOIDED'
  | 'GOOD_TRADE_MISSED'
  | 'NEUTRAL_OR_UNRESOLVED';

export interface CounterfactualObservation {
  signalId: string;
  decision: CounterfactualDecision;
  resolved: boolean;
  netReturnPercent: number | null;
  reasonCodes: readonly string[];
}

export interface ClassifiedCounterfactualObservation extends CounterfactualObservation {
  classification: CounterfactualClassification;
  reasonType: 'WHY_TRADE' | 'WHY_NO_TRADE';
}

export interface CounterfactualSummary {
  sampleSize: number;
  decisiveSampleSize: number;
  goodTradeTakenCount: number;
  badTradeTakenCount: number;
  badTradeAvoidedCount: number;
  goodTradeMissedCount: number;
  neutralOrUnresolvedCount: number;
  decisionQualityRatePercent: number | null;
  observedLossAvoidedPercentSum: number;
  observedUpsideMissedPercentSum: number;
  executionAuthority: 'NONE';
}

export interface CapitalHeatmapLaneInput {
  market: CapitalLabMarket;
  allocationKrw: number;
  allocationWeight: number;
  evidenceStatus: CapitalLabEvidenceStatus;
  confidence: number;
  researchScore: number;
  warnings: readonly string[];
}

export type CapitalHeatmapEvidenceStatus = 'INSUFFICIENT_DATA' | 'PARTIAL' | 'EVIDENCE_READY';

export interface CapitalHeatmapCell {
  bucket: CapitalLabMarket | 'CASH_RESERVE';
  allocationKrw: number;
  allocationPercent: number;
  intensity: number;
  evidenceStatus: CapitalLabEvidenceStatus | 'RESERVE';
  confidence: number | null;
  researchScore: number | null;
  warnings: readonly string[];
}

export interface CapitalAllocationHeatmap {
  initialCapitalKrw: number;
  evidenceStatus: CapitalHeatmapEvidenceStatus;
  cells: CapitalHeatmapCell[];
  allocatedKrw: number;
  invariantPassed: boolean;
  executionAuthority: 'NONE';
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function finiteNonNegative(value: number): boolean {
  return finite(value) && value >= 0;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function validateBand(name: string, band: StrategyHealthBand): void {
  if (!finite(band.expectedValueBelow)) throw new Error(`${name}.expectedValueBelow must be finite`);
  if (!finiteNonNegative(band.profitFactorBelow)) throw new Error(`${name}.profitFactorBelow must be non-negative`);
  if (!finiteNonNegative(band.maxDrawdownAtOrAbove)) throw new Error(`${name}.maxDrawdownAtOrAbove must be non-negative`);
  if (!finite(band.hitRateGapAtOrBelow)) throw new Error(`${name}.hitRateGapAtOrBelow must be finite`);
}

function validatePolicy(policy: StrategyHealthPolicy): void {
  if (!policy.version.trim()) throw new Error('Strategy health policy version is required');
  if (!Number.isInteger(policy.minimumSampleSize) || policy.minimumSampleSize <= 0) {
    throw new Error('Strategy health minimumSampleSize must be a positive integer');
  }
  validateBand('watch', policy.watch);
  validateBand('degraded', policy.degraded);
  validateBand('critical', policy.critical);
}

function worstObservedGap(input: StrategyHealthInput): number | null {
  const gaps = [
    input.paperVsBacktestHitRateGap,
    input.shadowVsBacktestHitRateGap,
    input.liveVsBacktestHitRateGap,
  ].filter((value): value is number => value != null && finite(value));
  return gaps.length ? Math.min(...gaps) : null;
}

function bandReasons(
  input: StrategyHealthInput,
  band: StrategyHealthBand,
  gap: number | null,
): string[] {
  const reasons: string[] = [];
  if ((input.expectedValue as number) < band.expectedValueBelow) reasons.push('EXPECTED_VALUE_BELOW_POLICY');
  if ((input.profitFactor as number) < band.profitFactorBelow) reasons.push('PROFIT_FACTOR_BELOW_POLICY');
  if ((input.maxDrawdownPercent as number) >= band.maxDrawdownAtOrAbove) reasons.push('DRAWDOWN_AT_OR_ABOVE_POLICY');
  if (gap != null && gap <= band.hitRateGapAtOrBelow) reasons.push('HIT_RATE_DRIFT_AT_OR_BELOW_POLICY');
  return reasons;
}

export function evaluateStrategyHealth(
  input: StrategyHealthInput,
  policy: StrategyHealthPolicy,
): StrategyHealthResult {
  validatePolicy(policy);
  if (!input.strategyId.trim()) throw new Error('strategyId is required');
  if (!input.strategyVersion.trim()) throw new Error('strategyVersion is required');

  const gap = worstObservedGap(input);
  const missingCoreMetrics = input.expectedValue == null
    || !finite(input.expectedValue)
    || input.profitFactor == null
    || !finiteNonNegative(input.profitFactor)
    || input.maxDrawdownPercent == null
    || !finiteNonNegative(input.maxDrawdownPercent);

  if (!Number.isInteger(input.sampleSize) || input.sampleSize < policy.minimumSampleSize || missingCoreMetrics) {
    const reasons: string[] = [];
    if (!Number.isInteger(input.sampleSize) || input.sampleSize < policy.minimumSampleSize) reasons.push('INSUFFICIENT_SAMPLE');
    if (missingCoreMetrics) reasons.push('CORE_PERFORMANCE_METRICS_REQUIRED');
    return {
      strategyId: input.strategyId,
      strategyVersion: input.strategyVersion,
      policyVersion: policy.version,
      status: 'INSUFFICIENT_DATA',
      sampleSize: Number.isInteger(input.sampleSize) && input.sampleSize >= 0 ? input.sampleSize : 0,
      minimumSampleSize: policy.minimumSampleSize,
      reasons,
      worstObservedHitRateGap: gap,
      alertEligible: false,
      executionAuthority: 'NONE',
    };
  }

  const ordered: Array<{ status: Exclude<StrategyHealthStatus, 'INSUFFICIENT_DATA' | 'HEALTHY'>; band: StrategyHealthBand }> = [
    { status: 'CRITICAL', band: policy.critical },
    { status: 'DEGRADED', band: policy.degraded },
    { status: 'WATCH', band: policy.watch },
  ];

  for (const item of ordered) {
    const reasons = bandReasons(input, item.band, gap);
    if (reasons.length) {
      return {
        strategyId: input.strategyId,
        strategyVersion: input.strategyVersion,
        policyVersion: policy.version,
        status: item.status,
        sampleSize: input.sampleSize,
        minimumSampleSize: policy.minimumSampleSize,
        reasons,
        worstObservedHitRateGap: gap,
        alertEligible: item.status === 'CRITICAL' || item.status === 'DEGRADED',
        executionAuthority: 'NONE',
      };
    }
  }

  return {
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    policyVersion: policy.version,
    status: 'HEALTHY',
    sampleSize: input.sampleSize,
    minimumSampleSize: policy.minimumSampleSize,
    reasons: [],
    worstObservedHitRateGap: gap,
    alertEligible: false,
    executionAuthority: 'NONE',
  };
}

export function classifyCounterfactualObservation(
  observation: CounterfactualObservation,
  minimumMeaningfulReturnPercent: number,
): ClassifiedCounterfactualObservation {
  if (!finiteNonNegative(minimumMeaningfulReturnPercent)) {
    throw new Error('minimumMeaningfulReturnPercent must be non-negative');
  }
  if (!observation.signalId.trim()) throw new Error('signalId is required');

  let classification: CounterfactualClassification = 'NEUTRAL_OR_UNRESOLVED';
  const value = observation.netReturnPercent;
  if (observation.resolved && value != null && finite(value)) {
    if (value > minimumMeaningfulReturnPercent) {
      classification = observation.decision === 'TAKE' ? 'GOOD_TRADE_TAKEN' : 'GOOD_TRADE_MISSED';
    } else if (value < -minimumMeaningfulReturnPercent) {
      classification = observation.decision === 'TAKE' ? 'BAD_TRADE_TAKEN' : 'BAD_TRADE_AVOIDED';
    }
  }

  return {
    ...observation,
    reasonCodes: [...observation.reasonCodes],
    classification,
    reasonType: observation.decision === 'TAKE' ? 'WHY_TRADE' : 'WHY_NO_TRADE',
  };
}

export function summarizeCounterfactualDecisions(
  observations: readonly CounterfactualObservation[],
  minimumMeaningfulReturnPercent: number,
): CounterfactualSummary {
  const classified = observations.map((item) => classifyCounterfactualObservation(item, minimumMeaningfulReturnPercent));
  const count = (classification: CounterfactualClassification) => classified.filter((item) => item.classification === classification).length;
  const goodTradeTakenCount = count('GOOD_TRADE_TAKEN');
  const badTradeTakenCount = count('BAD_TRADE_TAKEN');
  const badTradeAvoidedCount = count('BAD_TRADE_AVOIDED');
  const goodTradeMissedCount = count('GOOD_TRADE_MISSED');
  const neutralOrUnresolvedCount = count('NEUTRAL_OR_UNRESOLVED');
  const decisiveSampleSize = classified.length - neutralOrUnresolvedCount;
  const goodDecisions = goodTradeTakenCount + badTradeAvoidedCount;
  const observedLossAvoidedPercentSum = classified
    .filter((item) => item.classification === 'BAD_TRADE_AVOIDED')
    .reduce((sum, item) => sum + Math.abs(item.netReturnPercent ?? 0), 0);
  const observedUpsideMissedPercentSum = classified
    .filter((item) => item.classification === 'GOOD_TRADE_MISSED')
    .reduce((sum, item) => sum + Math.max(0, item.netReturnPercent ?? 0), 0);

  return {
    sampleSize: classified.length,
    decisiveSampleSize,
    goodTradeTakenCount,
    badTradeTakenCount,
    badTradeAvoidedCount,
    goodTradeMissedCount,
    neutralOrUnresolvedCount,
    decisionQualityRatePercent: decisiveSampleSize ? round(goodDecisions / decisiveSampleSize * 100) : null,
    observedLossAvoidedPercentSum: round(observedLossAvoidedPercentSum),
    observedUpsideMissedPercentSum: round(observedUpsideMissedPercentSum),
    executionAuthority: 'NONE',
  };
}

export function buildStrategyDriftTelegramAlert(args: {
  health: StrategyHealthResult;
  timestamp: string;
  cooldownMs: number;
}): TelegramAlertInput | null {
  if (!args.health.alertEligible) return null;
  if (!finiteNonNegative(args.cooldownMs)) throw new Error('cooldownMs must be non-negative');
  const reasonText = args.health.reasons.length ? args.health.reasons.join(', ') : 'NO_REASON';
  return {
    type: 'system_critical',
    symbol: args.health.strategyId,
    market: 'STRATEGY_HEALTH',
    details: `전략 상태 ${args.health.status}; policy=${args.health.policyVersion}; reasons=${reasonText}`,
    timestamp: args.timestamp,
    dedupeKey: `strategy-drift:${args.health.strategyId}:${args.health.strategyVersion}:${args.health.policyVersion}:${args.health.status}`,
    cooldownMs: args.cooldownMs,
    duplicateWindowMs: args.cooldownMs,
  };
}

export function buildCapitalAllocationHeatmap(args: {
  initialCapitalKrw: number;
  reserveKrw: number;
  lanes: readonly CapitalHeatmapLaneInput[];
}): CapitalAllocationHeatmap {
  if (!Number.isInteger(args.initialCapitalKrw) || args.initialCapitalKrw <= 0) {
    throw new Error('initialCapitalKrw must be a positive integer');
  }
  if (!Number.isInteger(args.reserveKrw) || args.reserveKrw < 0) {
    throw new Error('reserveKrw must be a non-negative integer');
  }

  const seen = new Set<CapitalLabMarket>();
  const laneCells = args.lanes.map((lane): CapitalHeatmapCell => {
    if (seen.has(lane.market)) throw new Error(`Duplicate capital heatmap market: ${lane.market}`);
    seen.add(lane.market);
    if (!Number.isInteger(lane.allocationKrw) || lane.allocationKrw < 0) throw new Error('allocationKrw must be non-negative integer');
    if (!finiteNonNegative(lane.allocationWeight)) throw new Error('allocationWeight must be non-negative');
    if (!finiteNonNegative(lane.confidence) || lane.confidence > 1) throw new Error('confidence must be between 0 and 1');
    if (!finiteNonNegative(lane.researchScore) || lane.researchScore > 1) throw new Error('researchScore must be between 0 and 1');
    const allocationPercent = round(lane.allocationKrw / args.initialCapitalKrw * 100);
    return {
      bucket: lane.market,
      allocationKrw: lane.allocationKrw,
      allocationPercent,
      intensity: round(allocationPercent / 100),
      evidenceStatus: lane.evidenceStatus,
      confidence: round(lane.confidence),
      researchScore: round(lane.researchScore),
      warnings: [...lane.warnings],
    };
  });

  const reservePercent = round(args.reserveKrw / args.initialCapitalKrw * 100);
  const cells: CapitalHeatmapCell[] = [
    ...laneCells,
    {
      bucket: 'CASH_RESERVE',
      allocationKrw: args.reserveKrw,
      allocationPercent: reservePercent,
      intensity: round(reservePercent / 100),
      evidenceStatus: 'RESERVE',
      confidence: null,
      researchScore: null,
      warnings: [],
    },
  ];

  const allocatedKrw = cells.reduce((sum, cell) => sum + cell.allocationKrw, 0);
  const everyEvidenceReady = laneCells.length > 0 && laneCells.every((cell) => cell.evidenceStatus === 'EVIDENCE_READY');
  const anyEvidence = laneCells.some((cell) => cell.evidenceStatus !== 'INSUFFICIENT');
  const evidenceStatus: CapitalHeatmapEvidenceStatus = everyEvidenceReady
    ? 'EVIDENCE_READY'
    : anyEvidence
      ? 'PARTIAL'
      : 'INSUFFICIENT_DATA';

  return {
    initialCapitalKrw: args.initialCapitalKrw,
    evidenceStatus,
    cells,
    allocatedKrw,
    invariantPassed: allocatedKrw === args.initialCapitalKrw,
    executionAuthority: 'NONE',
  };
}

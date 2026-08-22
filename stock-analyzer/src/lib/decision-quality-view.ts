export type StrategyHealthStatus = 'INSUFFICIENT_DATA' | 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'CRITICAL';
export type CapitalHeatmapEvidenceStatus = 'INSUFFICIENT_DATA' | 'PARTIAL' | 'EVIDENCE_READY';
export type CapitalHeatmapCellEvidenceStatus = 'INSUFFICIENT' | 'VALIDATING' | 'EVIDENCE_READY' | 'RESERVE';

export interface StrategyHealthView {
  strategyId: string;
  strategyVersion: string;
  policyVersion: string;
  status: StrategyHealthStatus;
  sampleSize: number;
  minimumSampleSize: number;
  reasons: readonly string[];
  worstObservedHitRateGap: number | null;
  alertEligible: boolean;
}

export interface CounterfactualSummaryView {
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
}

export interface CapitalHeatmapCellView {
  bucket: 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES' | 'CASH_RESERVE';
  allocationKrw: number;
  allocationPercent: number;
  intensity: number;
  evidenceStatus: CapitalHeatmapCellEvidenceStatus;
  confidence: number | null;
  researchScore: number | null;
  warnings: readonly string[];
}

export interface CapitalHeatmapView {
  initialCapitalKrw: number;
  evidenceStatus: CapitalHeatmapEvidenceStatus;
  cells: readonly CapitalHeatmapCellView[];
  allocatedKrw: number;
  invariantPassed: boolean;
}

export interface DecisionQualityDashboardView {
  health: StrategyHealthView;
  counterfactual: CounterfactualSummaryView;
  heatmap: CapitalHeatmapView;
}

const HEALTH_LABEL: Record<StrategyHealthStatus, string> = {
  INSUFFICIENT_DATA: '데이터 부족',
  HEALTHY: '정상',
  WATCH: '관찰',
  DEGRADED: '성능 저하',
  CRITICAL: '위험',
};

const EVIDENCE_LABEL: Record<CapitalHeatmapCellEvidenceStatus, string> = {
  INSUFFICIENT: '근거 부족',
  VALIDATING: '검증 중',
  EVIDENCE_READY: '근거 확보',
  RESERVE: '현금 보유',
};

const BUCKET_LABEL: Record<CapitalHeatmapCellView['bucket'], string> = {
  KR_STOCK: '국내주식',
  US_STOCK: '미국주식',
  CRYPTO_SPOT: '코인 현물',
  CRYPTO_FUTURES: '코인 선물',
  CASH_RESERVE: '현금',
};

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function nonNegative(value: number): boolean {
  return finite(value) && value >= 0;
}

export function strategyHealthLabel(status: StrategyHealthStatus): string {
  return HEALTH_LABEL[status];
}

export function capitalEvidenceLabel(status: CapitalHeatmapCellEvidenceStatus): string {
  return EVIDENCE_LABEL[status];
}

export function capitalBucketLabel(bucket: CapitalHeatmapCellView['bucket']): string {
  return BUCKET_LABEL[bucket];
}

export function formatKrw(value: number): string {
  if (!finite(value)) return '확인 불가';
  return `${Math.round(value).toLocaleString('ko-KR')}원`;
}

export function formatPercent(value: number | null, digits = 1): string {
  if (value == null || !finite(value)) return 'INSUFFICIENT_DATA';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(digits)}%`;
}

export function decisionQualityStatus(summary: CounterfactualSummaryView): 'INSUFFICIENT_DATA' | 'MEASURED' {
  return summary.decisiveSampleSize > 0 && summary.decisionQualityRatePercent != null
    ? 'MEASURED'
    : 'INSUFFICIENT_DATA';
}

export function orderCapitalHeatmapCells(cells: readonly CapitalHeatmapCellView[]): CapitalHeatmapCellView[] {
  return [...cells].sort((left, right) => {
    if (left.bucket === 'CASH_RESERVE' && right.bucket !== 'CASH_RESERVE') return 1;
    if (right.bucket === 'CASH_RESERVE' && left.bucket !== 'CASH_RESERVE') return -1;
    return right.allocationKrw - left.allocationKrw || left.bucket.localeCompare(right.bucket);
  });
}

export function validateDecisionQualityDashboard(view: DecisionQualityDashboardView): string[] {
  const errors: string[] = [];
  if (!view.health.strategyId.trim()) errors.push('STRATEGY_ID_REQUIRED');
  if (!view.health.strategyVersion.trim()) errors.push('STRATEGY_VERSION_REQUIRED');
  if (!view.health.policyVersion.trim()) errors.push('HEALTH_POLICY_VERSION_REQUIRED');
  if (!Number.isInteger(view.health.sampleSize) || view.health.sampleSize < 0) errors.push('INVALID_HEALTH_SAMPLE_SIZE');
  if (!Number.isInteger(view.health.minimumSampleSize) || view.health.minimumSampleSize <= 0) errors.push('INVALID_MINIMUM_SAMPLE_SIZE');

  const counter = view.counterfactual;
  if (!Number.isInteger(counter.sampleSize) || counter.sampleSize < 0) errors.push('INVALID_COUNTERFACTUAL_SAMPLE_SIZE');
  if (!Number.isInteger(counter.decisiveSampleSize) || counter.decisiveSampleSize < 0 || counter.decisiveSampleSize > counter.sampleSize) {
    errors.push('INVALID_COUNTERFACTUAL_DECISIVE_SAMPLE');
  }
  if (counter.decisionQualityRatePercent != null
      && (!nonNegative(counter.decisionQualityRatePercent) || counter.decisionQualityRatePercent > 100)) {
    errors.push('INVALID_DECISION_QUALITY_RATE');
  }

  const heatmap = view.heatmap;
  if (!Number.isInteger(heatmap.initialCapitalKrw) || heatmap.initialCapitalKrw <= 0) errors.push('INVALID_INITIAL_CAPITAL');
  if (!Number.isInteger(heatmap.allocatedKrw) || heatmap.allocatedKrw < 0) errors.push('INVALID_ALLOCATED_CAPITAL');
  const computed = heatmap.cells.reduce((sum, cell) => sum + cell.allocationKrw, 0);
  if (computed !== heatmap.allocatedKrw) errors.push('HEATMAP_ALLOCATION_SUM_MISMATCH');
  if (heatmap.invariantPassed !== (heatmap.allocatedKrw === heatmap.initialCapitalKrw)) errors.push('HEATMAP_INVARIANT_FLAG_MISMATCH');
  if (new Set(heatmap.cells.map((cell) => cell.bucket)).size !== heatmap.cells.length) errors.push('DUPLICATE_HEATMAP_BUCKET');
  for (const cell of heatmap.cells) {
    if (!Number.isInteger(cell.allocationKrw) || cell.allocationKrw < 0) errors.push(`INVALID_ALLOCATION:${cell.bucket}`);
    if (!nonNegative(cell.allocationPercent) || cell.allocationPercent > 100) errors.push(`INVALID_ALLOCATION_PERCENT:${cell.bucket}`);
    if (!nonNegative(cell.intensity) || cell.intensity > 1) errors.push(`INVALID_INTENSITY:${cell.bucket}`);
  }
  return errors;
}

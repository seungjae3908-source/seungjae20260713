export type SignalPerformanceAvailability = 'READY' | 'INSUFFICIENT_SAMPLE' | 'NOT_ENOUGH_DATA';

export interface ScannerSignalPerformanceSummary {
  availability: SignalPerformanceAvailability;
  sampleSize: number;
  hitRate: number | null;
  averageReturn: number | null;
  averageLoss: number | null;
  expectedValue: number | null;
  profitFactor: number | null;
  recent100HitRate: number | null;
  marketRegime: string | null;
}

export function signalPerformanceMessage(summary: ScannerSignalPerformanceSummary | null | undefined): string {
  if (!summary || summary.availability !== 'READY') return '통계 산출을 위한 데이터가 부족합니다.';
  return '과거 유사조건 성과';
}

export function canDisplayPerformanceRates(summary: ScannerSignalPerformanceSummary | null | undefined): boolean {
  return Boolean(summary && summary.availability === 'READY' && summary.sampleSize > 0 && summary.hitRate != null);
}

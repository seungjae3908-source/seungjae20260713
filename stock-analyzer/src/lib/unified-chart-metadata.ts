import type { AnalysisMarket } from './analysis-selection';

export type UnifiedChartTimeframe =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1H'
  | '4H'
  | '1D';

export const UNIFIED_CHART_TIMEFRAMES: Array<{
  key: UnifiedChartTimeframe;
  label: string;
}> = [
  { key: '1m', label: '1분' },
  { key: '3m', label: '3분' },
  { key: '5m', label: '5분' },
  { key: '15m', label: '15분' },
  { key: '30m', label: '30분' },
  { key: '1H', label: '1시간' },
  { key: '4H', label: '4시간' },
  { key: '1D', label: '일봉' },
];

export function unifiedMarketLabel(market: AnalysisMarket): string {
  const labels: Record<AnalysisMarket, string> = {
    KR: '국내주식',
    US: '미국주식',
    UPBIT: '코인 현물',
    BITGET: '코인 선물',
  };
  return labels[market];
}

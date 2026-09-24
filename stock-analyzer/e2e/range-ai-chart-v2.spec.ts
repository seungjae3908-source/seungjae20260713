import { expect, test } from '@playwright/test';
import { buildChartAnalysis, type ChartAnalysisInput } from '../src/lib/chart-analysis';

const baseInput: ChartAnalysisInput = {
  symbol: '005930',
  market: 'KR',
  timeframe: '5m',
  latestTime: 1_700_000_000,
  currentPrice: 70_000,
  previousClose: 69_500,
  trend: '상승',
  rsi: 58,
  macd: 12,
  volumeRatio: 1.4,
  support: 68_000,
  resistance: 71_000,
  signal: 'ENTER',
  confidence: 95,
  title: '상승 구조 후보',
  summary: '완료 여부를 확인합니다.',
  patterns: [],
  source: 'critical-browser-regression',
  isClosedCandle: true,
  dataStatus: 'ok',
};

test('AI Chart analysis fails closed when support is not below resistance', () => {
  for (const range of [
    { support: 72_000, resistance: 71_000 },
    { support: 71_000, resistance: 71_000 },
  ]) {
    const result = buildChartAnalysis({ ...baseInput, ...range });
    expect(result.status).toBe('expired');
    expect(result.priceLevels).toEqual([]);
    expect(result.reasons).toContain('핵심 가격/시간 데이터: unavailable');
  }

  const ordered = buildChartAnalysis(baseInput);
  expect(ordered.status).toBe('confirmed');
  expect(ordered.priceLevels).toEqual([
    { price: 68_000, role: 'support' },
    { price: 71_000, role: 'resistance' },
  ]);
});

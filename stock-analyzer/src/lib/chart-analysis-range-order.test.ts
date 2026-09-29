import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartAnalysis, type ChartAnalysisInput } from './chart-analysis';

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
  source: 'test-provider',
  isClosedCandle: true,
  dataStatus: 'ok',
};

test('inverted or zero-width support/resistance ranges fail closed', () => {
  for (const range of [
    { support: 72_000, resistance: 71_000 },
    { support: 71_000, resistance: 71_000 },
  ]) {
    const result = buildChartAnalysis({ ...baseInput, ...range });
    assert.equal(result.status, 'expired', JSON.stringify(range));
    assert.ok(result.expiredAt, JSON.stringify(range));
    assert.ok(result.reasons.includes('핵심 가격/시간 데이터: unavailable'), JSON.stringify(range));
    assert.deepEqual(result.priceLevels, [], JSON.stringify(range));
  }
});

test('ordered support/resistance range remains actionable', () => {
  const result = buildChartAnalysis(baseInput);
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(result.priceLevels, [
    { price: 68_000, role: 'support' },
    { price: 71_000, role: 'resistance' },
  ]);
});

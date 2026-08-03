import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartAnalysis, shouldAppendTimeline, type ChartAnalysisInput } from './chart-analysis';

const input: ChartAnalysisInput = {
  symbol: '005930', market: 'KR', timeframe: '5m', latestTime: 1_700_000_000,
  currentPrice: 70_000, previousClose: 69_500, trend: '상승', rsi: 58, macd: 12,
  volumeRatio: 1.4, support: 68_000, resistance: 71_000, signal: 'ENTER', confidence: 78,
  title: '상승 구조 후보', summary: '완료 여부를 확인합니다.', patterns: ['박스권 돌파 후보'], source: 'test-provider', isClosedCandle: false,
};

test('an open candle never creates a confirmed analysis', () => {
  assert.equal(buildChartAnalysis(input).status, 'forming');
});

test('a completed candle can confirm only with sufficient confidence', () => {
  assert.equal(buildChartAnalysis({ ...input, isClosedCandle: true }).status, 'confirmed');
  assert.equal(buildChartAnalysis({ ...input, isClosedCandle: true, confidence: 55 }).status, 'weakened');
});

test('exit invalidates a completed analysis', () => {
  const result = buildChartAnalysis({ ...input, isClosedCandle: true, signal: 'EXIT' });
  assert.equal(result.status, 'invalidated');
  assert.equal(result.bias, 'bearish');
});

test('timeline suppresses an unchanged analysis', () => {
  const result = buildChartAnalysis(input);
  assert.equal(shouldAppendTimeline(result, result), false);
  assert.equal(shouldAppendTimeline(result, { ...result, confidence: result.confidence - 1 }), false);
  assert.equal(shouldAppendTimeline(result, { ...result, status: 'candidate' }), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartAnalysis, type ChartAnalysisInput } from './chart-analysis';

const baseInput = (): ChartAnalysisInput => ({
  symbol: 'BTCUSDT',
  market: 'BITGET',
  timeframe: '15m',
  latestTime: 1_790_254_800,
  currentPrice: 100,
  previousClose: 99,
  trend: '상승',
  rsi: 58,
  macd: 1.2,
  volumeRatio: 1.4,
  support: 95,
  resistance: 105,
  signal: 'ENTER',
  confidence: 90,
  title: 'BTC 구조 분석',
  summary: '완료봉 기준 구조 분석',
  patterns: [],
  source: 'ai-chart-v2',
  isClosedCandle: true,
  dataStatus: 'ok',
});

test('complete analysis identity and provenance can remain actionable', () => {
  const analysis = buildChartAnalysis(baseInput());
  assert.equal(analysis.status, 'confirmed');
  assert.equal(analysis.symbol, 'BTCUSDT');
  assert.equal(analysis.market, 'BITGET');
  assert.equal(analysis.timeframe, '15m');
  assert.equal(analysis.source, 'ai-chart-v2');
  assert.equal(analysis.reasons.includes('분석 식별자/출처: unavailable'), false);
});

test('missing symbol, market, timeframe, or source expires analysis fail-closed', () => {
  for (const field of ['symbol', 'market', 'timeframe', 'source'] as const) {
    for (const missing of ['', '   ']) {
      const input = { ...baseInput(), [field]: missing };
      const analysis = buildChartAnalysis(input);
      assert.equal(analysis.status, 'expired', `${field}=${JSON.stringify(missing)}`);
      assert.ok(analysis.reasons.includes('분석 식별자/출처: unavailable'));
      assert.equal(analysis.confirmedAt, undefined);
      assert.equal(analysis.expiredAt, analysis.detectedAt);
    }
  }
});

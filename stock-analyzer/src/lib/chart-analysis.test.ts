import test from 'node:test';
import assert from 'node:assert/strict';
import './chart-external-window.test';
import {
  buildChartAnalysis,
  chartAnalysisTimelineKey,
  createStableAnalysisId,
  shouldAppendTimeline,
  type ChartAnalysisInput,
} from './chart-analysis';

const input: ChartAnalysisInput = {
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
  confidence: 78,
  title: '상승 구조 후보',
  summary: '완료 여부를 확인합니다.',
  patterns: ['박스권 돌파 후보'],
  source: 'test-provider',
  isClosedCandle: false,
  anchorTimes: [1_699_997_000, 1_699_998_500],
};

test('an open candle never creates a confirmed analysis', () => {
  assert.equal(buildChartAnalysis(input).status, 'forming');
});

test('a completed candle can confirm only with sufficient confidence', () => {
  assert.equal(buildChartAnalysis({ ...input, isClosedCandle: true }).status, 'confirmed');
  assert.equal(buildChartAnalysis({ ...input, isClosedCandle: true, confidence: 55 }).status, 'weakened');
});

test('exit invalidates a completed generic analysis and keeps bearish bias', () => {
  const result = buildChartAnalysis({
    ...input,
    patterns: [],
    isClosedCandle: true,
    signal: 'EXIT',
  });
  assert.equal(result.status, 'invalidated');
  assert.equal(result.bias, 'bearish');
});

test('stable analysis ids are deterministic and anchored to confirmed points', () => {
  const base = {
    engineVersion: 'chart-analysis-v2',
    market: 'KR',
    symbol: '005930',
    timeframe: '5m',
    type: 'double-top',
    subtype: 'M자 · 이중천장',
    anchorTimes: [300, 100, 300, 200],
    bias: 'bearish' as const,
  };
  assert.equal(createStableAnalysisId(base), createStableAnalysisId({ ...base, anchorTimes: [100, 200, 300] }));
  assert.notEqual(createStableAnalysisId(base), createStableAnalysisId({ ...base, anchorTimes: [100, 200, 400] }));
});

test('double top stays bearish before confirmation and never becomes an upward pattern', () => {
  const result = buildChartAnalysis({
    ...input,
    patterns: ['쌍봉 후보'],
    isClosedCandle: true,
    signal: 'WATCH',
  });
  assert.equal(result.type, 'double-top');
  assert.equal(result.subtype, 'M자 · 이중천장');
  assert.equal(result.status, 'candidate');
  assert.equal(result.bias, 'bearish');
  assert.match(result.summary, /하락 후보/);
  assert.doesNotMatch(`${result.title} ${result.summary}`, /M자.*상승 예상|이중천장.*상승 확정/);
});

test('double top confirms below the neckline and invalidates above the reference high', () => {
  const confirmed = buildChartAnalysis({
    ...input,
    patterns: ['이중천장'],
    isClosedCandle: true,
    signal: 'WATCH',
    currentPrice: 67_900,
  });
  const invalidated = buildChartAnalysis({
    ...input,
    patterns: ['M자'],
    isClosedCandle: true,
    signal: 'WATCH',
    currentPrice: 71_100,
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.match(confirmed.summary, /하락 패턴/);
  assert.equal(invalidated.status, 'invalidated');
  assert.match(invalidated.summary, /무효화/);
});

test('double bottom stays bullish, confirms above neckline, and invalidates below support', () => {
  const candidate = buildChartAnalysis({
    ...input,
    patterns: ['쌍바닥 후보'],
    isClosedCandle: true,
    signal: 'WATCH',
  });
  const confirmed = buildChartAnalysis({
    ...input,
    patterns: ['W자'],
    isClosedCandle: true,
    signal: 'WATCH',
    currentPrice: 71_100,
  });
  const invalidated = buildChartAnalysis({
    ...input,
    patterns: ['이중바닥'],
    isClosedCandle: true,
    signal: 'WATCH',
    currentPrice: 67_900,
  });
  assert.equal(candidate.bias, 'bullish');
  assert.equal(candidate.status, 'candidate');
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(invalidated.status, 'invalidated');
  assert.doesNotMatch(`${candidate.title} ${candidate.summary}`, /W자.*하락 확정|이중바닥.*하락 확정/);
});

test('state timestamps preserve the first creation time for the same stable analysis', () => {
  const candidate = buildChartAnalysis({
    ...input,
    patterns: ['쌍봉 후보'],
    isClosedCandle: true,
    signal: 'WATCH',
  });
  const confirmed = buildChartAnalysis({
    ...input,
    latestTime: input.latestTime + 300,
    patterns: ['쌍봉 후보'],
    isClosedCandle: true,
    signal: 'WATCH',
    currentPrice: 67_900,
    previousAnalysis: candidate,
  });
  assert.equal(confirmed.id, candidate.id);
  assert.equal(confirmed.createdAt, candidate.createdAt);
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(confirmed.confirmedAt);
  assert.match(confirmed.transitionReason ?? '', /후보에서 확정으로 변경/);
});

test('timeline suppresses noise but records meaningful state and confidence changes', () => {
  const candidate = buildChartAnalysis({
    ...input,
    patterns: [],
    signal: 'WATCH',
    isClosedCandle: true,
    confidence: 78,
  });
  const sameBucket = buildChartAnalysis({
    ...input,
    patterns: [],
    signal: 'WATCH',
    isClosedCandle: true,
    confidence: 75,
  });
  const nextBucket = buildChartAnalysis({
    ...input,
    patterns: [],
    signal: 'WATCH',
    isClosedCandle: true,
    confidence: 68,
  });
  assert.equal(shouldAppendTimeline(candidate, candidate), false);
  assert.equal(shouldAppendTimeline(candidate, sameBucket), false);
  assert.equal(shouldAppendTimeline(candidate, nextBucket), true);
  assert.equal(chartAnalysisTimelineKey(candidate), chartAnalysisTimelineKey({ ...candidate }));
});

test('non-finite indicators are converted to safe unavailable values', () => {
  const result = buildChartAnalysis({
    ...input,
    rsi: Number.NaN,
    macd: Number.POSITIVE_INFINITY,
    volumeRatio: Number.NaN,
  });
  assert.ok(result.reasons.includes('RSI: unavailable'));
  assert.ok(result.reasons.includes('MACD: unavailable'));
  assert.equal(result.relatedIndicators.volumeRatio, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartAnalysis, type ChartAnalysisInput } from './chart-analysis';
import { appendChartTimeline, eventsForChartContext } from './chart-live-timeline';

const base: ChartAnalysisInput = {
  symbol: '005930',
  market: 'KR',
  timeframe: '5m',
  latestTime: 1_700_000_000,
  currentPrice: 70_000,
  previousClose: 69_900,
  trend: '중립',
  rsi: 51,
  macd: 1.2,
  volumeRatio: 1.1,
  support: 68_000,
  resistance: 71_000,
  signal: 'WATCH',
  confidence: 62,
  title: '구조 관찰',
  summary: '확정봉을 기다립니다.',
  patterns: [],
  source: 'test',
  isClosedCandle: true,
  anchorTimes: [1_699_999_700],
};

test('timeline does not append an unchanged event for the same chart context', () => {
  const analysis = buildChartAnalysis(base);
  const once = appendChartTimeline([], analysis);
  const twice = appendChartTimeline(once, { ...analysis });
  assert.equal(once.length, 1);
  assert.equal(twice, once);
});

test('timeline appends a meaningful status transition and preserves the old event', () => {
  const candidate = buildChartAnalysis(base);
  const confirmed = buildChartAnalysis({
    ...base,
    signal: 'ENTER',
    confidence: 82,
    previousAnalysis: candidate,
  });
  const history = appendChartTimeline(appendChartTimeline([], candidate), confirmed);
  assert.equal(history.length, 2);
  assert.equal(history[0].analysis.status, 'confirmed');
  assert.equal(history[1].analysis.status, 'candidate');
});

test('events are separated by market, symbol, and timeframe', () => {
  const samsung = buildChartAnalysis(base);
  const apple = buildChartAnalysis({
    ...base,
    market: 'US',
    symbol: 'AAPL',
    timeframe: '15m',
    anchorTimes: [1_699_999_100],
  });
  const events = appendChartTimeline(appendChartTimeline([], samsung), apple);
  assert.equal(eventsForChartContext(events, { market: 'KR', symbol: '005930', timeframe: '5m' }).length, 1);
  assert.equal(eventsForChartContext(events, { market: 'US', symbol: 'AAPL', timeframe: '15m' }).length, 1);
  assert.equal(eventsForChartContext(events, { market: 'KR', symbol: 'AAPL', timeframe: '15m' }).length, 0);
});

test('timeline enforces a bounded history', () => {
  let events = [] as ReturnType<typeof appendChartTimeline>;
  for (let index = 0; index < 10; index += 1) {
    const analysis = buildChartAnalysis({
      ...base,
      symbol: `TEST${index}`,
      latestTime: base.latestTime + index * 300,
      anchorTimes: [base.latestTime + index * 300],
    });
    events = appendChartTimeline(events, analysis, 4);
  }
  assert.equal(events.length, 4);
});

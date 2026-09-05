import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateMultiTimeframe,
  buildTechnicalTimeframeEvidence,
  dataQualityFromStatus,
  defaultStrategyMode,
  mapPricePlan,
  normalizeStrategyMode,
  signalLifecycleFromAnalysis,
  strategyModeTimeframes,
  type AiChartTimeframeEvidence,
} from './ai-chart-v2-intelligence';

test('strategy modes use distinct multi-timeframe contexts', () => {
  assert.deepEqual(strategyModeTimeframes('SCALPING'), ['1m', '3m', '5m', '15m']);
  assert.deepEqual(strategyModeTimeframes('SWING'), ['15m', '1H', '4H', '1D']);
  assert.deepEqual(strategyModeTimeframes('MID_LONG'), ['4H', '1D']);
  assert.equal(defaultStrategyMode('5m'), 'SCALPING');
  assert.equal(defaultStrategyMode('1H'), 'SWING');
  assert.equal(normalizeStrategyMode('POSITION'), 'MID_LONG');
});

test('data quality preserves stale, partial, and unavailable states', () => {
  assert.equal(dataQualityFromStatus('ok'), 'LIVE');
  assert.equal(dataQualityFromStatus('delayed'), 'DELAYED');
  assert.equal(dataQualityFromStatus('stale'), 'STALE');
  assert.equal(dataQualityFromStatus('insufficient'), 'PARTIAL');
  assert.equal(dataQualityFromStatus('unavailable'), 'UNAVAILABLE');
});

test('signal lifecycle maps weakened invalidated and expired without deleting history', () => {
  assert.equal(signalLifecycleFromAnalysis('confirmed'), 'ACTIVE');
  assert.equal(signalLifecycleFromAnalysis('weakened'), 'WEAKENED');
  assert.equal(signalLifecycleFromAnalysis('invalidated'), 'INVALIDATED');
  assert.equal(signalLifecycleFromAnalysis('expired'), 'EXPIRED');
});

test('price plan mapping never invents a third entry or unavailable targets', () => {
  const mapped = mapPricePlan({
    entryZone: { from: 100, to: 102 },
    stopLoss: 96,
    invalidation: 95,
    targets: [108, 112],
    riskReward: 2.1,
  });
  assert.deepEqual(mapped.entries, [100, 102, null]);
  assert.deepEqual(mapped.targets, [108, 112, null]);
  assert.equal(mapped.stop, 96);
  assert.equal(mapped.invalidation, 95);
  assert.equal(mapped.riskReward, 2.1);
});

test('scanner context wins when it carries a real action and confidence', () => {
  const evidence = buildTechnicalTimeframeEvidence({
    market: 'BITGET',
    mode: 'SCALPING',
    timeframe: '5m',
    dataStatus: 'ok',
    candleCount: 100,
    trend: 'bearish',
    close: 100,
    ema12: 99,
    ema26: 101,
    vwap: 101,
    rsi14: 40,
    macdHistogram: -1,
    volumeRatio20: 1.8,
    atr14: 1,
    scannerAction: 'LONG',
    scannerConfidence: 84,
    scannerReasons: ['scanner validated'],
  });
  assert.equal(evidence.source, 'SCANNER');
  assert.equal(evidence.side, 'LONG');
  assert.equal(evidence.score, 84);
});

test('stale data never becomes an active directional signal', () => {
  const evidence = buildTechnicalTimeframeEvidence({
    market: 'KR',
    mode: 'SCALPING',
    timeframe: '5m',
    dataStatus: 'stale',
    candleCount: 100,
    trend: 'bullish',
    close: 70_000,
    ema12: 70_100,
    ema26: 69_900,
    vwap: 69_800,
    rsi14: 58,
    macdHistogram: 10,
    volumeRatio20: 1.5,
    atr14: 500,
  });
  assert.equal(evidence.state, 'INSUFFICIENT_DATA');
  assert.equal(evidence.side, 'WAIT');
  assert.equal(evidence.score, null);
  assert.equal(evidence.quality, 'STALE');
});

test('technical evidence creates market-semantic directions only from available evidence', () => {
  const stock = buildTechnicalTimeframeEvidence({
    market: 'US',
    mode: 'SCALPING',
    timeframe: '5m',
    dataStatus: 'ok',
    candleCount: 100,
    trend: 'bullish',
    close: 210,
    ema12: 209,
    ema26: 207,
    vwap: 205,
    rsi14: 60,
    macdHistogram: 1.2,
    volumeRatio20: 1.6,
    atr14: 2,
  });
  const futures = buildTechnicalTimeframeEvidence({
    market: 'BITGET',
    mode: 'SCALPING',
    timeframe: '5m',
    dataStatus: 'ok',
    candleCount: 100,
    trend: 'bearish',
    close: 100,
    ema12: 98,
    ema26: 102,
    vwap: 103,
    rsi14: 42,
    macdHistogram: -2,
    volumeRatio20: 1.7,
    atr14: 1,
  });
  assert.equal(stock.side, 'BUY');
  assert.ok((stock.score ?? 0) >= 70);
  assert.equal(futures.side, 'SHORT');
  assert.ok((futures.score ?? 0) >= 70);
});

test('multi-timeframe aggregation detects higher-timeframe conflict', () => {
  const context = (
    timeframe: AiChartTimeframeEvidence['timeframe'],
    side: AiChartTimeframeEvidence['side'],
  ): AiChartTimeframeEvidence => ({
    timeframe,
    state: 'READY',
    side,
    score: 80,
    quality: 'LIVE',
    positiveFactors: [],
    negativeFactors: [],
    riskFactors: [],
    reasonCodes: [],
    source: 'TECHNICAL_EVIDENCE',
  });
  const aggregate = aggregateMultiTimeframe('SWING', [
    context('15m', 'BUY'),
    context('1H', 'BUY'),
    context('4H', 'SELL'),
    context('1D', 'WAIT'),
  ], '15m');
  assert.equal(aggregate.higherTimeframeConflict, true);
  assert.deepEqual(aggregate.conflictTimeframes, ['4H']);
  assert.equal(aggregate.alignedDirectionalCount, 2);
});

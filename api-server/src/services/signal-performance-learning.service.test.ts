import './strategy-health-observatory.service.test';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildStagePerformanceComparison,
  calculateSignalPerformanceStatistics,
  calibrateSignalConfidence,
  createImmutableSignalSnapshot,
  evaluateSignalOutcome,
  SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY,
} from './signal-performance-learning.service';

function snapshot(direction: 'BUY' | 'SELL' | 'LONG' | 'SHORT') {
  return createImmutableSignalSnapshot({
    signalId: `sig-${direction}`,
    timestamp: '2026-08-13T00:00:00.000Z',
    market: direction === 'LONG' || direction === 'SHORT' ? 'CRYPTO_FUTURES' : 'KR_STOCK',
    symbol: 'TEST',
    symbolName: 'Test',
    strategyHorizon: 'SCALP',
    direction,
    signalScore: 84,
    displayConfidence: 82,
    referencePrice: 100,
    entryPrice: 100,
    stopLoss: direction === 'BUY' || direction === 'LONG' ? 95 : 105,
    target1: direction === 'BUY' || direction === 'LONG' ? 105 : 95,
    target2: direction === 'BUY' || direction === 'LONG' ? 110 : 90,
    riskReward: 2,
    timeframes: ['5m', '15m'],
    strategyProfileVersion: 'TEST_V1',
    indicatorSnapshot: { rsi: 55 },
    indicatorScores: { trend: 80 },
    patternSnapshot: {},
    volumeContext: {},
    volatilityContext: {},
    trendContext: {},
    marketRegime: 'UPTREND',
    liquidityContext: {},
    aiValidatorResult: { status: 'PASS' },
    riskEngineResult: { status: 'PASS' },
    dataProvenance: ['PUBLIC_TEST'],
    dataTimestamp: '2026-08-12T23:59:59.000Z',
  });
}

describe('signal performance learning', () => {
  it('creates immutable snapshots with no execution authority', () => {
    const value = snapshot('BUY');
    assert.equal(value.executionAuthority, SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY);
    assert.equal(Object.isFrozen(value), true);
    assert.throws(() => createImmutableSignalSnapshot({ ...value, dataTimestamp: '2026-08-13T00:01:00.000Z' }));
  });

  for (const direction of ['BUY', 'LONG'] as const) {
    it(`calculates favorable long-side outcome for ${direction}`, () => {
      const result = evaluateSignalOutcome({
        snapshot: snapshot(direction), evaluationHorizon: '1H', evaluatedAt: '2026-08-13T01:00:00.000Z',
        bars: [{ timestamp: '2026-08-13T00:05:00.000Z', high: 106, low: 99, close: 104 }],
      });
      assert.equal(result.outcome, 'WIN');
      assert.equal(result.target1Hit, true);
      assert.equal(result.returnPercent, 4);
      assert.equal(result.mfePercent, 6);
      assert.equal(result.maePercent, -1);
    });
  }

  for (const direction of ['SELL', 'SHORT'] as const) {
    it(`calculates favorable short-side outcome for ${direction}`, () => {
      const result = evaluateSignalOutcome({
        snapshot: snapshot(direction), evaluationHorizon: '1H', evaluatedAt: '2026-08-13T01:00:00.000Z',
        bars: [{ timestamp: '2026-08-13T00:05:00.000Z', high: 101, low: 94, close: 96 }],
      });
      assert.equal(result.outcome, 'WIN');
      assert.equal(result.target1Hit, true);
      assert.equal(result.returnPercent, 4);
      assert.equal(result.mfePercent, 6);
      assert.equal(result.maePercent, -1);
    });
  }

  it('uses conservative stop-first handling when target and stop occur in the same bar', () => {
    const result = evaluateSignalOutcome({
      snapshot: snapshot('LONG'), evaluationHorizon: '1H', evaluatedAt: '2026-08-13T01:00:00.000Z',
      bars: [{ timestamp: '2026-08-13T00:05:00.000Z', high: 106, low: 94, close: 101 }],
    });
    assert.equal(result.outcome, 'LOSS');
    assert.equal(result.stopLossHit, true);
    assert.equal(result.conservativeIntrabarConflict, true);
  });

  it('rejects bars later than evaluatedAt to prevent look-ahead leakage', () => {
    const result = evaluateSignalOutcome({
      snapshot: snapshot('BUY'), evaluationHorizon: '30M', evaluatedAt: '2026-08-13T00:30:00.000Z',
      bars: [
        { timestamp: '2026-08-13T00:10:00.000Z', high: 101, low: 99, close: 100 },
        { timestamp: '2026-08-13T00:40:00.000Z', high: 120, low: 99, close: 119 },
      ],
    });
    assert.equal(result.rejectedFutureBars, 1);
    assert.equal(result.target1Hit, false);
  });

  it('suppresses rate display for insufficient samples', () => {
    const outcome = evaluateSignalOutcome({
      snapshot: snapshot('BUY'), evaluationHorizon: '1H', evaluatedAt: '2026-08-13T01:00:00.000Z',
      bars: [{ timestamp: '2026-08-13T00:05:00.000Z', high: 106, low: 99, close: 104 }],
    });
    const stats = calculateSignalPerformanceStatistics([outcome], 30);
    assert.equal(stats.sampleStatus, 'INSUFFICIENT_SAMPLE');
    assert.equal(stats.hitRate, null);
    assert.equal(stats.executionAuthority, 'NONE');
  });

  it('keeps unavailable comparison stages null rather than inventing zeros', () => {
    const comparison = buildStagePerformanceComparison('TEST_V1', [{ source: 'BACKTEST', strategyProfileVersion: 'TEST_V1', sampleSize: 100, hitRate: 62, expectedValue: 1.2, averageReturn: 1.1 }]);
    assert.equal(comparison.sources.PAPER, null);
    assert.equal(comparison.liveVsBacktestHitRateGap, null);
  });

  it('calibration does not expose observed rate before minimum sample size', () => {
    const buckets = calibrateSignalConfidence([{ displayConfidence: 84, success: true }], 30);
    assert.equal(buckets[0]?.sampleStatus, 'INSUFFICIENT_SAMPLE');
    assert.equal(buckets[0]?.observedHitRate, null);
  });
});

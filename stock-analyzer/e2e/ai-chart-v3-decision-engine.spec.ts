import { expect, test } from '@playwright/test';
import {
  calibrateAiChartV3Performance,
  classifyAiChartV3Regime,
  decideAiChartV3,
  type AiChartV3CalibrationEvidence,
  type AiChartV3EngineEvidence,
} from '../src/lib/ai-chart-v3-decision-engine';

const readyCalibration: AiChartV3CalibrationEvidence = {
  sampleN: 120,
  oosSampleN: 40,
  holdoutSampleN: 30,
  shadowSampleN: 25,
  paperSampleN: 25,
  calibratedProbability: 0.6,
  averageWinPct: 2,
  averageLossPct: -1,
  profitFactor: 1.6,
  feesPct: 0.1,
  spreadPct: 0.05,
  slippagePct: 0.05,
  fundingPct: 0.02,
};

function evidence(direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL', score: number): AiChartV3EngineEvidence[] {
  return [
    { engine: 'TECHNICAL', direction, score, weight: 1, available: true, reasons: ['technical'] },
    { engine: 'MTF', direction, score, weight: 1.2, available: true, reasons: ['mtf'] },
    { engine: 'PERFORMANCE', direction, score, weight: 0.8, available: true, reasons: ['performance'] },
  ];
}

test('regime classification fails closed and distinguishes panic/breakout/trend', () => {
  expect(classifyAiChartV3Regime({ sampleN: 10, trendStrength: 80, atrPercentile: 50, volumePercentile: 50, liquidityScore: 80, benchmarkDirection: 50 })).toBe('INSUFFICIENT_DATA');
  expect(classifyAiChartV3Regime({ sampleN: 100, trendStrength: -80, atrPercentile: 98, volumePercentile: 95, liquidityScore: 80, benchmarkDirection: -70 })).toBe('PANIC');
  expect(classifyAiChartV3Regime({ sampleN: 100, trendStrength: 45, atrPercentile: 60, volumePercentile: 85, liquidityScore: 80, benchmarkDirection: 30, breakoutDirection: 'UP' })).toBe('BREAKOUT');
  expect(classifyAiChartV3Regime({ sampleN: 100, trendStrength: 78, atrPercentile: 50, volumePercentile: 50, liquidityScore: 80, benchmarkDirection: 20 })).toBe('STRONG_UPTREND');
});

test('calibration never converts technical score into probability and applies trading costs to EV', () => {
  const insufficient = calibrateAiChartV3Performance({ ...readyCalibration, sampleN: 12, calibratedProbability: 0.95 });
  expect(insufficient.state).toBe('INSUFFICIENT_SAMPLE');
  expect(insufficient.probability).toBeNull();
  expect(insufficient.costAdjustedEvPct).toBeNull();

  const ready = calibrateAiChartV3Performance(readyCalibration);
  expect(ready.state).toBe('READY');
  expect(ready.probability).toBe(0.6);
  expect(ready.totalCostPct).toBeCloseTo(0.22, 8);
  expect(ready.costAdjustedEvPct).toBeCloseTo(0.58, 8);
});

test('crypto futures LONG and SHORT are independently evidenced', () => {
  const common = {
    market: 'BITGET' as const,
    dataQuality: 'FRESH' as const,
    regime: 'UPTREND' as const,
    strategyHealth: 'ACTIVE' as const,
    eventRisk: 'LOW' as const,
    higherTimeframeConflict: false,
    hasPosition: false,
    calibration: readyCalibration,
  };

  const long = decideAiChartV3({ ...common, evidence: evidence('BULLISH', 82) });
  expect(long.decision).toBe('LONG');
  expect(long.longScore).toBeGreaterThan(long.shortScore ?? 0);

  const short = decideAiChartV3({ ...common, regime: 'DOWNTREND', evidence: evidence('BEARISH', 84) });
  expect(short.decision).toBe('SHORT');
  expect(short.shortScore).toBeGreaterThan(short.longScore ?? 0);

  const weakLong = decideAiChartV3({ ...common, evidence: evidence('BULLISH', 55) });
  expect(weakLong.decision).toBe('WAIT');
  expect(weakLong.decision).not.toBe('SHORT');
});

test('cash markets never create a short entry from bearish evidence', () => {
  const result = decideAiChartV3({
    market: 'KR',
    dataQuality: 'FRESH',
    regime: 'DOWNTREND',
    strategyHealth: 'ACTIVE',
    eventRisk: 'LOW',
    higherTimeframeConflict: false,
    hasPosition: false,
    evidence: evidence('BEARISH', 88),
    calibration: readyCalibration,
  });
  expect(result.decision).toBe('WATCH');
  expect(result.reasons).toContain('CASH_MARKET_BEARISH_NO_SHORT_ENTRY');
});

test('HTF conflict, stale data and insufficient samples veto new entries', () => {
  const base = {
    market: 'BITGET' as const,
    regime: 'UPTREND' as const,
    strategyHealth: 'ACTIVE' as const,
    eventRisk: 'LOW' as const,
    hasPosition: false,
    evidence: evidence('BULLISH', 90),
  };
  expect(decideAiChartV3({ ...base, dataQuality: 'FRESH', higherTimeframeConflict: true, calibration: readyCalibration }).decision).toBe('WATCH');
  expect(decideAiChartV3({ ...base, dataQuality: 'STALE', higherTimeframeConflict: false, calibration: readyCalibration }).decision).toBe('NO_TRADE');
  expect(decideAiChartV3({ ...base, dataQuality: 'FRESH', higherTimeframeConflict: false, calibration: { ...readyCalibration, sampleN: 5 } }).decision).toBe('WATCH');
});

test('position-aware invalidation exits without creating an order', () => {
  const result = decideAiChartV3({
    market: 'BITGET',
    dataQuality: 'FRESH',
    regime: 'UPTREND',
    strategyHealth: 'ACTIVE',
    eventRisk: 'LOW',
    higherTimeframeConflict: false,
    hasPosition: true,
    positionSide: 'LONG',
    invalidated: true,
    evidence: evidence('BULLISH', 80),
    calibration: readyCalibration,
  });
  expect(result.decision).toBe('EXIT');
  expect(result.reasons).toEqual(['POSITION_INVALIDATED']);
});

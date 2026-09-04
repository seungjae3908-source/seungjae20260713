import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  calibrateAiChartV3Performance,
  classifyAiChartV3Regime,
  decideAiChartV3,
  type AiChartV3CalibrationEvidence,
  type AiChartV3EngineEvidence,
  type AiChartV3EvidenceIdentity,
} from '../src/lib/ai-chart-v3-decision-engine';

const canonicalIdentity: AiChartV3EvidenceIdentity = {
  market: 'BITGET',
  symbol: 'BTCUSDT',
  timeframe: '15m',
  strategyId: 'SCALPING',
};

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
  provenance: {
    evidenceClass: 'CANONICAL',
    identity: canonicalIdentity,
    datasetDigest: 'a'.repeat(64),
    artifactDigest: 'b'.repeat(64),
    costModelDigest: 'c'.repeat(64),
    observedAt: '2026-09-01T00:00:00.000Z',
  },
};

function evidence(direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL', score: number): AiChartV3EngineEvidence[] {
  return [
    { engine: 'TECHNICAL', direction, score, weight: 1, available: true, reasons: ['technical'] },
    { engine: 'MTF', direction, score, weight: 1.2, available: true, reasons: ['mtf'] },
  ];
}

function decisionBase(overrides: Partial<Parameters<typeof decideAiChartV3>[0]> = {}) {
  return {
    identity: canonicalIdentity,
    market: 'BITGET' as const,
    dataQuality: 'FRESH' as const,
    regime: 'UPTREND' as const,
    strategyHealth: 'ACTIVE' as const,
    eventRisk: 'LOW' as const,
    higherTimeframeConflict: false,
    hasPosition: false,
    evidence: evidence('BULLISH', 82),
    calibration: readyCalibration,
    ...overrides,
  };
}

test('regime classification fails closed and distinguishes panic/breakout/trend', () => {
  expect(classifyAiChartV3Regime({ sampleN: 10, trendStrength: 80, atrPercentile: 50, volumePercentile: 50, liquidityScore: 80, benchmarkDirection: 50 })).toBe('INSUFFICIENT_DATA');
  expect(classifyAiChartV3Regime({ sampleN: Number.NaN, trendStrength: 80, atrPercentile: 50, volumePercentile: 50, liquidityScore: 80, benchmarkDirection: 50 })).toBe('INSUFFICIENT_DATA');
  expect(classifyAiChartV3Regime({ sampleN: 100, trendStrength: 120, atrPercentile: 50, volumePercentile: 50, liquidityScore: 80, benchmarkDirection: 50 })).toBe('INSUFFICIENT_DATA');
  expect(classifyAiChartV3Regime({ sampleN: 100, trendStrength: -80, atrPercentile: 98, volumePercentile: 95, liquidityScore: 80, benchmarkDirection: -70 })).toBe('PANIC');
  expect(classifyAiChartV3Regime({ sampleN: 100, trendStrength: 45, atrPercentile: 60, volumePercentile: 85, liquidityScore: 80, benchmarkDirection: 30, breakoutDirection: 'UP' })).toBe('BREAKOUT');
  expect(classifyAiChartV3Regime({ sampleN: 100, trendStrength: 78, atrPercentile: 50, volumePercentile: 50, liquidityScore: 80, benchmarkDirection: 20 })).toBe('STRONG_UPTREND');
});

test('missing calibration evidence stays missing instead of becoming sample N zero', () => {
  const missing = calibrateAiChartV3Performance(null, canonicalIdentity);
  expect(missing.state).toBe('MISSING_EVIDENCE');
  expect(missing.sampleN).toBeNull();
  expect(missing.probability).toBeNull();
  expect(missing.costAdjustedEvPct).toBeNull();
  expect(missing.totalCostPct).toBeNull();
});

test('calibration never converts technical score into probability and applies trading costs only to canonical same-identity evidence', () => {
  const insufficient = calibrateAiChartV3Performance({ ...readyCalibration, sampleN: 12, calibratedProbability: 0.95 }, canonicalIdentity);
  expect(insufficient.state).toBe('INSUFFICIENT_SAMPLE');
  expect(insufficient.probability).toBeNull();
  expect(insufficient.costAdjustedEvPct).toBeNull();

  const ready = calibrateAiChartV3Performance(readyCalibration, canonicalIdentity);
  expect(ready.state).toBe('READY');
  expect(ready.probability).toBe(0.6);
  expect(ready.totalCostPct).toBeCloseTo(0.22, 8);
  expect(ready.costAdjustedEvPct).toBeCloseTo(0.58, 8);
});

test('non-canonical or identity-mismatched calibration evidence cannot expose probability or EV', () => {
  const fixture = calibrateAiChartV3Performance({
    ...readyCalibration,
    provenance: { ...readyCalibration.provenance, evidenceClass: 'FIXTURE' },
  }, canonicalIdentity);
  expect(fixture.state).toBe('INVALID_EVIDENCE');
  expect(fixture.probability).toBeNull();
  expect(fixture.costAdjustedEvPct).toBeNull();

  const mismatch = calibrateAiChartV3Performance({
    ...readyCalibration,
    provenance: {
      ...readyCalibration.provenance,
      identity: { ...canonicalIdentity, timeframe: '1D' },
    },
  }, canonicalIdentity);
  expect(mismatch.state).toBe('INVALID_EVIDENCE');
  expect(mismatch.probability).toBeNull();
  expect(mismatch.costAdjustedEvPct).toBeNull();
});

test('invalid sample counts or cost evidence fail closed instead of being filtered', () => {
  const invalidCount = calibrateAiChartV3Performance({ ...readyCalibration, sampleN: Number.NaN }, canonicalIdentity);
  expect(invalidCount.state).toBe('INVALID_EVIDENCE');
  expect(invalidCount.sampleN).toBeNull();
  expect(invalidCount.probability).toBeNull();

  const fractionalCount = calibrateAiChartV3Performance({ ...readyCalibration, oosSampleN: 12.5 }, canonicalIdentity);
  expect(fractionalCount.state).toBe('INVALID_EVIDENCE');

  const invalidCost = calibrateAiChartV3Performance({ ...readyCalibration, slippagePct: Number.NaN }, canonicalIdentity);
  expect(invalidCost.state).toBe('INVALID_EVIDENCE');
  expect(invalidCost.totalCostPct).toBeNull();

  const signedFunding = calibrateAiChartV3Performance({ ...readyCalibration, fundingPct: -0.02 }, canonicalIdentity);
  expect(signedFunding.state).toBe('READY');
  expect(signedFunding.totalCostPct).toBeCloseTo(0.18, 8);
});

test('crypto futures LONG and SHORT are independently evidenced', () => {
  const long = decideAiChartV3(decisionBase({ evidence: evidence('BULLISH', 82) }));
  expect(long.decision).toBe('LONG');
  expect(long.longScore).toBeGreaterThan(long.shortScore ?? 0);

  const short = decideAiChartV3(decisionBase({ regime: 'DOWNTREND', evidence: evidence('BEARISH', 84) }));
  expect(short.decision).toBe('SHORT');
  expect(short.shortScore).toBeGreaterThan(short.longScore ?? 0);

  const weakLong = decideAiChartV3(decisionBase({ evidence: evidence('BULLISH', 20) }));
  expect(weakLong.longScore).toBe(20);
  expect(weakLong.shortScore).toBe(0);
  expect(weakLong.decision).toBe('WAIT');
  expect(weakLong.decision).not.toBe('SHORT');
});

test('cash markets never create a short entry from bearish evidence', () => {
  const krIdentity = { ...canonicalIdentity, market: 'KR' as const, symbol: '005930' };
  const result = decideAiChartV3({
    ...decisionBase({
      identity: krIdentity,
      market: 'KR',
      regime: 'DOWNTREND',
      evidence: evidence('BEARISH', 88),
      calibration: {
        ...readyCalibration,
        provenance: { ...readyCalibration.provenance, identity: krIdentity },
      },
    }),
  });
  expect(result.decision).toBe('WATCH');
  expect(result.reasons).toContain('CASH_MARKET_BEARISH_NO_SHORT_ENTRY');
});

test('HTF conflict, stale data, low liquidity, missing regime and insufficient samples veto new entries', () => {
  expect(decideAiChartV3(decisionBase({ higherTimeframeConflict: true })).decision).toBe('WATCH');
  expect(decideAiChartV3(decisionBase({ dataQuality: 'STALE' })).decision).toBe('NO_TRADE');
  expect(decideAiChartV3(decisionBase({ regime: 'LOW_LIQUIDITY' })).decision).toBe('NO_TRADE');
  const missingRegime = decideAiChartV3(decisionBase({ regime: 'INSUFFICIENT_DATA' }));
  expect(missingRegime.decision).toBe('WAIT');
  expect(missingRegime.reasons).toContain('REGIME_EVIDENCE_UNAVAILABLE');
  expect(decideAiChartV3(decisionBase({ calibration: { ...readyCalibration, sampleN: 5 } })).decision).toBe('WATCH');
});

test('unknown strategy health or event risk fails closed to WAIT instead of inventing a safe state', () => {
  const unknownStrategy = decideAiChartV3(decisionBase({ strategyHealth: 'UNKNOWN' }));
  expect(unknownStrategy.decision).toBe('WAIT');
  expect(unknownStrategy.reasons).toContain('STRATEGY_HEALTH_UNAVAILABLE');

  const unknownEvent = decideAiChartV3(decisionBase({ eventRisk: 'UNKNOWN' }));
  expect(unknownEvent.decision).toBe('WAIT');
  expect(unknownEvent.reasons).toContain('EVENT_RISK_UNAVAILABLE');
});

test('missing performance evidence cannot expose calibrated probability or net EV', () => {
  const result = decideAiChartV3(decisionBase({ calibration: null }));
  expect(result.calibrationState).toBe('MISSING_EVIDENCE');
  expect(result.calibratedProbability).toBeNull();
  expect(result.costAdjustedEvPct).toBeNull();
  expect(result.decision).toBe('WATCH');
  expect(result.reasons).toContain('PERFORMANCE_EVIDENCE_UNAVAILABLE');
});

test('strong regime conflict vetoes a contrary new entry', () => {
  const longAgainstBreakdown = decideAiChartV3(decisionBase({ regime: 'BREAKDOWN', evidence: evidence('BULLISH', 90) }));
  expect(longAgainstBreakdown.decision).toBe('WATCH');
  expect(longAgainstBreakdown.reasons).toContain('REGIME_DIRECTION_CONFLICT');

  const shortAgainstBreakout = decideAiChartV3(decisionBase({ regime: 'BREAKOUT', evidence: evidence('BEARISH', 90) }));
  expect(shortAgainstBreakout.decision).toBe('WATCH');
  expect(shortAgainstBreakout.reasons).toContain('REGIME_DIRECTION_CONFLICT');
});

test('position-aware invalidation exits without creating an order', () => {
  const result = decideAiChartV3(decisionBase({
    hasPosition: true,
    positionSide: 'LONG',
    invalidated: true,
    evidence: evidence('BULLISH', 80),
  }));
  expect(result.decision).toBe('EXIT');
  expect(result.reasons).toEqual(['POSITION_INVALIDATED']);
});

test('AI Chart intelligence panel is wired to the V3 decision gate and keeps probability/EV unavailable by default', async () => {
  const panel = await readFile(new URL('../src/components/ai-chart-v2-intelligence-panel.tsx', import.meta.url), 'utf8');
  expect(panel).toContain("from '@/lib/ai-chart-v3-decision-engine'");
  expect(panel).toContain('decideAiChartV3');
  expect(panel).toContain('data-testid="ai-chart-v3-decision-gate"');
  expect(panel).toContain('Calibrated Probability');
  expect(panel).toContain('Cost-adjusted EV');
  expect(panel).toContain('NOT AVAILABLE');
});

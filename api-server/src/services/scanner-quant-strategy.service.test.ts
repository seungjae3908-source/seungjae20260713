import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScannerQualityCandle } from './scanner-data-quality.service';
import {
  runScannerQuantStrategy,
  SCALPING_LIMITS,
  SWING_LIMITS,
  scannerContextTimeframe,
  scannerStrategyTimeframeAllowed,
} from './scanner-quant-strategy.service';

const NOW = Date.parse('2026-08-08T03:30:00.000Z');
const trustedQuality = {
  state: 'TRUSTED' as const,
  score: 100,
  strongSignalAllowed: true,
  issues: [],
  observedCandleCount: 140,
  expectedIntervalMs: 5 * 60_000,
  lastTimestamp: new Date(NOW).toISOString(),
};

function trendCandles(count = 140, volumeMultiplier = 1): ScannerQualityCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const base = 90 + index * 0.15;
    const latest = index === count - 1;
    const open = base;
    const close = base + 0.1;
    return {
      time: NOW - (count - index) * 5 * 60_000,
      open,
      high: close + 0.15,
      low: open - 0.1,
      close,
      volume: (1_000 + index * 3) * (latest ? volumeMultiplier : 1),
    };
  });
}

function fallingCandles(count = 140): ScannerQualityCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const base = 120 - index * 0.15;
    const open = base;
    const close = base - 0.1;
    return {
      time: NOW - (count - index) * 15 * 60_000,
      open,
      high: open + 0.15,
      low: close - 0.15,
      close,
      volume: 1_000 + index * 3,
    };
  });
}

function input(mode: 'scalping' | 'swing', candles = trendCandles()) {
  return {
    mode,
    timeframe: mode === 'scalping' ? '5m' : '1D',
    candles,
    contextCandles: candles,
    price: candles.at(-1)!.close,
    tradingValue: 50_000_000,
    spreadPercent: 0.05,
    riskScore: 20,
    dataQuality: trustedQuality,
    allowShort: false,
  } as const;
}

test('scalping and swing use independent thresholds and risk limits', () => {
  assert.notDeepEqual(SCALPING_LIMITS, SWING_LIMITS);
  assert.ok(SCALPING_LIMITS.maxRiskScore < SWING_LIMITS.maxRiskScore);
  assert.ok(SCALPING_LIMITS.minLiquidityFactor > SWING_LIMITS.minLiquidityFactor);
  assert.equal(scannerStrategyTimeframeAllowed('scalping', '5m'), true);
  assert.equal(scannerStrategyTimeframeAllowed('scalping', '15m'), false);
  assert.equal(scannerStrategyTimeframeAllowed('scalping', '1D'), false);
  assert.equal(scannerStrategyTimeframeAllowed('swing', '4H'), true);
  assert.equal(scannerStrategyTimeframeAllowed('swing', '60m'), false);
  assert.equal(scannerStrategyTimeframeAllowed('swing', '3m'), false);
  assert.equal(scannerContextTimeframe('scalping'), '15m');
  assert.equal(scannerContextTimeframe('swing'), '60m');
});

test('scalping uses 15m context as analysis evidence without exposing it as a primary timeframe', () => {
  const primary = trendCandles();
  const bullishContext = trendCandles().map((row, index) => ({
    ...row,
    time: NOW - (140 - index) * 15 * 60_000,
  }));
  const bearishContext = fallingCandles();
  const bullish = runScannerQuantStrategy({
    ...input('scalping', primary),
    contextCandles: bullishContext,
  });
  const bearish = runScannerQuantStrategy({
    ...input('scalping', primary),
    contextCandles: bearishContext,
  });

  assert.equal(scannerContextTimeframe('scalping'), '15m');
  assert.equal(scannerStrategyTimeframeAllowed('scalping', '15m'), false);
  assert.ok(bullish.factors.trend > bearish.factors.trend);
  assert.ok(bullish.factors.marketRegime > bearish.factors.marketRegime);
  assert.notDeepEqual(bullish.context, bearish.context);
});

test('relative volume spike alone cannot create an S-grade signal', () => {
  const flat = trendCandles(140, 3).map((row, index, all) => ({
    ...row,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: index === all.length - 1 ? 100.05 : 100,
  }));
  const result = runScannerQuantStrategy({
    ...input('scalping', flat),
    aiValidation: {
      status: 'PASS',
      provider: 'test-provider',
      counterEvidence: [],
      missingData: [],
      risks: [],
      explanation: 'AI 검증은 통과했지만 독립 기술 근거를 대신하지 않습니다.',
    },
  });
  assert.equal(result.primary.relativeVolume20! >= 2.5, true);
  assert.equal(result.factors.volume > 50, true);
  assert.equal(result.reasons.includes('독립근거 부족'), true);
  assert.notEqual(result.grade, 'S');
  assert.equal(result.strongSignalEligible, false);
});

test('AI is a validator/veto and no AI validation can promote a signal to S', () => {
  const withoutAi = runScannerQuantStrategy(input('swing'));
  assert.notEqual(withoutAi.grade, 'S');
  assert.equal(withoutAi.aiValidation.status, 'NOT_RUN');

  const vetoed = runScannerQuantStrategy({
    ...input('swing'),
    aiValidation: {
      status: 'VETO',
      provider: 'test-provider',
      counterEvidence: ['반대 추세 확인'],
      missingData: [],
      risks: ['급격한 변동성'],
      explanation: '주문 결정이 아니라 신호를 거부하는 검증입니다.',
    },
  });
  assert.ok(vetoed.score <= 49);
  assert.equal(vetoed.strongSignalEligible, false);
  assert.equal(vetoed.grade, 'D');
  assert.ok(vetoed.warnings.some((warning) => warning.includes('AI 반대근거')));
});

test('DATA_UNTRUSTED caps score and always blocks strong signals', () => {
  const result = runScannerQuantStrategy({
    ...input('scalping'),
    dataQuality: {
      ...trustedQuality,
      state: 'DATA_UNTRUSTED',
      score: 40,
      strongSignalAllowed: false,
      issues: [{ code: 'STALE_TIMESTAMP' as const, severity: 'blocking' as const, message: 'stale' }],
    },
  });
  assert.ok(result.score <= 49);
  assert.equal(result.strongSignalEligible, false);
  assert.notEqual(result.grade, 'S');
});

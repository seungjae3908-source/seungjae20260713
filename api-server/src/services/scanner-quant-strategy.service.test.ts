import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScannerQualityCandle } from './scanner-data-quality.service';
import { buildScannerIndicatorSnapshot, scannerRsi, scannerAtr, scannerAdx, scannerVwap } from './scanner-indicator-library.service';
import {
  runScannerQuantStrategy,
  SCALPING_LIMITS,
  SWING_LIMITS,
  scannerContextTimeframe,
  scannerStrategyForTimeframe,
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

test('default strategy mapping always maps to an allowed primary timeframe', () => {
  const expected = [
    ['1m', 'scalping'],
    ['3m', 'scalping'],
    ['5m', 'scalping'],
    ['15m', 'scalping'],
    ['60m', 'swing'],
    ['4H', 'swing'],
    ['1D', 'position'],
  ] as const;

  for (const [timeframe, mode] of expected) {
    assert.equal(scannerStrategyForTimeframe(timeframe), mode);
    assert.equal(scannerStrategyTimeframeAllowed(mode, timeframe), true);
  }
});

test('scalping and swing use independent thresholds and risk limits', () => {
  assert.notDeepEqual(SCALPING_LIMITS, SWING_LIMITS);
  assert.ok(SCALPING_LIMITS.maxRiskScore < SWING_LIMITS.maxRiskScore);
  assert.ok(SCALPING_LIMITS.minLiquidityFactor > SWING_LIMITS.minLiquidityFactor);
  assert.equal(scannerStrategyTimeframeAllowed('scalping', '5m'), true);
  assert.equal(scannerStrategyTimeframeAllowed('scalping', '15m'), true);
  assert.equal(scannerStrategyTimeframeAllowed('scalping', '1D'), false);
  assert.equal(scannerStrategyTimeframeAllowed('swing', '4H'), true);
  assert.equal(scannerStrategyTimeframeAllowed('swing', '60m'), true);
  assert.equal(scannerStrategyTimeframeAllowed('swing', '3m'), false);
  assert.equal(scannerStrategyTimeframeAllowed('position', '4H'), true);
  assert.equal(scannerStrategyTimeframeAllowed('position', '1D'), true);
  assert.equal(scannerStrategyTimeframeAllowed('position', '60m'), false);
  assert.equal(scannerContextTimeframe('scalping'), '15m');
  assert.equal(scannerContextTimeframe('swing'), '60m');
});

test('scalping supports 15m primary while preserving independent context evidence', () => {
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
  assert.equal(scannerStrategyTimeframeAllowed('scalping', '15m'), true);
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

test('breakout levels exclude the bar being evaluated and flat RSI is neutral', () => {
  const rows = trendCandles(21);
  const priorHigh = Math.max(...rows.slice(0, -1).map((row) => row.high));
  rows.at(-1)!.close = priorHigh + 1;
  rows.at(-1)!.high = priorHigh + 2;
  const snapshot = buildScannerIndicatorSnapshot(rows);
  assert.equal(snapshot.resistance20, priorHigh);
  assert.ok(snapshot.close! > snapshot.resistance20!);
  assert.equal(scannerRsi(Array(30).fill(100)), 50);
  assert.equal(buildScannerIndicatorSnapshot(rows.slice(-20)).resistance20, null);
});

test('RSI/ATR retain Wilder history and ADX smooths DX instead of returning a one-window DX', () => {
  assert.ok(Math.abs(scannerRsi([100, 102, 101, 103, 102], 3)! - 61.53846153846154) < 1e-10);
  const rows = [100, 102, 101, 103, 102, 104].map((close, index) => ({
    time: NOW - (6 - index) * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 1,
  }));
  assert.ok(Math.abs(scannerAtr(rows.slice(0, 5), 3)! - 22 / 9) < 1e-10);
  assert.equal(scannerAdx(rows.slice(0, 5), 3), null, 'ADX requires two-period warmup');
  // Initial two-bar DM sums=(2,1). Smoothed DX=(200/3,700/33,170/3).
  const expectedAdx = (200 / 3 + 700 / 33 + 170 / 3) / 3;
  assert.ok(Math.abs(scannerAdx(rows, 3)! - expectedAdx) < 1e-10);
});

test('session VWAP resets on the exchange-local date instead of depending on the entire downloaded history', () => {
  const row = (time: string, close: number): ScannerQualityCandle => ({ time, open: close, high: close, low: close, close, volume: 100 });
  const kr = [row('20260810153000', 10), row('20260811090000', 100), row('20260811090500', 120)];
  assert.equal(scannerVwap(kr, 'Asia/Seoul'), 110);
  const us = [row('2026-08-10T20:00:00Z', 10), row('2026-08-11T13:30:00Z', 100), row('2026-08-11T13:35:00Z', 120)];
  assert.equal(scannerVwap(us, 'America/New_York'), 110);
  assert.equal(scannerVwap([row('2026-08-10T23:59:00Z', 10), row('2026-08-11T00:00:00Z', 100)], 'UTC'), 100);
});

test('all futures strategies score bearish evidence in SHORT direction without relaxing gates', () => {
  const rows = Array.from({ length: 160 }, (_, index) => {
    const close = 200 - index * 0.5;
    return { time: NOW - (160 - index) * 5 * 60_000,
      open: close + 1, high: close + 1, low: close - 1, close,
      volume: index === 159 ? 400 : 100 };
  });
  for (const mode of ['scalping', 'swing', 'position'] as const) {
    const base = { ...input('swing', rows), mode, allowShort: true, riskScore: 10, spreadPercent: 0.01 };
    const result = runScannerQuantStrategy(base);
    assert.equal(result.direction, 'SHORT', mode);
    assert.ok(result.factors.trend < 50 && result.factors.momentum < 50, mode);
    assert.equal(result.strongSignalEligible, true, `${mode}: ${result.score}`);
    assert.notEqual(result.grade, 'S', 'AI NOT_RUN cannot grant S');
    assert.equal(runScannerQuantStrategy({ ...base, allowShort: false }).direction, 'NEUTRAL');
    assert.equal(runScannerQuantStrategy({ ...base, riskScore: 90 }).strongSignalEligible, false);
    assert.equal(runScannerQuantStrategy({ ...base, dataQuality: {
      ...trustedQuality, state: 'DATA_UNTRUSTED', strongSignalAllowed: false,
    } }).strongSignalEligible, false);
  }
});

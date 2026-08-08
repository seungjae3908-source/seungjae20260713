import test from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedChartCandle } from './chart-candle-normalizer';
import {
  analyzeChartStructure,
  buildMarketStructure,
  detectConfirmedPivots,
  type ConfirmedChartPivot,
} from './chart-structure-engine';

function candles(values: number[], options: { lastClosed?: boolean } = {}): NormalizedChartCandle[] {
  return values.map((close, index) => ({
    time: 1_700_000_000 + index * 300,
    sourceTime: String(1_700_000_000 + index * 300),
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1_000 + index * 10,
    isClosed: index === values.length - 1 ? options.lastClosed ?? true : true,
    closeStateSource: 'provider' as const,
  }));
}

test('a pivot is not emitted until all right-side confirmation candles are closed', () => {
  const incomplete = detectConfirmedPivots(candles([1, 2, 5, 2]), { leftBars: 2, rightBars: 2 });
  const complete = detectConfirmedPivots(candles([1, 2, 5, 2, 1]), { leftBars: 2, rightBars: 2 });
  const openConfirmation = detectConfirmedPivots(candles([1, 2, 5, 2, 1], { lastClosed: false }), { leftBars: 2, rightBars: 2 });
  assert.equal(incomplete.some((pivot) => pivot.kind === 'high'), false);
  assert.equal(openConfirmation.some((pivot) => pivot.kind === 'high'), false);
  assert.equal(complete.filter((pivot) => pivot.kind === 'high').length, 1);
  assert.equal(complete.find((pivot) => pivot.kind === 'high')?.time, 1_700_000_000 + 2 * 300);
});

test('confirmed pivots classify later highs and lows without future references', () => {
  const highPivots = detectConfirmedPivots(candles([1, 2, 5, 2, 1, 2, 6, 2, 1]));
  const highs = highPivots.filter((pivot) => pivot.kind === 'high');
  assert.equal(highs.length, 2);
  assert.equal(highs[0].classification, 'UNCLASSIFIED');
  assert.equal(highs[1].classification, 'HH');

  const lowPivots = detectConfirmedPivots(candles([5, 4, 1, 4, 5, 4, 2, 4, 5]));
  const lows = lowPivots.filter((pivot) => pivot.kind === 'low');
  assert.equal(lows.length, 2);
  assert.equal(lows[1].classification, 'HL');
});

test('market structure becomes bullish only when confirmed high and low classifications agree', () => {
  const pivots: ConfirmedChartPivot[] = [
    { id: 'h1', kind: 'high', candleIndex: 2, time: 2, price: 10, confirmedAtTime: 4, classification: 'UNCLASSIFIED' },
    { id: 'l1', kind: 'low', candleIndex: 4, time: 4, price: 5, confirmedAtTime: 6, classification: 'UNCLASSIFIED' },
    { id: 'h2', kind: 'high', candleIndex: 6, time: 6, price: 12, confirmedAtTime: 8, classification: 'HH' },
    { id: 'l2', kind: 'low', candleIndex: 8, time: 8, price: 7, confirmedAtTime: 10, classification: 'HL' },
  ];
  assert.equal(buildMarketStructure(pivots).trend, 'bullish');
  assert.equal(buildMarketStructure([{ ...pivots[2], classification: 'LH' }, { ...pivots[3], classification: 'HL' }]).trend, 'mixed');
});

test('M pattern remains a bearish candidate until a closed candle breaks the neckline', () => {
  const result = analyzeChartStructure(candles([100, 104, 110, 104, 100, 103, 109.5, 104, 102, 103, 104]));
  const pattern = result.patterns.find((item) => item.type === 'double-top');
  assert.ok(pattern);
  assert.equal(pattern?.label, 'M자 · 이중천장');
  assert.equal(pattern?.bias, 'bearish');
  assert.equal(pattern?.status, 'candidate');
});

test('M pattern confirms below the neckline and invalidates above the reference highs', () => {
  const base = [100, 104, 110, 104, 100, 103, 109.5, 104, 102, 103, 104];
  const confirmed = analyzeChartStructure(candles([...base, 98])).patterns.find((item) => item.type === 'double-top');
  const invalidated = analyzeChartStructure(candles([...base, 112])).patterns.find((item) => item.type === 'double-top');
  assert.equal(confirmed?.status, 'confirmed');
  assert.equal(confirmed?.bias, 'bearish');
  assert.equal(invalidated?.status, 'invalidated');
});

test('an unclosed neckline break cannot confirm an M pattern', () => {
  const base = [100, 104, 110, 104, 100, 103, 109.5, 104, 102, 103, 104];
  const result = analyzeChartStructure(candles([...base, 98], { lastClosed: false }));
  assert.equal(result.patterns.find((item) => item.type === 'double-top')?.status, 'candidate');
});

test('W pattern stays bullish and follows the opposite neckline rules', () => {
  const base = [110, 106, 100, 106, 110, 106, 100.5, 105, 107, 106, 107];
  const candidate = analyzeChartStructure(candles(base)).patterns.find((item) => item.type === 'double-bottom');
  const confirmed = analyzeChartStructure(candles([...base, 112])).patterns.find((item) => item.type === 'double-bottom');
  const invalidated = analyzeChartStructure(candles([...base, 98])).patterns.find((item) => item.type === 'double-bottom');
  assert.equal(candidate?.label, 'W자 · 이중바닥');
  assert.equal(candidate?.bias, 'bullish');
  assert.equal(candidate?.status, 'candidate');
  assert.equal(confirmed?.status, 'confirmed');
  assert.equal(invalidated?.status, 'invalidated');
});

test('pattern identifiers stay stable while status changes for the same anchor pivots', () => {
  const base = [100, 104, 110, 104, 100, 103, 109.5, 104, 102, 103, 104];
  const candidate = analyzeChartStructure(candles(base)).patterns.find((item) => item.type === 'double-top');
  const confirmed = analyzeChartStructure(candles([...base, 98])).patterns.find((item) => item.type === 'double-top');
  assert.ok(candidate && confirmed);
  assert.equal(candidate?.id, confirmed?.id);
  assert.equal(candidate?.anchorPivots[0].time, confirmed?.anchorPivots[0].time);
  assert.equal(candidate?.anchorPivots[1].time, confirmed?.anchorPivots[1].time);
});

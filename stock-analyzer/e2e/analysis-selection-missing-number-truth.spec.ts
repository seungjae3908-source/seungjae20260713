import { expect, test } from '@playwright/test';
import { normalizeAnalysisSelection } from '../src/lib/analysis-selection';

function baseSelection() {
  return {
    assetType: 'stock',
    market: 'KR',
    symbol: '005930',
    ticker: '005930',
    displayName: '삼성전자',
    timeframe: '5m',
    selectedAt: new Date(Date.now() - 1_000).toISOString(),
  };
}

test('missing numeric selection evidence never becomes measured zero', () => {
  const missingValues: unknown[] = [null, '', '   ', false, true, {}, []];

  for (const value of missingValues) {
    const normalized = normalizeAnalysisSelection({
      ...baseSelection(),
      signalScore: value,
      signalRank: value,
      confidence: value,
      pricePlan: {
        entryZone: { from: value, to: value },
        invalidation: value,
        stopLoss: value,
        targets: [value],
        riskReward: value,
      },
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.signalScore).toBeUndefined();
    expect(normalized?.signalRank).toBeUndefined();
    expect(normalized?.confidence).toBeUndefined();
    expect(normalized?.pricePlan).toEqual({
      entryZone: null,
      invalidation: null,
      stopLoss: null,
      targets: [],
      riskReward: null,
    });
  }
});

test('explicit numeric zero remains valid evidence while numeric strings stay supported', () => {
  const numericZero = normalizeAnalysisSelection({
    ...baseSelection(),
    signalScore: 0,
    signalRank: 0,
    confidence: 0,
    pricePlan: {
      entryZone: { from: '70000', to: '70010' },
      invalidation: 0,
      stopLoss: '0',
      targets: ['70100'],
      riskReward: '0',
    },
  });

  expect(numericZero).not.toBeNull();
  expect(numericZero?.signalScore).toBe(0);
  expect(numericZero?.signalRank).toBe(0);
  expect(numericZero?.confidence).toBe(0);
  expect(numericZero?.pricePlan).toEqual({
    entryZone: { from: 70000, to: 70010 },
    invalidation: 0,
    stopLoss: 0,
    targets: [70100],
    riskReward: 0,
  });
});

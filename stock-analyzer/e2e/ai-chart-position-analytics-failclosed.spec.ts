import { expect, test } from '@playwright/test';

import {
  buildPositionGuidance,
  feeInclusiveBreakEvenPrice,
  positionDirection,
  projectPriceOutcome,
  type PositionAnalyticsPosition,
} from '../src/lib/ai-chart-position-analytics';

function position(side: string | null): PositionAnalyticsPosition {
  return {
    quantity: 2,
    averageEntryPrice: 100,
    currentPrice: 110,
    unrealizedPnl: 20,
    liquidationPrice: 60,
    side,
  };
}

test('fails closed when position side is missing or unsupported', () => {
  for (const side of [null, '', 'SIDEWAYS', 'UNKNOWN', 'buy', 'sell']) {
    const value = position(side);
    expect(positionDirection(value)).toBeNull();
    expect(projectPriceOutcome({
      market: 'BITGET',
      position: value,
      chartPrice: 110,
      price: 120,
    })).toBeNull();
    expect(feeInclusiveBreakEvenPrice(value, {
      entryFeePercent: 0.1,
      exitFeePercent: 0.1,
      source: 'USER_INPUT',
    })).toBeNull();
    expect(buildPositionGuidance({ position: value, chartPrice: 110 })).toMatchObject({
      state: 'UNAVAILABLE',
      averageDistancePercent: null,
      stopGapPercent: null,
      targetGapPercent: null,
      liquidationGapPercent: null,
      nearestTarget: null,
      stopPrice: null,
    });
  }
});

test('preserves canonical long and short direction', () => {
  expect(positionDirection(position('LONG'))).toBe(1);
  expect(positionDirection(position(' short '))).toBe(-1);
});

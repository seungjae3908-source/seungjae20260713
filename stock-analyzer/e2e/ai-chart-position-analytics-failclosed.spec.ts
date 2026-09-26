import { expect, test } from '@playwright/test';

import {
  buildPositionGuidance,
  feeInclusiveBreakEvenPrice,
  positionDirection,
  projectPriceOutcome,
  type PositionAnalyticsPosition,
} from '../src/lib/ai-chart-position-analytics';

function position(side: string | null, market: string | null = 'BITGET'): PositionAnalyticsPosition {
  return {
    market,
    quantity: 2,
    averageEntryPrice: 100,
    currentPrice: 110,
    unrealizedPnl: 20,
    liquidationPrice: 60,
    side,
  };
}

test('fails closed when futures position side is missing or unsupported', () => {
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

test('preserves canonical futures direction', () => {
  expect(positionDirection(position('LONG'))).toBe(1);
  expect(positionDirection(position(' short '))).toBe(-1);
});

test('preserves long-only spot and cash truth without fabricating a futures side', () => {
  for (const market of ['KR', 'US', 'UPBIT'] as const) {
    const value = position(null, market);
    expect(positionDirection(value)).toBe(1);
    expect(projectPriceOutcome({ market, position: value, chartPrice: 110, price: 120 })).toMatchObject({
      priceReturnPercent: 20,
      pnlAmount: 40,
      pnlSource: 'POSITION_QUANTITY',
    });
  }
});

test('rejects contradictory side on spot and cash identities', () => {
  for (const market of ['KR', 'US', 'UPBIT'] as const) {
    const value = position('short', market);
    expect(positionDirection(value)).toBeNull();
    expect(projectPriceOutcome({ market, position: value, chartPrice: 110, price: 120 })).toBeNull();
  }
});

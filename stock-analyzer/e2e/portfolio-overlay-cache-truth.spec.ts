import { expect, test } from '@playwright/test';
import {
  parsePortfolioChartOverlays,
  parsePortfolioPurchaseDates,
  syncPortfolioChartOverlays,
} from '../src/lib/portfolio-overlay';

const VALID_OVERLAY = {
  ticker: 'AAPL',
  name: 'Apple',
  market: 'US',
  currency: 'USD',
  averagePrice: 200,
  quantity: 2,
  purchaseDate: '2026-09-01',
  currentPrice: 220,
  rate: 10,
  updatedAt: '2026-09-22T03:00:00.000Z',
} as const;

test('portfolio overlay cache accepts only internally consistent persisted truth', () => {
  expect(parsePortfolioChartOverlays([VALID_OVERLAY])).toEqual([VALID_OVERLAY]);

  expect(parsePortfolioChartOverlays([{
    ...VALID_OVERLAY,
    currency: 'KRW',
  }])).toEqual([]);

  expect(parsePortfolioChartOverlays([{
    ...VALID_OVERLAY,
    quantity: 0,
  }])).toEqual([]);

  expect(parsePortfolioChartOverlays([{
    ...VALID_OVERLAY,
    currentPrice: 220,
    rate: 0,
  }])).toEqual([]);

  expect(parsePortfolioChartOverlays([{
    ...VALID_OVERLAY,
    purchaseDate: '2026-02-31',
  }])).toEqual([]);
});

test('portfolio overlay cache rejects noncanonical or unbounded ticker identities', () => {
  for (const ticker of [
    'aapl',
    ' AAPL ',
    '__PROTO__',
    'AAPL/USD',
    'A'.repeat(33),
  ]) {
    expect(parsePortfolioChartOverlays([{
      ...VALID_OVERLAY,
      ticker,
    }])).toEqual([]);
  }

  expect(parsePortfolioChartOverlays([{
    ...VALID_OVERLAY,
    ticker: 'BRK.B',
  }])).toHaveLength(1);
});

test('portfolio overlay cache never resurrects malformed or duplicate rows after reload parsing', () => {
  const malformed = {
    ...VALID_OVERLAY,
    ticker: 'MSFT',
    updatedAt: 'not-a-time',
  };
  const duplicate = {
    ...VALID_OVERLAY,
    name: 'tampered duplicate',
  };

  expect(parsePortfolioChartOverlays({ rows: [VALID_OVERLAY] })).toEqual([]);
  expect(parsePortfolioChartOverlays([VALID_OVERLAY, malformed, duplicate])).toEqual([VALID_OVERLAY]);
});

test('portfolio overlay cache drops every persisted identity for a same-ticker cross-market conflict', () => {
  const conflictingKr = {
    ...VALID_OVERLAY,
    name: 'KR AAPL',
    market: 'KR' as const,
    currency: 'KRW' as const,
  };
  const unaffected = {
    ...VALID_OVERLAY,
    ticker: 'MSFT',
    name: 'Microsoft',
  };

  expect(parsePortfolioChartOverlays([
    VALID_OVERLAY,
    conflictingKr,
    unaffected,
  ])).toEqual([unaffected]);

  expect(parsePortfolioChartOverlays([
    conflictingKr,
    VALID_OVERLAY,
    unaffected,
  ])).toEqual([unaffected]);
});

test('portfolio overlay cache keeps nullable market facts coherent', () => {
  const noMarketPrice = {
    ...VALID_OVERLAY,
    currentPrice: null,
    rate: null,
  };

  expect(parsePortfolioChartOverlays([noMarketPrice])).toEqual([noMarketPrice]);
  expect(parsePortfolioChartOverlays([{
    ...noMarketPrice,
    rate: 1,
  }])).toEqual([]);
});

test('portfolio purchase-date cache accepts only normalized ticker and real calendar dates', () => {
  expect(parsePortfolioPurchaseDates({
    AAPL: '2026-09-01',
    '005930': '2026-09-02',
  })).toEqual({
    AAPL: '2026-09-01',
    '005930': '2026-09-02',
  });

  expect(parsePortfolioPurchaseDates([
    ['AAPL', '2026-09-01'],
  ])).toEqual({});

  expect(parsePortfolioPurchaseDates({
    aapl: '2026-09-01',
    ' AAPL ': '2026-09-01',
    '__proto__': '2026-09-01',
    MSFT: '2026-02-31',
    TSLA: 20260901,
    NVDA: 'not-a-date',
  })).toEqual({});
});

test('portfolio overlay sync rejects market/currency identity mismatch before persistence', () => {
  expect(() => syncPortfolioChartOverlays([{
    ticker: 'AAPL',
    name: 'Apple',
    market: 'US',
    currency: 'KRW',
    average_price: 200,
    quantity: 1,
    currentPrice: 220,
  }])).toThrow('PORTFOLIO_OVERLAY_IDENTITY_INVALID: AAPL');
});

test('portfolio overlay sync rejects same-ticker cross-market aggregation before persistence', () => {
  expect(() => syncPortfolioChartOverlays([
    {
      ticker: 'ABC',
      name: 'US ABC',
      market: 'US',
      currency: 'USD',
      average_price: 100,
      quantity: 2,
      currentPrice: 110,
    },
    {
      ticker: 'ABC',
      name: 'KR ABC',
      market: 'KR',
      currency: 'KRW',
      average_price: 200,
      quantity: 3,
      currentPrice: 210,
    },
  ])).toThrow('PORTFOLIO_OVERLAY_IDENTITY_CONFLICT: ABC');
});

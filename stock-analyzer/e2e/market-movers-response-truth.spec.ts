import { expect, test } from '@playwright/test';
import { requireMarketMoversResponse } from '../src/lib/market-movers-response';

const NOW = Date.parse('2026-09-09T00:00:00.000Z');

const baseRow = {
  ticker: '005930',
  name: '삼성전자',
  market: 'KR' as const,
  currency: 'KRW' as const,
  price: 85000,
  changePercent: 1.25,
  tradingValue: 120_000_000_000,
  volume: 1_500_000,
  rating: { score: 82 },
};

function success(overrides: Record<string, unknown> = {}) {
  return {
    market: 'KR' as const,
    provider: 'live-market-providers' as const,
    dataStatus: 'complete' as const,
    popular: [baseRow],
    volume: [baseRow],
    recommended: [baseRow],
    gainers: [baseRow],
    losers: [baseRow],
    risky: [baseRow],
    updatedAt: new Date(NOW - 30_000).toISOString(),
    ...overrides,
  };
}

test('canonical fresh movers success remains renderable', () => {
  expect(requireMarketMoversResponse(success(), 'KR', NOW)).toMatchObject({
    market: 'KR',
    provider: 'live-market-providers',
    dataStatus: 'complete',
  });
});

test('malformed HTTP 200 cannot become a safe-looking empty rankings state', () => {
  expect(() => requireMarketMoversResponse({ market: 'KR' }, 'KR', NOW)).toThrow('INVALID_MARKET_MOVERS_RESPONSE');
  expect(() => requireMarketMoversResponse(success({ popular: [] }), 'KR', NOW)).toThrow('INVALID_MARKET_MOVERS_RESPONSE');
  expect(() => requireMarketMoversResponse(success({ volume: undefined }), 'KR', NOW)).toThrow('INVALID_MARKET_MOVERS_RESPONSE');
});

test('cross-market and missing displayed investment facts fail closed', () => {
  expect(() => requireMarketMoversResponse(success({ market: 'US' }), 'KR', NOW)).toThrow('INVALID_MARKET_MOVERS_RESPONSE');
  expect(() => requireMarketMoversResponse(success({ gainers: [{ ...baseRow, changePercent: undefined }] }), 'KR', NOW)).toThrow('INVALID_MARKET_MOVERS_RESPONSE');
  expect(() => requireMarketMoversResponse(success({ losers: [{ ...baseRow, price: 0 }] }), 'KR', NOW)).toThrow('INVALID_MARKET_MOVERS_RESPONSE');
});

test('ranking categories require the evidence used to rank them', () => {
  expect(() => requireMarketMoversResponse(success({ popular: [{ ...baseRow, tradingValue: undefined }] }), 'KR', NOW)).toThrow('INVALID_MARKET_MOVERS_RESPONSE');
  expect(() => requireMarketMoversResponse(success({ volume: [{ ...baseRow, volume: undefined }] }), 'KR', NOW)).toThrow('INVALID_MARKET_MOVERS_RESPONSE');
  expect(() => requireMarketMoversResponse(success({ recommended: [{ ...baseRow, rating: undefined }] }), 'KR', NOW)).toThrow('INVALID_MARKET_MOVERS_RESPONSE');
});

test('stale and future timestamps fail closed instead of looking current', () => {
  expect(() => requireMarketMoversResponse(success({ updatedAt: new Date(NOW - 120_001).toISOString() }), 'KR', NOW)).toThrow('INVALID_MARKET_MOVERS_RESPONSE');
  expect(() => requireMarketMoversResponse(success({ updatedAt: new Date(NOW + 5_001).toISOString() }), 'KR', NOW)).toThrow('INVALID_MARKET_MOVERS_RESPONSE');
});

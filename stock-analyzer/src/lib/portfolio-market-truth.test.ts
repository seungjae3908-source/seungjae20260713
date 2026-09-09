import { describe, expect, it } from 'vitest';
import {
  assertPortfolioMarketEvidence,
  calculateHoldingMarketPerformance,
  calculatePortfolioMarketSummary,
  parsePortfolioQuoteSnapshot,
} from './portfolio-market-truth';

const now = Date.parse('2026-09-10T00:00:00.000Z');

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    quotes: [
      { ticker: '005930', price: 72_000, changePercent: 1.2 },
    ],
    requested: 1,
    available: 1,
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('parsePortfolioQuoteSnapshot', () => {
  it('accepts canonical quote evidence and reports complete coverage', () => {
    const parsed = parsePortfolioQuoteSnapshot(envelope(), ['005930'], now);
    expect(parsed.complete).toBe(true);
    expect(parsed.quotes.get('005930')?.price).toBe(72_000);
  });

  it('preserves genuine partial provider coverage as incomplete evidence', () => {
    const parsed = parsePortfolioQuoteSnapshot(
      envelope({ requested: 2, available: 1 }),
      ['005930', '000660'],
      now,
    );
    expect(parsed.complete).toBe(false);
    expect(parsed.quotes.has('000660')).toBe(false);
  });

  it('rejects malformed, stale, future, count-drift and unrequested success evidence', () => {
    expect(() => parsePortfolioQuoteSnapshot({}, ['005930'], now)).toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
    expect(() => parsePortfolioQuoteSnapshot(envelope({ requested: 2 }), ['005930'], now)).toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
    expect(() => parsePortfolioQuoteSnapshot(envelope({ available: 0 }), ['005930'], now)).toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
    expect(() => parsePortfolioQuoteSnapshot(envelope({ updatedAt: '2026-09-09T23:57:59.000Z' }), ['005930'], now)).toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
    expect(() => parsePortfolioQuoteSnapshot(envelope({ updatedAt: '2026-09-10T00:00:06.000Z' }), ['005930'], now)).toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
    expect(() => parsePortfolioQuoteSnapshot(envelope({ quotes: [{ ticker: 'AAPL', price: 200, changePercent: 1 }] }), ['005930'], now)).toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
    expect(() => parsePortfolioQuoteSnapshot(envelope({ quotes: [{ ticker: '005930', price: 0, changePercent: 1 }] }), ['005930'], now)).toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
  });
});

describe('portfolio market calculations', () => {
  it('fails closed before the existing portfolio UI can turn a missing quote into a fabricated zero return', () => {
    expect(() => assertPortfolioMarketEvidence([
      { ticker: '005930', quantity: 10, average_price: 70_000, currentPrice: null },
    ])).toThrow('PORTFOLIO_MARKET_EVIDENCE_MISSING');

    expect(() => assertPortfolioMarketEvidence([
      { ticker: '005930', quantity: 10, average_price: 70_000, currentPrice: 72_000 },
    ])).not.toThrow();
  });

  it('never replaces a missing current quote with average price / fabricated zero return', () => {
    const rows = [
      { quantity: 10, average_price: 70_000, currentPrice: null },
    ];
    expect(calculatePortfolioMarketSummary(rows)).toEqual({
      cost: 700_000,
      value: null,
      profit: null,
      rate: null,
      evidenceComplete: false,
    });
    expect(calculateHoldingMarketPerformance(rows[0])).toEqual({
      value: null,
      profit: null,
      rate: null,
    });
  });

  it('computes value and return only when every row has market evidence', () => {
    const rows = [
      { quantity: 10, average_price: 70_000, currentPrice: 72_000 },
      { quantity: 2, average_price: 100_000, currentPrice: 90_000 },
    ];
    expect(calculatePortfolioMarketSummary(rows)).toEqual({
      cost: 900_000,
      value: 900_000,
      profit: 0,
      rate: 0,
      evidenceComplete: true,
    });
    expect(calculateHoldingMarketPerformance(rows[0])).toEqual({
      value: 720_000,
      profit: 20_000,
      rate: (2_000 / 70_000) * 100,
    });
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPortfolioQuoteEvidence } from './portfolio-overlay';

test('portfolio quote evidence accepts finite positive current prices', () => {
  assert.doesNotThrow(() => assertPortfolioQuoteEvidence([
    { ticker: '005930', currentPrice: 81200 },
    { ticker: 'AAPL', currentPrice: 237.41 },
  ]));
});

test('portfolio quote evidence fails closed instead of treating missing quotes as break-even', () => {
  assert.throws(
    () => assertPortfolioQuoteEvidence([
      { ticker: '005930', currentPrice: null },
      { ticker: 'AAPL', currentPrice: Number.NaN },
    ]),
    /매입단가를 현재가나 0% 수익률로 대체하지 않습니다/,
  );
});

test('portfolio quote evidence rejects zero and negative prices', () => {
  assert.throws(
    () => assertPortfolioQuoteEvidence([
      { ticker: '005930', currentPrice: 0 },
      { ticker: 'AAPL', currentPrice: -1 },
    ]),
    /005930, AAPL/,
  );
});

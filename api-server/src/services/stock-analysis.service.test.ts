import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStockAnalysis, scoreToAnalysisRating } from './stock-analysis.service';

function candles(count: number, step: number) {
  return Array.from({ length: count }, (_, index) => ({
    time: `2026-09-${String((index % 28) + 1).padStart(2, '0')}`,
    close: 100 + index * step,
    volume: 1_000 + index,
  }));
}

test('builds a stock-detail analysis payload from quote and daily candles only', () => {
  const result = buildStockAnalysis({
    ticker: '005930',
    quote: { price: 70_000, changePercent: 2.5 },
    candles: candles(60, 1),
    candleProvider: 'kiwoom',
    now: new Date('2026-10-17T00:00:00.000Z'),
  });
  assert.ok(result);
  assert.equal(result.ticker, '005930');
  assert.ok(['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL'].includes(result.opinion));
  assert.ok(result.confidence >= 0 && result.confidence <= 100);
  for (const text of [result.opinionReason, result.shortTerm, result.midTerm, result.longTerm, result.conclusion]) {
    assert.equal(typeof text, 'string');
    assert.ok(text.trim().length > 0);
  }
  assert.ok(Array.isArray(result.buyReasons));
  assert.ok(Array.isArray(result.sellReasons));
  assert.equal(result.basis.candleCount, 60);
  assert.equal(result.basis.candleProvider, 'kiwoom');
  assert.equal(result.generatedAt, '2026-10-17T00:00:00.000Z');
  // No evidence-free target/stop prices are produced.
  assert.equal('targetPrice' in result, false);
  assert.equal('strategy' in result, false);
});

test('returns null instead of inventing an opinion when no quote and too little history exist', () => {
  assert.equal(buildStockAnalysis({ ticker: 'AAPL', quote: null, candles: candles(5, 1) }), null);
  assert.equal(buildStockAnalysis({ ticker: 'AAPL', quote: { price: 0, changePercent: 0 }, candles: [] }), null);
});

test('quote-only input still yields a valid payload without RSI', () => {
  const result = buildStockAnalysis({ ticker: 'AAPL', quote: { price: 200, changePercent: -3 }, candles: [] });
  assert.ok(result);
  assert.equal(result.basis.rsi, null);
  assert.ok(result.sellReasons.length >= 1);
});

test('score bands map to ratings', () => {
  assert.equal(scoreToAnalysisRating(80), 'STRONG_BUY');
  assert.equal(scoreToAnalysisRating(62), 'BUY');
  assert.equal(scoreToAnalysisRating(50), 'HOLD');
  assert.equal(scoreToAnalysisRating(30), 'SELL');
  assert.equal(scoreToAnalysisRating(10), 'STRONG_SELL');
});

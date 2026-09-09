import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StockDetailContractError,
  parseStockDetailNews,
  parseStockDetailProfile,
  parseStockDetailQuote,
} from './stock-detail-response';

const quoteFixture = {
  ticker: '005930',
  name: '삼성전자',
  market: 'KR',
  currency: 'KRW',
  price: 70000,
  changePercent: -1.25,
};

test('stock detail quote accepts truthful zero direction but rejects missing quote evidence', () => {
  const parsed = parseStockDetailQuote({ ...quoteFixture, changePercent: 0 }, '005930', 'KR');
  assert.equal(parsed.changePercent, 0);

  assert.throws(
    () => parseStockDetailQuote({ ...quoteFixture, changePercent: undefined }, '005930', 'KR'),
    StockDetailContractError,
  );
  assert.throws(
    () => parseStockDetailQuote({ ...quoteFixture, price: 0 }, '005930', 'KR'),
    StockDetailContractError,
  );
});

test('stock detail quote fails closed on identity and currency drift', () => {
  assert.throws(
    () => parseStockDetailQuote({ ...quoteFixture, ticker: '000660' }, '005930', 'KR'),
    /ticker mismatch/,
  );
  assert.throws(
    () => parseStockDetailQuote({ ...quoteFixture, currency: 'USD' }, '005930', 'KR'),
    /currency mismatch/,
  );
});

test('stock detail profile requires canonical identity instead of accepting arbitrary HTTP 200', () => {
  const parsed = parseStockDetailProfile({ ticker: 'AAPL', name: 'Apple Inc.', sector: 'Technology' }, 'AAPL', 'US');
  assert.equal(parsed.sector, 'Technology');

  assert.throws(() => parseStockDetailProfile({}, 'AAPL', 'US'), StockDetailContractError);
  assert.throws(
    () => parseStockDetailProfile({ ticker: 'MSFT', name: 'Microsoft' }, 'AAPL', 'US'),
    /ticker mismatch/,
  );
});

test('stock detail news preserves legitimate empty evidence but rejects missing arrays', () => {
  const empty = parseStockDetailNews(
    { ticker: 'AAPL', news: [], items: [], summary: '최근 관련 뉴스가 없습니다.' },
    'AAPL',
    'US',
  );
  assert.deepEqual(empty.items, []);

  assert.throws(
    () => parseStockDetailNews({ ticker: 'AAPL', summary: 'ok' }, 'AAPL', 'US'),
    /news arrays are required/,
  );
  assert.throws(
    () => parseStockDetailNews({ ticker: 'AAPL', news: [], items: [{ title: '' }], summary: 'ok' }, 'AAPL', 'US'),
    StockDetailContractError,
  );
});

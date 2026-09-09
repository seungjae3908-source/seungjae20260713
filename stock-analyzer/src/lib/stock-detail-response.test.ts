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

const profileFixture = {
  ticker: 'AAPL',
  name: 'Apple Inc.',
  market: 'US',
  currency: 'USD',
  description: '',
  industry: '',
  sector: 'Technology',
  country: '',
  mainBusiness: '',
  competitors: [] as string[],
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

test('stock detail profile requires canonical producer evidence while preserving explicit empty strings', () => {
  const parsed = parseStockDetailProfile(profileFixture, 'AAPL', 'US');
  assert.equal(parsed.sector, 'Technology');
  assert.equal(parsed.description, '');

  assert.throws(() => parseStockDetailProfile({}, 'AAPL', 'US'), StockDetailContractError);
  assert.throws(
    () => parseStockDetailProfile({ ...profileFixture, ticker: 'MSFT' }, 'AAPL', 'US'),
    /ticker mismatch/,
  );
  assert.throws(
    () => parseStockDetailProfile({ ...profileFixture, currency: undefined }, 'AAPL', 'US'),
    StockDetailContractError,
  );
  assert.throws(
    () => parseStockDetailProfile({ ...profileFixture, competitors: undefined }, 'AAPL', 'US'),
    /invalid competitors/,
  );
  assert.throws(
    () => parseStockDetailProfile({ ...profileFixture, sector: undefined }, 'AAPL', 'US'),
    StockDetailContractError,
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

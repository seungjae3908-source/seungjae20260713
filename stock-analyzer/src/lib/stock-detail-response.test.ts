import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StockDetailContractError,
  isStockInfoResponsePath,
  parseStockDetailNews,
  parseStockDetailProfile,
  parseStockDetailQuote,
  requireStockInfoSuccessResponse,
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

test('stock info path matcher is bounded to the basic stock-info consumers', () => {
  assert.equal(isStockInfoResponsePath('/api/stocks/005930/quote'), true);
  assert.equal(isStockInfoResponsePath('/api/stocks/special-feed'), true);
  assert.equal(isStockInfoResponsePath('/api/stocks/005930/chart'), false);
  assert.equal(isStockInfoResponsePath('/api/quotes'), false);
});

test('financials require canonical producer structure and preserve explicit empty evidence', () => {
  const financials = { annual: [], quarterly: [], ratios: {} };
  const parsed = requireStockInfoSuccessResponse('/api/stocks/AAPL/financials', {
    ticker: 'AAPL',
    financials,
    ...financials,
    items: [],
    summary: '실제 공개 재무 데이터를 불러왔습니다.',
  });
  assert.deepEqual(parsed.items, []);
  assert.throws(
    () => requireStockInfoSuccessResponse('/api/stocks/AAPL/financials', { ticker: 'AAPL', items: [] }),
    StockDetailContractError,
  );
});

test('market flow accepts explicit unavailable truth but rejects safe-looking malformed and future evidence', () => {
  const unavailable = {
    ticker: 'AAPL',
    period: 'daily',
    available: false,
    rows: [],
    totals: {
      individual: null,
      institution: null,
      foreign: null,
      program: null,
      volume: null,
      value: null,
      tradeValue: null,
    },
    message: '해외 종목의 투자자별 수급은 현재 제공처에서 지원하지 않습니다.',
  };
  assert.equal(
    requireStockInfoSuccessResponse('/api/stocks/AAPL/market-flow?period=daily', unavailable).available,
    false,
  );
  assert.throws(
    () => requireStockInfoSuccessResponse('/api/stocks/AAPL/market-flow?period=daily', { ticker: 'AAPL', available: false, rows: [] }),
    StockDetailContractError,
  );

  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  assert.throws(
    () => requireStockInfoSuccessResponse('/api/stocks/005930/market-flow?period=daily', {
      ticker: '005930',
      period: 'daily',
      available: true,
      rows: [{ date: '2026.09.10', individual: 1, institution: -2, foreign: 1 }],
      totals: { individual: 1, institution: -2, foreign: 1, program: null, volume: null, value: null, tradeValue: null },
      provider: 'NAVER_FINANCE',
      source: 'NAVER_FINANCE',
      asOf: '2026.09.10',
      updatedAt: future,
    }),
    /future/,
  );
});

test('short-selling distinguishes explicit unavailable truth from malformed success', () => {
  const parsed = requireStockInfoSuccessResponse('/api/stocks/AAPL/short-selling?period=weekly', {
    ticker: 'AAPL',
    available: false,
    rows: [],
    latest: null,
    message: '해외 공매도 데이터는 별도 제공처 연동이 필요합니다.',
  });
  assert.equal(parsed.available, false);
  assert.throws(
    () => requireStockInfoSuccessResponse('/api/stocks/AAPL/short-selling?period=weekly', {
      ticker: 'AAPL', available: false, rows: [], latest: null,
    }),
    StockDetailContractError,
  );
});

test('disclosures preserve canonical empty result but reject missing identity and evidence arrays', () => {
  const parsed = requireStockInfoSuccessResponse('/api/stocks/005930/disclosures?all=1', {
    ticker: '005930', disclosures: [], filings: [], items: [], summary: '최근 공시가 없습니다.',
  });
  assert.deepEqual(parsed.items, []);
  assert.throws(
    () => requireStockInfoSuccessResponse('/api/stocks/005930/disclosures?all=1', { disclosures: [], items: [] }),
    StockDetailContractError,
  );
});

test('special feed validates market/count/policy/freshness while allowing a truthful empty feed', () => {
  const now = new Date().toISOString();
  const parsed = requireStockInfoSuccessResponse('/api/stocks/special-feed?asset=stock&market=KR', {
    ok: true,
    market: 'KR',
    items: [],
    count: 0,
    catalogSize: 25,
    scannedNow: 8,
    nextCursor: 8,
    updatedAt: now,
    ttlMinutes: 60,
    refreshSeconds: 30,
    note: '현재 앱 종목 목록을 순환 확인합니다.',
  });
  assert.equal(parsed.count, 0);

  assert.throws(
    () => requireStockInfoSuccessResponse('/api/stocks/special-feed?asset=stock&market=KR', {
      ok: true,
      market: 'KR',
      items: [],
      count: 1,
      catalogSize: 25,
      scannedNow: 8,
      nextCursor: 8,
      updatedAt: now,
      ttlMinutes: 60,
      refreshSeconds: 30,
      note: 'x',
    }),
    /count mismatch/,
  );

  assert.throws(
    () => requireStockInfoSuccessResponse('/api/stocks/special-feed?asset=stock&market=US', {
      ok: true,
      market: 'KR',
      items: [],
      count: 0,
      catalogSize: 25,
      scannedNow: 0,
      nextCursor: 0,
      updatedAt: now,
      ttlMinutes: 60,
      refreshSeconds: 30,
      note: 'x',
    }),
    /market mismatch/,
  );
});

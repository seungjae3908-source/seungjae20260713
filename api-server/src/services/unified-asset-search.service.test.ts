import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUnifiedAssetId,
  extractHangulChoseong,
  normalizeSearchText,
  searchUnifiedAssetDocuments,
  type UnifiedAssetDocument,
} from '../lib/search-normalization';

const now = '2026-08-04T06:00:00.000Z';

function document(input: Partial<UnifiedAssetDocument> & Pick<UnifiedAssetDocument, 'assetType' | 'market' | 'exchange' | 'productCode' | 'displayName'>): UnifiedAssetDocument {
  const base: UnifiedAssetDocument = {
    id: '',
    assetType: input.assetType,
    market: input.market,
    instrumentType: input.assetType === 'stock' ? 'stock' : input.market === 'futures' ? 'futures' : 'spot',
    exchange: input.exchange,
    ticker: input.ticker,
    symbol: input.symbol,
    productCode: input.productCode,
    koreanName: input.koreanName ?? '',
    englishName: input.englishName ?? '',
    displayName: input.displayName,
    aliases: input.aliases ?? [],
    baseSymbol: input.baseSymbol ?? input.ticker ?? input.symbol ?? input.productCode,
    quoteCurrency: input.quoteCurrency ?? (input.market === 'KR' || input.market === 'spot' ? 'KRW' : input.market === 'US' ? 'USD' : 'USDT'),
    active: input.active ?? true,
    provider: input.provider ?? 'fixture',
    dataAsOf: now,
    liquidityRank: input.liquidityRank ?? null,
  };
  base.id = createUnifiedAssetId(base);
  return base;
}

const fixtures = [
  document({ assetType: 'stock', market: 'KR', exchange: 'KOSPI', productCode: '005930', ticker: '005930', koreanName: '삼성전자', englishName: 'Samsung Electronics', displayName: '삼성전자', aliases: ['삼성', '삼전', 'samsung'], liquidityRank: 1 }),
  document({ assetType: 'stock', market: 'US', exchange: 'NASDAQ', productCode: 'TSLA', ticker: 'TSLA', koreanName: '테슬라', englishName: 'Tesla', displayName: '테슬라', aliases: ['tesla motors'], liquidityRank: 2 }),
  document({ assetType: 'stock', market: 'US', exchange: 'NYSE', productCode: 'BRK.B', ticker: 'BRK.B', koreanName: '버크셔 해서웨이', englishName: 'Berkshire Hathaway', displayName: '버크셔 해서웨이', aliases: ['BRKB', 'berkshire'], liquidityRank: 3 }),
  document({ assetType: 'coin', market: 'spot', exchange: 'UPBIT', productCode: 'KRW-BTC', symbol: 'BTC', koreanName: '비트코인', englishName: 'Bitcoin', displayName: '비트코인', aliases: ['BTC/KRW', 'BTC-KRW', 'bitcoin'], baseSymbol: 'BTC', quoteCurrency: 'KRW', liquidityRank: 1 }),
  document({ assetType: 'coin', market: 'futures', exchange: 'BITGET', productCode: 'BTCUSDT', symbol: 'BTCUSDT', koreanName: '비트코인', englishName: 'Bitcoin', displayName: '비트코인', aliases: ['BTC/USDT', 'BTC-USDT'], baseSymbol: 'BTC', quoteCurrency: 'USDT', liquidityRank: 1 }),
  document({ assetType: 'coin', market: 'futures', exchange: 'BITGET', productCode: 'OLDUSDT', symbol: 'OLDUSDT', koreanName: '올드코인', englishName: 'Old Coin', displayName: '올드코인', aliases: [], baseSymbol: 'OLD', quoteCurrency: 'USDT', active: false }),
];

test('normalizes NFKC, case, whitespace and separators without losing leading zeroes', () => {
  assert.equal(normalizeSearchText('  ＴＳＬＡ  ').lower, 'tsla');
  assert.equal(normalizeSearchText('BTC / KRW').separatorless, 'btckrw');
  assert.equal(normalizeSearchText('005930').compact, '005930');
  assert.equal(normalizeSearchText('Samsung   Electronics').lower, 'samsung electronics');
});

test('extracts Hangul choseong search keys', () => {
  assert.equal(extractHangulChoseong('삼성전자'), 'ㅅㅅㅈㅈ');
  assert.equal(extractHangulChoseong('비트코인'), 'ㅂㅌㅋㅇ');
});

test('supports one-character Korean prefixes and aliases', () => {
  assert.equal(searchUnifiedAssetDocuments(fixtures, '삼', { limit: 25 })[0]?.document.productCode, '005930');
  assert.equal(searchUnifiedAssetDocuments(fixtures, '테슬라', { limit: 25 })[0]?.document.productCode, 'TSLA');
  assert.equal(searchUnifiedAssetDocuments(fixtures, 'samsung', { limit: 25 })[0]?.document.productCode, '005930');
});

test('keeps exact codes above names, aliases and fuzzy matches', () => {
  const code = searchUnifiedAssetDocuments(fixtures, '005930');
  assert.equal(code[0]?.matchType, 'code_exact');
  assert.equal(code[0]?.document.productCode, '005930');
  const ticker = searchUnifiedAssetDocuments(fixtures, 'TSLA');
  assert.equal(ticker[0]?.matchType, 'code_exact');
  assert.equal(ticker[0]?.document.productCode, 'TSLA');
});

test('matches dotted US tickers with or without separators', () => {
  assert.equal(searchUnifiedAssetDocuments(fixtures, 'BRK.B')[0]?.document.productCode, 'BRK.B');
  assert.equal(searchUnifiedAssetDocuments(fixtures, 'BRKB')[0]?.document.productCode, 'BRK.B');
});

test('matches slash, hyphen and separatorless coin product forms', () => {
  assert.equal(searchUnifiedAssetDocuments(fixtures, 'BTC/KRW')[0]?.document.market, 'spot');
  assert.equal(searchUnifiedAssetDocuments(fixtures, 'BTC-KRW')[0]?.document.market, 'spot');
  assert.equal(searchUnifiedAssetDocuments(fixtures, 'BTCUSDT')[0]?.document.market, 'futures');
});

test('does not merge spot and futures documents with the same base symbol', () => {
  const btc = searchUnifiedAssetDocuments(fixtures, 'BTC', { limit: 10 });
  assert.deepEqual(new Set(btc.map((item) => item.document.market)), new Set(['spot', 'futures']));
  assert.notEqual(fixtures[3].id, fixtures[4].id);
});

test('supports choseong and constrained typo matching below exact results', () => {
  assert.equal(searchUnifiedAssetDocuments(fixtures, 'ㅅㅅㅈㅈ')[0]?.document.productCode, '005930');
  const typo = searchUnifiedAssetDocuments(fixtures, 'Teslz');
  assert.equal(typo[0]?.document.productCode, 'TSLA');
  assert.equal(typo[0]?.matchType, 'fuzzy');
});

test('ranks active products above delisted products for otherwise equivalent matches', () => {
  const active = document({ assetType: 'coin', market: 'futures', exchange: 'BITGET', productCode: 'NEWUSDT', symbol: 'NEWUSDT', englishName: 'New Coin', displayName: 'New Coin', aliases: ['new'], baseSymbol: 'NEW', active: true });
  const inactive = document({ assetType: 'coin', market: 'futures', exchange: 'BITGET', productCode: 'NEW-OLD', symbol: 'NEW-OLD', englishName: 'New Coin', displayName: 'New Coin', aliases: ['new'], baseSymbol: 'NEW', active: false });
  assert.equal(searchUnifiedAssetDocuments([inactive, active], 'New Coin')[0]?.document.id, active.id);
});

const krCoverage = [
  ['005930', '삼성전자', 'Samsung Electronics'],
  ['000660', 'SK하이닉스', 'SK Hynix'],
  ['005380', '현대차', 'Hyundai Motor'],
  ['035420', '네이버', 'NAVER'],
  ['035720', '카카오', 'Kakao'],
  ['051910', 'LG화학', 'LG Chem'],
  ['207940', '삼성바이오로직스', 'Samsung Biologics'],
  ['068270', '셀트리온', 'Celltrion'],
  ['005490', 'POSCO홀딩스', 'POSCO Holdings'],
  ['105560', 'KB금융', 'KB Financial'],
] as const;
const usCoverage = [
  ['TSLA', '테슬라', 'Tesla'], ['NVDA', '엔비디아', 'NVIDIA'], ['AAPL', '애플', 'Apple'],
  ['MSFT', '마이크로소프트', 'Microsoft'], ['AMZN', '아마존', 'Amazon'], ['GOOGL', '구글', 'Alphabet'],
  ['META', '메타', 'Meta Platforms'], ['AMD', 'AMD', 'Advanced Micro Devices'], ['COIN', '코인베이스', 'Coinbase'],
  ['PLTR', '팔란티어', 'Palantir Technologies'],
] as const;
const coinCoverage = [
  ['BTC', '비트코인', 'Bitcoin'], ['ETH', '이더리움', 'Ethereum'], ['XRP', '리플', 'XRP'],
  ['SOL', '솔라나', 'Solana'], ['DOGE', '도지코인', 'Dogecoin'], ['ADA', '에이다', 'Cardano'],
  ['AVAX', '아발란체', 'Avalanche'], ['LINK', '체인링크', 'Chainlink'], ['DOT', '폴카닷', 'Polkadot'],
  ['TRX', '트론', 'TRON'],
] as const;

const broadCoverageDocuments = [
  ...krCoverage.map(([ticker, koreanName, englishName], index) => document({ assetType: 'stock', market: 'KR', exchange: 'KOSPI', productCode: ticker, ticker, koreanName, englishName, displayName: koreanName, liquidityRank: index + 1 })),
  ...usCoverage.map(([ticker, koreanName, englishName], index) => document({ assetType: 'stock', market: 'US', exchange: 'NASDAQ', productCode: ticker, ticker, koreanName, englishName, displayName: koreanName, liquidityRank: index + 1 })),
  ...coinCoverage.flatMap(([symbol, koreanName, englishName], index) => [
    document({ assetType: 'coin', market: 'spot', exchange: 'UPBIT', productCode: `KRW-${symbol}`, symbol, koreanName, englishName, displayName: koreanName, aliases: [`${symbol}/KRW`, `${symbol}-KRW`], baseSymbol: symbol, quoteCurrency: 'KRW', liquidityRank: index + 1 }),
    document({ assetType: 'coin', market: 'futures', exchange: 'BITGET', productCode: `${symbol}USDT`, symbol: `${symbol}USDT`, koreanName, englishName, displayName: koreanName, aliases: [`${symbol}/USDT`, `${symbol}-USDT`], baseSymbol: symbol, quoteCurrency: 'USDT', liquidityRank: index + 1 }),
  ]),
];

test('covers at least ten supported assets in every market group', () => {
  for (const [ticker, koreanName, englishName] of krCoverage) {
    assert.equal(searchUnifiedAssetDocuments(broadCoverageDocuments, ticker, { market: 'KR' })[0]?.document.productCode, ticker);
    assert.equal(searchUnifiedAssetDocuments(broadCoverageDocuments, koreanName, { market: 'KR' })[0]?.document.productCode, ticker);
    assert.equal(searchUnifiedAssetDocuments(broadCoverageDocuments, englishName, { market: 'KR' })[0]?.document.productCode, ticker);
  }
  for (const [ticker, koreanName, englishName] of usCoverage) {
    assert.equal(searchUnifiedAssetDocuments(broadCoverageDocuments, ticker, { market: 'US' })[0]?.document.productCode, ticker);
    assert.equal(searchUnifiedAssetDocuments(broadCoverageDocuments, koreanName, { market: 'US' })[0]?.document.productCode, ticker);
    assert.equal(searchUnifiedAssetDocuments(broadCoverageDocuments, englishName, { market: 'US' })[0]?.document.productCode, ticker);
  }
  for (const [symbol, koreanName, englishName] of coinCoverage) {
    assert.equal(searchUnifiedAssetDocuments(broadCoverageDocuments, `${symbol}/KRW`, { market: 'spot' })[0]?.document.productCode, `KRW-${symbol}`);
    assert.equal(searchUnifiedAssetDocuments(broadCoverageDocuments, `${symbol}USDT`, { market: 'futures' })[0]?.document.productCode, `${symbol}USDT`);
    assert.equal(searchUnifiedAssetDocuments(broadCoverageDocuments, koreanName, { market: 'spot' })[0]?.document.baseSymbol, symbol);
    assert.equal(searchUnifiedAssetDocuments(broadCoverageDocuments, englishName, { market: 'futures' })[0]?.document.baseSymbol, symbol);
  }
});

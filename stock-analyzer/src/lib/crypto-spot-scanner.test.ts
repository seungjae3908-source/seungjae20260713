import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CRYPTO_SPOT_FILTERS,
  compareCryptoSpotRows,
  scanCryptoSpotMarket,
  scoreCryptoSpotTicker,
  type CryptoSpotMarket,
  type CryptoSpotTicker,
} from './crypto-spot-scanner';

const NOW = Date.now();
const markets: CryptoSpotMarket[] = [
  { market: 'KRW-BTC', symbol: 'BTC', koreanName: '비트코인', englishName: 'Bitcoin', warning: false },
  { market: 'KRW-ETH', symbol: 'ETH', koreanName: '이더리움', englishName: 'Ethereum', warning: false },
  { market: 'KRW-RISK', symbol: 'RISK', koreanName: '유의코인', englishName: 'Risk', warning: true },
];

function ticker(symbol: string, overrides: Partial<CryptoSpotTicker> = {}): CryptoSpotTicker {
  return {
    market: `KRW-${symbol}`, symbol, price: 100, change: 'RISE', changeRate: 0.02,
    changePercent: 2, changePrice: 2, high24h: 110, low24h: 80, volume24h: 1_000_000,
    tradingValue24h: 10_000_000_000, timestamp: NOW,
    ...overrides,
  };
}

test('scores fresh liquid spot data and identifies breakout and pullback structures', () => {
  const breakout = scoreCryptoSpotTicker(ticker('BTC', { price: 109, changePercent: 8 }), markets[0], NOW);
  assert.equal(breakout.dataState, 'ok');
  assert.equal(breakout.liquidityPass, true);
  assert.ok(breakout.matched.includes('24시간 고가 돌파 근접'));

  const pullback = scoreCryptoSpotTicker(ticker('ETH', { price: 98, high24h: 120, low24h: 70, changePercent: 2 }), markets[1], NOW);
  assert.ok(pullback.matched.includes('상승 후 눌림 구간'));
});

test('marks stale, warning, low-liquidity and chase-risk rows with higher risk', () => {
  const row = scoreCryptoSpotTicker(ticker('RISK', {
    changePercent: 20,
    tradingValue24h: 100_000_000,
    timestamp: NOW - 180_000,
  }), markets[2], NOW);
  assert.equal(row.dataState, 'stale');
  assert.equal(row.warning, true);
  assert.equal(row.chaseRisk, true);
  assert.ok(row.riskScore >= 90);
  assert.ok(row.warnings.includes('급등 추격 위험'));
});

test('deduplicates by newest timestamp and applies deterministic score-value-volume-symbol sorting', () => {
  const result = scanCryptoSpotMarket(markets, [
    ticker('BTC', { timestamp: NOW - 1_000, price: 90 }),
    ticker('BTC', { timestamp: NOW, price: 100 }),
    ticker('ETH', { timestamp: NOW, price: 100 }),
  ], { ...DEFAULT_CRYPTO_SPOT_FILTERS, minimumScore: 0, maximumRiskScore: 100 }, NOW);
  assert.equal(result.scanned, 2);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.rows.find((row) => row.symbol === 'BTC')?.price, 100);
  const sorted = [...result.rows].sort(compareCryptoSpotRows);
  assert.deepEqual(result.rows.map((row) => row.symbol), sorted.map((row) => row.symbol));
});

test('filters surge, pullback, stale, warning, score and risk without mixing non-KRW markets', () => {
  const result = scanCryptoSpotMarket(markets, [
    ticker('BTC', { changePercent: 15 }),
    ticker('ETH', { price: 98, high24h: 120, low24h: 70, changePercent: 2 }),
    ticker('RISK'),
    { ...ticker('USDT'), market: 'USDT-BTC' },
  ], {
    ...DEFAULT_CRYPTO_SPOT_FILTERS,
    trend: 'surge',
    minimumScore: 0,
    maximumRiskScore: 100,
    excludeWarnings: true,
    excludeStale: true,
  }, NOW);
  assert.deepEqual(result.rows.map((row) => row.symbol), ['BTC']);
  assert.equal(result.scanned, 3);
});

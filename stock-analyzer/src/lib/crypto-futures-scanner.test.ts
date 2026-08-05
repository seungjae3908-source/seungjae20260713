import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CRYPTO_FUTURES_FILTERS,
  compareCryptoFuturesRows,
  scanCryptoFuturesMarket,
  scoreCryptoFuturesTicker,
  type CryptoFuturesCandle,
  type CryptoFuturesTicker,
} from './crypto-futures-scanner';

const NOW = Date.now();

function ticker(symbol: string, overrides: Partial<CryptoFuturesTicker> = {}): CryptoFuturesTicker {
  return {
    symbol, price: 100, markPrice: 100, indexPrice: 100, changeRate24h: 0.02,
    changePercent24h: 2, changePercent: 2, high24h: 110, low24h: 80,
    volume24h: 1_000_000, tradingValue24h: 50_000_000, fundingRate: 0.0001,
    fundingRatePercent: 0.01, openInterest: 1_000_000, bidPrice: 99.95, askPrice: 100.05,
    timestamp: NOW,
    ...overrides,
  };
}

function candles(direction: 'up' | 'down' = 'up', breakout = false): CryptoFuturesCandle[] {
  return Array.from({ length: 35 }, (_, index) => {
    const base = direction === 'up' ? 80 + index * 0.6 : 120 - index * 0.6;
    const close = breakout && index === 34 ? base + 8 : base;
    return {
      time: NOW - (35 - index) * 60_000,
      open: close - (direction === 'up' ? 0.2 : -0.2),
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: index === 34 && breakout ? 3_000 : 1_000,
    };
  });
}

test('scores bullish and bearish technical structures using public candles', () => {
  const long = scoreCryptoFuturesTicker(ticker('BTCUSDT', { changePercent24h: 5 }), candles('up', true), NOW);
  assert.ok(long.longScore > long.shortScore);
  assert.ok(long.matched.includes('상승 추세'));
  assert.ok(long.matched.includes('거래량 증가'));

  const short = scoreCryptoFuturesTicker(ticker('ETHUSDT', { changePercent24h: -7 }), candles('down'), NOW);
  assert.ok(short.shortScore > short.longScore);
  assert.ok(short.matched.includes('하락 추세'));
});

test('raises risk for stale, illiquid, wide-spread, funding and chase conditions', () => {
  const row = scoreCryptoFuturesTicker(ticker('RISKUSDT', {
    changePercent24h: 20,
    tradingValue24h: 100_000,
    bidPrice: 90,
    askPrice: 100,
    fundingRatePercent: 0.3,
    timestamp: NOW - 180_000,
  }), [], NOW);
  assert.equal(row.dataState, 'stale');
  assert.equal(row.chaseRisk, true);
  assert.ok(row.riskScore >= 90);
  assert.ok(row.warnings.includes('기술 캔들 부족'));
});

test('deduplicates newest ticker and sorts ties by value, OI, then symbol', () => {
  const map = new Map<string, CryptoFuturesCandle[]>([
    ['BTCUSDT', candles('up')],
    ['ETHUSDT', candles('up')],
  ]);
  const result = scanCryptoFuturesMarket([
    ticker('BTCUSDT', { timestamp: NOW - 1_000, markPrice: 90 }),
    ticker('BTCUSDT', { timestamp: NOW, markPrice: 100 }),
    ticker('ETHUSDT', { timestamp: NOW, markPrice: 100 }),
  ], map, { ...DEFAULT_CRYPTO_FUTURES_FILTERS, minimumScore: 0, maximumRiskScore: 100, excludeChaseRisk: false }, NOW);
  assert.equal(result.scanned, 2);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.rows.find((row) => row.symbol === 'BTCUSDT')?.markPrice, 100);
  const sorted = [...result.rows].sort(compareCryptoFuturesRows);
  assert.deepEqual(result.rows.map((row) => row.symbol), sorted.map((row) => row.symbol));
});

test('applies direction, volume, breakout, pullback, score and risk filters independently', () => {
  const candleMap = new Map<string, CryptoFuturesCandle[]>([
    ['BTCUSDT', candles('up', true)],
    ['ETHUSDT', candles('down')],
  ]);
  const result = scanCryptoFuturesMarket([
    ticker('BTCUSDT', { changePercent24h: 5 }),
    ticker('ETHUSDT', { changePercent24h: -5 }),
  ], candleMap, {
    ...DEFAULT_CRYPTO_FUTURES_FILTERS,
    direction: 'LONG',
    technical: 'volume',
    minimumScore: 0,
    maximumRiskScore: 100,
    excludeChaseRisk: false,
  }, NOW);
  assert.deepEqual(result.rows.map((row) => row.symbol), ['BTCUSDT']);
});

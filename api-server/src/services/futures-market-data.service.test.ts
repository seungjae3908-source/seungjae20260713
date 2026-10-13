import './bitget-futures-public-evidence.service.test';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBasis,
  calculateOpenInterestChangePercent,
  calculateSpreadPercent,
  classifyDataStatus,
  normalizeBitgetCandles,
  normalizeFuturesMarketFlowEvidence,
  normalizeFuturesSymbol,
  resolveSnapshotTimestampStatus,
  toFiniteNumber,
} from './futures-market-data.service';

test('toFiniteNumber keeps valid numbers and zero', () => {
  assert.equal(toFiniteNumber('12.5'), 12.5);
  assert.equal(toFiniteNumber(0), 0);
  assert.equal(toFiniteNumber('0'), 0);
});

test('toFiniteNumber rejects empty and non-finite values', () => {
  assert.equal(toFiniteNumber(''), null);
  assert.equal(toFiniteNumber('   '), null);
  assert.equal(toFiniteNumber(undefined), null);
  assert.equal(toFiniteNumber(null), null);
  assert.equal(toFiniteNumber(Number.NaN), null);
  assert.equal(toFiniteNumber(Number.POSITIVE_INFINITY), null);
  assert.equal(toFiniteNumber(Number.NEGATIVE_INFINITY), null);
});

test('futures symbol normalization accepts supported input shapes', () => {
  for (const value of ['BTC', 'BTCUSDT', 'BTC-USDT', 'BTC/USDT', 'btcusdt']) {
    assert.equal(normalizeFuturesSymbol(value), 'BTCUSDT');
  }
  assert.equal(normalizeFuturesSymbol('BTC$USDT'), null);
});

test('basis calculation follows mark minus index formula', () => {
  assert.deepEqual(calculateBasis(101, 100), { basis: 1, basisPercent: 1 });
});

test('basis calculation blocks zero division and missing values', () => {
  assert.deepEqual(calculateBasis(101, 0), { basis: null, basisPercent: null });
  assert.deepEqual(calculateBasis(null, 100), { basis: null, basisPercent: null });
});

test('spread calculation uses midpoint and rejects inverted book', () => {
  assert.equal(calculateSpreadPercent(99, 101), 2);
  assert.equal(calculateSpreadPercent(101, 99), null);
  assert.equal(calculateSpreadPercent(0, 1), null);
});

test('open interest change calculation rejects invalid previous values', () => {
  assert.equal(calculateOpenInterestChangePercent(110, 100), 10);
  assert.equal(calculateOpenInterestChangePercent(110, 0), null);
  assert.equal(calculateOpenInterestChangePercent(110, null), null);
});

test('candle normalization sorts timestamps and removes duplicates', () => {
  const now = Date.UTC(2026, 0, 1, 1, 0, 0);
  const result = normalizeBitgetCandles([
    ['1767225600000', '100', '105', '99', '103', '10', '1000'],
    ['1767225540000', '98', '102', '97', '100', '9', '900'],
    ['1767225600000', '100', '106', '99', '104', '11', '1100'],
  ], 'BTCUSDT', '1m', now);
  assert.equal(result.data.length, 2);
  assert.ok(result.data[0].timestamp < result.data[1].timestamp);
  assert.equal(result.data[1].close, 104);
  assert.ok(result.warnings.some((warning) => warning.includes('중복 timestamp')));
});

test('candle normalization removes invalid OHLC rows', () => {
  const result = normalizeBitgetCandles([
    ['1767225600000', '100', '90', '95', '96', '10', '1000'],
    ['1767225660000', '100', '105', '99', '106', '10', '1000'],
    ['1767225720000', '100', '105', '99', '103', '10', '1000'],
  ], 'BTCUSDT', '1m', Date.UTC(2026, 0, 1, 1, 0, 0));
  assert.equal(result.data.length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('OHLC')));
});

test('data status uses timeframe-aware stale threshold', () => {
  const now = 1_000_000;
  assert.equal(classifyDataStatus({
    now,
    lastTimestamp: now - 80_000,
    timeframeMs: 60_000,
    count: 30,
    minimumCount: 25,
  }), 'live');
  assert.equal(classifyDataStatus({
    now,
    lastTimestamp: now - 200_000,
    timeframeMs: 60_000,
    count: 30,
    minimumCount: 25,
  }), 'delayed');
});

test('empty candle data is insufficient without fabricated rows', () => {
  const result = normalizeBitgetCandles([], 'BTCUSDT', '15m', Date.now());
  assert.equal(result.status, 'insufficient');
  assert.deepEqual(result.data, []);
  assert.ok(result.warnings.some((warning) => warning.includes('사용 가능한 캔들')));
});

test('snapshot without exchange timestamp is insufficient instead of live', () => {
  const result = resolveSnapshotTimestampStatus({
    now: 1_700_000_000_000,
    sourceTimestamps: [null, undefined, '', Number.NaN],
    availableCoreValues: 5,
  });
  assert.equal(result.sourceTimestamp, null);
  assert.equal(result.status, 'insufficient');
  assert.equal(result.warning, '거래소 데이터 시각을 확인할 수 없습니다.');
});

test('snapshot keeps live status when a valid exchange timestamp exists', () => {
  const now = 1_700_000_000_000;
  const result = resolveSnapshotTimestampStatus({
    now,
    sourceTimestamps: [now - 10_000],
    availableCoreValues: 5,
  });
  assert.equal(result.sourceTimestamp, now - 10_000);
  assert.equal(result.status, 'live');
  assert.equal(result.warning, null);
});


test('futures flow keeps selected-symbol long-short and liquidation evidence read-only', () => {
  const now = Date.UTC(2026, 8, 26, 3, 0, 0);
  const result = normalizeFuturesMarketFlowEvidence({
    symbol: 'SUIUSDT',
    now,
    longShortPayload: {
      code: '00000',
      data: [{
        symbol: 'SUIUSDT',
        longRatio: '0.58',
        shortRatio: '0.42',
        longShortRatio: '1.380952',
        ts: String(now - 10_000),
      }],
    },
    liquidationPayload: {
      code: '00000',
      data: {
        list: [
          { symbol: 'SUIUSDT', side: 'buy', amount: '1200', ts: String(now - 8_000) },
          { symbol: 'SUIUSDT', side: 'sell', amount: '800', ts: String(now - 7_000) },
          { symbol: 'BTCUSDT', side: 'buy', amount: '999999', ts: String(now - 6_000) },
        ],
      },
    },
  });
  assert.equal(result.symbol, 'SUIUSDT');
  assert.equal(result.longRatio, 0.58);
  assert.equal(result.shortRatio, 0.42);
  assert.equal(result.longShortRatio, 1.380952);
  assert.equal(result.longLiquidationAmount, 1200);
  assert.equal(result.shortLiquidationAmount, 800);
  assert.equal(result.liquidationCount, 2);
  assert.equal(result.status, 'live');
  assert.equal(result.publicDataOnly, true);
  assert.equal(result.directionalScoreImpact, 0);
  assert.equal(result.probabilityImpact, 0);
  assert.equal(result.executionAuthority, 'NONE');
});

test('futures flow never coerces missing ratio or liquidation evidence to zero', () => {
  const result = normalizeFuturesMarketFlowEvidence({
    symbol: 'SUIUSDT',
    now: Date.UTC(2026, 8, 26, 3, 0, 0),
    longShortPayload: { code: '00000', data: [] },
    liquidationPayload: { code: '00000', data: { list: [] } },
  });
  assert.equal(result.longRatio, null);
  assert.equal(result.shortRatio, null);
  assert.equal(result.longShortRatio, null);
  assert.equal(result.longLiquidationAmount, null);
  assert.equal(result.shortLiquidationAmount, null);
  assert.equal(result.liquidationCount, 0);
  assert.equal(result.status, 'insufficient');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKTEST_MARKET_PROFILES,
  BacktestMarketContractError,
  buildBacktestPerformanceKey,
  normalizeBacktestSymbol,
  validateBacktestMarketOrder,
} from './backtest-market-profile.service';

test('cash markets use BUY/SELL and reject short-style actions', () => {
  for (const market of ['kr-stock', 'us-stock', 'crypto-spot'] as const) {
    assert.deepEqual(BACKTEST_MARKET_PROFILES[market].allowedActions, ['BUY', 'SELL']);
    assert.equal(BACKTEST_MARKET_PROFILES[market].shortOpeningAllowed, false);
    assert.throws(
      () => validateBacktestMarketOrder({ market, action: 'SHORT', leverage: 1 }),
      (error: unknown) => error instanceof BacktestMarketContractError && error.code === 'ACTION_NOT_ALLOWED',
    );
  }
});

test('cash SELL is reduce-or-exit only', () => {
  assert.throws(
    () => validateBacktestMarketOrder({ market: 'crypto-spot', action: 'SELL', leverage: 1, hasOpenPosition: false }),
    (error: unknown) => error instanceof BacktestMarketContractError && error.code === 'CASH_SELL_WITHOUT_POSITION',
  );
  assert.equal(
    validateBacktestMarketOrder({ market: 'crypto-spot', action: 'SELL', leverage: 1, hasOpenPosition: true }),
    'REDUCE_OR_EXIT',
  );
});

test('cash markets reject leverage and funding while futures allow LONG/SHORT', () => {
  assert.throws(
    () => validateBacktestMarketOrder({ market: 'kr-stock', action: 'BUY', leverage: 2 }),
    (error: unknown) => error instanceof BacktestMarketContractError && error.code === 'INVALID_MARKET_LEVERAGE',
  );
  assert.throws(
    () => validateBacktestMarketOrder({ market: 'us-stock', action: 'BUY', leverage: 1, fundingRatePerInterval: 0.0001 }),
    (error: unknown) => error instanceof BacktestMarketContractError && error.code === 'FUNDING_NOT_APPLICABLE',
  );
  assert.equal(validateBacktestMarketOrder({ market: 'crypto-futures', action: 'LONG', leverage: 3 }), 'OPEN_OR_ADD');
  assert.equal(validateBacktestMarketOrder({ market: 'crypto-futures', action: 'SHORT', leverage: 3 }), 'OPEN_OR_ADD');
});

test('symbols are normalized by market without guessing another market', () => {
  assert.equal(normalizeBacktestSymbol('kr-stock', '005930'), '005930');
  assert.equal(normalizeBacktestSymbol('us-stock', 'brk.b'), 'BRK.B');
  assert.equal(normalizeBacktestSymbol('crypto-spot', 'krw/btc'), 'KRW-BTC');
  assert.equal(normalizeBacktestSymbol('crypto-futures', 'btc-usdt'), 'BTCUSDT');
  assert.throws(() => normalizeBacktestSymbol('kr-stock', 'AAPL'));
  assert.throws(() => normalizeBacktestSymbol('crypto-spot', 'BTCUSDT'));
});

test('performance keys keep market, strategy, action, timeframe and regime separated', () => {
  assert.equal(
    buildBacktestPerformanceKey({
      market: 'crypto-futures', strategy: 'breakout', timeframe: '5m', action: 'SHORT', regime: 'bear',
    }),
    'crypto-futures|breakout|5m|SHORT|bear|backtest-market-v1',
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKTEST_MARKET_PROFILES,
  BacktestMarketContractError,
  buildBacktestPerformanceKey,
  normalizeBacktestSymbol,
  validateBacktestMarketOrder,
} from './backtest-market-profile.service';
import { runCashBacktest, type CashBacktestCandle } from './cash-backtest-engine.service';
import { loadUpbitBacktestCandles } from './upbit-backtest-data.service';

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

function cashCandles(count = 100): CashBacktestCandle[] {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_value, index) => {
    const close = index < 60 ? 100 + index * 0.1 : 106 + (index - 60) * 0.8;
    return {
      timestamp: start + index * 60_000,
      open: close - 0.2,
      high: close + (index === 75 ? 5 : 0.5),
      low: close - (index === 75 ? 5 : 0.5),
      close,
      volume: index >= 60 ? 2_000 : 1_000,
      quoteVolume: close * (index >= 60 ? 2_000 : 1_000),
      timeframe: '1m', symbol: 'KRW-BTC', market: 'crypto-spot', source: 'test', isClosed: true,
    };
  });
}

test('Upbit loader normalizes historical candles without submitting orders', async () => {
  const now = Date.UTC(2026, 0, 1, 0, 5);
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify([
    { market: 'KRW-BTC', candle_date_time_utc: '2026-01-01T00:04:00', opening_price: 104, high_price: 105, low_price: 103, trade_price: 104.5, candle_acc_trade_price: 1000, candle_acc_trade_volume: 10 },
    { market: 'KRW-BTC', candle_date_time_utc: '2026-01-01T00:03:00', opening_price: 103, high_price: 104, low_price: 102, trade_price: 103.5, candle_acc_trade_price: 900, candle_acc_trade_volume: 9 },
  ]), { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await loadUpbitBacktestCandles({
    symbol: 'krw-btc', timeframe: '1m', startTime: Date.UTC(2026, 0, 1, 0, 3),
    endTime: Date.UTC(2026, 0, 1, 0, 4), now, fetchImpl,
  });
  assert.equal(result.orderSubmitted, false);
  assert.deepEqual(result.candles.map((candle) => candle.timestamp), [Date.UTC(2026, 0, 1, 0, 3), Date.UTC(2026, 0, 1, 0, 4)]);
});

test('cash engine performs BUY then reduce-or-exit SELL with fees and slippage', () => {
  const result = runCashBacktest({
    market: 'crypto-spot', symbol: 'KRW-BTC', timeframe: '1m', initialCapital: 1_000_000,
    strategy: 'breakout', parameters: { lookback: 20, volumePeriod: 20, volumeMultiplier: 1.2 },
    riskPercent: 0.2, entryFeeRate: 0.0005, exitFeeRate: 0.0005, slippageRate: 0.0002,
    stopLossPercent: 1, takeProfitR: 1.5, maximumTradesPerDay: 10, intrabarPriority: 'stop_first',
  }, cashCandles());
  assert.equal(result.orderSubmitted, false);
  assert.ok(result.totalTrades >= 1);
  assert.ok(result.totalFees > 0);
  assert.ok(result.totalSlippage > 0);
  assert.ok(result.trades.every((trade) => trade.quantity > 0));
});

test('cash engine uses stop-first when stop and target touch within one candle', () => {
  const result = runCashBacktest({
    market: 'crypto-spot', symbol: 'KRW-BTC', timeframe: '1m', initialCapital: 1_000_000,
    strategy: 'breakout', parameters: { lookback: 20, volumePeriod: 20, volumeMultiplier: 1.2 },
    riskPercent: 0.2, entryFeeRate: 0, exitFeeRate: 0, slippageRate: 0,
    stopLossPercent: 1, takeProfitR: 1, maximumTradesPerDay: 10, intrabarPriority: 'stop_first',
  }, cashCandles());
  assert.ok(result.trades.some((trade) => trade.exitReason === 'stop_loss'));
});

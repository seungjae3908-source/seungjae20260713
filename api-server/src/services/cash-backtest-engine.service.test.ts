import assert from 'node:assert/strict';
import test from 'node:test';
import { runCashBacktest, type CashBacktestCandle } from './cash-backtest-engine.service';
import { loadUpbitBacktestCandles } from './upbit-backtest-data.service';

function makeCandles(count = 100): CashBacktestCandle[] {
  const start = Date.UTC(2026, 0, 1);
  const candles: CashBacktestCandle[] = [];
  for (let index = 0; index < count; index += 1) {
    const trend = index < 60 ? index * 0.2 : 12 + (index - 60) * 0.8;
    const close = 100 + trend;
    candles.push({
      timestamp: start + index * 60_000,
      open: close - 0.2,
      high: close + (index === 75 ? 5 : 0.5),
      low: close - (index === 75 ? 5 : 0.5),
      close,
      volume: index >= 60 ? 2_000 : 1_000,
      quoteVolume: close * (index >= 60 ? 2_000 : 1_000),
      timeframe: '1m',
      symbol: 'KRW-BTC',
      market: 'crypto-spot',
      source: 'test',
      isClosed: true,
    });
  }
  return candles;
}

test('Upbit 과거 캔들을 오래된 순서로 정규화하고 미완료 봉을 제외한다', async () => {
  const now = Date.UTC(2026, 0, 1, 0, 5);
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify([
    {
      market: 'KRW-BTC', candle_date_time_utc: '2026-01-01T00:04:00', opening_price: 104,
      high_price: 105, low_price: 103, trade_price: 104.5, candle_acc_trade_price: 1000, candle_acc_trade_volume: 10,
    },
    {
      market: 'KRW-BTC', candle_date_time_utc: '2026-01-01T00:03:00', opening_price: 103,
      high_price: 104, low_price: 102, trade_price: 103.5, candle_acc_trade_price: 900, candle_acc_trade_volume: 9,
    },
  ]), { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await loadUpbitBacktestCandles({
    symbol: 'krw-btc', timeframe: '1m', startTime: Date.UTC(2026, 0, 1, 0, 3),
    endTime: Date.UTC(2026, 0, 1, 0, 4), now, fetchImpl,
  });
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.provider, 'upbit');
  assert.deepEqual(result.candles.map((candle) => candle.timestamp), [Date.UTC(2026, 0, 1, 0, 3), Date.UTC(2026, 0, 1, 0, 4)]);
  assert.equal(result.candles[0].symbol, 'KRW-BTC');
});

test('현물 백테스트는 BUY 후 SELL만 수행하고 수수료·슬리피지를 차감한다', () => {
  const result = runCashBacktest({
    market: 'crypto-spot', symbol: 'KRW-BTC', timeframe: '1m', initialCapital: 1_000_000,
    strategy: 'breakout', parameters: { lookback: 20, volumePeriod: 20, volumeMultiplier: 1.2 },
    riskPercent: 0.2, entryFeeRate: 0.0005, exitFeeRate: 0.0005, slippageRate: 0.0002,
    stopLossPercent: 1, takeProfitR: 1.5, maximumTradesPerDay: 10, intrabarPriority: 'stop_first',
  }, makeCandles());
  assert.equal(result.ok, true);
  assert.equal(result.orderSubmitted, false);
  assert.ok(result.totalTrades >= 1);
  assert.ok(result.totalFees > 0);
  assert.ok(result.totalSlippage > 0);
  assert.ok(result.trades.every((trade) => trade.quantity > 0));
});

test('동일 봉에서 손절과 목표가가 모두 닿으면 손절 우선으로 처리한다', () => {
  const result = runCashBacktest({
    market: 'crypto-spot', symbol: 'KRW-BTC', timeframe: '1m', initialCapital: 1_000_000,
    strategy: 'breakout', parameters: { lookback: 20, volumePeriod: 20, volumeMultiplier: 1.2 },
    riskPercent: 0.2, entryFeeRate: 0, exitFeeRate: 0, slippageRate: 0,
    stopLossPercent: 1, takeProfitR: 1, maximumTradesPerDay: 10, intrabarPriority: 'stop_first',
  }, makeCandles());
  assert.ok(result.trades.length > 0);
  assert.ok(result.trades.some((trade) => trade.exitReason === 'stop_loss'));
});

test('현물 엔진은 선물 시장을 거부한다', () => {
  assert.throws(() => runCashBacktest({
    market: 'crypto-futures' as never, symbol: 'BTCUSDT', timeframe: '1m', initialCapital: 1_000_000,
    strategy: 'breakout', riskPercent: 0.2, entryFeeRate: 0, exitFeeRate: 0, slippageRate: 0,
    stopLossPercent: 1, takeProfitR: 1.5, maximumTradesPerDay: 10,
  }, makeCandles()), /현물 백테스트 시장/);
});

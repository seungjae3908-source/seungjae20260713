import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCashSignals, runCashBacktest, type CashBacktestCandle } from './cash-backtest-engine.service';
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

function makeRegimeCandles(mode: 'bull' | 'bear-then-bounce', count = 2_000): CashBacktestCandle[] {
  const start = Date.UTC(2026, 0, 1);
  let close = mode === 'bull' ? 100 : 300;
  return Array.from({ length: count }, (_value, index) => {
    if (mode === 'bull') close += 0.5;
    else close += index < count - 120 ? -0.05 : 0.8;
    return {
      timestamp: start + index * 15 * 60_000,
      open: close - 0.1,
      high: close + 0.1,
      low: close - 0.2,
      close,
      volume: 2_000,
      quoteVolume: close * 2_000,
      timeframe: '15m',
      symbol: 'KRW-BTC',
      market: 'crypto-spot',
      source: 'test',
      isClosed: true,
    };
  });
}

function makeConfirmedPullbackCandles(count = 2_200) {
  const candles = makeRegimeCandles('bull', count);
  const pullbackIndex = count - 80;
  const previous = candles[pullbackIndex - 1];
  candles[pullbackIndex] = {
    ...candles[pullbackIndex],
    open: previous.close + 0.1,
    high: previous.close + 0.2,
    low: 1,
    close: previous.close + 0.05,
  };
  candles[pullbackIndex + 1] = {
    ...candles[pullbackIndex + 1],
    open: previous.close + 0.05,
    high: previous.close + 0.7,
    low: previous.close,
    close: previous.close + 0.6,
  };
  candles[pullbackIndex + 2] = {
    ...candles[pullbackIndex + 2],
    open: previous.close + 0.9,
    high: previous.close + 1.2,
    low: previous.close + 0.7,
    close: previous.close + 1,
  };
  return candles;
}

const regimeParameters = {
  lookback: 20,
  volumePeriod: 20,
  volumeMultiplier: 1,
  regimeFilterEnabled: 1,
  regimeFastPeriod1h: 12,
  regimeSlowPeriod1h: 26,
  regimeFastPeriod4h: 12,
  regimeSlowPeriod4h: 26,
  minimumTrendSlopePercent: 0,
  cooldownBars: 16,
  atrPeriod: 14,
  minimumBreakoutAtr: 0.1,
};

function request(parameters: Record<string, number>) {
  return {
    market: 'crypto-spot' as const,
    symbol: 'KRW-BTC',
    timeframe: '15m',
    initialCapital: 1_000_000,
    strategy: 'breakout' as const,
    parameters,
    riskPercent: 0.2,
    entryFeeRate: 0,
    exitFeeRate: 0,
    slippageRate: 0,
    stopLossPercent: 1,
    takeProfitR: 1.5,
    maximumTradesPerDay: 10,
    intrabarPriority: 'stop_first' as const,
  };
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

test('market-regime-v2는 완료된 1시간·4시간 상승 추세에서만 매수 신호를 허용한다', () => {
  const bullishSignals = calculateCashSignals(request(regimeParameters), makeRegimeCandles('bull'));
  const bearishCandles = makeRegimeCandles('bear-then-bounce');
  const unfilteredSignals = calculateCashSignals(request({ ...regimeParameters, regimeFilterEnabled: 0 }), bearishCandles);
  const filteredSignals = calculateCashSignals(request(regimeParameters), bearishCandles);
  assert.ok(bullishSignals.some((signal) => signal.action === 'BUY'));
  assert.ok(unfilteredSignals.some((signal) => signal.action === 'BUY'));
  assert.equal(filteredSignals.filter((signal) => signal.action === 'BUY').length, 0);
});

test('재진입 대기시간은 연속 돌파 신호 수를 줄인다', () => {
  const candles = makeRegimeCandles('bull');
  const withoutCooldown = calculateCashSignals(request({ ...regimeParameters, cooldownBars: 0 }), candles)
    .filter((signal) => signal.action === 'BUY').length;
  const withCooldown = calculateCashSignals(request({ ...regimeParameters, cooldownBars: 32 }), candles)
    .filter((signal) => signal.action === 'BUY').length;
  assert.ok(withoutCooldown > 0);
  assert.ok(withCooldown > 0);
  assert.ok(withCooldown < withoutCooldown);
});

test('RSI 범위는 과열된 돌파 진입을 차단한다', () => {
  const candles = makeRegimeCandles('bull');
  const unfiltered = calculateCashSignals(request({ ...regimeParameters, maximumEntryRsi: 100 }), candles)
    .filter((signal) => signal.action === 'BUY').length;
  const filtered = calculateCashSignals(request({ ...regimeParameters, maximumEntryRsi: 60 }), candles)
    .filter((signal) => signal.action === 'BUY').length;
  assert.ok(unfiltered > 0);
  assert.equal(filtered, 0);
});

test('조기 전략청산 비활성화 시 strategy_exit 거래가 생성되지 않는다', () => {
  const result = runCashBacktest({
    ...request({ ...regimeParameters, regimeFilterEnabled: 0, strategyExitEnabled: 0, maximumEntryRsi: 100 }),
    stopLossPercent: 1,
    takeProfitR: 2,
  }, makeRegimeCandles('bull'));
  assert.ok(result.totalTrades > 0);
  assert.ok(result.trades.every((trade) => trade.exitReason !== 'strategy_exit'));
});

test('regime_pullback은 눌림 확인 뒤 다음 봉 시가에 진입하고 ATR 손절을 사용한다', () => {
  const candles = makeConfirmedPullbackCandles();
  const parameters = {
    regimeFilterEnabled: 1,
    regimeFastPeriod1h: 12,
    regimeSlowPeriod1h: 26,
    regimeFastPeriod4h: 12,
    regimeSlowPeriod4h: 26,
    minimumTrendSlopePercent: 0,
    fastPeriod: 20,
    slowPeriod: 50,
    pullbackTolerancePercent: 0,
    maximumExtensionPercent: 100,
    volumePeriod: 20,
    volumeMultiplier: 0,
    rsiPeriod: 14,
    minimumEntryRsi: 0,
    maximumEntryRsi: 100,
    cooldownBars: 16,
    strategyExitEnabled: 0,
    entryOnNextOpen: 1,
    executionAtrPeriod: 14,
    stopAtrMultiplier: 1.5,
  };
  const signalRequest = { ...request(parameters), strategy: 'regime_pullback' as const };
  const firstBuy = calculateCashSignals(signalRequest, candles).find((signal) => signal.action === 'BUY');
  assert.ok(firstBuy);
  assert.ok(firstBuy.index + 1 < candles.length);
  const result = runCashBacktest({ ...signalRequest, takeProfitR: 2 }, candles);
  assert.ok(result.totalTrades > 0);
  assert.equal(result.trades[0].entryPrice, candles[firstBuy.index + 1].open);
  assert.ok(result.warnings.some((warning) => warning.includes('다음 완료 봉의 시가')));
  assert.ok(result.warnings.some((warning) => warning.includes('ATR(14)')));
  assert.equal(result.orderSubmitted, false);
});

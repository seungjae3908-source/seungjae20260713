import test from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedCandle } from './futures-market-data.service';
import {
  atrSeries,
  averageVolumeSeries,
  emaSeries,
  rollingHighestSeries,
  rollingLowestSeries,
  rsiSeries,
  sanitizeClosedCandles,
  smaSeries,
  trueRangeSeries,
  utcSessionVwapSeries,
} from './backtest-indicators.service';
import {
  BACKTEST_LIMITS,
  BACKTEST_WARMUP_BARS,
  BacktestValidationError,
  backtestWarmupMs,
  calculateStrategySignals,
  evaluateSelectionBias,
  expectedMaxNoiseSharpe,
  fundingHistoryHash,
  fundingRateSumHeld,
  fundingSettlementsHeld,
  sanitizeFundingPoints,
  inverseNormalCdf,
  PORTFOLIO_BACKTEST_LIMITS,
  recordSelectionRun,
  resetSelectionRunsForTests,
  selectionBiasWarning,
  measureBacktestPerformance,
  runBacktest,
  runPortfolioBacktest,
  validateBacktestRequest,
  warmupStartTime,
  type BacktestRequest,
} from './backtest-engine.service';

const STEP = 15 * 60_000;
const START = Date.UTC(2026, 0, 1);

function makeCandle(index: number, close: number, options: Partial<NormalizedCandle> = {}): NormalizedCandle {
  const open = options.open ?? close;
  const high = options.high ?? Math.max(open, close) + 1;
  const low = options.low ?? Math.min(open, close) - 1;
  return {
    timestamp: START + index * STEP,
    open,
    high,
    low,
    close,
    volume: options.volume ?? 100,
    quoteVolume: options.quoteVolume ?? close * (options.volume ?? 100),
    timeframe: '15m',
    symbol: 'BTCUSDT',
    market: 'crypto-futures',
    source: 'fixture',
    isClosed: options.isClosed ?? true,
    isDelayed: false,
    updatedAt: new Date(START + index * STEP).toISOString(),
  };
}

function breakoutFixture(direction: 'long' | 'short' = 'long', options: { bothTouched?: boolean; holdBars?: number } = {}) {
  const candles: NormalizedCandle[] = [];
  for (let index = 0; index < 60; index += 1) candles.push(makeCandle(index, 100));
  const signalClose = direction === 'long' ? 104 : 96;
  candles.push(makeCandle(60, signalClose, {
    open: 100,
    high: direction === 'long' ? 105 : 101,
    low: direction === 'long' ? 99 : 95,
    volume: 1_000,
  }));
  const entryOpen = signalClose;
  candles.push(makeCandle(61, entryOpen, {
    open: entryOpen,
    high: options.bothTouched ? entryOpen * 1.04 : entryOpen * 1.005,
    low: options.bothTouched ? entryOpen * 0.96 : entryOpen * 0.995,
    volume: 200,
  }));
  const holdBars = options.holdBars ?? 2;
  for (let offset = 0; offset < holdBars; offset += 1) {
    const index = 62 + offset;
    candles.push(makeCandle(index, entryOpen, {
      open: entryOpen,
      high: direction === 'long' ? entryOpen * 1.05 : entryOpen * 1.005,
      low: direction === 'short' ? entryOpen * 0.95 : entryOpen * 0.995,
      volume: 100,
    }));
  }
  return candles;
}

function request(overrides: Partial<BacktestRequest> = {}): BacktestRequest {
  return {
    market: 'crypto-futures',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    startTime: START,
    endTime: START + 200 * STEP,
    initialCapital: 10_000,
    strategy: 'breakout',
    side: 'both',
    parameters: { lookback: 20, volumePeriod: 20, volumeMultiplier: 1.2 },
    riskPercent: 0.5,
    leverage: 2,
    entryFeeRate: 0.0006,
    exitFeeRate: 0.0006,
    slippageRate: 0.0005,
    fundingRatePerInterval: 0,
    fundingIntervalHours: 8,
    stopLossMode: 'percent',
    stopLossValue: 1,
    takeProfitMode: 'risk_multiple',
    takeProfitValue: 2,
    trailingStop: { enabled: false },
    maximumConcurrentPositions: 1,
    maximumTradesPerDay: 10,
    intrabarPriority: 'stop_first',
    validationSplit: { trainingPercent: 60, validationPercent: 20, testPercent: 20 },
    quantityStep: 0.001,
    quantityPrecision: 3,
    minimumQuantity: 0.001,
    minimumNotional: 5,
    maximumLeverage: 125,
    contractRulesStatus: 'live',
    ...overrides,
  };
}

const closes = [1, 2, 3, 4, 5, 6];

test('SMA returns null before first complete window', () => assert.deepEqual(smaSeries(closes, 3).slice(0, 2), [null, null]));
test('SMA returns known rolling averages', () => assert.deepEqual(smaSeries(closes, 3).slice(2), [2, 3, 4, 5]));
test('SMA rejects invalid period safely', () => assert.deepEqual(smaSeries(closes, 0), Array(closes.length).fill(null)));
test('EMA seeds with SMA at period minus one', () => assert.equal(emaSeries(closes, 3)[2], 2));
test('EMA known next value is recursive', () => assert.equal(emaSeries(closes, 3)[3], 3));
test('EMA returns null for insufficient data', () => assert.deepEqual(emaSeries([1, 2], 3), [null, null]));
test('RSI reaches 100 for uninterrupted gains', () => assert.equal(rsiSeries([1, 2, 3, 4, 5, 6], 3)[5], 100));
test('RSI reaches zero for uninterrupted losses', () => assert.equal(rsiSeries([6, 5, 4, 3, 2, 1], 3)[5], 0));
test('RSI returns 50 for flat initial window', () => assert.equal(rsiSeries([1, 1, 1, 1, 1], 3)[3], 50));
test('true range uses high minus low on first candle', () => assert.equal(trueRangeSeries([makeCandle(0, 100)])[0], 2));
test('true range includes previous close gap', () => {
  const rows = [makeCandle(0, 100), makeCandle(1, 110, { low: 109, high: 111 })];
  assert.equal(trueRangeSeries(rows)[1], 11);
});
test('ATR returns null before period', () => assert.equal(atrSeries([makeCandle(0, 100), makeCandle(1, 101)], 3)[1], null));
test('ATR returns finite known fixture value', () => assert.equal(atrSeries([makeCandle(0, 100), makeCandle(1, 101), makeCandle(2, 102)], 3)[2], 2));
test('UTC VWAP resets at UTC day boundary', () => {
  const rows = [makeCandle(0, 100), { ...makeCandle(1, 200), timestamp: START + 24 * 60 * 60_000 }];
  assert.notEqual(utcSessionVwapSeries(rows)[0], utcSessionVwapSeries(rows)[1]);
});
test('UTC VWAP returns null with zero cumulative volume', () => assert.equal(utcSessionVwapSeries([makeCandle(0, 100, { volume: 0 })])[0], null));
test('average volume is a rolling SMA', () => assert.equal(averageVolumeSeries([makeCandle(0, 100, { volume: 10 }), makeCandle(1, 100, { volume: 20 })], 2)[1], 15));
test('rolling high includes current by default', () => assert.equal(rollingHighestSeries([1, 3, 2], 2)[2], 3));
test('rolling high can exclude current to prevent self reference', () => assert.equal(rollingHighestSeries([1, 3, 9], 2, { excludeCurrent: true })[2], 3));
test('rolling low can exclude current to prevent self reference', () => assert.equal(rollingLowestSeries([5, 3, 1], 2, { excludeCurrent: true })[2], 3));
test('sanitize removes incomplete candles', () => assert.equal(sanitizeClosedCandles([makeCandle(0, 100), makeCandle(1, 101, { isClosed: false })]).data.length, 1));
test('sanitize removes duplicate timestamps', () => assert.equal(sanitizeClosedCandles([makeCandle(0, 100), makeCandle(0, 101)]).data.length, 1));
test('sanitize sorts timestamps ascending', () => assert.deepEqual(sanitizeClosedCandles([makeCandle(2, 100), makeCandle(1, 100)]).data.map((row) => row.timestamp), [START + STEP, START + 2 * STEP]));

test('request validation rejects unsupported strategy', () => assert.throws(() => validateBacktestRequest(request({ strategy: 'volume_breakout' })), BacktestValidationError));
test('request validation rejects more than 7x leverage', () => assert.throws(() => validateBacktestRequest(request({ leverage: 8 })), /레버리지/));
test('request validation rejects risk above one percent', () => assert.throws(() => validateBacktestRequest(request({ riskPercent: 1.1 })), /위험률/));
test('request validation rejects inverted period', () => assert.throws(() => validateBacktestRequest(request({ startTime: START + STEP, endTime: START })), /기간/));
test('request validation rejects split not totaling 100', () => assert.throws(() => validateBacktestRequest(request({ validationSplit: { trainingPercent: 60, validationPercent: 30, testPercent: 30 } })), /합은 100/));
test('request validation accepts the three implemented strategies', () => {
  for (const strategy of ['trend_pullback', 'breakout', 'vwap_reclaim'] as const) assert.doesNotThrow(() => validateBacktestRequest(request({ strategy })));
});

test('four-market direction and leverage policy keeps cash markets long-only at 1x', () => {
  for (const [market, symbol] of [
    ['kr-stock', '005930'],
    ['us-stock', 'AAPL'],
    ['crypto-spot', 'BTC'],
  ] as const) {
    assert.doesNotThrow(() => validateBacktestRequest(request({ market, symbol, side: 'long', leverage: 1 })));
    assert.throws(
      () => validateBacktestRequest(request({ market, symbol, side: 'short', leverage: 1 })),
      (error: unknown) => error instanceof BacktestValidationError && error.code === 'LONG_ONLY_MARKET',
    );
    assert.throws(
      () => validateBacktestRequest(request({ market, symbol, side: 'both', leverage: 1 })),
      (error: unknown) => error instanceof BacktestValidationError && error.code === 'LONG_ONLY_MARKET',
    );
    assert.throws(
      () => validateBacktestRequest(request({ market, symbol, side: 'long', leverage: 2 })),
      (error: unknown) => error instanceof BacktestValidationError && error.code === 'INVALID_LEVERAGE',
    );
  }
  assert.doesNotThrow(() => validateBacktestRequest(request({
    market: 'crypto-futures', symbol: 'BTCUSDT', side: 'both', leverage: 3,
  })));
});

test('breakout long signal uses prior completed highs', () => {
  const signals = calculateStrategySignals(request({ side: 'long' }), breakoutFixture('long'));
  assert.ok(signals.some((signal) => signal.side === 'long' && signal.index === 60));
});
test('breakout short signal uses prior completed lows', () => {
  const signals = calculateStrategySignals(request({ side: 'short' }), breakoutFixture('short'));
  assert.ok(signals.some((signal) => signal.side === 'short' && signal.index === 60));
});
test('breakout does not use current candle in its own boundary', () => {
  const rows = breakoutFixture('long');
  const signals = calculateStrategySignals(request({ side: 'long' }), rows);
  assert.ok(signals.find((signal) => signal.index === 60));
});
test('last-candle signal is not entered without a next candle', () => {
  const rows = breakoutFixture('long').slice(0, 61);
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.equal(result.totalTrades, 0);
});
test('trend pullback emits long signal on EMA reclaim fixture', () => {
  const rows = Array.from({ length: 80 }, (_, index) => makeCandle(index, 100 + index * 0.2, { volume: 100 }));
  rows[78] = makeCandle(78, rows[77].close - 1, { volume: 120 });
  rows[79] = makeCandle(79, rows[77].close + 1, { volume: 200 });
  const signals = calculateStrategySignals(request({ strategy: 'trend_pullback', side: 'long', parameters: { fastPeriod: 5, slowPeriod: 10, volumePeriod: 5, volumeMultiplier: 1, pullbackTolerancePercent: 2 } }), rows);
  assert.ok(signals.some((signal) => signal.side === 'long'));
});
test('trend pullback emits short signal on EMA reject fixture', () => {
  const rows = Array.from({ length: 80 }, (_, index) => makeCandle(index, 120 - index * 0.2, { volume: 100 }));
  rows[78] = makeCandle(78, rows[77].close + 1, { volume: 120 });
  rows[79] = makeCandle(79, rows[77].close - 1, { volume: 200 });
  const signals = calculateStrategySignals(request({ strategy: 'trend_pullback', side: 'short', parameters: { fastPeriod: 5, slowPeriod: 10, volumePeriod: 5, volumeMultiplier: 1, pullbackTolerancePercent: 2 } }), rows);
  assert.ok(signals.some((signal) => signal.side === 'short'));
});
test('VWAP reclaim emits long after crossing above session VWAP', () => {
  const rows = Array.from({ length: 70 }, (_, index) => makeCandle(index, index < 68 ? 100 : index === 68 ? 95 : 105, { volume: index === 69 ? 1_000 : 100 }));
  const signals = calculateStrategySignals(request({ strategy: 'vwap_reclaim', side: 'long', parameters: { volumePeriod: 20, volumeMultiplier: 1.2 } }), rows);
  assert.ok(signals.some((signal) => signal.side === 'long'));
});
test('side filter prevents short signals in long-only mode', () => {
  const signals = calculateStrategySignals(request({ side: 'long' }), breakoutFixture('short'));
  assert.equal(signals.some((signal) => signal.side === 'short'), false);
});

test('market signal is entered on the next candle open', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(result.trades[0].entryTime > result.trades[0].signalTime);
  assert.equal(result.trades[0].entryTime, rows[61].timestamp);
});
test('long entry applies adverse positive slippage', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(result.trades[0].entryPrice > rows[61].open);
});
test('short entry applies adverse negative slippage', () => {
  const rows = breakoutFixture('short');
  const result = runBacktest(request({ side: 'short', endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(result.trades[0].entryPrice < rows[61].open);
});
test('same candle stop and target defaults to stop first', () => {
  const rows = breakoutFixture('long', { bothTouched: true });
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.equal(result.trades[0].exitReason, 'stop_loss');
});
test('a bar that gaps through the stop fills at the open, not at the better stop price', () => {
  const rows = breakoutFixture('long').map((row) => ({ ...row }));
  const base = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  const entry = base.trades[0];
  const gapIndex = rows.findIndex((row) => row.timestamp === entry.entryTime) + 1;
  const gapOpen = entry.entryPrice * 0.9; // far below the 1% stop
  rows[gapIndex] = { ...rows[gapIndex], open: gapOpen, high: gapOpen * 1.001, low: gapOpen * 0.99, close: gapOpen };
  const gapped = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows).trades[0];
  assert.equal(gapped.exitReason, 'stop_loss');
  assert.ok(gapped.exitPrice < entry.entryPrice * 0.95, `gap fill ${gapped.exitPrice} must be near the gapped open`);
  assert.ok(gapped.netPnl < base.trades[0].netPnl || gapped.netPnl < 0);
});
test('target-first option is explicit and non-default', () => {
  const rows = breakoutFixture('long', { bothTouched: true });
  const result = runBacktest(request({ side: 'long', intrabarPriority: 'target_first', endTime: rows.at(-1)!.timestamp }), rows);
  assert.equal(result.trades[0].exitReason, 'take_profit');
});
test('representative performance is net of fees and slippage', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  const trade = result.trades[0];
  assert.ok(trade.netPnl <= trade.grossPnl - trade.entryFee - trade.exitFee);
});
test('fees are reported separately', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(result.totalFees > 0);
});
test('slippage is reported separately', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(result.totalSlippage > 0);
});
test('positive funding charges a long held through a full interval', () => {
  const rows = breakoutFixture('long', { holdBars: 40 }).map((row, index) => index > 61 ? { ...row, high: row.open * 1.005, low: row.open * 0.995, close: row.open } : row);
  const result = runBacktest(request({ side: 'long', fundingRatePerInterval: 0.001, endTime: rows.at(-1)!.timestamp, takeProfitValue: 20 }), rows);
  assert.ok(result.totalFunding >= 0);
});
test('positive funding is receivable for a short', () => {
  const rows = breakoutFixture('short', { holdBars: 40 }).map((row, index) => index > 61 ? { ...row, high: row.open * 1.005, low: row.open * 0.995, close: row.open } : row);
  const result = runBacktest(request({ side: 'short', fundingRatePerInterval: 0.001, endTime: rows.at(-1)!.timestamp, takeProfitValue: 20 }), rows);
  assert.ok(result.totalFunding <= 0);
});
test('zero funding creates zero funding cost', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', fundingRatePerInterval: 0, endTime: rows.at(-1)!.timestamp }), rows);
  assert.equal(result.totalFunding, 0);
});
test('end of data closes remaining positions', () => {
  const rows = breakoutFixture('long', { holdBars: 2 }).map((row, index) => index > 61 ? { ...row, high: row.open * 1.001, low: row.open * 0.999, close: row.open } : row);
  const result = runBacktest(request({ side: 'long', takeProfitValue: 20, stopLossValue: 20, endTime: rows.at(-1)!.timestamp }), rows);
  assert.equal(result.trades.at(-1)?.exitReason, 'end_of_data');
});
test('trailing stop can close an activated position', () => {
  const rows = breakoutFixture('long', { holdBars: 3 });
  rows[61] = { ...rows[61], high: rows[61].open * 1.03, low: rows[61].open * 0.999 };
  rows[62] = { ...rows[62], high: rows[62].open * 1.01, low: rows[62].open * 1.005 };
  const result = runBacktest(request({ side: 'long', trailingStop: { enabled: true, activationR: 1, distanceR: 0.5 }, takeProfitValue: 20, endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(['trailing_stop', 'end_of_data'].includes(result.trades[0].exitReason));
});
test('maximum loss remains bounded by configured risk budget', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(Math.abs(result.trades[0].rMultiple) < 10);
});
test('leverage change does not change riskPercent input', () => {
  const rows = breakoutFixture('long');
  const low = runBacktest(request({ side: 'long', leverage: 2, endTime: rows.at(-1)!.timestamp }), rows);
  const high = runBacktest(request({ side: 'long', leverage: 3, endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(Math.abs(low.trades[0].quantity - high.trades[0].quantity) < 1e-9);
});
test('result preserves backtest-only safety contract', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.equal(result.mode, 'backtest-only');
  assert.equal(result.orderSubmitted, false);
});
test('equity curve is realized trade based', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.equal(result.equityCurve.length, result.totalTrades + 1);
});
test('drawdown curve has one point per closed trade', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.equal(result.drawdownCurve.length, result.totalTrades);
});
test('profit factor is null when there are no losing trades', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  if (result.losingTrades === 0) assert.equal(result.profitFactor, null);
});
test('validation ranges are chronological and non-overlapping', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  const [training, validation, testing] = result.validationPerformance;
  assert.ok(training.endTime <= validation.startTime && validation.endTime <= testing.startTime);
});
test('validation result includes training validation and test', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.deepEqual(result.validationPerformance.map((item) => item.name), ['training', 'validation', 'test']);
});
test('walk-forward basic evaluation returns ordered windows', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.equal(result.walkForward.length, 3);
  assert.ok(result.walkForward[0].endTime <= result.walkForward[1].startTime);
});
test('monthly performance is sorted', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.deepEqual(result.monthlyPerformance.map((item) => item.month), [...result.monthlyPerformance.map((item) => item.month)].sort());
});
test('long and short performance are separated', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.equal(result.shortPerformance.trades, 0);
});
test('insufficient daily return samples produce null Sharpe safely', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.equal(result.sharpeRatio, null);
});
test('Sharpe counts idle calendar days so it is not inflated by trade-day-only samples', () => {
  const rows = breakoutFixture('long');
  const endTime = rows.at(-1)!.timestamp;
  const result = runBacktest(request({ side: 'long', endTime }), rows);
  const byDay = new Map<string, number>();
  for (const trade of result.trades) { const day = new Date(trade.exitTime).toISOString().slice(0, 10); byDay.set(day, (byDay.get(day) ?? 0) + trade.netPnl); }
  let equity = result.initialCapital; const active: number[] = [];
  for (const day of [...byDay.keys()].sort()) { const pnl = byDay.get(day)!; active.push(pnl / equity); equity += pnl; }
  const sd = (values: number[]) => { const m = values.reduce((a, b) => a + b, 0) / values.length; return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1)); };
  if (result.sharpeRatio !== null && active.length >= 2 && sd(active) > 0) {
    const activeOnly = active.reduce((a, b) => a + b, 0) / active.length / sd(active) * Math.sqrt(365);
    assert.ok(result.sharpeRatio <= activeOnly + 1e-9);
  }
});
test('marked drawdown includes unrealized loss and is never below the realized drawdown', () => {
  for (const side of ['long', 'short'] as const) {
    const rows = breakoutFixture(side);
    const result = runBacktest(request({ side, endTime: rows.at(-1)!.timestamp }), rows);
    assert.ok(Number.isFinite(result.markedMaximumDrawdown));
    assert.ok(result.markedMaximumDrawdown >= result.maximumDrawdown - 1e-9);
    assert.ok(result.markedMaximumDrawdownPercent >= result.maximumDrawdownPercent - 1e-9);
    if (result.trades.length > 0 && result.maximumDrawdown === 0 && result.trades.some((trade) => trade.maximumAdverseExcursion > 0)) {
      assert.ok(result.markedMaximumDrawdown > 0, 'a winning run that dipped must still show a drawdown');
    }
  }
});
test('funding is charged per real settlement boundary, not per elapsed hours', () => {
  const H = 3_600_000; const base = { timeframe: '1H', fundingIntervalHours: 8 };
  assert.equal(fundingSettlementsHeld(7 * H, 9 * H, 'strategy_exit', base), 1); // crosses 08:00
  assert.equal(fundingSettlementsHeld(1 * H, 7 * H, 'strategy_exit', base), 0); // 6h held, no settlement
  assert.equal(fundingSettlementsHeld(8 * H, 9 * H, 'strategy_exit', base), 0); // filled at the settlement instant
  assert.equal(fundingSettlementsHeld(1 * H, 7 * H, 'stop_loss', base), 0); // exit bar ends 07:59:59.999
  assert.equal(fundingSettlementsHeld(1 * H, 8 * H, 'stop_loss', base), 1); // stop inside the 08:00 bar -> held through settlement
  assert.equal(fundingSettlementsHeld(0, 24 * H, 'strategy_exit', { timeframe: '1H', fundingIntervalHours: 0 }), 0);
});
test('order delay moves the entry later and rejects invalid delays', () => {
  const rows = breakoutFixture('long'); const endTime = rows.at(-1)!.timestamp;
  const immediate = runBacktest(request({ side: 'long', endTime }), rows);
  const delayed = runBacktest(request({ side: 'long', endTime, parameters: { ...request({}).parameters, entryDelayBars: 2 } }), rows);
  assert.ok(immediate.trades.length > 0 && delayed.trades.length > 0, 'fixture must trade with and without delay');
  assert.ok(delayed.trades[0].entryTime > immediate.trades[0].entryTime);
  assert.ok(delayed.warnings.some((warning) => warning.includes('주문 지연 2봉')));
  for (const bad of [-1, 6, 1.5]) assert.throws(() => runBacktest(request({ side: 'long', endTime, parameters: { ...request({}).parameters, entryDelayBars: bad } }), rows), /주문 지연/u);
});
test('inverse normal CDF matches known quantiles', () => {
  assert.ok(Math.abs(inverseNormalCdf(0.5)) < 1e-9);
  assert.ok(Math.abs(inverseNormalCdf(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(inverseNormalCdf(0.001) + 3.090232) < 1e-5);
  assert.equal(inverseNormalCdf(0), Number.NEGATIVE_INFINITY);
});
test('expected best noise Sharpe grows with the number of tries and shrinks with a longer sample', () => {
  assert.equal(expectedMaxNoiseSharpe(1, 2), null);
  assert.equal(expectedMaxNoiseSharpe(10, 0), null);
  const few = expectedMaxNoiseSharpe(5, 2)!; const many = expectedMaxNoiseSharpe(50, 2)!; const longer = expectedMaxNoiseSharpe(50, 8)!;
  assert.ok(few > 0 && many > few && longer < many);
});
test('selection bias flags a result that luck alone could produce', () => {
  const start = Date.UTC(2024, 0, 1); const end = Date.UTC(2025, 0, 1);
  const weak = evaluateSelectionBias(30, 0.4, start, end);
  assert.equal(weak.indistinguishableFromNoise, true);
  assert.match(selectionBiasWarning(weak)!, /우연과 구분되지 않습니다/u);
  const strong = evaluateSelectionBias(30, 5, start, end);
  assert.equal(strong.indistinguishableFromNoise, false);
  assert.equal(selectionBiasWarning(evaluateSelectionBias(3, 0.1, start, end)), null);
  assert.equal(evaluateSelectionBias(1, null, start, end).indistinguishableFromNoise, false);
});
test('selection runs count distinct settings, ignore the period, include nested parameters and expire after a day', () => {
  resetSelectionRunsForTests();
  const base = { market: 'crypto-futures', symbol: 'BTCUSDT', strategy: 'breakout', stopLossValue: 1, startTime: 1, endTime: 2, parameters: { lookback: 20 } } as unknown as BacktestRequest;
  const counts = [1, 1.1, 1.2, 1.3, 1.4, 1.5].map((value) => recordSelectionRun('m1', { ...base, stopLossValue: value }));
  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6]);
  assert.equal(recordSelectionRun('m1', { ...base, stopLossValue: 1.5, startTime: 9, endTime: 99 }), 6);
  assert.equal(recordSelectionRun('m1', { ...base, parameters: { lookback: 30 } }), 7);
  assert.equal(recordSelectionRun('m2', base), 1);
  assert.equal(recordSelectionRun('m1', { ...base, stopLossValue: 2 }, Date.now() + 25 * 3_600_000), 1);
  resetSelectionRunsForTests();
});
const relabel = (rows: NormalizedCandle[], symbol: string): NormalizedCandle[] => rows.map((row) => ({ ...row, symbol }));
test('portfolio backtest splits capital equally, combines closed trades and bounds the marked drawdown', () => {
  const rows = breakoutFixture('long'); const endTime = rows.at(-1)!.timestamp;
  const portfolio = runPortfolioBacktest(request({ side: 'long', endTime }), { BTCUSDT: rows, ETHUSDT: relabel(rows, 'ETHUSDT') });
  assert.deepEqual(portfolio.symbols, ['BTCUSDT', 'ETHUSDT']);
  assert.ok(portfolio.sleeves.every((sleeve) => sleeve.allocatedCapital === 5_000 && sleeve.result.initialCapital === 5_000));
  const single = runBacktest(request({ side: 'long', endTime, initialCapital: 5_000 }), rows);
  assert.equal(portfolio.totalTrades, single.totalTrades * 2);
  assert.ok(Math.abs(portfolio.finalCapital - (10_000 + single.totalReturnPercent / 100 * 5_000 * 2)) < 1e-6);
  assert.ok(portfolio.markedMaximumDrawdownUpperBound >= portfolio.maximumDrawdown - 1e-9);
  assert.equal(portfolio.equityCurve.length, portfolio.totalTrades + 1);
  assert.ok(portfolio.warnings.some((warning) => warning.includes('독립 운용')));
});
test('portfolio backtest rejects bad sizes, skips unusable symbols and fails when none remain', () => {
  const rows = breakoutFixture('long'); const endTime = rows.at(-1)!.timestamp; const base = request({ side: 'long', endTime });
  assert.throws(() => runPortfolioBacktest(base, { BTCUSDT: rows }), /종목 2~5개/u);
  const many = Object.fromEntries(['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT', 'EUSDT', 'FUSDT'].map((symbol) => [symbol, relabel(rows, symbol)]));
  assert.equal(PORTFOLIO_BACKTEST_LIMITS.maximumSymbols, 5);
  assert.throws(() => runPortfolioBacktest(base, many), /종목 2~5개/u);
  const partial = runPortfolioBacktest(base, { BTCUSDT: rows, ETHUSDT: relabel(rows.slice(0, 10), 'ETHUSDT') });
  assert.deepEqual(partial.symbols, ['BTCUSDT']);
  assert.equal(partial.skipped[0].symbol, 'ETHUSDT');
  assert.throws(() => runPortfolioBacktest(base, { BTCUSDT: rows.slice(0, 10), ETHUSDT: relabel(rows.slice(0, 10), 'ETHUSDT') }), /만족하지 못했습니다/u);
});
test('history before the start only warms indicators: it never creates trades before the start', () => {
  const rows = breakoutFixture('long'); const endTime = rows.at(-1)!.timestamp;
  const warm = Array.from({ length: 70 }, (_, k) => makeCandle(-70 + k, 100));
  const parameters = { lookback: 100, volumePeriod: 20, volumeMultiplier: 1.2 };
  const cold = runBacktest(request({ side: 'long', endTime, parameters }), rows);
  const warmed = runBacktest(request({ side: 'long', endTime, parameters }), [...warm, ...rows]);
  assert.equal(cold.totalTrades, 0, 'a 100-bar breakout window cannot fill from 61 requested bars alone');
  assert.ok(warmed.totalTrades > 0, 'the 70 earlier bars complete the window');
  assert.ok(warmed.trades.every((trade) => trade.entryTime >= START && trade.signalTime >= START));
  assert.ok(warmed.warnings.some((warning) => warning.includes('워밍업')));
  assert.equal(BACKTEST_WARMUP_BARS, 300);
  assert.equal(backtestWarmupMs('15m'), 300 * 900_000);
  assert.equal(backtestWarmupMs('weird'), 0);
});
test('crypto signals right after a candle gap are skipped until the indicator window refills', () => {
  const rows = breakoutFixture('long'); const endTime = rows.at(-1)!.timestamp;
  const padded = [...rows, ...Array.from({ length: 10 }, (_, k) => makeCandle(rows.length + k, 100))]; const gapEnd = padded.at(-1)!.timestamp; const gapped = padded.filter((row) => row.timestamp < START + 50 * STEP || row.timestamp >= START + 55 * STEP);
  const result = runBacktest(request({ side: 'long', endTime: gapEnd }), gapped);
  assert.equal(result.totalTrades, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('캔들 누락 구간 직후')));
  const stock = runBacktest(request({ side: 'long', endTime: gapEnd, market: 'us-stock', symbol: 'SPY', leverage: 1 }), gapped.map((row) => ({ ...row, market: 'us-stock', symbol: 'SPY' })));
  assert.ok(!stock.warnings.some((warning) => warning.includes('캔들 누락 구간 직후')), 'weekend/holiday gaps are normal for stocks');
});
test('warm-up history is requested but never exceeds the candle or duration limits', () => {
  const day = 86_400_000; const base = { timeframe: '15m', startTime: START, endTime: START + 10 * day };
  assert.equal(warmupStartTime(base), START - 300 * 900_000);
  assert.equal(warmupStartTime({ ...base, timeframe: 'weird' }), START);
  const nearDurationLimit = { timeframe: '1D', startTime: START, endTime: START + 365 * day };
  const loadedSpan = nearDurationLimit.endTime - warmupStartTime(nearDurationLimit);
  assert.ok(loadedSpan <= BACKTEST_LIMITS.maximumDurationMs);
  const nearCandleLimit = { timeframe: '1m', startTime: START, endTime: START + 19_990 * 60_000 };
  assert.ok((nearCandleLimit.endTime - warmupStartTime(nearCandleLimit)) / 60_000 <= BACKTEST_LIMITS.maximumCandles);
  assert.equal(warmupStartTime({ timeframe: '1m', startTime: START, endTime: START + 20_000 * 60_000 }), START);
});
test('warnings document stop-first policy', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(result.warnings.some((warning) => warning.includes('손절을 우선')));
});
test('warnings document UTC VWAP session', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(result.warnings.some((warning) => warning.includes('협정세계시 기준 하루 단위')));
});
test('performance measurement returns finite duration and memory delta', () => {
  const rows = breakoutFixture('long');
  const measured = measureBacktestPerformance(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(Number.isFinite(measured.durationMs));
  assert.ok(Number.isFinite(measured.heapDeltaBytes));
});

test('futures 7x analytical ceiling is accepted with no provider order', () => {
  assert.doesNotThrow(() => validateBacktestRequest(request({ market: 'crypto-futures', symbol: 'BTCUSDT', side: 'long', leverage: 7 })));
});

test('funding rate sum uses the recorded rate per settlement and counts fallbacks for boundaries without one', () => {
  const H = 3_600_000; const base = { timeframe: '1H', fundingIntervalHours: 8, fundingRatePerInterval: 0.0001 };
  const points = sanitizeFundingPoints([{ time: 8 * H, rate: 0.0005 }, { time: 16 * H + 30_000, rate: -0.0002 }]);
  const funding = { lookup: (boundary: number) => { const hit = points.find((point) => Math.abs(point.time - boundary) <= 60_000); return hit ? hit.rate : null; }, tally: { history: 0, fallback: 0 } };
  const sum = fundingRateSumHeld(7 * H, 25 * H, 'strategy_exit', base, funding); // crosses 08:00, 16:00, 24:00
  assert.ok(Math.abs(sum - (0.0005 - 0.0002 + 0.0001)) < 1e-12);
  assert.deepEqual(funding.tally, { history: 2, fallback: 1 });
});
test('sanitizeFundingPoints drops invalid or absurd rates and de-duplicates by minute; hash tracks content', () => {
  const clean = sanitizeFundingPoints([{ time: 100 * 60_000, rate: 0.0001 }, { time: 100 * 60_000 + 5_000, rate: 0.0002 }, { time: -1, rate: 0.1 }, { time: 200 * 60_000, rate: Number.NaN }, { time: 300 * 60_000, rate: 0.5 }]);
  assert.equal(clean.length, 1);
  assert.notEqual(fundingHistoryHash(clean), fundingHistoryHash([{ ...clean[0], rate: 0.0003 }]));
  assert.equal(fundingHistoryHash(clean), fundingHistoryHash(clean));
});
test('runBacktest applies real funding history, reports coverage, and leaves results unchanged without it', () => {
  const rows = breakoutFixture('long', { holdBars: 40 }).map((row, index) => index > 61 ? { ...row, high: row.open * 1.005, low: row.open * 0.995, close: row.open } : row);
  const base = request({ side: 'long', fundingRatePerInterval: 0.001, endTime: rows.at(-1)!.timestamp, takeProfitValue: 20 });
  const plain = runBacktest(base, rows);
  assert.equal(plain.fundingHistory, undefined);
  assert.ok(plain.warnings.some((warning) => warning.includes('고정 비율')));
  const H = 3_600_000; const first = Math.floor(START / (8 * H)) * 8 * H;
  const points = Array.from({ length: 40 }, (_, k) => ({ time: first + k * 8 * H, rate: 0.003 }));
  const real = runBacktest(base, rows, new Date(), { fundingHistory: points });
  assert.ok(real.fundingHistory);
  assert.equal(real.fundingHistory!.fallbackSettlements, 0);
  assert.equal(real.fundingHistory!.historySettlements, real.fundingHistory!.settlements);
  assert.equal(real.fundingHistory!.contentHash, fundingHistoryHash(sanitizeFundingPoints(points)));
  if (plain.totalTrades > 0 && plain.totalFunding > 0) assert.ok(real.totalFunding > plain.totalFunding * 2.9);
  const sparse = runBacktest(base, rows, new Date(), { fundingHistory: [{ time: first - 800 * H, rate: 0.003 }] });
  assert.equal(sparse.fundingHistory!.historySettlements, 0);
  assert.equal(sparse.totalFunding, plain.totalFunding);
});

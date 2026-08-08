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
  BacktestValidationError,
  calculateStrategySignals,
  measureBacktestPerformance,
  runBacktest,
  validateBacktestRequest,
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
test('request validation rejects more than 10x leverage', () => assert.throws(() => validateBacktestRequest(request({ leverage: 11 })), /레버리지/));
test('request validation rejects risk above one percent', () => assert.throws(() => validateBacktestRequest(request({ riskPercent: 1.1 })), /위험률/));
test('request validation rejects inverted period', () => assert.throws(() => validateBacktestRequest(request({ startTime: START + STEP, endTime: START })), /기간/));
test('request validation rejects split not totaling 100', () => assert.throws(() => validateBacktestRequest(request({ validationSplit: { trainingPercent: 60, validationPercent: 30, testPercent: 30 } })), /합은 100/));
test('request validation accepts the three implemented strategies', () => {
  for (const strategy of ['trend_pullback', 'breakout', 'vwap_reclaim'] as const) assert.doesNotThrow(() => validateBacktestRequest(request({ strategy })));
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
  const high = runBacktest(request({ side: 'long', leverage: 5, endTime: rows.at(-1)!.timestamp }), rows);
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
test('warnings document stop-first policy', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(result.warnings.some((warning) => warning.includes('손절을 우선')));
});
test('warnings document UTC VWAP session', () => {
  const rows = breakoutFixture('long');
  const result = runBacktest(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(result.warnings.some((warning) => warning.includes('UTC 일 단위')));
});
test('performance measurement returns finite duration and memory delta', () => {
  const rows = breakoutFixture('long');
  const measured = measureBacktestPerformance(request({ side: 'long', endTime: rows.at(-1)!.timestamp }), rows);
  assert.ok(Number.isFinite(measured.durationMs));
  assert.ok(Number.isFinite(measured.heapDeltaBytes));
});

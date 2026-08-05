import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadUpbitBacktestCandles } from '../services/upbit-backtest-data.service';
import type { CashBacktestCandle } from '../services/cash-backtest-engine.service';

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const DAYS = 90;
const TIMEFRAME = '10m';
const TIMEFRAME_MS = 10 * 60_000;
const END_TIME = Date.now() - 60_000;
const START_TIME = END_TIME - DAYS * DAY;
const OUTPUT_PATH = process.env.BACKTEST_OUTPUT
  ?? path.resolve(process.cwd(), 'artifacts/crypto-spot-strategy-search.json');
const SYMBOLS = ['KRW-BTC', 'KRW-ETH'] as const;
const COSTS = Object.freeze({ entryFeeRate: 0.0005, exitFeeRate: 0.0005, slippageRate: 0.0005 });
const SELECTION_MINIMUM = Object.freeze({ trainingTrades: 20, validationTrades: 5 });
const GATE = Object.freeze({
  minimumFullTrades: 50,
  minimumFullExpectancyR: 0.1,
  minimumFullProfitFactor: 1.2,
  minimumLockedTestTrades: 5,
  minimumLockedTestExpectancyR: 0.05,
  minimumLockedTestProfitFactor: 1.1,
  maximumDrawdownPercent: 15,
});

type Symbol = typeof SYMBOLS[number];
type SegmentName = 'training' | 'validation' | 'locked-test' | 'full';
type Candidate = {
  id: string;
  centerPeriod: number;
  trendPeriod: number;
  bandAtr: number;
  oversoldRsi: number;
  requireBullishFourHour: boolean;
  requireLocalTrend: boolean;
  volumeMultiplier: number;
  stopAtrMultiplier: number;
  minimumRewardR: number;
  maximumHoldBars: number;
};
type Signal = { index: number; targetPrice: number };
type SegmentResult = {
  symbol: Symbol;
  segment: SegmentName;
  startTime: number;
  endTime: number;
  totalTrades: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number | null;
  maximumDrawdownPercent: number;
  totalReturnPercent: number;
  averageWinR: number;
  averageLossR: number;
};
type CandidateAssessment = {
  candidate: Candidate;
  training: SegmentResult;
  validation: SegmentResult;
  selectionQualified: boolean;
  minimumSelectionExpectancyR: number;
  minimumSelectionProfitFactor: number;
  selectionTrades: number;
  score: number;
};
type Trade = { netPnl: number; rMultiple: number };
type Position = {
  quantity: number;
  entryPrice: number;
  entryFee: number;
  riskAmount: number;
  stop: number;
  target: number;
  openedIndex: number;
};
type TrendState = { bullish: boolean; slow: number } | null;

function ema(values: readonly number[], period: number) {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return output;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  output[period - 1] = value;
  for (let index = period; index < values.length; index += 1) {
    value = values[index] * multiplier + value * (1 - multiplier);
    output[index] = value;
  }
  return output;
}

function atr(candles: readonly CashBacktestCandle[], period = 14) {
  const output: Array<number | null> = Array(candles.length).fill(null);
  const ranges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  if (ranges.length < period) return output;
  let value = ranges.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  output[period - 1] = value;
  for (let index = period; index < ranges.length; index += 1) {
    value = (value * (period - 1) + ranges[index]) / period;
    output[index] = value;
  }
  return output;
}

function rsi(values: readonly number[], period = 14) {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return output;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  gain /= period;
  loss /= period;
  const current = () => loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  output[period] = current();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = current();
  }
  return output;
}

function averageVolume(candles: readonly CashBacktestCandle[], period = 20) {
  return candles.map((_candle, index) => {
    if (index < period) return null;
    return candles.slice(index - period, index).reduce((sum, candle) => sum + candle.volume, 0) / period;
  });
}

function completedTrend(candles: readonly CashBacktestCandle[], bucketMs: number, fastPeriod: number, slowPeriod: number) {
  const buckets: Array<{ endIndex: number; close: number }> = [];
  let key: number | null = null;
  let endIndex = -1;
  let close = 0;
  let timestamp = 0;
  const finalize = () => {
    if (key == null || endIndex < 0) return;
    if (timestamp + TIMEFRAME_MS >= (key + 1) * bucketMs) buckets.push({ endIndex, close });
  };
  for (let index = 0; index < candles.length; index += 1) {
    const nextKey = Math.floor(candles[index].timestamp / bucketMs);
    if (key != null && nextKey !== key) finalize();
    if (nextKey !== key) key = nextKey;
    endIndex = index;
    close = candles[index].close;
    timestamp = candles[index].timestamp;
  }
  finalize();
  const closes = buckets.map((bucket) => bucket.close);
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const states: TrendState[] = buckets.map((_bucket, index) => {
    const fastValue = fast[index];
    const slowValue = slow[index];
    if (fastValue == null || slowValue == null) return null;
    return { bullish: fastValue > slowValue, slow: slowValue };
  });
  const output: TrendState[] = Array(candles.length).fill(null);
  let cursor = 0;
  let available: TrendState = null;
  for (let index = 0; index < candles.length; index += 1) {
    while (cursor < buckets.length && buckets[cursor].endIndex <= index) {
      available = states[cursor];
      cursor += 1;
    }
    output[index] = available;
  }
  return output;
}

function buildCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  for (const centerPeriod of [20, 40]) {
    for (const trendPeriod of [100, 160]) {
      for (const bandAtr of [0.25, 0.5, 0.75]) {
        for (const oversoldRsi of [55, 100]) {
          for (const requireBullishFourHour of [false, true]) {
            for (const requireLocalTrend of [false, true]) {
              for (const volumeMultiplier of [0, 0.5]) {
                for (const stopAtrMultiplier of [1.25, 1.75]) {
                  for (const minimumRewardR of [0.3, 0.5]) {
                    for (const maximumHoldBars of [12, 24]) {
                      candidates.push({
                        id: `c${centerPeriod}-t${trendPeriod}-b${bandAtr}-rsi${oversoldRsi}-4h${Number(requireBullishFourHour)}-lt${Number(requireLocalTrend)}-v${volumeMultiplier}-atr${stopAtrMultiplier}-rr${minimumRewardR}-hold${maximumHoldBars}`,
                        centerPeriod,
                        trendPeriod,
                        bandAtr,
                        oversoldRsi,
                        requireBullishFourHour,
                        requireLocalTrend,
                        volumeMultiplier,
                        stopAtrMultiplier,
                        minimumRewardR,
                        maximumHoldBars,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return candidates;
}

function signals(candles: readonly CashBacktestCandle[], candidate: Candidate) {
  const closes = candles.map((candle) => candle.close);
  const center = ema(closes, candidate.centerPeriod);
  const trend = ema(closes, candidate.trendPeriod);
  const atrValues = atr(candles);
  const rsiValues = rsi(closes);
  const volumes = averageVolume(candles);
  const fourHour = completedTrend(candles, 4 * HOUR, 6, 18);
  const output: Signal[] = [];
  let lastSignal = Number.NEGATIVE_INFINITY;
  for (let index = 2; index < candles.length; index += 1) {
    const centerPrevious = center[index - 1];
    const centerCurrent = center[index];
    const trendCurrent = trend[index];
    const atrPrevious = atrValues[index - 1];
    const atrCurrent = atrValues[index];
    const rsiPrevious = rsiValues[index - 1];
    const rsiCurrent = rsiValues[index];
    const average = volumes[index];
    const fourHourState = fourHour[index];
    if (centerPrevious == null || centerCurrent == null || trendCurrent == null || atrPrevious == null || atrCurrent == null
      || rsiPrevious == null || rsiCurrent == null || average == null || !fourHourState) continue;
    const current = candles[index];
    if (current.close < fourHourState.slow) continue;
    if (candidate.requireBullishFourHour && !fourHourState.bullish) continue;
    if (candidate.requireLocalTrend && centerCurrent <= trendCurrent) continue;
    const previous = candles[index - 1];
    const lowerPrevious = centerPrevious - atrPrevious * candidate.bandAtr;
    const lowerCurrent = centerCurrent - atrCurrent * candidate.bandAtr;
    const oversold = previous.low <= lowerPrevious && previous.close < centerPrevious && rsiPrevious <= candidate.oversoldRsi;
    const bullish = current.close > current.open && current.close > previous.close && rsiCurrent >= rsiPrevious;
    const reclaimed = current.close > lowerCurrent && current.close < centerCurrent;
    const volumeOk = candidate.volumeMultiplier === 0 || current.volume >= average * candidate.volumeMultiplier;
    if (oversold && bullish && reclaimed && volumeOk && index - lastSignal > 6) {
      output.push({ index, targetPrice: centerCurrent });
      lastSignal = index;
    }
  }
  return output;
}

function backtest(candles: CashBacktestCandle[], candidate: Candidate) {
  const signalMap = new Map(signals(candles, candidate).map((signal) => [signal.index, signal]));
  const atrValues = atr(candles);
  const trades: Trade[] = [];
  let cash = 1_000_000;
  let peak = cash;
  let maximumDrawdown = 0;
  let pending: Signal | null = null;
  let position: Position | null = null;
  let tradesToday = 0;
  let day = '';

  const closePosition = (rawPrice: number) => {
    const active = position as Position | null;
    if (!active) return;
    const exitPrice = rawPrice * (1 - COSTS.slippageRate);
    const exitFee = active.quantity * exitPrice * COSTS.exitFeeRate;
    const netPnl = active.quantity * (exitPrice - active.entryPrice) - active.entryFee - exitFee;
    cash += active.quantity * exitPrice - exitFee;
    trades.push({ netPnl, rMultiple: netPnl / active.riskAmount });
    position = null;
  };

  const openPosition = (index: number, signal: Signal) => {
    const rawEntry = candles[index].open;
    const entryPrice = rawEntry * (1 + COSTS.slippageRate);
    const atrValue = atrValues[index];
    if (atrValue == null || atrValue <= 0 || signal.targetPrice <= entryPrice) return;
    const stopDistance = atrValue * candidate.stopAtrMultiplier;
    const stop = entryPrice - stopDistance;
    if (stop <= 0) return;
    const conservativeStopExit = stop * (1 - COSTS.slippageRate);
    const conservativeTargetExit = signal.targetPrice * (1 - COSTS.slippageRate);
    const entryFeePerUnit = entryPrice * COSTS.entryFeeRate;
    const stopFeePerUnit = conservativeStopExit * COSTS.exitFeeRate;
    const targetFeePerUnit = conservativeTargetExit * COSTS.exitFeeRate;
    const executionCost = stop * COSTS.slippageRate + entryFeePerUnit + stopFeePerUnit;
    if (executionCost <= 0 || stopDistance / executionCost < 2) return;
    const lossPerUnit = entryPrice - conservativeStopExit + entryFeePerUnit + stopFeePerUnit;
    const netRewardPerUnit = conservativeTargetExit - entryPrice - entryFeePerUnit - targetFeePerUnit;
    if (netRewardPerUnit <= 0 || netRewardPerUnit / lossPerUnit < candidate.minimumRewardR) return;
    const maxRisk = cash * 0.0015;
    const quantity = Math.min(maxRisk / lossPerUnit, cash / (entryPrice * (1 + COSTS.entryFeeRate)));
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const entryFee = quantity * entryPrice * COSTS.entryFeeRate;
    cash -= quantity * entryPrice + entryFee;
    position = { quantity, entryPrice, entryFee, riskAmount: quantity * lossPerUnit, stop, target: signal.targetPrice, openedIndex: index };
    tradesToday += 1;
  };

  for (let index = 1; index < candles.length; index += 1) {
    const nextDay = new Date(candles[index].timestamp).toISOString().slice(0, 10);
    if (nextDay !== day) {
      day = nextDay;
      tradesToday = 0;
    }
    if (!position && pending) {
      if (tradesToday < 3) openPosition(index, pending);
      pending = null;
    }
    const active = position as Position | null;
    if (active) {
      const hitStop = candles[index].low <= active.stop;
      const hitTarget = candles[index].high >= active.target;
      if (hitStop) closePosition(active.stop);
      else if (hitTarget) closePosition(active.target);
      else if (index - active.openedIndex >= candidate.maximumHoldBars) closePosition(candles[index].close);
    }
    if (!position && !pending && signalMap.has(index) && tradesToday < 3) pending = signalMap.get(index) ?? null;
    const marked = position as Position | null;
    const equity = cash + (marked ? marked.quantity * candles[index].close : 0);
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
  }
  if (position) closePosition(candles.at(-1)!.close);
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl <= 0);
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  return {
    totalTrades: trades.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    expectancyR: average(trades.map((trade) => trade.rMultiple)),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    maximumDrawdownPercent: peak > 0 ? maximumDrawdown / peak * 100 : 0,
    totalReturnPercent: (cash / 1_000_000 - 1) * 100,
    averageWinR: average(wins.map((trade) => trade.rMultiple)),
    averageLossR: average(losses.map((trade) => trade.rMultiple)),
  };
}

function split(candles: CashBacktestCandle[]) {
  const trainingEnd = Math.floor(candles.length * 0.6);
  const validationEnd = Math.floor(candles.length * 0.8);
  return { training: candles.slice(0, trainingEnd), validation: candles.slice(trainingEnd, validationEnd), lockedTest: candles.slice(validationEnd), full: candles };
}

function result(symbol: Symbol, segment: SegmentName, candles: CashBacktestCandle[], candidate: Candidate): SegmentResult {
  return { symbol, segment, startTime: candles.at(0)?.timestamp ?? 0, endTime: candles.at(-1)?.timestamp ?? 0, ...backtest(candles, candidate) };
}

function finiteProfitFactor(value: number | null) {
  return value == null ? Number.POSITIVE_INFINITY : value;
}

function assess(symbol: Symbol, dataset: ReturnType<typeof split>, candidate: Candidate): CandidateAssessment {
  const training = result(symbol, 'training', dataset.training, candidate);
  const validation = result(symbol, 'validation', dataset.validation, candidate);
  const selectionQualified = training.totalTrades >= SELECTION_MINIMUM.trainingTrades && validation.totalTrades >= SELECTION_MINIMUM.validationTrades;
  const minimumSelectionExpectancyR = Math.min(training.expectancyR, validation.expectancyR);
  const minimumSelectionProfitFactor = Math.min(finiteProfitFactor(training.profitFactor), finiteProfitFactor(validation.profitFactor));
  const selectionTrades = training.totalTrades + validation.totalTrades;
  const rawScore = minimumSelectionExpectancyR + Math.min(minimumSelectionProfitFactor, 3) * 0.05 + Math.min(selectionTrades, 100) * 0.001;
  const score = selectionQualified ? rawScore : -1_000_000 + selectionTrades;
  return { candidate, training, validation, selectionQualified, minimumSelectionExpectancyR, minimumSelectionProfitFactor, selectionTrades, score };
}

function eligibility(selectionQualified: boolean, lockedTest: SegmentResult, full: SegmentResult) {
  const reasons: string[] = [];
  if (!selectionQualified) reasons.push('NO_SELECTION_CANDIDATE_WITH_ADEQUATE_SAMPLE');
  if (full.totalTrades < GATE.minimumFullTrades) reasons.push('INSUFFICIENT_FULL_TRADES');
  if (full.expectancyR < GATE.minimumFullExpectancyR) reasons.push('FULL_EXPECTANCY_BELOW_MINIMUM');
  if (finiteProfitFactor(full.profitFactor) < GATE.minimumFullProfitFactor) reasons.push('FULL_PROFIT_FACTOR_BELOW_MINIMUM');
  if (full.maximumDrawdownPercent > GATE.maximumDrawdownPercent) reasons.push('DRAWDOWN_ABOVE_MAXIMUM');
  if (lockedTest.totalTrades < GATE.minimumLockedTestTrades) reasons.push('INSUFFICIENT_LOCKED_TEST_TRADES');
  if (lockedTest.expectancyR < GATE.minimumLockedTestExpectancyR) reasons.push('LOCKED_TEST_EXPECTANCY_BELOW_MINIMUM');
  if (finiteProfitFactor(lockedTest.profitFactor) < GATE.minimumLockedTestProfitFactor) reasons.push('LOCKED_TEST_PROFIT_FACTOR_BELOW_MINIMUM');
  return { automationEligible: reasons.length === 0, automationBlockReasons: reasons };
}

const candidates = buildCandidates();
const results = [];
const providerWarnings: Record<string, string[]> = {};
for (const symbol of SYMBOLS) {
  const history = await loadUpbitBacktestCandles({ symbol, timeframe: TIMEFRAME, startTime: START_TIME, endTime: END_TIME });
  const candles = history.candles as CashBacktestCandle[];
  providerWarnings[symbol] = history.warnings;
  const dataset = split(candles);
  const ranked = candidates.map((candidate) => assess(symbol, dataset, candidate))
    .sort((left, right) => right.score - left.score || right.selectionTrades - left.selectionTrades);
  const selected = ranked[0];
  if (!selected) throw new Error(`NO_CANDIDATE_${symbol}`);
  const lockedTest = result(symbol, 'locked-test', dataset.lockedTest, selected.candidate);
  const full = result(symbol, 'full', dataset.full, selected.candidate);
  results.push({
    symbol,
    selectedCandidate: selected.candidate,
    selectionQualified: selected.selectionQualified,
    training: selected.training,
    validation: selected.validation,
    lockedTest,
    full,
    ...eligibility(selected.selectionQualified, lockedTest, full),
    topCandidates: ranked.slice(0, 10).map((item) => ({
      candidate: item.candidate,
      selectionQualified: item.selectionQualified,
      score: item.score,
      selectionTrades: item.selectionTrades,
      minimumSelectionExpectancyR: item.minimumSelectionExpectancyR,
      minimumSelectionProfitFactor: item.minimumSelectionProfitFactor,
    })),
  });
}

const payload = {
  ok: true,
  mode: 'backtest-only',
  orderSubmitted: false,
  strategyFamily: 'relaxed_bullish_channel_center_exit',
  generatedAt: new Date().toISOString(),
  period: { startTime: START_TIME, endTime: END_TIME, days: DAYS, timeframe: TIMEFRAME },
  split: { trainingPercent: 60, validationPercent: 20, lockedTestPercent: 20 },
  selectionMinimum: SELECTION_MINIMUM,
  selectionPolicy: 'BTC와 ETH를 개별 최적화하며 학습 20건·검증 5건 미만 후보는 선택하지 않고 잠금 테스트는 선택 후 한 번만 평가합니다.',
  candidateCountPerSymbol: candidates.length,
  gate: GATE,
  anyAutomationEligible: results.some((item) => item.automationEligible),
  results,
  providerWarnings,
};

await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(payload, null, 2));

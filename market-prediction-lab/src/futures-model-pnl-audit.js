import { predictTinyModel } from "./tiny-model.js";
import { calculateExecutionAwareTrade } from "./research-validation-layer.js";
import { BITGET_STANDARD_TAKER_RESEARCH_COSTS } from "./historical-backtest-data.js";

const DEFAULT_CAPITAL = 1_000_000;
const DEFAULT_RISK_PER_TRADE = 0.005;

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function positive(value, label) {
  const number = finite(value, label);
  if (!(number > 0)) throw new TypeError(`${label} must be positive`);
  return number;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function trueRange(candle, previousClose) {
  return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
}

function atrAt(candles, endIndex, period = 14) {
  if (endIndex < period) return null;
  let total = 0;
  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    if (index <= 0) return null;
    total += trueRange(candles[index], candles[index - 1].close);
  }
  return total / period;
}

function validateCandles(rawCandles) {
  if (!Array.isArray(rawCandles) || rawCandles.length < 120) throw new TypeError("at least 120 candles are required");
  let previousTimestamp = 0;
  return Object.freeze(rawCandles.map((raw, index) => {
    const timestamp = Number(raw?.timestamp);
    const open = positive(raw?.open, `candles[${index}].open`);
    const high = positive(raw?.high, `candles[${index}].high`);
    const low = positive(raw?.low, `candles[${index}].low`);
    const close = positive(raw?.close, `candles[${index}].close`);
    const volume = finite(raw?.volume ?? 0, `candles[${index}].volume`);
    if (!Number.isInteger(timestamp) || timestamp <= previousTimestamp) throw new TypeError("candles must have strictly increasing millisecond timestamps");
    if (volume < 0 || high < Math.max(open, close) || low > Math.min(open, close) || high < low) throw new TypeError(`candles[${index}] OHLCV is invalid`);
    previousTimestamp = timestamp;
    return Object.freeze({ timestamp, open, high, low, close, volume });
  }));
}

function normalizeFunding(rawFunding = []) {
  if (!Array.isArray(rawFunding)) throw new TypeError("fundingRates must be an array");
  let previousTimestamp = 0;
  return Object.freeze([...rawFunding].sort((a, b) => Number(a.timestamp) - Number(b.timestamp)).map((row, index) => {
    const timestamp = Number(row?.timestamp);
    const rate = finite(row?.rate, `fundingRates[${index}].rate`);
    if (!Number.isInteger(timestamp) || timestamp <= 0 || timestamp === previousTimestamp) throw new TypeError("funding timestamps must be unique positive integers");
    previousTimestamp = timestamp;
    return Object.freeze({ timestamp, rate });
  }));
}

function normalizeParams(raw = {}) {
  const params = {
    minDirectionalProbability: Number(raw.minDirectionalProbability ?? 0.44),
    minProbabilityEdge: Number(raw.minProbabilityEdge ?? 0.05),
    atrPeriod: Number(raw.atrPeriod ?? 14),
    stopAtrMultiple: Number(raw.stopAtrMultiple ?? 2),
    rewardRisk: Number(raw.rewardRisk ?? 1.5),
    maxHoldBars: Number(raw.maxHoldBars ?? 12),
    riskPerTrade: Number(raw.riskPerTrade ?? DEFAULT_RISK_PER_TRADE),
  };
  if (!(params.minDirectionalProbability >= 0.33 && params.minDirectionalProbability <= 0.9)) throw new TypeError("minDirectionalProbability must be 0.33..0.9");
  if (!(params.minProbabilityEdge >= 0 && params.minProbabilityEdge <= 0.5)) throw new TypeError("minProbabilityEdge must be 0..0.5");
  if (!Number.isInteger(params.atrPeriod) || params.atrPeriod < 5 || params.atrPeriod > 100) throw new TypeError("atrPeriod must be 5..100");
  if (!(params.stopAtrMultiple >= 0.5 && params.stopAtrMultiple <= 6)) throw new TypeError("stopAtrMultiple must be 0.5..6");
  if (!(params.rewardRisk >= 0.5 && params.rewardRisk <= 6)) throw new TypeError("rewardRisk must be 0.5..6");
  if (!Number.isInteger(params.maxHoldBars) || params.maxHoldBars < 1 || params.maxHoldBars > 200) throw new TypeError("maxHoldBars must be 1..200");
  if (!(params.riskPerTrade > 0 && params.riskPerTrade <= 0.02)) throw new TypeError("riskPerTrade must be >0 and <=0.02");
  return Object.freeze(params);
}

export function futuresDecisionFromProbabilities(probabilities, rawParams = {}) {
  const params = normalizeParams(rawParams);
  const bullish = finite(probabilities?.bullish, "probabilities.bullish");
  const bearish = finite(probabilities?.bearish, "probabilities.bearish");
  const neutral = finite(probabilities?.neutral, "probabilities.neutral");
  const total = bullish + bearish + neutral;
  if (!(total > 0)) throw new TypeError("probabilities total must be positive");
  const bull = bullish / total;
  const bear = bearish / total;
  if (bull >= params.minDirectionalProbability && bull - bear >= params.minProbabilityEdge && bull > neutral / total) {
    return Object.freeze({ action: "LONG", probability: bull, oppositeProbability: bear, edge: bull - bear });
  }
  if (bear >= params.minDirectionalProbability && bear - bull >= params.minProbabilityEdge && bear > neutral / total) {
    return Object.freeze({ action: "SHORT", probability: bear, oppositeProbability: bull, edge: bear - bull });
  }
  return null;
}

function exitForTrade(action, candle, stop, target, conservativeSameBar = true) {
  if (action === "LONG") {
    if (candle.open <= stop) return { price: candle.open, reason: "stop_gap" };
    if (candle.open >= target) return { price: target, reason: "target_gap" };
    const stopHit = candle.low <= stop;
    const targetHit = candle.high >= target;
    if (stopHit && targetHit) return { price: conservativeSameBar ? stop : target, reason: conservativeSameBar ? "stop_same_bar" : "target_same_bar" };
    if (stopHit) return { price: stop, reason: "stop" };
    if (targetHit) return { price: target, reason: "target" };
    return null;
  }
  if (candle.open >= stop) return { price: candle.open, reason: "stop_gap" };
  if (candle.open <= target) return { price: target, reason: "target_gap" };
  const stopHit = candle.high >= stop;
  const targetHit = candle.low <= target;
  if (stopHit && targetHit) return { price: conservativeSameBar ? stop : target, reason: conservativeSameBar ? "stop_same_bar" : "target_same_bar" };
  if (stopHit) return { price: stop, reason: "stop" };
  if (targetHit) return { price: target, reason: "target" };
  return null;
}

function fundingForTrade(fundingRows, entryTimestamp, exitTimestamp) {
  return fundingRows.filter((row) => row.timestamp > entryTimestamp && row.timestamp <= exitTimestamp).map((row) => row.rate);
}

function quantityForRisk({ capital, riskPerTrade, entryPrice, stopPrice }) {
  const stopDistance = Math.abs(entryPrice - stopPrice);
  if (!(stopDistance > 0)) return 0;
  const byRisk = capital * riskPerTrade / stopDistance;
  const byNotional = capital / entryPrice;
  return Math.min(byRisk, byNotional);
}

function summaryFromTrades(trades, initialCapital) {
  const returns = trades.map((trade) => trade.netReturnOnMargin);
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  let equity = initialCapital;
  let peak = initialCapital;
  let maximumDrawdown = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    if (peak > 0) maximumDrawdown = Math.max(maximumDrawdown, (peak - equity) / peak);
  }
  const deviation = stddev(returns);
  const expectancyReturn = mean(returns);
  const directions = {
    LONG: trades.filter((trade) => trade.action === "LONG").length,
    SHORT: trades.filter((trade) => trade.action === "SHORT").length,
  };
  return Object.freeze({
    tradeCount: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    netPnl: trades.reduce((sum, trade) => sum + trade.netPnl, 0),
    totalReturn: initialCapital > 0 ? (equity - initialCapital) / initialCapital : 0,
    expectancyReturn,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    maximumDrawdown,
    sharpeLike: deviation > 0 ? expectancyReturn / deviation * Math.sqrt(Math.max(1, trades.length)) : 0,
    totalExecutionCost: trades.reduce((sum, trade) => sum + (trade.costs?.total ?? 0), 0),
    fundingCost: trades.reduce((sum, trade) => sum + (trade.costs?.funding ?? 0), 0),
    directionCounts: Object.freeze(directions),
    finalCapital: equity,
  });
}

export function simulateFrozenFuturesModel(raw = {}) {
  if (!raw.model?.trained) throw new TypeError("a trained frozen model is required");
  const candles = validateCandles(raw.candles);
  const fundingRates = normalizeFunding(raw.fundingRates ?? []);
  const records = Array.isArray(raw.records) ? [...raw.records].sort((a, b) => a.anchorTimestamp - b.anchorTimestamp) : [];
  const params = normalizeParams(raw.params);
  const capital = positive(raw.initialCapital ?? DEFAULT_CAPITAL, "initialCapital");
  const costMultiplier = positive(raw.costMultiplier ?? 1, "costMultiplier");
  const baseCosts = BITGET_STANDARD_TAKER_RESEARCH_COSTS.CRYPTO_FUTURES;
  const indexByTimestamp = new Map(candles.map((candle, index) => [candle.timestamp, index]));
  const trades = [];
  let blockedUntilIndex = -1;

  for (const record of records) {
    const anchorIndex = indexByTimestamp.get(record.anchorTimestamp);
    if (!Number.isInteger(anchorIndex) || anchorIndex + 1 >= candles.length) continue;
    const entryIndex = anchorIndex + 1;
    if (entryIndex <= blockedUntilIndex) continue;
    const prediction = predictTinyModel(record.features, raw.model);
    const decision = futuresDecisionFromProbabilities(prediction.probabilities, params);
    if (!decision) continue;
    const signalAtr = atrAt(candles, anchorIndex, params.atrPeriod);
    if (!(signalAtr > 0)) continue;
    const entryCandle = candles[entryIndex];
    const stopDistance = signalAtr * params.stopAtrMultiple;
    const stop = decision.action === "LONG" ? entryCandle.open - stopDistance : entryCandle.open + stopDistance;
    const target = decision.action === "LONG" ? entryCandle.open + stopDistance * params.rewardRisk : entryCandle.open - stopDistance * params.rewardRisk;
    if (!(stop > 0 && target > 0)) continue;
    const quantity = quantityForRisk({ capital, riskPerTrade: params.riskPerTrade, entryPrice: entryCandle.open, stopPrice: stop });
    if (!(quantity > 0)) continue;

    const lastExitIndex = Math.min(candles.length - 1, entryIndex + params.maxHoldBars - 1);
    let exitIndex = lastExitIndex;
    let exitPrice = candles[lastExitIndex].close;
    let exitReason = "time";
    for (let index = entryIndex; index <= lastExitIndex; index += 1) {
      const exit = exitForTrade(decision.action, candles[index], stop, target, true);
      if (!exit) continue;
      exitIndex = index;
      exitPrice = exit.price;
      exitReason = exit.reason;
      break;
    }
    const applicableFunding = fundingForTrade(fundingRates, entryCandle.timestamp, candles[exitIndex].timestamp);
    const execution = calculateExecutionAwareTrade({
      market: "CRYPTO_FUTURES",
      action: decision.action,
      entryPrice: entryCandle.open,
      exitPrice,
      quantity,
      leverage: 1,
      entryFeeRate: baseCosts.entryFeeRate * costMultiplier,
      exitFeeRate: baseCosts.exitFeeRate * costMultiplier,
      taxRate: 0,
      slippageRate: baseCosts.slippageRate * costMultiplier,
      spreadRate: baseCosts.spreadRate * costMultiplier,
      latencyBars: baseCosts.latencyBars,
      latencyDriftRate: baseCosts.latencyDriftRate,
      fundingRates: applicableFunding,
    });
    trades.push(Object.freeze({
      ...execution,
      symbol: raw.symbol ?? record.symbol,
      timeframe: raw.timeframe ?? record.timeframe,
      anchorTimestamp: record.anchorTimestamp,
      entryTimestamp: entryCandle.timestamp,
      exitTimestamp: candles[exitIndex].timestamp,
      exitReason,
      stop,
      target,
      probability: decision.probability,
      probabilityEdge: decision.edge,
      fundingEvents: applicableFunding.length,
      modelId: raw.model.id,
    }));
    blockedUntilIndex = exitIndex;
  }

  return Object.freeze({
    params,
    modelId: raw.model.id,
    costMultiplier,
    trades: Object.freeze(trades),
    metrics: summaryFromTrades(trades, capital),
  });
}

function aggregate(items, initialCapital) {
  const trades = items.flatMap((item) => item.simulation.trades);
  const metrics = summaryFromTrades(trades, initialCapital);
  const positiveSymbols = items.filter((item) => item.simulation.metrics.expectancyReturn > 0 && item.simulation.metrics.profitFactor > 1).length;
  return Object.freeze({
    metrics,
    positiveSymbols,
    symbolCount: items.length,
    perSymbol: Object.freeze(Object.fromEntries(items.map((item) => [item.symbol, item.simulation.metrics]))),
  });
}

export function evaluateFrozenFuturesDatasets({ datasets, model, params, segment = "test", costMultiplier = 1, initialCapital = DEFAULT_CAPITAL }) {
  if (!Array.isArray(datasets) || datasets.length === 0) throw new TypeError("datasets are required");
  const items = datasets.map((dataset) => {
    const records = dataset?.split?.[segment] ?? dataset?.records ?? [];
    return Object.freeze({
      symbol: dataset.symbol,
      simulation: simulateFrozenFuturesModel({
        symbol: dataset.symbol,
        timeframe: dataset.timeframe,
        candles: dataset.candles,
        fundingRates: dataset.fundingRates,
        records,
        model,
        params,
        costMultiplier,
        initialCapital,
      }),
    });
  });
  return aggregate(items, initialCapital);
}

function objective(summary) {
  const metrics = summary.metrics;
  if (metrics.tradeCount < Math.max(12, summary.symbolCount * 5)) return -1_000;
  const pf = Number.isFinite(metrics.profitFactor) ? Math.min(metrics.profitFactor, 5) : 5;
  return metrics.expectancyReturn * 200 + metrics.totalReturn * 10 + (pf - 1) * 2 + metrics.sharpeLike * 0.3
    + (summary.positiveSymbols / summary.symbolCount) * 2 - metrics.maximumDrawdown * 10;
}

function passGate(summary, { minimumTrades, requireBothDirections = true } = {}) {
  const metrics = summary.metrics;
  const minimum = minimumTrades ?? Math.max(18, summary.symbolCount * 6);
  const directionOk = !requireBothDirections || (metrics.directionCounts.LONG >= 3 && metrics.directionCounts.SHORT >= 3);
  return metrics.tradeCount >= minimum
    && metrics.expectancyReturn > 0
    && metrics.profitFactor >= 1.05
    && metrics.maximumDrawdown <= 0.35
    && summary.positiveSymbols >= Math.ceil(summary.symbolCount * 2 / 3)
    && directionOk;
}

export function expandFuturesPnlGrid(raw = {}) {
  const values = {
    minDirectionalProbability: raw.minDirectionalProbability ?? [0.38, 0.42, 0.46, 0.50],
    minProbabilityEdge: raw.minProbabilityEdge ?? [0.02, 0.05, 0.08],
    stopAtrMultiple: raw.stopAtrMultiple ?? [1.5, 2, 2.5],
    rewardRisk: raw.rewardRisk ?? [1.5, 2],
    maxHoldBars: raw.maxHoldBars ?? [8, 12],
  };
  const grid = [];
  for (const minDirectionalProbability of values.minDirectionalProbability)
    for (const minProbabilityEdge of values.minProbabilityEdge)
      for (const stopAtrMultiple of values.stopAtrMultiple)
        for (const rewardRisk of values.rewardRisk)
          for (const maxHoldBars of values.maxHoldBars) grid.push(Object.freeze({
            minDirectionalProbability, minProbabilityEdge, atrPeriod: 14, stopAtrMultiple, rewardRisk, maxHoldBars, riskPerTrade: DEFAULT_RISK_PER_TRADE,
          }));
  return Object.freeze(grid);
}

function rollingWindows(records, count = 4) {
  const ordered = [...records].sort((a, b) => a.anchorTimestamp - b.anchorTimestamp);
  if (ordered.length < count * 10) return [];
  const size = Math.floor(ordered.length / count);
  return Array.from({ length: count }, (_, index) => {
    const start = index * size;
    const end = index === count - 1 ? ordered.length : (index + 1) * size;
    return Object.freeze(ordered.slice(start, end));
  });
}

function futureTimeAudit(datasets, model, params, initialCapital) {
  const perDatasetWindows = datasets.map((dataset) => ({ dataset, windows: rollingWindows(dataset.split.test, 4) }));
  const maxWindows = Math.min(...perDatasetWindows.map((item) => item.windows.length));
  if (!(maxWindows > 0)) return Object.freeze({ passed: false, activeWindows: 0, positiveWindows: 0, windows: Object.freeze([]) });
  const windows = [];
  for (let index = 0; index < maxWindows; index += 1) {
    const items = perDatasetWindows.map(({ dataset, windows: recordWindows }) => ({
      symbol: dataset.symbol,
      simulation: simulateFrozenFuturesModel({
        symbol: dataset.symbol,
        timeframe: dataset.timeframe,
        candles: dataset.candles,
        fundingRates: dataset.fundingRates,
        records: recordWindows[index],
        model,
        params,
        initialCapital,
      }),
    }));
    const summary = aggregate(items, initialCapital);
    windows.push(Object.freeze({ index: index + 1, summary, passed: summary.metrics.expectancyReturn > 0 && summary.metrics.profitFactor > 1 }));
  }
  const positiveWindows = windows.filter((window) => window.passed).length;
  return Object.freeze({
    passed: windows.length >= 3 && positiveWindows >= Math.ceil(windows.length * 0.75),
    activeWindows: windows.length,
    positiveWindows,
    windows: Object.freeze(windows),
    parametersRetunedPerWindow: false,
    futureWindowsUsedForSelection: false,
  });
}

export function optimizeFrozenFuturesPnl(raw = {}) {
  if (!raw.model?.trained) throw new TypeError("trained frozen model is required");
  if (!Array.isArray(raw.seedDatasets) || raw.seedDatasets.length < 2) throw new TypeError("at least two seed datasets are required");
  if (!Array.isArray(raw.holdoutDatasets) || raw.holdoutDatasets.length < 1) throw new TypeError("at least one unseen holdout dataset is required");
  const initialCapital = positive(raw.initialCapital ?? DEFAULT_CAPITAL, "initialCapital");
  const stressMultiplier = positive(raw.stressMultiplier ?? 1.5, "stressMultiplier");
  const grid = raw.grid ? expandFuturesPnlGrid(raw.grid) : expandFuturesPnlGrid();
  if (!grid.length || grid.length > 2_000) throw new TypeError("futures PnL grid must contain 1..2000 candidates");

  const trained = grid.map((params) => ({ params, train: evaluateFrozenFuturesDatasets({ datasets: raw.seedDatasets, model: raw.model, params, segment: "train", initialCapital }) }))
    .sort((a, b) => objective(b.train) - objective(a.train));
  const finalists = trained.slice(0, Math.min(24, trained.length)).map((candidate) => ({
    ...candidate,
    validation: evaluateFrozenFuturesDatasets({ datasets: raw.seedDatasets, model: raw.model, params: candidate.params, segment: "validation", initialCapital }),
  })).sort((a, b) => objective(b.validation) - objective(a.validation));
  const selected = finalists.find((candidate) => passGate(candidate.validation, { minimumTrades: 16 })) ?? finalists[0];
  if (!selected) throw new Error("no futures PnL candidate could be selected");

  const seedTest = evaluateFrozenFuturesDatasets({ datasets: raw.seedDatasets, model: raw.model, params: selected.params, segment: "test", initialCapital });
  const stressedSeedTest = evaluateFrozenFuturesDatasets({ datasets: raw.seedDatasets, model: raw.model, params: selected.params, segment: "test", costMultiplier: stressMultiplier, initialCapital });
  const holdout = evaluateFrozenFuturesDatasets({ datasets: raw.holdoutDatasets, model: raw.model, params: selected.params, segment: "test", initialCapital });
  const stressedHoldout = evaluateFrozenFuturesDatasets({ datasets: raw.holdoutDatasets, model: raw.model, params: selected.params, segment: "test", costMultiplier: stressMultiplier, initialCapital });
  const rolling = futureTimeAudit(raw.seedDatasets, raw.model, selected.params, initialCapital);
  const validationPassed = passGate(selected.validation, { minimumTrades: 16 });
  const seedTestPassed = passGate(seedTest);
  const stressPassed = passGate(stressedSeedTest, { minimumTrades: 12 });
  const holdoutPassed = passGate(holdout, { minimumTrades: 8, requireBothDirections: false });
  const holdoutStressPassed = passGate(stressedHoldout, { minimumTrades: 6, requireBothDirections: false });
  const status = validationPassed && seedTestPassed && stressPassed && holdoutPassed && holdoutStressPassed && rolling.passed
    ? "shadow_pnl_candidate"
    : "research_hold";

  return Object.freeze({
    schemaVersion: 1,
    status,
    researchOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    modelId: raw.model.id,
    selectionContract: Object.freeze({
      trainGridCandidates: grid.length,
      validationFinalists: finalists.length,
      seedTestUsedForSelection: false,
      unseenHoldoutUsedForSelection: false,
      futureWindowsUsedForSelection: false,
      parametersRetunedOnHoldout: false,
    }),
    costAssumptions: Object.freeze({
      base: BITGET_STANDARD_TAKER_RESEARCH_COSTS.CRYPTO_FUTURES,
      stressMultiplier,
      fundingUsesObservedHistoricalRates: true,
      fundingStressMultiplierApplied: false,
      note: "Fee/spread/slippage stress is multiplied conservatively; observed historical funding is kept unchanged because funding can be either a cost or a credit depending on side.",
    }),
    params: selected.params,
    train: selected.train,
    validation: selected.validation,
    seedTest,
    stressedSeedTest,
    unseenHoldout: holdout,
    stressedUnseenHoldout: stressedHoldout,
    futureTimeRolling: rolling,
    gates: Object.freeze({ validationPassed, seedTestPassed, stressPassed, holdoutPassed, holdoutStressPassed, rollingPassed: rolling.passed }),
  });
}

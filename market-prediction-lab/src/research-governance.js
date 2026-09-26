import { MARKETS } from "./contracts.js";
import { sha256, stableStringify } from "./data-quality.js";

const ACTIONS = Object.freeze(["BUY", "SELL", "LONG", "SHORT"]);
const CASH_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]);
const CLASS_NAMES = Object.freeze(["bullish", "neutral", "bearish"]);

export class ResearchContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ResearchContractError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export const RESEARCH_MARKET_PROFILES = Object.freeze({
  KR_STOCK: Object.freeze({
    market: "KR_STOCK",
    actions: Object.freeze(["BUY", "SELL"]),
    openingActions: Object.freeze(["BUY"]),
    closingActions: Object.freeze(["SELL"]),
    positionMode: "long_only",
    maximumLeverage: 1,
    fundingApplicable: false,
    taxApplicable: true,
  }),
  US_STOCK: Object.freeze({
    market: "US_STOCK",
    actions: Object.freeze(["BUY", "SELL"]),
    openingActions: Object.freeze(["BUY"]),
    closingActions: Object.freeze(["SELL"]),
    positionMode: "long_only",
    maximumLeverage: 1,
    fundingApplicable: false,
    taxApplicable: true,
  }),
  CRYPTO_SPOT: Object.freeze({
    market: "CRYPTO_SPOT",
    actions: Object.freeze(["BUY", "SELL"]),
    openingActions: Object.freeze(["BUY"]),
    closingActions: Object.freeze(["SELL"]),
    positionMode: "long_only",
    maximumLeverage: 1,
    fundingApplicable: false,
    taxApplicable: false,
  }),
  CRYPTO_FUTURES: Object.freeze({
    market: "CRYPTO_FUTURES",
    actions: Object.freeze(["LONG", "SHORT"]),
    openingActions: Object.freeze(["LONG", "SHORT"]),
    closingActions: Object.freeze([]),
    positionMode: "two_sided",
    maximumLeverage: 10,
    fundingApplicable: true,
    taxApplicable: false,
  }),
});

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ResearchContractError("NON_FINITE_NUMBER", `${label} must be finite`, { label, value });
  }
  return value;
}

function nonNegativeRate(value, label) {
  finite(value, label);
  if (value < 0 || value >= 1) {
    throw new ResearchContractError("INVALID_RATE", `${label} must be between 0 and 1`, { label, value });
  }
  return value;
}

function assertMarket(market) {
  if (!MARKETS.includes(market) || !RESEARCH_MARKET_PROFILES[market]) {
    throw new ResearchContractError("INVALID_MARKET", `unsupported market: ${market}`, { market });
  }
  return RESEARCH_MARKET_PROFILES[market];
}

export function normalizeResearchSymbol(market, input) {
  assertMarket(market);
  const symbol = String(input ?? "").trim().toUpperCase();
  if (market === "KR_STOCK") {
    if (!/^\d{6}$/.test(symbol)) throw new ResearchContractError("INVALID_KR_SYMBOL", "KR stock symbol must be six digits");
    return symbol;
  }
  if (market === "US_STOCK") {
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) throw new ResearchContractError("INVALID_US_SYMBOL", "US stock symbol is invalid");
    return symbol;
  }
  if (market === "CRYPTO_SPOT") {
    const normalized = symbol.replace("/", "-");
    if (!/^(KRW|USDT|BTC)-[A-Z0-9]{2,15}$/.test(normalized)) {
      throw new ResearchContractError("INVALID_SPOT_SYMBOL", "spot symbol must use quote-base format such as KRW-BTC");
    }
    return normalized;
  }
  const normalized = symbol.replace(/[-_/]/g, "");
  if (!/^[A-Z0-9]{2,16}USDT$/.test(normalized)) {
    throw new ResearchContractError("INVALID_FUTURES_SYMBOL", "futures symbol must use BTCUSDT style");
  }
  return normalized;
}

export function validateResearchAction({ market, action, leverage = 1, hasOpenPosition = false, fundingRate = 0 }) {
  const profile = assertMarket(market);
  if (!ACTIONS.includes(action) || !profile.actions.includes(action)) {
    throw new ResearchContractError("ACTION_NOT_ALLOWED", `${action} is not allowed for ${market}`, { market, action });
  }
  finite(leverage, "leverage");
  if (leverage < 1 || leverage > profile.maximumLeverage) {
    throw new ResearchContractError("INVALID_LEVERAGE", `leverage must be between 1 and ${profile.maximumLeverage}`, { market, leverage });
  }
  finite(fundingRate, "fundingRate");
  if (!profile.fundingApplicable && fundingRate !== 0) {
    throw new ResearchContractError("FUNDING_NOT_APPLICABLE", `${market} cannot use funding rates`, { market, fundingRate });
  }
  if (profile.closingActions.includes(action) && !hasOpenPosition) {
    throw new ResearchContractError("SELL_WITHOUT_POSITION", `${market} SELL may only reduce or close an existing position`, { market });
  }
  return Object.freeze({
    market,
    action,
    leverage,
    intent: profile.closingActions.includes(action) ? "REDUCE_OR_EXIT" : "OPEN_OR_ADD",
    positionMode: profile.positionMode,
  });
}

function validateTemporalRows(rows, label, asOf) {
  if (!Array.isArray(rows)) throw new ResearchContractError("INVALID_SERIES", `${label} must be an array`);
  const sorted = [...rows].sort((left, right) => left.timestamp - right.timestamp);
  for (let index = 0; index < sorted.length; index += 1) {
    const row = sorted[index];
    if (!row || !Number.isInteger(row.timestamp) || row.timestamp <= 0) {
      throw new ResearchContractError("INVALID_TIMESTAMP", `${label}[${index}] timestamp is invalid`, { label, index });
    }
    if (row.timestamp > asOf) {
      throw new ResearchContractError("FUTURE_DATA", `${label}[${index}] is later than asOf`, { label, index, timestamp: row.timestamp, asOf });
    }
    if (index > 0 && row.timestamp === sorted[index - 1].timestamp) {
      throw new ResearchContractError("DUPLICATE_TIMESTAMP", `${label} contains duplicate timestamps`, { label, timestamp: row.timestamp });
    }
    if (row.observedAt !== undefined) {
      if (!Number.isInteger(row.observedAt) || row.observedAt <= 0) {
        throw new ResearchContractError("INVALID_OBSERVED_AT", `${label}[${index}].observedAt is invalid`, { label, index });
      }
      if (row.observedAt > row.timestamp) {
        throw new ResearchContractError("RETROACTIVE_FEATURE", `${label}[${index}] was observed after its effective timestamp`, {
          label,
          index,
          timestamp: row.timestamp,
          observedAt: row.observedAt,
        });
      }
    }
  }
  return sorted;
}

export function alignResearchSeries({ candles, features = {}, asOf, requireComplete = true }) {
  if (!Number.isInteger(asOf) || asOf <= 0) throw new ResearchContractError("INVALID_AS_OF", "asOf must be a positive integer");
  const candleRows = validateTemporalRows(candles, "candles", asOf);
  if (candleRows.length === 0) throw new ResearchContractError("EMPTY_CANDLES", "candles cannot be empty");
  const featureEntries = Object.entries(features).map(([name, rows]) => [name, validateTemporalRows(rows, `features.${name}`, asOf)]);
  const maps = Object.fromEntries(featureEntries.map(([name, rows]) => [name, new Map(rows.map((row) => [row.timestamp, row]))]));
  const missing = Object.fromEntries(featureEntries.map(([name]) => [name, 0]));
  const aligned = candleRows.map((candle) => {
    const rowFeatures = {};
    for (const [name] of featureEntries) {
      const match = maps[name].get(candle.timestamp);
      if (!match) {
        missing[name] += 1;
        if (requireComplete) {
          throw new ResearchContractError("MISSING_ALIGNED_FEATURE", `${name} is missing at candle timestamp`, { name, timestamp: candle.timestamp });
        }
        rowFeatures[name] = null;
      } else {
        rowFeatures[name] = Object.freeze({ ...match });
      }
    }
    return Object.freeze({ candle: Object.freeze({ ...candle }), features: Object.freeze(rowFeatures) });
  });
  return Object.freeze({
    rows: Object.freeze(aligned),
    quality: Object.freeze({
      candleCount: candleRows.length,
      featureCounts: Object.freeze(Object.fromEntries(featureEntries.map(([name, rows]) => [name, rows.length]))),
      missing: Object.freeze(missing),
      exactTimestampJoin: true,
      futureRowsBlocked: true,
      retroactiveFeaturesBlocked: true,
    }),
  });
}

function firstAnchorAfter(records, startIndex, timestamp) {
  for (let index = startIndex; index < records.length; index += 1) {
    if (records[index].anchorTimestamp > timestamp) return index;
  }
  return records.length;
}

export function createPurgedWalkForwardFolds(rawRecords, options = {}) {
  if (!Array.isArray(rawRecords) || rawRecords.length < 30) {
    throw new ResearchContractError("INSUFFICIENT_RECORDS", "at least 30 records are required");
  }
  const trainSize = options.trainSize ?? 18;
  const validationSize = options.validationSize ?? 6;
  const testSize = options.testSize ?? 6;
  const stepSize = options.stepSize ?? testSize;
  const embargoMs = options.embargoMs ?? 0;
  for (const [label, value] of Object.entries({ trainSize, validationSize, testSize, stepSize })) {
    if (!Number.isInteger(value) || value < 1) throw new ResearchContractError("INVALID_WINDOW", `${label} must be a positive integer`);
  }
  if (!Number.isInteger(embargoMs) || embargoMs < 0) throw new ResearchContractError("INVALID_EMBARGO", "embargoMs must be a non-negative integer");
  const records = [...rawRecords].sort((left, right) => left.anchorTimestamp - right.anchorTimestamp || left.futureEndTimestamp - right.futureEndTimestamp);
  for (let index = 0; index < records.length; index += 1) {
    const row = records[index];
    if (!Number.isInteger(row.anchorTimestamp) || !Number.isInteger(row.futureEndTimestamp) || row.futureEndTimestamp < row.anchorTimestamp) {
      throw new ResearchContractError("INVALID_TEMPORAL_RECORD", `record ${index} has invalid temporal bounds`, { index });
    }
    if (index > 0 && row.anchorTimestamp === records[index - 1].anchorTimestamp) {
      throw new ResearchContractError("DUPLICATE_ANCHOR", "records contain duplicate anchor timestamps", { timestamp: row.anchorTimestamp });
    }
  }
  const folds = [];
  for (let trainStart = 0; trainStart + trainSize < records.length; trainStart += stepSize) {
    const trainEnd = trainStart + trainSize;
    const train = records.slice(trainStart, trainEnd);
    const maxTrainFuture = Math.max(...train.map((row) => row.futureEndTimestamp)) + embargoMs;
    const validationStart = firstAnchorAfter(records, trainEnd, maxTrainFuture);
    const validationEnd = validationStart + validationSize;
    if (validationEnd >= records.length) break;
    const validation = records.slice(validationStart, validationEnd);
    const maxValidationFuture = Math.max(...validation.map((row) => row.futureEndTimestamp)) + embargoMs;
    const testStart = firstAnchorAfter(records, validationEnd, maxValidationFuture);
    const testEnd = testStart + testSize;
    if (testEnd > records.length) break;
    const test = records.slice(testStart, testEnd);
    folds.push(Object.freeze({
      fold: folds.length + 1,
      train: Object.freeze(train),
      validation: Object.freeze(validation),
      test: Object.freeze(test),
      report: Object.freeze({
        purgedTrainValidation: validationStart - trainEnd,
        purgedValidationTest: testStart - validationEnd,
        maxTrainFuture,
        validationFirstAnchor: validation[0].anchorTimestamp,
        maxValidationFuture,
        testFirstAnchor: test[0].anchorTimestamp,
        embargoMs,
      }),
    }));
  }
  if (folds.length === 0) throw new ResearchContractError("NO_VALID_FOLDS", "no leak-free walk-forward folds could be created");
  return Object.freeze(folds);
}

function directionForTrade(market, action) {
  assertMarket(market);
  if (CASH_MARKETS.has(market)) {
    if (action !== "BUY") throw new ResearchContractError("INVALID_ENTRY_ACTION", `${market} backtest entries must use BUY`);
    return 1;
  }
  if (action === "LONG") return 1;
  if (action === "SHORT") return -1;
  throw new ResearchContractError("INVALID_ENTRY_ACTION", "futures entries must use LONG or SHORT");
}

export function calculateTradeResult(input) {
  const profile = assertMarket(input.market);
  const direction = directionForTrade(input.market, input.action);
  const leverage = input.leverage ?? 1;
  validateResearchAction({ market: input.market, action: input.action, leverage, fundingRate: 0 });
  const entryPrice = finite(input.entryPrice, "entryPrice");
  const exitPrice = finite(input.exitPrice, "exitPrice");
  const quantity = finite(input.quantity, "quantity");
  if (!(entryPrice > 0 && exitPrice > 0 && quantity > 0)) throw new ResearchContractError("INVALID_TRADE", "prices and quantity must be greater than zero");
  const entryFeeRate = nonNegativeRate(input.entryFeeRate ?? 0, "entryFeeRate");
  const exitFeeRate = nonNegativeRate(input.exitFeeRate ?? 0, "exitFeeRate");
  const slippageRate = nonNegativeRate(input.slippageRate ?? 0, "slippageRate");
  const taxRate = nonNegativeRate(input.taxRate ?? 0, "taxRate");
  if (!profile.taxApplicable && taxRate !== 0) throw new ResearchContractError("TAX_NOT_APPLICABLE", `${input.market} taxRate must be zero`);
  const fundingRates = input.fundingRates ?? [];
  if (!Array.isArray(fundingRates)) throw new ResearchContractError("INVALID_FUNDING", "fundingRates must be an array");
  if (!profile.fundingApplicable && fundingRates.some((rate) => rate !== 0)) {
    throw new ResearchContractError("FUNDING_NOT_APPLICABLE", `${input.market} cannot include funding rates`);
  }
  fundingRates.forEach((rate, index) => finite(rate, `fundingRates[${index}]`));
  const executedEntry = entryPrice * (direction > 0 ? 1 + slippageRate : 1 - slippageRate);
  const executedExit = exitPrice * (direction > 0 ? 1 - slippageRate : 1 + slippageRate);
  const entryNotional = executedEntry * quantity;
  const exitNotional = executedExit * quantity;
  const rawGrossPnl = direction * (exitPrice - entryPrice) * quantity;
  const grossPnl = direction * (executedExit - executedEntry) * quantity;
  const entryFee = entryNotional * entryFeeRate;
  const exitFee = exitNotional * exitFeeRate;
  const tax = exitNotional * taxRate;
  const fundingRateTotal = fundingRates.reduce((sum, value) => sum + value, 0);
  const funding = profile.fundingApplicable ? entryNotional * fundingRateTotal * direction : 0;
  const slippage = rawGrossPnl - grossPnl;
  const netPnl = grossPnl - entryFee - exitFee - tax - funding;
  const margin = entryNotional / leverage;
  return Object.freeze({
    market: input.market,
    action: input.action,
    direction: direction > 0 ? "long" : "short",
    entryPrice,
    exitPrice,
    executedEntry,
    executedExit,
    quantity,
    leverage,
    entryNotional,
    exitNotional,
    rawGrossPnl,
    grossPnl,
    netPnl,
    netReturnOnMargin: margin > 0 ? netPnl / margin : 0,
    costsIncluded: true,
    costs: Object.freeze({ entryFee, exitFee, tax, funding, slippage, total: entryFee + exitFee + tax + funding + slippage }),
  });
}

export function calculateSignalExcursion({ action, entryPrice, candles }) {
  if (!Array.isArray(candles) || candles.length === 0) throw new ResearchContractError("EMPTY_FUTURE_PATH", "future candles are required");
  const direction = action === "SHORT" ? -1 : action === "LONG" || action === "BUY" ? 1 : 0;
  if (direction === 0) throw new ResearchContractError("INVALID_ENTRY_ACTION", "action must be BUY, LONG or SHORT");
  finite(entryPrice, "entryPrice");
  let maximumFavorable = -Infinity;
  let maximumAdverse = Infinity;
  for (const [index, candle] of candles.entries()) {
    if (!candle || !Number.isFinite(candle.high) || !Number.isFinite(candle.low) || candle.high <= 0 || candle.low <= 0 || candle.high < candle.low) {
      throw new ResearchContractError("INVALID_FUTURE_CANDLE", `future candle ${index} is invalid`, { index });
    }
    const favorable = direction > 0 ? candle.high / entryPrice - 1 : entryPrice / candle.low - 1;
    const adverse = direction > 0 ? candle.low / entryPrice - 1 : entryPrice / candle.high - 1;
    maximumFavorable = Math.max(maximumFavorable, favorable);
    maximumAdverse = Math.min(maximumAdverse, adverse);
  }
  return Object.freeze({ maximumFavorableExcursion: maximumFavorable, maximumAdverseExcursion: maximumAdverse });
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function summarizeTradePerformance(trades) {
  if (!Array.isArray(trades)) throw new ResearchContractError("INVALID_TRADES", "trades must be an array");
  const netPnls = trades.map((trade, index) => finite(trade.netPnl, `trades[${index}].netPnl`));
  const wins = netPnls.filter((value) => value > 0);
  const losses = netPnls.filter((value) => value < 0);
  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  for (const pnl of netPnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
  }
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const totalCosts = trades.reduce((sum, trade) => sum + finite(trade.costs?.total ?? 0, "trade.costs.total"), 0);
  return Object.freeze({
    sampleCount: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    expectancy: mean(netPnls),
    averageWin: mean(wins),
    averageLoss: Math.abs(mean(losses)),
    payoffRatio: losses.length && wins.length ? mean(wins) / Math.abs(mean(losses)) : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    netPnl: netPnls.reduce((sum, value) => sum + value, 0),
    maximumDrawdown,
    totalCosts,
    costsIncluded: trades.every((trade) => trade.costsIncluded === true),
  });
}

function normalizeProbabilities(probabilities, label) {
  if (!probabilities || typeof probabilities !== "object") throw new ResearchContractError("INVALID_PROBABILITIES", `${label} is required`);
  const values = CLASS_NAMES.map((name) => Math.max(0, finite(probabilities[name], `${label}.${name}`)));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) throw new ResearchContractError("INVALID_PROBABILITIES", `${label} total must be positive`);
  return Object.freeze(Object.fromEntries(CLASS_NAMES.map((name, index) => [name, values[index] / total])));
}

function predictedClass(probabilities) {
  return CLASS_NAMES.reduce((best, name) => probabilities[name] > probabilities[best] ? name : best, CLASS_NAMES[0]);
}

export function evaluatePredictionQuality(records, { bins = 10 } = {}) {
  if (!Array.isArray(records) || records.length === 0) throw new ResearchContractError("EMPTY_PREDICTIONS", "prediction records are required");
  if (!Number.isInteger(bins) || bins < 2 || bins > 50) throw new ResearchContractError("INVALID_BINS", "bins must be between 2 and 50");
  const confusion = Object.fromEntries(CLASS_NAMES.map((actual) => [actual, Object.fromEntries(CLASS_NAMES.map((predicted) => [predicted, 0]))]));
  const calibration = Array.from({ length: bins }, (_, index) => ({ index, count: 0, confidence: 0, accuracy: 0 }));
  let brier = 0;
  for (const [index, record] of records.entries()) {
    if (!CLASS_NAMES.includes(record.actual)) throw new ResearchContractError("INVALID_ACTUAL_CLASS", `records[${index}].actual is invalid`);
    const probabilities = normalizeProbabilities(record.probabilities, `records[${index}].probabilities`);
    const predicted = predictedClass(probabilities);
    confusion[record.actual][predicted] += 1;
    brier += CLASS_NAMES.reduce((sum, name) => sum + (probabilities[name] - (name === record.actual ? 1 : 0)) ** 2, 0);
    const confidence = probabilities[predicted];
    const bucket = calibration[Math.min(bins - 1, Math.floor(confidence * bins))];
    bucket.count += 1;
    bucket.confidence += confidence;
    bucket.accuracy += predicted === record.actual ? 1 : 0;
  }
  const perClass = {};
  for (const name of CLASS_NAMES) {
    const tp = confusion[name][name];
    const fp = CLASS_NAMES.reduce((sum, actual) => sum + (actual === name ? 0 : confusion[actual][name]), 0);
    const fn = CLASS_NAMES.reduce((sum, predicted) => sum + (predicted === name ? 0 : confusion[name][predicted]), 0);
    const precision = tp / Math.max(tp + fp, 1);
    const recall = tp / Math.max(tp + fn, 1);
    perClass[name] = Object.freeze({ precision, recall, f1: 2 * precision * recall / Math.max(precision + recall, 1e-12) });
  }
  const calibrationBins = calibration.map((bucket) => {
    const averageConfidence = bucket.count ? bucket.confidence / bucket.count : 0;
    const accuracy = bucket.count ? bucket.accuracy / bucket.count : 0;
    return Object.freeze({ index: bucket.index, count: bucket.count, averageConfidence, accuracy, gap: Math.abs(averageConfidence - accuracy) });
  });
  const expectedCalibrationError = calibrationBins.reduce((sum, bucket) => sum + (bucket.count / records.length) * bucket.gap, 0);
  return Object.freeze({
    sampleCount: records.length,
    brier: brier / records.length,
    macroF1: CLASS_NAMES.reduce((sum, name) => sum + perClass[name].f1, 0) / CLASS_NAMES.length,
    expectedCalibrationError,
    maximumCalibrationError: Math.max(...calibrationBins.map((bucket) => bucket.gap)),
    perClass: Object.freeze(perClass),
    confusion: Object.freeze(confusion),
    calibrationBins: Object.freeze(calibrationBins),
  });
}

export function comparePaperToBacktest({ backtest, paper }) {
  for (const [label, metrics] of Object.entries({ backtest, paper })) {
    if (!metrics || typeof metrics !== "object") throw new ResearchContractError("INVALID_COMPARISON", `${label} metrics are required`);
  }
  const delta = (name) => finite(paper[name], `paper.${name}`) - finite(backtest[name], `backtest.${name}`);
  return Object.freeze({
    sampleCount: Object.freeze({ backtest: backtest.sampleCount ?? 0, paper: paper.sampleCount ?? 0 }),
    winRateDelta: delta("winRate"),
    expectancyDelta: delta("expectancy"),
    maximumDrawdownDelta: delta("maximumDrawdown"),
    totalCostDelta: delta("totalCosts"),
    absoluteExpectancyGap: Math.abs(delta("expectancy")),
  });
}

function allSymbolsMeet(perSymbol, minimum) {
  const entries = Object.entries(perSymbol ?? {});
  return entries.length > 0 && entries.every(([, count]) => Number.isInteger(count) && count >= minimum);
}

export function evaluateResearchPromotion(input, thresholds = {}) {
  const limits = Object.freeze({
    minSamples: thresholds.minSamples ?? 300,
    minPerSymbol: thresholds.minPerSymbol ?? 100,
    minObservationMs: thresholds.minObservationMs ?? 28 * 24 * 60 * 60 * 1000,
    minRegimes: thresholds.minRegimes ?? 2,
    maxDrawdown: thresholds.maxDrawdown ?? Infinity,
    maxBrierRegression: thresholds.maxBrierRegression ?? 0,
    maxMacroF1Regression: thresholds.maxMacroF1Regression ?? 0,
    maxCalibrationError: thresholds.maxCalibrationError ?? 0.12,
    maxPaperExpectancyGap: thresholds.maxPaperExpectancyGap ?? Infinity,
  });
  const reasons = [];
  if ((input.sampleCount ?? 0) < limits.minSamples) reasons.push("insufficient_samples");
  if (!allSymbolsMeet(input.perSymbolSamples, limits.minPerSymbol)) reasons.push("insufficient_per_symbol_samples");
  if ((input.observationMs ?? 0) < limits.minObservationMs) reasons.push("insufficient_observation_period");
  if ((input.qualifiedRegimes ?? 0) < limits.minRegimes) reasons.push("insufficient_regime_diversity");
  if (input.costsIncluded !== true) reasons.push("costs_not_included");
  if (input.walkForwardValidated !== true) reasons.push("walk_forward_not_validated");
  if (input.reproducible !== true) reasons.push("result_not_reproducible");
  if (input.integrityVerified !== true) reasons.push("integrity_not_verified");
  if (input.candidate.maximumDrawdown > limits.maxDrawdown) reasons.push("maximum_drawdown_exceeded");
  if (input.candidate.brier > input.baseline.brier + limits.maxBrierRegression) reasons.push("brier_regressed");
  if (input.candidate.macroF1 < input.baseline.macroF1 - limits.maxMacroF1Regression) reasons.push("macro_f1_regressed");
  if (input.candidate.expectedCalibrationError > limits.maxCalibrationError) reasons.push("calibration_error_exceeded");
  if (Math.abs(input.paperComparison?.expectancyDelta ?? Infinity) > limits.maxPaperExpectancyGap) reasons.push("paper_backtest_gap_exceeded");
  return Object.freeze({
    approved: reasons.length === 0,
    status: reasons.length === 0 ? "integration_review_ready" : "research_hold",
    reasons: Object.freeze(reasons),
    automaticOperationsAllowed: false,
    mainMergeAllowed: false,
    deploymentAllowed: false,
  });
}

export function createResearchArtifact(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ResearchContractError("INVALID_ARTIFACT", "payload must be an object");
  if (!Number.isInteger(payload.evaluatedAt) || payload.evaluatedAt <= 0) {
    throw new ResearchContractError("INVALID_EVALUATED_AT", "evaluatedAt must be an explicit positive integer for reproducibility");
  }
  const canonicalPayload = JSON.parse(stableStringify(payload));
  const integrityHash = sha256(stableStringify(canonicalPayload));
  return Object.freeze({ schemaVersion: 1, integrityHash, payload: Object.freeze(canonicalPayload) });
}

export function verifyResearchArtifact(artifact) {
  if (!artifact || artifact.schemaVersion !== 1 || typeof artifact.integrityHash !== "string") return false;
  return sha256(stableStringify(artifact.payload)) === artifact.integrityHash;
}

import { predictTinyModel } from "./tiny-model.js";
import { futuresDecisionFromProbabilities } from "./futures-model-pnl-audit.js";
import { calculateExecutionAwareTrade } from "./research-validation-layer.js";
import { BITGET_STANDARD_TAKER_RESEARCH_COSTS } from "./historical-backtest-data.js";
import {
  FUTURES_REGIME_EXECUTION_CANDIDATE,
  FUTURES_REGIME_EXECUTION_CANDIDATE_SHA256,
} from "./futures-regime-execution-candidate.js";

const DEFAULT_CAPITAL = 1_000_000;
const MAX_FUNDING_AGE_MS = 12 * 60 * 60 * 1000;

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

function validateCandles(rawCandles) {
  if (!Array.isArray(rawCandles) || rawCandles.length < 160) throw new TypeError("at least 160 futures candles are required");
  let previousTimestamp = 0;
  return Object.freeze(rawCandles.map((raw, index) => {
    const timestamp = Number(raw?.timestamp);
    const open = positive(raw?.open, `candles[${index}].open`);
    const high = positive(raw?.high, `candles[${index}].high`);
    const low = positive(raw?.low, `candles[${index}].low`);
    const close = positive(raw?.close, `candles[${index}].close`);
    const volume = finite(raw?.volume ?? 0, `candles[${index}].volume`);
    if (!Number.isInteger(timestamp) || timestamp <= previousTimestamp) throw new TypeError("futures candles must have increasing timestamps");
    if (volume < 0 || high < Math.max(open, close) || low > Math.min(open, close) || high < low) throw new TypeError("invalid futures OHLCV");
    previousTimestamp = timestamp;
    return Object.freeze({ timestamp, open, high, low, close, volume });
  }));
}

function normalizeFunding(raw = []) {
  if (!Array.isArray(raw)) throw new TypeError("fundingRates must be an array");
  return Object.freeze([...raw].map((row, index) => Object.freeze({
    timestamp: Number(row?.timestamp),
    rate: finite(row?.rate, `fundingRates[${index}].rate`),
  })).filter((row) => Number.isInteger(row.timestamp) && row.timestamp > 0).sort((a, b) => a.timestamp - b.timestamp));
}

function sma(candles, endIndex, period) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  let total = 0;
  for (let index = start; index <= endIndex; index += 1) total += candles[index].close;
  return total / period;
}

function trueRange(candle, previousClose) {
  return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
}

function atr(candles, endIndex, period = 14) {
  if (endIndex < period) return null;
  let total = 0;
  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    if (index <= 0) return null;
    total += trueRange(candles[index], candles[index - 1].close);
  }
  return total / period;
}

function normalizeRegimeParams(raw = {}) {
  const params = {
    trendMaPeriod: Number(raw.trendMaPeriod),
    trendSlopeBars: Number(raw.trendSlopeBars),
    maxAtrFraction: Number(raw.maxAtrFraction),
    fundingCrowdingAbsRate: Number(raw.fundingCrowdingAbsRate),
  };
  if (!Number.isInteger(params.trendMaPeriod) || params.trendMaPeriod < 20 || params.trendMaPeriod > 250) throw new TypeError("invalid trendMaPeriod");
  if (!Number.isInteger(params.trendSlopeBars) || params.trendSlopeBars < 1 || params.trendSlopeBars > 50) throw new TypeError("invalid trendSlopeBars");
  if (!(params.maxAtrFraction > 0.001 && params.maxAtrFraction <= 0.1)) throw new TypeError("invalid maxAtrFraction");
  if (!(params.fundingCrowdingAbsRate > 0 && params.fundingCrowdingAbsRate <= 0.01)) throw new TypeError("invalid fundingCrowdingAbsRate");
  return Object.freeze(params);
}

function latestFundingAt(fundingRows, timestamp) {
  let latest = null;
  for (const row of fundingRows) {
    if (row.timestamp > timestamp) break;
    latest = row;
  }
  if (!latest || timestamp - latest.timestamp > MAX_FUNDING_AGE_MS) return null;
  return latest;
}

export function evaluateFuturesRegimeGate({ candles, anchorIndex, action, fundingRates, params }) {
  const normalized = normalizeRegimeParams(params);
  const currentMa = sma(candles, anchorIndex, normalized.trendMaPeriod);
  const priorMa = sma(candles, anchorIndex - normalized.trendSlopeBars, normalized.trendMaPeriod);
  const signalAtr = atr(candles, anchorIndex, FUTURES_REGIME_EXECUTION_CANDIDATE.frozenExecutionParams.atrPeriod);
  const candle = candles[anchorIndex];
  const funding = latestFundingAt(fundingRates, candle.timestamp);
  const reasons = [];
  if (!(currentMa > 0 && priorMa > 0 && signalAtr > 0)) reasons.push("insufficient_regime_history");
  const atrFraction = signalAtr > 0 ? signalAtr / candle.close : null;
  if (atrFraction != null && atrFraction > normalized.maxAtrFraction) reasons.push("volatility_above_gate");
  if (!funding) reasons.push("fresh_funding_missing");
  if (currentMa > 0 && priorMa > 0) {
    if (action === "LONG" && !(candle.close > currentMa && currentMa > priorMa)) reasons.push("long_trend_not_aligned");
    if (action === "SHORT" && !(candle.close < currentMa && currentMa < priorMa)) reasons.push("short_trend_not_aligned");
  }
  if (funding) {
    if (action === "LONG" && funding.rate > normalized.fundingCrowdingAbsRate) reasons.push("long_funding_crowded");
    if (action === "SHORT" && funding.rate < -normalized.fundingCrowdingAbsRate) reasons.push("short_funding_crowded");
  }
  return Object.freeze({
    passed: reasons.length === 0,
    reasons: Object.freeze(reasons),
    atr: signalAtr,
    atrFraction,
    currentMa,
    priorMa,
    fundingRate: funding?.rate ?? null,
    fundingTimestamp: funding?.timestamp ?? null,
  });
}

function fundingDuringTrade(fundingRows, entryTimestamp, exitTimestamp) {
  return fundingRows.filter((row) => row.timestamp > entryTimestamp && row.timestamp <= exitTimestamp).map((row) => row.rate);
}

function exitForTrade(action, candle, stop, target) {
  if (action === "LONG") {
    if (candle.open <= stop) return { price: candle.open, reason: "stop_gap" };
    if (candle.open >= target) return { price: target, reason: "target_gap" };
    const stopHit = candle.low <= stop;
    const targetHit = candle.high >= target;
    if (stopHit && targetHit) return { price: stop, reason: "stop_same_bar_conservative" };
    if (stopHit) return { price: stop, reason: "stop" };
    if (targetHit) return { price: target, reason: "target" };
  } else {
    if (candle.open >= stop) return { price: candle.open, reason: "stop_gap" };
    if (candle.open <= target) return { price: target, reason: "target_gap" };
    const stopHit = candle.high >= stop;
    const targetHit = candle.low <= target;
    if (stopHit && targetHit) return { price: stop, reason: "stop_same_bar_conservative" };
    if (stopHit) return { price: stop, reason: "stop" };
    if (targetHit) return { price: target, reason: "target" };
  }
  return null;
}

function quantityForRisk(capital, entryPrice, stopPrice) {
  const stopDistance = Math.abs(entryPrice - stopPrice);
  if (!(stopDistance > 0)) return 0;
  const riskCash = capital * FUTURES_REGIME_EXECUTION_CANDIDATE.frozenExecutionParams.riskPerTrade;
  return Math.min(riskCash / stopDistance, capital / entryPrice);
}

function summarizeTrades(trades, initialCapital) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const returns = trades.map((trade) => trade.netReturnOnMargin);
  let equity = initialCapital;
  let peak = initialCapital;
  let maximumDrawdown = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  const expectancyReturn = mean(returns);
  const deviation = stddev(returns);
  return Object.freeze({
    tradeCount: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    netPnl: trades.reduce((sum, trade) => sum + trade.netPnl, 0),
    totalReturn: (equity - initialCapital) / initialCapital,
    expectancyReturn,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    maximumDrawdown,
    sharpeLike: deviation > 0 ? expectancyReturn / deviation * Math.sqrt(Math.max(1, trades.length)) : 0,
    totalExecutionCost: trades.reduce((sum, trade) => sum + (trade.costs?.total ?? 0), 0),
    fundingCost: trades.reduce((sum, trade) => sum + (trade.costs?.funding ?? 0), 0),
    directionCounts: Object.freeze({
      LONG: trades.filter((trade) => trade.action === "LONG").length,
      SHORT: trades.filter((trade) => trade.action === "SHORT").length,
    }),
    finalCapital: equity,
  });
}

export function simulateFrozenFuturesRegimeExecution(raw = {}) {
  if (!raw.model?.trained) throw new TypeError("trained frozen futures model is required");
  const candles = validateCandles(raw.candles);
  const fundingRates = normalizeFunding(raw.fundingRates ?? []);
  const records = Array.isArray(raw.records) ? [...raw.records].sort((a, b) => a.anchorTimestamp - b.anchorTimestamp) : [];
  const regimeParams = normalizeRegimeParams(raw.regimeParams);
  const initialCapital = positive(raw.initialCapital ?? DEFAULT_CAPITAL, "initialCapital");
  const costMultiplier = positive(raw.costMultiplier ?? 1, "costMultiplier");
  const fixed = FUTURES_REGIME_EXECUTION_CANDIDATE.frozenExecutionParams;
  const costs = BITGET_STANDARD_TAKER_RESEARCH_COSTS.CRYPTO_FUTURES;
  const indexByTimestamp = new Map(candles.map((candle, index) => [candle.timestamp, index]));
  const trades = [];
  const rejected = {};
  let blockedUntilIndex = -1;

  for (const record of records) {
    const anchorIndex = indexByTimestamp.get(record.anchorTimestamp);
    if (!Number.isInteger(anchorIndex) || anchorIndex + 1 >= candles.length) continue;
    const entryIndex = anchorIndex + 1;
    if (entryIndex <= blockedUntilIndex) continue;
    const prediction = predictTinyModel(record.features, raw.model);
    const decision = futuresDecisionFromProbabilities(prediction.probabilities, fixed);
    if (!decision) {
      rejected.model_abstain = (rejected.model_abstain ?? 0) + 1;
      continue;
    }
    const gate = evaluateFuturesRegimeGate({ candles, anchorIndex, action: decision.action, fundingRates, params: regimeParams });
    if (!gate.passed) {
      for (const reason of gate.reasons) rejected[reason] = (rejected[reason] ?? 0) + 1;
      continue;
    }
    const entryCandle = candles[entryIndex];
    const stopDistance = gate.atr * fixed.stopAtrMultiple;
    const stop = decision.action === "LONG" ? entryCandle.open - stopDistance : entryCandle.open + stopDistance;
    const target = decision.action === "LONG" ? entryCandle.open + stopDistance * fixed.rewardRisk : entryCandle.open - stopDistance * fixed.rewardRisk;
    if (!(stop > 0 && target > 0)) continue;
    const quantity = quantityForRisk(initialCapital, entryCandle.open, stop);
    if (!(quantity > 0)) continue;
    const lastExitIndex = Math.min(candles.length - 1, entryIndex + fixed.maxHoldBars - 1);
    let exitIndex = lastExitIndex;
    let exitPrice = candles[lastExitIndex].close;
    let exitReason = "time";
    for (let index = entryIndex; index <= lastExitIndex; index += 1) {
      const exit = exitForTrade(decision.action, candles[index], stop, target);
      if (!exit) continue;
      exitIndex = index;
      exitPrice = exit.price;
      exitReason = exit.reason;
      break;
    }
    const observedFunding = fundingDuringTrade(fundingRates, entryCandle.timestamp, candles[exitIndex].timestamp);
    const execution = calculateExecutionAwareTrade({
      market: "CRYPTO_FUTURES",
      action: decision.action,
      entryPrice: entryCandle.open,
      exitPrice,
      quantity,
      leverage: 1,
      entryFeeRate: costs.entryFeeRate * costMultiplier,
      exitFeeRate: costs.exitFeeRate * costMultiplier,
      taxRate: 0,
      slippageRate: costs.slippageRate * costMultiplier,
      spreadRate: costs.spreadRate * costMultiplier,
      latencyBars: costs.latencyBars,
      latencyDriftRate: costs.latencyDriftRate,
      fundingRates: observedFunding,
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
      regimeEvidence: gate,
      modelId: raw.model.id,
      candidateManifestSha256: FUTURES_REGIME_EXECUTION_CANDIDATE_SHA256,
    }));
    blockedUntilIndex = exitIndex;
  }

  return Object.freeze({
    candidateId: FUTURES_REGIME_EXECUTION_CANDIDATE.id,
    candidateManifestSha256: FUTURES_REGIME_EXECUTION_CANDIDATE_SHA256,
    regimeParams,
    fixedExecutionParams: fixed,
    costMultiplier,
    trades: Object.freeze(trades),
    rejected: Object.freeze(rejected),
    metrics: summarizeTrades(trades, initialCapital),
    safeguards: Object.freeze({ modelRetrained: false, executionParametersRetuned: false, actualOrders: 0, liveExecutionAllowed: false }),
  });
}

function aggregate(items, initialCapital = DEFAULT_CAPITAL) {
  const trades = items.flatMap((item) => item.simulation.trades);
  const metrics = summarizeTrades(trades, initialCapital);
  const positiveSymbols = items.filter((item) => item.simulation.metrics.expectancyReturn > 0 && item.simulation.metrics.profitFactor > 1).length;
  return Object.freeze({
    metrics,
    positiveSymbols,
    symbolCount: items.length,
    perSymbol: Object.freeze(Object.fromEntries(items.map((item) => [item.symbol, item.simulation.metrics]))),
  });
}

function evaluateDatasets(datasets, model, regimeParams, recordsSelector, costMultiplier = 1) {
  const items = datasets.map((dataset) => Object.freeze({
    symbol: dataset.symbol,
    simulation: simulateFrozenFuturesRegimeExecution({
      symbol: dataset.symbol,
      timeframe: dataset.timeframe,
      candles: dataset.candles,
      fundingRates: dataset.fundingRates,
      records: recordsSelector(dataset),
      model,
      regimeParams,
      costMultiplier,
      initialCapital: DEFAULT_CAPITAL,
    }),
  }));
  return aggregate(items, DEFAULT_CAPITAL);
}

export function expandFuturesRegimeGrid() {
  const search = FUTURES_REGIME_EXECUTION_CANDIDATE.regimeSearch;
  const result = [];
  for (const trendMaPeriod of search.trendMaPeriod)
    for (const trendSlopeBars of search.trendSlopeBars)
      for (const maxAtrFraction of search.maxAtrFraction)
        for (const fundingCrowdingAbsRate of search.fundingCrowdingAbsRate) result.push(Object.freeze({ trendMaPeriod, trendSlopeBars, maxAtrFraction, fundingCrowdingAbsRate }));
  return Object.freeze(result);
}

function passGate(summary, minimumTrades = 10) {
  return summary.metrics.tradeCount >= minimumTrades
    && summary.metrics.expectancyReturn > 0
    && summary.metrics.profitFactor >= 1.1
    && summary.metrics.maximumDrawdown <= 0.10
    && summary.positiveSymbols === summary.symbolCount;
}

function compare(left, right) {
  const leftPass = passGate(left.summary, 8);
  const rightPass = passGate(right.summary, 8);
  if (leftPass !== rightPass) return leftPass ? -1 : 1;
  if (left.summary.metrics.profitFactor !== right.summary.metrics.profitFactor) return right.summary.metrics.profitFactor - left.summary.metrics.profitFactor;
  if (left.summary.metrics.expectancyReturn !== right.summary.metrics.expectancyReturn) return right.summary.metrics.expectancyReturn - left.summary.metrics.expectancyReturn;
  if (left.summary.metrics.totalReturn !== right.summary.metrics.totalReturn) return right.summary.metrics.totalReturn - left.summary.metrics.totalReturn;
  if (left.summary.metrics.maximumDrawdown !== right.summary.metrics.maximumDrawdown) return left.summary.metrics.maximumDrawdown - right.summary.metrics.maximumDrawdown;
  return JSON.stringify(left.params).localeCompare(JSON.stringify(right.params));
}

function rollingAudit(datasets, model, params, count = 4) {
  const windows = [];
  for (let windowIndex = 0; windowIndex < count; windowIndex += 1) {
    const summary = evaluateDatasets(datasets, model, params, (dataset) => {
      const records = dataset.records ?? [];
      const start = Math.floor(records.length * 0.5);
      const tail = records.slice(start);
      const windowSize = Math.max(1, Math.floor(tail.length / count));
      const from = windowIndex * windowSize;
      const to = windowIndex === count - 1 ? tail.length : Math.min(tail.length, from + windowSize);
      return tail.slice(from, to);
    });
    const passed = summary.metrics.tradeCount >= 4
      && summary.metrics.expectancyReturn > 0
      && summary.metrics.profitFactor > 1
      && summary.metrics.maximumDrawdown <= 0.10;
    windows.push(Object.freeze({ index: windowIndex, summary, passed }));
  }
  return Object.freeze({ windows: Object.freeze(windows), positiveWindows: windows.filter((row) => row.passed).length, windowCount: windows.length, parametersRetunedPerWindow: false });
}

export function optimizeFrozenFuturesRegimeExecution(raw = {}) {
  if (!raw.model?.trained) throw new TypeError("trained frozen model is required");
  const designDatasets = Array.isArray(raw.designDatasets) ? raw.designDatasets : [];
  const holdoutDatasets = Array.isArray(raw.holdoutDatasets) ? raw.holdoutDatasets : [];
  if (designDatasets.length !== 2 || holdoutDatasets.length !== 2) throw new TypeError("exactly two design and two holdout datasets are required");
  const designSymbols = designDatasets.map((row) => row.symbol);
  const holdoutSymbols = holdoutDatasets.map((row) => row.symbol);
  if (JSON.stringify(designSymbols) !== JSON.stringify(FUTURES_REGIME_EXECUTION_CANDIDATE.designSymbols)) throw new TypeError("design symbols must match preregistered BNB/XRP order");
  if (JSON.stringify(holdoutSymbols) !== JSON.stringify(FUTURES_REGIME_EXECUTION_CANDIDATE.holdoutSymbols)) throw new TypeError("holdout symbols must match preregistered ADA/DOGE order");
  if ([...designSymbols, ...holdoutSymbols].some((symbol) => FUTURES_REGIME_EXECUTION_CANDIDATE.priorSymbols.includes(symbol))) throw new TypeError("prior BTC/ETH/SOL symbols cannot be reused");
  const stressMultiplier = Number(raw.stressMultiplier ?? 1.5);
  if (!Number.isFinite(stressMultiplier) || stressMultiplier < 1 || stressMultiplier > 3) throw new TypeError("invalid stressMultiplier");
  const grid = expandFuturesRegimeGrid();

  const trained = grid.map((params) => ({
    params,
    summary: evaluateDatasets(designDatasets, raw.model, params, (dataset) => dataset.split?.train ?? []),
  })).sort(compare);
  const finalists = trained.slice(0, Math.min(12, trained.length)).map((candidate) => ({
    params: candidate.params,
    train: candidate.summary,
    summary: evaluateDatasets(designDatasets, raw.model, candidate.params, (dataset) => dataset.split?.validation ?? []),
  })).sort(compare);
  const selected = finalists.find((candidate) => passGate(candidate.summary, 8)) ?? finalists[0];
  if (!selected) throw new TypeError("futures regime optimizer could not select a candidate");

  const designTest = evaluateDatasets(designDatasets, raw.model, selected.params, (dataset) => dataset.split?.test ?? []);
  const stressedDesignTest = evaluateDatasets(designDatasets, raw.model, selected.params, (dataset) => dataset.split?.test ?? [], stressMultiplier);
  const holdoutTest = evaluateDatasets(holdoutDatasets, raw.model, selected.params, (dataset) => dataset.split?.test ?? []);
  const stressedHoldout = evaluateDatasets(holdoutDatasets, raw.model, selected.params, (dataset) => dataset.split?.test ?? [], stressMultiplier);
  const rolling = rollingAudit(holdoutDatasets, raw.model, selected.params, 4);
  const validationPassed = passGate(selected.summary, 8);
  const designTestPassed = passGate(designTest, 8);
  const stressPassed = passGate(stressedDesignTest, 8);
  const holdoutPassed = passGate(holdoutTest, 8);
  const holdoutStressPassed = passGate(stressedHoldout, 8);
  const rollingPassed = rolling.positiveWindows >= 3;
  const status = validationPassed && designTestPassed && stressPassed && holdoutPassed && holdoutStressPassed && rollingPassed
    ? "cross_asset_regime_execution_candidate"
    : "research_hold";

  return Object.freeze({
    schemaVersion: 1,
    market: "CRYPTO_FUTURES",
    timeframe: "15m",
    status,
    candidateId: FUTURES_REGIME_EXECUTION_CANDIDATE.id,
    candidateManifestSha256: FUTURES_REGIME_EXECUTION_CANDIDATE_SHA256,
    fixedExecutionParams: FUTURES_REGIME_EXECUTION_CANDIDATE.frozenExecutionParams,
    regimeParams: selected.params,
    train: selected.train,
    validation: selected.summary,
    designTest,
    stressedDesignTest,
    holdoutTest,
    stressedHoldout,
    rolling,
    gates: Object.freeze({ validationPassed, designTestPassed, stressPassed, holdoutPassed, holdoutStressPassed, rollingPassed }),
    selectionContract: Object.freeze({
      gridCandidates: grid.length,
      validationFinalists: finalists.length,
      executionParametersRetuned: false,
      searchedDimensions: Object.freeze(["trendMaPeriod", "trendSlopeBars", "maxAtrFraction", "fundingCrowdingAbsRate"]),
      priorSymbolsUsedForSelection: false,
      designTestUsedForSelection: false,
      holdoutUsedForSelection: false,
      rollingUsedForSelection: false,
    }),
    designSymbols: Object.freeze(designSymbols),
    holdoutSymbols: Object.freeze(holdoutSymbols),
    safeguards: Object.freeze({ researchOnly: true, modelRetrained: false, actualOrders: 0, privateAccountRequests: 0, liveExecutionAllowed: false }),
    limitations: Object.freeze([
      "historical open interest is not backfilled",
      "funding is required fresh at each accepted signal and missing funding fails closed",
      "public candle OHLC cannot reconstruct intrabar path so stop-first is conservative",
      "cross-asset holdout remains historical research rather than prospective Shadow evidence",
    ]),
  });
}

import { calculateExecutionAwareTrade } from "./research-validation-layer.js";
import { BITGET_STANDARD_TAKER_RESEARCH_COSTS } from "./historical-backtest-data.js";
import {
  FUTURES_DONCHIAN_TREND_CANDIDATE,
  FUTURES_DONCHIAN_TREND_CANDIDATE_SHA256,
} from "./futures-donchian-trend-candidate.js";

const DEFAULT_CAPITAL = 1_000_000;

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
  if (!Array.isArray(rawCandles) || rawCandles.length < 600) throw new TypeError("at least 600 futures candles are required");
  let previousTimestamp = 0;
  return Object.freeze(rawCandles.map((raw, index) => {
    const timestamp = Number(raw?.timestamp);
    const open = positive(raw?.open, `candles[${index}].open`);
    const high = positive(raw?.high, `candles[${index}].high`);
    const low = positive(raw?.low, `candles[${index}].low`);
    const close = positive(raw?.close, `candles[${index}].close`);
    const volume = finite(raw?.volume ?? 0, `candles[${index}].volume`);
    if (!Number.isInteger(timestamp) || timestamp <= previousTimestamp) throw new TypeError("futures candles must have strictly increasing timestamps");
    if (volume < 0 || high < Math.max(open, close) || low > Math.min(open, close) || high < low) throw new TypeError("invalid futures OHLCV");
    previousTimestamp = timestamp;
    return Object.freeze({ timestamp, open, high, low, close, volume });
  }));
}

function normalizeFunding(raw = []) {
  if (!Array.isArray(raw)) throw new TypeError("fundingRates must be an array");
  const seen = new Set();
  return Object.freeze([...raw].map((row, index) => {
    const timestamp = Number(row?.timestamp);
    const rate = finite(row?.rate, `fundingRates[${index}].rate`);
    if (!Number.isInteger(timestamp) || timestamp <= 0 || seen.has(timestamp)) throw new TypeError("funding timestamps must be unique positive integers");
    seen.add(timestamp);
    return Object.freeze({ timestamp, rate });
  }).sort((a, b) => a.timestamp - b.timestamp));
}

function normalizeParams(raw = {}) {
  const params = {
    breakoutLookback: Number(raw.breakoutLookback),
    trendMaPeriod: Number(raw.trendMaPeriod),
    stopAtrMultiple: Number(raw.stopAtrMultiple),
    maxHoldBars: Number(raw.maxHoldBars),
    maxAtrFraction: Number(raw.maxAtrFraction),
    fundingCrowdingAbsRate: Number(raw.fundingCrowdingAbsRate),
    atrPeriod: FUTURES_DONCHIAN_TREND_CANDIDATE.fixed.atrPeriod,
    trailingAtrMultiple: FUTURES_DONCHIAN_TREND_CANDIDATE.fixed.trailingAtrMultiple,
    riskPerTrade: FUTURES_DONCHIAN_TREND_CANDIDATE.fixed.riskPerTrade,
  };
  for (const name of ["breakoutLookback", "trendMaPeriod", "maxHoldBars", "atrPeriod"]) {
    if (!Number.isInteger(params[name]) || params[name] < 2 || params[name] > 500) throw new TypeError(`invalid ${name}`);
  }
  if (!(params.stopAtrMultiple >= 0.5 && params.stopAtrMultiple <= 8)) throw new TypeError("invalid stopAtrMultiple");
  if (!(params.trailingAtrMultiple >= 0.5 && params.trailingAtrMultiple <= 8)) throw new TypeError("invalid trailingAtrMultiple");
  if (!(params.maxAtrFraction > 0 && params.maxAtrFraction <= 0.2)) throw new TypeError("invalid maxAtrFraction");
  if (!(params.fundingCrowdingAbsRate > 0 && params.fundingCrowdingAbsRate <= 0.01)) throw new TypeError("invalid fundingCrowdingAbsRate");
  return Object.freeze(params);
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

function atr(candles, endIndex, period) {
  if (endIndex < period) return null;
  let total = 0;
  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    if (index <= 0) return null;
    total += trueRange(candles[index], candles[index - 1].close);
  }
  return total / period;
}

function highestHighBefore(candles, index, period) {
  const start = index - period;
  if (start < 0) return null;
  let highest = -Infinity;
  for (let cursor = start; cursor < index; cursor += 1) highest = Math.max(highest, candles[cursor].high);
  return Number.isFinite(highest) ? highest : null;
}

function lowestLowBefore(candles, index, period) {
  const start = index - period;
  if (start < 0) return null;
  let lowest = Infinity;
  for (let cursor = start; cursor < index; cursor += 1) lowest = Math.min(lowest, candles[cursor].low);
  return Number.isFinite(lowest) ? lowest : null;
}

function latestFundingAt(fundingRows, timestamp) {
  let latest = null;
  for (const row of fundingRows) {
    if (row.timestamp > timestamp) break;
    latest = row;
  }
  if (!latest || timestamp - latest.timestamp > FUTURES_DONCHIAN_TREND_CANDIDATE.fixed.fundingFreshnessMs) return null;
  return latest;
}

function signalAt(candles, fundingRows, index, params) {
  const signalAtr = atr(candles, index, params.atrPeriod);
  const trendMa = sma(candles, index, params.trendMaPeriod);
  const priorHigh = highestHighBefore(candles, index, params.breakoutLookback);
  const priorLow = lowestLowBefore(candles, index, params.breakoutLookback);
  const candle = candles[index];
  const funding = latestFundingAt(fundingRows, candle.timestamp);
  if (!(signalAtr > 0 && trendMa > 0 && priorHigh > 0 && priorLow > 0 && funding)) return Object.freeze({ action: null, reason: "missing_regime_evidence" });
  const atrFraction = signalAtr / candle.close;
  if (atrFraction > params.maxAtrFraction) return Object.freeze({ action: null, reason: "volatility_above_gate", atrFraction, fundingRate: funding.rate });

  const longBreakout = candle.close > priorHigh && candle.close > trendMa;
  const shortBreakout = candle.close < priorLow && candle.close < trendMa;
  if (longBreakout) {
    if (funding.rate > params.fundingCrowdingAbsRate) return Object.freeze({ action: null, reason: "long_funding_crowded", atrFraction, fundingRate: funding.rate });
    return Object.freeze({ action: "LONG", atr: signalAtr, atrFraction, fundingRate: funding.rate, breakoutLevel: priorHigh, trendMa });
  }
  if (shortBreakout) {
    if (funding.rate < -params.fundingCrowdingAbsRate) return Object.freeze({ action: null, reason: "short_funding_crowded", atrFraction, fundingRate: funding.rate });
    return Object.freeze({ action: "SHORT", atr: signalAtr, atrFraction, fundingRate: funding.rate, breakoutLevel: priorLow, trendMa });
  }
  return Object.freeze({ action: null, reason: "no_breakout", atrFraction, fundingRate: funding.rate });
}

function fundingDuringTrade(fundingRows, entryTimestamp, exitTimestamp) {
  return fundingRows.filter((row) => row.timestamp > entryTimestamp && row.timestamp <= exitTimestamp).map((row) => row.rate);
}

function quantityForRisk(capital, entryPrice, stopPrice) {
  const stopDistance = Math.abs(entryPrice - stopPrice);
  if (!(stopDistance > 0)) return 0;
  const riskCash = capital * FUTURES_DONCHIAN_TREND_CANDIDATE.fixed.riskPerTrade;
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
    sharpeLike: deviation > 0 ? expectancyReturn / deviation * Math.sqrt(Math.max(1, returns.length)) : 0,
    totalExecutionCost: trades.reduce((sum, trade) => sum + (trade.costs?.total ?? 0), 0),
    fundingCost: trades.reduce((sum, trade) => sum + (trade.costs?.funding ?? 0), 0),
    directionCounts: Object.freeze({
      LONG: trades.filter((trade) => trade.action === "LONG").length,
      SHORT: trades.filter((trade) => trade.action === "SHORT").length,
    }),
    finalCapital: equity,
  });
}

export function simulateFuturesDonchianTrend(raw = {}) {
  const candles = validateCandles(raw.candles);
  const fundingRates = normalizeFunding(raw.fundingRates ?? []);
  const params = normalizeParams(raw.params);
  const initialCapital = positive(raw.initialCapital ?? DEFAULT_CAPITAL, "initialCapital");
  const costMultiplier = positive(raw.costMultiplier ?? 1, "costMultiplier");
  const costs = BITGET_STANDARD_TAKER_RESEARCH_COSTS.CRYPTO_FUTURES;
  const warmup = Math.max(params.breakoutLookback, params.trendMaPeriod, params.atrPeriod) + 1;
  const startIndex = Math.max(warmup, Number.isInteger(raw.startIndex) ? raw.startIndex : warmup);
  const endIndex = Math.min(candles.length - 1, Number.isInteger(raw.endIndex) ? raw.endIndex : candles.length - 1);
  const trades = [];
  const rejected = {};
  let signalIndex = startIndex;

  while (signalIndex < endIndex) {
    const signal = signalAt(candles, fundingRates, signalIndex, params);
    if (!signal.action) {
      rejected[signal.reason] = (rejected[signal.reason] ?? 0) + 1;
      signalIndex += 1;
      continue;
    }
    const entryIndex = signalIndex + 1;
    if (entryIndex > endIndex) break;
    const entry = candles[entryIndex];
    const initialStopDistance = signal.atr * params.stopAtrMultiple;
    let stop = signal.action === "LONG" ? entry.open - initialStopDistance : entry.open + initialStopDistance;
    if (!(stop > 0)) {
      signalIndex += 1;
      continue;
    }
    const quantity = quantityForRisk(initialCapital, entry.open, stop);
    if (!(quantity > 0)) {
      signalIndex += 1;
      continue;
    }

    let peak = entry.high;
    let trough = entry.low;
    const lastExitIndex = Math.min(endIndex, entryIndex + params.maxHoldBars - 1);
    let exitIndex = lastExitIndex;
    let exitPrice = candles[lastExitIndex].close;
    let exitReason = "time";

    for (let index = entryIndex; index <= lastExitIndex; index += 1) {
      const candle = candles[index];
      if (signal.action === "LONG") {
        if (candle.open <= stop) {
          exitIndex = index;
          exitPrice = candle.open;
          exitReason = "stop_gap";
          break;
        }
        if (candle.low <= stop) {
          exitIndex = index;
          exitPrice = stop;
          exitReason = "trailing_stop";
          break;
        }
      } else {
        if (candle.open >= stop) {
          exitIndex = index;
          exitPrice = candle.open;
          exitReason = "stop_gap";
          break;
        }
        if (candle.high >= stop) {
          exitIndex = index;
          exitPrice = stop;
          exitReason = "trailing_stop";
          break;
        }
      }

      peak = Math.max(peak, candle.high);
      trough = Math.min(trough, candle.low);
      const currentAtr = atr(candles, index, params.atrPeriod);
      if (currentAtr > 0) {
        if (signal.action === "LONG") stop = Math.max(stop, peak - currentAtr * params.trailingAtrMultiple);
        else stop = Math.min(stop, trough + currentAtr * params.trailingAtrMultiple);
      }
    }

    const observedFunding = fundingDuringTrade(fundingRates, entry.timestamp, candles[exitIndex].timestamp);
    const execution = calculateExecutionAwareTrade({
      market: "CRYPTO_FUTURES",
      action: signal.action,
      entryPrice: entry.open,
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
      symbol: raw.symbol,
      timeframe: "15m",
      action: signal.action,
      signalTimestamp: candles[signalIndex].timestamp,
      entryTimestamp: entry.timestamp,
      exitTimestamp: candles[exitIndex].timestamp,
      exitReason,
      initialStopDistance,
      finalStop: stop,
      breakoutLevel: signal.breakoutLevel,
      trendMa: signal.trendMa,
      signalAtr: signal.atr,
      signalAtrFraction: signal.atrFraction,
      signalFundingRate: signal.fundingRate,
      candidateManifestSha256: FUTURES_DONCHIAN_TREND_CANDIDATE_SHA256,
    }));
    signalIndex = exitIndex + 1;
  }

  return Object.freeze({
    candidateId: FUTURES_DONCHIAN_TREND_CANDIDATE.id,
    candidateManifestSha256: FUTURES_DONCHIAN_TREND_CANDIDATE_SHA256,
    params,
    costMultiplier,
    segment: Object.freeze({ startIndex, endIndex, startTimestamp: candles[startIndex]?.timestamp ?? null, endTimestamp: candles[endIndex]?.timestamp ?? null }),
    trades: Object.freeze(trades),
    rejected: Object.freeze(rejected),
    metrics: summarizeTrades(trades, initialCapital),
    safeguards: FUTURES_DONCHIAN_TREND_CANDIDATE.safeguards,
  });
}

export function expandFuturesDonchianGrid() {
  const search = FUTURES_DONCHIAN_TREND_CANDIDATE.search;
  const result = [];
  for (const breakoutLookback of search.breakoutLookback)
    for (const trendMaPeriod of search.trendMaPeriod)
      for (const stopAtrMultiple of search.stopAtrMultiple)
        for (const maxHoldBars of search.maxHoldBars)
          for (const maxAtrFraction of search.maxAtrFraction)
            for (const fundingCrowdingAbsRate of search.fundingCrowdingAbsRate) result.push(Object.freeze({
              breakoutLookback,
              trendMaPeriod,
              stopAtrMultiple,
              maxHoldBars,
              maxAtrFraction,
              fundingCrowdingAbsRate,
            }));
  return Object.freeze(result);
}

export function buildFuturesDonchianSegments(candleCount) {
  if (!Number.isInteger(candleCount) || candleCount < 1000) throw new TypeError("futures Donchian candleCount must be at least 1000");
  const trainEnd = Math.floor(candleCount * 0.6) - 1;
  const validationEnd = Math.floor(candleCount * 0.8) - 1;
  return Object.freeze({
    train: Object.freeze({ startIndex: 0, endIndex: trainEnd }),
    validation: Object.freeze({ startIndex: trainEnd + 1, endIndex: validationEnd }),
    test: Object.freeze({ startIndex: validationEnd + 1, endIndex: candleCount - 1 }),
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
    rejected: Object.freeze(items.reduce((output, item) => {
      output[item.symbol] = item.simulation.rejected;
      return output;
    }, {})),
  });
}

function evaluateDatasets(datasets, params, segmentName, costMultiplier = 1) {
  const items = datasets.map((dataset) => {
    const segment = buildFuturesDonchianSegments(dataset.candles.length)[segmentName];
    return Object.freeze({
      symbol: dataset.symbol,
      simulation: simulateFuturesDonchianTrend({
        symbol: dataset.symbol,
        candles: dataset.candles,
        fundingRates: dataset.fundingRates,
        params,
        costMultiplier,
        ...segment,
      }),
    });
  });
  return aggregate(items);
}

function passGate(summary, minimumTrades) {
  return summary.metrics.tradeCount >= minimumTrades
    && summary.metrics.expectancyReturn > 0
    && summary.metrics.profitFactor >= 1.1
    && summary.metrics.maximumDrawdown <= 0.12
    && summary.positiveSymbols === summary.symbolCount;
}

function compare(left, right) {
  const leftPass = passGate(left.summary, 12);
  const rightPass = passGate(right.summary, 12);
  if (leftPass !== rightPass) return leftPass ? -1 : 1;
  if (left.summary.metrics.profitFactor !== right.summary.metrics.profitFactor) return right.summary.metrics.profitFactor - left.summary.metrics.profitFactor;
  if (left.summary.metrics.expectancyReturn !== right.summary.metrics.expectancyReturn) return right.summary.metrics.expectancyReturn - left.summary.metrics.expectancyReturn;
  if (left.summary.metrics.totalReturn !== right.summary.metrics.totalReturn) return right.summary.metrics.totalReturn - left.summary.metrics.totalReturn;
  if (left.summary.metrics.maximumDrawdown !== right.summary.metrics.maximumDrawdown) return left.summary.metrics.maximumDrawdown - right.summary.metrics.maximumDrawdown;
  return JSON.stringify(left.params).localeCompare(JSON.stringify(right.params));
}

function rollingAudit(datasets, params, count = 4) {
  const windows = [];
  for (let windowIndex = 0; windowIndex < count; windowIndex += 1) {
    const items = datasets.map((dataset) => {
      const total = dataset.candles.length;
      const warmup = Math.max(params.breakoutLookback, params.trendMaPeriod, FUTURES_DONCHIAN_TREND_CANDIDATE.fixed.atrPeriod) + 1;
      const tailStart = Math.max(warmup, Math.floor(total * 0.5));
      const tailSpan = total - tailStart;
      const windowSize = Math.max(200, Math.floor(tailSpan / count));
      const startIndex = tailStart + windowIndex * windowSize;
      const endIndex = windowIndex === count - 1 ? total - 1 : Math.min(total - 1, startIndex + windowSize - 1);
      return Object.freeze({
        symbol: dataset.symbol,
        simulation: simulateFuturesDonchianTrend({ symbol: dataset.symbol, candles: dataset.candles, fundingRates: dataset.fundingRates, params, startIndex, endIndex }),
      });
    });
    const summary = aggregate(items);
    const passed = summary.metrics.tradeCount >= 6
      && summary.metrics.expectancyReturn > 0
      && summary.metrics.profitFactor > 1
      && summary.metrics.maximumDrawdown <= 0.12;
    windows.push(Object.freeze({ index: windowIndex, summary, passed }));
  }
  return Object.freeze({ windows: Object.freeze(windows), positiveWindows: windows.filter((row) => row.passed).length, windowCount: windows.length, parametersRetunedPerWindow: false });
}

export function optimizeFuturesDonchianTrend(raw = {}) {
  const designDatasets = Array.isArray(raw.designDatasets) ? raw.designDatasets : [];
  const holdoutDatasets = Array.isArray(raw.holdoutDatasets) ? raw.holdoutDatasets : [];
  if (designDatasets.length !== 2 || holdoutDatasets.length !== 2) throw new TypeError("exactly two design and two holdout datasets are required");
  const designSymbols = designDatasets.map((row) => String(row.symbol));
  const holdoutSymbols = holdoutDatasets.map((row) => String(row.symbol));
  if (JSON.stringify(designSymbols) !== JSON.stringify(FUTURES_DONCHIAN_TREND_CANDIDATE.designSymbols)) throw new TypeError("design symbols must match preregistered LTC/BCH order");
  if (JSON.stringify(holdoutSymbols) !== JSON.stringify(FUTURES_DONCHIAN_TREND_CANDIDATE.holdoutSymbols)) throw new TypeError("holdout symbols must match preregistered LINK/DOT order");
  const prior = new Set(FUTURES_DONCHIAN_TREND_CANDIDATE.priorResearchSymbols);
  if ([...designSymbols, ...holdoutSymbols].some((symbol) => prior.has(symbol))) throw new TypeError("prior futures research symbols cannot be reused");
  const stressMultiplier = Number(raw.stressMultiplier ?? 1.5);
  if (!Number.isFinite(stressMultiplier) || stressMultiplier < 1 || stressMultiplier > 3) throw new TypeError("invalid stressMultiplier");
  const grid = expandFuturesDonchianGrid();

  const trained = grid.map((params) => ({ params, summary: evaluateDatasets(designDatasets, params, "train") })).sort(compare);
  const finalists = trained.slice(0, Math.min(20, trained.length)).map((candidate) => ({
    params: candidate.params,
    train: candidate.summary,
    summary: evaluateDatasets(designDatasets, candidate.params, "validation"),
  })).sort(compare);
  const selected = finalists.find((candidate) => passGate(candidate.summary, 12)) ?? finalists[0];
  if (!selected) throw new TypeError("futures Donchian optimizer could not select a candidate");

  const designTest = evaluateDatasets(designDatasets, selected.params, "test");
  const stressedDesignTest = evaluateDatasets(designDatasets, selected.params, "test", stressMultiplier);
  const holdoutTest = evaluateDatasets(holdoutDatasets, selected.params, "test");
  const stressedHoldout = evaluateDatasets(holdoutDatasets, selected.params, "test", stressMultiplier);
  const rolling = rollingAudit(holdoutDatasets, selected.params, 4);
  const validationPassed = passGate(selected.summary, 12);
  const designTestPassed = passGate(designTest, 12);
  const stressPassed = passGate(stressedDesignTest, 12);
  const holdoutPassed = passGate(holdoutTest, 12);
  const holdoutStressPassed = passGate(stressedHoldout, 12);
  const rollingPassed = rolling.positiveWindows >= 3;
  const status = validationPassed && designTestPassed && stressPassed && holdoutPassed && holdoutStressPassed && rollingPassed
    ? "cross_asset_trend_candidate"
    : "research_hold";

  return Object.freeze({
    schemaVersion: 1,
    market: "CRYPTO_FUTURES",
    timeframe: "15m",
    strategy: "two_sided_donchian_atr_trend",
    status,
    candidateId: FUTURES_DONCHIAN_TREND_CANDIDATE.id,
    candidateManifestSha256: FUTURES_DONCHIAN_TREND_CANDIDATE_SHA256,
    params: selected.params,
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
      scalarWeightedScoreUsed: false,
      modelUsed: false,
      priorResearchSymbolsUsedForSelection: false,
      designTestUsedForSelection: false,
      holdoutUsedForSelection: false,
      holdoutStressUsedForSelection: false,
      rollingUsedForSelection: false,
    }),
    designSymbols: Object.freeze(designSymbols),
    holdoutSymbols: Object.freeze(holdoutSymbols),
    safeguards: FUTURES_DONCHIAN_TREND_CANDIDATE.safeguards,
    limitations: Object.freeze([
      "historical open interest is not backfilled",
      "funding must be fresh at signal time and missing funding fails closed",
      "public OHLC cannot reconstruct intrabar path, so pre-bar trailing stops are used conservatively",
      "historical cross-asset evidence is not prospective Shadow evidence",
    ]),
  });
}

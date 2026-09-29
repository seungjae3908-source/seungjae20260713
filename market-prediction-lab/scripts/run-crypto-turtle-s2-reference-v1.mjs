import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  collectVisionFuturesDailyKlines,
  collectVisionFuturesFunding,
} from "../src/binance-vision-futures-archive.js";
import { calculateExecutionAwareTrade } from "../src/research-validation-layer.js";
import { BITGET_STANDARD_TAKER_RESEARCH_COSTS } from "../src/historical-backtest-data.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse("2020-01-01T00:00:00.000Z");
const END = Date.parse("2025-12-31T23:59:59.999Z");
const SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT"]);
const INITIAL_CAPITAL = 1_000_000;
const SYSTEM = Object.freeze({
  id: "TURTLE_SYSTEM_2_V1",
  entryLookback: 55,
  exitLookback: 20,
  nPeriod: 20,
  unitEquityFractionPerN: 0.01,
  initialStopN: 2,
  pyramidStepN: 0.5,
  maxUnits: 4,
});
const WINDOWS = Object.freeze([
  Object.freeze({ id: "PRIOR_2021_2023", start: Date.parse("2021-01-01T00:00:00Z"), end: Date.parse("2023-12-31T23:59:59Z") }),
  Object.freeze({ id: "RECENT_2024_2025", start: Date.parse("2024-01-01T00:00:00Z"), end: Date.parse("2025-12-31T23:59:59Z") }),
]);
const SOURCE_RULES = "https://www.turtletrader.com/rules/";

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function median(values) {
  if (!values.length) return null;
  const xs = [...values].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
function std(values) {
  if (values.length < 2) return null;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}
function maxDrawdownFromPnls(trades, initialCapital) {
  let equity = initialCapital;
  let peak = initialCapital;
  let mdd = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    mdd = Math.max(mdd, peak > 0 ? (peak - equity) / peak : 0);
  }
  return mdd;
}
function summarize(trades, initialCapital = INITIAL_CAPITAL) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = -losses.reduce((sum, trade) => sum + trade.netPnl, 0);
  const returns = trades.map((trade) => trade.netPnl / Math.max(1, trade.equityBefore));
  const totalNetPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const deviation = std(returns);
  return {
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : null,
    meanTradeReturnOnEquity: mean(returns),
    medianTradeReturnOnEquity: median(returns),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    totalNetPnl,
    additiveReturnOnInitialCapital: totalNetPnl / initialCapital,
    maxDrawdown: maxDrawdownFromPnls(trades, initialCapital),
    sharpeLike: deviation && deviation > 0 ? mean(returns) / deviation * Math.sqrt(trades.length) : null,
    longTrades: trades.filter((trade) => trade.action === "LONG").length,
    shortTrades: trades.filter((trade) => trade.action === "SHORT").length,
    fourUnitTrades: trades.filter((trade) => trade.unitCount === 4).length,
    averageUnits: trades.length ? mean(trades.map((trade) => trade.unitCount)) : null,
  };
}
function trueRange(candle, previousClose) {
  return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
}
function buildN(candles) {
  const values = new Array(candles.length).fill(null);
  const tr = new Array(candles.length).fill(null);
  for (let index = 1; index < candles.length; index += 1) {
    tr[index] = trueRange(candles[index], candles[index - 1].close);
  }
  if (candles.length <= SYSTEM.nPeriod) return values;
  let initial = 0;
  for (let index = 1; index <= SYSTEM.nPeriod; index += 1) initial += tr[index];
  values[SYSTEM.nPeriod] = initial / SYSTEM.nPeriod;
  for (let index = SYSTEM.nPeriod + 1; index < candles.length; index += 1) {
    values[index] = ((SYSTEM.nPeriod - 1) * values[index - 1] + tr[index]) / SYSTEM.nPeriod;
  }
  return values;
}
function highestBefore(candles, index, period) {
  if (index - period < 0) return null;
  let value = -Infinity;
  for (let cursor = index - period; cursor < index; cursor += 1) value = Math.max(value, candles[cursor].high);
  return Number.isFinite(value) ? value : null;
}
function lowestBefore(candles, index, period) {
  if (index - period < 0) return null;
  let value = Infinity;
  for (let cursor = index - period; cursor < index; cursor += 1) value = Math.min(value, candles[cursor].low);
  return Number.isFinite(value) ? value : null;
}
function fundingDuring(records, startExclusive, endInclusive) {
  return records.filter((row) => row.timestamp > startExclusive && row.timestamp <= endInclusive).map((row) => row.rate);
}
function requestedFill(candle, level, action) {
  if (action === "LONG") return candle.open >= level ? candle.open : level;
  return candle.open <= level ? candle.open : level;
}
function exitFill(candle, level, action) {
  if (action === "LONG") return candle.open <= level ? candle.open : level;
  return candle.open >= level ? candle.open : level;
}
function unitQuantity(equity, n) {
  return (SYSTEM.unitEquityFractionPerN * equity) / n;
}
function executeUnit({ action, unit, exitPrice, exitTimestamp, fundingRates, costMultiplier }) {
  const costs = BITGET_STANDARD_TAKER_RESEARCH_COSTS.CRYPTO_FUTURES;
  return calculateExecutionAwareTrade({
    market: "CRYPTO_FUTURES",
    action,
    entryPrice: unit.entryPrice,
    exitPrice,
    quantity: unit.quantity,
    leverage: 1,
    entryFeeRate: costs.entryFeeRate * costMultiplier,
    exitFeeRate: costs.exitFeeRate * costMultiplier,
    taxRate: 0,
    slippageRate: costs.slippageRate * costMultiplier,
    spreadRate: costs.spreadRate * costMultiplier,
    latencyBars: costs.latencyBars,
    latencyDriftRate: costs.latencyDriftRate,
    fundingRates,
  });
}
function simulateSystem2({ symbol, candles, fundingRates, costMultiplier = 1, maxUnits = SYSTEM.maxUnits }) {
  const nSeries = buildN(candles);
  const warmup = Math.max(SYSTEM.entryLookback, SYSTEM.nPeriod) + 1;
  let equity = INITIAL_CAPITAL;
  let position = null;
  const trades = [];
  const diagnostics = {
    ambiguousTwoSidedBreakoutBars: 0,
    sameBarEntryStopExits: 0,
    sameBarPyramidStopExits: 0,
    gapEntries: 0,
    gapStopsOrExits: 0,
  };

  const closePosition = (index, exitPrice, exitReason) => {
    const candle = candles[index];
    const equityBefore = equity;
    const unitExecutions = position.units.map((unit) => executeUnit({
      action: position.action,
      unit,
      exitPrice,
      exitTimestamp: candle.timestamp,
      fundingRates: fundingDuring(fundingRates, unit.entryTimestamp, candle.timestamp),
      costMultiplier,
    }));
    const netPnl = unitExecutions.reduce((sum, execution) => sum + execution.netPnl, 0);
    equity += netPnl;
    const trade = {
      symbol,
      action: position.action,
      entryTimestamp: position.units[0].entryTimestamp,
      exitTimestamp: candle.timestamp,
      entryDate: new Date(position.units[0].entryTimestamp).toISOString().slice(0, 10),
      exitDate: new Date(candle.timestamp).toISOString().slice(0, 10),
      entryN: position.n,
      unitCount: position.units.length,
      unitEntries: position.units.map((unit) => unit.entryPrice),
      quantities: position.units.map((unit) => unit.quantity),
      exitPrice,
      exitReason,
      equityBefore,
      equityAfter: equity,
      netPnl,
      executionCost: unitExecutions.reduce((sum, execution) => sum + (execution.costs?.total ?? 0), 0),
      fundingCost: unitExecutions.reduce((sum, execution) => sum + (execution.costs?.funding ?? 0), 0),
      costMultiplier,
    };
    trades.push(trade);
    position = null;
  };

  for (let index = warmup; index < candles.length; index += 1) {
    const candle = candles[index];
    const n = nSeries[index - 1] ?? nSeries[index];
    if (!(n > 0)) continue;

    if (position) {
      const channel = position.action === "LONG"
        ? lowestBefore(candles, index, SYSTEM.exitLookback)
        : highestBefore(candles, index, SYSTEM.exitLookback);
      const stopTouched = position.action === "LONG" ? candle.low <= position.stop : candle.high >= position.stop;
      const exitTouched = channel != null && (position.action === "LONG" ? candle.low <= channel : candle.high >= channel);
      if (stopTouched || exitTouched) {
        const stopPrice = stopTouched ? exitFill(candle, position.stop, position.action) : null;
        const channelPrice = exitTouched ? exitFill(candle, channel, position.action) : null;
        let exitPrice;
        let exitReason;
        if (stopPrice != null && channelPrice != null) {
          exitPrice = position.action === "LONG" ? Math.min(stopPrice, channelPrice) : Math.max(stopPrice, channelPrice);
          exitReason = "STOP_OR_20D_EXIT_CONSERVATIVE";
        } else if (stopPrice != null) {
          exitPrice = stopPrice;
          exitReason = "2N_STOP";
        } else {
          exitPrice = channelPrice;
          exitReason = "20D_OPPOSITE_BREAKOUT";
        }
        if (exitPrice === candle.open) diagnostics.gapStopsOrExits += 1;
        closePosition(index, exitPrice, exitReason);
        continue;
      }

      while (position && position.units.length < maxUnits) {
        const lastFill = position.units.at(-1).entryPrice;
        const addLevel = position.action === "LONG"
          ? lastFill + SYSTEM.pyramidStepN * position.n
          : lastFill - SYSTEM.pyramidStepN * position.n;
        const touched = position.action === "LONG" ? candle.high >= addLevel : candle.low <= addLevel;
        if (!touched) break;
        const fill = requestedFill(candle, addLevel, position.action);
        const quantity = unitQuantity(equity, position.n);
        position.units.push({ entryPrice: fill, entryTimestamp: candle.timestamp, quantity });
        position.stop = position.action === "LONG"
          ? fill - SYSTEM.initialStopN * position.n
          : fill + SYSTEM.initialStopN * position.n;
        const newStopTouched = position.action === "LONG" ? candle.low <= position.stop : candle.high >= position.stop;
        if (newStopTouched) {
          diagnostics.sameBarPyramidStopExits += 1;
          closePosition(index, position.stop, "PYRAMID_NEW_STOP_SAME_BAR_CONSERVATIVE");
          break;
        }
      }
      continue;
    }

    const priorHigh = highestBefore(candles, index, SYSTEM.entryLookback);
    const priorLow = lowestBefore(candles, index, SYSTEM.entryLookback);
    if (!(priorHigh > 0 && priorLow > 0)) continue;
    const longBreakout = candle.high > priorHigh;
    const shortBreakout = candle.low < priorLow;
    if (longBreakout && shortBreakout) {
      diagnostics.ambiguousTwoSidedBreakoutBars += 1;
      continue;
    }
    if (!longBreakout && !shortBreakout) continue;
    const action = longBreakout ? "LONG" : "SHORT";
    const level = longBreakout ? priorHigh : priorLow;
    const fill = requestedFill(candle, level, action);
    if (fill === candle.open) diagnostics.gapEntries += 1;
    const quantity = unitQuantity(equity, n);
    if (!(quantity > 0)) continue;
    const stop = action === "LONG" ? fill - SYSTEM.initialStopN * n : fill + SYSTEM.initialStopN * n;
    if (!(stop > 0)) continue;
    position = {
      action,
      n,
      stop,
      units: [{ entryPrice: fill, entryTimestamp: candle.timestamp, quantity }],
    };
    const sameBarStop = action === "LONG" ? candle.low <= stop : candle.high >= stop;
    if (sameBarStop) {
      diagnostics.sameBarEntryStopExits += 1;
      closePosition(index, stop, "ENTRY_AND_2N_STOP_SAME_BAR_CONSERVATIVE");
      continue;
    }
    while (position && position.units.length < maxUnits) {
      const lastFill = position.units.at(-1).entryPrice;
      const addLevel = action === "LONG"
        ? lastFill + SYSTEM.pyramidStepN * n
        : lastFill - SYSTEM.pyramidStepN * n;
      const touched = action === "LONG" ? candle.high >= addLevel : candle.low <= addLevel;
      if (!touched) break;
      const addFill = requestedFill(candle, addLevel, action);
      position.units.push({ entryPrice: addFill, entryTimestamp: candle.timestamp, quantity: unitQuantity(equity, n) });
      position.stop = action === "LONG"
        ? addFill - SYSTEM.initialStopN * n
        : addFill + SYSTEM.initialStopN * n;
      const newStopTouched = action === "LONG" ? candle.low <= position.stop : candle.high >= position.stop;
      if (newStopTouched) {
        diagnostics.sameBarPyramidStopExits += 1;
        closePosition(index, position.stop, "PYRAMID_NEW_STOP_SAME_BAR_CONSERVATIVE");
        break;
      }
    }
  }

  if (position) {
    closePosition(candles.length - 1, candles.at(-1).close, "DATASET_END");
  }
  return {
    symbol,
    maxUnits,
    costMultiplier,
    initialCapital: INITIAL_CAPITAL,
    finalCapital: equity,
    metrics: summarize(trades),
    trades,
    diagnostics,
  };
}
function windowSummary(trades) {
  return Object.fromEntries(WINDOWS.map((window) => {
    const rows = trades.filter((trade) => trade.entryTimestamp >= window.start && trade.entryTimestamp <= window.end);
    return [window.id, summarize(rows)];
  }));
}
function aggregateRuns(runs) {
  const totalInitial = runs.length * INITIAL_CAPITAL;
  const allTrades = runs.flatMap((run) => run.trades);
  return {
    symbolCount: runs.length,
    initialCapital: totalInitial,
    finalCapital: runs.reduce((sum, run) => sum + run.finalCapital, 0),
    totalReturn: runs.reduce((sum, run) => sum + (run.finalCapital - INITIAL_CAPITAL), 0) / totalInitial,
    tradeMetrics: summarize(allTrades, totalInitial),
    perSymbol: Object.fromEntries(runs.map((run) => [run.symbol, {
      finalCapital: run.finalCapital,
      metrics: run.metrics,
      diagnostics: run.diagnostics,
    }])),
    windows: Object.fromEntries(WINDOWS.map((window) => {
      const rows = runs.flatMap((run) => run.trades.filter((trade) => trade.entryTimestamp >= window.start && trade.entryTimestamp <= window.end));
      return [window.id, summarize(rows, totalInitial)];
    })),
  };
}
function selfTest() {
  const candles = [];
  let price = 100;
  for (let index = 0; index < 100; index += 1) {
    const prior = price;
    price *= 1.002;
    candles.push({
      timestamp: Date.UTC(2020, 0, 1) + index * DAY_MS,
      open: prior,
      high: price * 1.005,
      low: prior * 0.995,
      close: price,
    });
  }
  const n = buildN(candles);
  if (!(n[20] > 0 && n[99] > 0)) throw new Error("SELFTEST_N");
  if (Math.abs(unitQuantity(1_000_000, 1000) - 10) > 1e-12) throw new Error("SELFTEST_UNIT");
  if (highestBefore(candles, 60, 55) == null || lowestBefore(candles, 60, 20) == null) throw new Error("SELFTEST_CHANNEL");
  console.log("CRYPTO_TURTLE_S2_REFERENCE_V1_SELF_TEST_OK");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const datasets = {};
for (const symbol of SYMBOLS) {
  const [price, funding] = await Promise.all([
    collectVisionFuturesDailyKlines({ symbol, startTime: START, endTime: END, concurrency: 8 }),
    collectVisionFuturesFunding({ symbol, startTime: START, endTime: END, concurrency: 8 }),
  ]);
  if (!price.checksumVerified || !funding.checksumVerified) throw new Error(`${symbol}_CHECKSUM_UNVERIFIED`);
  if (price.candles.length < 2_000) throw new Error(`${symbol}_PRICE_COVERAGE_${price.candles.length}`);
  if (funding.records.length < 1_000) throw new Error(`${symbol}_FUNDING_COVERAGE_${funding.records.length}`);
  datasets[symbol] = { candles: price.candles, fundingRates: funding.records };
}

const sourceNormal = SYMBOLS.map((symbol) => simulateSystem2({ symbol, ...datasets[symbol], maxUnits: 4, costMultiplier: 1 }));
const sourceStress = SYMBOLS.map((symbol) => simulateSystem2({ symbol, ...datasets[symbol], maxUnits: 4, costMultiplier: 1.5 }));
const singleUnitNormal = SYMBOLS.map((symbol) => simulateSystem2({ symbol, ...datasets[symbol], maxUnits: 1, costMultiplier: 1 }));
const sourceAggregate = aggregateRuns(sourceNormal);
const stressAggregate = aggregateRuns(sourceStress);
const singleUnitAggregate = aggregateRuns(singleUnitNormal);

const report = {
  schemaVersion: 1,
  status: "pass",
  market: "CRYPTO_FUTURES",
  sourceContract: {
    recipeId: SYSTEM.id,
    source: SOURCE_RULES,
    entry: "55-day high LONG / 55-day low SHORT; every breakout taken",
    n: "20-day exponential average of True Range; first N is 20-day simple average",
    unitSizing: "1 N of price movement represents 1% of current account equity",
    initialStop: "2 N from most recently added unit",
    pyramiding: "add one unit every 0.5 N from actual previous fill, max 4 units",
    exit: "20-day opposite breakout",
    takeProfit: null,
    parameterSearch: false,
  },
  data: {
    provider: "Binance Vision USD-M monthly public archive",
    symbols: SYMBOLS,
    startInclusive: new Date(START).toISOString(),
    endInclusive: new Date(END).toISOString(),
    fundingIncluded: true,
    checksumVerified: true,
    reserved2026ForLaterIndependentCheck: true,
  },
  execution: {
    targetCostAssumption: "Bitget standard taker research costs",
    crossVenueProxy: true,
    normalCostMultiplier: 1,
    stressCostMultiplier: 1.5,
    dailyOhlcIntrabarPathKnown: false,
    sameBarEntryStopPolicy: "conservative stop",
    sameBarNewPyramidStopPolicy: "conservative stop",
    simultaneousLongShortBreakoutPolicy: "skip ambiguous daily bar",
  },
  results: {
    sourceNormal: sourceAggregate,
    sourceStress: stressAggregate,
    singleUnitControl: singleUnitAggregate,
    pyramidContribution: {
      totalReturnDelta: sourceAggregate.totalReturn - singleUnitAggregate.totalReturn,
      tradeReturnDelta: sourceAggregate.tradeMetrics.additiveReturnOnInitialCapital - singleUnitAggregate.tradeMetrics.additiveReturnOnInitialCapital,
    },
  },
  transferBoundary: {
    canonicalOriginalTurtlePortfolioReplication: false,
    reason: "two crypto perpetual markets, no original diversified commodity portfolio heat/correlation limits, daily OHLC cannot recover exact intraday event order",
    sourceSystem2RulesPreserved: true,
    system1SkipRuleNotImplementedInThisBaseline: true,
    exactContractTickSizeAndExchangeMarginNotModeled: true,
  },
  decisionBoundary: {
    observedHistoryUsedForParameterSelection: false,
    automaticPromotionAllowed: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    nextRequiredEvidence: "read frozen System-2 result versus single-unit control and temporal windows before deciding whether any independent 2026 check is justified",
  },
  safety: {
    researchOnly: true,
    publicDataOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    orderRouteCalled: false,
    executionAuthority: "NONE",
    actualOrders: 0,
  },
  limitations: [
    "The original Turtle program traded a diversified futures portfolio with portfolio-level unit/correlation limits; this is a two-market crypto-perpetual application.",
    "Daily OHLC cannot determine intraday ordering when breakout, pyramid add and stop levels are all touched; ambiguous cases are handled conservatively.",
    "Funding is included for perpetual futures even though the original dated-futures rules had no perpetual funding.",
    "Binance historical market data is combined with Bitget-oriented cost assumptions and is therefore a cross-venue proxy.",
    "System 1 is deliberately excluded until its previous-breakout winner skip rule is implemented without approximation.",
  ],
};

const output = resolve(process.argv[2] ?? "docs/crypto-turtle-s2-reference-v1.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  status: report.status,
  sourceReturn: report.results.sourceNormal.totalReturn,
  stressReturn: report.results.sourceStress.totalReturn,
  singleUnitReturn: report.results.singleUnitControl.totalReturn,
  sourceTrades: report.results.sourceNormal.tradeMetrics.trades,
  sourcePF: report.results.sourceNormal.tradeMetrics.profitFactor,
  sourceMDD: report.results.sourceNormal.tradeMetrics.maxDrawdown,
  priorReturn: report.results.sourceNormal.windows.PRIOR_2021_2023.additiveReturnOnInitialCapital,
  recentReturn: report.results.sourceNormal.windows.RECENT_2024_2025.additiveReturnOnInitialCapital,
}));

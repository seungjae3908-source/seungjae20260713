import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  collectVisionFuturesDailyKlines,
  collectVisionFuturesFunding,
} from "../src/binance-vision-futures-archive.js";
import { calculateExecutionAwareTrade } from "../src/research-validation-layer.js";
import { BITGET_STANDARD_TAKER_RESEARCH_COSTS } from "../src/historical-backtest-data.js";

const DAY = 86_400_000;
const DATA_START = Date.parse("2020-01-01T00:00:00.000Z");
const DATA_END = Date.parse("2026-08-31T23:59:59.999Z");
const INITIAL_CAPITAL = 1_000_000;
const SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT"]);
const SOURCE_URL = "https://www.turtletrader.com/rules/";
const SOURCE_RULES_URL = "https://www.brookstradingcourse.com/wp-content/uploads/wpforo/attachments/12514/3508-CurtisFaith-WayoftheTurtle-1.pdf";
const SYSTEM = Object.freeze({
  id: "TURTLE_SYSTEM2_55_20_V1",
  entryLookback: 55,
  exitLookback: 20,
  nPeriod: 20,
  initialStopN: 2,
  addEveryN: 0.5,
  maxUnits: 4,
  unitRiskNEquityFraction: 0.01,
});
const SEGMENTS = Object.freeze({
  FULL: Object.freeze({ start: Date.parse("2020-03-01T00:00:00.000Z"), end: DATA_END }),
  PRIOR: Object.freeze({ start: Date.parse("2020-03-01T00:00:00.000Z"), end: Date.parse("2022-12-31T23:59:59.999Z") }),
  MID: Object.freeze({ start: Date.parse("2023-01-01T00:00:00.000Z"), end: Date.parse("2024-12-31T23:59:59.999Z") }),
  RECENT: Object.freeze({ start: Date.parse("2025-01-01T00:00:00.000Z"), end: DATA_END }),
});
const COST = BITGET_STANDARD_TAKER_RESEARCH_COSTS.CRYPTO_FUTURES;

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function trueRange(candle, previousClose) {
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose),
  );
}
function buildN(candles) {
  const tr = new Array(candles.length).fill(null);
  const n = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i += 1) tr[i] = trueRange(candles[i], candles[i - 1].close);
  if (candles.length <= SYSTEM.nPeriod) return n;
  const first = tr.slice(1, SYSTEM.nPeriod + 1);
  if (first.some((value) => !Number.isFinite(value))) return n;
  n[SYSTEM.nPeriod] = first.reduce((sum, value) => sum + value, 0) / SYSTEM.nPeriod;
  for (let i = SYSTEM.nPeriod + 1; i < candles.length; i += 1) {
    n[i] = ((SYSTEM.nPeriod - 1) * n[i - 1] + tr[i]) / SYSTEM.nPeriod;
  }
  return n;
}
function highestBefore(candles, index, lookback) {
  const start = index - lookback;
  if (start < 0) return null;
  let value = -Infinity;
  for (let i = start; i < index; i += 1) value = Math.max(value, candles[i].high);
  return Number.isFinite(value) ? value : null;
}
function lowestBefore(candles, index, lookback) {
  const start = index - lookback;
  if (start < 0) return null;
  let value = Infinity;
  for (let i = start; i < index; i += 1) value = Math.min(value, candles[i].low);
  return Number.isFinite(value) ? value : null;
}
function assertDailyContinuity(candles, symbol) {
  if (!Array.isArray(candles) || candles.length < 500) throw new Error(`${symbol}_INSUFFICIENT_CANDLES_${candles?.length ?? 0}`);
  for (let i = 1; i < candles.length; i += 1) {
    const delta = candles[i].timestamp - candles[i - 1].timestamp;
    if (delta !== DAY) throw new Error(`${symbol}_DAILY_GAP_${candles[i - 1].timestamp}_${delta}`);
  }
}
function fundingBetween(records, start, end) {
  return records.filter((row) => row.timestamp > start && row.timestamp <= end).map((row) => row.rate);
}
function executionForUnit(unit, exitPrice, exitTimestamp, action, fundingRates, costMultiplier) {
  return calculateExecutionAwareTrade({
    market: "CRYPTO_FUTURES",
    action,
    entryPrice: unit.entryPrice,
    exitPrice,
    quantity: unit.quantity,
    leverage: 1,
    entryFeeRate: COST.entryFeeRate * costMultiplier,
    exitFeeRate: COST.exitFeeRate * costMultiplier,
    taxRate: 0,
    slippageRate: COST.slippageRate * costMultiplier,
    spreadRate: COST.spreadRate * costMultiplier,
    latencyBars: COST.latencyBars,
    latencyDriftRate: COST.latencyDriftRate,
    fundingRates: fundingBetween(fundingRates, unit.entryTimestamp, exitTimestamp),
  });
}
function summarize(trades, initialCapital) {
  const wins = trades.filter((row) => row.netPnl > 0);
  const losses = trades.filter((row) => row.netPnl < 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + row.netPnl, 0));
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 1);
  }
  return {
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : null,
    netPnl: trades.reduce((sum, row) => sum + row.netPnl, 0),
    totalReturn: equity / initialCapital - 1,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    maxDrawdown,
    meanNetPnl: trades.length ? mean(trades.map((row) => row.netPnl)) : null,
    meanUnits: trades.length ? mean(trades.map((row) => row.units)) : null,
    maxUnits: trades.length ? Math.max(...trades.map((row) => row.units)) : 0,
    maxGrossLeverage: trades.length ? Math.max(...trades.map((row) => row.maxGrossLeverage)) : null,
    longTrades: trades.filter((row) => row.action === "LONG").length,
    shortTrades: trades.filter((row) => row.action === "SHORT").length,
    stopExits: trades.filter((row) => row.exitReason === "2N_STOP").length,
    channelExits: trades.filter((row) => row.exitReason === "20D_CHANNEL_EXIT").length,
    horizonExits: trades.filter((row) => row.exitReason === "SEGMENT_END").length,
    totalExecutionCost: trades.reduce((sum, row) => sum + row.costs.total, 0),
    fundingCost: trades.reduce((sum, row) => sum + row.costs.funding, 0),
    grossBeforeExecutionCosts: trades.reduce((sum, row) => sum + row.netPnl + row.costs.total, 0),
    grossBeforeExecutionCostsReturn: initialCapital > 0
      ? trades.reduce((sum, row) => sum + row.netPnl + row.costs.total, 0) / initialCapital
      : null,
    finalCapital: equity,
  };
}
function closePosition({
  position,
  exitPrice,
  exitTimestamp,
  exitReason,
  fundingRates,
  costMultiplier,
  equityAtEntry,
}) {
  const executions = position.units.map((unit) => executionForUnit(
    unit,
    exitPrice,
    exitTimestamp,
    position.action,
    fundingRates,
    costMultiplier,
  ));
  const costs = executions.reduce((acc, row) => {
    acc.entryFee += row.costs.entryFee;
    acc.exitFee += row.costs.exitFee;
    acc.funding += row.costs.funding;
    acc.slippage += row.costs.slippage;
    acc.spread += row.costs.spread;
    acc.latency += row.costs.latency;
    acc.total += row.costs.total;
    return acc;
  }, { entryFee: 0, exitFee: 0, funding: 0, slippage: 0, spread: 0, latency: 0, total: 0 });
  const netPnl = executions.reduce((sum, row) => sum + row.netPnl, 0);
  return {
    action: position.action,
    entryTimestamp: position.units[0].entryTimestamp,
    exitTimestamp,
    exitReason,
    nAtEntry: position.n,
    units: position.units.length,
    entries: position.units.map((unit) => ({ timestamp: unit.entryTimestamp, price: unit.entryPrice, quantity: unit.quantity })),
    exitPrice,
    netPnl,
    returnOnStartEquity: equityAtEntry > 0 ? netPnl / equityAtEntry : null,
    maxGrossLeverage: position.maxGrossLeverage,
    costs,
  };
}
function addUnitsForBar(position, candle, equity) {
  const direction = position.action === "LONG" ? 1 : -1;
  while (position.units.length < SYSTEM.maxUnits) {
    const trigger = position.nextAddPrice;
    const hit = direction > 0 ? candle.high >= trigger : candle.low <= trigger;
    if (!hit) break;
    const quantity = equity * SYSTEM.unitRiskNEquityFraction / position.n;
    if (!(quantity > 0)) break;
    position.units.push({ entryTimestamp: candle.timestamp, entryPrice: trigger, quantity });
    position.lastUnitPrice = trigger;
    position.nextAddPrice = trigger + direction * SYSTEM.addEveryN * position.n;
    position.stop = trigger - direction * SYSTEM.initialStopN * position.n;
    const gross = position.units.reduce((sum, unit) => sum + Math.abs(unit.entryPrice * unit.quantity), 0);
    position.maxGrossLeverage = Math.max(position.maxGrossLeverage, equity > 0 ? gross / equity : Infinity);
  }
}
function simulate({ candles, fundingRates, segment, costMultiplier }) {
  const nSeries = buildN(candles);
  const trades = [];
  const rejected = {};
  let equity = INITIAL_CAPITAL;
  let position = null;
  let positionStartEquity = null;
  const warmup = Math.max(SYSTEM.entryLookback, SYSTEM.exitLookback, SYSTEM.nPeriod) + 1;

  function reject(reason) {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  }
  function finalize(exitPrice, exitTimestamp, exitReason) {
    const trade = closePosition({
      position,
      exitPrice,
      exitTimestamp,
      exitReason,
      fundingRates,
      costMultiplier,
      equityAtEntry: positionStartEquity,
    });
    trades.push(trade);
    equity += trade.netPnl;
    position = null;
    positionStartEquity = null;
  }

  for (let index = warmup; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.timestamp < segment.start) continue;
    if (candle.timestamp > segment.end) break;
    const priorN = nSeries[index - 1];

    if (!position) {
      if (!(priorN > 0) || !(equity > 0)) {
        reject("N_OR_EQUITY_NOT_READY");
        continue;
      }
      const entryHigh = highestBefore(candles, index, SYSTEM.entryLookback);
      const entryLow = lowestBefore(candles, index, SYSTEM.entryLookback);
      if (!(entryHigh > 0 && entryLow > 0)) {
        reject("ENTRY_CHANNEL_NOT_READY");
        continue;
      }
      const longHit = candle.high > entryHigh;
      const shortHit = candle.low < entryLow;
      if (longHit && shortHit) {
        reject("AMBIGUOUS_DUAL_BREAKOUT");
        continue;
      }
      if (!longHit && !shortHit) continue;

      const action = longHit ? "LONG" : "SHORT";
      const direction = action === "LONG" ? 1 : -1;
      const entryPrice = action === "LONG"
        ? (candle.open > entryHigh ? candle.open : entryHigh)
        : (candle.open < entryLow ? candle.open : entryLow);
      const quantity = equity * SYSTEM.unitRiskNEquityFraction / priorN;
      if (!(entryPrice > 0 && quantity > 0)) {
        reject("INVALID_ENTRY_SIZE");
        continue;
      }
      positionStartEquity = equity;
      position = {
        action,
        n: priorN,
        units: [{ entryTimestamp: candle.timestamp, entryPrice, quantity }],
        lastUnitPrice: entryPrice,
        nextAddPrice: entryPrice + direction * SYSTEM.addEveryN * priorN,
        stop: entryPrice - direction * SYSTEM.initialStopN * priorN,
        maxGrossLeverage: Math.abs(entryPrice * quantity) / equity,
      };

      addUnitsForBar(position, candle, equity);

      const exitChannel = action === "LONG"
        ? lowestBefore(candles, index, SYSTEM.exitLookback)
        : highestBefore(candles, index, SYSTEM.exitLookback);
      const protective = action === "LONG"
        ? Math.max(position.stop, exitChannel)
        : Math.min(position.stop, exitChannel);
      const hitProtection = action === "LONG" ? candle.low <= protective : candle.high >= protective;
      if (hitProtection) {
        const exitPrice = action === "LONG"
          ? (candle.open <= protective ? candle.open : protective)
          : (candle.open >= protective ? candle.open : protective);
        const reason = action === "LONG"
          ? (position.stop >= exitChannel ? "2N_STOP" : "20D_CHANNEL_EXIT")
          : (position.stop <= exitChannel ? "2N_STOP" : "20D_CHANNEL_EXIT");
        finalize(exitPrice, candle.timestamp, reason);
      }
      continue;
    }

    const action = position.action;
    const exitChannel = action === "LONG"
      ? lowestBefore(candles, index, SYSTEM.exitLookback)
      : highestBefore(candles, index, SYSTEM.exitLookback);
    let protective = action === "LONG"
      ? Math.max(position.stop, exitChannel)
      : Math.min(position.stop, exitChannel);

    const gapExit = action === "LONG" ? candle.open <= protective : candle.open >= protective;
    if (gapExit) {
      const reason = action === "LONG"
        ? (position.stop >= exitChannel ? "2N_STOP" : "20D_CHANNEL_EXIT")
        : (position.stop <= exitChannel ? "2N_STOP" : "20D_CHANNEL_EXIT");
      finalize(candle.open, candle.timestamp, reason);
      continue;
    }

    // Daily OHLC cannot reveal intraday ordering. If an add and an adverse exit
    // are both touched, add first then exit. This is deliberately pessimistic.
    addUnitsForBar(position, candle, equity);
    protective = action === "LONG"
      ? Math.max(position.stop, exitChannel)
      : Math.min(position.stop, exitChannel);
    const exitHit = action === "LONG" ? candle.low <= protective : candle.high >= protective;
    if (exitHit) {
      const reason = action === "LONG"
        ? (position.stop >= exitChannel ? "2N_STOP" : "20D_CHANNEL_EXIT")
        : (position.stop <= exitChannel ? "2N_STOP" : "20D_CHANNEL_EXIT");
      finalize(protective, candle.timestamp, reason);
    }
  }

  if (position) {
    const last = [...candles].reverse().find((row) => row.timestamp <= segment.end);
    if (last) finalize(last.close, last.timestamp, "SEGMENT_END");
  }
  return {
    metrics: summarize(trades, INITIAL_CAPITAL),
    rejected,
    trades,
  };
}
async function collectSymbol(symbol) {
  const [prices, funding] = await Promise.all([
    collectVisionFuturesDailyKlines({
      symbol,
      startTime: DATA_START,
      endTime: DATA_END,
      concurrency: 8,
    }),
    collectVisionFuturesFunding({
      symbol,
      startTime: DATA_START,
      endTime: DATA_END,
      concurrency: 8,
    }),
  ]);
  assertDailyContinuity(prices.candles, symbol);
  if (!prices.checksumVerified || !funding.checksumVerified) throw new Error(`${symbol}_CHECKSUM_NOT_VERIFIED`);
  return {
    symbol,
    candles: prices.candles,
    fundingRates: funding.records,
    report: {
      symbol,
      priceProvider: prices.provider,
      fundingProvider: funding.provider,
      checksumVerified: true,
      candles: prices.candles.length,
      fundingRecords: funding.records.length,
      firstCandle: iso(prices.candles[0]?.timestamp),
      lastCandle: iso(prices.candles.at(-1)?.timestamp),
      firstFunding: iso(funding.records[0]?.timestamp),
      lastFunding: iso(funding.records.at(-1)?.timestamp),
    },
  };
}
function selfTest() {
  const candles = [];
  let price = 100;
  for (let i = 0; i < 120; i += 1) {
    price *= 1.002;
    candles.push({
      timestamp: Date.UTC(2020, 0, 1) + i * DAY,
      open: price * 0.999,
      high: price * 1.01,
      low: price * 0.99,
      close: price,
      volume: 1,
    });
  }
  const n = buildN(candles);
  if (!(n[60] > 0)) throw new Error("SELFTEST_N");
  if (!(highestBefore(candles, 60, 55) > lowestBefore(candles, 60, 55))) throw new Error("SELFTEST_CHANNEL");
  console.log("TURTLE_SYSTEM2_SELF_TEST_OK");
}
async function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const datasets = [];
  const failures = [];
  for (const symbol of SYMBOLS) {
    try {
      datasets.push(await collectSymbol(symbol));
    } catch (error) {
      failures.push({ symbol, error: String(error?.message ?? error) });
    }
  }
  if (datasets.length < 2) throw new Error(`TURTLE_DATASETS_INSUFFICIENT_${datasets.length}`);

  const results = {};
  for (const dataset of datasets) {
    results[dataset.symbol] = {};
    for (const [segmentName, segment] of Object.entries(SEGMENTS)) {
      results[dataset.symbol][segmentName] = {
        normal: simulate({ candles: dataset.candles, fundingRates: dataset.fundingRates, segment, costMultiplier: 1 }),
        stress15x: simulate({ candles: dataset.candles, fundingRates: dataset.fundingRates, segment, costMultiplier: 1.5 }),
      };
    }
  }

  const segmentAggregate = {};
  for (const segmentName of Object.keys(SEGMENTS)) {
    const rows = datasets.map((dataset) => results[dataset.symbol][segmentName].normal.metrics);
    const stress = datasets.map((dataset) => results[dataset.symbol][segmentName].stress15x.metrics);
    segmentAggregate[segmentName] = {
      symbolsPositiveNormal: rows.filter((row) => row.totalReturn > 0).length,
      symbolsPositiveStress: stress.filter((row) => row.totalReturn > 0).length,
      meanSymbolReturnNormal: mean(rows.map((row) => row.totalReturn)),
      meanSymbolReturnStress: mean(stress.map((row) => row.totalReturn)),
      meanProfitFactorNormal: mean(rows.map((row) => row.profitFactor).filter(Number.isFinite)),
      meanMaxDrawdownNormal: mean(rows.map((row) => row.maxDrawdown)),
    };
  }

  const crossSymbolTransferPassed = ["PRIOR", "MID", "RECENT"].every((segmentName) =>
    segmentAggregate[segmentName].symbolsPositiveStress === datasets.length
  );

  const report = {
    schemaVersion: 1,
    status: "pass",
    recipeId: SYSTEM.id,
    market: "CRYPTO_FUTURES",
    purpose: "source-faithful Turtle System 2 baseline before any local optimization or AI overlay",
    source: {
      primaryRulesUrl: SOURCE_URL,
      rulesCopyUrl: SOURCE_RULES_URL,
      system: "System 2",
      rules: {
        entry: "55-day breakout, every signal taken",
        exit: "20-day opposite breakout",
        N: "20-day exponentially smoothed true range",
        initialStop: "2N",
        pyramiding: "add every 0.5N, maximum 4 units",
        unitSizing: "1N dollar volatility equals 1% of equity, translated to crypto quantity",
      },
    },
    implementation: {
      parameterSearch: false,
      ruleRetuning: false,
      dailyOhlcIntrabarOrdering: "when add and adverse exit coexist, add-first then exit (pessimistic)",
      currentBarNUsedForSignal: false,
      priorCompletedBarNUsed: true,
      portfolioCorrelationUnitLimitsImplemented: false,
      singleMarketSystem2Translation: true,
      priceProvider: "Binance Vision USD-M monthly archive",
      fundingProvider: "Binance Vision USD-M monthly funding archive",
      executionCostAssumption: "Bitget standard taker research cost model",
      costStressMultiplier: 1.5,
    },
    data: {
      requestedStart: new Date(DATA_START).toISOString(),
      requestedEnd: new Date(DATA_END).toISOString(),
      symbolsRequested: SYMBOLS,
      datasets: datasets.map((row) => row.report),
      failures,
    },
    segments: SEGMENTS,
    results,
    segmentAggregate,
    promotionAssessment: {
      status: crossSymbolTransferPassed
        ? "REFERENCE_CANDIDATE_REQUIRES_FUTURE_OOS"
        : "RESEARCH_HOLD_CROSS_SYMBOL_GENERALIZATION_FAILED",
      crossSymbolTransferPassed,
      automaticPromotionAllowed: false,
      economicSampleCredit: 0,
      profitabilityClaimAllowed: false,
      symbolSpecificWinnerSelectionAllowed: false,
      observedHistoryMaySelectETHOnly: false,
      reason: crossSymbolTransferPassed
        ? "fixed source rules remained positive across both symbols and all three fixed windows under 1.5x cost stress, but historical replay still cannot promote"
        : "ETH is positive across fixed windows, but BTC fails MID and RECENT even before modeled execution costs; selecting ETH after seeing these results would be post-hoc symbol selection",
      nextRule: "do not optimize lookbacks, N, stop, pyramiding, unit risk, or symbol selection on these observed windows; move to a different independent source recipe or genuinely unused future evidence",
    },
    safeguards: {
      researchOnly: true,
      publicDataOnly: true,
      privateAccountRequestAllowed: false,
      actualOrders: 0,
      orderRouteCalled: false,
      executionAuthority: "NONE",
      liveExecutionAllowed: false,
    },
    limitations: [
      "This is a crypto-futures translation of Turtle System 2, not the original diversified commodity portfolio.",
      "Portfolio-level correlated-market unit limits and contract-specific dollar-per-point values from the original program are not reproduced.",
      "Daily OHLC cannot recover intraday event ordering; ambiguous add-versus-exit bars use pessimistic add-first semantics.",
      "Crypto quantity sizing maps 1N to 1% equity but does not enforce exchange historical margin tiers or liquidation rules.",
      "Bitget cost assumptions are explicit research assumptions; they are not exact historical account fees.",
      "Historical replay is not genuine future-time OOS/Forward profitability proof.",
    ],
  };

  const out = resolve(process.argv[2] ?? "docs/crypto-turtle-system2-v1.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    status: report.status,
    symbols: report.data.datasets.map((row) => row.symbol),
    priorMeanReturn: report.segmentAggregate.PRIOR.meanSymbolReturnNormal,
    midMeanReturn: report.segmentAggregate.MID.meanSymbolReturnNormal,
    recentMeanReturn: report.segmentAggregate.RECENT.meanSymbolReturnNormal,
    fullMeanReturn: report.segmentAggregate.FULL.meanSymbolReturnNormal,
    priorPositive: report.segmentAggregate.PRIOR.symbolsPositiveNormal,
    midPositive: report.segmentAggregate.MID.symbolsPositiveNormal,
    recentPositive: report.segmentAggregate.RECENT.symbolsPositiveNormal,
    recentStressPositive: report.segmentAggregate.RECENT.symbolsPositiveStress,
    crossSymbolTransferPassed: report.promotionAssessment.crossSymbolTransferPassed,
    promotionStatus: report.promotionAssessment.status,
    btcMidGrossBeforeCosts: report.results.BTCUSDT?.MID?.normal?.metrics?.grossBeforeExecutionCostsReturn ?? null,
    btcRecentGrossBeforeCosts: report.results.BTCUSDT?.RECENT?.normal?.metrics?.grossBeforeExecutionCostsReturn ?? null,
  }));
}
await main();

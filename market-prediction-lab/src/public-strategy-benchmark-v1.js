import { calculateExecutionAwareTrade, summarizeResearchPerformance } from "./research-validation-layer.js";
import { BITGET_STANDARD_TAKER_RESEARCH_COSTS } from "./historical-backtest-data.js";

export const PUBLIC_STRATEGY_BENCHMARK_V1 = "public-strategy-3y-benchmark/v1";
export const BENCHMARK_START_TIME = Date.UTC(2023, 8, 30, 0, 0, 0, 0);
export const BENCHMARK_END_TIME = Date.UTC(2026, 8, 30, 0, 0, 0, 0);

const CASH_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]);
const MARKETS = Object.freeze(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);

export const BENCHMARK_HORIZONS_V1 = Object.freeze({
  SHORT: Object.freeze({
    timeframe: "15m",
    lookbackBars: 96,
    holdingBars: 16,
    minimumAbsReturn: 0.004,
  }),
  SWING: Object.freeze({
    timeframe: "1h",
    lookbackBars: 168,
    holdingBars: 24,
    minimumAbsReturn: 0.01,
  }),
  POSITION: Object.freeze({
    timeframe: "1d",
    lookbackBars: 60,
    holdingBars: 20,
    minimumAbsReturn: 0.03,
  }),
});

export const STOCK_RESEARCH_COST_RATE_PER_SIDE_V1 = Object.freeze({
  KR_STOCK: 0.0025,
  US_STOCK: 0.0015,
});

export const PUBLIC_REFERENCE_REPLICATION_READINESS_V1 = Object.freeze([
  Object.freeze({
    recipeId: "CHARTING_BY_MACHINES_V1",
    status: "BLOCKED_DATA",
    blocker: "LOCAL_POINT_IN_TIME_ML_REPLICATION_NOT_COMPLETED",
    executableProxyAllowed: false,
  }),
  Object.freeze({
    recipeId: "STOCKS_IN_PLAY_ORB_5M_V1",
    status: "BLOCKED_DATA",
    blocker: "THREE_YEAR_POINT_IN_TIME_INTRADAY_STOCKS_IN_PLAY_DATA_NOT_MATERIALIZED",
    executableProxyAllowed: false,
  }),
  Object.freeze({
    recipeId: "CRYPTO_RISK_MANAGED_MOMENTUM_V1",
    status: "BLOCKED_DATA",
    blocker: "CRYPTO_PIT_LISTING_DELISTING_AND_WEEKLY_MARKET_CAP_HISTORY_NOT_MATERIALIZED",
    executableProxyAllowed: false,
  }),
  Object.freeze({
    recipeId: "FUNDING_RATE_ARBITRAGE_CEX_DEX_V1",
    status: "BLOCKED_DATA",
    blocker: "SYNCHRONIZED_CEX_DEX_HEDGE_LEGS_AND_VENUE_FULL_COST_HISTORY_NOT_MATERIALIZED",
    executableProxyAllowed: false,
  }),
  Object.freeze({
    recipeId: "MLLM_VISUAL_CHART_CRYPTO_V1",
    status: "BLOCKED_DATA",
    blocker: "IMMUTABLE_MODEL_PROMPT_RENDERER_ROLLING_OOS_REPLICATION_NOT_COMPLETED",
    executableProxyAllowed: false,
  }),
  Object.freeze({
    recipeId: "TIME_SERIES_MOMENTUM_V1",
    status: "LOCAL_FIXED_PROXY_EXECUTABLE",
    blocker: null,
    executableProxyAllowed: true,
  }),
  Object.freeze({
    recipeId: "RELATIVE_MOMENTUM_PROXY_V1",
    status: "LOCAL_FIXED_PROXY_EXECUTABLE",
    blocker: null,
    executableProxyAllowed: true,
  }),
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function positive(value, label) {
  finite(value, label);
  if (!(value > 0)) throw new TypeError(`${label} must be positive`);
  return value;
}

function assertMarket(market) {
  if (!MARKETS.includes(market)) throw new TypeError(`unsupported market: ${market}`);
  return market;
}

function assertHorizon(horizon) {
  const config = BENCHMARK_HORIZONS_V1[horizon];
  if (!config) throw new TypeError(`unsupported horizon: ${horizon}`);
  return config;
}

function normalizeCandles(candles, startTime = BENCHMARK_START_TIME, endTime = BENCHMARK_END_TIME) {
  if (!Array.isArray(candles)) throw new TypeError("candles must be an array");
  const rows = candles
    .filter((row) => Number.isInteger(row?.timestamp) && row.timestamp >= startTime && row.timestamp < endTime)
    .map((row) => {
      for (const field of ["open", "high", "low", "close"]) positive(Number(row[field]), `candle.${field}`);
      const volume = Number(row.volume ?? 0);
      if (!Number.isFinite(volume) || volume < 0) throw new TypeError("candle.volume must be non-negative");
      if (row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close) || row.high < row.low) {
        throw new TypeError("invalid OHLC candle");
      }
      return Object.freeze({
        timestamp: row.timestamp,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume,
      });
    })
    .sort((a, b) => a.timestamp - b.timestamp);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].timestamp <= rows[index - 1].timestamp) throw new TypeError("candles must be unique and increasing");
  }
  return Object.freeze(rows);
}

function costModel(market, multiplier = 1) {
  positive(multiplier, "costMultiplier");
  if (market === "KR_STOCK" || market === "US_STOCK") {
    const rate = STOCK_RESEARCH_COST_RATE_PER_SIDE_V1[market] * multiplier;
    return Object.freeze({
      entryFeeRate: rate,
      exitFeeRate: rate,
      taxRate: 0,
      slippageRate: 0,
      spreadRate: 0,
      latencyBars: 0,
      latencyDriftRate: 0,
    });
  }
  const base = BITGET_STANDARD_TAKER_RESEARCH_COSTS[market];
  if (!base) throw new TypeError(`no cost model for ${market}`);
  return Object.freeze({
    ...base,
    entryFeeRate: base.entryFeeRate * multiplier,
    exitFeeRate: base.exitFeeRate * multiplier,
    slippageRate: base.slippageRate * multiplier,
    spreadRate: base.spreadRate * multiplier,
  });
}

function fundingRatesForWindow(rows, startTime, endTime) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows
    .filter((row) => Number.isInteger(row?.timestamp) && row.timestamp > startTime && row.timestamp <= endTime)
    .map((row) => Number(row.rate))
    .filter(Number.isFinite);
}

function directionForMomentum(market, momentum, minimumAbsReturn) {
  if (momentum >= minimumAbsReturn) return "LONG";
  if (market === "CRYPTO_FUTURES" && momentum <= -minimumAbsReturn) return "SHORT";
  return null;
}

function actionForDirection(market, direction) {
  if (market === "CRYPTO_FUTURES") return direction;
  return "BUY";
}

function buildTrade({
  market,
  symbol,
  timeframe,
  strategy,
  direction,
  entryCandle,
  exitCandle,
  equityBefore,
  cost,
  fundingRates,
  signalContext,
}) {
  const quantity = equityBefore / entryCandle.open;
  const action = actionForDirection(market, direction);
  const execution = calculateExecutionAwareTrade({
    market,
    action,
    entryPrice: entryCandle.open,
    exitPrice: exitCandle.open,
    quantity,
    leverage: 1,
    entryFeeRate: cost.entryFeeRate,
    exitFeeRate: cost.exitFeeRate,
    taxRate: cost.taxRate,
    slippageRate: cost.slippageRate,
    spreadRate: cost.spreadRate,
    latencyBars: cost.latencyBars,
    latencyDriftRate: cost.latencyDriftRate,
    fundingRates,
  });
  return Object.freeze({
    id: `${strategy}:${market}:${symbol}:${entryCandle.timestamp}:${exitCandle.timestamp}:${direction}`,
    market,
    symbol,
    strategy,
    strategyVersion: "PUBLIC_3Y_FIXED_PROXY_V1",
    timeframe,
    regime: "fixed_public_proxy",
    side: direction.toLowerCase(),
    action,
    entryTime: entryCandle.timestamp,
    exitTime: exitCandle.timestamp,
    entryPrice: entryCandle.open,
    exitPrice: exitCandle.open,
    quantity,
    leverage: 1,
    netPnl: execution.netPnl,
    grossPnl: execution.grossPnl,
    netReturnOnMargin: execution.netReturnOnMargin,
    entryNotional: execution.entryNotional,
    costs: execution.costs,
    execution,
    signalContext: deepFreeze(signalContext),
    equityBefore,
    equityAfter: equityBefore + execution.netPnl,
  });
}

function compactPerformance(trades, initialCapital) {
  const perf = summarizeResearchPerformance(trades, { initialCapital }).overall;
  return deepFreeze({
    sampleCount: perf.sampleCount,
    totalReturnPercent: perf.totalReturn * 100,
    winRatePercent: perf.winRate * 100,
    profitFactor: perf.profitFactor,
    maximumDrawdownPercent: perf.maximumDrawdownPercent * 100,
    tradeSharpe: perf.tradeSharpe,
    expectancy: perf.expectancy,
    turnover: perf.turnover,
    totalExecutionCost: perf.totalExecutionCost,
    finalCapital: perf.finalCapital,
  });
}

function foldBoundaries() {
  const sixMonths = [
    Date.UTC(2024, 2, 30),
    Date.UTC(2024, 8, 30),
    Date.UTC(2025, 2, 30),
    Date.UTC(2025, 8, 30),
    Date.UTC(2026, 2, 30),
    BENCHMARK_END_TIME,
  ];
  const starts = [
    BENCHMARK_START_TIME,
    Date.UTC(2024, 2, 30),
    Date.UTC(2024, 8, 30),
    Date.UTC(2025, 2, 30),
    Date.UTC(2025, 8, 30),
    Date.UTC(2026, 2, 30),
  ];
  return starts.map((startTime, index) => Object.freeze({ fold: index + 1, startTime, endTime: sixMonths[index] }));
}

function summarizeWalkForward(trades, initialCapital) {
  const folds = foldBoundaries().map(({ fold, startTime, endTime }) => {
    const rows = trades.filter((trade) => trade.exitTime >= startTime && trade.exitTime < endTime);
    const metrics = compactPerformance(rows, initialCapital);
    return deepFreeze({ fold, startTime, endTime, ...metrics });
  });
  const active = folds.filter((fold) => fold.sampleCount > 0);
  return deepFreeze({
    foldCount: folds.length,
    activeFoldCount: active.length,
    positiveFoldCount: active.filter((fold) => fold.totalReturnPercent > 0).length,
    allActiveFoldsPositive: active.length > 0 && active.every((fold) => fold.totalReturnPercent > 0),
    folds,
  });
}

export function simulateTimeSeriesMomentumProxyV1({
  market,
  symbol,
  horizon,
  candles,
  fundingRates = [],
  costMultiplier = 1,
  initialCapital = 1_000_000,
} = {}) {
  assertMarket(market);
  const config = assertHorizon(horizon);
  const rows = normalizeCandles(candles);
  if (rows.length < config.lookbackBars + config.holdingBars + 3) {
    return deepFreeze({
      status: "BLOCKED_DATA",
      reason: "INSUFFICIENT_CANDLES_FOR_FIXED_PROXY",
      market,
      symbol,
      horizon,
      timeframe: config.timeframe,
      candleCount: rows.length,
    });
  }
  positive(initialCapital, "initialCapital");
  const cost = costModel(market, costMultiplier);
  const trades = [];
  let equity = initialCapital;
  let index = config.lookbackBars;
  while (index + config.holdingBars + 1 < rows.length && equity > 0) {
    const signal = rows[index];
    const reference = rows[index - config.lookbackBars];
    const momentum = signal.close / reference.close - 1;
    const direction = directionForMomentum(market, momentum, config.minimumAbsReturn);
    if (!direction) {
      index += config.holdingBars;
      continue;
    }
    const entry = rows[index + 1];
    const exitIndex = Math.min(rows.length - 1, index + 1 + config.holdingBars);
    const exit = rows[exitIndex];
    const trade = buildTrade({
      market,
      symbol,
      timeframe: config.timeframe,
      strategy: "TIME_SERIES_MOMENTUM_PROXY_V1",
      direction,
      entryCandle: entry,
      exitCandle: exit,
      equityBefore: equity,
      cost,
      fundingRates: market === "CRYPTO_FUTURES"
        ? fundingRatesForWindow(fundingRates, entry.timestamp, exit.timestamp)
        : [],
      signalContext: {
        horizon,
        lookbackBars: config.lookbackBars,
        holdingBars: config.holdingBars,
        minimumAbsReturn: config.minimumAbsReturn,
        momentum,
        sourceFaithfulReplication: false,
        localFixedProxy: true,
      },
    });
    trades.push(trade);
    equity = trade.equityAfter;
    index = exitIndex;
  }
  return deepFreeze({
    status: "EXECUTED_PROXY",
    recipeId: "TIME_SERIES_MOMENTUM_V1",
    strategy: "TIME_SERIES_MOMENTUM_PROXY_V1",
    market,
    symbol,
    horizon,
    timeframe: config.timeframe,
    costMultiplier,
    initialCapital,
    parameters: config,
    performance: compactPerformance(trades, initialCapital),
    walkForward: summarizeWalkForward(trades, initialCapital),
    trades: Object.freeze(trades),
    safeguards: Object.freeze({
      nextBarOpenExecution: true,
      fixedParametersNoOosRetuning: true,
      sourceFaithfulReplication: false,
      profitabilityClaimAllowed: false,
      economicCreditAllowed: false,
      executionAuthority: "NONE",
    }),
  });
}

function alignedDatasets(datasets) {
  if (!Array.isArray(datasets) || datasets.length < 2) throw new TypeError("at least two datasets are required");
  const normalized = datasets.map((dataset) => ({
    symbol: String(dataset.symbol ?? "").trim(),
    candles: normalizeCandles(dataset.candles),
  }));
  if (normalized.some((dataset) => !dataset.symbol || dataset.candles.length === 0)) throw new TypeError("invalid relative-momentum dataset");
  const maps = normalized.map((dataset) => new Map(dataset.candles.map((candle) => [candle.timestamp, candle])));
  let timestamps = [...maps[0].keys()];
  for (let index = 1; index < maps.length; index += 1) timestamps = timestamps.filter((timestamp) => maps[index].has(timestamp));
  timestamps.sort((a, b) => a - b);
  return deepFreeze({
    symbols: normalized.map((dataset) => dataset.symbol),
    timestamps,
    candlesBySymbol: Object.fromEntries(normalized.map((dataset, index) => [
      dataset.symbol,
      Object.freeze(timestamps.map((timestamp) => maps[index].get(timestamp))),
    ])),
  });
}

export function simulateRelativeMomentumProxyV1({
  market,
  horizon,
  datasets,
  fundingRatesBySymbol = {},
  costMultiplier = 1,
  initialCapital = 1_000_000,
} = {}) {
  assertMarket(market);
  const config = assertHorizon(horizon);
  const aligned = alignedDatasets(datasets);
  if (aligned.timestamps.length < config.lookbackBars + config.holdingBars + 3) {
    return deepFreeze({
      status: "BLOCKED_DATA",
      reason: "INSUFFICIENT_ALIGNED_CANDLES_FOR_RELATIVE_MOMENTUM_PROXY",
      market,
      horizon,
      timeframe: config.timeframe,
      alignedCandleCount: aligned.timestamps.length,
    });
  }
  const cost = costModel(market, costMultiplier);
  const trades = [];
  let equity = initialCapital;
  let index = config.lookbackBars;
  while (index + config.holdingBars + 1 < aligned.timestamps.length && equity > 0) {
    const ranked = aligned.symbols.map((symbol) => {
      const rows = aligned.candlesBySymbol[symbol];
      return Object.freeze({
        symbol,
        momentum: rows[index].close / rows[index - config.lookbackBars].close - 1,
      });
    }).sort((a, b) => b.momentum - a.momentum || a.symbol.localeCompare(b.symbol));
    const best = ranked[0];
    const worst = ranked.at(-1);
    let selected = null;
    let direction = null;
    if (best.momentum >= config.minimumAbsReturn) {
      selected = best;
      direction = "LONG";
    }
    if (market === "CRYPTO_FUTURES" && worst.momentum <= -config.minimumAbsReturn
        && (!selected || Math.abs(worst.momentum) > Math.abs(best.momentum))) {
      selected = worst;
      direction = "SHORT";
    }
    if (!selected || !direction) {
      index += config.holdingBars;
      continue;
    }
    const rows = aligned.candlesBySymbol[selected.symbol];
    const entry = rows[index + 1];
    const exitIndex = Math.min(rows.length - 1, index + 1 + config.holdingBars);
    const exit = rows[exitIndex];
    const trade = buildTrade({
      market,
      symbol: selected.symbol,
      timeframe: config.timeframe,
      strategy: "RELATIVE_MOMENTUM_PROXY_V1",
      direction,
      entryCandle: entry,
      exitCandle: exit,
      equityBefore: equity,
      cost,
      fundingRates: market === "CRYPTO_FUTURES"
        ? fundingRatesForWindow(fundingRatesBySymbol[selected.symbol] ?? [], entry.timestamp, exit.timestamp)
        : [],
      signalContext: {
        horizon,
        ranked,
        selectedSymbol: selected.symbol,
        direction,
        lookbackBars: config.lookbackBars,
        holdingBars: config.holdingBars,
        minimumAbsReturn: config.minimumAbsReturn,
        sourceFaithfulReplication: false,
        pointInTimeUniverseComplete: false,
        localTwoOrThreeAssetProxy: true,
      },
    });
    trades.push(trade);
    equity = trade.equityAfter;
    index = exitIndex;
  }
  return deepFreeze({
    status: "EXECUTED_PROXY",
    recipeId: "RELATIVE_MOMENTUM_PROXY_V1",
    strategy: "RELATIVE_MOMENTUM_PROXY_V1",
    market,
    horizon,
    timeframe: config.timeframe,
    symbols: aligned.symbols,
    costMultiplier,
    initialCapital,
    parameters: config,
    performance: compactPerformance(trades, initialCapital),
    walkForward: summarizeWalkForward(trades, initialCapital),
    trades: Object.freeze(trades),
    safeguards: Object.freeze({
      nextBarOpenExecution: true,
      fixedParametersNoOosRetuning: true,
      sourceFaithfulReplication: false,
      survivorshipAndPITUniverseCreditAllowed: false,
      profitabilityClaimAllowed: false,
      economicCreditAllowed: false,
      executionAuthority: "NONE",
    }),
  });
}

export function summarizeTsmomUniverseV1(results = []) {
  const executed = results.filter((row) => row?.status === "EXECUTED_PROXY");
  if (executed.length === 0) return deepFreeze({ status: "NO_EXECUTED_RESULTS", resultCount: 0 });
  const median = (values) => {
    const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  return deepFreeze({
    status: "EXECUTED_PROXY_SUMMARY",
    resultCount: executed.length,
    medianTotalReturnPercent: median(executed.map((row) => row.performance.totalReturnPercent)),
    medianTradeSharpe: median(executed.map((row) => row.performance.tradeSharpe)),
    medianProfitFactor: median(executed.map((row) => row.performance.profitFactor)),
    worstMaximumDrawdownPercent: Math.max(...executed.map((row) => row.performance.maximumDrawdownPercent)),
    minimumPositiveFoldCount: Math.min(...executed.map((row) => row.walkForward.positiveFoldCount)),
    perSymbol: Object.freeze(executed.map((row) => deepFreeze({
      symbol: row.symbol,
      totalReturnPercent: row.performance.totalReturnPercent,
      tradeSharpe: row.performance.tradeSharpe,
      profitFactor: row.performance.profitFactor,
      maximumDrawdownPercent: row.performance.maximumDrawdownPercent,
      winRatePercent: row.performance.winRatePercent,
      sampleCount: row.performance.sampleCount,
      positiveFoldCount: row.walkForward.positiveFoldCount,
    }))),
  });
}

export function buildPublicStrategyBenchmarkPlanV1() {
  const profiles = MARKETS.flatMap((market) => Object.entries(BENCHMARK_HORIZONS_V1).map(([horizon, config]) => {
    const stockIntradayBlocked = (market === "KR_STOCK" || market === "US_STOCK") && horizon !== "POSITION";
    return deepFreeze({
      profileId: `${market}:${horizon}`,
      market,
      horizon,
      timeframe: config.timeframe,
      dataStatus: stockIntradayBlocked ? "BLOCKED_DATA" : "COLLECT_PUBLIC_DATA",
      dataBlocker: stockIntradayBlocked ? "THREE_YEAR_INTRADAY_STOCK_PUBLIC_PROVIDER_NOT_INTEGRATED" : null,
      executableStrategies: stockIntradayBlocked ? [] : ["TIME_SERIES_MOMENTUM_PROXY_V1", "RELATIVE_MOMENTUM_PROXY_V1"],
    });
  }));
  return deepFreeze({
    schemaVersion: 1,
    contract: PUBLIC_STRATEGY_BENCHMARK_V1,
    startTime: BENCHMARK_START_TIME,
    endTimeExclusive: BENCHMARK_END_TIME,
    exactThreeYearWindow: true,
    profileCount: profiles.length,
    profiles,
    referenceReplicationReadiness: PUBLIC_REFERENCE_REPLICATION_READINESS_V1,
    safety: Object.freeze({
      researchOnly: true,
      profitabilityProven: false,
      winnerDeclared: false,
      automaticActivationAllowed: false,
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      executionAuthority: "NONE",
    }),
  });
}

export const EVIDENCE_BACKED_3Y_BENCHMARK_VERSION = "evidence-backed-3y-benchmark-v1";

export const BENCHMARK_PERIOD = Object.freeze({
  startTime: Date.UTC(2023, 7, 10, 0, 0, 0, 0),
  endTime: Date.UTC(2026, 7, 9, 23, 59, 59, 999),
  label: "2023-08-10_to_2026-08-09",
  selectionUsesPost2025Data: false,
  finalHoldoutBoundaryPreserved: true,
});

export const BENCHMARK_HORIZONS = Object.freeze({
  SHORT: Object.freeze({ timeframe: "15m", intervalMs: 15 * 60 * 1000, tsmomLookbackBars: 96, rebalanceBars: 16 }),
  SWING: Object.freeze({ timeframe: "1h", intervalMs: 60 * 60 * 1000, tsmomLookbackBars: 168, rebalanceBars: 24 }),
  POSITION: Object.freeze({ timeframe: "1d", intervalMs: 24 * 60 * 60 * 1000, tsmomLookbackBars: 252, rebalanceBars: 21 }),
});

export const BENCHMARK_MARKETS = Object.freeze([
  "KR_STOCK",
  "US_STOCK",
  "CRYPTO_SPOT",
  "CRYPTO_FUTURES",
]);

export const COMMON_FRICTION_STRESS_BPS_PER_SIDE = Object.freeze([5, 10, 20]);

const STOCK_INTRADAY_BLOCKER =
  "APPROVED_PUBLIC_3Y_EXACT_INTRADAY_STOCK_COLLECTOR_NOT_AVAILABLE";

export const BENCHMARK_PROFILE_PLAN = Object.freeze(
  BENCHMARK_MARKETS.flatMap((market) => Object.entries(BENCHMARK_HORIZONS).map(([horizon, definition]) => {
    const stockIntraday = (market === "KR_STOCK" || market === "US_STOCK") && horizon !== "POSITION";
    return Object.freeze({
      profileId: `${market}:${horizon}`,
      market,
      horizon,
      timeframe: definition.timeframe,
      status: stockIntraday ? "BLOCKED_DATA" : "READY_FOR_PUBLIC_BENCHMARK",
      blockers: stockIntraday ? Object.freeze([STOCK_INTRADAY_BLOCKER]) : Object.freeze([]),
      dataRole: market === "KR_STOCK" || market === "US_STOCK"
        ? "REPRESENTATIVE_FIXED_BASKET_DAILY_ONLY"
        : "PUBLIC_CRYPTO_EXACT_TIMEFRAME",
    });
  })),
);

export const SOURCE_REFERENCE_RECIPES = Object.freeze([
  Object.freeze({
    recipeId: "CHARTING_BY_MACHINES_V1",
    benchmarkStatus: "BLOCKED_REPLICATION",
    blockers: Object.freeze([
      "SOURCE_FAITHFUL_NONLINEAR_MODEL_TRAINING_PIPELINE_NOT_FROZEN",
      "POINT_IN_TIME_FULL_STOCK_UNIVERSE_WITH_DELISTED_SECURITIES_NOT_BOUND",
    ]),
  }),
  Object.freeze({
    recipeId: "STOCKS_IN_PLAY_ORB_5M_V1",
    benchmarkStatus: "BLOCKED_DATA",
    blockers: Object.freeze([
      "THREE_YEAR_5M_US_STOCK_POINT_IN_TIME_INTRADAY_UNIVERSE_NOT_BOUND",
      "STOCKS_IN_PLAY_ABNORMAL_ACTIVITY_RANKING_HISTORY_NOT_BOUND",
    ]),
  }),
  Object.freeze({
    recipeId: "CRYPTO_RISK_MANAGED_MOMENTUM_V1",
    benchmarkStatus: "PROXY_ONLY",
    blockers: Object.freeze([
      "PAPER_REPLICATION_REQUIRES_POINT_IN_TIME_CRYPTO_UNIVERSE",
      "PAPER_REPLICATION_REQUIRES_WEEKLY_POINT_IN_TIME_MARKET_CAP",
    ]),
  }),
  Object.freeze({
    recipeId: "FUNDING_RATE_ARBITRAGE_CEX_DEX_V1",
    benchmarkStatus: "PROXY_ONLY",
    blockers: Object.freeze([
      "SOURCE_REPLICATION_REQUIRES_SYNCHRONIZED_CEX_DEX_HEDGE_LEGS",
      "SOURCE_REPLICATION_REQUIRES_VENUE_SPECIFIC_FULL_COST_AND_LIQUIDATION_EVIDENCE",
    ]),
  }),
  Object.freeze({
    recipeId: "MLLM_VISUAL_CHART_CRYPTO_V1",
    benchmarkStatus: "BLOCKED_REPLICATION",
    blockers: Object.freeze([
      "IMMUTABLE_MODEL_AND_PROMPT_IDENTITY_NOT_FROZEN_FOR_LOCAL_REPLICATION",
      "POINT_IN_TIME_TOP100_MARKET_CAP_UNIVERSE_NOT_BOUND",
    ]),
  }),
]);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function costModelFromCommonFrictionBps(perSideBps) {
  if (!Number.isFinite(perSideBps) || perSideBps < 0 || perSideBps > 1_000) {
    throw new RangeError("perSideBps must be between 0 and 1000");
  }
  const rate = perSideBps / 10_000;
  return Object.freeze({
    entryFeeRate: rate,
    exitFeeRate: rate,
    taxRate: 0,
    slippageRate: 0,
    spreadRate: 0,
    latencyBars: 0,
    latencyDriftRate: 0,
    schedule: Object.freeze([]),
    evidenceRole: "COMMON_FRICTION_STRESS_NOT_MARKET_SPECIFIC_FULL_COST",
  });
}

export function buildTsmomSignalEvaluator({ lookbackBars, threshold = 0 } = {}) {
  if (!Number.isSafeInteger(lookbackBars) || lookbackBars < 2) throw new RangeError("lookbackBars must be >= 2");
  if (!Number.isFinite(threshold) || threshold < 0) throw new RangeError("threshold must be non-negative");
  return ({ side, candles, index }) => {
    if (index < lookbackBars) return null;
    const current = candles[index]?.close;
    const prior = candles[index - lookbackBars]?.close;
    if (!(current > 0 && prior > 0)) return null;
    const pastReturn = current / prior - 1;
    if (side === "long" && pastReturn <= threshold) return null;
    if (side === "short" && pastReturn >= -threshold) return null;
    return Object.freeze({
      family: "TSMOM_FIXED",
      lookbackBars,
      threshold,
      pastReturn,
      direction: side === "long" ? "UP" : "DOWN",
      sourceRole: "LOCAL_FIXED_HORIZON_ADAPTATION",
    });
  };
}

export function coverageSummary({ candles, startTime = BENCHMARK_PERIOD.startTime, endTime = BENCHMARK_PERIOD.endTime } = {}) {
  const rows = Array.isArray(candles) ? candles.filter((row) => Number.isInteger(row?.timestamp)).sort((a, b) => a.timestamp - b.timestamp) : [];
  if (rows.length === 0) {
    return Object.freeze({
      status: "BLOCKED_DATA",
      candleCount: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      timeCoverageRatio: 0,
      blockers: Object.freeze(["NO_CANDLES"]),
    });
  }
  const firstTimestamp = rows[0].timestamp;
  const lastTimestamp = rows.at(-1).timestamp;
  const requestedSpan = endTime - startTime;
  const observedStart = Math.max(firstTimestamp, startTime);
  const observedEnd = Math.min(lastTimestamp, endTime);
  const observedSpan = Math.max(0, observedEnd - observedStart);
  const timeCoverageRatio = requestedSpan > 0 ? observedSpan / requestedSpan : 0;
  const blockers = [];
  if (firstTimestamp > startTime + 7 * 24 * 60 * 60 * 1000) blockers.push("START_COVERAGE_LATE");
  if (lastTimestamp < endTime - 7 * 24 * 60 * 60 * 1000) blockers.push("END_COVERAGE_EARLY");
  if (timeCoverageRatio < 0.98) blockers.push("TIME_COVERAGE_BELOW_98_PERCENT");
  return Object.freeze({
    status: blockers.length ? "BLOCKED_DATA" : "READY",
    candleCount: rows.length,
    firstTimestamp,
    lastTimestamp,
    timeCoverageRatio,
    blockers: Object.freeze(blockers),
  });
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function maxDrawdownFromReturns(returns) {
  let equity = 1;
  let peak = 1;
  let maximumDrawdown = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  return maximumDrawdown;
}

export function summarizeReturnSeries(returns, { barsPerYear, initialCapital = 1_000_000 } = {}) {
  if (!Array.isArray(returns)) throw new TypeError("returns must be an array");
  if (!(barsPerYear > 0)) throw new RangeError("barsPerYear must be positive");
  const clean = returns.map(finite).filter((value) => value !== null && value > -1);
  let wealth = 1;
  for (const value of clean) wealth *= 1 + value;
  const totalReturn = wealth - 1;
  const years = clean.length / barsPerYear;
  const cagr = years > 0 && wealth > 0 ? wealth ** (1 / years) - 1 : null;
  const std = sampleStd(clean);
  const avg = mean(clean);
  const sharpe = std > 0 ? avg / std * Math.sqrt(barsPerYear) : null;
  const positives = clean.filter((value) => value > 0);
  const negatives = clean.filter((value) => value < 0);
  const grossPositive = positives.reduce((sum, value) => sum + value, 0);
  const grossNegative = Math.abs(negatives.reduce((sum, value) => sum + value, 0));
  return Object.freeze({
    sampleCount: clean.length,
    totalReturn,
    cagr,
    annualizedSharpe: sharpe,
    maximumDrawdown: maxDrawdownFromReturns(clean),
    positiveBarRate: clean.length ? positives.length / clean.length : 0,
    barProfitFactor: grossNegative > 0 ? grossPositive / grossNegative : grossPositive > 0 ? null : 0,
    finalCapital: initialCapital * wealth,
  });
}


const DAY_MS = 24 * 60 * 60 * 1000;

export const PERFORMANCE_WINDOW_DEFINITIONS = Object.freeze({
  DAILY: Object.freeze({ label: "1d", durationMs: DAY_MS }),
  WEEKLY: Object.freeze({ label: "1w", durationMs: 7 * DAY_MS }),
  MONTHLY: Object.freeze({ label: "1m", durationMs: 30 * DAY_MS }),
  SIX_MONTH: Object.freeze({ label: "6m", durationMs: 182 * DAY_MS }),
  YEARLY: Object.freeze({ label: "1y", durationMs: 365 * DAY_MS }),
  THREE_YEAR: Object.freeze({
    label: "3y",
    durationMs: BENCHMARK_PERIOD.endTime - BENCHMARK_PERIOD.startTime,
  }),
});

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function aggregateObservationsToDaily(observations) {
  const byDay = new Map();
  for (const row of observations ?? []) {
    if (!Number.isInteger(row?.timestamp) || !Number.isFinite(row?.return) || row.return <= -1) continue;
    const day = Math.floor(row.timestamp / DAY_MS) * DAY_MS;
    const current = byDay.get(day) ?? 1;
    byDay.set(day, current * (1 + row.return));
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, wealth]) => Object.freeze({ timestamp, return: wealth - 1 }));
}

function compoundReturns(rows) {
  let wealth = 1;
  for (const row of rows) wealth *= 1 + row.return;
  return wealth - 1;
}

function rollingWindowReturns(dailyRows, durationMs) {
  if (!dailyRows.length) return [];
  if (durationMs <= DAY_MS) return dailyRows.map((row) => row.return);
  const results = [];
  let left = 0;
  for (let right = 0; right < dailyRows.length; right += 1) {
    const end = dailyRows[right].timestamp;
    const targetStart = end - durationMs + DAY_MS;
    while (left < right && dailyRows[left].timestamp < targetStart) left += 1;
    const observedSpan = end - dailyRows[left].timestamp + DAY_MS;
    const tolerance = durationMs <= 7 * DAY_MS ? 3 * DAY_MS : 7 * DAY_MS;
    if (observedSpan + tolerance < durationMs) continue;
    results.push(compoundReturns(dailyRows.slice(left, right + 1)));
  }
  return results;
}

function windowStats(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (!clean.length) {
    return Object.freeze({
      sampleCount: 0,
      latestReturn: null,
      averageReturn: null,
      medianReturn: null,
      positiveRate: null,
      bestReturn: null,
      worstReturn: null,
    });
  }
  return Object.freeze({
    sampleCount: clean.length,
    latestReturn: clean.at(-1),
    averageReturn: mean(clean),
    medianReturn: median(clean),
    positiveRate: clean.filter((value) => value > 0).length / clean.length,
    bestReturn: Math.max(...clean),
    worstReturn: Math.min(...clean),
  });
}

export function summarizePerformanceWindows(observations = []) {
  const dailyRows = aggregateObservationsToDaily(observations);
  const windows = {};
  for (const [key, definition] of Object.entries(PERFORMANCE_WINDOW_DEFINITIONS)) {
    if (key === "THREE_YEAR") {
      const observedSpan = dailyRows.length
        ? dailyRows.at(-1).timestamp - dailyRows[0].timestamp + DAY_MS
        : 0;
      const benchmarkSpan = BENCHMARK_PERIOD.endTime - BENCHMARK_PERIOD.startTime;
      const complete = observedSpan >= benchmarkSpan * 0.98;
      const value = complete ? compoundReturns(dailyRows) : null;
      windows[key] = Object.freeze({
        sampleCount: value == null ? 0 : 1,
        latestReturn: value,
        averageReturn: value,
        medianReturn: value,
        positiveRate: value == null ? null : value > 0 ? 1 : 0,
        bestReturn: value,
        worstReturn: value,
      });
      continue;
    }
    windows[key] = windowStats(rollingWindowReturns(dailyRows, definition.durationMs));
  }
  return Object.freeze({
    dailyObservationCount: dailyRows.length,
    windows: Object.freeze(windows),
  });
}

function intersectTimestamps(datasets) {
  if (!Array.isArray(datasets) || datasets.length < 2) return [];
  const maps = datasets.map(({ candles }) => new Map(candles.map((row) => [row.timestamp, row])));
  const first = [...maps[0].keys()].sort((a, b) => a - b);
  return first.filter((timestamp) => maps.every((map) => map.has(timestamp)));
}

function closesBySymbol(datasets) {
  return Object.fromEntries(datasets.map(({ symbol, candles }) => [
    symbol,
    new Map(candles.map((row) => [row.timestamp, row.close])),
  ]));
}

export function runEqualWeightBuyHoldBaseline({
  datasets,
  perSideCostBps = 10,
  barsPerYear,
  startTime = BENCHMARK_PERIOD.startTime,
  endTime = BENCHMARK_PERIOD.endTime,
} = {}) {
  if (!Array.isArray(datasets) || datasets.length < 1) throw new TypeError("at least one dataset is required");
  if (!(barsPerYear > 0)) throw new RangeError("barsPerYear must be positive");
  const timestamps = intersectTimestamps(datasets);
  const closeMaps = closesBySymbol(datasets);
  const symbols = datasets.map((item) => item.symbol);
  const startIndex = timestamps.findIndex((timestamp) => timestamp >= startTime);
  if (startIndex < 0) throw new Error("BUY_HOLD_START_NOT_AVAILABLE");
  let endIndex = timestamps.length - 1;
  while (endIndex >= 0 && timestamps[endIndex] > endTime) endIndex -= 1;
  if (endIndex <= startIndex) throw new Error("BUY_HOLD_END_NOT_AVAILABLE");

  const weight = 1 / symbols.length;
  const costRate = perSideCostBps / 10_000;
  const returns = [];
  const observations = [];
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const currentTimestamp = timestamps[index];
    const priorTimestamp = timestamps[index - 1];
    let barReturn = 0;
    for (const symbol of symbols) {
      const prior = closeMaps[symbol].get(priorTimestamp);
      const current = closeMaps[symbol].get(currentTimestamp);
      if (!(prior > 0 && current > 0)) continue;
      barReturn += weight * (current / prior - 1);
    }
    if (index === startIndex + 1) barReturn -= costRate;
    if (index === endIndex) barReturn -= costRate;
    returns.push(barReturn);
    observations.push(Object.freeze({ timestamp: currentTimestamp, return: barReturn }));
  }

  return Object.freeze({
    family: "EQUAL_WEIGHT_BUY_HOLD_BASELINE",
    sourceFaithfulReplication: true,
    fixedBasketBaseline: true,
    perSideCostBps,
    performance: summarizeReturnSeries(returns, { barsPerYear }),
    periodAnalysis: summarizePerformanceWindows(observations),
  });
}

export function runTimeSeriesMomentumProxy({
  datasets,
  lookbackBars,
  perSideCostBps = 10,
  longShort = false,
  barsPerYear,
  startTime = BENCHMARK_PERIOD.startTime,
  endTime = BENCHMARK_PERIOD.endTime,
} = {}) {
  if (!Array.isArray(datasets) || datasets.length < 1) throw new TypeError("at least one dataset is required");
  if (!Number.isSafeInteger(lookbackBars) || lookbackBars < 2) throw new RangeError("lookbackBars must be >= 2");
  if (!(barsPerYear > 0)) throw new RangeError("barsPerYear must be positive");
  const timestamps = intersectTimestamps(datasets);
  const closeMaps = closesBySymbol(datasets);
  const symbols = datasets.map((item) => item.symbol);
  const costRate = perSideCostBps / 10_000;
  const positions = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  const returns = [];
  const observations = [];

  for (let index = lookbackBars + 1; index < timestamps.length; index += 1) {
    const currentTimestamp = timestamps[index];
    const priorTimestamp = timestamps[index - 1];
    if (currentTimestamp < startTime) continue;
    if (currentTimestamp > endTime) break;
    const signalTimestamp = timestamps[index - 1];
    const lookbackTimestamp = timestamps[index - 1 - lookbackBars];
    let portfolioReturn = 0;

    for (const symbol of symbols) {
      const signalClose = closeMaps[symbol].get(signalTimestamp);
      const lookbackClose = closeMaps[symbol].get(lookbackTimestamp);
      const priorClose = closeMaps[symbol].get(priorTimestamp);
      const currentClose = closeMaps[symbol].get(currentTimestamp);
      if (!(signalClose > 0 && lookbackClose > 0 && priorClose > 0 && currentClose > 0)) continue;
      const momentum = signalClose / lookbackClose - 1;
      const nextPosition = momentum > 0 ? 1 : momentum < 0 && longShort ? -1 : 0;
      const turnover = Math.abs(nextPosition - positions[symbol]);
      const barReturn = nextPosition * (currentClose / priorClose - 1) - turnover * costRate;
      portfolioReturn += barReturn / symbols.length;
      positions[symbol] = nextPosition;
    }
    returns.push(portfolioReturn);
    observations.push(Object.freeze({ timestamp: currentTimestamp, return: portfolioReturn }));
  }

  return Object.freeze({
    family: "TSMOM_FIXED_PROXY",
    sourceFaithfulReplication: false,
    fixedHorizonAdaptation: true,
    longShort,
    lookbackBars,
    perSideCostBps,
    performance: summarizeReturnSeries(returns, { barsPerYear }),
    periodAnalysis: summarizePerformanceWindows(observations),
  });
}

export function runCrossSectionalMomentumProxy({
  datasets,
  lookbackBars,
  rebalanceBars,
  perSideCostBps = 10,
  longShort = false,
  volatilityManaged = false,
  volatilityLookbackBars = 20,
  targetAnnualVolatility = 0.15,
  barsPerYear,
  startTime = BENCHMARK_PERIOD.startTime,
  endTime = BENCHMARK_PERIOD.endTime,
} = {}) {
  if (!Array.isArray(datasets) || datasets.length < 2) throw new TypeError("at least two datasets are required");
  if (!Number.isSafeInteger(lookbackBars) || lookbackBars < 2) throw new RangeError("lookbackBars must be >= 2");
  if (!Number.isSafeInteger(rebalanceBars) || rebalanceBars < 1) throw new RangeError("rebalanceBars must be >= 1");
  if (!(barsPerYear > 0)) throw new RangeError("barsPerYear must be positive");
  const timestamps = intersectTimestamps(datasets);
  const closeMaps = closesBySymbol(datasets);
  const symbols = datasets.map((item) => item.symbol);
  const costRate = perSideCostBps / 10_000;
  const returns = [];
  const observations = [];
  let weights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  const portfolioReturnHistory = [];
  const firstEligibleIndex = timestamps.findIndex((timestamp, index) =>
    index >= lookbackBars + 1 && timestamp >= startTime);
  if (firstEligibleIndex < 0) {
    return Object.freeze({
      family: volatilityManaged ? "RISK_MANAGED_RELATIVE_MOMENTUM_PROXY" : "RELATIVE_MOMENTUM_PROXY",
      sourceFaithfulReplication: false,
      fixedBasketProxy: true,
      longShort,
      lookbackBars,
      rebalanceBars,
      perSideCostBps,
      performance: summarizeReturnSeries([], { barsPerYear }),
      periodAnalysis: summarizePerformanceWindows([]),
    });
  }

  for (let index = firstEligibleIndex; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    if (timestamp > endTime) break;
    const priorTimestamp = timestamps[index - 1];
    let turnover = 0;

    if ((index - firstEligibleIndex) % rebalanceBars === 0) {
      const signalTimestamp = timestamps[index - 1];
      const lookbackTimestamp = timestamps[index - 1 - lookbackBars];
      const ranked = symbols.map((symbol) => {
        const signalClose = closeMaps[symbol].get(signalTimestamp);
        const prior = closeMaps[symbol].get(lookbackTimestamp);
        return {
          symbol,
          momentum: signalClose > 0 && prior > 0
            ? signalClose / prior - 1
            : Number.NEGATIVE_INFINITY,
        };
      }).sort((a, b) => b.momentum - a.momentum || a.symbol.localeCompare(b.symbol));

      const next = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
      if (ranked.length > 0 && Number.isFinite(ranked[0].momentum)) next[ranked[0].symbol] = longShort ? 0.5 : 1;
      if (longShort && ranked.length > 1 && Number.isFinite(ranked.at(-1).momentum)) next[ranked.at(-1).symbol] = -0.5;

      if (volatilityManaged && portfolioReturnHistory.length >= volatilityLookbackBars) {
        const recent = portfolioReturnHistory.slice(-volatilityLookbackBars);
        const realizedBarVol = sampleStd(recent);
        const annualizedVol = realizedBarVol * Math.sqrt(barsPerYear);
        const scale = annualizedVol > 0 ? Math.min(1, targetAnnualVolatility / annualizedVol) : 1;
        for (const symbol of symbols) next[symbol] *= scale;
      }

      turnover = symbols.reduce((sum, symbol) => sum + Math.abs(next[symbol] - weights[symbol]), 0);
      weights = next;
    }

    let barReturn = 0;
    for (const symbol of symbols) {
      const previousClose = closeMaps[symbol].get(priorTimestamp);
      const currentClose = closeMaps[symbol].get(timestamp);
      if (!(previousClose > 0 && currentClose > 0)) continue;
      barReturn += weights[symbol] * (currentClose / previousClose - 1);
    }
    barReturn -= turnover * costRate;
    portfolioReturnHistory.push(barReturn);
    returns.push(barReturn);
    observations.push(Object.freeze({ timestamp, return: barReturn }));
  }

  return Object.freeze({
    family: volatilityManaged ? "RISK_MANAGED_RELATIVE_MOMENTUM_PROXY" : "RELATIVE_MOMENTUM_PROXY",
    sourceFaithfulReplication: false,
    fixedBasketProxy: true,
    longShort,
    lookbackBars,
    rebalanceBars,
    perSideCostBps,
    performance: summarizeReturnSeries(returns, { barsPerYear }),
    periodAnalysis: summarizePerformanceWindows(observations),
  });
}

export function runFundingCarryProxy({
  spotCandles,
  futuresCandles,
  fundingRecords,
  perSideCostBps = 10,
  trailingFundingDays = 7,
  startTime = BENCHMARK_PERIOD.startTime,
  endTime = BENCHMARK_PERIOD.endTime,
} = {}) {
  if (!Array.isArray(spotCandles) || !Array.isArray(futuresCandles) || !Array.isArray(fundingRecords)) {
    throw new TypeError("spotCandles, futuresCandles and fundingRecords must be arrays");
  }
  if (!Number.isSafeInteger(trailingFundingDays) || trailingFundingDays < 1) {
    throw new RangeError("trailingFundingDays must be >= 1");
  }
  const spotMap = new Map(spotCandles.map((row) => [row.timestamp, row.close]));
  const futuresMap = new Map(futuresCandles.map((row) => [row.timestamp, row.close]));
  const timestamps = [...spotMap.keys()].filter((timestamp) => futuresMap.has(timestamp)).sort((a, b) => a - b);
  const funding = fundingRecords
    .filter((row) => Number.isInteger(row?.timestamp) && Number.isFinite(row?.rate))
    .sort((a, b) => a.timestamp - b.timestamp);
  const costRate = perSideCostBps / 10_000;
  const returns = [];
  const observations = [];
  let active = 0;

  for (let index = 1; index < timestamps.length; index += 1) {
    const previousTimestamp = timestamps[index - 1];
    const currentTimestamp = timestamps[index];
    if (currentTimestamp < startTime) continue;
    if (currentTimestamp > endTime) break;
    const signalCutoff = previousTimestamp;
    const trailingStart = signalCutoff - trailingFundingDays * 24 * 60 * 60 * 1000;
    const trailingFunding = funding
      .filter((row) => row.timestamp > trailingStart && row.timestamp <= signalCutoff)
      .reduce((sum, row) => sum + row.rate, 0);
    const nextActive = trailingFunding > 0 ? 1 : 0;
    const turnover = Math.abs(nextActive - active);

    const spotPrevious = spotMap.get(previousTimestamp);
    const spotCurrent = spotMap.get(currentTimestamp);
    const futuresPrevious = futuresMap.get(previousTimestamp);
    const futuresCurrent = futuresMap.get(currentTimestamp);
    if (!(spotPrevious > 0 && spotCurrent > 0 && futuresPrevious > 0 && futuresCurrent > 0)) continue;

    const intervalFunding = funding
      .filter((row) => row.timestamp > previousTimestamp && row.timestamp <= currentTimestamp)
      .reduce((sum, row) => sum + row.rate, 0);

    const hedgedPriceReturn = nextActive * (
      0.5 * (spotCurrent / spotPrevious - 1)
      - 0.5 * (futuresCurrent / futuresPrevious - 1)
    );
    const fundingIncome = nextActive * 0.5 * intervalFunding;
    const transactionCost = turnover * costRate;
    const intervalReturn = hedgedPriceReturn + fundingIncome - transactionCost;
    returns.push(intervalReturn);
    observations.push(Object.freeze({ timestamp: currentTimestamp, return: intervalReturn }));
    active = nextActive;
  }

  return Object.freeze({
    family: "SAME_VENUE_FUNDING_CARRY_PROXY",
    sourceFaithfulReplication: false,
    crossVenueReplication: false,
    deltaNeutralTarget: true,
    trailingFundingDays,
    perSideCostBps,
    performance: summarizeReturnSeries(returns, { barsPerYear: 365 }),
    periodAnalysis: summarizePerformanceWindows(observations),
  });
}

export function barsPerYearForProfile(market, horizon) {
  if (horizon === "SHORT") {
    if (market === "KR_STOCK") return 252 * 6.5 * 4;
    if (market === "US_STOCK") return 252 * 6.5 * 4;
    return 365 * 24 * 4;
  }
  if (horizon === "SWING") {
    if (market === "KR_STOCK" || market === "US_STOCK") return 252 * 6.5;
    return 365 * 24;
  }
  return market === "KR_STOCK" || market === "US_STOCK" ? 252 : 365;
}

export function benchmarkSafetyEnvelope() {
  return Object.freeze({
    researchOnly: true,
    profitabilityProven: false,
    economicCreditGranted: false,
    paperCreditGranted: false,
    automaticActivationAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
}

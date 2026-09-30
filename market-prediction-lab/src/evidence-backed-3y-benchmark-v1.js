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

export function runTimeSeriesMomentumProxy({
  datasets,
  lookbackBars,
  perSideCostBps = 10,
  longShort = false,
  barsPerYear,
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

  for (let index = lookbackBars + 1; index < timestamps.length; index += 1) {
    const currentTimestamp = timestamps[index];
    const priorTimestamp = timestamps[index - 1];
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
  }

  return Object.freeze({
    family: "TSMOM_FIXED_PROXY",
    sourceFaithfulReplication: false,
    fixedHorizonAdaptation: true,
    longShort,
    lookbackBars,
    perSideCostBps,
    performance: summarizeReturnSeries(returns, { barsPerYear }),
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
  let weights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  const portfolioReturnHistory = [];

  for (let index = lookbackBars + 1; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    const priorTimestamp = timestamps[index - 1];
    let turnover = 0;

    if ((index - (lookbackBars + 1)) % rebalanceBars === 0) {
      const lookbackTimestamp = timestamps[index - lookbackBars];
      const ranked = symbols.map((symbol) => {
        const now = closeMaps[symbol].get(timestamp);
        const prior = closeMaps[symbol].get(lookbackTimestamp);
        return { symbol, momentum: now > 0 && prior > 0 ? now / prior - 1 : Number.NEGATIVE_INFINITY };
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

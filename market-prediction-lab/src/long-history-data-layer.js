import { createHash } from "node:crypto";

export const LONG_HISTORY_DATASET_SCHEMA_VERSION = 1;
export const SCANNER_BACKTEST_QUALITY_SCHEMA_VERSION = 1;
export const BACKTEST_QUALITY_STATUSES = Object.freeze([
  "verified",
  "partial",
  "insufficient_history",
  "missing",
  "blocked_provider",
  "failed_validation",
]);

const MARKET_SET = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const QUALITY_SET = new Set(BACKTEST_QUALITY_STATUSES);

function assertFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer timestamp`);
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function datasetDigest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizeCandle({ market, symbol, timeframe, source, candle, index, generatedAt }) {
  if (!candle || typeof candle !== "object") throw new TypeError(`candles[${index}] must be an object`);
  const timestamp = assertTimestamp(candle.timestamp, `candles[${index}].timestamp`);
  if (timestamp > generatedAt) throw new Error(`FUTURE_CANDLE:${timestamp}`);
  if (candle.isClosed !== true) throw new Error(`OPEN_CANDLE:${timestamp}`);
  const open = assertFinite(candle.open, `candles[${index}].open`);
  const high = assertFinite(candle.high, `candles[${index}].high`);
  const low = assertFinite(candle.low, `candles[${index}].low`);
  const close = assertFinite(candle.close, `candles[${index}].close`);
  const volume = assertFinite(candle.volume ?? 0, `candles[${index}].volume`);
  if ([open, high, low, close].some((value) => value <= 0)) throw new Error(`NON_POSITIVE_OHLC:${timestamp}`);
  if (volume < 0) throw new Error(`NEGATIVE_VOLUME:${timestamp}`);
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) throw new Error(`INVALID_OHLC:${timestamp}`);
  const observedAt = assertTimestamp(candle.observedAt ?? timestamp, `candles[${index}].observedAt`);
  if (observedAt > generatedAt) throw new Error(`FUTURE_OBSERVATION:${observedAt}`);
  return Object.freeze({ market, symbol, timeframe, timestamp, open, high, low, close, volume, isClosed: true, source, observedAt });
}

function continuousMissingIntervals(candles, intervalMs) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || candles.length < 2) return Object.freeze([]);
  const gaps = [];
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1].timestamp;
    const current = candles[index].timestamp;
    if (current - previous <= intervalMs) continue;
    const missingCount = Math.max(0, Math.round((current - previous) / intervalMs) - 1);
    if (missingCount > 0) gaps.push(Object.freeze({ after: previous, before: current, missingCount }));
  }
  return Object.freeze(gaps);
}

export function buildHistoricalDataset(input) {
  if (!MARKET_SET.has(input?.market)) throw new TypeError(`unsupported market: ${input?.market}`);
  if (typeof input.symbol !== "string" || !input.symbol.trim()) throw new TypeError("symbol is required");
  if (typeof input.timeframe !== "string" || !input.timeframe.trim()) throw new TypeError("timeframe is required");
  if (typeof input.source !== "string" || !input.source.trim()) throw new TypeError("source is required");
  if (typeof input.provider !== "string" || !input.provider.trim()) throw new TypeError("provider is required");
  const requestedStart = assertTimestamp(input.requestedStart, "requestedStart");
  const requestedEnd = assertTimestamp(input.requestedEnd, "requestedEnd");
  const generatedAt = assertTimestamp(input.generatedAt, "generatedAt");
  if (requestedEnd < requestedStart) throw new RangeError("requestedEnd must be >= requestedStart");
  if (!Array.isArray(input.candles)) throw new TypeError("candles must be an array");

  let duplicateCount = 0;
  const seen = new Set();
  let previousTimestamp = null;
  for (let index = 0; index < input.candles.length; index += 1) {
    const timestamp = assertTimestamp(input.candles[index]?.timestamp, `candles[${index}].timestamp`);
    if (seen.has(timestamp)) duplicateCount += 1;
    seen.add(timestamp);
    if (previousTimestamp != null && timestamp < previousTimestamp) throw new Error(`REVERSED_CANDLE_ORDER:${timestamp}`);
    previousTimestamp = timestamp;
  }
  if (duplicateCount > 0) throw new Error(`DUPLICATE_CANDLE:${duplicateCount}`);

  const candles = Object.freeze(input.candles.map((candle, index) => normalizeCandle({
    market: input.market,
    symbol: input.symbol,
    timeframe: input.timeframe,
    source: input.source,
    candle,
    index,
    generatedAt,
  })));
  const actualStart = candles[0]?.timestamp ?? null;
  const actualEnd = candles.at(-1)?.timestamp ?? null;
  const missingIntervals = continuousMissingIntervals(candles, input.expectedIntervalMs);
  const expectedCount = Number.isSafeInteger(input.expectedIntervalMs) && input.expectedIntervalMs > 0
    ? Math.floor((requestedEnd - requestedStart) / input.expectedIntervalMs) + 1
    : null;
  const coverageRatio = expectedCount && expectedCount > 0 ? Math.min(1, candles.length / expectedCount) : null;
  const reachesStart = actualStart != null && (input.expectedIntervalMs ? actualStart <= requestedStart + input.expectedIntervalMs : actualStart <= requestedStart);
  const reachesEnd = actualEnd != null && (input.expectedIntervalMs ? actualEnd >= requestedEnd - input.expectedIntervalMs : actualEnd >= requestedEnd);
  const dataQuality = candles.length === 0
    ? "missing"
    : missingIntervals.length > 0 || !reachesStart || !reachesEnd
      ? "partial"
      : "verified";
  const digestPayload = { market: input.market, symbol: input.symbol, timeframe: input.timeframe, provider: input.provider, providerVersion: input.providerVersion ?? null, adjustmentMode: input.adjustmentMode ?? "none", candles };
  const dataset = {
    schemaVersion: LONG_HISTORY_DATASET_SCHEMA_VERSION,
    market: input.market,
    symbol: input.symbol,
    timeframe: input.timeframe,
    candles,
    requestedStart,
    requestedEnd,
    actualStart,
    actualEnd,
    coverageRatio,
    missingIntervals,
    duplicateCount: 0,
    dataQuality,
    provider: input.provider,
    providerVersion: input.providerVersion ?? null,
    source: input.source,
    adjustmentMode: input.adjustmentMode ?? "none",
    corporateActions: input.corporateActions ?? (input.market.endsWith("STOCK") ? "unverified" : "not_applicable"),
    survivorshipSafeguard: input.survivorshipSafeguard ?? (input.market.endsWith("STOCK") ? "unverified" : "not_applicable"),
    generatedAt,
    datasetDigest: datasetDigest(digestPayload),
  };
  return Object.freeze(dataset);
}

export function assertDatasetDigest(dataset) {
  const expected = datasetDigest({
    market: dataset.market,
    symbol: dataset.symbol,
    timeframe: dataset.timeframe,
    provider: dataset.provider,
    providerVersion: dataset.providerVersion ?? null,
    adjustmentMode: dataset.adjustmentMode ?? "none",
    candles: dataset.candles,
  });
  if (expected !== dataset.datasetDigest) throw new Error("CORRUPTED_DATASET_DIGEST");
  return true;
}

function metricsOrNull(value) {
  if (!value || typeof value !== "object") return null;
  return Object.freeze({
    trades: Number.isFinite(value.tradeCount) ? value.tradeCount : null,
    winRate: Number.isFinite(value.winRate) ? value.winRate : null,
    expectancy: Number.isFinite(value.expectancy) ? value.expectancy : null,
    profitFactor: Number.isFinite(value.profitFactor) ? value.profitFactor : value.profitFactor === null ? null : null,
    maximumDrawdown: Number.isFinite(value.maximumDrawdown) ? value.maximumDrawdown : null,
    netReturn: Number.isFinite(value.totalReturn) ? value.totalReturn : null,
    sharpe: Number.isFinite(value.sharpe) ? value.sharpe : null,
    costImpact: Number.isFinite(value.costImpact) ? value.costImpact : null,
  });
}

function ratioToPercent(value) {
  return Number.isFinite(value) ? value * 100 : null;
}

function negativeDrawdownPercent(value) {
  return Number.isFinite(value) ? -Math.abs(value * 100) : null;
}

function expectancyPercent(value, initialCapital) {
  if (!Number.isFinite(value) || !Number.isFinite(initialCapital) || initialCapital <= 0) return null;
  return value / initialCapital * 100;
}

export function classifyBacktestQuality({ dataset, oosMetrics, walkForward, holdout, costModel, lookaheadSafe, survivorshipSafeguard }) {
  const reasons = [];
  if (!dataset) reasons.push("missing_dataset");
  else {
    try { assertDatasetDigest(dataset); } catch { reasons.push("corrupted_dataset"); }
    if (dataset.dataQuality === "missing") reasons.push("missing_history");
    if (dataset.dataQuality === "partial") reasons.push("partial_coverage");
  }
  if (!oosMetrics || !Number.isFinite(oosMetrics.tradeCount)) reasons.push("missing_oos");
  if (!walkForward || !Array.isArray(walkForward.windows) || walkForward.windows.length === 0) reasons.push("missing_walk_forward");
  if (walkForward?.windows?.some((window) => window.leakFree !== true)) reasons.push("walk_forward_leak_risk");
  if (!costModel || costModel.fee !== true || costModel.spread !== true || costModel.slippage !== true) reasons.push("incomplete_cost_model");
  if (lookaheadSafe !== true) reasons.push("lookahead_not_verified");
  if (dataset?.market?.endsWith("STOCK") && !["verified", "partial"].includes(survivorshipSafeguard ?? dataset.survivorshipSafeguard)) reasons.push("survivorship_not_verified");
  if (!holdout || holdout.status !== "evaluated") reasons.push("holdout_not_evaluated");

  let status = "verified";
  if (reasons.includes("corrupted_dataset") || reasons.includes("lookahead_not_verified") || reasons.includes("walk_forward_leak_risk")) status = "failed_validation";
  else if (reasons.includes("missing_dataset") || reasons.includes("missing_history")) status = "missing";
  else if (reasons.includes("missing_oos") || reasons.includes("missing_walk_forward")) status = "insufficient_history";
  else if (reasons.length > 0) status = "partial";
  return Object.freeze({ status, reasons: Object.freeze(reasons) });
}

export function buildScannerBacktestQualityRow(input) {
  if (!MARKET_SET.has(input?.market)) throw new TypeError(`unsupported market: ${input?.market}`);
  if (!QUALITY_SET.has(input.backtestQuality)) throw new TypeError(`unsupported backtestQuality: ${input.backtestQuality}`);
  if (!/^[0-9a-f]{40}$/i.test(input.researchCodeSha ?? "")) throw new TypeError("researchCodeSha must be an immutable 40-character SHA");
  const oosWinRate = ratioToPercent(input.oos?.winRate);
  const walkForwardWinRate = ratioToPercent(input.walkForward?.winRate);
  const expectancyPercentValue = expectancyPercent(input.oos?.expectancy, input.initialCapital);
  const maxDrawdownPercent = negativeDrawdownPercent(input.oos?.maximumDrawdown);
  const netReturnPercent = ratioToPercent(input.oos?.totalReturn);
  return Object.freeze({
    market: input.market,
    symbol: input.symbol,
    strategyType: input.strategyType,
    direction: input.direction,
    strategyVersion: input.strategyVersion,
    timeframe: input.timeframe,
    backtestQuality: input.backtestQuality,
    reasons: Object.freeze([...(input.reasons ?? [])]),
    development: metricsOrNull(input.development),
    oos: metricsOrNull(input.oos),
    walkForward: input.walkForward ?? null,
    holdout: input.holdout ?? null,
    // Scanner-compatible normalized fields. Rates are percentage points (0..100),
    // drawdown is negative percentage, and expectancyPercent is per-trade net PnL
    // divided by the fixed research initial capital. Raw research metrics remain above.
    oosWinRate,
    walkForwardWinRate,
    expectancy: Number.isFinite(input.oos?.expectancy) ? input.oos.expectancy : null,
    expectancyPercent: expectancyPercentValue,
    profitFactor: Number.isFinite(input.oos?.profitFactor) ? input.oos.profitFactor : null,
    maximumDrawdown: Number.isFinite(input.oos?.maximumDrawdown) ? input.oos.maximumDrawdown : null,
    maxDrawdownPercent,
    netReturnPercent,
    tradeCount: Number.isFinite(input.oos?.tradeCount) ? input.oos.tradeCount : null,
    walkForwardStability: Number.isFinite(input.walkForward?.stabilityScore) ? input.walkForward.stabilityScore : null,
    oosStabilityScore: Number.isFinite(input.walkForward?.stabilityScore) ? input.walkForward.stabilityScore : null,
    regimePerformance: input.regimePerformance ?? null,
    regimeScore: Number.isFinite(input.regimeScore) ? input.regimeScore : null,
    confidence: input.confidence ?? null,
    minimumTradeCount: Number.isFinite(input.minimumTradeCount) ? input.minimumTradeCount : null,
    costsIncluded: input.costModel?.fee === true && input.costModel?.spread === true,
    slippageIncluded: input.costModel?.slippage === true,
    lookaheadGuarded: input.lookaheadSafe === true,
    survivorshipGuarded: input.dataset?.market?.endsWith("STOCK")
      ? input.dataset?.survivorshipSafeguard === "verified"
      : true,
    oosAvailable: input.oos != null,
    walkForwardAvailable: Array.isArray(input.walkForward?.windows) && input.walkForward.windows.length > 0,
    researchStatus: input.researchStatus,
    metricUnits: Object.freeze({
      oosWinRate: "percent_0_100",
      walkForwardWinRate: "percent_0_100",
      expectancy: "research_currency_per_trade",
      expectancyPercent: "percent_of_initial_capital_per_trade",
      maximumDrawdown: "ratio_0_1",
      maxDrawdownPercent: "negative_percent",
      netReturnPercent: "percent",
    }),
    dataQuality: Object.freeze({
      requestedStart: input.dataset?.requestedStart ?? null,
      requestedEnd: input.dataset?.requestedEnd ?? null,
      actualStart: input.dataset?.actualStart ?? null,
      actualEnd: input.dataset?.actualEnd ?? null,
      coverage: input.dataset?.dataQuality ?? "missing",
      coverageRatio: input.dataset?.coverageRatio ?? null,
      survivorshipSafeguard: input.dataset?.survivorshipSafeguard ?? null,
      lookaheadSafe: input.lookaheadSafe === true,
    }),
    dataStart: input.dataset?.actualStart ?? null,
    dataEnd: input.dataset?.actualEnd ?? null,
    datasetDigest: input.dataset?.datasetDigest ?? null,
    researchCodeSha: input.researchCodeSha,
    generatedAt: input.generatedAt,
  });
}

export function buildScannerBacktestQualityArtifact({ researchCodeSha, generatedAt, rows, blocked = [] }) {
  if (!/^[0-9a-f]{40}$/i.test(researchCodeSha ?? "")) throw new TypeError("researchCodeSha must be an immutable 40-character SHA");
  const artifact = {
    schema: "scanner-backtest-quality-v1",
    schemaVersion: SCANNER_BACKTEST_QUALITY_SCHEMA_VERSION,
    researchCodeSha,
    generatedAt,
    rows: Object.freeze([...(rows ?? [])]),
    blocked: Object.freeze([...(blocked ?? [])]),
    realHistoricalDataOnly: true,
    syntheticMetricsAllowed: false,
    liveOrderAllowed: false,
    privateApiAllowed: false,
    orderSubmitted: false,
  };
  return Object.freeze({ ...artifact, artifactDigest: datasetDigest(artifact) });
}

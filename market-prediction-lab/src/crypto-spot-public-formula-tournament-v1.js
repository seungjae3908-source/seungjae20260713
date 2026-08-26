import { BITGET_TIMEFRAME_MS, collectBitgetCandles } from "./bitget-candle-collector.js";
import {
  buildEvidenceBackedFormulaExecutionParametersV1,
  createEvidenceBackedFormulaSignalEvaluatorV1,
} from "./evidence-backed-formula-entry-evaluator-v1.js";
import { runEvidenceBackedFormulaTournamentAdapterV1 } from "./evidence-backed-formula-tournament-adapter-v1.js";
import { RESEARCH_BACKTEST_PERIOD } from "./multi-market-backtest-engine.js";
import { normalizeResearchSymbol } from "./research-governance.js";
import { runOnePassCandidateBacktestV1 } from "./research-tournament-engine-v1.js";
import { researchDigest } from "./research-trial-registry.js";

export const CRYPTO_SPOT_PUBLIC_FORMULA_TOURNAMENT_VERSION = 1;
export const CRYPTO_SPOT_PUBLIC_FORMULA_TOURNAMENT_CONTRACT = "crypto-spot-public-formula-tournament/v1";

const SUPPORTED_TIMEFRAMES = new Set(["15m", "1h", "1d"]);
const BITGET_SPOT_RESEARCH_QUOTES = Object.freeze(["USDT", "BTC"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INITIAL_CAPITAL = RESEARCH_BACKTEST_PERIOD.initialCapital;
const DEFAULT_MINIMUM_PARTITION_CANDLES = 120;
const BASE_COST_MODEL = Object.freeze({
  entryFeeRate: 0.001,
  exitFeeRate: 0.001,
  taxRate: 0,
  slippageRate: 0.0002,
  spreadRate: 0.0002,
  latencyBars: 0,
  latencyDriftRate: 0,
});
const COST_STRESS_MULTIPLIERS = Object.freeze({
  BASE_COST: 1,
  MODERATE_STRESS: 1.5,
  HIGH_STRESS: 2,
});
const BASE_LIQUIDITY_IMPACT_RATE = 0.0002;
const REGIME_LOOKBACK_BARS = 20;
const REGIME_MIN_SAMPLE = 1;

export class CryptoSpotPublicFormulaTournamentError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "CryptoSpotPublicFormulaTournamentError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, details = {}) {
  throw new CryptoSpotPublicFormulaTournamentError(code, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function finite(value, code, details = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(code, { ...details, value });
  return value;
}

function positiveInteger(value, code, details = {}) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, { ...details, value });
  return value;
}

function requiredText(value, code) {
  if (typeof value !== "string" || !value.trim()) fail(code, { value });
  return value.trim();
}

function bitgetSpotSymbolToResearchSymbol(symbol) {
  const raw = requiredText(symbol, "CRYPTO_SPOT_SYMBOL_REQUIRED").toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(raw)) {
    fail("CRYPTO_SPOT_BITGET_SYMBOL_INVALID", { symbol: raw });
  }
  const quote = BITGET_SPOT_RESEARCH_QUOTES.find((candidate) => raw.endsWith(candidate) && raw.length > candidate.length);
  if (!quote) {
    fail("CRYPTO_SPOT_BITGET_QUOTE_UNSUPPORTED", { symbol: raw, supportedQuotes: BITGET_SPOT_RESEARCH_QUOTES });
  }
  const base = raw.slice(0, -quote.length);
  try {
    return normalizeResearchSymbol("CRYPTO_SPOT", `${quote}-${base}`);
  } catch (error) {
    fail("CRYPTO_SPOT_BITGET_SYMBOL_TO_RESEARCH_UNSUPPORTED", {
      symbol: raw,
      quote,
      base,
      cause: error?.code ?? error?.name ?? "UNKNOWN",
    });
  }
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1));
}

function timeframeMs(timeframe) {
  if (!SUPPORTED_TIMEFRAMES.has(timeframe) || !Number.isSafeInteger(BITGET_TIMEFRAME_MS[timeframe])) {
    fail("CRYPTO_SPOT_FORMULA_TIMEFRAME_UNSUPPORTED", { timeframe });
  }
  return BITGET_TIMEFRAME_MS[timeframe];
}

function datasetFingerprint(candles) {
  return researchDigest(candles.map((candle) => [
    candle.timestamp,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
  ]));
}

function datasetIdentity(kind, core) {
  return `crypto-spot-public:${kind}:sha256:${researchDigest(core)}`;
}

function validateCandleSequence(candles, intervalMs) {
  if (!Array.isArray(candles) || candles.length === 0) fail("CRYPTO_SPOT_CANDLES_REQUIRED");
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!Number.isSafeInteger(candle?.timestamp) || candle.timestamp <= 0) fail("CRYPTO_SPOT_CANDLE_TIMESTAMP_INVALID", { index });
    for (const field of ["open", "high", "low", "close", "volume"]) finite(candle[field], "CRYPTO_SPOT_CANDLE_NON_FINITE", { index, field });
    if (!(candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0) || candle.volume < 0) {
      fail("CRYPTO_SPOT_CANDLE_VALUE_INVALID", { index });
    }
    if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.high < candle.low) {
      fail("CRYPTO_SPOT_CANDLE_OHLC_INVALID", { index });
    }
    if (index > 0) {
      const delta = candle.timestamp - candles[index - 1].timestamp;
      if (delta !== intervalMs) fail("CRYPTO_SPOT_CANDLE_GAP_OR_DUPLICATE", { index, delta, expected: intervalMs });
    }
  }
}

function periodFromCandles(candles) {
  if (!candles.length) fail("CRYPTO_SPOT_PERIOD_CANDLES_REQUIRED");
  return Object.freeze({ startTime: candles[0].timestamp, endTime: candles.at(-1).timestamp });
}

function datasetSummary(dataset) {
  return deepFreeze({
    schemaVersion: dataset.schemaVersion,
    contract: dataset.contract,
    provider: dataset.provider,
    symbol: dataset.symbol,
    researchSymbol: dataset.researchSymbol,
    market: dataset.market,
    timeframe: dataset.timeframe,
    requestedStartTime: dataset.requestedStartTime,
    requestedEndTime: dataset.requestedEndTime,
    collectedAt: dataset.collectedAt,
    candleCount: dataset.candles.length,
    trainCandleCount: dataset.trainCandles.length,
    oosCandleCount: dataset.oosCandles.length,
    datasetIdentity: dataset.datasetIdentity,
    oosDatasetIdentity: dataset.oosDatasetIdentity,
    fingerprint: dataset.fingerprint,
    trainPeriod: dataset.trainPeriod,
    oosPeriod: dataset.oosPeriod,
    finalHoldoutExcluded: true,
    openCandleExcluded: true,
    exactTimeframeRequired: true,
    executionAuthority: "NONE",
  });
}

export function prepareCryptoSpotPublicFormulaTournamentDatasetV1({
  collected,
  requestedStartTime,
  requestedEndTime,
  minimumPartitionCandles = DEFAULT_MINIMUM_PARTITION_CANDLES,
} = {}) {
  if (!collected || typeof collected !== "object") fail("CRYPTO_SPOT_COLLECTION_REQUIRED");
  if (collected.provider !== "bitget-public-v2" || collected.market !== "CRYPTO_SPOT") {
    fail("CRYPTO_SPOT_PUBLIC_PROVIDER_CONTRACT_INVALID", { provider: collected.provider, market: collected.market });
  }
  const symbol = requiredText(collected.symbol, "CRYPTO_SPOT_SYMBOL_REQUIRED").toUpperCase();
  const researchSymbol = bitgetSpotSymbolToResearchSymbol(symbol);
  const timeframe = requiredText(collected.timeframe, "CRYPTO_SPOT_TIMEFRAME_REQUIRED");
  const intervalMs = timeframeMs(timeframe);
  positiveInteger(requestedStartTime, "CRYPTO_SPOT_START_TIME_INVALID");
  positiveInteger(requestedEndTime, "CRYPTO_SPOT_END_TIME_INVALID");
  if (requestedStartTime >= requestedEndTime) fail("CRYPTO_SPOT_PERIOD_INVALID");
  if (requestedStartTime < RESEARCH_BACKTEST_PERIOD.startTime) {
    fail("CRYPTO_SPOT_PREDECLARED_RESEARCH_START_VIOLATION", { requestedStartTime, minimum: RESEARCH_BACKTEST_PERIOD.startTime });
  }
  if (requestedEndTime > RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime) {
    fail("CRYPTO_SPOT_FINAL_HOLDOUT_PREACCESS_FORBIDDEN", { requestedEndTime, maximum: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime });
  }
  positiveInteger(minimumPartitionCandles, "CRYPTO_SPOT_MINIMUM_PARTITION_INVALID");
  const candles = [...(collected.candles ?? [])];
  validateCandleSequence(candles, intervalMs);
  if (candles[0].timestamp < requestedStartTime || candles.at(-1).timestamp >= requestedEndTime) {
    fail("CRYPTO_SPOT_COLLECTION_BOUNDARY_INVALID", {
      first: candles[0].timestamp,
      last: candles.at(-1).timestamp,
      requestedStartTime,
      requestedEndTime,
    });
  }

  const trainCandles = candles.filter((candle) => candle.timestamp <= RESEARCH_BACKTEST_PERIOD.developmentEndTime);
  const oosCandles = candles.filter((candle) => candle.timestamp >= RESEARCH_BACKTEST_PERIOD.validationStartTime
    && candle.timestamp <= RESEARCH_BACKTEST_PERIOD.validationEndTime);
  if (trainCandles.length < minimumPartitionCandles) {
    fail("CRYPTO_SPOT_DEVELOPMENT_PARTITION_INSUFFICIENT", { observed: trainCandles.length, required: minimumPartitionCandles });
  }
  if (oosCandles.length < minimumPartitionCandles) {
    fail("CRYPTO_SPOT_OOS_PARTITION_INSUFFICIENT", { observed: oosCandles.length, required: minimumPartitionCandles });
  }
  if (trainCandles.at(-1).timestamp >= oosCandles[0].timestamp) fail("CRYPTO_SPOT_TRAIN_OOS_OVERLAP");

  const fingerprint = datasetFingerprint(candles);
  const trainFingerprint = datasetFingerprint(trainCandles);
  const oosFingerprint = datasetFingerprint(oosCandles);
  const commonIdentity = Object.freeze({
    provider: collected.provider,
    market: "CRYPTO_SPOT",
    symbol,
    researchSymbol,
    timeframe,
    requestedStartTime,
    requestedEndTime,
  });
  const trainIdentity = datasetIdentity("train", { ...commonIdentity, fingerprint: trainFingerprint });
  const oosIdentity = datasetIdentity("oos", { ...commonIdentity, fingerprint: oosFingerprint });
  return deepFreeze({
    schemaVersion: CRYPTO_SPOT_PUBLIC_FORMULA_TOURNAMENT_VERSION,
    contract: CRYPTO_SPOT_PUBLIC_FORMULA_TOURNAMENT_CONTRACT,
    provider: collected.provider,
    collectedAt: positiveInteger(collected.collectedAt, "CRYPTO_SPOT_COLLECTED_AT_INVALID"),
    market: "CRYPTO_SPOT",
    symbol,
    researchSymbol,
    timeframe,
    intervalMs,
    requestedStartTime,
    requestedEndTime,
    fingerprint,
    datasetIdentity: trainIdentity,
    oosDatasetIdentity: oosIdentity,
    candles,
    trainCandles,
    oosCandles,
    trainPeriod: periodFromCandles(trainCandles),
    oosPeriod: periodFromCandles(oosCandles),
    availableFields: ["symbol", "open", "high", "low", "close", "volume"],
    finalHoldoutExcluded: true,
    openCandleExcluded: true,
    exactTimeframeRequired: true,
    safety: {
      researchOnly: true,
      profitabilityClaimAllowed: false,
      championPromotionAllowed: false,
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      executionAuthority: "NONE",
    },
  });
}

export async function collectCryptoSpotPublicFormulaTournamentDatasetV1({
  client,
  symbol,
  timeframe,
  startTime,
  endTime,
  maxCandles = 250_000,
  minimumPartitionCandles = DEFAULT_MINIMUM_PARTITION_CANDLES,
  onPage,
} = {}) {
  timeframeMs(timeframe);
  if (!Number.isSafeInteger(endTime)) fail("CRYPTO_SPOT_EXPLICIT_END_TIME_REQUIRED");
  if (endTime > RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime) fail("CRYPTO_SPOT_FINAL_HOLDOUT_PREACCESS_FORBIDDEN");
  const collected = await collectBitgetCandles({
    client,
    market: "CRYPTO_SPOT",
    symbol,
    timeframe,
    startTime,
    endTime,
    maxCandles,
    onPage,
  });
  return prepareCryptoSpotPublicFormulaTournamentDatasetV1({
    collected,
    requestedStartTime: startTime,
    requestedEndTime: endTime,
    minimumPartitionCandles,
  });
}

function rollingRegime(candles, index) {
  if (index < REGIME_LOOKBACK_BARS) return null;
  const start = index - REGIME_LOOKBACK_BARS;
  const returns = [];
  for (let cursor = start + 1; cursor <= index; cursor += 1) {
    returns.push((candles[cursor].close / candles[cursor - 1].close) - 1);
  }
  const cumulativeReturn = (candles[index].close / candles[start].close) - 1;
  const volatility = sampleStd(returns);
  const threshold = Math.max(0.0025, volatility * Math.sqrt(REGIME_LOOKBACK_BARS) * 0.5);
  return cumulativeReturn > threshold ? "BULL" : cumulativeReturn < -threshold ? "BEAR" : "SIDEWAYS";
}

function candleIndexByTimestamp(candles) {
  return new Map(candles.map((candle, index) => [candle.timestamp, index]));
}

function tradeRegimeCounts(trades, candles) {
  const indexes = candleIndexByTimestamp(candles);
  const counts = { BULL: 0, BEAR: 0, SIDEWAYS: 0 };
  for (const trade of trades) {
    const index = indexes.get(trade.signalTime);
    const regime = Number.isSafeInteger(index) ? rollingRegime(candles, index) : null;
    if (regime) counts[regime] += 1;
  }
  return Object.freeze(counts);
}

function independentPeriodCount(trades, timeframe) {
  const bucketMs = Math.max(7 * DAY_MS, 30 * timeframeMs(timeframe));
  return new Set(trades.map((trade) => Math.floor(trade.signalTime / bucketMs))).size;
}

function sampleEvidence(backtest, dataset) {
  return Object.freeze({
    tradeCount: backtest.trades.length,
    independentPeriods: independentPeriodCount(backtest.trades, dataset.timeframe),
    regimeCounts: tradeRegimeCounts(backtest.trades, dataset.candles),
  });
}

function stressedCostModel(multiplier) {
  finite(multiplier, "CRYPTO_SPOT_COST_MULTIPLIER_INVALID");
  if (!(multiplier >= 1)) fail("CRYPTO_SPOT_COST_MULTIPLIER_INVALID", { multiplier });
  return Object.freeze({
    entryFeeRate: BASE_COST_MODEL.entryFeeRate * multiplier,
    exitFeeRate: BASE_COST_MODEL.exitFeeRate * multiplier,
    taxRate: 0,
    slippageRate: BASE_COST_MODEL.slippageRate * multiplier,
    spreadRate: BASE_COST_MODEL.spreadRate * multiplier,
    latencyBars: 0,
    latencyDriftRate: 0,
  });
}

function backtestCandidate({ formulaCandidate, generatedCandidate, dataset, period, datasetIdentity: identity, costMultiplier = 1 }) {
  const executionParameters = buildEvidenceBackedFormulaExecutionParametersV1({ formulaCandidate, generatedCandidate });
  const { signalEvaluator, evaluatorContract } = createEvidenceBackedFormulaSignalEvaluatorV1({ formulaCandidate, generatedCandidate });
  return runOnePassCandidateBacktestV1({
    formulaCandidate,
    generatedCandidate,
    datasetIdentity: identity,
    backtestInput: {
      market: "CRYPTO_SPOT",
      symbol: dataset.researchSymbol,
      timeframe: dataset.timeframe,
      side: "long",
      candles: dataset.candles,
      initialCapital: DEFAULT_INITIAL_CAPITAL,
      riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
      costModel: stressedCostModel(costMultiplier),
      fundingRates: [],
    },
    executionParameters,
    signalEvaluator,
    evaluatorContract,
    period: { ...period, includeFinalHoldout: false },
    liquidityImpactEvidence: null,
  });
}

function maximumEntryLookbackBars(formulaCandidate, generatedCandidate) {
  let maximum = 1;
  const selected = generatedCandidate.selectedParameters;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.kind === "INDICATOR" && typeof node.parameters?.period === "string") {
      const value = selected[node.parameters.period];
      if (Number.isSafeInteger(value) && value > maximum) maximum = value;
    }
    if (Array.isArray(node)) node.forEach(visit);
    else Object.values(node).forEach(visit);
  };
  visit(formulaCandidate.entryDsl);
  return maximum;
}

function buildWalkForwardPeriods(dataset, requestedWindows = 3) {
  const windows = Math.max(3, Math.min(6, requestedWindows));
  const oos = dataset.oosCandles;
  const segmentCount = windows * 2;
  const segmentSize = Math.floor(oos.length / segmentCount);
  if (segmentSize < 20) return [];
  const result = [];
  for (let index = 0; index < windows; index += 1) {
    const validationStart = index * segmentSize * 2;
    const validationEnd = validationStart + segmentSize - 1;
    const oosStart = validationEnd + 1;
    const oosEnd = index === windows - 1 ? oos.length - 1 : oosStart + segmentSize - 1;
    const validationCandles = oos.slice(validationStart, validationEnd + 1);
    const testCandles = oos.slice(oosStart, oosEnd + 1);
    if (!validationCandles.length || !testCandles.length) return [];
    const trainEndTime = validationCandles[0].timestamp - dataset.intervalMs;
    if (trainEndTime <= dataset.trainPeriod.startTime) return [];
    result.push(Object.freeze({
      trainPeriod: Object.freeze({ startTime: dataset.trainPeriod.startTime, endTime: trainEndTime }),
      validationPeriod: periodFromCandles(validationCandles),
      oosPeriod: periodFromCandles(testCandles),
    }));
  }
  return Object.freeze(result);
}

function costCell(value, evidenceId) {
  if (!Number.isFinite(value) || value < 0) fail("CRYPTO_SPOT_COST_EVIDENCE_INVALID", { value, evidenceId });
  return Object.freeze({ value, evidenceId });
}

function costScenarioFromBacktest(name, multiplier, result) {
  const trades = result.trades;
  const sum = (selector) => trades.reduce((total, trade) => total + selector(trade), 0);
  const commission = sum((trade) => (trade.costs?.entryFee ?? 0) + (trade.costs?.exitFee ?? 0));
  const spread = sum((trade) => trade.costs?.spread ?? 0);
  const slippage = sum((trade) => trade.costs?.slippage ?? 0);
  const tax = sum((trade) => trade.costs?.tax ?? 0);
  const funding = sum((trade) => trade.costs?.funding ?? 0);
  const latency = sum((trade) => trade.costs?.latency ?? 0);
  const liquidityImpact = sum((trade) => (trade.entryNotional ?? 0) * BASE_LIQUIDITY_IMPACT_RATE * multiplier);
  const grossEdge = sum((trade) => trade.execution?.preExecutionGrossPnl ?? trade.grossPnl ?? 0);
  const costs = Object.freeze({
    commission: costCell(commission, `${name}:#690:commission`),
    spread: costCell(spread, `${name}:#690:spread`),
    slippage: costCell(slippage, `${name}:#690:slippage`),
    tax: costCell(tax, `${name}:#690:tax-observed-zero-spot`),
    funding: costCell(funding, `${name}:#690:funding-observed-zero-spot`),
    latency: costCell(latency, `${name}:#690:latency`),
    liquidityImpact: costCell(liquidityImpact, `${name}:modeled-liquidity-impact:${(BASE_LIQUIDITY_IMPACT_RATE * multiplier).toFixed(8)}`),
  });
  const explicitCosts = Object.values(costs).reduce((total, cell) => total + cell.value, 0);
  const netEdge = grossEdge - explicitCosts;
  return Object.freeze({
    name,
    status: trades.length > 0 && netEdge > 0 ? "PASS" : "FAIL",
    costMultiplier: multiplier,
    tradeCount: trades.length,
    costs,
    grossEdge,
    explicitCosts,
    netEdge,
    costEvidenceState: "MIXED_MEASURED_AND_CONSERVATIVE_MODELED",
  });
}

function tradeSubsetMetrics(trades, initialCapital = DEFAULT_INITIAL_CAPITAL) {
  if (!trades.length) return null;
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const net = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  let equity = initialCapital;
  let peak = initialCapital;
  let maximumDrawdown = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  return Object.freeze({
    winRate: wins.length / trades.length,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    expectancy: net / trades.length,
    maximumDrawdown,
    return: net / initialCapital,
  });
}

function rollingFeatures(candles, index) {
  if (index < REGIME_LOOKBACK_BARS) return null;
  const start = index - REGIME_LOOKBACK_BARS;
  const returns = [];
  const volumes = [];
  for (let cursor = start + 1; cursor <= index; cursor += 1) {
    returns.push((candles[cursor].close / candles[cursor - 1].close) - 1);
    volumes.push(candles[cursor].volume);
  }
  return Object.freeze({
    regime: rollingRegime(candles, index),
    volatility: sampleStd(returns),
    volume: candles[index].volume,
    averageVolume: average(volumes),
  });
}

function buildRegimeEvidence(baseResult, dataset, requestedRegimes) {
  const indexes = candleIndexByTimestamp(dataset.candles);
  const observations = baseResult.trades.map((trade) => {
    const index = indexes.get(trade.signalTime);
    return Number.isSafeInteger(index) ? { trade, feature: rollingFeatures(dataset.candles, index) } : null;
  }).filter((row) => row?.feature);
  const volatilityValues = observations.map((row) => row.feature.volatility).filter(Number.isFinite).sort((a, b) => a - b);
  const volatilityMedian = volatilityValues.length ? volatilityValues[Math.floor(volatilityValues.length / 2)] : null;
  const byRegime = {};
  for (const regime of requestedRegimes) {
    if (regime === "HIGH_SPREAD") {
      byRegime[regime] = Object.freeze({
        availability: "N/A",
        sampleCount: null,
        passed: null,
        metrics: null,
        methodology: "historical bid-ask spread is not present in Bitget OHLCV candles; no proxy is fabricated",
      });
      continue;
    }
    let subset;
    let methodology;
    if (["BULL", "BEAR", "SIDEWAYS"].includes(regime)) {
      subset = observations.filter((row) => row.feature.regime === regime).map((row) => row.trade);
      methodology = `causal ${REGIME_LOOKBACK_BARS}-bar return versus volatility-scaled threshold`;
    } else if (regime === "HIGH_VOLATILITY") {
      subset = volatilityMedian === null ? [] : observations.filter((row) => row.feature.volatility >= volatilityMedian).map((row) => row.trade);
      methodology = `causal ${REGIME_LOOKBACK_BARS}-bar realized-volatility >= trade-sample median`;
    } else if (regime === "LOW_VOLATILITY") {
      subset = volatilityMedian === null ? [] : observations.filter((row) => row.feature.volatility < volatilityMedian).map((row) => row.trade);
      methodology = `causal ${REGIME_LOOKBACK_BARS}-bar realized-volatility < trade-sample median`;
    } else if (regime === "LOW_LIQUIDITY") {
      subset = observations.filter((row) => row.feature.averageVolume > 0 && row.feature.volume < row.feature.averageVolume).map((row) => row.trade);
      methodology = `current closed-candle volume < causal ${REGIME_LOOKBACK_BARS}-bar average volume; volume proxy only`;
    } else {
      subset = [];
      methodology = "unsupported regime evidence is not inferred";
    }
    const metrics = tradeSubsetMetrics(subset);
    if (!metrics) {
      byRegime[regime] = Object.freeze({ availability: "N/A", sampleCount: null, passed: null, metrics: null, methodology });
    } else {
      byRegime[regime] = Object.freeze({
        availability: "AVAILABLE",
        sampleCount: subset.length,
        passed: subset.length >= REGIME_MIN_SAMPLE && metrics.expectancy > 0 && metrics.return > 0,
        metrics,
        methodology,
      });
    }
  }
  return Object.freeze(byRegime);
}

export function createCryptoSpotPublicFormulaTournamentDependenciesV1({ dataset } = {}) {
  if (!dataset || dataset.contract !== CRYPTO_SPOT_PUBLIC_FORMULA_TOURNAMENT_CONTRACT || dataset.market !== "CRYPTO_SPOT") {
    fail("CRYPTO_SPOT_PREPARED_DATASET_REQUIRED");
  }
  return Object.freeze({
    loadDatasetMetadata: async ({ formulaCandidate, datasetIdentity: requestedIdentity }) => {
      if (formulaCandidate.market !== "CRYPTO_SPOT" || formulaCandidate.timeframe !== dataset.timeframe || formulaCandidate.direction !== "LONG") {
        return { status: "MISSING_EVIDENCE", failureCode: "TIMEFRAME_INCOMPATIBLE", failureReason: "formula profile does not match exact public dataset" };
      }
      if (requestedIdentity !== dataset.datasetIdentity) {
        return { status: "MISSING_EVIDENCE", failureCode: "DATASET_ROLE_INVALID", failureReason: "requested train dataset identity differs from prepared public dataset" };
      }
      return {
        datasetIdentity: dataset.datasetIdentity,
        datasetRole: "TRAIN",
        market: "CRYPTO_SPOT",
        timeframe: dataset.timeframe,
        direction: "LONG",
        candleCount: dataset.trainCandles.length,
        independentPeriods: Math.max(1, Math.floor((dataset.trainPeriod.endTime - dataset.trainPeriod.startTime) / Math.max(7 * DAY_MS, 30 * dataset.intervalMs))),
        availableFields: dataset.availableFields,
      };
    },

    runHistoricalBacktest: async ({ formulaCandidate, generatedCandidate, datasetIdentity: requestedIdentity }) => {
      if (requestedIdentity !== dataset.datasetIdentity) return { status: "MISSING_EVIDENCE", failureCode: "DATASET_ROLE_INVALID", failureReason: "historical dataset identity mismatch" };
      const result = backtestCandidate({
        formulaCandidate,
        generatedCandidate,
        dataset,
        period: dataset.trainPeriod,
        datasetIdentity: dataset.datasetIdentity,
      });
      return Object.freeze({ ...result, sample: sampleEvidence(result, dataset) });
    },

    runOos: async ({ formulaCandidate, generatedCandidate, trainDatasetIdentity }) => {
      if (trainDatasetIdentity !== dataset.datasetIdentity) return { status: "MISSING_EVIDENCE", failureCode: "OOS_FAILED", failureReason: "OOS train identity mismatch" };
      const result = backtestCandidate({
        formulaCandidate,
        generatedCandidate,
        dataset,
        period: dataset.oosPeriod,
        datasetIdentity: dataset.oosDatasetIdentity,
      });
      if (result.trades.length === 0) return { status: "MISSING_EVIDENCE", failureCode: "OOS_FAILED", failureReason: "OOS produced zero trades" };
      return Object.freeze({
        ...result,
        strategyHash: formulaCandidate.formulaHash,
        parameterIdentity: generatedCandidate.parameterIdentity,
        trainDatasetIdentity: dataset.datasetIdentity,
        oosDatasetIdentity: dataset.oosDatasetIdentity,
        trainPeriod: dataset.trainPeriod,
        oosPeriod: dataset.oosPeriod,
        parameterFrozen: true,
        strategyFrozen: true,
      });
    },

    runPurgedOos: async ({ formulaCandidate, generatedCandidate, ordinaryOosDatasetIdentity }) => {
      if (ordinaryOosDatasetIdentity !== dataset.oosDatasetIdentity) return { status: "MISSING_EVIDENCE", failureCode: "PURGED_OOS_INVALID", failureReason: "ordinary OOS identity mismatch" };
      const featureLookbackBars = maximumEntryLookbackBars(formulaCandidate, generatedCandidate);
      const purgeWindowBars = Math.max(1, featureLookbackBars);
      const embargoWindowBars = Math.max(1, Math.ceil(featureLookbackBars / 4));
      if (dataset.oosCandles.length <= purgeWindowBars + embargoWindowBars + 20) {
        return { status: "MISSING_EVIDENCE", failureCode: "PURGED_OOS_INVALID", failureReason: "OOS sample is too short after purge/embargo" };
      }
      const usable = dataset.oosCandles.slice(purgeWindowBars, dataset.oosCandles.length - embargoWindowBars);
      const purgedOosDatasetIdentity = datasetIdentity("purged-oos", {
        sourceOosDatasetIdentity: dataset.oosDatasetIdentity,
        featureLookbackBars,
        purgeWindowBars,
        embargoWindowBars,
        fingerprint: datasetFingerprint(usable),
      });
      const purgedPeriod = periodFromCandles(usable);
      const result = backtestCandidate({
        formulaCandidate,
        generatedCandidate,
        dataset,
        period: purgedPeriod,
        datasetIdentity: purgedOosDatasetIdentity,
      });
      if (result.trades.length === 0) {
        return { status: "MISSING_EVIDENCE", failureCode: "PURGED_OOS_INVALID", failureReason: "purged OOS produced zero trades" };
      }
      return Object.freeze({
        status: "PASS",
        strategyHash: formulaCandidate.formulaHash,
        parameterIdentity: generatedCandidate.parameterIdentity,
        purgedOosDatasetIdentity,
        purgeWindowBars,
        embargoWindowBars,
        featureLookbackBars,
        overlappingLabelLeakage: false,
        timestampIntegrity: true,
        parameterFrozen: true,
        strategyFrozen: true,
        usableCandleCount: usable.length,
        canonicalBacktestOwner: result.canonicalBacktestOwner,
        executionEquivalent: result.executionEquivalent,
        executionEngine: result.executionEngine,
        evaluatedTradeCount: result.trades.length,
        evaluatedPeriod: purgedPeriod,
        metrics: result.metrics,
      });
    },

    runWalkForward: async ({ formulaCandidate, generatedCandidate, maxWindows }) => {
      const periods = buildWalkForwardPeriods(dataset, Math.min(maxWindows ?? 3, 3));
      if (periods.length < 3) return { status: "MISSING_EVIDENCE", failureCode: "WALK_FORWARD_INSUFFICIENT", failureReason: "three causal walk-forward windows could not be built" };
      const windows = [];
      for (const definition of periods) {
        const identity = datasetIdentity("walk-forward-oos", {
          parent: dataset.oosDatasetIdentity,
          startTime: definition.oosPeriod.startTime,
          endTime: definition.oosPeriod.endTime,
        });
        const result = backtestCandidate({ formulaCandidate, generatedCandidate, dataset, period: definition.oosPeriod, datasetIdentity: identity });
        const metrics = result.metrics;
        if (result.trades.length === 0 || !Number.isFinite(metrics.return) || !Number.isFinite(metrics.expectancy) || !Number.isFinite(metrics.maximumDrawdown)) {
          return { status: "MISSING_EVIDENCE", failureCode: "WALK_FORWARD_INSUFFICIENT", failureReason: "walk-forward OOS window lacks finite trade evidence" };
        }
        windows.push(Object.freeze({
          trainPeriod: definition.trainPeriod,
          validationPeriod: definition.validationPeriod,
          oosPeriod: definition.oosPeriod,
          strategyHash: formulaCandidate.formulaHash,
          parameterIdentity: generatedCandidate.parameterIdentity,
          trades: result.trades.length,
          return: metrics.return,
          profitFactor: metrics.profitFactor,
          expectancy: metrics.expectancy,
          maximumDrawdown: metrics.maximumDrawdown,
        }));
      }
      return Object.freeze({ status: "PASS", mode: "EXPANDING", windows: Object.freeze(windows), parameterFrozen: true, strategyFrozen: true });
    },

    runCostStress: async ({ formulaCandidate, generatedCandidate, scenarios, maxScenarios }) => {
      if (!Array.isArray(scenarios) || scenarios.length > maxScenarios) return { status: "NOT_EVALUABLE", failureCode: "NOT_EVALUABLE_RESOURCE_LIMIT", failureReason: "cost scenario budget invalid" };
      const rows = [];
      for (const name of scenarios) {
        const multiplier = COST_STRESS_MULTIPLIERS[name];
        if (!Number.isFinite(multiplier)) return { status: "MISSING_EVIDENCE", failureCode: "COST_EVIDENCE_MISSING", failureReason: `unsupported canonical cost scenario: ${name}` };
        const identity = datasetIdentity("cost-stress", { parent: dataset.oosDatasetIdentity, scenario: name, multiplier });
        const result = backtestCandidate({ formulaCandidate, generatedCandidate, dataset, period: dataset.oosPeriod, datasetIdentity: identity, costMultiplier: multiplier });
        rows.push(costScenarioFromBacktest(name, multiplier, result));
      }
      return Object.freeze({ status: "PASS", scenarios: Object.freeze(rows), market: "CRYPTO_SPOT", evidenceMode: "MEASURED_ONE_PASS_PLUS_MODELED_LIQUIDITY_IMPACT" });
    },

    runRegimeStress: async ({ formulaCandidate, generatedCandidate, regimes }) => {
      const result = backtestCandidate({ formulaCandidate, generatedCandidate, dataset, period: dataset.oosPeriod, datasetIdentity: dataset.oosDatasetIdentity });
      if (result.trades.length === 0) return { status: "MISSING_EVIDENCE", failureCode: "REGIME_EVIDENCE_MISSING", failureReason: "OOS contains no trades for regime analysis" };
      return Object.freeze({
        status: "PASS",
        strategyHash: formulaCandidate.formulaHash,
        parameterIdentity: generatedCandidate.parameterIdentity,
        regimes: buildRegimeEvidence(result, dataset, regimes),
        sourceDatasetIdentity: dataset.oosDatasetIdentity,
      });
    },
  });
}

function validateAdapterProfile(adapterInput, dataset) {
  if (!adapterInput || typeof adapterInput !== "object") fail("CRYPTO_SPOT_ADAPTER_INPUT_REQUIRED");
  const profile = adapterInput.seedResult?.profile;
  if (profile?.market !== "CRYPTO_SPOT") fail("CRYPTO_SPOT_PROFILE_REQUIRED", { market: profile?.market });
  if (profile.timeframe !== dataset.timeframe) fail("CRYPTO_SPOT_PROFILE_TIMEFRAME_MISMATCH", { profile: profile.timeframe, dataset: dataset.timeframe });
  if (!SUPPORTED_TIMEFRAMES.has(profile.timeframe)) fail("CRYPTO_SPOT_PROFILE_TIMEFRAME_UNSUPPORTED", { timeframe: profile.timeframe });
  if (adapterInput.hypothesis?.assetClass !== "CRYPTO_SPOT") fail("CRYPTO_SPOT_HYPOTHESIS_ASSET_CLASS_REQUIRED");
  if (!adapterInput.hypothesis?.timeframeScope?.includes(profile.timeframe)) fail("CRYPTO_SPOT_HYPOTHESIS_TIMEFRAME_MISMATCH");
  for (const requirement of adapterInput.hypothesis?.requiredData ?? []) {
    if (requirement.frequency !== profile.timeframe) fail("CRYPTO_SPOT_REQUIRED_DATA_FREQUENCY_MISMATCH", { frequency: requirement.frequency, timeframe: profile.timeframe });
    const missing = (requirement.fields ?? []).filter((field) => !dataset.availableFields.includes(field));
    if (missing.length) fail("CRYPTO_SPOT_REQUIRED_DATA_FIELDS_UNAVAILABLE", { missing });
  }
}

export function bindCryptoSpotPublicDatasetToAdapterInputV1(adapterInput, dataset) {
  validateAdapterProfile(adapterInput, dataset);
  if (adapterInput.compilerPolicy?.datasetRole !== "TRAIN") fail("CRYPTO_SPOT_COMPILER_DATASET_ROLE_MUST_BE_TRAIN");
  if (adapterInput.tournament?.search?.finalHoldoutAccess !== false) fail("CRYPTO_SPOT_FINAL_HOLDOUT_PREACCESS_FORBIDDEN");
  return deepFreeze({
    ...adapterInput,
    compilerPolicy: {
      ...adapterInput.compilerPolicy,
      datasetIdentity: dataset.datasetIdentity,
      datasetRole: "TRAIN",
    },
    tournament: {
      ...adapterInput.tournament,
      search: {
        ...adapterInput.tournament.search,
        datasetIdentity: dataset.datasetIdentity,
        finalHoldoutAccess: false,
      },
    },
  });
}

export async function runCryptoSpotPublicFormulaTournamentV1({
  client,
  symbol,
  startTime,
  endTime,
  maxCandles = 250_000,
  minimumPartitionCandles = DEFAULT_MINIMUM_PARTITION_CANDLES,
  adapterInput,
  onPage,
} = {}) {
  const timeframe = adapterInput?.seedResult?.profile?.timeframe;
  const dataset = await collectCryptoSpotPublicFormulaTournamentDatasetV1({
    client,
    symbol,
    timeframe,
    startTime,
    endTime,
    maxCandles,
    minimumPartitionCandles,
    onPage,
  });
  const boundInput = bindCryptoSpotPublicDatasetToAdapterInputV1(adapterInput, dataset);
  const dependencies = createCryptoSpotPublicFormulaTournamentDependenciesV1({ dataset });
  const result = await runEvidenceBackedFormulaTournamentAdapterV1(boundInput, dependencies);
  const candidates = result.tournament?.candidates ?? [];
  const reachedStatisticalFirewall = candidates.filter((candidate) => candidate.stageRecords?.some((record) => record.stage === "REGIME_STRESS" && record.status === "PASS")).length;
  return deepFreeze({
    schemaVersion: CRYPTO_SPOT_PUBLIC_FORMULA_TOURNAMENT_VERSION,
    contract: CRYPTO_SPOT_PUBLIC_FORMULA_TOURNAMENT_CONTRACT,
    status: "COMPLETED",
    dataset: datasetSummary(dataset),
    result,
    reachedStatisticalFirewall,
    nextCanonicalOwnerRequired: "#547",
    finalHoldoutEvaluated: false,
    profitabilityClaimAllowed: false,
    championPromotionAllowed: false,
    tradingAuthority: false,
    safety: {
      researchOnly: true,
      finalHoldoutPreAccessAllowed: false,
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      executionAuthority: "NONE",
    },
  });
}

export function buildCryptoSpotPublicFormulaDatasetSummaryV1(dataset) {
  return datasetSummary(dataset);
}

export const CRYPTO_SPOT_PUBLIC_FORMULA_BASE_COST_MODEL = BASE_COST_MODEL;
export const CRYPTO_SPOT_PUBLIC_FORMULA_COST_STRESS_MULTIPLIERS = COST_STRESS_MULTIPLIERS;
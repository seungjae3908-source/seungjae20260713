import { runIndependentSignalBacktest } from "./independent-strategy-backtest.js";
import { MARKET_SPECIALIZED_FAMILIES, calculateMarketSpecializedSignal, familyReadiness } from "./market-specialized-alpha-families.js";
import { buildV7Candidates } from "./v7-vwap-mean-reversion.js";
import { buildV8Candidates, validExchangeSessionMeta } from "./v8-opening-range-retest.js";
import { buildV9Candidates } from "./v9-relative-strength.js";
import { buildV10Candidates } from "./v10-derivatives-positioning.js";

const BUILDERS = Object.freeze({ V7: buildV7Candidates, V8: buildV8Candidates, V9: buildV9Candidates, V10: buildV10Candidates });

export function buildSpecializedCandidateFilters(version) {
  const builder = BUILDERS[version];
  if (!builder) throw new TypeError(`unsupported market-specialized version: ${version}`);
  return builder();
}

function benchmarkCoverage(candles, benchmarkCandles) {
  if (!Array.isArray(candles) || !Array.isArray(benchmarkCandles) || benchmarkCandles.length === 0) return false;
  const timestamps = new Set();
  for (const row of benchmarkCandles) {
    if (!Number.isInteger(row?.timestamp) || timestamps.has(row.timestamp)) return false;
    timestamps.add(row.timestamp);
  }
  return candles.every((row) => Number.isInteger(row?.timestamp) && timestamps.has(row.timestamp));
}

function preflightReasons({ version, backtestInput, benchmarkCandles, derivatives }) {
  const candles = backtestInput?.candles;
  const sampleCandle = Array.isArray(candles) && candles.length ? candles[candles.length - 1] : null;
  const readiness = familyReadiness({
    version,
    market: backtestInput?.market,
    side: backtestInput?.side ?? "long",
    timeframe: backtestInput?.timeframe,
    sampleCandle,
    benchmarkCandles,
    derivatives,
  });
  const reasons = [...readiness.reasons];
  if (!Array.isArray(candles) || candles.length === 0) reasons.push("price_history_required");
  if (version === "V8" && Array.isArray(candles) && !candles.every(validExchangeSessionMeta)) reasons.push("complete_exchange_session_metadata_required");
  if (version === "V9" && !benchmarkCoverage(candles, benchmarkCandles)) reasons.push("exact_benchmark_timestamp_coverage_required");
  return Object.freeze([...new Set(reasons)]);
}

export function runMarketSpecializedBacktest({
  version,
  backtestInput,
  parameters,
  filter,
  period,
  benchmarkCandles = null,
  derivatives = null,
  runner = runIndependentSignalBacktest,
} = {}) {
  if (!MARKET_SPECIALIZED_FAMILIES[version]) throw new TypeError(`unsupported market-specialized version: ${version}`);
  if (!backtestInput || typeof backtestInput !== "object") throw new TypeError("backtestInput is required");
  if (!parameters || typeof parameters !== "object") throw new TypeError("risk/exit parameters are required");
  if (!filter || typeof filter !== "object") throw new TypeError("strategy filter is required");
  if (!period || typeof period !== "object") throw new TypeError("research period is required");
  if (period.includeFinalHoldout === true) throw new Error("MARKET_SPECIALIZED_FINAL_HOLDOUT_SELECTION_FORBIDDEN");
  if (typeof runner !== "function") throw new TypeError("runner must be a function");

  const reasons = preflightReasons({ version, backtestInput, benchmarkCandles, derivatives });
  if (reasons.length) {
    return Object.freeze({
      schemaVersion: 1,
      version,
      family: MARKET_SPECIALIZED_FAMILIES[version].family,
      status: "blocked_data",
      reasons,
      result: null,
      finalHoldoutUsedForSelection: false,
      liveOrderAllowed: false,
      privateAccountRequestAllowed: false,
      orderSubmitted: false,
      syntheticResearchDataAllowed: false,
    });
  }

  const result = runner({
    backtestInput,
    strategy: MARKET_SPECIALIZED_FAMILIES[version].family.toLowerCase(),
    strategyVersion: version,
    parameters,
    period,
    signalEvaluator: ({ side, candles, atr, index }) => calculateMarketSpecializedSignal({
      version,
      market: backtestInput.market,
      side,
      candles,
      atr,
      index,
      filter,
      benchmarkCandles,
      derivatives,
    }),
  });

  return Object.freeze({
    schemaVersion: 1,
    version,
    family: MARKET_SPECIALIZED_FAMILIES[version].family,
    status: "evaluated",
    reasons: Object.freeze([]),
    result,
    finalHoldoutUsedForSelection: false,
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
    orderSubmitted: false,
    syntheticResearchDataAllowed: false,
  });
}

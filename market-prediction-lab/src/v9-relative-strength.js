import {
  SPECIALIZED_EPSILON,
  assertSpecializedMarket,
  assertSpecializedSide,
  buildBoundedCandidates,
  finiteNonNegative,
  positiveInteger,
} from "./market-specialized-alpha-contract.js";

export const V9_FAMILY = "V9_RELATIVE_STRENGTH_ROTATION";
export const V9_GRID = Object.freeze({
  lookbackBars: Object.freeze([20, 60, 120]),
  minRelativeReturn: Object.freeze([0.02, 0.05]),
  minAssetReturn: Object.freeze([-0.02, 0.02]),
  requireAcceleration: Object.freeze([false, true]),
});

export function normalizeV9Filter(filter = {}) {
  if (!Number.isFinite(filter.minAssetReturn) || filter.minAssetReturn < -1 || filter.minAssetReturn > 5) {
    throw new TypeError("minAssetReturn must be finite in [-1, 5]");
  }
  return Object.freeze({
    lookbackBars: positiveInteger(filter.lookbackBars, "lookbackBars", 500),
    minRelativeReturn: finiteNonNegative(filter.minRelativeReturn, "minRelativeReturn", 5),
    minAssetReturn: filter.minAssetReturn,
    requireAcceleration: filter.requireAcceleration === true,
  });
}

export function buildV9Candidates(grid = V9_GRID) {
  return buildBoundedCandidates(grid, ["lookbackBars", "minRelativeReturn", "minAssetReturn", "requireAcceleration"], normalizeV9Filter);
}

function exactBenchmarkMap(rows) {
  const map = new Map();
  for (const row of rows ?? []) {
    if (!Number.isInteger(row?.timestamp) || !Number.isFinite(row?.close) || row.close <= 0 || map.has(row.timestamp)) return null;
    map.set(row.timestamp, row);
  }
  return map;
}

export function calculateV9Signal({ market, side, candles, index, benchmarkCandles, filter }) {
  assertSpecializedMarket(market);
  assertSpecializedSide(side);
  if (!new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]).has(market) || side !== "long") return null;
  const candidate = normalizeV9Filter(filter);
  if (!Array.isArray(candles) || !Array.isArray(benchmarkCandles) || !Number.isInteger(index) || index < candidate.lookbackBars * 2 || index >= candles.length) return null;
  const benchmark = exactBenchmarkMap(benchmarkCandles);
  if (!benchmark) return null;
  const current = candles[index];
  const past = candles[index - candidate.lookbackBars];
  const earlier = candles[index - candidate.lookbackBars * 2];
  const bCurrent = benchmark.get(current.timestamp);
  const bPast = benchmark.get(past.timestamp);
  const bEarlier = benchmark.get(earlier.timestamp);
  if (![current.close, past.close, earlier.close, bCurrent?.close, bPast?.close, bEarlier?.close].every((value) => Number.isFinite(value) && value > 0)) return null;
  const assetReturn = current.close / past.close - 1;
  const benchmarkReturn = bCurrent.close / bPast.close - 1;
  const relativeReturn = assetReturn - benchmarkReturn;
  const previousRelativeReturn = (past.close / earlier.close - 1) - (bPast.close / bEarlier.close - 1);
  if (assetReturn + SPECIALIZED_EPSILON < candidate.minAssetReturn || relativeReturn + SPECIALIZED_EPSILON < candidate.minRelativeReturn) return null;
  if (candidate.requireAcceleration && !(relativeReturn > previousRelativeReturn + SPECIALIZED_EPSILON)) return null;
  return Object.freeze({
    independentSignal: true,
    family: V9_FAMILY,
    assetReturn,
    benchmarkReturn,
    relativeReturn,
    previousRelativeReturn,
    benchmarkTimestampExactMatch: true,
    usesOnlyClosedHistoryThroughSignal: true,
  });
}

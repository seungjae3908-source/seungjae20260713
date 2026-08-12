import {
  SPECIALIZED_EPSILON,
  assertSpecializedMarket,
  assertSpecializedSide,
  buildBoundedCandidates,
  finiteNonNegative,
  positiveInteger,
} from "./market-specialized-alpha-contract.js";

export const V10_FAMILY = "V10_DERIVATIVES_POSITIONING";
export const V10_GRID = Object.freeze({
  lookbackBars: Object.freeze([4, 12, 24]),
  minOiChange: Object.freeze([0.01, 0.03]),
  minDirectionalReturn: Object.freeze([0.005, 0.01]),
  maxAbsFunding: Object.freeze([0.001, 0.003]),
  maxAbsBasis: Object.freeze([0.01, 0.03]),
});

export function normalizeV10Filter(filter = {}) {
  return Object.freeze({
    lookbackBars: positiveInteger(filter.lookbackBars, "lookbackBars", 500),
    minOiChange: finiteNonNegative(filter.minOiChange, "minOiChange", 10),
    minDirectionalReturn: finiteNonNegative(filter.minDirectionalReturn, "minDirectionalReturn", 5),
    maxAbsFunding: finiteNonNegative(filter.maxAbsFunding, "maxAbsFunding", 1),
    maxAbsBasis: finiteNonNegative(filter.maxAbsBasis, "maxAbsBasis", 1),
  });
}

export function buildV10Candidates(grid = V10_GRID) {
  return buildBoundedCandidates(grid, ["lookbackBars", "minOiChange", "minDirectionalReturn", "maxAbsFunding", "maxAbsBasis"], normalizeV10Filter);
}

function normalizeSeries(rows, valueKeys) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const result = [];
  let previous = -Infinity;
  for (const row of rows) {
    if (!Number.isInteger(row?.timestamp) || row.timestamp <= previous) return null;
    previous = row.timestamp;
    const value = valueKeys.map((key) => row?.[key]).find(Number.isFinite);
    if (!Number.isFinite(value)) return null;
    result.push({ timestamp: row.timestamp, value });
  }
  return result;
}

function atOrBefore(rows, timestamp) {
  let result = null;
  for (const row of rows) {
    if (row.timestamp > timestamp) break;
    result = row;
  }
  return result;
}

export function normalizeDerivativesContext(derivatives) {
  const priceVenue = derivatives?.priceVenue;
  if (typeof priceVenue !== "string" || priceVenue.length === 0) return null;
  const sources = [derivatives?.openInterest, derivatives?.funding, derivatives?.basis];
  if (sources.some((source) => !source || source.venue !== priceVenue)) return null;
  const openInterest = normalizeSeries(derivatives.openInterest.rows, ["openInterest", "value"]);
  const funding = normalizeSeries(derivatives.funding.rows, ["rate", "value"]);
  const basis = normalizeSeries(derivatives.basis.rows, ["basis", "rate", "value"]);
  const maxStalenessMs = Object.freeze({
    openInterest: derivatives?.maxStalenessMs?.openInterest,
    funding: derivatives?.maxStalenessMs?.funding,
    basis: derivatives?.maxStalenessMs?.basis,
  });
  if (!openInterest || !funding || !basis) return null;
  if (!Object.values(maxStalenessMs).every((value) => Number.isSafeInteger(value) && value > 0)) return null;
  return Object.freeze({ priceVenue, openInterest, funding, basis, maxStalenessMs });
}

export function calculateV10Signal({ market, side, candles, index, derivatives, filter }) {
  assertSpecializedMarket(market);
  assertSpecializedSide(side);
  if (market !== "CRYPTO_FUTURES") return null;
  const candidate = normalizeV10Filter(filter);
  if (!Array.isArray(candles) || !Number.isInteger(index) || index < candidate.lookbackBars || index >= candles.length) return null;
  const context = normalizeDerivativesContext(derivatives);
  if (!context) return null;
  const current = candles[index];
  const past = candles[index - candidate.lookbackBars];
  if (![current?.close, past?.close].every((value) => Number.isFinite(value) && value > 0)) return null;
  const oiNow = atOrBefore(context.openInterest, current.timestamp);
  const oiPast = atOrBefore(context.openInterest, past.timestamp);
  const fundingNow = atOrBefore(context.funding, current.timestamp);
  const basisNow = atOrBefore(context.basis, current.timestamp);
  if (![oiNow?.value, oiPast?.value, fundingNow?.value, basisNow?.value].every(Number.isFinite) || !(oiPast.value > 0)) return null;
  const contextAgesMs = Object.freeze({
    openInterest: current.timestamp - oiNow.timestamp,
    funding: current.timestamp - fundingNow.timestamp,
    basis: current.timestamp - basisNow.timestamp,
  });
  if (Object.entries(contextAgesMs).some(([key, age]) => !Number.isSafeInteger(age) || age < 0 || age > context.maxStalenessMs[key])) return null;
  const priceReturn = current.close / past.close - 1;
  const directionalReturn = side === "long" ? priceReturn : -priceReturn;
  const openInterestChange = oiNow.value / oiPast.value - 1;
  if (directionalReturn + SPECIALIZED_EPSILON < candidate.minDirectionalReturn) return null;
  if (openInterestChange + SPECIALIZED_EPSILON < candidate.minOiChange) return null;
  if (Math.abs(fundingNow.value) > candidate.maxAbsFunding + SPECIALIZED_EPSILON) return null;
  if (Math.abs(basisNow.value) > candidate.maxAbsBasis + SPECIALIZED_EPSILON) return null;
  return Object.freeze({
    independentSignal: true,
    family: V10_FAMILY,
    priceReturn,
    directionalReturn,
    openInterestChange,
    fundingRate: fundingNow.value,
    basisRate: basisNow.value,
    priceVenue: context.priceVenue,
    contextTimestamps: Object.freeze({ openInterest: oiNow.timestamp, funding: fundingNow.timestamp, basis: basisNow.timestamp }),
    contextAgesMs,
    sameVenue: true,
    usesPointInTimeContextOnly: true,
    usesOnlyClosedHistoryThroughSignal: true,
  });
}

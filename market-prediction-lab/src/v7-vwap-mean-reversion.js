import {
  SPECIALIZED_EPSILON,
  assertSpecializedMarket,
  assertSpecializedSide,
  buildBoundedCandidates,
  finiteNonNegative,
  finitePositive,
  positiveInteger,
  relativeVolume,
} from "./market-specialized-alpha-contract.js";

export const V7_FAMILY = "V7_VWAP_MEAN_REVERSION";
export const V7_GRID = Object.freeze({
  vwapLookback: Object.freeze([20, 40, 80]),
  stretchAtr: Object.freeze([1, 1.5, 2]),
  reclaimAtr: Object.freeze([0.25, 0.5]),
  maxEntryRvol: Object.freeze([1.5, 2.5]),
});

export function normalizeV7Filter(filter = {}) {
  const normalized = {
    vwapLookback: positiveInteger(filter.vwapLookback, "vwapLookback", 500),
    stretchAtr: finitePositive(filter.stretchAtr, "stretchAtr", 10),
    reclaimAtr: finiteNonNegative(filter.reclaimAtr, "reclaimAtr", 5),
    maxEntryRvol: finitePositive(filter.maxEntryRvol, "maxEntryRvol", 20),
  };
  if (normalized.reclaimAtr >= normalized.stretchAtr) throw new TypeError("reclaimAtr must be smaller than stretchAtr");
  return Object.freeze(normalized);
}

export function buildV7Candidates(grid = V7_GRID) {
  return buildBoundedCandidates(grid, ["vwapLookback", "stretchAtr", "reclaimAtr", "maxEntryRvol"], normalizeV7Filter);
}

function rollingVwap(candles, index, lookback) {
  const start = index - lookback + 1;
  if (start < 0) return null;
  const rows = candles.slice(start, index + 1);
  if (rows.length !== lookback) return null;
  let weighted = 0;
  let volume = 0;
  for (const candle of rows) {
    if (![candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) || candle.volume < 0) return null;
    weighted += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
    volume += candle.volume;
  }
  return volume > 0 ? weighted / volume : null;
}

export function calculateV7Signal({ market, side, candles, atr, index, filter }) {
  assertSpecializedMarket(market);
  assertSpecializedSide(side);
  if (market !== "CRYPTO_FUTURES" && side === "short") return null;
  const candidate = normalizeV7Filter(filter);
  if (!Array.isArray(candles) || !Array.isArray(atr) || !Number.isInteger(index) || index < candidate.vwapLookback || index >= candles.length) return null;
  const atrNow = atr[index];
  const atrPrevious = atr[index - 1];
  if (!(Number.isFinite(atrNow) && atrNow > 0 && Number.isFinite(atrPrevious) && atrPrevious > 0)) return null;
  const currentVwap = rollingVwap(candles, index, candidate.vwapLookback);
  const previousVwap = rollingVwap(candles, index - 1, candidate.vwapLookback);
  if (!(Number.isFinite(currentVwap) && currentVwap > 0 && Number.isFinite(previousVwap) && previousVwap > 0)) return null;
  const current = candles[index];
  const previous = candles[index - 1];
  const rvol = relativeVolume(candles, index);
  if (!Number.isFinite(rvol) || rvol > candidate.maxEntryRvol + SPECIALIZED_EPSILON) return null;
  const previousDistanceAtr = (previous.close - previousVwap) / atrPrevious;
  const currentDistanceAtr = (current.close - currentVwap) / atrNow;
  const stretched = side === "long" ? previousDistanceAtr <= -candidate.stretchAtr : previousDistanceAtr >= candidate.stretchAtr;
  const reclaimed = side === "long" ? currentDistanceAtr >= -candidate.reclaimAtr : currentDistanceAtr <= candidate.reclaimAtr;
  const directionalBody = side === "long" ? current.close > current.open : current.close < current.open;
  if (!(stretched && reclaimed && directionalBody)) return null;
  return Object.freeze({
    independentSignal: true,
    family: V7_FAMILY,
    rollingVwap: currentVwap,
    previousDistanceAtr,
    currentDistanceAtr,
    relativeVolume: rvol,
    usesOnlyClosedHistoryThroughSignal: true,
  });
}

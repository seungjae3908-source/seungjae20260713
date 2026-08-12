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

export const V8_FAMILY = "V8_SESSION_OPENING_RANGE_RETEST";
export const V8_GRID = Object.freeze({
  openingRangeMinutes: Object.freeze([15, 30, 60]),
  breakoutRecencyBars: Object.freeze([1, 3]),
  breakoutBufferAtr: Object.freeze([0, 0.1]),
  retestToleranceAtr: Object.freeze([0.25, 0.5]),
  minRvol: Object.freeze([1, 1.5]),
});

export function validExchangeSessionMeta(candle) {
  return typeof candle?.sessionDate === "string" && Number.isInteger(candle?.sessionMinute) && candle.sessionMinute >= 0;
}

export function normalizeV8Filter(filter = {}) {
  return Object.freeze({
    openingRangeMinutes: positiveInteger(filter.openingRangeMinutes, "openingRangeMinutes", 180),
    breakoutRecencyBars: positiveInteger(filter.breakoutRecencyBars, "breakoutRecencyBars", 20),
    breakoutBufferAtr: finiteNonNegative(filter.breakoutBufferAtr, "breakoutBufferAtr", 2),
    retestToleranceAtr: finiteNonNegative(filter.retestToleranceAtr, "retestToleranceAtr", 2),
    minRvol: finitePositive(filter.minRvol, "minRvol", 20),
  });
}

export function buildV8Candidates(grid = V8_GRID) {
  return buildBoundedCandidates(grid, ["openingRangeMinutes", "breakoutRecencyBars", "breakoutBufferAtr", "retestToleranceAtr", "minRvol"], normalizeV8Filter);
}

function sameSessionRange(candles, index, openingRangeMinutes) {
  const current = candles[index];
  if (!validExchangeSessionMeta(current)) return null;
  const rows = [];
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const row = candles[cursor];
    if (!validExchangeSessionMeta(row) || row.sessionDate !== current.sessionDate) break;
    if (row.sessionMinute < openingRangeMinutes) rows.push({ index: cursor, row });
  }
  if (rows.length === 0 || Math.min(...rows.map(({ row }) => row.sessionMinute)) !== 0) return null;
  const high = Math.max(...rows.map(({ row }) => row.high));
  const low = Math.min(...rows.map(({ row }) => row.low));
  if (!(Number.isFinite(high) && Number.isFinite(low) && high >= low)) return null;
  return Object.freeze({ high, low, lastIndex: Math.max(...rows.map(({ index: cursor }) => cursor)) });
}

export function calculateV8Signal({ market, side, candles, atr, index, filter }) {
  assertSpecializedMarket(market);
  assertSpecializedSide(side);
  if (!new Set(["KR_STOCK", "US_STOCK"]).has(market) || side !== "long") return null;
  const candidate = normalizeV8Filter(filter);
  if (!Array.isArray(candles) || !Array.isArray(atr) || !Number.isInteger(index) || index <= 1 || index >= candles.length) return null;
  const current = candles[index];
  if (!validExchangeSessionMeta(current) || current.sessionMinute < candidate.openingRangeMinutes) return null;
  const range = sameSessionRange(candles, index, candidate.openingRangeMinutes);
  if (!range) return null;
  const atrNow = atr[index];
  const rvol = relativeVolume(candles, index);
  if (!(Number.isFinite(atrNow) && atrNow > 0 && Number.isFinite(rvol) && rvol + SPECIALIZED_EPSILON >= candidate.minRvol)) return null;
  const earliest = Math.max(range.lastIndex + 1, index - candidate.breakoutRecencyBars);
  for (let breakoutIndex = index - 1; breakoutIndex >= earliest; breakoutIndex -= 1) {
    const breakout = candles[breakoutIndex];
    if (breakout.sessionDate !== current.sessionDate) continue;
    const breakoutAtr = atr[breakoutIndex];
    if (!(Number.isFinite(breakoutAtr) && breakoutAtr > 0)) continue;
    if (!(breakout.close > range.high + candidate.breakoutBufferAtr * breakoutAtr)) continue;
    const tolerance = candidate.retestToleranceAtr * atrNow;
    const touched = current.low <= range.high + tolerance + SPECIALIZED_EPSILON && current.low >= range.high - tolerance - SPECIALIZED_EPSILON;
    if (!(touched && current.close > range.high && current.close > current.open)) continue;
    return Object.freeze({
      independentSignal: true,
      family: V8_FAMILY,
      sessionDate: current.sessionDate,
      openingRangeHigh: range.high,
      openingRangeLow: range.low,
      breakoutTimestamp: breakout.timestamp,
      barsSinceBreakout: index - breakoutIndex,
      relativeVolume: rvol,
      usesExchangeLocalSessionMetadata: true,
      usesOnlyClosedHistoryThroughSignal: true,
    });
  }
  return null;
}

export const SPECIALIZED_MARKETS = Object.freeze(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
export const SPECIALIZED_SIDES = Object.freeze(["long", "short"]);
export const SPECIALIZED_EPSILON = 1e-12;

const MARKET_SET = new Set(SPECIALIZED_MARKETS);
const SIDE_SET = new Set(SPECIALIZED_SIDES);

export function assertSpecializedMarket(market) {
  if (!MARKET_SET.has(market)) throw new TypeError(`unsupported market: ${market}`);
}

export function assertSpecializedSide(side) {
  if (!SIDE_SET.has(side)) throw new TypeError(`unsupported side: ${side}`);
}

export function positiveInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new TypeError(`${label} must be integer in [1, ${max}]`);
  }
  return value;
}

export function finiteNonNegative(value, label, max = Number.POSITIVE_INFINITY) {
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new TypeError(`${label} must be finite in [0, ${max}]`);
  }
  return value;
}

export function finitePositive(value, label, max = Number.POSITIVE_INFINITY) {
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new TypeError(`${label} must be finite in (0, ${max}]`);
  }
  return value;
}

export function buildBoundedCandidates(grid, keys, normalize, maxCandidates = 64) {
  const rows = [];
  const walk = (depth, current) => {
    if (depth === keys.length) {
      rows.push(normalize(current));
      return;
    }
    const key = keys[depth];
    const values = grid?.[key];
    if (!Array.isArray(values) || values.length === 0) throw new TypeError(`grid.${key} must be non-empty array`);
    for (const value of values) walk(depth + 1, { ...current, [key]: value });
  };
  walk(0, {});
  const unique = [...new Map(rows.map((row) => [JSON.stringify(row), row])).values()];
  if (unique.length < 1 || unique.length > maxCandidates) {
    throw new RangeError(`candidate grid must contain 1..${maxCandidates} unique rows; got ${unique.length}`);
  }
  return Object.freeze(unique.map(Object.freeze));
}

export function relativeVolume(candles, index, lookback = 20) {
  if (index <= 0 || !Number.isFinite(candles[index]?.volume)) return null;
  const start = Math.max(0, index - lookback);
  const history = candles.slice(start, index).map((row) => row.volume).filter((value) => Number.isFinite(value) && value >= 0);
  if (history.length === 0) return null;
  const average = history.reduce((sum, value) => sum + value, 0) / history.length;
  return average > 0 ? candles[index].volume / average : null;
}

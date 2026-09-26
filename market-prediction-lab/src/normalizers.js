import { MARKETS, TIMEFRAMES, PredictionInputError } from "./contracts.js";
import { assertMonotonicCandles, inspectCandleQuality } from "./data-quality.js";

function parseNumber(value, label) {
  const normalized = typeof value === "string" ? value.replaceAll(",", "").trim() : value;
  const number = typeof normalized === "number" ? normalized : Number(normalized);
  if (!Number.isFinite(number)) throw new PredictionInputError(`${label} must be numeric`, { value });
  return number;
}

function parseTimestamp(value, unit = "auto") {
  if (unit === "iso") {
    const timestamp = Date.parse(String(value));
    if (!Number.isFinite(timestamp)) throw new PredictionInputError("timestamp is not valid ISO date text", { value });
    return timestamp;
  }
  const numeric = parseNumber(value, "timestamp");
  if (!Number.isInteger(numeric) || numeric <= 0) throw new PredictionInputError("timestamp must be a positive integer", { value });
  if (unit === "seconds") return numeric * 1000;
  if (unit === "milliseconds") return numeric;
  return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
}

function toCandle(row, config, index) {
  let values;
  if (config.format === "bitget-array") {
    if (!Array.isArray(row) || row.length < 6) throw new PredictionInputError(`rows[${index}] must contain at least 6 values`);
    values = { timestamp: row[0], open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5] };
  } else {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new PredictionInputError(`rows[${index}] must be an object`);
    const map = config.fieldMap ?? { timestamp: "timestamp", open: "open", high: "high", low: "low", close: "close", volume: "volume" };
    values = Object.fromEntries(Object.entries(map).map(([canonical, source]) => [canonical, row[source]]));
  }

  const timestamp = parseTimestamp(values.timestamp, config.timestampUnit ?? "auto");
  const open = parseNumber(values.open, `rows[${index}].open`);
  const high = parseNumber(values.high, `rows[${index}].high`);
  const low = parseNumber(values.low, `rows[${index}].low`);
  const close = parseNumber(values.close, `rows[${index}].close`);
  const volume = parseNumber(values.volume, `rows[${index}].volume`);
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) throw new PredictionInputError(`rows[${index}] contains invalid price or volume`);
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) throw new PredictionInputError(`rows[${index}] has invalid OHLC relationships`);
  return { timestamp, open, high, low, close, volume };
}

export function normalizeCandleRows(rows, rawConfig) {
  const config = { format: "canonical-object", duplicatePolicy: "last", strict: true, ...rawConfig };
  if (!Array.isArray(rows)) throw new PredictionInputError("snapshot rows must be an array");
  if (!MARKETS.includes(config.market)) throw new PredictionInputError(`unsupported market: ${config.market}`);
  if (!TIMEFRAMES.includes(config.timeframe)) throw new PredictionInputError(`unsupported timeframe: ${config.timeframe}`);
  if (typeof config.symbol !== "string" || !/^[A-Za-z0-9._:-]{1,40}$/.test(config.symbol)) throw new PredictionInputError("invalid symbol");

  const rejected = [];
  const normalized = [];
  rows.forEach((row, index) => {
    try { normalized.push(toCandle(row, config, index)); }
    catch (error) {
      rejected.push({ index, message: error.message });
      if (config.strict) throw error;
    }
  });
  normalized.sort((a, b) => a.timestamp - b.timestamp);

  const deduped = [];
  let duplicateRows = 0;
  for (const candle of normalized) {
    const previous = deduped.at(-1);
    if (!previous || previous.timestamp !== candle.timestamp) { deduped.push(candle); continue; }
    duplicateRows += 1;
    if (config.duplicatePolicy === "reject") throw new PredictionInputError("duplicate timestamp detected", { timestamp: candle.timestamp });
    if (config.duplicatePolicy === "first") continue;
    deduped[deduped.length - 1] = candle;
  }
  assertMonotonicCandles(deduped);
  const quality = inspectCandleQuality(deduped, config);
  return Object.freeze({
    schemaVersion: 2,
    metadata: Object.freeze({
      market: config.market,
      symbol: config.symbol.toUpperCase(),
      timeframe: config.timeframe,
      source: String(config.source ?? "offline-snapshot").slice(0, 80),
      timestampUnit: "milliseconds",
    }),
    candles: Object.freeze(deduped.map((candle) => Object.freeze(candle))),
    quality: Object.freeze({
      ...quality,
      duplicateRowsRemoved: duplicateRows,
      rejectedRows: rejected.length,
      rejected: Object.freeze(rejected.map(Object.freeze)),
    }),
  });
}

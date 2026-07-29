export const MARKETS = Object.freeze([
  "KR_STOCK",
  "US_STOCK",
  "CRYPTO_SPOT",
  "CRYPTO_FUTURES",
]);

export const TIMEFRAMES = Object.freeze(["15m", "1h", "4h", "1d"]);

export class PredictionInputError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PredictionInputError";
    this.details = details;
  }
}

export function assertFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PredictionInputError(`${name} must be a finite number`, { name, value });
  }
  return value;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function validateCandle(candle, index) {
  if (!candle || typeof candle !== "object" || Array.isArray(candle)) {
    throw new PredictionInputError(`candles[${index}] must be an object`);
  }

  const timestamp = assertFiniteNumber(candle.timestamp, `candles[${index}].timestamp`);
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new PredictionInputError(`candles[${index}].timestamp must be a positive integer in milliseconds`);
  }

  const open = assertFiniteNumber(candle.open, `candles[${index}].open`);
  const high = assertFiniteNumber(candle.high, `candles[${index}].high`);
  const low = assertFiniteNumber(candle.low, `candles[${index}].low`);
  const close = assertFiniteNumber(candle.close, `candles[${index}].close`);
  const volume = assertFiniteNumber(candle.volume, `candles[${index}].volume`);

  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
    throw new PredictionInputError(`candles[${index}] prices must be greater than zero`);
  }
  if (volume < 0) {
    throw new PredictionInputError(`candles[${index}].volume cannot be negative`);
  }
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
    throw new PredictionInputError(`candles[${index}] has invalid OHLC relationships`);
  }

  return Object.freeze({ timestamp, open, high, low, close, volume });
}

function validateOptionalNumber(value, name) {
  if (value === undefined || value === null) return undefined;
  return assertFiniteNumber(value, name);
}

export function validatePredictionInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("input must be an object");
  }
  if (!MARKETS.includes(raw.market)) {
    throw new PredictionInputError(`market must be one of: ${MARKETS.join(", ")}`);
  }
  if (typeof raw.symbol !== "string" || !/^[A-Za-z0-9._:-]{1,40}$/.test(raw.symbol)) {
    throw new PredictionInputError("symbol contains unsupported characters or has an invalid length");
  }
  if (!TIMEFRAMES.includes(raw.timeframe)) {
    throw new PredictionInputError(`timeframe must be one of: ${TIMEFRAMES.join(", ")}`);
  }
  const horizon = raw.horizon ?? 5;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 20) {
    throw new PredictionInputError("horizon must be an integer between 1 and 20");
  }
  if (!Array.isArray(raw.candles) || raw.candles.length < 60 || raw.candles.length > 1000) {
    throw new PredictionInputError("candles must contain between 60 and 1000 items");
  }

  const candles = raw.candles.map(validateCandle);
  for (let i = 1; i < candles.length; i += 1) {
    if (candles[i].timestamp <= candles[i - 1].timestamp) {
      throw new PredictionInputError("candles must be strictly ordered by unique ascending timestamps");
    }
  }

  const marketFeatures = raw.marketFeatures && typeof raw.marketFeatures === "object"
    ? Object.freeze({
        breadth: validateOptionalNumber(raw.marketFeatures.breadth, "marketFeatures.breadth"),
        benchmarkReturn: validateOptionalNumber(raw.marketFeatures.benchmarkReturn, "marketFeatures.benchmarkReturn"),
        sentimentScore: validateOptionalNumber(raw.marketFeatures.sentimentScore, "marketFeatures.sentimentScore"),
        foreignNetRatio: validateOptionalNumber(raw.marketFeatures.foreignNetRatio, "marketFeatures.foreignNetRatio"),
        institutionNetRatio: validateOptionalNumber(raw.marketFeatures.institutionNetRatio, "marketFeatures.institutionNetRatio"),
      })
    : Object.freeze({});

  const derivativesFeatures = raw.derivativesFeatures && typeof raw.derivativesFeatures === "object"
    ? Object.freeze({
        openInterestChange: validateOptionalNumber(raw.derivativesFeatures.openInterestChange, "derivativesFeatures.openInterestChange"),
        fundingRate: validateOptionalNumber(raw.derivativesFeatures.fundingRate, "derivativesFeatures.fundingRate"),
        longShortRatio: validateOptionalNumber(raw.derivativesFeatures.longShortRatio, "derivativesFeatures.longShortRatio"),
        basisRate: validateOptionalNumber(raw.derivativesFeatures.basisRate, "derivativesFeatures.basisRate"),
      })
    : Object.freeze({});

  return Object.freeze({
    market: raw.market,
    symbol: raw.symbol.toUpperCase(),
    timeframe: raw.timeframe,
    horizon,
    candles: Object.freeze(candles),
    marketFeatures,
    derivativesFeatures,
    collectedAt: Number.isInteger(raw.collectedAt) && raw.collectedAt > 0 ? raw.collectedAt : Date.now(),
    source: typeof raw.source === "string" && raw.source.length <= 80 ? raw.source : "standalone-fixture",
  });
}

const TIMEFRAME_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
});

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}

export function verifyLiveCollection(snapshot, {
  minCandles = 60,
  now = Date.now(),
  maxLatestAgeIntervals = 3,
} = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("snapshot must be an object");
  }
  if (!new Set(["CRYPTO_SPOT", "CRYPTO_FUTURES"]).has(snapshot.market)) {
    throw new TypeError("unsupported market");
  }
  if (typeof snapshot.symbol !== "string" || !/^[A-Z0-9]{3,30}$/.test(snapshot.symbol)) {
    throw new TypeError("invalid symbol");
  }
  const intervalMs = TIMEFRAME_MS[snapshot.timeframe];
  if (!intervalMs) throw new TypeError("unsupported timeframe");
  if (!Number.isInteger(minCandles) || minCandles < 60 || minCandles > 10_000) {
    throw new TypeError("minCandles must be between 60 and 10000");
  }
  if (!Number.isFinite(now) || now <= 0) throw new TypeError("now must be a positive finite timestamp");
  if (!Array.isArray(snapshot.candles) || snapshot.candles.length < minCandles) {
    throw new Error(`not enough candles: ${snapshot.candles?.length ?? 0} < ${minCandles}`);
  }

  let gaps = 0;
  let zeroVolume = 0;
  let maximumGapMs = 0;
  for (let index = 0; index < snapshot.candles.length; index += 1) {
    const candle = snapshot.candles[index];
    if (!candle || typeof candle !== "object" || Array.isArray(candle)) {
      throw new TypeError(`candles[${index}] must be an object`);
    }
    const timestamp = finite(candle.timestamp, `candles[${index}].timestamp`);
    const open = finite(candle.open, `candles[${index}].open`);
    const high = finite(candle.high, `candles[${index}].high`);
    const low = finite(candle.low, `candles[${index}].low`);
    const close = finite(candle.close, `candles[${index}].close`);
    const volume = finite(candle.volume, `candles[${index}].volume`);
    if (!Number.isInteger(timestamp) || timestamp <= 0) {
      throw new TypeError(`candles[${index}].timestamp is invalid`);
    }
    if ([open, high, low, close].some((value) => value <= 0)) {
      throw new TypeError(`candles[${index}] prices must be positive`);
    }
    if (volume < 0 || high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
      throw new TypeError(`candles[${index}] has invalid OHLCV relationships`);
    }
    if (volume === 0) zeroVolume += 1;
    if (index > 0) {
      const delta = timestamp - snapshot.candles[index - 1].timestamp;
      if (delta <= 0) throw new Error(`timestamps are not strictly increasing at index ${index}`);
      maximumGapMs = Math.max(maximumGapMs, delta);
      if (delta !== intervalMs) gaps += 1;
    }
  }

  const firstTimestamp = snapshot.candles[0].timestamp;
  const lastTimestamp = snapshot.candles.at(-1).timestamp;
  const latestAgeMs = now - lastTimestamp;
  if (latestAgeMs < -intervalMs) throw new Error("latest candle timestamp is unexpectedly in the future");
  if (latestAgeMs > intervalMs * maxLatestAgeIntervals) {
    throw new Error(`latest candle is stale by ${latestAgeMs}ms`);
  }
  if (gaps > 0) throw new Error(`timeframe gaps detected: ${gaps}`);

  return Object.freeze({
    status: "pass",
    provider: snapshot.provider ?? null,
    market: snapshot.market,
    symbol: snapshot.symbol,
    timeframe: snapshot.timeframe,
    candleCount: snapshot.candles.length,
    firstTimestamp,
    lastTimestamp,
    latestAgeMs,
    gaps,
    zeroVolume,
    maximumGapMs,
  });
}

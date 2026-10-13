// Public-only QA helpers. Upbit's 'timestamp' is the last trade tick, NOT
// the candle bucket start. Scanner needs candle_date_time_utc.
const SPOT_TIMEFRAMES = Object.freeze({ "15m": 15, "60m": 60, "4H": 240 });

export function spotPublicQaProfile(profile) {
  if (!profile || typeof profile !== "object") throw new Error("UPBIT_QA_PROFILE_REQUIRED");
  return profile.strategy === "SWING"
    ? Object.freeze({ ...profile, timeframe: "4H" })
    : Object.freeze({ ...profile });
}

export function upbitPublicQaCandleUrl(symbol, timeframe) {
  const market = encodeURIComponent("KRW-" + symbol);
  if (timeframe === "1D") {
    return "https://api.upbit.com/v1/candles/days?market=" + market + "&count=200";
  }
  const unit = SPOT_TIMEFRAMES[timeframe];
  if (!unit) throw new Error("UPBIT_QA_TIMEFRAME_UNSUPPORTED:" + timeframe);
  return "https://api.upbit.com/v1/candles/minutes/" + unit + "?market=" + market + "&count=200";
}

export function normalizeUpbitPublicQaCandles(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      // Only the official bucket-start timestamp is acceptable for signal QA.
      time: Date.parse(String(row?.candle_date_time_utc ?? "") + "Z"),
      open: Number(row?.opening_price),
      high: Number(row?.high_price),
      low: Number(row?.low_price),
      close: Number(row?.trade_price),
      volume: Number(row?.candle_acc_trade_volume),
      quoteVolume: Number(row?.candle_acc_trade_price) || null,
    }))
    .filter((row) => Number.isFinite(row.time) && row.time > 0 && row.close > 0)
    .sort((left, right) => left.time - right.time);
}

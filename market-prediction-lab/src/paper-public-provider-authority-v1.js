// Shared by public collection and the lifecycle's direct-call trust boundary.
const DAY_MS = 24 * 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export const PAPER_FORWARD_PROVIDER_AUTHORITY = Object.freeze({
  KR_STOCK: Object.freeze({ provider: "yahoo-public-chart", symbol: "005930", timeframe: "1d", intervalMs: DAY_MS, closeOffsetMs: 6.5 * 60 * 60 * 1000, maxAgeMs: 4 * DAY_MS }),
  US_STOCK: Object.freeze({ provider: "yahoo-public-chart", symbol: "SPY", timeframe: "1d", intervalMs: DAY_MS, closeOffsetMs: 6.5 * 60 * 60 * 1000, maxAgeMs: 4 * DAY_MS }),
  CRYPTO_SPOT: Object.freeze({ provider: "upbit-public-candles", symbol: "BTC", timeframe: "4h", intervalMs: FOUR_HOURS_MS, maxAgeMs: 8 * 60 * 60 * 1000 }),
  CRYPTO_FUTURES: Object.freeze({ provider: "bitget-public-v2", symbol: "BTCUSDT", timeframe: "4h", intervalMs: FOUR_HOURS_MS, maxAgeMs: 8 * 60 * 60 * 1000 }),
});

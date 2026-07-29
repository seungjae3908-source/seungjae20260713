import { timeframeToMs } from "./timeframes.js";

export function generateCandles({ count = 500, start = 100, timeframe = "15m", startTimestamp = 1_700_000_000_000, drift = 0.0004, volatility = 0.006 } = {}) {
  const interval = timeframeToMs(timeframe);
  const candles = [];
  let previousClose = start;
  for (let index = 0; index < count; index += 1) {
    const cycle = Math.sin(index * 0.37) * volatility;
    const impulse = Math.cos(index * 0.11) * volatility * 0.35;
    const open = previousClose;
    const close = Math.max(0.000001, open * (1 + drift + cycle * 0.12 + impulse * 0.08));
    const spread = volatility * (0.45 + Math.abs(Math.sin(index * 0.23)) * 0.35);
    const high = Math.max(open, close) * (1 + spread);
    const low = Math.min(open, close) * (1 - spread);
    const volume = 1000 * (1 + Math.abs(Math.sin(index * 0.19)) * 0.8);
    candles.push({ timestamp: startTimestamp + index * interval, open, high, low, close, volume });
    previousClose = close;
  }
  return candles;
}

export function toBitgetRows(candles) {
  return candles.map((candle) => [
    String(candle.timestamp), String(candle.open), String(candle.high), String(candle.low), String(candle.close), String(candle.volume),
  ]);
}

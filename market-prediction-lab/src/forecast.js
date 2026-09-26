import { clamp, round } from "./contracts.js";

const TIMEFRAME_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
});

function scenarioDrift(name, probabilities, volatility, horizon) {
  const directionalEdge = probabilities.bullish - probabilities.bearish;
  const baseTotal = clamp(directionalEdge * volatility * Math.sqrt(horizon) * 0.7, -0.12, 0.12);
  if (name === "bullish") return Math.max(baseTotal + volatility * Math.sqrt(horizon) * 0.9, volatility * 0.5) / horizon;
  if (name === "bearish") return Math.min(baseTotal - volatility * Math.sqrt(horizon) * 0.9, -volatility * 0.5) / horizon;
  return baseTotal / horizon;
}

function generatePath({ name, input, indicators, probabilities }) {
  const horizon = input.horizon;
  const interval = TIMEFRAME_MS[input.timeframe];
  const volatility = clamp(indicators.atrPct, 0.002, 0.12);
  const drift = scenarioDrift(name, probabilities, volatility, horizon);
  const start = input.candles.at(-1);
  const averageVolume = Math.max(indicators.averageVolume20, 0);
  const candles = [];
  let previousClose = start.close;

  for (let index = 1; index <= horizon; index += 1) {
    const wave = Math.sin(index * 1.618 + (name === "bullish" ? 0.4 : name === "bearish" ? 2.4 : 1.2));
    const wiggle = wave * volatility * 0.12;
    const open = previousClose;
    const close = Math.max(0.00000001, open * (1 + drift + wiggle));
    const expansion = volatility * (0.42 + (index / horizon) * 0.12);
    const upperWick = expansion * (0.55 + Math.abs(Math.sin(index * 0.73)) * 0.25);
    const lowerWick = expansion * (0.55 + Math.abs(Math.cos(index * 0.81)) * 0.25);
    const high = Math.max(open, close) * (1 + upperWick);
    const low = Math.max(0.00000001, Math.min(open, close) * (1 - lowerWick));
    const volumeMultiplier = 1 + Math.abs(drift) / volatility * 0.3 + Math.abs(wave) * 0.08;

    candles.push(Object.freeze({
      timestamp: start.timestamp + (interval * index),
      open: round(open, 8),
      high: round(high, 8),
      low: round(low, 8),
      close: round(close, 8),
      volume: round(averageVolume * volumeMultiplier, 4),
      estimated: true,
    }));
    previousClose = close;
  }

  const probability = probabilities[name === "neutral" ? "neutral" : name];
  return Object.freeze({
    name,
    probability: round(probability, 6),
    candles: Object.freeze(candles),
    finalReturn: round((candles.at(-1).close / start.close) - 1, 6),
  });
}

export function buildForecast(input, indicators, probabilities) {
  const scenarios = ["bullish", "neutral", "bearish"].map((name) =>
    generatePath({ name, input, indicators, probabilities }));
  const base = scenarios[1];
  const volatility = clamp(indicators.atrPct, 0.002, 0.12);
  const bands = base.candles.map((candle, index) => {
    const step = index + 1;
    const sigma = volatility * Math.sqrt(step);
    return Object.freeze({
      timestamp: candle.timestamp,
      median: candle.close,
      lower50: round(candle.close * (1 - sigma * 0.67), 8),
      upper50: round(candle.close * (1 + sigma * 0.67), 8),
      lower80: round(candle.close * (1 - sigma * 1.28), 8),
      upper80: round(candle.close * (1 + sigma * 1.28), 8),
    });
  });

  return Object.freeze({
    scenarios: Object.freeze(scenarios),
    forecastCandles: base.candles,
    uncertaintyBands: Object.freeze(bands),
  });
}

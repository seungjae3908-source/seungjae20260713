import { analyzeMarket } from "../src/engine.js";

function createCandles(count = 180, startPrice = 100) {
  const candles = [];
  let close = startPrice;
  const start = Date.UTC(2026, 0, 1);
  for (let index = 0; index < count; index += 1) {
    const open = close;
    const change = 0.0012 + Math.sin(index / 7) * 0.0025;
    close = open * (1 + change);
    candles.push({
      timestamp: start + index * 60 * 60 * 1000,
      open,
      high: Math.max(open, close) * 1.004,
      low: Math.min(open, close) * 0.996,
      close,
      volume: 1000 + index * 2 + Math.abs(Math.sin(index)) * 200,
    });
  }
  return candles;
}

const result = analyzeMarket({
  market: "CRYPTO_FUTURES",
  symbol: "BTCUSDT",
  timeframe: "1h",
  horizon: 8,
  candles: createCandles(),
  derivativesFeatures: {
    openInterestChange: 0.08,
    fundingRate: 0.0007,
    longShortRatio: 1.08,
    basisRate: 0.001,
  },
  marketFeatures: {
    benchmarkReturn: 0.01,
    sentimentScore: 0.15,
  },
  collectedAt: Date.UTC(2026, 6, 30),
  source: "smoke-fixture",
});

const probabilitySum = Object.values(result.probabilities).reduce((sum, value) => sum + value, 0);
if (Math.abs(probabilitySum - 1) > 0.00001) throw new Error("probabilities do not sum to one");
if (result.forecastCandles.length !== 8) throw new Error("unexpected forecast horizon");
console.log(JSON.stringify({
  ok: true,
  stance: result.stance,
  confidence: result.confidence,
  probabilities: result.probabilities,
  forecastCount: result.forecastCandles.length,
  modelVersion: result.modelVersion,
}, null, 2));

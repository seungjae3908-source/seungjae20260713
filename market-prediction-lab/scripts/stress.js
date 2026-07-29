import { performance } from "node:perf_hooks";
import { analyzeMarket } from "../src/engine.js";

function candles(kind, count = 240) {
  const result = [];
  let close = kind === "high-price" ? 100000 : 100;
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < count; i += 1) {
    const open = close;
    let change = 0;
    if (kind === "up") change = 0.001 + Math.sin(i / 5) * 0.003;
    if (kind === "down") change = -0.001 + Math.sin(i / 5) * 0.003;
    if (kind === "volatile") change = Math.sin(i * 1.7) * 0.04;
    if (kind === "flat") change = 0;
    if (kind === "high-price") change = Math.sin(i / 10) * 0.002;
    close = Math.max(0.00001, open * (1 + change));
    const wick = kind === "volatile" ? 0.06 : 0.005;
    result.push({
      timestamp: start + i * 15 * 60 * 1000,
      open,
      high: Math.max(open, close) * (1 + wick),
      low: Math.max(0.00000001, Math.min(open, close) * (1 - wick)),
      close,
      volume: kind === "flat" ? 0 : 1000 + (i % 20) * 25,
    });
  }
  return result;
}

const markets = ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"];
const timeframes = ["15m", "1h", "4h", "1d"];
const kinds = ["up", "down", "volatile", "flat", "high-price"];
let count = 0;
const before = process.memoryUsage().heapUsed;
const started = performance.now();
for (let loop = 0; loop < 100; loop += 1) {
  for (const market of markets) {
    for (const timeframe of timeframes) {
      for (const kind of kinds) {
        const result = analyzeMarket({
          market,
          symbol: market.includes("STOCK") ? "005930" : "BTCUSDT",
          timeframe,
          horizon: 12,
          candles: candles(kind),
          marketFeatures: {
            sentimentScore: loop % 2 ? 0.3 : -0.2,
            benchmarkReturn: 0.01,
            foreignNetRatio: 0.1,
            institutionNetRatio: -0.03,
          },
          derivativesFeatures: market === "CRYPTO_FUTURES" ? {
            openInterestChange: 0.08,
            fundingRate: 0.0008,
            longShortRatio: 1.12,
          } : undefined,
          collectedAt: Date.UTC(2026, 6, 30),
          source: "stress",
        });
        const sum = Object.values(result.probabilities).reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1) > 0.00001) throw new Error("bad probability sum");
        if (!Object.values(result.features).every(Number.isFinite)) throw new Error("non-finite feature");
        for (const candle of result.forecastCandles) {
          if (!(candle.high >= Math.max(candle.open, candle.close))) throw new Error("bad high");
          if (!(candle.low <= Math.min(candle.open, candle.close) && candle.low > 0)) throw new Error("bad low");
        }
        count += 1;
      }
    }
  }
}
const elapsed = performance.now() - started;
const after = process.memoryUsage().heapUsed;
console.log(JSON.stringify({
  ok: true,
  analyses: count,
  elapsedMs: Math.round(elapsed),
  averageMs: Number((elapsed / count).toFixed(4)),
  heapDeltaMb: Number(((after - before) / 1024 / 1024).toFixed(2)),
  rssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
}, null, 2));

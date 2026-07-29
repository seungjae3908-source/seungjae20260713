import { performance } from "node:perf_hooks";
import { normalizeCandleRows } from "../src/normalizers.js";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { walkForwardSplit } from "../src/walk-forward.js";
import { generateCandles, toBitgetRows } from "../src/synthetic-data.js";

const cases = [
  ["KR_STOCK", "005930", "1d", "canonical-object"],
  ["US_STOCK", "AAPL", "1d", "canonical-object"],
  ["CRYPTO_SPOT", "BTCUSDT", "4h", "bitget-array"],
  ["CRYPTO_FUTURES", "ETHUSDT", "15m", "bitget-array"],
];
let totalRecords = 0;
const started = performance.now();
for (const [market, symbol, timeframe, format] of cases) {
  const candles = generateCandles({ count: 1600, timeframe, drift: market.includes("STOCK") ? 0.00025 : 0.00005, volatility: market.includes("CRYPTO") ? 0.012 : 0.006 });
  const rows = format === "bitget-array" ? toBitgetRows(candles) : candles;
  const snapshot = normalizeCandleRows(rows, { market, symbol, timeframe, format, source: "stress" });
  const records = buildTrainingRecords(snapshot, { lookback: 200, horizon: 10, stride: 3 });
  const split = walkForwardSplit(records);
  if (!(split.report.trainLastFutureTimestamp < split.report.validationFirstAnchorTimestamp)) throw new Error("train/validation leakage detected");
  if (!(split.report.validationLastFutureTimestamp < split.report.testFirstAnchorTimestamp)) throw new Error("validation/test leakage detected");
  totalRecords += records.length;
}
const elapsedMs = performance.now() - started;
console.log(JSON.stringify({ cases: cases.length, totalRecords, elapsedMs: Number(elapsedMs.toFixed(2)), msPerRecord: Number((elapsedMs / totalRecords).toFixed(4)) }, null, 2));

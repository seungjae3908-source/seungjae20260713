import { normalizeCandleRows } from "../src/normalizers.js";
import { generateCandles } from "../src/synthetic-data.js";

let state = 0x9e3779b9;
function random() { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0xffffffff; }
const mutations = [
  (row) => ({ ...row, open: Number.NaN }),
  (row) => ({ ...row, volume: -1 }),
  (row) => ({ ...row, high: row.low - 1 }),
  (row) => ({ ...row, timestamp: 0 }),
  (row) => ({ ...row, close: "not-a-number" }),
  () => null,
];
let rejected = 0;
let accepted = 0;
for (let iteration = 0; iteration < 5000; iteration += 1) {
  const rows = generateCandles({ count: 80, drift: (random() - 0.5) * 0.002, volatility: 0.002 + random() * 0.02 });
  if (random() < 0.7) {
    const index = Math.floor(random() * rows.length);
    rows[index] = mutations[Math.floor(random() * mutations.length)](rows[index]);
  }
  try {
    const snapshot = normalizeCandleRows(rows, { market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m", format: "canonical-object", strict: true });
    if (snapshot.candles.some((candle) => !Number.isFinite(candle.close))) throw new Error("non-finite candle escaped validation");
    accepted += 1;
  } catch (error) {
    if (!(error instanceof Error)) throw new Error("normalizer threw a non-Error value");
    rejected += 1;
  }
}
if (accepted === 0 || rejected === 0) throw new Error("fuzz coverage did not exercise both accepted and rejected paths");
console.log(JSON.stringify({ iterations: accepted + rejected, accepted, rejected }, null, 2));

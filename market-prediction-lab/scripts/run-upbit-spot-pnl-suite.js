import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";
import { optimizeCryptoSpotPnl } from "../src/crypto-spot-pnl-optimizer.js";

const DAY = 86_400_000;
const SYMBOLS = Object.freeze(["BTC", "ETH"]);

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const output = resolve(process.argv[2] ?? "docs/upbit-spot-pnl-suite-result.json");
const endTime = Date.now();
const startTime = endTime - 730 * DAY;

try {
  const datasets = [];
  const collection = {};
  for (const symbol of SYMBOLS) {
    const history = await collectUpbitSpotHistory({ symbol, startTime, endTime, maxPages: 40, minIntervalMs: 120 });
    datasets.push({ symbol, candles: history.candles });
    collection[symbol] = {
      candleCount: history.candleCount,
      pageCount: history.pageCount,
      firstTimestamp: history.firstTimestamp,
      lastTimestamp: history.lastTimestamp,
    };
  }
  const result = optimizeCryptoSpotPnl({
    datasets,
    costRatePerSide: 0.0015,
    stressMultiplier: 1.5,
    grid: {
      breakoutLookback: [12, 24, 48],
      maPeriod: [24, 60],
      atrStopMultiplier: [1.5, 2, 2.5],
      rewardRisk: [1.5, 2],
      maxHoldBars: [6, 12, 24],
      minRelativeVolume: [1, 1.2],
      maxGapPercent: [2, 4],
    },
  });
  const report = {
    schemaVersion: 1,
    status: "pass",
    market: "CRYPTO_SPOT",
    exchange: "UPBIT",
    timeframe: "4h",
    requestedDays: 730,
    symbols: SYMBOLS,
    collection,
    pnlResearch: result,
    researchOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
  };
  await save(output, report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    schemaVersion: 1,
    status: "fail",
    market: "CRYPTO_SPOT",
    exchange: "UPBIT",
    stage: "cost_aware_pnl_oos",
    message: String(error?.message ?? error).slice(0, 1000),
    researchOnly: true,
    liveExecutionAllowed: false,
  };
  await save(output, report);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}

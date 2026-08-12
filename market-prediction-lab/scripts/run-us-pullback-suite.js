import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { optimizeUsStockPullback } from "../src/stock-pullback-optimizer.js";

const DAY = 86_400_000;
const SEED = Object.freeze(["AAPL", "MSFT", "NVDA"]);
const HOLDOUT = Object.freeze(["AMZN", "GOOGL", "META", "JPM", "XOM"]);

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function collect(symbols, startTime, endTime) {
  const datasets = [];
  for (const symbol of symbols) {
    const history = await collectYahooStockHistory({ market: "US_STOCK", symbol, startTime, endTime });
    datasets.push({ symbol, candles: history.candles });
  }
  return datasets;
}

const output = resolve(process.argv[2] ?? "docs/us-pullback-suite-result.json");
const endTime = Date.now();
const startTime = endTime - 3650 * DAY;

try {
  const seedDatasets = await collect(SEED, startTime, endTime);
  const holdoutDatasets = await collect(HOLDOUT, startTime, endTime);
  const result = optimizeUsStockPullback({
    seedDatasets,
    holdoutDatasets,
    costRatePerSide: 0.0015,
    stressMultiplier: 1.5,
    grid: {
      trendMaPeriod: [50, 100, 200],
      pullbackLookback: [5, 10],
      maxPullbackAtr: [1.5, 2.5],
      atrStopMultiplier: [1.5, 2.5],
      rewardRisk: [1.5, 2],
      maxHoldBars: [5, 10],
      minRelativeVolume: [0.8, 1],
      maxGapPercent: [4],
    },
  });
  const report = {
    schemaVersion: 1,
    status: "pass",
    market: "US_STOCK",
    strategyFamily: "trend_pullback",
    seedSymbols: SEED,
    holdoutSymbols: HOLDOUT,
    result,
    researchOnly: true,
    liveExecutionAllowed: false,
    note: "A research candidate here is not a live/shadow promotion because the strategy family was introduced after an earlier breakout-family failure.",
  };
  await save(output, report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    schemaVersion: 1,
    status: "fail",
    market: "US_STOCK",
    strategyFamily: "trend_pullback",
    stage: "cross_symbol_research",
    message: String(error?.message ?? error).slice(0, 1000),
    researchOnly: true,
    liveExecutionAllowed: false,
  };
  await save(output, report);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}

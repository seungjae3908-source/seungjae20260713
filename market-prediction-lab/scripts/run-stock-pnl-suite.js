import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { optimizeStockSwingMarket } from "../src/stock-swing-optimizer.js";

const DAY = 86_400_000;
const SPECS = {
  KR_STOCK: {
    symbols: ["005930", "000660", "035420"],
    costRatePerSide: 0.0025,
    grid: {
      breakoutLookback: [10, 20, 40], maPeriod: [20, 60], atrStopMultiplier: [1.5, 2, 2.5],
      rewardRisk: [1.5, 2], maxHoldBars: [5, 10, 20], minRelativeVolume: [1, 1.2], maxGapPercent: [3, 5],
    },
  },
  US_STOCK: {
    symbols: ["AAPL", "MSFT", "NVDA"],
    costRatePerSide: 0.0015,
    grid: {
      breakoutLookback: [10, 20, 40], maPeriod: [20, 60], atrStopMultiplier: [1.5, 2, 2.5],
      rewardRisk: [1.5, 2], maxHoldBars: [5, 10, 20], minRelativeVolume: [1, 1.2], maxGapPercent: [4, 7],
    },
  },
};

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const output = resolve(process.argv[2] ?? "docs/stock-pnl-suite-result.json");
const endTime = Date.now();
const startTime = endTime - 3650 * DAY;
const markets = {};
for (const [market, spec] of Object.entries(SPECS)) {
  try {
    const datasets = [];
    for (const symbol of spec.symbols) {
      const history = await collectYahooStockHistory({ market, symbol, startTime, endTime });
      datasets.push({ symbol, candles: history.candles });
    }
    markets[market] = optimizeStockSwingMarket({
      market, datasets, costRatePerSide: spec.costRatePerSide, stressMultiplier: 1.5, grid: spec.grid,
    });
  } catch (error) {
    markets[market] = { status: "technical_failure", message: String(error?.message ?? error).slice(0, 500) };
  }
}
const report = {
  schemaVersion: 1,
  status: Object.values(markets).some((value) => value.status === "technical_failure") ? "fail" : "pass",
  researchOnly: true,
  methodology: "close signal -> next session open entry; ATR stop/target; train/validation selection; untouched test; 1.5x cost stress",
  costNote: "Cost rates are research stress assumptions, not broker fee schedules.",
  markets,
};
await save(output, report);
console.log(JSON.stringify(report, null, 2));
if (report.status !== "pass") process.exitCode = 1;

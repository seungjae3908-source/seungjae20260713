import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { optimizeStockRegimeRouter } from "../src/stock-regime-router-optimizer.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SPECS = Object.freeze({
  KR_STOCK: Object.freeze({
    seedSymbols: Object.freeze(["005930", "000660", "035420"]),
    holdoutSymbols: Object.freeze(["005380", "000270", "051910", "068270", "105560", "055550", "035720"]),
    costRatePerSide: 0.0025,
    grid: Object.freeze({
      regimeLookback: [20, 40],
      regimeMaPeriod: [50, 100],
      trendEfficiencyMin: [0.25, 0.35],
      rangeEfficiencyMax: [0.12, 0.20],
      trendMaxPullbackAtr: [1.5, 2.5],
      trendMinRelativeVolume: [0.8],
      trendStopAtr: [2],
      trendRewardRisk: [1.5, 2],
      rangeEntryZ: [-1.5, -2],
      rangeExitZ: [0],
      rangeStopAtr: [2],
      maxHoldBars: [10, 20],
      maxGapPercent: [4],
    }),
  }),
  US_STOCK: Object.freeze({
    seedSymbols: Object.freeze(["AAPL", "MSFT", "NVDA"]),
    holdoutSymbols: Object.freeze(["AMZN", "GOOGL", "META", "JPM", "XOM"]),
    costRatePerSide: 0.0015,
    grid: Object.freeze({
      regimeLookback: [20, 40],
      regimeMaPeriod: [50, 100],
      trendEfficiencyMin: [0.25, 0.35],
      rangeEfficiencyMax: [0.12, 0.20],
      trendMaxPullbackAtr: [1.5, 2.5],
      trendMinRelativeVolume: [0.8],
      trendStopAtr: [2],
      trendRewardRisk: [1.5, 2],
      rangeEntryZ: [-1.5, -2],
      rangeExitZ: [0],
      rangeStopAtr: [2],
      maxHoldBars: [10, 20],
      maxGapPercent: [4],
    }),
  }),
});

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error).slice(0, 1200),
    details: error?.details ?? null,
    stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 10) : [],
  };
}

async function collectDatasets({ market, symbols, startTime, endTime }) {
  const datasets = [];
  for (const symbol of symbols) {
    const history = await collectYahooStockHistory({ market, symbol, startTime, endTime });
    datasets.push(Object.freeze({
      symbol,
      candles: history.candles,
      report: Object.freeze({
        symbol,
        providerSymbol: history.providerSymbol,
        candleCount: history.candleCount,
        firstTimestamp: history.firstTimestamp,
        lastTimestamp: history.lastTimestamp,
        source: history.source,
      }),
    }));
  }
  return Object.freeze(datasets);
}

const output = resolve(process.argv[2] ?? "docs/stock-regime-suite-result.json");
const endTime = Date.now();
const startTime = endTime - 3650 * DAY_MS;
const markets = {};

for (const [market, spec] of Object.entries(SPECS)) {
  try {
    const seedDatasets = await collectDatasets({ market, symbols: spec.seedSymbols, startTime, endTime });
    const holdoutDatasets = await collectDatasets({ market, symbols: spec.holdoutSymbols, startTime, endTime });
    const result = optimizeStockRegimeRouter({
      market,
      seedDatasets,
      holdoutDatasets,
      costRatePerSide: spec.costRatePerSide,
      stressMultiplier: 1.5,
      grid: spec.grid,
    });
    markets[market] = Object.freeze({
      ...result,
      seedSymbols: spec.seedSymbols,
      holdoutSymbols: spec.holdoutSymbols,
      datasets: Object.freeze([...seedDatasets, ...holdoutDatasets].map((dataset) => dataset.report)),
      survivorshipProtection: Object.freeze({
        pointInTimeConstituentUniverse: false,
        delistedNamesIntegrated: false,
        blocksExecutionPromotion: true,
      }),
    });
  } catch (error) {
    markets[market] = Object.freeze({ status: "technical_failure", error: serializeError(error) });
  }
}

const technicalFailure = Object.values(markets).some((value) => value.status === "technical_failure");
const report = Object.freeze({
  schemaVersion: 1,
  status: technicalFailure ? "fail" : "pass",
  researchOnly: true,
  liveExecutionAllowed: false,
  privateAccountRequestAllowed: false,
  methodology: "market-specific regime routing: trend regime -> pullback/recovery; range regime -> z-score mean reversion; train/validation selection on seed symbols only; untouched seed test; cost stress; unseen-symbol holdout; holdout stress; fixed-parameter time rolling",
  safeguards: Object.freeze({
    krAndUsOptimizedSeparately: true,
    holdoutUsedForSelection: false,
    testUsedForSelection: false,
    parametersRetunedOnHoldout: false,
    pointInTimeUniverseStillMissing: true,
    actualOrders: 0,
    privateAccountRequests: 0,
  }),
  markets,
});
await save(output, report);
console.log(JSON.stringify(report, null, 2));
if (technicalFailure) process.exitCode = 1;

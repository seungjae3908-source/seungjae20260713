import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { optimizeKrCrossSectionalMomentum } from "../src/kr-cross-sectional-momentum.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DESIGN_SYMBOLS = Object.freeze([
  "005490", // POSCO Holdings
  "012330", // Hyundai Mobis
  "066570", // LG Electronics
  "028260", // Samsung C&T
  "032830", // Samsung Life
  "086790", // Hana Financial
  "017670", // SK Telecom
  "096770", // SK Innovation
]);
const HOLDOUT_SYMBOLS = Object.freeze([
  "009150", // Samsung Electro-Mechanics
  "018260", // Samsung SDS
  "030200", // KT
  "034730", // SK Inc.
  "010950", // S-Oil
  "011170", // Lotte Chemical
  "024110", // Industrial Bank of Korea
  "033780", // KT&G
]);
const PREVIOUS_RESEARCH_SYMBOLS = Object.freeze([
  "005930", "000660", "035420", "005380", "000270", "051910", "068270", "105560", "055550", "035720",
]);

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error).slice(0, 1200),
    details: error?.details ?? null,
    stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 12) : [],
  };
}

async function collect(symbols, startTime, endTime) {
  const datasets = [];
  for (const symbol of symbols) {
    const history = await collectYahooStockHistory({ market: "KR_STOCK", symbol, startTime, endTime });
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

const output = resolve(process.argv[2] ?? "docs/kr-cross-sectional-momentum-suite-result.json");
const endTime = Date.now();
const startTime = endTime - 3650 * DAY_MS;
let report;

try {
  const prior = new Set(PREVIOUS_RESEARCH_SYMBOLS);
  if ([...DESIGN_SYMBOLS, ...HOLDOUT_SYMBOLS].some((symbol) => prior.has(symbol))) throw new Error("KR_MOMENTUM_FRESH_UNIVERSE_OVERLAP");
  const designDatasets = await collect(DESIGN_SYMBOLS, startTime, endTime);
  const holdoutDatasets = await collect(HOLDOUT_SYMBOLS, startTime, endTime);
  const result = optimizeKrCrossSectionalMomentum({
    designDatasets,
    holdoutDatasets,
    costRatePerSide: 0.0025,
    stressMultiplier: 1.5,
    grid: {
      momentumLookback: [60, 120, 180],
      trendMaPeriod: [100, 200],
      topCount: [2, 3],
      rebalanceBars: [20, 40],
      stopAtrMultiple: [2.5, 3.5],
    },
  });
  report = Object.freeze({
    schemaVersion: 1,
    status: "pass",
    researchOnly: true,
    market: "KR_STOCK",
    family: "cross_sectional_relative_strength",
    result,
    datasets: Object.freeze({
      design: designDatasets.map((row) => row.report),
      holdout: holdoutDatasets.map((row) => row.report),
    }),
    provenance: Object.freeze({
      previousRegimeResearchSymbolsExcluded: true,
      previousResearchSymbols: PREVIOUS_RESEARCH_SYMBOLS,
      designSymbols: DESIGN_SYMBOLS,
      holdoutSymbols: HOLDOUT_SYMBOLS,
      holdoutUsedForSelection: false,
      parametersRetunedOnHoldout: false,
      publicDataOnly: true,
    }),
    safeguards: Object.freeze({
      actualOrders: 0,
      privateAccountRequests: 0,
      liveExecutionAllowed: false,
      mainMergePerformed: false,
    }),
  });
} catch (error) {
  report = Object.freeze({
    schemaVersion: 1,
    status: "fail",
    researchOnly: true,
    market: "KR_STOCK",
    error: serializeError(error),
    safeguards: Object.freeze({ actualOrders: 0, privateAccountRequests: 0, liveExecutionAllowed: false }),
  });
  process.exitCode = 1;
}

await save(output, report);
console.log(JSON.stringify(report, null, 2));

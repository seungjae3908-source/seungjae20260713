import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";
import { optimizeSpotAlternativeStrategies } from "../src/crypto-spot-alternative-optimizer.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SEED_SYMBOLS = Object.freeze(["BTC", "ETH"]);
const HOLDOUT_SYMBOLS = Object.freeze(["XRP", "SOL"]);

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

async function collect(symbol, startTime, endTime) {
  const history = await collectUpbitSpotHistory({
    symbol,
    startTime,
    endTime,
    maxPages: 40,
    minIntervalMs: 120,
  });
  return Object.freeze({
    symbol,
    candles: history.candles,
    report: Object.freeze({
      symbol,
      providerMarket: history.providerMarket,
      candleCount: history.candleCount,
      pageCount: history.pageCount,
      firstTimestamp: history.firstTimestamp,
      lastTimestamp: history.lastTimestamp,
    }),
  });
}

const output = resolve(process.argv[2] ?? "docs/upbit-spot-alternative-suite-result.json");
const endTime = Date.now();
const startTime = endTime - 730 * DAY_MS;
let report;

try {
  const seedDatasets = [];
  const holdoutDatasets = [];
  for (const symbol of SEED_SYMBOLS) seedDatasets.push(await collect(symbol, startTime, endTime));
  for (const symbol of HOLDOUT_SYMBOLS) holdoutDatasets.push(await collect(symbol, startTime, endTime));
  const result = optimizeSpotAlternativeStrategies({
    seedDatasets,
    holdoutDatasets,
    costRatePerSide: 0.0015,
    stressMultiplier: 1.5,
  });
  report = Object.freeze({
    schemaVersion: 1,
    status: "pass",
    researchOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    methodology: "BTC+ETH seed train/validation family selection across independent trend-pullback and mean-reversion families -> untouched seed test -> 1.5x cost stress -> unseen XRP+SOL holdout -> holdout stress -> fixed-parameter future-time rolling",
    safeguards: Object.freeze({
      longOnly: true,
      xrpSolUsedForSelection: false,
      seedTestUsedForSelection: false,
      familyChosenOnValidationOnly: true,
      actualOrders: 0,
      privateAccountRequests: 0,
    }),
    result,
    datasets: Object.freeze([...seedDatasets, ...holdoutDatasets].map((dataset) => dataset.report)),
  });
} catch (error) {
  report = Object.freeze({
    schemaVersion: 1,
    status: "fail",
    researchOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    error: serializeError(error),
  });
}

await save(output, report);
console.log(JSON.stringify(report, null, 2));
if (report.status !== "pass") process.exitCode = 1;

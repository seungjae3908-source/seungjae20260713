import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import {
  advanceUsStockForwardState,
  createUsStockForwardState,
  summarizeUsStockForwardState,
} from "../src/us-stock-forward-validation.js";
import {
  US_STOCK_FORWARD_CANDIDATE,
  US_STOCK_FORWARD_CANDIDATE_SHA256,
  US_STOCK_FORWARD_START,
} from "../src/us-stock-forward-candidate.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CONSERVATIVE_DAILY_CLOSE_LAG_MS = 12 * 60 * 60 * 1000;

async function readJsonOptional(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomically(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

function markClosedCandles(candles, cycleTime) {
  return Object.freeze(candles.map((candle, index) => Object.freeze({
    ...candle,
    isClosed: index < candles.length - 1 || cycleTime - candle.timestamp >= CONSERVATIVE_DAILY_CLOSE_LAG_MS,
    observedAt: cycleTime,
  })));
}

const statePath = resolve(process.argv[2] ?? "docs/us-stock-forward-state.json");
const summaryPath = resolve(process.argv[3] ?? "docs/us-stock-forward-summary.json");
const cycleTime = Date.now();
if (cycleTime < US_STOCK_FORWARD_START) throw new Error("US_STOCK_FORWARD_NOT_STARTED");

const previous = await readJsonOptional(statePath, null);
const state = previous ?? createUsStockForwardState(cycleTime);
if (state.candidateId !== US_STOCK_FORWARD_CANDIDATE.id || state.candidateManifestSha256 !== US_STOCK_FORWARD_CANDIDATE_SHA256) {
  throw new Error("US_STOCK_FORWARD_STATE_CANDIDATE_MISMATCH");
}

const startTime = cycleTime - 420 * DAY_MS;
const candlesBySymbol = {};
const datasets = [];
for (const symbol of US_STOCK_FORWARD_CANDIDATE.prospectiveOnlySymbols) {
  const history = await collectYahooStockHistory({
    market: "US_STOCK",
    symbol,
    startTime,
    endTime: cycleTime,
  });
  candlesBySymbol[symbol] = markClosedCandles(history.candles, cycleTime);
  datasets.push(Object.freeze({
    symbol,
    providerSymbol: history.providerSymbol,
    source: history.source,
    candleCount: history.candleCount,
    firstTimestamp: history.firstTimestamp,
    lastTimestamp: history.lastTimestamp,
    lastMarkedClosed: candlesBySymbol[symbol].at(-1)?.isClosed === true,
  }));
}

const nextState = advanceUsStockForwardState({ state, candlesBySymbol, cycleTime });
const forward = summarizeUsStockForwardState(nextState);
const summary = Object.freeze({
  schemaVersion: 1,
  status: "pass",
  generatedAt: cycleTime,
  candidate: Object.freeze({
    id: US_STOCK_FORWARD_CANDIDATE.id,
    manifestSha256: US_STOCK_FORWARD_CANDIDATE_SHA256,
    sourceResearchSha: US_STOCK_FORWARD_CANDIDATE.sourceResearchSha,
    sourceRunId: US_STOCK_FORWARD_CANDIDATE.sourceRunId,
    params: US_STOCK_FORWARD_CANDIDATE.params,
    prospectiveOnlySymbols: US_STOCK_FORWARD_CANDIDATE.prospectiveOnlySymbols,
  }),
  forward,
  datasets: Object.freeze(datasets),
  safeguards: Object.freeze({
    forwardStart: US_STOCK_FORWARD_START,
    conservativeDailyCloseLagMs: CONSERVATIVE_DAILY_CLOSE_LAG_MS,
    parametersRetunedAfterFreeze: false,
    historicalProspectiveSymbolsUsedForSelection: false,
    lateSignalsBackfilled: false,
    currentConstituentSurvivorshipGateSatisfied: false,
    pointInTimeMembershipStillRequired: true,
    costAwareProspectivePnlStillRequired: true,
    publicMarketDataOnly: true,
    actualOrders: 0,
    privateAccountRequests: 0,
    liveExecutionAllowed: false,
  }),
});

await writeJsonAtomically(statePath, nextState);
await writeJsonAtomically(summaryPath, summary);
console.log(JSON.stringify(summary, null, 2));

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import {
  advanceUsStockForwardState,
  createUsStockForwardState,
  summarizeUsStockForwardState,
} from "../src/us-stock-forward-validation.js";
import {
  advanceUsStockForwardPnlState,
  createUsStockForwardPnlState,
  summarizeUsStockForwardPnlState,
} from "../src/us-stock-forward-pnl-shadow.js";
import { evaluateUsStockResearchPromotion } from "../src/us-stock-research-promotion-gate.js";
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

function unresolvedBiasAudit() {
  return Object.freeze({
    schemaVersion: 1,
    market: "US_STOCK",
    status: "research_hold",
    executionPromotionAllowed: false,
    researchOnly: true,
    gates: Object.freeze({
      pointInTimeMembershipsPresent: false,
      removedNamesPresent: false,
      membershipHistoryCoveragePassed: false,
      removedNameHistoryCoveragePassed: false,
    }),
    reasons: Object.freeze([
      "authoritative_point_in_time_membership_evidence_missing",
      "authoritative_removed_name_history_evidence_missing",
    ]),
    safeguards: Object.freeze({
      currentConstituentListAloneCannotPass: true,
      missingHistoriesFailClosed: true,
      liveExecutionAllowed: false,
      privateAccountRequestAllowed: false,
      actualOrders: 0,
    }),
  });
}

const statePath = resolve(process.argv[2] ?? "docs/us-stock-forward-state.json");
const summaryPath = resolve(process.argv[3] ?? "docs/us-stock-forward-summary.json");
const pnlStatePath = resolve(process.argv[4] ?? "docs/us-stock-forward-pnl-state.json");
const pnlSummaryPath = resolve(process.argv[5] ?? "docs/us-stock-forward-pnl-summary.json");
const biasPath = resolve(process.argv[6] ?? "docs/us-stock-universe-bias-audit.json");
const promotionPath = resolve(process.argv[7] ?? "docs/us-stock-research-promotion.json");
const cycleTime = Date.now();
if (cycleTime < US_STOCK_FORWARD_START) throw new Error("US_STOCK_FORWARD_NOT_STARTED");

const previous = await readJsonOptional(statePath, null);
const state = previous ?? createUsStockForwardState(cycleTime);
if (state.candidateId !== US_STOCK_FORWARD_CANDIDATE.id || state.candidateManifestSha256 !== US_STOCK_FORWARD_CANDIDATE_SHA256) {
  throw new Error("US_STOCK_FORWARD_STATE_CANDIDATE_MISMATCH");
}
const previousPnl = await readJsonOptional(pnlStatePath, null);
const pnlState = previousPnl ?? createUsStockForwardPnlState(cycleTime);
if (pnlState.candidateId !== US_STOCK_FORWARD_CANDIDATE.id || pnlState.candidateManifestSha256 !== US_STOCK_FORWARD_CANDIDATE_SHA256) {
  throw new Error("US_STOCK_FORWARD_PNL_STATE_CANDIDATE_MISMATCH");
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
const nextPnlState = advanceUsStockForwardPnlState({
  state: pnlState,
  signalState: nextState,
  candlesBySymbol,
  cycleTime,
});
const pnl = summarizeUsStockForwardPnlState(nextPnlState);
const biasAudit = await readJsonOptional(biasPath, unresolvedBiasAudit());
const promotion = evaluateUsStockResearchPromotion({
  biasAudit,
  signalShadow: forward,
  pnlShadow: pnl,
});
const summary = Object.freeze({
  schemaVersion: 3,
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
  pnl,
  biasAudit,
  promotion,
  datasets: Object.freeze(datasets),
  safeguards: Object.freeze({
    forwardStart: US_STOCK_FORWARD_START,
    conservativeDailyCloseLagMs: CONSERVATIVE_DAILY_CLOSE_LAG_MS,
    parametersRetunedAfterFreeze: false,
    historicalProspectiveSymbolsUsedForSelection: false,
    lateSignalsBackfilled: false,
    nextSessionOpenEntryOnly: true,
    sameBarStopFirstConservative: true,
    baseCostRatePerSide: US_STOCK_FORWARD_CANDIDATE.costRatePerSide,
    stressMultiplier: US_STOCK_FORWARD_CANDIDATE.stressMultiplier,
    currentConstituentSurvivorshipGateSatisfied: promotion.gates.pointInTimeBiasPassed,
    pointInTimeMembershipStillRequired: !promotion.gates.pointInTimeBiasPassed,
    costAwareProspectivePnlShadowActive: true,
    publicMarketDataOnly: true,
    actualOrders: 0,
    privateAccountRequests: 0,
    liveExecutionAllowed: false,
  }),
});

await writeJsonAtomically(statePath, nextState);
await writeJsonAtomically(summaryPath, summary);
await writeJsonAtomically(pnlStatePath, nextPnlState);
await writeJsonAtomically(pnlSummaryPath, pnl);
await writeJsonAtomically(promotionPath, promotion);
console.log(JSON.stringify(summary, null, 2));

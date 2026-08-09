import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetUtcDailyForwardCandles } from "../src/bitget-forward-daily-candles.js";
import { collectFundingRateHistory } from "../src/derivatives-history.js";
import {
  ETH_V6_FORWARD_CANDIDATE,
  ETH_V6_FORWARD_START,
  advanceEthV6ForwardState,
  createEthV6ForwardState,
  summarizeEthV6ForwardState,
} from "../src/eth-v6-forward-validation.js";
import { FROZEN_CANDIDATE_MANIFEST_SHA256 } from "../src/final-holdout-evaluator.js";
import { NET_PROFITABLE_RATE_DEFINITION } from "../src/research-metric-semantics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 180;
const UTC_FORWARD_DATA_CONTRACT = Object.freeze({
  version: 1,
  timeframe: "1d",
  timezone: "UTC",
  granularity: "1Dutc",
  closedHistorySource: "bitget-public-history-candles",
  currentOpenSource: "bitget-public-candles",
});
const replayPath = resolve(process.argv[2] ?? "docs/eth-v6-replay-proof.json");
const statePath = resolve(process.argv[3] ?? "docs/eth-v6-forward-state.json");
const summaryPath = resolve(process.argv[4] ?? "docs/eth-v6-forward-summary.json");
const markdownPath = resolve(process.argv[5] ?? "docs/eth-v6-forward-summary.md");
const cycleTime = Date.now();

async function readJsonOptional(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function iso(timestamp) {
  return timestamp ? new Date(timestamp).toISOString() : "-";
}

function format(value, digits = 2) {
  if (value === null || value === undefined) return "-";
  if (value === Number.POSITIVE_INFINITY) return "∞";
  if (!Number.isFinite(value)) return "-";
  return Number(value).toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function hasUtcDataContract(state) {
  return state?.dataContract?.version === UTC_FORWARD_DATA_CONTRACT.version
    && state?.dataContract?.timeframe === UTC_FORWARD_DATA_CONTRACT.timeframe
    && state?.dataContract?.timezone === UTC_FORWARD_DATA_CONTRACT.timezone
    && state?.dataContract?.granularity === UTC_FORWARD_DATA_CONTRACT.granularity;
}

function prepareUtcForwardState(previous, candlesResult) {
  if (hasUtcDataContract(previous)) return previous;
  const existingRecords = previous?.ledger?.records?.length ?? 0;
  const existingMissedSignals = previous?.missedSignals?.length ?? 0;
  if (previous && (existingRecords > 0 || existingMissedSignals > 0)) {
    throw new Error(`refusing UTC forward cutover with existing legacy evidence: records=${existingRecords}, missed=${existingMissedSignals}`);
  }
  const base = createEthV6ForwardState(cycleTime);
  const priorUtcSignalBoundary = Math.max(ETH_V6_FORWARD_START - 1, candlesResult.currentOpenTimestamp - 2 * DAY_MS);
  return Object.freeze({
    ...base,
    lastSignalEvaluated: priorUtcSignalBoundary,
    dataContract: UTC_FORWARD_DATA_CONTRACT,
    cutover: Object.freeze({
      resetAt: cycleTime,
      previousLegacyStateDiscarded: Boolean(previous),
      previousLegacyRecordCount: existingRecords,
      previousLegacyMissedSignalCount: existingMissedSignals,
      reason: "align_forward_validation_with_frozen_utc_daily_contract",
      historicalMetricsReused: false,
      parametersChanged: false,
      holdoutReusedForSelection: false,
    }),
  });
}

const replay = await readJsonOptional(replayPath);
if (!replay || replay.status !== "passed") throw new Error("ETH V6 deterministic replay proof must pass before Paper/Shadow starts");
if (replay.strategyId !== ETH_V6_FORWARD_CANDIDATE.id || replay.candidateManifestSha256 !== FROZEN_CANDIDATE_MANIFEST_SHA256) {
  throw new Error("ETH V6 replay proof does not match the frozen candidate manifest");
}

const previous = await readJsonOptional(statePath, null);
const client = new BitgetPublicClient({ minIntervalMs: 180, maxRetries: 4, timeoutMs: 15_000 });
const candlesResult = await collectBitgetUtcDailyForwardCandles({
  client,
  symbol: "ETHUSDT",
  productType: "usdt-futures",
  asOf: cycleTime,
  lookbackDays: LOOKBACK_DAYS,
  minimumClosedCandles: 60,
});
if (!Array.isArray(candlesResult.candles) || candlesResult.closedCandleCount < 60) throw new Error("ETH V6 forward cycle has insufficient UTC daily candle history");

const funding = await collectFundingRateHistory({
  client,
  symbol: "ETHUSDT",
  productType: "usdt-futures",
  startTime: Math.max(ETH_V6_FORWARD_START - 7 * DAY_MS, cycleTime - 120 * DAY_MS),
  endTime: cycleTime,
  pageSize: 100,
  maxPages: 20,
});

const state = advanceEthV6ForwardState({
  state: prepareUtcForwardState(previous, candlesResult),
  candles: candlesResult.candles,
  fundingRates: funding.records,
  cycleTime,
});
const summary = summarizeEthV6ForwardState(state);

const report = Object.freeze({
  ...summary,
  dataContract: state.dataContract,
  cutover: state.cutover ?? null,
  netProfitableRateDefinition: NET_PROFITABLE_RATE_DEFINITION,
  replay: Object.freeze({ status: replay.status, generatedAt: replay.generatedAt, usedForSelection: false }),
  data: Object.freeze({
    provider: candlesResult.provider,
    timezone: candlesResult.timezone,
    granularity: candlesResult.granularity,
    candleCount: candlesResult.candles.length,
    closedCandleCount: candlesResult.closedCandleCount,
    currentOpenTimestamp: candlesResult.currentOpenTimestamp,
    firstCandle: candlesResult.candles[0]?.timestamp ?? null,
    lastCandle: candlesResult.candles.at(-1)?.timestamp ?? null,
    fundingRecords: funding.records.length,
    fundingFirst: funding.records[0]?.timestamp ?? null,
    fundingLast: funding.records.at(-1)?.timestamp ?? null,
    collectedAt: cycleTime,
  }),
  stages: Object.freeze({
    replay: Object.freeze({ passed: true, evidence: "docs/eth-v6-replay-proof.json" }),
    paper: Object.freeze({ passed: false, status: summary.status, forwardOnly: true, simulatedCapital: true }),
    shadow: Object.freeze({ passed: false, status: summary.status, forwardOnly: true, orderSubmitted: false }),
  }),
  liveOrderAllowed: false,
  privateAccountRequestAllowed: false,
});

const markdown = `# ETHUSDT V6 Forward Paper / Shadow\n\n`
  + `- candidate: **${report.candidateId}**\n`
  + `- frozen manifest: \`${report.candidateManifestSha256}\`\n`
  + `- replay: **passed** / selection 사용: false\n`
  + `- forward validation start: ${iso(report.startedAt)}\n`
  + `- data contract: ${report.data.granularity} / timezone ${report.data.timezone} / current open ${iso(report.data.currentOpenTimestamp)}\n`
  + `- UTC cutover reset: ${report.cutover?.previousLegacyStateDiscarded === true ? "yes (legacy evidence was empty)" : "no"} / historical metrics reused: false\n`
  + `- last signal evaluated: ${iso(report.lastSignalEvaluated)}\n`
  + `- signals: ${report.signalsRecorded} / settled: ${report.settledTrades} / tracking: ${report.trackingTrades} / missed: ${report.missedSignals}\n`
  + `- paper equity: ${format(report.paperEquity, 0)}원 / return: ${format(report.totalReturnPercent)}%\n`
  + `- TP-before-SL success rate: ${format(report.successRatePercent)}% / resolved barriers: ${report.barrierResolvedTradeCount} / TP: ${report.tpHitCount} / SL: ${report.slHitCount} / censored: ${report.censoredTradeCount}\n`
  + `- net-profitable trade rate after all modeled costs: ${format(report.netProfitableTradeRatePercent)}% / settled trades: ${report.settledTrades}\n`
  + `- PF: ${format(report.profitFactor)} / MDD: ${format(report.maximumDrawdownPercent)}% / expectancy: ${format(report.expectancy, 0)}원\n`
  + `- cost stress return: 1.5x ${format(report.costStress?.x1_5?.totalReturnPercent)}% / 2x ${format(report.costStress?.x2?.totalReturnPercent)}% (diagnostic)\n`
  + `- regime diagnostics: trend/volatility are point-in-time and do not affect promotion; liquidity=${report.regimeResults?.liquidity?.status ?? "not_available"}\n`
  + `- status: **${report.status}** / next: ${report.nextStage}\n`
  + `- actual order: 0 / private account API: 0 / live promotion: false\n`
  + `- late workflow cycles never backfill a signal after its entry window has passed.\n`;

await writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
await writeAtomic(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
await writeAtomic(markdownPath, markdown);
console.log(markdown);

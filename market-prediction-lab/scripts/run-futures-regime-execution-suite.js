import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { repairBitgetCandleGaps } from "../src/candle-gap-repair.js";
import { collectFundingRateHistory } from "../src/derivatives-history.js";
import { normalizeCandleRows } from "../src/normalizers.js";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { walkForwardSplit } from "../src/walk-forward.js";
import { optimizeFrozenFuturesRegimeExecution } from "../src/futures-regime-execution.js";
import {
  FUTURES_REGIME_EXECUTION_CANDIDATE,
  FUTURES_REGIME_EXECUTION_CANDIDATE_SHA256,
} from "../src/futures-regime-execution-candidate.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CONFIG = Object.freeze({ timeframe: "15m", days: 90, lookback: 200, horizon: 8, stride: 4 });

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

async function loadFrozenModel() {
  const path = resolve("docs/candidate-models", `${FUTURES_REGIME_EXECUTION_CANDIDATE.modelGroup}.json`);
  const artifact = JSON.parse(await readFile(path, "utf8"));
  if (artifact?.status !== "shadow_candidate" || !artifact?.model?.trained) throw new Error("FROZEN_15M_SHADOW_MODEL_MISSING");
  return artifact.model;
}

async function collectDataset(client, symbol, suiteEndTime) {
  const startTime = suiteEndTime - CONFIG.days * DAY_MS;
  const raw = await collectBitgetCandles({
    client,
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe: CONFIG.timeframe,
    startTime,
    endTime: suiteEndTime,
    maxCandles: 50_000,
  });
  const repaired = await repairBitgetCandleGaps({
    client,
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe: CONFIG.timeframe,
    candles: raw.candles,
  });
  if (repaired.remainingMissingCandleCount > 0) throw new Error(`${symbol}_UNRESOLVED_GAPS_${repaired.remainingMissingCandleCount}`);
  const normalized = normalizeCandleRows(repaired.candles, {
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe: CONFIG.timeframe,
    format: "canonical-object",
    source: `bitget-public-futures-regime-${symbol}-15m`,
    strict: true,
  });
  if (normalized.quality.status !== "clean") throw new Error(`${symbol}_QUALITY_${normalized.quality.status}`);
  const records = buildTrainingRecords(normalized, {
    lookback: CONFIG.lookback,
    horizon: CONFIG.horizon,
    stride: CONFIG.stride,
  });
  if (records.length < 240) throw new Error(`${symbol}_RECORDS_${records.length}`);
  const split = walkForwardSplit(records, { trainRatio: 0.6, validationRatio: 0.2 });
  const funding = await collectFundingRateHistory({
    client,
    symbol,
    startTime: startTime - 12 * 60 * 60 * 1000,
    endTime: suiteEndTime,
    pageSize: 100,
    maxPages: 100,
  });
  return Object.freeze({
    symbol,
    timeframe: CONFIG.timeframe,
    candles: normalized.candles,
    fundingRates: funding.records,
    records,
    split,
    report: Object.freeze({
      symbol,
      timeframe: CONFIG.timeframe,
      candleCount: normalized.candles.length,
      recordCount: records.length,
      fundingRecords: funding.records.length,
      firstTimestamp: normalized.candles[0]?.timestamp ?? null,
      lastTimestamp: normalized.candles.at(-1)?.timestamp ?? null,
      quality: normalized.quality.status,
      split: split.report,
    }),
  });
}

const output = resolve(process.argv[2] ?? "docs/futures-regime-execution-suite-result.json");
const suiteEndTime = Date.now();
const client = new BitgetPublicClient({ minIntervalMs: 170, maxRetries: 4, timeoutMs: 12_000 });
let report;

try {
  const model = await loadFrozenModel();
  const designDatasets = [];
  const holdoutDatasets = [];
  for (const symbol of FUTURES_REGIME_EXECUTION_CANDIDATE.designSymbols) designDatasets.push(await collectDataset(client, symbol, suiteEndTime));
  for (const symbol of FUTURES_REGIME_EXECUTION_CANDIDATE.holdoutSymbols) holdoutDatasets.push(await collectDataset(client, symbol, suiteEndTime));
  const result = optimizeFrozenFuturesRegimeExecution({
    model,
    designDatasets,
    holdoutDatasets,
    stressMultiplier: 1.5,
  });
  report = Object.freeze({
    schemaVersion: 1,
    status: "pass",
    researchOnly: true,
    market: "CRYPTO_FUTURES",
    exchange: "BITGET",
    candidateId: FUTURES_REGIME_EXECUTION_CANDIDATE.id,
    candidateManifestSha256: FUTURES_REGIME_EXECUTION_CANDIDATE_SHA256,
    result,
    datasets: Object.freeze({
      design: designDatasets.map((row) => row.report),
      holdout: holdoutDatasets.map((row) => row.report),
    }),
    provenance: Object.freeze({
      sourceResearchSha: FUTURES_REGIME_EXECUTION_CANDIDATE.sourceResearchSha,
      sourceArtifactDigest: FUTURES_REGIME_EXECUTION_CANDIDATE.sourceArtifactDigest,
      frozenModel: true,
      frozenExecutionParameters: true,
      priorBTCETHSOLUsedForSelection: false,
      holdoutADADOGEUsedForSelection: false,
      historicalFundingRequiredAtSignal: true,
      historicalOpenInterestBackfilled: false,
      publicDataOnly: true,
    }),
    safeguards: Object.freeze({ actualOrders: 0, privateAccountRequests: 0, liveExecutionAllowed: false, mainMergePerformed: false }),
  });
} catch (error) {
  report = Object.freeze({
    schemaVersion: 1,
    status: "fail",
    researchOnly: true,
    market: "CRYPTO_FUTURES",
    candidateId: FUTURES_REGIME_EXECUTION_CANDIDATE.id,
    candidateManifestSha256: FUTURES_REGIME_EXECUTION_CANDIDATE_SHA256,
    error: serializeError(error),
    safeguards: Object.freeze({ actualOrders: 0, privateAccountRequests: 0, liveExecutionAllowed: false }),
  });
  process.exitCode = 1;
}

await save(output, report);
console.log(JSON.stringify(report, null, 2));

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { repairBitgetCandleGaps } from "../src/candle-gap-repair.js";
import { normalizeCandleRows } from "../src/normalizers.js";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { walkForwardSplit } from "../src/walk-forward.js";
import {
  compareCandidateToBaseline,
  evaluateStoredBaseline,
  evaluateTinyModel,
} from "../src/tiny-model-training.js";

const DAY = 86_400_000;
const SPECS = Object.freeze([
  Object.freeze({ group: "crypto-futures-15m", symbol: "SOLUSDT", timeframe: "15m", days: 52, lookback: 200, horizon: 8, stride: 4 }),
  Object.freeze({ group: "crypto-futures-1h", symbol: "SOLUSDT", timeframe: "1h", days: 83, lookback: 200, horizon: 12, stride: 2 }),
]);

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function metrics(value) {
  return {
    sampleCount: value.sampleCount,
    accuracy: value.accuracy,
    balancedAccuracy: value.balancedAccuracy,
    macroF1: value.macroF1,
    logLoss: value.logLoss,
    brier: value.brier,
    expectedCalibrationError: value.expectedCalibrationError,
  };
}

async function loadFrozenModel(group) {
  const artifact = JSON.parse(await readFile(resolve("docs/candidate-models", `${group}.json`), "utf8"));
  if (!artifact?.model?.trained) throw new Error(`FROZEN_MODEL_MISSING_${group}`);
  return artifact.model;
}

const output = resolve(process.argv[2] ?? "docs/futures-generalization-suite-result.json");
const endTime = Date.now();
const client = new BitgetPublicClient({ minIntervalMs: 170, maxRetries: 4, timeoutMs: 12_000 });
const groups = {};
let technicalFailure = false;

for (const spec of SPECS) {
  try {
    const startTime = endTime - spec.days * DAY;
    const raw = await collectBitgetCandles({
      client,
      market: "CRYPTO_FUTURES",
      symbol: spec.symbol,
      timeframe: spec.timeframe,
      startTime,
      endTime,
    });
    const repaired = await repairBitgetCandleGaps({
      client,
      market: "CRYPTO_FUTURES",
      symbol: spec.symbol,
      timeframe: spec.timeframe,
      candles: raw.candles,
    });
    if (repaired.remainingMissingCandleCount > 0) throw new Error(`SOL_UNRESOLVED_GAPS_${repaired.remainingMissingCandleCount}`);
    const normalized = normalizeCandleRows(repaired.candles, {
      market: "CRYPTO_FUTURES",
      symbol: spec.symbol,
      timeframe: spec.timeframe,
      format: "canonical-object",
      source: `bitget-public-frozen-holdout-${spec.group}`,
      strict: true,
    });
    if (normalized.quality.status !== "clean") throw new Error(`SOL_QUALITY_${normalized.quality.status}`);
    const records = buildTrainingRecords(normalized, { lookback: spec.lookback, horizon: spec.horizon, stride: spec.stride });
    if (records.length < 120) throw new Error(`SOL_RECORDS_${records.length}`);
    const split = walkForwardSplit(records, { trainRatio: 0.7, validationRatio: 0.15 });
    const model = await loadFrozenModel(spec.group);
    const baseline = evaluateStoredBaseline(split.test);
    const candidate = evaluateTinyModel(split.test, model);
    const comparison = compareCandidateToBaseline(baseline, candidate);
    groups[spec.group] = {
      status: comparison.promoted ? "generalization_candidate" : "research_hold",
      symbol: spec.symbol,
      timeframe: spec.timeframe,
      frozenModel: true,
      modelRetunedOnSol: false,
      holdoutUsedForSelection: false,
      candleCount: normalized.candles.length,
      testSamples: split.test.length,
      baseline: metrics(baseline),
      candidate: metrics(candidate),
      comparison,
    };
  } catch (error) {
    technicalFailure = true;
    groups[spec.group] = { status: "technical_failure", message: String(error?.message ?? error).slice(0, 800) };
  }
}

const allGeneralized = !technicalFailure && Object.values(groups).every((value) => value.status === "generalization_candidate");
const report = {
  schemaVersion: 1,
  status: technicalFailure ? "fail" : "pass",
  researchStatus: allGeneralized ? "generalization_candidate" : "research_hold",
  market: "CRYPTO_FUTURES",
  exchange: "BITGET",
  holdoutSymbol: "SOLUSDT",
  groups,
  researchOnly: true,
  liveExecutionAllowed: false,
  privateAccountRequestAllowed: false,
  methodology: "Freeze the BTC+ETH-trained price/volume model and evaluate it on unseen SOLUSDT held-out test records without retuning.",
  limitations: [
    "This validates price/volume generalization only.",
    "Historical funding candidate remains separately gated and is not promoted by this result.",
    "Current open interest must not be backfilled into historical records.",
  ],
};

await save(output, report);
console.log(JSON.stringify(report, null, 2));
if (report.status !== "pass") process.exitCode = 1;

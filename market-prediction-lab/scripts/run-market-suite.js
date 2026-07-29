import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles, collectBitgetFuturesContext, BITGET_TIMEFRAME_MS } from "../src/bitget-candle-collector.js";
import { repairBitgetCandleGaps } from "../src/candle-gap-repair.js";
import { verifyLiveCollection } from "../src/live-collection-verifier.js";
import { normalizeCandleRows } from "../src/normalizers.js";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { walkForwardSplit } from "../src/walk-forward.js";
import { exportWalkForwardDataset } from "../src/dataset-export.js";
import { BASELINE_MODEL } from "../src/tiny-model.js";
import {
  calibrateTemperature,
  compareCandidateToBaseline,
  evaluateStoredBaseline,
  evaluateTinyModel,
  trainTinySoftmaxModel,
} from "../src/tiny-model-training.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SUITE_SPECS = Object.freeze([
  Object.freeze({ id: "btcusdt-futures-15m-52d", group: "crypto-futures-15m", market: "CRYPTO_FUTURES", symbol: "BTCUSDT", timeframe: "15m", days: 52, lookback: 200, horizon: 8, stride: 4 }),
  Object.freeze({ id: "ethusdt-futures-15m-52d", group: "crypto-futures-15m", market: "CRYPTO_FUTURES", symbol: "ETHUSDT", timeframe: "15m", days: 52, lookback: 200, horizon: 8, stride: 4 }),
  Object.freeze({ id: "btcusdt-futures-1h-83d", group: "crypto-futures-1h", market: "CRYPTO_FUTURES", symbol: "BTCUSDT", timeframe: "1h", days: 83, lookback: 200, horizon: 12, stride: 2 }),
  Object.freeze({ id: "ethusdt-futures-1h-83d", group: "crypto-futures-1h", market: "CRYPTO_FUTURES", symbol: "ETHUSDT", timeframe: "1h", days: 83, lookback: 200, horizon: 12, stride: 2 }),
  Object.freeze({ id: "btcusdt-spot-4h-240d", group: "crypto-spot-4h", market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "4h", days: 240, lookback: 200, horizon: 6, stride: 1 }),
]);

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error).slice(0, 1200),
    details: error?.details ?? null,
    stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 10) : [],
  };
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function expectedCandles(spec) {
  return Math.floor((spec.days * DAY_MS) / BITGET_TIMEFRAME_MS[spec.timeframe]);
}

function portableOutputs(outputs) {
  return Object.fromEntries(Object.entries(outputs).map(([name, output]) => [name, {
    count: output.count,
    sha256: output.sha256,
  }]));
}

function metricSummary(metrics) {
  return {
    sampleCount: metrics.sampleCount,
    accuracy: metrics.accuracy,
    balancedAccuracy: metrics.balancedAccuracy,
    macroF1: metrics.macroF1,
    logLoss: metrics.logLoss,
    brier: metrics.brier,
    expectedCalibrationError: metrics.expectedCalibrationError,
    perClass: metrics.perClass,
    confusion: metrics.confusion,
  };
}

async function collectDataset({ client, spec, suiteEndTime, outputRoot }) {
  const startedAt = Date.now();
  const startTime = suiteEndTime - (spec.days * DAY_MS);
  const raw = await collectBitgetCandles({
    client,
    market: spec.market,
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    startTime,
    endTime: suiteEndTime,
    onPage: ({ page, received }) => console.log(JSON.stringify({ dataset: spec.id, stage: "collect", page, received })),
  });
  const repair = await repairBitgetCandleGaps({
    client,
    market: spec.market,
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    candles: raw.candles,
    onAttempt: (attempt) => console.log(JSON.stringify({ dataset: spec.id, stage: "repair", ...attempt })),
  });
  if (repair.remainingMissingCandleCount > 0) {
    const error = new Error(`unresolved candle gaps: ${repair.remainingMissingCandleCount}`);
    error.details = repair.unresolvedGaps;
    throw error;
  }
  const snapshot = Object.freeze({ ...raw, candles: repair.candles });
  const expected = expectedCandles(spec);
  const quality = verifyLiveCollection(snapshot, { minCandles: Math.max(60, Math.floor(expected * 0.985)) });
  const normalized = normalizeCandleRows(snapshot.candles, {
    market: spec.market,
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    format: "canonical-object",
    source: `bitget-public-market-suite-${spec.id}`,
    strict: true,
  });
  if (normalized.quality.status !== "clean") throw new Error(`normalized quality is ${normalized.quality.status}`);

  const records = buildTrainingRecords(normalized, {
    lookback: spec.lookback,
    horizon: spec.horizon,
    stride: spec.stride,
  });
  if (records.length < 120) throw new Error(`not enough training records: ${records.length}`);
  const split = walkForwardSplit(records, { trainRatio: 0.7, validationRatio: 0.15 });
  const datasetRoot = resolve(outputRoot, "datasets", spec.id);
  await writeJsonAtomically(resolve(datasetRoot, "raw-candles.json"), snapshot);
  await writeJsonAtomically(resolve(datasetRoot, "normalized-candles.json"), normalized);
  await writeJsonAtomically(resolve(datasetRoot, "gap-repair.json"), repair);
  const manifest = await exportWalkForwardDataset(resolve(datasetRoot, "records"), split, {
    market: spec.market,
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    lookback: spec.lookback,
    horizon: spec.horizon,
    stride: spec.stride,
  });
  const baselineTest = evaluateStoredBaseline(split.test);
  return {
    spec,
    split,
    summary: {
      id: spec.id,
      status: "pass",
      durationMs: Date.now() - startedAt,
      market: spec.market,
      symbol: spec.symbol,
      timeframe: spec.timeframe,
      requestedDays: spec.days,
      expectedCandleCount: expected,
      candleCount: quality.candleCount,
      coverageRatio: quality.candleCount / expected,
      firstTimestamp: quality.firstTimestamp,
      lastTimestamp: quality.lastTimestamp,
      latestAgeMs: quality.latestAgeMs,
      gaps: quality.gaps,
      zeroVolume: quality.zeroVolume,
      normalizedQuality: normalized.quality,
      gapRepair: {
        initialGapCount: repair.initialGapCount,
        initialMissingCandleCount: repair.initialMissingCandleCount,
        repairedCandleCount: repair.repairedCandleCount,
        remainingGapCount: repair.remainingGapCount,
        remainingMissingCandleCount: repair.remainingMissingCandleCount,
      },
      records: records.length,
      split: split.report,
      baselineTest: metricSummary(baselineTest),
      outputs: portableOutputs(manifest.outputs),
      candleSha256: sha256Json(snapshot),
    },
  };
}

function combineSplits(datasets) {
  return Object.freeze({
    train: Object.freeze(datasets.flatMap((dataset) => dataset.split.train)),
    validation: Object.freeze(datasets.flatMap((dataset) => dataset.split.validation)),
    test: Object.freeze(datasets.flatMap((dataset) => dataset.split.test)),
  });
}

async function trainGroup({ group, datasets, outputRoot, candidateRoot }) {
  const split = combineSplits(datasets);
  const model = trainTinySoftmaxModel(split.train, {
    featureOrder: BASELINE_MODEL.featureOrder,
    id: `tiny-softmax-${group}-v1`,
    epochs: 520,
    learningRate: 0.075,
    l2: 0.003,
    patience: 60,
  });
  const calibrated = calibrateTemperature(split.validation, model);
  const baseline = evaluateStoredBaseline(split.test);
  const candidate = evaluateTinyModel(split.test, calibrated);
  const comparison = compareCandidateToBaseline(baseline, candidate);
  const crossSymbol = new Set(datasets.map((dataset) => dataset.spec.symbol)).size >= 2;
  const shadowEligible = comparison.promoted && crossSymbol;
  const perDataset = Object.fromEntries(datasets.map((dataset) => {
    const datasetBaseline = evaluateStoredBaseline(dataset.split.test);
    const datasetCandidate = evaluateTinyModel(dataset.split.test, calibrated);
    return [dataset.spec.id, {
      baseline: metricSummary(datasetBaseline),
      candidate: metricSummary(datasetCandidate),
      comparison: compareCandidateToBaseline(datasetBaseline, datasetCandidate),
    }];
  }));
  const artifact = {
    schemaVersion: 1,
    status: shadowEligible ? "shadow_candidate" : "research_hold",
    group,
    crossSymbol,
    sourceDatasets: datasets.map((dataset) => dataset.spec.id),
    featureLimitations: [
      "price_volume_features_only",
      "historical_open_interest_not_yet_time_aligned",
      "historical_funding_not_yet_time_aligned",
      "news_and_flow_features_not_yet_time_aligned",
    ],
    model: calibrated,
    baselineTest: metricSummary(baseline),
    candidateTest: metricSummary(candidate),
    comparison,
    perDataset,
  };
  await writeJsonAtomically(resolve(outputRoot, "models", `${group}.json`), artifact);
  await writeJsonAtomically(resolve(candidateRoot, `${group}.json`), artifact);
  return {
    status: artifact.status,
    crossSymbol,
    sourceDatasets: artifact.sourceDatasets,
    modelId: calibrated.id,
    modelSha256: sha256Json(calibrated),
    temperature: calibrated.temperature,
    training: calibrated.training,
    calibration: calibrated.calibration,
    baselineTest: artifact.baselineTest,
    candidateTest: artifact.candidateTest,
    comparison,
    perDataset,
    featureLimitations: artifact.featureLimitations,
  };
}

const outputRoot = resolve(process.argv[2] ?? "live-market-suite");
const reportPath = resolve(process.argv[3] ?? "docs/market-suite-result.json");
const candidateRoot = resolve(process.argv[4] ?? "models/candidates");
const suiteEndTime = Date.now();
const suiteStartedAt = Date.now();
const client = new BitgetPublicClient({ minIntervalMs: 160, maxRetries: 4, timeoutMs: 12_000 });
const datasets = [];
const datasetResults = [];

for (const spec of SUITE_SPECS) {
  try {
    const result = await collectDataset({ client, spec, suiteEndTime, outputRoot });
    datasets.push(result);
    datasetResults.push(result.summary);
  } catch (error) {
    datasetResults.push({
      id: spec.id,
      status: "fail",
      market: spec.market,
      symbol: spec.symbol,
      timeframe: spec.timeframe,
      requestedDays: spec.days,
      error: serializeError(error),
    });
  }
}

const contextResults = {};
for (const symbol of [...new Set(SUITE_SPECS.filter((spec) => spec.market === "CRYPTO_FUTURES").map((spec) => spec.symbol))]) {
  try {
    const context = await collectBitgetFuturesContext({ client, symbol });
    await writeJsonAtomically(resolve(outputRoot, "contexts", `${symbol}.json`), context);
    contextResults[symbol] = {
      status: "pass",
      openInterestRaw: context.openInterestRaw,
      fundingRateRaw: context.fundingRateRaw,
      fundingIntervalHours: context.fundingIntervalHours,
      marketPriceRaw: context.marketPriceRaw,
      markPriceRaw: context.markPriceRaw,
      indexPriceRaw: context.indexPriceRaw,
      fundingHistoryCount: context.fundingHistory.length,
    };
  } catch (error) {
    contextResults[symbol] = { status: "partial", error: serializeError(error) };
  }
}

const modelResults = {};
for (const group of [...new Set(SUITE_SPECS.map((spec) => spec.group))]) {
  const expectedIds = SUITE_SPECS.filter((spec) => spec.group === group).map((spec) => spec.id);
  const groupDatasets = datasets.filter((dataset) => dataset.spec.group === group);
  if (groupDatasets.length !== expectedIds.length) {
    modelResults[group] = { status: "not_trained", reason: "one_or_more_group_datasets_failed", expectedIds };
    continue;
  }
  try {
    modelResults[group] = await trainGroup({ group, datasets: groupDatasets, outputRoot, candidateRoot });
  } catch (error) {
    modelResults[group] = { status: "training_failed", error: serializeError(error) };
  }
}

const failedDatasets = datasetResults.filter((result) => result.status !== "pass");
const failedModels = Object.values(modelResults).filter((result) => ["not_trained", "training_failed"].includes(result.status));
const report = {
  schemaVersion: 1,
  status: failedDatasets.length === 0 && failedModels.length === 0 ? "pass" : "fail",
  stage: "complete",
  verifiedAt: Date.now(),
  durationMs: Date.now() - suiteStartedAt,
  source: "github-actions-isolated-multi-market-suite",
  suiteEndTime,
  datasets: datasetResults,
  futuresContexts: contextResults,
  models: modelResults,
  safety: {
    externalRuntimeDependencies: 0,
    usesPublicMarketDataOnly: true,
    usesAccountOrOrderApi: false,
    modifiesExistingAppApi: false,
    modelDeployment: false,
    trainingMode: "offline-research-only",
  },
};
await writeJsonAtomically(reportPath, report);
console.log(JSON.stringify(report, null, 2));
if (report.status !== "pass") process.exitCode = 1;

export { SUITE_SPECS };

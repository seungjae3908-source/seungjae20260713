import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
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
const CLASS_NAMES = Object.freeze(["bullish", "neutral", "bearish"]);
const SUITE_SPECS = Object.freeze([
  Object.freeze({ id: "005930-kr-1d-10y", group: "kr-stock-1d", market: "KR_STOCK", symbol: "005930", timeframe: "1d", days: 3650, lookback: 200, horizon: 5, stride: 2 }),
  Object.freeze({ id: "000660-kr-1d-10y", group: "kr-stock-1d", market: "KR_STOCK", symbol: "000660", timeframe: "1d", days: 3650, lookback: 200, horizon: 5, stride: 2 }),
  Object.freeze({ id: "035420-kr-1d-10y", group: "kr-stock-1d", market: "KR_STOCK", symbol: "035420", timeframe: "1d", days: 3650, lookback: 200, horizon: 5, stride: 2 }),
  Object.freeze({ id: "aapl-us-1d-10y", group: "us-stock-1d", market: "US_STOCK", symbol: "AAPL", timeframe: "1d", days: 3650, lookback: 200, horizon: 5, stride: 2 }),
  Object.freeze({ id: "msft-us-1d-10y", group: "us-stock-1d", market: "US_STOCK", symbol: "MSFT", timeframe: "1d", days: 3650, lookback: 200, horizon: 5, stride: 2 }),
  Object.freeze({ id: "nvda-us-1d-10y", group: "us-stock-1d", market: "US_STOCK", symbol: "NVDA", timeframe: "1d", days: 3650, lookback: 200, horizon: 5, stride: 2 }),
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

function directionCounts(records) {
  const counts = Object.fromEntries(CLASS_NAMES.map((name) => [name, 0]));
  for (const record of records) counts[record.label.direction] += 1;
  return counts;
}

async function collectDataset({ spec, suiteEndTime, outputRoot }) {
  const startedAt = Date.now();
  const startTime = suiteEndTime - spec.days * DAY_MS;
  const raw = await collectYahooStockHistory({
    market: spec.market,
    symbol: spec.symbol,
    startTime,
    endTime: suiteEndTime,
  });
  const normalized = normalizeCandleRows(raw.candles, {
    market: spec.market,
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    format: "canonical-object",
    source: `yahoo-public-stock-suite-${spec.id}`,
    strict: true,
  });
  if (normalized.quality.status === "invalid") {
    throw new Error(`normalized stock quality is ${normalized.quality.status}`);
  }
  if (normalized.candles.length < 1000) {
    throw new Error(`not enough stock candles: ${normalized.candles.length}`);
  }
  const records = buildTrainingRecords(normalized, {
    lookback: spec.lookback,
    horizon: spec.horizon,
    stride: spec.stride,
  });
  if (records.length < 300) throw new Error(`not enough stock training records: ${records.length}`);
  const split = walkForwardSplit(records, { trainRatio: 0.7, validationRatio: 0.15 });
  const datasetRoot = resolve(outputRoot, "datasets", spec.id);
  await writeJsonAtomically(resolve(datasetRoot, "raw-stock-history.json"), raw);
  await writeJsonAtomically(resolve(datasetRoot, "normalized-candles.json"), normalized);
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
      providerSymbol: raw.providerSymbol,
      timeframe: spec.timeframe,
      requestedDays: spec.days,
      candleCount: normalized.candles.length,
      firstTimestamp: normalized.candles[0].timestamp,
      lastTimestamp: normalized.candles.at(-1).timestamp,
      normalizedQuality: normalized.quality,
      records: records.length,
      split: split.report,
      classCounts: {
        train: directionCounts(split.train),
        validation: directionCounts(split.validation),
        test: directionCounts(split.test),
      },
      baselineTest: metricSummary(baselineTest),
      outputs: portableOutputs(manifest.outputs),
      candleSha256: sha256Json(normalized.candles),
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

async function writeResearchHold({ group, datasets, split, outputRoot, candidateRoot, reason, classCounts }) {
  const artifact = {
    schemaVersion: 1,
    status: "research_hold",
    reason,
    group,
    market: datasets[0]?.spec.market ?? null,
    crossSymbol: new Set(datasets.map((dataset) => dataset.spec.symbol)).size >= 2,
    sourceDatasets: datasets.map((dataset) => dataset.spec.id),
    classCounts,
    splitSizes: {
      train: split.train.length,
      validation: split.validation.length,
      test: split.test.length,
    },
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    model: null,
  };
  await writeJsonAtomically(resolve(outputRoot, "models", `${group}.json`), artifact);
  await writeJsonAtomically(resolve(candidateRoot, `${group}.json`), artifact);
  return artifact;
}

async function trainGroup({ group, datasets, outputRoot, candidateRoot }) {
  const split = combineSplits(datasets);
  const classCounts = {
    train: directionCounts(split.train),
    validation: directionCounts(split.validation),
    test: directionCounts(split.test),
  };
  if (CLASS_NAMES.some((name) => classCounts.train[name] < 30 || classCounts.validation[name] < 10 || classCounts.test[name] < 10)) {
    return writeResearchHold({
      group,
      datasets,
      split,
      outputRoot,
      candidateRoot,
      reason: "insufficient_class_coverage",
      classCounts,
    });
  }
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
  const perDataset = Object.fromEntries(datasets.map((dataset) => {
    const datasetBaseline = evaluateStoredBaseline(dataset.split.test);
    const datasetCandidate = evaluateTinyModel(dataset.split.test, calibrated);
    return [dataset.spec.id, {
      baseline: metricSummary(datasetBaseline),
      candidate: metricSummary(datasetCandidate),
      comparison: compareCandidateToBaseline(datasetBaseline, datasetCandidate),
    }];
  }));
  const allDatasetsNonRegressive = Object.values(perDataset).every((item) => item.comparison.promoted || item.comparison.reason === "candidate_not_materially_better");
  const researchEligible = comparison.promoted && crossSymbol && allDatasetsNonRegressive;
  const artifact = {
    schemaVersion: 1,
    status: researchEligible ? "research_candidate" : "research_hold",
    group,
    market: datasets[0]?.spec.market ?? null,
    crossSymbol,
    sourceDatasets: datasets.map((dataset) => dataset.spec.id),
    classCounts,
    featureLimitations: [
      "daily_price_volume_features_only",
      "no_corporate_action_adjustment_beyond_provider_chart_contract",
      "no_point_in_time_fundamental_features",
      "no_news_or_flow_features",
      "classification_metrics_are_not_trading_pnl",
    ],
    model: calibrated,
    baselineTest: metricSummary(baseline),
    candidateTest: metricSummary(candidate),
    comparison,
    perDataset,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
  };
  await writeJsonAtomically(resolve(outputRoot, "models", `${group}.json`), artifact);
  await writeJsonAtomically(resolve(candidateRoot, `${group}.json`), artifact);
  return {
    status: artifact.status,
    market: artifact.market,
    crossSymbol,
    sourceDatasets: artifact.sourceDatasets,
    classCounts,
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

const outputRoot = resolve(process.argv[2] ?? "live-stock-market-suite");
const reportPath = resolve(process.argv[3] ?? "docs/stock-market-suite-result.json");
const candidateRoot = resolve(process.argv[4] ?? "docs/stock-candidate-models");
const suiteEndTime = Date.now();
const suiteStartedAt = Date.now();
const datasets = [];
const datasetResults = [];

for (const spec of SUITE_SPECS) {
  try {
    const result = await collectDataset({ spec, suiteEndTime, outputRoot });
    datasets.push(result);
    datasetResults.push(result.summary);
    console.log(JSON.stringify({ dataset: spec.id, stage: "complete", candles: result.summary.candleCount, records: result.summary.records }));
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
  researchOnly: true,
  branchWrite: false,
  liveOrderAllowed: false,
  privateAccountRequestAllowed: false,
  dataSource: "Yahoo public chart API",
  scope: {
    markets: ["KR_STOCK", "US_STOCK"],
    timeframe: "1d",
    requestedHistoryYearsApprox: 10,
    symbols: Object.fromEntries(["KR_STOCK", "US_STOCK"].map((market) => [market, SUITE_SPECS.filter((spec) => spec.market === market).map((spec) => spec.symbol)])),
  },
  limitations: [
    "Representative-symbol research is not full-universe optimization.",
    "Prediction accuracy is not equivalent to strategy profitability.",
    "No stock model may change live scanner thresholds until separate cost-aware PnL OOS and walk-forward validation passes.",
  ],
  datasets: datasetResults,
  models: modelResults,
};

await writeJsonAtomically(reportPath, report);
console.log(JSON.stringify({
  status: report.status,
  reportPath,
  durationMs: report.durationMs,
  datasetCount: datasetResults.length,
  failedDatasetCount: failedDatasets.length,
  modelResults,
}, null, 2));
if (report.status !== "pass") process.exitCode = 1;

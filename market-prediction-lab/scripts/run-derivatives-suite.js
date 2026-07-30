import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { repairBitgetCandleGaps } from "../src/candle-gap-repair.js";
import { collectFundingRateHistory, createTemporalDerivativesProvider, summarizeTemporalCoverage } from "../src/derivatives-history.js";
import { normalizeCandleRows } from "../src/normalizers.js";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { walkForwardSplit } from "../src/walk-forward.js";
import { BASELINE_MODEL } from "../src/tiny-model.js";
import { calibrateTemperature, evaluateTinyModel, trainTinySoftmaxModel } from "../src/tiny-model-training.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SPECS = Object.freeze([
  Object.freeze({ id: "btcusdt-futures-15m-52d", group: "crypto-futures-15m", symbol: "BTCUSDT", timeframe: "15m", days: 52, lookback: 200, horizon: 8, stride: 4 }),
  Object.freeze({ id: "ethusdt-futures-15m-52d", group: "crypto-futures-15m", symbol: "ETHUSDT", timeframe: "15m", days: 52, lookback: 200, horizon: 8, stride: 4 }),
  Object.freeze({ id: "btcusdt-futures-1h-83d", group: "crypto-futures-1h", symbol: "BTCUSDT", timeframe: "1h", days: 83, lookback: 200, horizon: 12, stride: 2 }),
  Object.freeze({ id: "ethusdt-futures-1h-83d", group: "crypto-futures-1h", symbol: "ETHUSDT", timeframe: "1h", days: 83, lookback: 200, horizon: 12, stride: 2 }),
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

async function loadV1Model(group) {
  const path = resolve("docs/candidate-models", `${group}.json`);
  const artifact = JSON.parse(await readFile(path, "utf8"));
  if (!artifact?.model?.trained) throw new Error(`v1 model is missing for ${group}`);
  return artifact.model;
}

async function collectDataset({ client, spec, suiteEndTime, outputRoot }) {
  const startTime = suiteEndTime - spec.days * DAY_MS;
  const raw = await collectBitgetCandles({
    client,
    market: "CRYPTO_FUTURES",
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    startTime,
    endTime: suiteEndTime,
  });
  const repaired = await repairBitgetCandleGaps({
    client,
    market: "CRYPTO_FUTURES",
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    candles: raw.candles,
  });
  if (repaired.remainingMissingCandleCount > 0) throw new Error(`unresolved candle gaps: ${repaired.remainingMissingCandleCount}`);

  const normalized = normalizeCandleRows(repaired.candles, {
    market: "CRYPTO_FUTURES",
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    format: "canonical-object",
    source: `bitget-public-derivatives-suite-${spec.id}`,
    strict: true,
  });
  if (normalized.quality.status !== "clean") throw new Error(`normalized quality is ${normalized.quality.status}`);

  const funding = await collectFundingRateHistory({
    client,
    symbol: spec.symbol,
    startTime: startTime - 12 * 60 * 60 * 1000,
    endTime: suiteEndTime,
    onPage: ({ pageNo, received }) => console.log(JSON.stringify({ dataset: spec.id, stage: "funding", pageNo, received })),
  });
  if (funding.records.length < 20) throw new Error(`not enough historical funding records: ${funding.records.length}`);
  const provider = createTemporalDerivativesProvider({ fundingHistory: funding.records });
  const records = buildTrainingRecords(normalized, {
    lookback: spec.lookback,
    horizon: spec.horizon,
    stride: spec.stride,
    derivativesFeatureProvider: provider,
  });
  const coverage = summarizeTemporalCoverage(records);
  if (coverage.fundingCoverage < 0.9) throw new Error(`funding coverage below 90%: ${coverage.fundingCoverage}`);
  const split = walkForwardSplit(records, { trainRatio: 0.7, validationRatio: 0.15 });

  const datasetRoot = resolve(outputRoot, "datasets", spec.id);
  await writeJsonAtomically(resolve(datasetRoot, "funding-history.json"), funding);
  await writeJsonAtomically(resolve(datasetRoot, "coverage.json"), coverage);

  return {
    spec,
    split,
    summary: {
      id: spec.id,
      status: "pass",
      symbol: spec.symbol,
      timeframe: spec.timeframe,
      candleCount: normalized.candles.length,
      fundingRecords: funding.records.length,
      fundingCoverage: coverage.fundingCoverage,
      openInterestCoverage: coverage.openInterestCoverage,
      gaps: normalized.quality.gaps,
      quality: normalized.quality.status,
      records: records.length,
      split: split.report,
      candleSha256: sha256Json(normalized.candles),
      fundingSha256: sha256Json(funding.records),
    },
  };
}

function combine(datasets, key) {
  return Object.freeze(datasets.flatMap((dataset) => dataset.split[key]));
}

function compareMetrics(v1, v2) {
  return Object.freeze({
    logLossImprovement: v1.logLoss - v2.logLoss,
    macroF1Delta: v2.macroF1 - v1.macroF1,
    accuracyDelta: v2.accuracy - v1.accuracy,
    brierImprovement: v1.brier - v2.brier,
    eceImprovement: v1.expectedCalibrationError - v2.expectedCalibrationError,
  });
}

function strictPromotion({ overall, perDataset, temperature, crossSymbol, fundingCoverage }) {
  const reasons = [];
  if (!crossSymbol) reasons.push("cross_symbol_validation_missing");
  if (fundingCoverage < 0.9) reasons.push("funding_coverage_below_90pct");
  if (overall.logLossImprovement < 0.005) reasons.push("overall_log_loss_improvement_insufficient");
  if (overall.macroF1Delta < 0) reasons.push("overall_macro_f1_regressed");
  if (overall.accuracyDelta < -0.005) reasons.push("overall_accuracy_regressed");
  if (temperature >= 4.999) reasons.push("temperature_hit_search_ceiling");
  for (const [datasetId, comparison] of Object.entries(perDataset)) {
    if (comparison.logLossImprovement < -0.01) reasons.push(`${datasetId}:log_loss_regressed`);
    if (comparison.macroF1Delta < -0.01) reasons.push(`${datasetId}:macro_f1_regressed`);
    if (comparison.accuracyDelta < -0.02) reasons.push(`${datasetId}:accuracy_regressed`);
  }
  return Object.freeze({
    promoted: reasons.length === 0,
    status: reasons.length === 0 ? "shadow_candidate_v2" : "research_hold",
    reasons: Object.freeze(reasons),
  });
}

async function trainGroup({ group, datasets, candidateRoot }) {
  const train = combine(datasets, "train");
  const validation = combine(datasets, "validation");
  const test = combine(datasets, "test");
  const v1Model = await loadV1Model(group);
  const trained = trainTinySoftmaxModel(train, {
    featureOrder: BASELINE_MODEL.featureOrder,
    id: `tiny-softmax-${group}-funding-v2`,
    epochs: 650,
    learningRate: 0.065,
    l2: 0.004,
    patience: 75,
  });
  const v2Model = calibrateTemperature(validation, trained, { minTemperature: 0.5, maxTemperature: 5, step: 0.05 });
  const v1Metrics = evaluateTinyModel(test, v1Model);
  const v2Metrics = evaluateTinyModel(test, v2Model);
  const overall = compareMetrics(v1Metrics, v2Metrics);
  const perDataset = Object.fromEntries(datasets.map((dataset) => {
    const before = evaluateTinyModel(dataset.split.test, v1Model);
    const after = evaluateTinyModel(dataset.split.test, v2Model);
    return [dataset.spec.id, {
      v1: metricSummary(before),
      v2: metricSummary(after),
      comparison: compareMetrics(before, after),
    }];
  }));
  const promotion = strictPromotion({
    overall,
    perDataset: Object.fromEntries(Object.entries(perDataset).map(([id, value]) => [id, value.comparison])),
    temperature: v2Model.temperature,
    crossSymbol: new Set(datasets.map((dataset) => dataset.spec.symbol)).size >= 2,
    fundingCoverage: Math.min(...datasets.map((dataset) => dataset.summary.fundingCoverage)),
  });
  const artifact = {
    schemaVersion: 1,
    status: promotion.status,
    group,
    sourceDatasets: datasets.map((dataset) => dataset.spec.id),
    temporalSafety: {
      fundingUsesOnlyRecordsAtOrBeforeAnchor: true,
      openInterestBackfillUsed: false,
      currentValuesAppliedToPast: false,
    },
    fundingCoverage: Object.fromEntries(datasets.map((dataset) => [dataset.spec.id, dataset.summary.fundingCoverage])),
    model: v2Model,
    v1Test: metricSummary(v1Metrics),
    v2Test: metricSummary(v2Metrics),
    comparison: overall,
    promotion,
    perDataset,
  };
  await writeJsonAtomically(resolve(candidateRoot, `${group}-funding-v2.json`), artifact);
  return artifact;
}

const outputRoot = resolve(process.argv[2] ?? "live-derivatives-suite");
const reportPath = resolve(process.argv[3] ?? "docs/derivatives-suite-result.json");
const candidateRoot = resolve(process.argv[4] ?? "docs/candidate-models-v2");
const suiteEndTime = Date.now();
const client = new BitgetPublicClient({ minIntervalMs: 170, maxRetries: 4, timeoutMs: 12_000 });
const datasets = [];
const datasetResults = [];

for (const spec of SPECS) {
  try {
    const dataset = await collectDataset({ client, spec, suiteEndTime, outputRoot });
    datasets.push(dataset);
    datasetResults.push(dataset.summary);
  } catch (error) {
    datasetResults.push({ id: spec.id, status: "fail", symbol: spec.symbol, timeframe: spec.timeframe, error: serializeError(error) });
  }
}

const models = {};
for (const group of [...new Set(SPECS.map((spec) => spec.group))]) {
  const expected = SPECS.filter((spec) => spec.group === group);
  const groupDatasets = datasets.filter((dataset) => dataset.spec.group === group);
  if (groupDatasets.length !== expected.length) {
    models[group] = { status: "not_trained", reason: "one_or_more_datasets_failed" };
    continue;
  }
  try {
    models[group] = await trainGroup({ group, datasets: groupDatasets, candidateRoot });
  } catch (error) {
    models[group] = { status: "training_failed", error: serializeError(error) };
  }
}

const technicalFailures = datasetResults.filter((result) => result.status !== "pass").length
  + Object.values(models).filter((model) => ["not_trained", "training_failed"].includes(model.status)).length;
const report = {
  schemaVersion: 1,
  status: technicalFailures === 0 ? "pass" : "fail",
  stage: "complete",
  verifiedAt: Date.now(),
  source: "github-actions-isolated-derivatives-suite",
  suiteEndTime,
  datasets: datasetResults,
  models,
  safety: {
    usesPublicMarketDataOnly: true,
    openInterestHistoricalBackfillInvented: false,
    futureDataLeakageAllowed: false,
    modifiesExistingAppApi: false,
    modelDeployment: false,
  },
};
await writeJsonAtomically(reportPath, report);
console.log(JSON.stringify(report, null, 2));
if (report.status !== "pass") process.exitCode = 1;

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { repairBitgetCandleGaps } from "../src/candle-gap-repair.js";
import { collectFundingRateHistory } from "../src/derivatives-history.js";
import { collectBitgetDerivedCandles, createTemporalMarketStructureProvider, summarizeStructureCoverage } from "../src/market-structure-history.js";
import { normalizeCandleRows } from "../src/normalizers.js";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { walkForwardSplit } from "../src/walk-forward.js";
import { BASELINE_MODEL } from "../src/tiny-model.js";
import { calibrateTemperature, evaluateTinyModel, trainTinySoftmaxModel } from "../src/tiny-model-training.js";
import { selectProbabilityEnsemble } from "../src/model-ensemble.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FEATURE_ORDER = Object.freeze([
  ...BASELINE_MODEL.featureOrder,
  "basisRate",
  "fundingRateChange",
  "fundingRateZScore",
  "markPremium",
  "marketMarkSpread",
]);
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
  const artifact = JSON.parse(await readFile(resolve("docs/candidate-models", `${group}.json`), "utf8"));
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
  const repair = await repairBitgetCandleGaps({
    client,
    market: "CRYPTO_FUTURES",
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    candles: raw.candles,
  });
  if (repair.remainingMissingCandleCount > 0) throw new Error(`unresolved market candle gaps: ${repair.remainingMissingCandleCount}`);
  const normalized = normalizeCandleRows(repair.candles, {
    market: "CRYPTO_FUTURES",
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    format: "canonical-object",
    source: `bitget-public-market-structure-${spec.id}`,
    strict: true,
  });
  if (normalized.quality.status !== "clean") throw new Error(`market quality is ${normalized.quality.status}`);

  const [funding, mark, index] = await Promise.all([
    collectFundingRateHistory({ client, symbol: spec.symbol, startTime: startTime - 12 * 60 * 60 * 1000, endTime: suiteEndTime }),
    collectBitgetDerivedCandles({ client, kind: "mark", symbol: spec.symbol, timeframe: spec.timeframe, startTime, endTime: suiteEndTime }),
    collectBitgetDerivedCandles({ client, kind: "index", symbol: spec.symbol, timeframe: spec.timeframe, startTime, endTime: suiteEndTime }),
  ]);
  const provider = createTemporalMarketStructureProvider({
    fundingHistory: funding.records,
    markCandles: mark.candles,
    indexCandles: index.candles,
  });
  const records = buildTrainingRecords(normalized, {
    lookback: spec.lookback,
    horizon: spec.horizon,
    stride: spec.stride,
    derivativesFeatureProvider: provider,
  });
  const coverage = summarizeStructureCoverage(records);
  if (coverage.fundingCoverage < 0.9) throw new Error(`funding coverage below 90%: ${coverage.fundingCoverage}`);
  if (coverage.structureCoverage < 0.98) throw new Error(`structure coverage below 98%: ${coverage.structureCoverage}`);
  const split = walkForwardSplit(records, { trainRatio: 0.7, validationRatio: 0.15 });

  const datasetRoot = resolve(outputRoot, "datasets", spec.id);
  await writeJsonAtomically(resolve(datasetRoot, "coverage.json"), coverage);
  await writeJsonAtomically(resolve(datasetRoot, "funding-history.json"), funding);
  return {
    spec,
    split,
    summary: {
      id: spec.id,
      status: "pass",
      symbol: spec.symbol,
      timeframe: spec.timeframe,
      marketCandles: normalized.candles.length,
      markCandles: mark.candles.length,
      indexCandles: index.candles.length,
      fundingRecords: funding.records.length,
      fundingCoverage: coverage.fundingCoverage,
      structureCoverage: coverage.structureCoverage,
      records: records.length,
      split: split.report,
      hashes: {
        market: sha256Json(normalized.candles),
        mark: sha256Json(mark.candles),
        index: sha256Json(index.candles),
        funding: sha256Json(funding.records),
      },
    },
  };
}

function combine(datasets, key) {
  return Object.freeze(datasets.flatMap((dataset) => dataset.split[key]));
}

function compareMetrics(reference, candidate) {
  return Object.freeze({
    logLossImprovement: reference.logLoss - candidate.logLoss,
    macroF1Delta: candidate.macroF1 - reference.macroF1,
    accuracyDelta: candidate.accuracy - reference.accuracy,
    brierImprovement: reference.brier - candidate.brier,
    eceImprovement: reference.expectedCalibrationError - candidate.expectedCalibrationError,
  });
}

function strictPromotion({ overall, perDataset, temperature, minimumCoverage, promotedStatus }) {
  const reasons = [];
  if (minimumCoverage < 0.98) reasons.push("structure_coverage_below_gate");
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
    status: reasons.length === 0 ? promotedStatus : "research_hold",
    reasons: Object.freeze(reasons),
  });
}

function evaluatePerDataset(datasets, referenceModel, candidateModel) {
  return Object.fromEntries(datasets.map((dataset) => {
    const reference = evaluateTinyModel(dataset.split.test, referenceModel);
    const candidate = evaluateTinyModel(dataset.split.test, candidateModel);
    return [dataset.spec.id, {
      reference: metricSummary(reference),
      candidate: metricSummary(candidate),
      comparison: compareMetrics(reference, candidate),
    }];
  }));
}

async function trainGroup({ group, datasets, candidateRoot, ensembleRoot }) {
  const train = combine(datasets, "train");
  const validation = combine(datasets, "validation");
  const test = combine(datasets, "test");
  const referenceModel = await loadV1Model(group);
  const trained = trainTinySoftmaxModel(train, {
    featureOrder: FEATURE_ORDER,
    id: `tiny-softmax-${group}-market-structure-v3`,
    epochs: 800,
    learningRate: 0.055,
    l2: 0.006,
    patience: 90,
  });
  const candidateModel = calibrateTemperature(validation, trained, { minTemperature: 0.5, maxTemperature: 5, step: 0.05 });
  const referenceMetrics = evaluateTinyModel(test, referenceModel);
  const candidateMetrics = evaluateTinyModel(test, candidateModel);
  const overall = compareMetrics(referenceMetrics, candidateMetrics);
  const perDataset = evaluatePerDataset(datasets, referenceModel, candidateModel);
  const minimumCoverage = Math.min(...datasets.map((dataset) => dataset.summary.structureCoverage));
  const promotion = strictPromotion({
    overall,
    perDataset: Object.fromEntries(Object.entries(perDataset).map(([id, value]) => [id, value.comparison])),
    temperature: candidateModel.temperature,
    minimumCoverage,
    promotedStatus: "shadow_candidate_v3",
  });
  const artifact = {
    schemaVersion: 1,
    status: promotion.status,
    group,
    sourceDatasets: datasets.map((dataset) => dataset.spec.id),
    temporalSafety: {
      fundingAtOrBeforeAnchorOnly: true,
      markAndIndexExactAnchorMatchOnly: true,
      historicalOpenInterestInvented: false,
      currentValuesAppliedToPast: false,
    },
    featureOrder: FEATURE_ORDER,
    coverage: Object.fromEntries(datasets.map((dataset) => [dataset.spec.id, {
      funding: dataset.summary.fundingCoverage,
      structure: dataset.summary.structureCoverage,
    }])),
    model: candidateModel,
    referenceTest: metricSummary(referenceMetrics),
    candidateTest: metricSummary(candidateMetrics),
    comparison: overall,
    promotion,
    perDataset,
  };
  await writeJsonAtomically(resolve(candidateRoot, `${group}-market-structure-v3.json`), artifact);

  const selected = selectProbabilityEnsemble(validation, {
    id: `tiny-ensemble-${group}-v1-v3-v4`,
    referenceModel,
    alternateModel: candidateModel,
    weightStep: 0.05,
    minTemperature: 0.5,
    maxTemperature: 3,
    temperatureStep: 0.05,
  });
  const ensembleMetrics = evaluateTinyModel(test, selected.model);
  const ensembleOverall = compareMetrics(referenceMetrics, ensembleMetrics);
  const ensemblePerDataset = evaluatePerDataset(datasets, referenceModel, selected.model);
  const ensemblePromotion = strictPromotion({
    overall: ensembleOverall,
    perDataset: Object.fromEntries(Object.entries(ensemblePerDataset).map(([id, value]) => [id, value.comparison])),
    temperature: selected.model.temperature,
    minimumCoverage,
    promotedStatus: "shadow_candidate_v4",
  });
  if (selected.selection.alternateWeight <= 0) {
    ensemblePromotion.reasons.push?.("alternate_model_weight_is_zero");
  }
  const finalEnsemblePromotion = selected.selection.alternateWeight <= 0
    ? Object.freeze({ promoted: false, status: "research_hold", reasons: Object.freeze([...ensemblePromotion.reasons, "alternate_model_weight_is_zero"]) })
    : ensemblePromotion;
  const ensembleArtifact = {
    schemaVersion: 1,
    status: finalEnsemblePromotion.status,
    group,
    sourceDatasets: datasets.map((dataset) => dataset.spec.id),
    selectionUsesValidationOnly: true,
    testUsedForSelection: false,
    temporalSafety: artifact.temporalSafety,
    coverage: artifact.coverage,
    selection: selected.selection,
    model: selected.model,
    referenceTest: metricSummary(referenceMetrics),
    candidateTest: metricSummary(ensembleMetrics),
    comparison: ensembleOverall,
    promotion: finalEnsemblePromotion,
    perDataset: ensemblePerDataset,
  };
  await writeJsonAtomically(resolve(ensembleRoot, `${group}-ensemble-v4.json`), ensembleArtifact);
  return Object.freeze({ v3: artifact, v4: ensembleArtifact });
}

const outputRoot = resolve(process.argv[2] ?? "live-market-structure-suite");
const reportPath = resolve(process.argv[3] ?? "docs/market-structure-suite-result.json");
const candidateRoot = resolve(process.argv[4] ?? "docs/candidate-models-v3");
const ensembleRoot = resolve(process.argv[5] ?? "docs/candidate-models-v4");
const suiteEndTime = Date.now();
const client = new BitgetPublicClient({ minIntervalMs: 180, maxRetries: 4, timeoutMs: 12_000 });
const datasets = [];
const datasetResults = [];

for (const spec of SPECS) {
  try {
    const result = await collectDataset({ client, spec, suiteEndTime, outputRoot });
    datasets.push(result);
    datasetResults.push(result.summary);
  } catch (error) {
    datasetResults.push({ id: spec.id, status: "fail", symbol: spec.symbol, timeframe: spec.timeframe, error: serializeError(error) });
  }
}

const models = {};
for (const group of [...new Set(SPECS.map((spec) => spec.group))]) {
  const expectedCount = SPECS.filter((spec) => spec.group === group).length;
  const groupDatasets = datasets.filter((dataset) => dataset.spec.group === group);
  if (groupDatasets.length !== expectedCount) {
    models[group] = { status: "not_trained", reason: "one_or_more_datasets_failed" };
    continue;
  }
  try {
    models[group] = await trainGroup({ group, datasets: groupDatasets, candidateRoot, ensembleRoot });
  } catch (error) {
    models[group] = { status: "training_failed", error: serializeError(error) };
  }
}

const technicalFailures = datasetResults.filter((result) => result.status !== "pass").length
  + Object.values(models).filter((model) => ["not_trained", "training_failed"].includes(model.status)).length;
const report = {
  schemaVersion: 2,
  status: technicalFailures === 0 ? "pass" : "fail",
  stage: "complete",
  verifiedAt: Date.now(),
  source: "github-actions-isolated-market-structure-suite",
  suiteEndTime,
  datasets: datasetResults,
  models,
  safety: {
    usesPublicMarketDataOnly: true,
    exactTemporalJoinRequired: true,
    historicalOpenInterestInvented: false,
    ensembleSelectionUsesValidationOnly: true,
    testUsedForSelection: false,
    modifiesExistingAppApi: false,
    modelDeployment: false,
  },
};
await writeJsonAtomically(reportPath, report);
console.log(JSON.stringify(report, null, 2));
if (report.status !== "pass") process.exitCode = 1;

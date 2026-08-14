import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { predictTinyModel } from '../src/tiny-model.js';

const CLASS_NAMES = Object.freeze(['bullish', 'neutral', 'bearish']);
const GROUPS = Object.freeze(['crypto-futures-15m', 'crypto-futures-1h']);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readJsonOptional(filePath) {
  try { return await readJson(filePath); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function loadCandidate(group) {
  const v1 = await readJson(resolve('docs/candidate-models', `${group}.json`));
  if (!v1?.model?.trained) throw new Error(`missing trained V1 candidate for ${group}`);
  const v4 = await readJsonOptional(resolve('docs/candidate-models-v4', `${group}-ensemble-v4.json`));
  if (v4?.status === 'shadow_candidate_v4' && v4?.model?.trained) return { model: v4.model, source: 'ensemble-v4' };
  const v3 = await readJsonOptional(resolve('docs/candidate-models-v3', `${group}-market-structure-v3.json`));
  if (v3?.status === 'shadow_candidate_v3' && v3?.model?.trained) return { model: v3.model, source: 'market-structure-v3' };
  const v2 = await readJsonOptional(resolve('docs/candidate-models-v2', `${group}-funding-v2.json`));
  if (v2?.status === 'shadow_candidate_v2' && v2?.model?.trained) return { model: v2.model, source: 'funding-v2' };
  return { model: v1.model, source: 'v1' };
}

function predictedClass(probabilities) {
  return CLASS_NAMES.reduce((best, name) => probabilities[name] > probabilities[best] ? name : best, CLASS_NAMES[0]);
}

function classDistribution(rows, selector) {
  const counts = Object.fromEntries(CLASS_NAMES.map((name) => [name, 0]));
  for (const row of rows) counts[selector(row)] += 1;
  return counts;
}

function safeLogLoss(probabilities, actual) {
  return -Math.log(Math.max(Number(probabilities?.[actual]) || 0, 1e-12));
}

function brier(probabilities, actual) {
  return CLASS_NAMES.reduce((sum, name) => sum + ((Number(probabilities?.[name]) || 0) - (name === actual ? 1 : 0)) ** 2, 0);
}

function metrics(rows, probabilitySelector) {
  const settled = rows.filter((row) => row.status === 'settled' && CLASS_NAMES.includes(row.actualDirection));
  if (!settled.length) return null;
  const confusion = Object.fromEntries(CLASS_NAMES.map((actual) => [actual, Object.fromEntries(CLASS_NAMES.map((predicted) => [predicted, 0]))]));
  let hits = 0;
  let logLoss = 0;
  let brierScore = 0;
  for (const row of settled) {
    const probabilities = probabilitySelector(row);
    const predicted = predictedClass(probabilities);
    confusion[row.actualDirection][predicted] += 1;
    if (predicted === row.actualDirection) hits += 1;
    logLoss += safeLogLoss(probabilities, row.actualDirection);
    brierScore += brier(probabilities, row.actualDirection);
  }
  const perClass = {};
  for (const name of CLASS_NAMES) {
    const tp = confusion[name][name];
    const fp = CLASS_NAMES.reduce((sum, actual) => sum + (actual === name ? 0 : confusion[actual][name]), 0);
    const fn = CLASS_NAMES.reduce((sum, predicted) => sum + (predicted === name ? 0 : confusion[name][predicted]), 0);
    const precision = tp / Math.max(tp + fp, 1);
    const recall = tp / Math.max(tp + fn, 1);
    const f1 = 2 * precision * recall / Math.max(precision + recall, 1e-12);
    perClass[name] = { precision, recall, f1 };
  }
  return {
    sampleCount: settled.length,
    accuracy: hits / settled.length,
    macroF1: CLASS_NAMES.reduce((sum, name) => sum + perClass[name].f1, 0) / CLASS_NAMES.length,
    logLoss: logLoss / settled.length,
    brier: brierScore / settled.length,
    perClass,
    confusion,
  };
}

function summarizeBySymbol(rows) {
  const symbols = [...new Set(rows.map((row) => row.symbol))].sort();
  return Object.fromEntries(symbols.map((symbol) => {
    const selected = rows.filter((row) => row.symbol === symbol);
    return [symbol, {
      sampleCount: selected.length,
      originalPredicted: classDistribution(selected, (row) => row.candidateClass),
      parityPredicted: classDistribution(selected, (row) => row.parityClass),
      changedClassCount: selected.filter((row) => row.candidateClass !== row.parityClass).length,
    }];
  }));
}

function replayRecord(record, model) {
  const features = { ...(record.features ?? {}) };
  const originalOi = Number.isFinite(features.openInterestChange) ? features.openInterestChange : null;
  delete features.openInterestChange;
  const replay = predictTinyModel(features, model);
  return {
    id: record.id,
    status: record.status,
    symbol: record.symbol,
    timeframe: record.timeframe,
    anchorTimestamp: record.anchorTimestamp,
    actualDirection: record.actualDirection ?? null,
    candidateClass: record.candidateClass,
    parityClass: predictedClass(replay.probabilities),
    candidateProbabilities: record.candidateProbabilities,
    parityProbabilities: replay.probabilities,
    originalOpenInterestChange: originalOi,
    originalOpenInterestKnown: record.featureAvailability?.openInterestKnown === true,
  };
}

const inputPath = resolve(process.argv[2] ?? 'docs/shadow-state.json');
const outputPath = resolve(process.argv[3] ?? 'docs/shadow-oi-parity-replay.json');
const state = await readJson(inputPath);
const result = {
  schemaVersion: 1,
  generatedAt: Date.now(),
  sourceState: inputPath,
  mode: 'counterfactual-replay-remove-open-interest-change',
  selectionOrTuningUsed: false,
  finalHoldoutUsed: false,
  modelRetrained: false,
  thresholdChanged: false,
  classWeightChanged: false,
  groups: {},
  safety: {
    publicNetworkRequests: 0,
    privateAccountRequests: 0,
    actualOrders: 0,
    writesSourceState: false,
    executionAuthority: 'NONE',
  },
};

for (const group of GROUPS) {
  const selected = state.groups?.[group]?.records ?? [];
  const { model, source } = await loadCandidate(group);
  const rows = selected
    .filter((record) => record.modelId === model.id)
    .map((record) => replayRecord(record, model));
  const original = metrics(rows, (row) => row.candidateProbabilities);
  const parity = metrics(rows, (row) => row.parityProbabilities);
  result.groups[group] = {
    modelId: model.id,
    modelSource: source,
    totalCurrentModelRecords: rows.length,
    settled: rows.filter((row) => row.status === 'settled').length,
    originalOiKnownCount: rows.filter((row) => row.originalOpenInterestKnown).length,
    originalOiNonZeroCount: rows.filter((row) => row.originalOpenInterestChange != null && Math.abs(row.originalOpenInterestChange) > 1e-15).length,
    originalPredicted: classDistribution(rows, (row) => row.candidateClass),
    parityPredicted: classDistribution(rows, (row) => row.parityClass),
    changedClassCount: rows.filter((row) => row.candidateClass !== row.parityClass).length,
    changedClassRate: rows.length ? rows.filter((row) => row.candidateClass !== row.parityClass).length / rows.length : 0,
    originalMetrics: original,
    parityMetrics: parity,
    metricDelta: original && parity ? {
      accuracy: parity.accuracy - original.accuracy,
      macroF1: parity.macroF1 - original.macroF1,
      logLossImprovement: original.logLoss - parity.logLoss,
      brierImprovement: original.brier - parity.brier,
    } : null,
    bySymbol: summarizeBySymbol(rows),
  };
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));

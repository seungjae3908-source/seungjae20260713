import { scoreToProbabilities } from "./rules.js";
import { predictTinyModel } from "./tiny-model.js";

const CLASS_NAMES = Object.freeze(["bullish", "neutral", "bearish"]);
export const DEPLOYED_RULE_WEIGHT = 0.65;
export const DEFAULT_RULE_WEIGHT_GRID = Object.freeze([
  0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65,
]);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalize(probabilities) {
  const values = CLASS_NAMES.map((name) => Math.max(0, finite(probabilities?.[name]) ? probabilities[name] : 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) throw new TypeError("probabilities must contain positive finite mass");
  return Object.freeze(Object.fromEntries(CLASS_NAMES.map((name, index) => [name, values[index] / total])));
}

function assertRecords(records, label, minimum = 30) {
  if (!Array.isArray(records) || records.length < minimum) {
    throw new TypeError(`${label} must contain at least ${minimum} records`);
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record?.features || !CLASS_NAMES.includes(record?.label?.direction)) {
      throw new TypeError(`${label}[${index}] is invalid`);
    }
    if (!finite(record.ruleScore)) {
      throw new TypeError(`${label}[${index}].ruleScore is required`);
    }
  }
}

export function predictRuleModelBlend(record, model, ruleWeight) {
  if (!(finite(ruleWeight) && ruleWeight >= 0 && ruleWeight <= 1)) {
    throw new RangeError("ruleWeight must be in [0, 1]");
  }
  if (!record?.features || !finite(record.ruleScore)) {
    throw new TypeError("features and ruleScore are required");
  }
  const rule = scoreToProbabilities(record.ruleScore);
  const modelProbabilities = predictTinyModel(record.features, model).probabilities;
  const probabilities = normalize(Object.fromEntries(CLASS_NAMES.map((name) => [
    name,
    (rule[name] * ruleWeight) + (modelProbabilities[name] * (1 - ruleWeight)),
  ])));
  return Object.freeze({ ruleWeight, modelWeight: 1 - ruleWeight, probabilities });
}

function predictedClass(probabilities) {
  return CLASS_NAMES.reduce((best, name) => probabilities[name] > probabilities[best] ? name : best, CLASS_NAMES[0]);
}

export function evaluateRuleModelBlend(records, model, ruleWeight) {
  assertRecords(records, "records");
  const confusion = Object.fromEntries(CLASS_NAMES.map((actual) => [actual,
    Object.fromEntries(CLASS_NAMES.map((predicted) => [predicted, 0]))]));
  const predictedCounts = Object.fromEntries(CLASS_NAMES.map((name) => [name, 0]));
  let correct = 0;
  let logLoss = 0;
  let brier = 0;

  for (const record of records) {
    const actual = record.label.direction;
    const probabilities = predictRuleModelBlend(record, model, ruleWeight).probabilities;
    const predicted = predictedClass(probabilities);
    predictedCounts[predicted] += 1;
    confusion[actual][predicted] += 1;
    if (predicted === actual) correct += 1;
    logLoss -= Math.log(Math.max(probabilities[actual], 1e-12));
    for (const name of CLASS_NAMES) {
      brier += (probabilities[name] - (actual === name ? 1 : 0)) ** 2;
    }
  }

  const perClass = {};
  for (const name of CLASS_NAMES) {
    const tp = confusion[name][name];
    const fp = CLASS_NAMES.reduce((sum, actual) => sum + (actual === name ? 0 : confusion[actual][name]), 0);
    const fn = CLASS_NAMES.reduce((sum, predicted) => sum + (predicted === name ? 0 : confusion[name][predicted]), 0);
    const support = CLASS_NAMES.reduce((sum, predicted) => sum + confusion[name][predicted], 0);
    const precision = tp / Math.max(tp + fp, 1);
    const recall = tp / Math.max(tp + fn, 1);
    const f1 = 2 * precision * recall / Math.max(precision + recall, 1e-12);
    perClass[name] = Object.freeze({ support, precision, recall, f1 });
  }

  const predictedShares = Object.freeze(Object.fromEntries(CLASS_NAMES.map((name) => [name, predictedCounts[name] / records.length])));
  return Object.freeze({
    sampleCount: records.length,
    ruleWeight,
    modelWeight: 1 - ruleWeight,
    accuracy: correct / records.length,
    balancedAccuracy: CLASS_NAMES.reduce((sum, name) => sum + perClass[name].recall, 0) / CLASS_NAMES.length,
    macroF1: CLASS_NAMES.reduce((sum, name) => sum + perClass[name].f1, 0) / CLASS_NAMES.length,
    logLoss: logLoss / records.length,
    brier: brier / records.length,
    confusion: Object.freeze(confusion),
    perClass: Object.freeze(perClass),
    predictedCounts: Object.freeze(predictedCounts),
    predictedShares,
  });
}

export function evaluateBlendHealth(metrics, {
  maxDominantPredictionShare = 0.9,
  minDirectionalRecall = 0.05,
  minDirectionalSupport = 5,
} = {}) {
  const shares = metrics?.predictedShares ?? {};
  const dominantClass = CLASS_NAMES.reduce((best, name) => (shares[name] ?? 0) > (shares[best] ?? 0) ? name : best, CLASS_NAMES[0]);
  const dominantShare = shares[dominantClass] ?? 0;
  const bullish = metrics?.perClass?.bullish ?? { support: 0, recall: 0 };
  const bearish = metrics?.perClass?.bearish ?? { support: 0, recall: 0 };
  const directionalEligible = bullish.support >= minDirectionalSupport && bearish.support >= minDirectionalSupport;
  const directionalRecallAverage = (bullish.recall + bearish.recall) / 2;
  const reasons = [];
  if (dominantShare >= maxDominantPredictionShare) reasons.push(`dominant_prediction_share:${dominantClass}`);
  if (directionalEligible && bullish.recall < minDirectionalRecall && bearish.recall < minDirectionalRecall) {
    reasons.push("directional_recall_collapse");
  }
  return Object.freeze({
    collapsed: reasons.length > 0,
    dominantClass,
    dominantShare,
    directionalRecallAverage,
    directionalRecall: Object.freeze({ bullish: bullish.recall, bearish: bearish.recall }),
    reasons: Object.freeze(reasons),
  });
}

function comparison(baseline, candidate) {
  return Object.freeze({
    accuracyDelta: candidate.accuracy - baseline.accuracy,
    balancedAccuracyDelta: candidate.balancedAccuracy - baseline.balancedAccuracy,
    macroF1Delta: candidate.macroF1 - baseline.macroF1,
    logLossImprovement: baseline.logLoss - candidate.logLoss,
    brierImprovement: baseline.brier - candidate.brier,
    directionalRecallAverageDelta:
      ((candidate.perClass.bullish.recall + candidate.perClass.bearish.recall) / 2)
      - ((baseline.perClass.bullish.recall + baseline.perClass.bearish.recall) / 2),
  });
}

function candidateGrid(weights) {
  const normalized = [...new Set(weights
    .filter((weight) => finite(weight) && weight >= 0 && weight <= DEPLOYED_RULE_WEIGHT)
    .map((weight) => Math.round(weight * 1000) / 1000))]
    .sort((left, right) => left - right);
  if (!normalized.includes(DEPLOYED_RULE_WEIGHT)) normalized.push(DEPLOYED_RULE_WEIGHT);
  return normalized.sort((left, right) => left - right);
}

export function buildRuleModelBlendChallenger({
  validationRecords,
  testRecords,
  model,
  ruleWeights = DEFAULT_RULE_WEIGHT_GRID,
  deployedRuleWeight = DEPLOYED_RULE_WEIGHT,
  minTestSamples = 60,
} = {}) {
  assertRecords(validationRecords, "validationRecords", 30);
  assertRecords(testRecords, "testRecords", minTestSamples);
  if (!model?.trained || typeof model.id !== "string") throw new TypeError("trained model is required");
  if (deployedRuleWeight !== DEPLOYED_RULE_WEIGHT) throw new RangeError("deployedRuleWeight must remain 0.65 in this research lane");

  const weights = candidateGrid(ruleWeights);
  const validationBaseline = evaluateRuleModelBlend(validationRecords, model, deployedRuleWeight);
  const validationRows = weights.map((ruleWeight) => {
    const metrics = evaluateRuleModelBlend(validationRecords, model, ruleWeight);
    const health = evaluateBlendHealth(metrics);
    const admissible = !health.collapsed
      && metrics.accuracy >= validationBaseline.accuracy - 0.02
      && metrics.logLoss <= validationBaseline.logLoss + 0.02;
    return Object.freeze({ ruleWeight, metrics, health, admissible });
  });

  const selected = validationRows
    .filter((row) => row.admissible)
    .sort((left, right) => right.metrics.macroF1 - left.metrics.macroF1
      || right.metrics.balancedAccuracy - left.metrics.balancedAccuracy
      || left.metrics.logLoss - right.metrics.logLoss
      || right.metrics.accuracy - left.metrics.accuracy
      || right.ruleWeight - left.ruleWeight)[0] ?? null;

  if (!selected) {
    return Object.freeze({
      schemaVersion: 1,
      status: "research_hold",
      reason: "no_admissible_validation_weight",
      modelId: model.id,
      selection: Object.freeze({ source: "validation_only", testUsedForSelection: false, ruleWeights: Object.freeze(weights) }),
      validationBaseline,
      validationRows: Object.freeze(validationRows),
      safety: Object.freeze({ runtimeChanged: false, finalHoldoutUsed: false, paperUsed: false, shadowUsedForSelection: false, liveAuthority: false }),
    });
  }

  const testBaseline = evaluateRuleModelBlend(testRecords, model, deployedRuleWeight);
  const testCandidate = evaluateRuleModelBlend(testRecords, model, selected.ruleWeight);
  const testHealth = evaluateBlendHealth(testCandidate);
  const delta = comparison(testBaseline, testCandidate);
  const reasons = [];
  if (testHealth.collapsed) reasons.push(...testHealth.reasons.map((reason) => `test:${reason}`));
  if (delta.macroF1Delta < 0.05) reasons.push("test_macro_f1_gain_insufficient");
  if (delta.balancedAccuracyDelta < 0.03) reasons.push("test_balanced_accuracy_gain_insufficient");
  if (delta.directionalRecallAverageDelta < 0.03) reasons.push("test_directional_recall_gain_insufficient");
  if (delta.accuracyDelta < -0.02) reasons.push("test_accuracy_regressed");
  if (delta.logLossImprovement < -0.01) reasons.push("test_log_loss_regressed");

  return Object.freeze({
    schemaVersion: 1,
    status: reasons.length === 0 ? "shadow_challenger_candidate" : "research_hold",
    reason: reasons.length === 0 ? null : "untouched_test_gates_failed",
    reasons: Object.freeze(reasons),
    modelId: model.id,
    deployedRuleWeight,
    candidateRuleWeight: selected.ruleWeight,
    selection: Object.freeze({
      source: "validation_only",
      testUsedForSelection: false,
      objectiveOrder: Object.freeze(["macroF1", "balancedAccuracy", "logLoss", "accuracy", "minimal_weight_change_on_tie"]),
      ruleWeights: Object.freeze(weights),
      selectedValidationMetrics: selected.metrics,
      selectedValidationHealth: selected.health,
    }),
    validationBaseline,
    validationRows: Object.freeze(validationRows),
    test: Object.freeze({ baseline: testBaseline, candidate: testCandidate, health: testHealth, comparison: delta }),
    safety: Object.freeze({
      runtimeChanged: false,
      thresholdChanged: false,
      classWeightChanged: false,
      labelChanged: false,
      finalHoldoutUsed: false,
      paperUsed: false,
      shadowUsedForSelection: false,
      liveAuthority: false,
      promotionAuthority: false,
    }),
  });
}

export const RULE_MODEL_BLEND_CLASSES = CLASS_NAMES;

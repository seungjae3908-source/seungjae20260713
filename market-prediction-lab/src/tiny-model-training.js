import { BASELINE_MODEL, predictTinyModel } from "./tiny-model.js";

const CLASS_NAMES = Object.freeze(["bullish", "neutral", "bearish"]);

function finite(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function softmax(logits) {
  const maxValue = Math.max(...logits);
  const exps = logits.map((value) => Math.exp(clamp(value - maxValue, -60, 60)));
  const total = exps.reduce((sum, value) => sum + value, 0) || 1;
  return exps.map((value) => value / total);
}

function assertRecords(records, name, { min = 1 } = {}) {
  if (!Array.isArray(records) || records.length < min) {
    throw new TypeError(`${name} must contain at least ${min} records`);
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || typeof record !== "object" || !record.features || !record.label) {
      throw new TypeError(`${name}[${index}] is invalid`);
    }
    if (!CLASS_NAMES.includes(record.label.direction)) {
      throw new TypeError(`${name}[${index}].label.direction is invalid`);
    }
  }
  return records;
}

function vectorFromFeatures(features, featureOrder, normalization) {
  return featureOrder.map((key, index) => {
    const value = finite(features[key]);
    if (!normalization) return value;
    const mean = finite(normalization.mean[index]);
    const scale = Math.max(Math.abs(finite(normalization.scale[index], 1)), 1e-9);
    return clamp((value - mean) / scale, -12, 12);
  });
}

export function fitFeatureNormalization(records, featureOrder) {
  assertRecords(records, "records");
  if (!Array.isArray(featureOrder) || featureOrder.length === 0) throw new TypeError("featureOrder is required");
  const mean = featureOrder.map((key) => records.reduce((sum, record) => sum + finite(record.features[key]), 0) / records.length);
  const scale = featureOrder.map((key, index) => {
    const variance = records.reduce((sum, record) => {
      const delta = finite(record.features[key]) - mean[index];
      return sum + (delta * delta);
    }, 0) / records.length;
    return Math.max(Math.sqrt(variance), 1e-6);
  });
  return Object.freeze({ mean: Object.freeze(mean), scale: Object.freeze(scale) });
}

function vectorLogits(features, featureOrder, normalization, weights, biases) {
  const vector = vectorFromFeatures(features, featureOrder, normalization);
  return CLASS_NAMES.map((_, classIndex) => biases[classIndex]
    + weights[classIndex].reduce((sum, weight, featureIndex) => sum + weight * vector[featureIndex], 0));
}

function classWeights(records) {
  const counts = Object.fromEntries(CLASS_NAMES.map((name) => [name, 0]));
  for (const record of records) counts[record.label.direction] += 1;
  const weights = {};
  for (const name of CLASS_NAMES) {
    weights[name] = counts[name] === 0 ? 0 : clamp(records.length / (CLASS_NAMES.length * counts[name]), 0.35, 4);
  }
  return { counts, weights };
}

function trainingLoss(records, featureOrder, normalization, weights, biases, classWeightMap, l2) {
  let loss = 0;
  let weightTotal = 0;
  for (const record of records) {
    const probabilities = softmax(vectorLogits(record.features, featureOrder, normalization, weights, biases));
    const targetIndex = CLASS_NAMES.indexOf(record.label.direction);
    const rowWeight = classWeightMap[record.label.direction] || 1;
    loss -= rowWeight * Math.log(Math.max(probabilities[targetIndex], 1e-12));
    weightTotal += rowWeight;
  }
  const penalty = weights.flat().reduce((sum, value) => sum + value * value, 0) * l2 * 0.5;
  return (loss / Math.max(weightTotal, 1)) + penalty;
}

export function trainTinySoftmaxModel(records, {
  featureOrder = BASELINE_MODEL.featureOrder,
  id = "tiny-softmax-candidate-v1",
  epochs = 420,
  learningRate = 0.08,
  l2 = 0.002,
  patience = 45,
} = {}) {
  assertRecords(records, "records", { min: 90 });
  if (!Array.isArray(featureOrder) || featureOrder.length === 0) throw new TypeError("featureOrder is required");
  if (!Number.isInteger(epochs) || epochs < 20 || epochs > 5000) throw new RangeError("epochs must be between 20 and 5000");
  if (!(learningRate > 0 && learningRate <= 1)) throw new RangeError("learningRate must be in (0, 1]");
  if (!(l2 >= 0 && l2 <= 1)) throw new RangeError("l2 must be in [0, 1]");
  if (!Number.isInteger(patience) || patience < 5 || patience > epochs) throw new RangeError("patience must be between 5 and epochs");

  const normalization = fitFeatureNormalization(records, featureOrder);
  const { counts, weights: classWeightMap } = classWeights(records);
  if (Object.values(counts).some((count) => count === 0)) throw new Error("training data must contain all three classes");

  let weights = CLASS_NAMES.map(() => featureOrder.map(() => 0));
  let biases = CLASS_NAMES.map(() => 0);
  let bestLoss = Number.POSITIVE_INFINITY;
  let best = null;
  let staleEpochs = 0;
  let epochsRun = 0;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradWeights = CLASS_NAMES.map(() => featureOrder.map(() => 0));
    const gradBiases = CLASS_NAMES.map(() => 0);
    let weightTotal = 0;
    for (const record of records) {
      const vector = vectorFromFeatures(record.features, featureOrder, normalization);
      const logits = CLASS_NAMES.map((_, classIndex) => biases[classIndex]
        + weights[classIndex].reduce((sum, weight, featureIndex) => sum + weight * vector[featureIndex], 0));
      const probabilities = softmax(logits);
      const targetIndex = CLASS_NAMES.indexOf(record.label.direction);
      const rowWeight = classWeightMap[record.label.direction] || 1;
      weightTotal += rowWeight;
      for (let classIndex = 0; classIndex < CLASS_NAMES.length; classIndex += 1) {
        const error = (probabilities[classIndex] - (classIndex === targetIndex ? 1 : 0)) * rowWeight;
        gradBiases[classIndex] += error;
        for (let featureIndex = 0; featureIndex < featureOrder.length; featureIndex += 1) {
          gradWeights[classIndex][featureIndex] += error * vector[featureIndex];
        }
      }
    }

    const lr = learningRate / Math.sqrt(1 + epoch * 0.02);
    for (let classIndex = 0; classIndex < CLASS_NAMES.length; classIndex += 1) {
      biases[classIndex] -= lr * (gradBiases[classIndex] / Math.max(weightTotal, 1));
      for (let featureIndex = 0; featureIndex < featureOrder.length; featureIndex += 1) {
        const gradient = (gradWeights[classIndex][featureIndex] / Math.max(weightTotal, 1))
          + l2 * weights[classIndex][featureIndex];
        weights[classIndex][featureIndex] -= lr * gradient;
      }
    }

    epochsRun = epoch + 1;
    if (epoch % 5 === 0 || epoch === epochs - 1) {
      const loss = trainingLoss(records, featureOrder, normalization, weights, biases, classWeightMap, l2);
      if (!Number.isFinite(loss)) throw new Error("training produced a non-finite loss");
      if (loss < bestLoss - 1e-7) {
        bestLoss = loss;
        best = { weights: weights.map((row) => [...row]), biases: [...biases] };
        staleEpochs = 0;
      } else {
        staleEpochs += 5;
        if (staleEpochs >= patience) break;
      }
    }
  }

  if (!best) throw new Error("training did not produce a finite model");
  const classes = Object.freeze(Object.fromEntries(CLASS_NAMES.map((name, index) => [name, Object.freeze({
    bias: best.biases[index],
    weights: Object.freeze(best.weights[index]),
  })])));
  return Object.freeze({
    id,
    trained: true,
    modelType: "multinomial-logistic-regression",
    featureOrder: Object.freeze([...featureOrder]),
    normalization,
    temperature: 1,
    classes,
    training: Object.freeze({
      sampleCount: records.length,
      classCounts: Object.freeze(counts),
      epochsRun,
      learningRate,
      l2,
      weightedTrainingLoss: bestLoss,
    }),
  });
}

function normalizeStoredProbabilities(probabilities, index) {
  if (!probabilities || CLASS_NAMES.some((name) => !Number.isFinite(probabilities[name]))) {
    throw new TypeError(`records[${index}].probabilities are invalid`);
  }
  const total = CLASS_NAMES.reduce((sum, name) => sum + Math.max(0, probabilities[name]), 0) || 1;
  return Object.freeze(Object.fromEntries(CLASS_NAMES.map((name) => [name, Math.max(0, probabilities[name]) / total])));
}

function metricsFromRows(rows) {
  const confusion = Object.fromEntries(CLASS_NAMES.map((actual) => [actual,
    Object.fromEntries(CLASS_NAMES.map((predicted) => [predicted, 0]))]));
  let correct = 0;
  let logLoss = 0;
  let brier = 0;
  const bins = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, correct: 0 }));

  for (const row of rows) {
    const predicted = CLASS_NAMES.reduce((best, name) => row.probabilities[name] > row.probabilities[best] ? name : best, CLASS_NAMES[0]);
    const hit = predicted === row.actual;
    if (hit) correct += 1;
    confusion[row.actual][predicted] += 1;
    logLoss -= Math.log(Math.max(row.probabilities[row.actual], 1e-12));
    for (const name of CLASS_NAMES) brier += (row.probabilities[name] - (row.actual === name ? 1 : 0)) ** 2;
    const confidence = row.probabilities[predicted];
    const bin = bins[Math.min(9, Math.floor(confidence * 10))];
    bin.count += 1;
    bin.confidence += confidence;
    bin.correct += hit ? 1 : 0;
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

  const macroF1 = CLASS_NAMES.reduce((sum, name) => sum + perClass[name].f1, 0) / CLASS_NAMES.length;
  const balancedAccuracy = CLASS_NAMES.reduce((sum, name) => sum + perClass[name].recall, 0) / CLASS_NAMES.length;
  const expectedCalibrationError = bins.reduce((sum, bin) => {
    if (bin.count === 0) return sum;
    return sum + (bin.count / rows.length) * Math.abs((bin.correct / bin.count) - (bin.confidence / bin.count));
  }, 0);

  return Object.freeze({
    sampleCount: rows.length,
    accuracy: correct / rows.length,
    balancedAccuracy,
    macroF1,
    logLoss: logLoss / rows.length,
    brier: brier / rows.length,
    expectedCalibrationError,
    confusion: Object.freeze(confusion),
    perClass: Object.freeze(perClass),
  });
}

export function evaluateTinyModel(records, model) {
  assertRecords(records, "records");
  return metricsFromRows(records.map((record) => ({
    actual: record.label.direction,
    probabilities: predictTinyModel(record.features, model).probabilities,
  })));
}

export function evaluateStoredBaseline(records) {
  assertRecords(records, "records");
  return metricsFromRows(records.map((record, index) => ({
    actual: record.label.direction,
    probabilities: normalizeStoredProbabilities(record.probabilities, index),
  })));
}

export function calibrateTemperature(records, model, {
  minTemperature = 0.5,
  maxTemperature = 3,
  step = 0.05,
} = {}) {
  assertRecords(records, "records", { min: 30 });
  if (!(minTemperature >= 0.2 && maxTemperature <= 5 && minTemperature <= maxTemperature)) {
    throw new RangeError("temperature range is invalid");
  }
  if (!(step > 0 && step <= 0.5)) throw new RangeError("temperature step is invalid");

  let bestTemperature = 1;
  let bestLogLoss = Number.POSITIVE_INFINITY;
  for (let temperature = minTemperature; temperature <= maxTemperature + 1e-9; temperature += step) {
    const candidate = { ...model, temperature };
    let loss = 0;
    for (const record of records) {
      const probabilities = predictTinyModel(record.features, candidate).probabilities;
      loss -= Math.log(Math.max(probabilities[record.label.direction], 1e-12));
    }
    loss /= records.length;
    if (loss < bestLogLoss) {
      bestLogLoss = loss;
      bestTemperature = temperature;
    }
  }

  return Object.freeze({
    ...model,
    id: `${model.id}-calibrated`,
    temperature: Math.round(bestTemperature * 1000) / 1000,
    calibration: Object.freeze({ sampleCount: records.length, validationLogLoss: bestLogLoss }),
  });
}

export function compareCandidateToBaseline(baseline, candidate) {
  for (const metrics of [baseline, candidate]) {
    if (!metrics || !Number.isFinite(metrics.logLoss) || !Number.isFinite(metrics.macroF1)
        || !Number.isFinite(metrics.accuracy)) throw new TypeError("metrics are invalid");
  }
  const logLossImprovement = baseline.logLoss - candidate.logLoss;
  const promoted = logLossImprovement >= 0.002
    && candidate.macroF1 >= baseline.macroF1 - 0.02
    && candidate.accuracy >= baseline.accuracy - 0.01;
  return Object.freeze({
    promoted,
    status: promoted ? "candidate_pass" : "candidate_hold",
    logLossImprovement,
    macroF1Delta: candidate.macroF1 - baseline.macroF1,
    accuracyDelta: candidate.accuracy - baseline.accuracy,
    reasons: Object.freeze([
      ...(logLossImprovement < 0.002 ? ["log_loss_improvement_insufficient"] : []),
      ...(candidate.macroF1 < baseline.macroF1 - 0.02 ? ["macro_f1_regressed"] : []),
      ...(candidate.accuracy < baseline.accuracy - 0.01 ? ["accuracy_regressed"] : []),
    ]),
  });
}

export const TINY_MODEL_CLASS_NAMES = CLASS_NAMES;

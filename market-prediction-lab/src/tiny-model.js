import { round } from "./contracts.js";

export const BASELINE_MODEL = Object.freeze({
  id: "tiny-linear-baseline-v0",
  trained: false,
  featureOrder: Object.freeze([
    "return5",
    "return20",
    "emaGap",
    "rsiCentered",
    "macdHistogramPct",
    "atrPct",
    "volumeRatio",
    "trendSlope",
    "sentimentScore",
    "benchmarkReturn",
    "foreignNetRatio",
    "institutionNetRatio",
    "openInterestChange",
    "fundingRate",
    "longShortBias",
  ]),
  classes: Object.freeze({
    bullish: Object.freeze({ bias: 0, weights: Object.freeze([7, 4, 70, 0.25, 900, -2.5, 0.18, 18, 0.45, 2.5, 0.25, 0.25, 0.35, -8, -0.08]) }),
    neutral: Object.freeze({ bias: 0.35, weights: Object.freeze([-1, -1, -10, -0.05, -120, 2.2, -0.08, -3, -0.1, -0.4, -0.05, -0.05, -0.08, 1.5, 0.03]) }),
    bearish: Object.freeze({ bias: 0, weights: Object.freeze([-7, -4, -70, -0.25, -900, -2.5, -0.18, -18, -0.45, -2.5, -0.25, -0.25, -0.35, 8, 0.08]) }),
  }),
});

const CLASS_NAMES = Object.freeze(["bullish", "neutral", "bearish"]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finite(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function dot(weights, vector) {
  return weights.reduce((sum, weight, index) => sum + (finite(weight) * vector[index]), 0);
}

function softmax(logits) {
  const maxValue = Math.max(...logits);
  const exps = logits.map((value) => Math.exp(clamp(value - maxValue, -60, 60)));
  const total = exps.reduce((sum, value) => sum + value, 0) || 1;
  return exps.map((value) => value / total);
}

function featureVector(features, model) {
  const normalization = model.normalization;
  return model.featureOrder.map((key, index) => {
    const value = finite(features[key]);
    if (!normalization) return value;
    if (!Array.isArray(normalization.mean) || !Array.isArray(normalization.scale)
        || normalization.mean.length !== model.featureOrder.length
        || normalization.scale.length !== model.featureOrder.length) {
      throw new Error("invalid tiny model normalization");
    }
    const mean = finite(normalization.mean[index]);
    const scale = Math.max(Math.abs(finite(normalization.scale[index], 1)), 1e-9);
    return clamp((value - mean) / scale, -12, 12);
  });
}

function temperatureScaleProbabilities(probabilities, temperature) {
  const logits = CLASS_NAMES.map((name) => Math.log(Math.max(probabilities[name], 1e-12)) / temperature);
  const scaled = softmax(logits);
  return Object.fromEntries(CLASS_NAMES.map((name, index) => [name, scaled[index]]));
}

function predictLinearModel(features, model) {
  if (!Array.isArray(model.featureOrder) || model.featureOrder.length === 0) {
    throw new Error("invalid tiny model feature order");
  }
  const vector = featureVector(features, model);
  const temperature = clamp(finite(model.temperature, 1), 0.2, 5);
  const logits = CLASS_NAMES.map((name) => {
    const classModel = model.classes?.[name];
    if (!classModel || !Array.isArray(classModel.weights) || classModel.weights.length !== vector.length) {
      throw new Error(`invalid tiny model class definition: ${name}`);
    }
    return (finite(classModel.bias) + dot(classModel.weights, vector)) / temperature;
  });
  const values = softmax(logits);
  return Object.fromEntries(CLASS_NAMES.map((name, index) => [name, values[index]]));
}

function predictEnsemble(features, model, depth) {
  if (!Array.isArray(model.components) || model.components.length < 2 || model.components.length > 8) {
    throw new Error("probability ensemble must contain 2-8 components");
  }
  const weights = model.components.map((component, index) => {
    if (!component || typeof component !== "object" || !component.model) throw new Error(`invalid ensemble component: ${index}`);
    const weight = finite(component.weight, Number.NaN);
    if (!(weight >= 0)) throw new Error(`invalid ensemble weight: ${index}`);
    return weight;
  });
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (!(totalWeight > 0)) throw new Error("ensemble weight total must be positive");
  const combined = Object.fromEntries(CLASS_NAMES.map((name) => [name, 0]));
  model.components.forEach((component, index) => {
    const child = predictModelProbabilities(features, component.model, depth + 1);
    for (const name of CLASS_NAMES) combined[name] += child[name] * weights[index] / totalWeight;
  });
  const temperature = clamp(finite(model.temperature, 1), 0.2, 5);
  return temperatureScaleProbabilities(combined, temperature);
}

function predictModelProbabilities(features, model, depth = 0) {
  if (!model || typeof model !== "object") throw new Error("invalid tiny model");
  if (depth > 4) throw new Error("tiny model nesting is too deep");
  if (model.modelType === "probability-ensemble") return predictEnsemble(features, model, depth);
  return predictLinearModel(features, model);
}

export function predictTinyModel(features, model = BASELINE_MODEL) {
  const probabilities = predictModelProbabilities(features, model);
  return Object.freeze({
    modelId: model.id,
    trained: model.trained === true,
    probabilities: Object.freeze({
      bullish: round(probabilities.bullish, 10),
      neutral: round(probabilities.neutral, 10),
      bearish: round(probabilities.bearish, 10),
    }),
  });
}

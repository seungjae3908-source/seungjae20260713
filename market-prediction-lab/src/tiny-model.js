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

export function predictTinyModel(features, model = BASELINE_MODEL) {
  if (!model || !Array.isArray(model.featureOrder) || model.featureOrder.length === 0) {
    throw new Error("invalid tiny model feature order");
  }
  const vector = featureVector(features, model);
  const classNames = ["bullish", "neutral", "bearish"];
  const temperature = clamp(finite(model.temperature, 1), 0.2, 5);
  const logits = classNames.map((name) => {
    const classModel = model.classes?.[name];
    if (!classModel || !Array.isArray(classModel.weights) || classModel.weights.length !== vector.length) {
      throw new Error(`invalid tiny model class definition: ${name}`);
    }
    return (finite(classModel.bias) + dot(classModel.weights, vector)) / temperature;
  });
  const probabilities = softmax(logits);
  return Object.freeze({
    modelId: model.id,
    trained: model.trained === true,
    probabilities: Object.freeze({
      bullish: round(probabilities[0], 10),
      neutral: round(probabilities[1], 10),
      bearish: round(probabilities[2], 10),
    }),
  });
}

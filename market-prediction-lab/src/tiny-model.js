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

function dot(weights, vector) {
  return weights.reduce((sum, weight, index) => sum + (weight * vector[index]), 0);
}

function softmax(logits) {
  const maxValue = Math.max(...logits);
  const exps = logits.map((value) => Math.exp(value - maxValue));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map((value) => value / total);
}

export function predictTinyModel(features, model = BASELINE_MODEL) {
  const vector = model.featureOrder.map((key) => {
    const value = features[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  });
  const classNames = ["bullish", "neutral", "bearish"];
  const logits = classNames.map((name) => {
    const classModel = model.classes[name];
    if (!classModel || classModel.weights.length !== vector.length) {
      throw new Error(`invalid tiny model class definition: ${name}`);
    }
    return classModel.bias + dot(classModel.weights, vector);
  });
  const probabilities = softmax(logits);
  return Object.freeze({
    modelId: model.id,
    trained: model.trained,
    probabilities: Object.freeze({
      bullish: round(probabilities[0], 10),
      neutral: round(probabilities[1], 10),
      bearish: round(probabilities[2], 10),
    }),
  });
}

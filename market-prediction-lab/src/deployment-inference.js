import { scoreToProbabilities } from "./rules.js";
import { predictTinyModel } from "./tiny-model.js";

export const DEPLOYED_RULE_WEIGHT = 0.65;
export const DEPLOYED_MODEL_WEIGHT = 0.35;
export const DEPLOYED_INFERENCE_CONTRACT = "deployed-rule-model-65-35";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeProbabilities(probabilities) {
  const values = [probabilities?.bullish, probabilities?.neutral, probabilities?.bearish]
    .map((value) => Math.max(0, finite(value) ? value : 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) throw new TypeError("probabilities must contain finite positive mass");
  return Object.freeze({
    bullish: values[0] / total,
    neutral: values[1] / total,
    bearish: values[2] / total,
  });
}

export function blendDeployedProbabilities(ruleScore, modelProbabilities) {
  if (!finite(ruleScore)) throw new TypeError("ruleScore is required for deployment-parity inference");
  const ruleProbabilities = scoreToProbabilities(ruleScore);
  const normalizedModel = normalizeProbabilities(modelProbabilities);
  const probabilities = normalizeProbabilities({
    bullish: (ruleProbabilities.bullish * DEPLOYED_RULE_WEIGHT)
      + (normalizedModel.bullish * DEPLOYED_MODEL_WEIGHT),
    neutral: (ruleProbabilities.neutral * DEPLOYED_RULE_WEIGHT)
      + (normalizedModel.neutral * DEPLOYED_MODEL_WEIGHT),
    bearish: (ruleProbabilities.bearish * DEPLOYED_RULE_WEIGHT)
      + (normalizedModel.bearish * DEPLOYED_MODEL_WEIGHT),
  });
  return Object.freeze({ ruleProbabilities, modelProbabilities: normalizedModel, probabilities });
}

export function predictDeployedTinyModel(record, model) {
  if (!record?.features || typeof record.features !== "object") {
    throw new TypeError("record.features are required for deployment-parity inference");
  }
  if (!finite(record.ruleScore)) {
    throw new TypeError("record.ruleScore is required for deployment-parity inference");
  }
  const modelResult = predictTinyModel(record.features, model);
  const blended = blendDeployedProbabilities(record.ruleScore, modelResult.probabilities);
  return Object.freeze({
    modelId: modelResult.modelId,
    trained: modelResult.trained,
    inferenceContract: DEPLOYED_INFERENCE_CONTRACT,
    ruleProbabilities: blended.ruleProbabilities,
    modelProbabilities: blended.modelProbabilities,
    probabilities: blended.probabilities,
  });
}

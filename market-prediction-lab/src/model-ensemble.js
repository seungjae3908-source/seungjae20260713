import { evaluateTinyModel } from "./tiny-model-training.js";

function assertRecords(records, label, minimum = 30) {
  if (!Array.isArray(records) || records.length < minimum) throw new TypeError(`${label} must contain at least ${minimum} records`);
}

function assertModel(model, label) {
  if (!model || typeof model !== "object" || typeof model.id !== "string" || model.trained !== true) {
    throw new TypeError(`${label} must be a trained model`);
  }
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function buildProbabilityEnsemble({
  id,
  referenceModel,
  alternateModel,
  alternateWeight,
  temperature = 1,
}) {
  assertModel(referenceModel, "referenceModel");
  assertModel(alternateModel, "alternateModel");
  if (typeof id !== "string" || id.length === 0) throw new TypeError("id is required");
  if (!(alternateWeight > 0 && alternateWeight <= 1)) throw new RangeError("alternateWeight must be in (0, 1]");
  if (!(temperature >= 0.2 && temperature <= 5)) throw new RangeError("temperature must be in [0.2, 5]");
  return Object.freeze({
    id,
    trained: true,
    modelType: "probability-ensemble",
    temperature: round(temperature, 4),
    components: Object.freeze([
      Object.freeze({ role: "reference", weight: round(1 - alternateWeight, 6), model: referenceModel }),
      Object.freeze({ role: "alternate", weight: round(alternateWeight, 6), model: alternateModel }),
    ]),
  });
}

export function selectProbabilityEnsemble(validationRecords, {
  id,
  referenceModel,
  alternateModel,
  weightStep = 0.05,
  minTemperature = 0.5,
  maxTemperature = 3,
  temperatureStep = 0.05,
} = {}) {
  assertRecords(validationRecords, "validationRecords");
  assertModel(referenceModel, "referenceModel");
  assertModel(alternateModel, "alternateModel");
  if (typeof id !== "string" || id.length === 0) throw new TypeError("id is required");
  if (!(weightStep > 0 && weightStep <= 0.5)) throw new RangeError("weightStep is invalid");
  if (!(minTemperature >= 0.2 && maxTemperature <= 5 && minTemperature <= maxTemperature)) throw new RangeError("temperature range is invalid");
  if (!(temperatureStep > 0 && temperatureStep <= 0.5)) throw new RangeError("temperatureStep is invalid");

  let best = null;
  for (let weight = weightStep; weight <= 1 + 1e-9; weight += weightStep) {
    const normalizedWeight = Math.min(1, Math.round(weight * 1e6) / 1e6);
    for (let temperature = minTemperature; temperature <= maxTemperature + 1e-9; temperature += temperatureStep) {
      const model = buildProbabilityEnsemble({
        id,
        referenceModel,
        alternateModel,
        alternateWeight: normalizedWeight,
        temperature,
      });
      const metrics = evaluateTinyModel(validationRecords, model);
      const complexityPenalty = normalizedWeight < 1 ? 1e-8 : 0;
      const objective = metrics.logLoss + complexityPenalty;
      if (!best || objective < best.objective - 1e-12
          || (Math.abs(objective - best.objective) <= 1e-12 && normalizedWeight < best.alternateWeight)) {
        best = {
          objective,
          model,
          metrics,
          alternateWeight: normalizedWeight,
          temperature: model.temperature,
        };
      }
    }
  }
  if (!best) throw new Error("ensemble selection produced no candidate");
  return Object.freeze({
    model: best.model,
    selection: Object.freeze({
      validationSamples: validationRecords.length,
      alternateWeight: best.alternateWeight,
      referenceWeight: 1 - best.alternateWeight,
      temperature: best.temperature,
      validationLogLoss: best.metrics.logLoss,
      validationMacroF1: best.metrics.macroF1,
      validationAccuracy: best.metrics.accuracy,
    }),
  });
}

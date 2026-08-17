import { BASELINE_MODEL, predictTinyModel } from "./tiny-model.js";

const CLASS_NAMES = Object.freeze(["bullish", "neutral", "bearish"]);
const VOLATILITY_REGIMES = Object.freeze(["low", "normal", "high"]);

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function actualDirection(record) {
  const direction = record?.actualDirection ?? record?.label?.direction;
  if (!CLASS_NAMES.includes(direction)) throw new TypeError("record actual direction is invalid");
  return direction;
}

function predictedClass(probabilities) {
  return CLASS_NAMES.reduce((best, name) => probabilities[name] > probabilities[best] ? name : best, CLASS_NAMES[0]);
}

export function evaluateModelRecords(records, model) {
  if (!Array.isArray(records) || records.length === 0) throw new TypeError("records are required");
  if (!model || typeof model !== "object" || typeof model.id !== "string") throw new TypeError("model is required");
  const confusion = Object.fromEntries(CLASS_NAMES.map((actual) => [actual,
    Object.fromEntries(CLASS_NAMES.map((predicted) => [predicted, 0]))]));
  const predictedCounts = Object.fromEntries(CLASS_NAMES.map((name) => [name, 0]));
  let hits = 0;
  let logLoss = 0;
  let brier = 0;

  for (const record of records) {
    if (!record?.features || typeof record.features !== "object") throw new TypeError("record features are required");
    const actual = actualDirection(record);
    const probabilities = predictTinyModel(record.features, model).probabilities;
    const predicted = predictedClass(probabilities);
    predictedCounts[predicted] += 1;
    confusion[actual][predicted] += 1;
    hits += predicted === actual ? 1 : 0;
    logLoss -= Math.log(Math.max(probabilities[actual], 1e-12));
    for (const name of CLASS_NAMES) brier += (probabilities[name] - (actual === name ? 1 : 0)) ** 2;
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

  return Object.freeze({
    sampleCount: records.length,
    accuracy: hits / records.length,
    macroF1: CLASS_NAMES.reduce((sum, name) => sum + perClass[name].f1, 0) / CLASS_NAMES.length,
    balancedAccuracy: CLASS_NAMES.reduce((sum, name) => sum + perClass[name].recall, 0) / CLASS_NAMES.length,
    logLoss: logLoss / records.length,
    brier: brier / records.length,
    perClass: Object.freeze(perClass),
    confusion: Object.freeze(confusion),
    predictedCounts: Object.freeze(predictedCounts),
    predictedShares: Object.freeze(Object.fromEntries(CLASS_NAMES.map((name) => [name, predictedCounts[name] / records.length]))),
  });
}

export function evaluatePredictionHealth(metrics, {
  maxDominantShare = 0.8,
  minDirectionalRecall = 0.05,
  minDirectionalSupport = 5,
} = {}) {
  if (!metrics || !Number.isInteger(metrics.sampleCount) || metrics.sampleCount <= 0) throw new TypeError("metrics are required");
  const shares = metrics.predictedShares ?? {};
  const dominantClass = CLASS_NAMES.reduce((best, name) => (shares[name] ?? 0) > (shares[best] ?? 0) ? name : best, CLASS_NAMES[0]);
  const dominantShare = shares[dominantClass] ?? 0;
  const bullish = metrics.perClass?.bullish ?? { support: 0, recall: 0 };
  const bearish = metrics.perClass?.bearish ?? { support: 0, recall: 0 };
  const directionalEligible = bullish.support >= minDirectionalSupport && bearish.support >= minDirectionalSupport;
  const directionalRecallAverage = (bullish.recall + bearish.recall) / 2;
  const reasons = [];
  if (dominantShare >= maxDominantShare) reasons.push(`dominant_prediction_share:${dominantClass}`);
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

function atrReference(model) {
  const index = Array.isArray(model?.featureOrder) ? model.featureOrder.indexOf("atrPct") : -1;
  const mean = index >= 0 ? model?.normalization?.mean?.[index] : null;
  const scale = index >= 0 ? model?.normalization?.scale?.[index] : null;
  if (!Number.isFinite(mean) || !Number.isFinite(scale) || scale <= 0) return null;
  return Object.freeze({ mean, scale, feature: "atrPct" });
}

function volatilityRegime(record, reference, sigmaBand) {
  const atrPct = record?.features?.atrPct;
  if (!Number.isFinite(atrPct)) return null;
  const z = (atrPct - reference.mean) / reference.scale;
  if (z <= -sigmaBand) return "low";
  if (z >= sigmaBand) return "high";
  return "normal";
}

export function evaluateVolatilityRegimeHealth(records, candidateModel, referenceModel, {
  sigmaBand = 1,
  minRegimeSamples = 12,
  minDirectionalSupport = 3,
} = {}) {
  if (!Array.isArray(records) || records.length === 0) throw new TypeError("records are required");
  if (!(sigmaBand > 0)) throw new RangeError("sigmaBand must be positive");
  if (!Number.isInteger(minRegimeSamples) || minRegimeSamples < 1) throw new RangeError("minRegimeSamples must be positive");
  const reference = atrReference(referenceModel);
  if (!reference) {
    return Object.freeze({
      available: false,
      healthy: true,
      reason: "atr_training_normalization_unavailable",
      reference: null,
      byRegime: Object.freeze({}),
      collapsedRegimes: Object.freeze([]),
    });
  }

  const buckets = Object.fromEntries(VOLATILITY_REGIMES.map((name) => [name, []]));
  let missingAtr = 0;
  for (const record of records) {
    const regime = volatilityRegime(record, reference, sigmaBand);
    if (!regime) {
      missingAtr += 1;
      continue;
    }
    buckets[regime].push(record);
  }

  const byRegime = {};
  const collapsedRegimes = [];
  for (const regime of VOLATILITY_REGIMES) {
    const rows = buckets[regime];
    if (rows.length < minRegimeSamples) {
      byRegime[regime] = Object.freeze({
        qualified: false,
        sampleCount: rows.length,
        required: minRegimeSamples,
        metrics: null,
        health: null,
      });
      continue;
    }
    const metrics = evaluateModelRecords(rows, candidateModel);
    const health = evaluatePredictionHealth(metrics, { minDirectionalSupport });
    if (health.collapsed) collapsedRegimes.push(regime);
    byRegime[regime] = Object.freeze({
      qualified: true,
      sampleCount: rows.length,
      required: minRegimeSamples,
      metrics: compactMetrics(metrics),
      health,
    });
  }

  return Object.freeze({
    available: true,
    healthy: collapsedRegimes.length === 0,
    reason: collapsedRegimes.length === 0 ? null : "volatility_regime_prediction_collapse",
    reference: Object.freeze({
      atrPctMean: reference.mean,
      atrPctScale: reference.scale,
      sigmaBand,
      lowUpper: reference.mean - (sigmaBand * reference.scale),
      highLower: reference.mean + (sigmaBand * reference.scale),
    }),
    missingAtr,
    byRegime: Object.freeze(byRegime),
    collapsedRegimes: Object.freeze(collapsedRegimes),
  });
}

function buildEnsemble({ id, referenceModel, baselineWeight, temperature }) {
  if (!(baselineWeight > 0 && baselineWeight <= 1)) throw new RangeError("baselineWeight must be in (0, 1]");
  return Object.freeze({
    id,
    trained: true,
    modelType: "probability-ensemble",
    temperature: round(temperature, 4),
    components: Object.freeze([
      Object.freeze({ role: "v1-reference", weight: round(1 - baselineWeight, 6), model: referenceModel }),
      Object.freeze({ role: "rule-baseline", weight: round(baselineWeight, 6), model: BASELINE_MODEL }),
    ]),
  });
}

function comparison(candidate, reference) {
  return Object.freeze({
    accuracyDelta: candidate.accuracy - reference.accuracy,
    macroF1Delta: candidate.macroF1 - reference.macroF1,
    balancedAccuracyDelta: candidate.balancedAccuracy - reference.balancedAccuracy,
    logLossImprovement: reference.logLoss - candidate.logLoss,
    brierImprovement: reference.brier - candidate.brier,
  });
}

function compactMetrics(metrics) {
  return Object.freeze({
    sampleCount: metrics.sampleCount,
    accuracy: metrics.accuracy,
    macroF1: metrics.macroF1,
    balancedAccuracy: metrics.balancedAccuracy,
    logLoss: metrics.logLoss,
    brier: metrics.brier,
    perClass: metrics.perClass,
    confusion: metrics.confusion,
    predictedCounts: metrics.predictedCounts,
    predictedShares: metrics.predictedShares,
  });
}

function perSymbol(records, candidateModel, referenceModel) {
  const symbols = [...new Set(records.map((record) => record.symbol).filter(Boolean))].sort();
  return Object.fromEntries(symbols.map((symbol) => {
    const rows = records.filter((record) => record.symbol === symbol);
    const candidate = evaluateModelRecords(rows, candidateModel);
    const reference = evaluateModelRecords(rows, referenceModel);
    return [symbol, Object.freeze({
      candidate: compactMetrics(candidate),
      reference: compactMetrics(reference),
      comparison: comparison(candidate, reference),
      health: evaluatePredictionHealth(candidate, { minDirectionalSupport: 3 }),
    })];
  }));
}

function researchHold({ group, reason, settled, required, referenceModelId, diagnostics = null }) {
  return Object.freeze({
    schemaVersion: 1,
    status: "research_hold",
    reason,
    group,
    generatedAt: Date.now(),
    settled,
    required,
    referenceModelId,
    diagnostics,
    safety: Object.freeze({
      usesPublicMarketDataOnly: true,
      usesAccountOrOrderApi: false,
      modifiesExistingAppApi: false,
      deploysModel: false,
    }),
  });
}

export function buildAdaptiveShadowCandidate({
  group,
  state,
  referenceArtifact,
  minSettled = 120,
  holdoutRatio = 0.25,
  minHoldout = 24,
  minCalibration = 60,
  volatilitySigmaBand = 1,
  minVolatilityRegimeSamples = 12,
} = {}) {
  if (typeof group !== "string" || group.length === 0) throw new TypeError("group is required");
  const referenceModel = referenceArtifact?.model;
  if (!referenceModel?.trained || typeof referenceModel.id !== "string") throw new TypeError("trained reference artifact is required");
  if (!(holdoutRatio > 0 && holdoutRatio < 0.5)) throw new RangeError("holdoutRatio must be in (0, 0.5)");

  const settled = (state?.records ?? [])
    .filter((record) => record?.status === "settled"
      && record.modelId === referenceModel.id
      && record.referenceModelId === BASELINE_MODEL.id)
    .sort((left, right) => left.anchorTimestamp - right.anchorTimestamp || String(left.symbol).localeCompare(String(right.symbol)));

  if (settled.length < minSettled) {
    return researchHold({
      group,
      reason: "insufficient_live_shadow_samples",
      settled: settled.length,
      required: minSettled,
      referenceModelId: referenceModel.id,
    });
  }

  const requestedHoldout = Math.max(minHoldout, Math.ceil(settled.length * holdoutRatio));
  const holdoutCount = Math.min(requestedHoldout, settled.length - minCalibration);
  if (holdoutCount < minHoldout || settled.length - holdoutCount < minCalibration) {
    return researchHold({
      group,
      reason: "insufficient_chronological_split",
      settled: settled.length,
      required: minCalibration + minHoldout,
      referenceModelId: referenceModel.id,
    });
  }

  const calibration = settled.slice(0, settled.length - holdoutCount);
  const holdout = settled.slice(settled.length - holdoutCount);
  const candidateId = `adaptive-${group}-v2-live-blend`;
  let best = null;

  for (let baselineWeight = 0.1; baselineWeight <= 1 + 1e-9; baselineWeight += 0.1) {
    const normalizedWeight = Math.min(1, Math.round(baselineWeight * 10) / 10);
    for (let temperature = 0.6; temperature <= 1.6 + 1e-9; temperature += 0.1) {
      const model = buildEnsemble({ id: candidateId, referenceModel, baselineWeight: normalizedWeight, temperature });
      const metrics = evaluateModelRecords(calibration, model);
      const health = evaluatePredictionHealth(metrics);
      if (health.collapsed) continue;
      const volatilityHealth = evaluateVolatilityRegimeHealth(calibration, model, referenceModel, {
        sigmaBand: volatilitySigmaBand,
        minRegimeSamples: minVolatilityRegimeSamples,
      });
      if (volatilityHealth.available && !volatilityHealth.healthy) continue;
      const objective = metrics.logLoss - (0.2 * metrics.macroF1) - (0.1 * metrics.balancedAccuracy);
      if (!best || objective < best.objective - 1e-12
          || (Math.abs(objective - best.objective) <= 1e-12 && normalizedWeight < best.baselineWeight)) {
        best = { objective, model, metrics, health, volatilityHealth, baselineWeight: normalizedWeight, temperature: model.temperature };
      }
    }
  }

  if (!best) {
    return researchHold({
      group,
      reason: "no_non_collapsed_blend_found",
      settled: settled.length,
      required: minSettled,
      referenceModelId: referenceModel.id,
    });
  }

  const candidateMetrics = evaluateModelRecords(holdout, best.model);
  const referenceMetrics = evaluateModelRecords(holdout, referenceModel);
  const baselineMetrics = evaluateModelRecords(holdout, BASELINE_MODEL);
  const candidateHealth = evaluatePredictionHealth(candidateMetrics);
  const referenceHealth = evaluatePredictionHealth(referenceMetrics);
  const holdoutVolatilityHealth = evaluateVolatilityRegimeHealth(holdout, best.model, referenceModel, {
    sigmaBand: volatilitySigmaBand,
    minRegimeSamples: minVolatilityRegimeSamples,
  });
  const delta = comparison(candidateMetrics, referenceMetrics);
  const reasons = [];

  if (candidateHealth.collapsed) reasons.push(...candidateHealth.reasons.map((reason) => `holdout:${reason}`));
  if (holdoutVolatilityHealth.available && !holdoutVolatilityHealth.healthy) {
    for (const regime of holdoutVolatilityHealth.collapsedRegimes) {
      const health = holdoutVolatilityHealth.byRegime[regime]?.health;
      for (const reason of health?.reasons ?? []) reasons.push(`holdout_volatility_${regime}:${reason}`);
    }
  }
  if (delta.logLossImprovement < -0.01) reasons.push("holdout_log_loss_regressed");
  if (delta.macroF1Delta < 0.02) reasons.push("holdout_macro_f1_gain_insufficient");
  if (delta.accuracyDelta < -0.02) reasons.push("holdout_accuracy_regressed");
  if (candidateHealth.directionalRecallAverage < Math.max(0.1, referenceHealth.directionalRecallAverage + 0.03)) {
    reasons.push("holdout_directional_recall_gain_insufficient");
  }

  const symbolMetrics = perSymbol(holdout, best.model, referenceModel);
  for (const [symbol, metrics] of Object.entries(symbolMetrics)) {
    if (metrics.candidate.sampleCount < 8) {
      reasons.push(`${symbol}:insufficient_holdout_samples`);
      continue;
    }
    if (metrics.comparison.macroF1Delta < -0.03) reasons.push(`${symbol}:macro_f1_regressed`);
    if (metrics.comparison.logLossImprovement < -0.03) reasons.push(`${symbol}:log_loss_regressed`);
    if (metrics.health.collapsed) reasons.push(...metrics.health.reasons.map((reason) => `${symbol}:${reason}`));
  }

  const diagnostics = Object.freeze({
    split: Object.freeze({ total: settled.length, calibration: calibration.length, holdout: holdout.length }),
    selection: Object.freeze({
      baselineWeight: best.baselineWeight,
      referenceWeight: 1 - best.baselineWeight,
      temperature: best.temperature,
      objective: best.objective,
      calibrationMetrics: compactMetrics(best.metrics),
      calibrationHealth: best.health,
      volatilityRegimes: best.volatilityHealth,
    }),
    holdout: Object.freeze({
      candidate: compactMetrics(candidateMetrics),
      reference: compactMetrics(referenceMetrics),
      baseline: compactMetrics(baselineMetrics),
      comparison: delta,
      candidateHealth,
      referenceHealth,
      volatilityRegimes: holdoutVolatilityHealth,
      bySymbol: symbolMetrics,
    }),
  });

  return Object.freeze({
    schemaVersion: 1,
    status: reasons.length === 0 ? "shadow_candidate_v2" : "research_hold",
    reason: reasons.length === 0 ? null : "adaptive_candidate_gates_failed",
    reasons: Object.freeze(reasons),
    group,
    generatedAt: Date.now(),
    source: "chronological-live-shadow-v1-baseline-blend",
    model: best.model,
    referenceModelId: referenceModel.id,
    diagnostics,
    safety: Object.freeze({
      chronologicalSplit: true,
      volatilityRegimeSelectionUsesTrainingNormalizationOnly: true,
      overwritesExistingShadowHistory: false,
      usesPublicMarketDataOnly: true,
      usesAccountOrOrderApi: false,
      modifiesExistingAppApi: false,
      deploysModel: false,
    }),
  });
}

export const ADAPTIVE_SHADOW_CLASSES = CLASS_NAMES;
export const ADAPTIVE_SHADOW_VOLATILITY_REGIMES = VOLATILITY_REGIMES;

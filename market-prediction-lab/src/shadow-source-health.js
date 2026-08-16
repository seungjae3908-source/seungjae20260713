const CLASS_NAMES = Object.freeze(["bullish", "neutral", "bearish"]);

function classCounts() {
  return Object.fromEntries(CLASS_NAMES.map((name) => [name, 0]));
}

function shares(counts, total) {
  if (total <= 0) return Object.freeze(Object.fromEntries(CLASS_NAMES.map((name) => [name, 0])));
  return Object.freeze(Object.fromEntries(CLASS_NAMES.map((name) => [name, counts[name] / total])));
}

function validateClass(value, label) {
  if (!CLASS_NAMES.includes(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function featureMeanShifts(records, model) {
  const order = Array.isArray(model?.featureOrder) ? model.featureOrder : [];
  const mean = model?.normalization?.mean;
  const scale = model?.normalization?.scale;
  if (!Array.isArray(mean) || !Array.isArray(scale) || mean.length !== order.length || scale.length !== order.length) {
    return Object.freeze({ available: false, reason: "MODEL_NORMALIZATION_UNAVAILABLE", features: Object.freeze([]), topMeanShifts: Object.freeze([]) });
  }

  const features = order.map((key, index) => {
    const values = records.map((record) => record?.features?.[key]).filter((value) => typeof value === "number" && Number.isFinite(value));
    const liveMean = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const trainingMean = Number.isFinite(mean[index]) ? mean[index] : 0;
    const trainingScale = Math.max(Math.abs(Number.isFinite(scale[index]) ? scale[index] : 1), 1e-9);
    const meanZ = liveMean === null ? null : (liveMean - trainingMean) / trainingScale;
    return Object.freeze({
      feature: key,
      observed: values.length,
      missing: records.length - values.length,
      liveMean,
      trainingMean,
      trainingScale,
      meanZ,
      absMeanZ: meanZ === null ? null : Math.abs(meanZ),
    });
  });

  const topMeanShifts = [...features]
    .filter((row) => row.absMeanZ !== null)
    .sort((left, right) => right.absMeanZ - left.absMeanZ || left.feature.localeCompare(right.feature))
    .slice(0, 8);
  return Object.freeze({ available: true, features: Object.freeze(features), topMeanShifts: Object.freeze(topMeanShifts) });
}

export function summarizeShadowSourceHealth({
  state,
  model,
  minCollapseSamples = 20,
  maxDominantShare = 0.8,
  minDirectionalSupport = 5,
  minDirectionalRecall = 0.05,
} = {}) {
  if (!model || typeof model.id !== "string" || model.id.length === 0) throw new TypeError("model is required");
  if (!Number.isInteger(minCollapseSamples) || minCollapseSamples < 1) throw new TypeError("minCollapseSamples is invalid");
  if (!(maxDominantShare > 0.5 && maxDominantShare <= 1)) throw new TypeError("maxDominantShare is invalid");

  const records = (state?.records ?? [])
    .filter((record) => record?.status === "settled" && record.modelId === model.id)
    .sort((left, right) => left.anchorTimestamp - right.anchorTimestamp || String(left.symbol).localeCompare(String(right.symbol)));
  const predictedCounts = classCounts();
  const actualCounts = classCounts();
  const confusion = Object.fromEntries(CLASS_NAMES.map((actual) => [actual, classCounts()]));

  for (const record of records) {
    const actual = validateClass(record.actualDirection, "actualDirection");
    const predicted = validateClass(record.candidateClass, "candidateClass");
    actualCounts[actual] += 1;
    predictedCounts[predicted] += 1;
    confusion[actual][predicted] += 1;
  }

  const predictedShares = shares(predictedCounts, records.length);
  const actualShares = shares(actualCounts, records.length);
  const dominantClass = CLASS_NAMES.reduce(
    (best, name) => predictedShares[name] > predictedShares[best] ? name : best,
    CLASS_NAMES[0],
  );
  const dominantShare = predictedShares[dominantClass];
  const directionalRecall = {};
  for (const name of ["bullish", "bearish"]) {
    const support = actualCounts[name];
    directionalRecall[name] = Object.freeze({
      support,
      recall: confusion[name][name] / Math.max(support, 1),
    });
  }

  const reasons = [];
  const collapseGateEligible = records.length >= minCollapseSamples;
  if (collapseGateEligible && dominantShare >= maxDominantShare) {
    reasons.push(`dominant_prediction_share:${dominantClass}`);
  }
  if (collapseGateEligible
      && directionalRecall.bullish.support >= minDirectionalSupport
      && directionalRecall.bearish.support >= minDirectionalSupport
      && directionalRecall.bullish.recall < minDirectionalRecall
      && directionalRecall.bearish.recall < minDirectionalRecall) {
    reasons.push("directional_recall_collapse");
  }

  const collapsed = reasons.length > 0;
  return Object.freeze({
    schemaVersion: 1,
    modelId: model.id,
    sampleCount: records.length,
    status: collapsed ? "MODEL_DEGENERATE" : collapseGateEligible ? "HEALTHY_OR_UNPROVEN" : "INSUFFICIENT_SAMPLE",
    collapseGateEligible,
    minCollapseSamples,
    maxDominantShare,
    dominantClass,
    dominantShare,
    collapsed,
    reasons: Object.freeze(reasons),
    actualCounts: Object.freeze(actualCounts),
    actualShares,
    predictedCounts: Object.freeze(predictedCounts),
    predictedShares,
    directionalRecall: Object.freeze(directionalRecall),
    featureMeanShift: featureMeanShifts(records, model),
  });
}

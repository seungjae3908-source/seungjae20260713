const CLASSES = Object.freeze(["bullish", "neutral", "bearish"]);

const finite = (value) => typeof value === "number" && Number.isFinite(value);

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function summarize(values, totalCount = values.length) {
  const numeric = values.filter(finite);
  const sorted = [...numeric].sort((a, b) => a - b);
  const missingCount = Math.max(totalCount - numeric.length, 0);
  if (numeric.length === 0) {
    return Object.freeze({ count: 0, missingCount, missingRatio: totalCount ? missingCount / totalCount : null, zeroCount: 0, zeroRatio: null, mean: null, std: null, min: null, max: null, p05: null, p50: null, p95: null });
  }
  const mean = numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
  const variance = numeric.reduce((sum, value) => sum + (value - mean) ** 2, 0) / numeric.length;
  const zeroCount = numeric.filter((value) => value === 0).length;
  return Object.freeze({
    count: numeric.length,
    missingCount,
    missingRatio: totalCount ? missingCount / totalCount : null,
    zeroCount,
    zeroRatio: zeroCount / numeric.length,
    mean,
    std: Math.sqrt(variance),
    min: sorted[0],
    max: sorted.at(-1),
    p05: quantile(sorted, 0.05),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
  });
}

function empiricalCdf(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sorted[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return low / sorted.length;
}

export function kolmogorovSmirnovDistance(referenceValues, currentValues) {
  const reference = referenceValues.filter(finite).sort((a, b) => a - b);
  const current = currentValues.filter(finite).sort((a, b) => a - b);
  if (!reference.length || !current.length) return null;
  const points = [...new Set([...reference, ...current])].sort((a, b) => a - b);
  return points.reduce((maximum, value) => Math.max(maximum, Math.abs(empiricalCdf(reference, value) - empiricalCdf(current, value))), 0);
}

export function populationStabilityIndex(referenceValues, currentValues, { bins = 10, epsilon = 1e-6 } = {}) {
  const reference = referenceValues.filter(finite).sort((a, b) => a - b);
  const current = currentValues.filter(finite);
  if (!reference.length || !current.length) return null;
  if (!Number.isInteger(bins) || bins < 2 || bins > 50) throw new TypeError("bins must be an integer between 2 and 50");
  const boundaries = Array.from({ length: bins - 1 }, (_, index) => quantile(reference, (index + 1) / bins));
  const bucket = (value) => {
    let index = 0;
    while (index < boundaries.length && value > boundaries[index]) index += 1;
    return index;
  };
  const referenceCounts = Array(bins).fill(0);
  const currentCounts = Array(bins).fill(0);
  reference.forEach((value) => { referenceCounts[bucket(value)] += 1; });
  current.forEach((value) => { currentCounts[bucket(value)] += 1; });
  return referenceCounts.reduce((psi, count, index) => {
    const referenceRatio = Math.max(count / reference.length, epsilon);
    const currentRatio = Math.max(currentCounts[index] / current.length, epsilon);
    return psi + (currentRatio - referenceRatio) * Math.log(currentRatio / referenceRatio);
  }, 0);
}

function validateModel(model, canonicalFeatureOrder) {
  if (!model || !Array.isArray(model.featureOrder) || !model.featureOrder.length) throw new TypeError("model featureOrder is required");
  if (canonicalFeatureOrder && (canonicalFeatureOrder.length !== model.featureOrder.length || canonicalFeatureOrder.some((name, index) => name !== model.featureOrder[index]))) {
    throw new Error("feature order mismatch");
  }
  const mean = model.normalization?.mean;
  const scale = model.normalization?.scale;
  if (!Array.isArray(mean) || !Array.isArray(scale) || mean.length !== model.featureOrder.length || scale.length !== model.featureOrder.length) throw new Error("scaler mismatch");
  scale.forEach((value, index) => {
    if (!finite(mean[index]) || !finite(value) || Math.abs(value) === 0) throw new Error(`invalid scaler at feature ${model.featureOrder[index]}`);
  });
}

function assertTemporalIntegrity(record) {
  if (!Number.isInteger(record.anchorTimestamp) || record.anchorTimestamp <= 0) throw new TypeError("record anchorTimestamp is invalid");
  for (const [key, value] of Object.entries(record.featureAvailability ?? {})) {
    if (/(timestamp|time|at)$/i.test(key) && finite(value) && value > record.anchorTimestamp) throw new Error(`future feature timestamp: ${key}`);
  }
}

function topClass(probabilities) {
  return CLASSES.reduce((best, name) => probabilities[name] > probabilities[best] ? name : best, CLASSES[0]);
}

function probabilityRow(record) {
  const probabilities = record.candidateProbabilities;
  if (!probabilities || CLASSES.some((name) => !finite(probabilities[name]))) throw new TypeError("candidate probabilities are invalid");
  const ranked = CLASSES.map((name) => probabilities[name]).sort((a, b) => b - a);
  return Object.freeze({
    predicted: record.candidateClass ?? topClass(probabilities),
    actual: record.status === "settled" && CLASSES.includes(record.actualDirection) ? record.actualDirection : null,
    bullish: probabilities.bullish,
    neutral: probabilities.neutral,
    bearish: probabilities.bearish,
    margin: ranked[0] - ranked[1],
  });
}

function classCounts(rows, field) {
  const counts = Object.fromEntries(CLASSES.map((name) => [name, 0]));
  let unknown = 0;
  rows.forEach((row) => {
    if (CLASSES.includes(row[field])) counts[row[field]] += 1;
    else unknown += 1;
  });
  return Object.freeze({ ...counts, unknown });
}

function summarizeProbabilities(records) {
  const rows = records.map(probabilityRow);
  const settled = rows.filter((row) => row.actual !== null);
  return Object.freeze({
    count: rows.length,
    settledCount: settled.length,
    bullish: summarize(rows.map((row) => row.bullish)),
    neutral: summarize(rows.map((row) => row.neutral)),
    bearish: summarize(rows.map((row) => row.bearish)),
    confidenceMargin: summarize(rows.map((row) => row.margin)),
    predictedClassDistribution: classCounts(rows, "predicted"),
    actualLabelDistribution: classCounts(settled, "actual"),
  });
}

function featureStats(records, model, featureName, index, referenceRecords) {
  const values = records.map((record) => finite(record.features?.[featureName]) ? record.features[featureName] : null);
  const raw = summarize(values, records.length);
  const baselineMean = model.normalization.mean[index];
  const baselineScale = Math.abs(model.normalization.scale[index]);
  const normalized = values.filter(finite).map((value) => (value - baselineMean) / baselineScale);
  const referenceValues = Array.isArray(referenceRecords) ? referenceRecords.map((record) => record.features?.[featureName]).filter(finite) : [];
  const currentValues = values.filter(finite);
  const clippingCount = normalized.filter((value) => Math.abs(value) >= 12).length;
  return Object.freeze({
    feature: featureName,
    raw,
    modelNormalization: Object.freeze({ mean: baselineMean, scale: baselineScale }),
    standardizedMeanShift: raw.mean === null ? null : (raw.mean - baselineMean) / baselineScale,
    stdRatioToTrainingScale: raw.std === null ? null : raw.std / baselineScale,
    clippingCount,
    clippingRatio: normalized.length ? clippingCount / normalized.length : null,
    referenceDistributionAvailable: referenceValues.length > 0,
    psi: referenceValues.length ? populationStabilityIndex(referenceValues, currentValues) : null,
    ksDistance: referenceValues.length ? kolmogorovSmirnovDistance(referenceValues, currentValues) : null,
  });
}

function temporalBuckets(records) {
  const sorted = [...records].sort((a, b) => a.anchorTimestamp - b.anchorTimestamp || String(a.id).localeCompare(String(b.id)));
  if (sorted.length < 4) return Object.freeze({ all: sorted });
  const quarter = Math.max(Math.floor(sorted.length / 4), 1);
  return Object.freeze({ oldest25: sorted.slice(0, quarter), middle50: sorted.slice(quarter, sorted.length - quarter), newest25: sorted.slice(sorted.length - quarter) });
}

export function buildShadowFeatureDriftDiagnostic({ records, modelArtifact, canonicalFeatureOrder, referenceRecords = null, researchCodeSha, shadowResearchCodeSha, modelGroup, generatedAt = Date.now() }) {
  if (!Array.isArray(records) || !records.length) throw new Error("empty shadow sample");
  const model = modelArtifact?.model ?? modelArtifact;
  validateModel(model, canonicalFeatureOrder);
  if (!/^[0-9a-f]{40}$/.test(researchCodeSha ?? "")) throw new TypeError("researchCodeSha must be an immutable SHA");
  if (!/^[0-9a-f]{40}$/.test(shadowResearchCodeSha ?? "")) throw new TypeError("shadowResearchCodeSha must be an immutable SHA");
  if (!modelGroup) throw new TypeError("modelGroup is required");
  const modelRecords = records.filter((record) => record.modelId === model.id);
  if (!modelRecords.length) throw new Error(`no records for active model ${model.id}`);
  const timeframes = [...new Set(modelRecords.map((record) => record.timeframe))];
  if (timeframes.length !== 1) throw new Error("mixed timeframe aggregation is forbidden");
  modelRecords.forEach(assertTemporalIntegrity);
  const features = Object.freeze(Object.fromEntries(model.featureOrder.map((featureName, index) => [featureName, featureStats(modelRecords, model, featureName, index, referenceRecords)])));
  const symbols = [...new Set(modelRecords.map((record) => record.symbol))].sort();
  const bySymbol = Object.freeze(Object.fromEntries(symbols.map((symbol) => {
    const subset = modelRecords.filter((record) => record.symbol === symbol);
    return [symbol, Object.freeze({ count: subset.length, probabilities: summarizeProbabilities(subset) })];
  })));
  const temporal = Object.freeze(Object.fromEntries(Object.entries(temporalBuckets(modelRecords)).map(([name, subset]) => [name, Object.freeze({ count: subset.length, firstAnchorTimestamp: subset[0]?.anchorTimestamp ?? null, lastAnchorTimestamp: subset.at(-1)?.anchorTimestamp ?? null, probabilities: summarizeProbabilities(subset) })])));
  const hasReference = Array.isArray(referenceRecords) && referenceRecords.length > 0;
  return Object.freeze({
    schemaVersion: 2,
    kind: "shadow-feature-drift-diagnostic",
    generatedAt,
    researchCodeSha,
    shadowResearchCodeSha,
    modelGroup,
    modelId: model.id,
    referenceModelId: modelRecords[0]?.referenceModelId ?? null,
    diagnostics: Object.freeze({
      count: modelRecords.length,
      timeframe: timeframes[0],
      firstAnchorTimestamp: Math.min(...modelRecords.map((record) => record.anchorTimestamp)),
      lastAnchorTimestamp: Math.max(...modelRecords.map((record) => record.anchorTimestamp)),
      featureOrder: Object.freeze([...model.featureOrder]),
      features,
      probabilities: summarizeProbabilities(modelRecords),
      bySymbol,
      temporal,
    }),
    trueDistributionDriftAvailable: hasReference,
    limitations: Object.freeze(hasReference ? [] : ["raw_train_validation_feature_samples_not_persisted", "psi_and_ks_require_reference_feature_samples", "model_normalization_mean_scale_are_training_baseline_proxies_not_empirical_distributions"]),
    rootCauseVerdict: hasReference ? "DRIFT_MEASURED_CAUSALITY_UNPROVEN" : "INSUFFICIENT_EVIDENCE",
    safety: Object.freeze({ diagnosticsOnly: true, syntheticDataAllowed: false, modelModified: false, thresholdModified: false, labelModified: false, liveOrderAllowed: false, privateAccountRequestAllowed: false, orderSubmitted: false }),
  });
}

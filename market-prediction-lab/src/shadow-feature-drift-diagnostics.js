const CLASS_NAMES = Object.freeze(["bullish", "neutral", "bearish"]);

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function summarizeNumeric(values, totalCount = values.length) {
  const numeric = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  const sorted = [...numeric].sort((left, right) => left - right);
  const count = numeric.length;
  const missingCount = Math.max(totalCount - count, 0);
  if (count === 0) {
    return Object.freeze({
      count: 0,
      missingCount,
      missingRatio: totalCount > 0 ? missingCount / totalCount : null,
      zeroCount: 0,
      zeroRatio: null,
      mean: null,
      std: null,
      min: null,
      max: null,
      median: null,
      p01: null,
      p05: null,
      p25: null,
      p50: null,
      p75: null,
      p95: null,
      p99: null,
    });
  }
  const mean = numeric.reduce((sum, value) => sum + value, 0) / count;
  const variance = numeric.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / count;
  const zeroCount = numeric.filter((value) => value === 0).length;
  return Object.freeze({
    count,
    missingCount,
    missingRatio: totalCount > 0 ? missingCount / totalCount : null,
    zeroCount,
    zeroRatio: zeroCount / count,
    mean,
    std: Math.sqrt(variance),
    min: sorted[0],
    max: sorted.at(-1),
    median: quantile(sorted, 0.5),
    p01: quantile(sorted, 0.01),
    p05: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
  });
}

function assertModelContract(model, canonicalFeatureOrder) {
  if (!model || typeof model !== "object") throw new TypeError("model is required");
  if (!Array.isArray(model.featureOrder) || model.featureOrder.length === 0) {
    throw new TypeError("model featureOrder is required");
  }
  if (canonicalFeatureOrder) {
    if (!Array.isArray(canonicalFeatureOrder) || canonicalFeatureOrder.length !== model.featureOrder.length
      || canonicalFeatureOrder.some((name, index) => name !== model.featureOrder[index])) {
      throw new Error("feature order mismatch");
    }
  }
  const mean = model.normalization?.mean;
  const scale = model.normalization?.scale;
  if (!Array.isArray(mean) || !Array.isArray(scale)
      || mean.length !== model.featureOrder.length || scale.length !== model.featureOrder.length) {
    throw new Error("scaler mismatch");
  }
  for (let index = 0; index < scale.length; index += 1) {
    if (!Number.isFinite(mean[index]) || !Number.isFinite(scale[index]) || !(Math.abs(scale[index]) > 0)) {
      throw new Error(`invalid scaler at feature ${model.featureOrder[index]}`);
    }
  }
}

function assertTemporalIntegrity(record) {
  const anchor = record.anchorTimestamp;
  if (!Number.isInteger(anchor) || anchor <= 0) throw new TypeError("record anchorTimestamp is invalid");
  const availability = record.featureAvailability;
  if (!availability || typeof availability !== "object") return;
  for (const [key, raw] of Object.entries(availability)) {
    if (!/(timestamp|time|at)$/i.test(key)) continue;
    const value = finiteOrNull(raw);
    if (value !== null && value > anchor) throw new Error(`future feature timestamp: ${key}`);
  }
}

function predictedClass(probabilities) {
  return CLASS_NAMES.reduce((best, name) => probabilities[name] > probabilities[best] ? name : best, CLASS_NAMES[0]);
}

function entropy(probabilities) {
  return CLASS_NAMES.reduce((sum, name) => {
    const value = Math.max(Number(probabilities?.[name]) || 0, 1e-12);
    return sum - value * Math.log(value);
  }, 0);
}

function probabilityRow(record) {
  const probabilities = record.candidateProbabilities;
  if (!probabilities || CLASS_NAMES.some((name) => !Number.isFinite(probabilities[name]))) {
    throw new TypeError("candidate probabilities are invalid");
  }
  const ranked = CLASS_NAMES.map((name) => ({ name, value: probabilities[name] }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
  return Object.freeze({
    predicted: record.candidateClass ?? predictedClass(probabilities),
    bullish: probabilities.bullish,
    neutral: probabilities.neutral,
    bearish: probabilities.bearish,
    top1: ranked[0].value,
    top2: ranked[1].value,
    margin: ranked[0].value - ranked[1].value,
    entropy: entropy(probabilities),
    actual: record.status === "settled" ? record.actualDirection ?? null : null,
  });
}

function countClasses(rows, field) {
  const counts = Object.fromEntries(CLASS_NAMES.map((name) => [name, 0]));
  let unknown = 0;
  for (const row of rows) {
    if (CLASS_NAMES.includes(row[field])) counts[row[field]] += 1;
    else unknown += 1;
  }
  return Object.freeze({ ...counts, unknown });
}

function summarizeProbabilities(records) {
  const rows = records.map(probabilityRow);
  const total = rows.length;
  const settled = rows.filter((row) => CLASS_NAMES.includes(row.actual));
  const classConditional = {};
  for (const actual of CLASS_NAMES) {
    const subset = settled.filter((row) => row.actual === actual);
    classConditional[actual] = Object.freeze({
      count: subset.length,
      bullish: summarizeNumeric(subset.map((row) => row.bullish)),
      neutral: summarizeNumeric(subset.map((row) => row.neutral)),
      bearish: summarizeNumeric(subset.map((row) => row.bearish)),
      margin: summarizeNumeric(subset.map((row) => row.margin)),
      entropy: summarizeNumeric(subset.map((row) => row.entropy)),
      predictedClassDistribution: countClasses(subset, "predicted"),
    });
  }
  return Object.freeze({
    count: total,
    settledCount: settled.length,
    bullish: summarizeNumeric(rows.map((row) => row.bullish)),
    neutral: summarizeNumeric(rows.map((row) => row.neutral)),
    bearish: summarizeNumeric(rows.map((row) => row.bearish)),
    top1: summarizeNumeric(rows.map((row) => row.top1)),
    top2: summarizeNumeric(rows.map((row) => row.top2)),
    confidenceMargin: summarizeNumeric(rows.map((row) => row.margin)),
    entropy: summarizeNumeric(rows.map((row) => row.entropy)),
    predictedClassDistribution: countClasses(rows, "predicted"),
    actualLabelDistribution: countClasses(settled, "actual"),
    classConditional: Object.freeze(classConditional),
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
  const reference = referenceValues.filter(Number.isFinite).sort((a, b) => a - b);
  const current = currentValues.filter(Number.isFinite).sort((a, b) => a - b);
  if (reference.length === 0 || current.length === 0) return null;
  const points = [...new Set([...reference, ...current])].sort((a, b) => a - b);
  return points.reduce((maximum, value) => Math.max(
    maximum,
    Math.abs(empiricalCdf(reference, value) - empiricalCdf(current, value)),
  ), 0);
}

export function populationStabilityIndex(referenceValues, currentValues, { bins = 10, epsilon = 1e-6 } = {}) {
  const reference = referenceValues.filter(Number.isFinite).sort((a, b) => a - b);
  const current = currentValues.filter(Number.isFinite);
  if (reference.length === 0 || current.length === 0) return null;
  if (!Number.isInteger(bins) || bins < 2 || bins > 50) throw new TypeError("bins must be an integer between 2 and 50");
  const boundaries = [];
  for (let index = 1; index < bins; index += 1) boundaries.push(quantile(reference, index / bins));
  const bucket = (value) => {
    let index = 0;
    while (index < boundaries.length && value > boundaries[index]) index += 1;
    return index;
  };
  const referenceCounts = Array(bins).fill(0);
  const currentCounts = Array(bins).fill(0);
  for (const value of reference) referenceCounts[bucket(value)] += 1;
  for (const value of current) currentCounts[bucket(value)] += 1;
  let psi = 0;
  for (let index = 0; index < bins; index += 1) {
    const refRatio = Math.max(referenceCounts[index] / reference.length, epsilon);
    const curRatio = Math.max(currentCounts[index] / current.length, epsilon);
    psi += (curRatio - refRatio) * Math.log(curRatio / refRatio);
  }
  return psi;
}

function normalizedFeatureStats(records, model, featureName, index, referenceRecords) {
  const values = records.map((record) => finiteOrNull(record.features?.[featureName]));
  const summary = summarizeNumeric(values, records.length);
  const baselineMean = model.normalization.mean[index];
  const baselineScale = Math.abs(model.normalization.scale[index]);
  const normalized = values
    .filter((value) => value !== null)
    .map((value) => (value - baselineMean) / baselineScale);
  const clippingCount = normalized.filter((value) => Math.abs(value) >= 12).length;
  const normalizedSummary = summarizeNumeric(normalized);
  const referenceValues = Array.isArray(referenceRecords)
    ? referenceRecords.map((record) => finiteOrNull(record.features?.[featureName])).filter((value) => value !== null)
    : [];
  const currentValues = values.filter((value) => value !== null);
  return Object.freeze({
    feature: featureName,
    raw: summary,
    modelNormalization: Object.freeze({ mean: baselineMean, scale: baselineScale }),
    normalized: normalizedSummary,
    clippingCount,
    clippingRatio: normalized.length > 0 ? clippingCount / normalized.length : null,
    standardizedMeanShift: summary.mean === null ? null : (summary.mean - baselineMean) / baselineScale,
    stdRatioToTrainingScale: summary.std === null ? null : summary.std / baselineScale,
    referenceDistributionAvailable: referenceValues.length > 0,
    psi: referenceValues.length > 0 ? populationStabilityIndex(referenceValues, currentValues) : null,
    ksDistance: referenceValues.length > 0 ? kolmogorovSmirnovDistance(referenceValues, currentValues) : null,
  });
}

function timeBuckets(records) {
  const sorted = [...records].sort((left, right) => left.anchorTimestamp - right.anchorTimestamp || String(left.id).localeCompare(String(right.id)));
  if (sorted.length < 4) return Object.freeze({ all: sorted });
  const quarter = Math.max(Math.floor(sorted.length / 4), 1);
  return Object.freeze({
    oldest25: sorted.slice(0, quarter),
    middle50: sorted.slice(quarter, sorted.length - quarter),
    newest25: sorted.slice(sorted.length - quarter),
  });
}

function buildSlice(records, model, canonicalFeatureOrder, referenceRecords) {
  if (records.length === 0) throw new Error("empty shadow sample");
  const timeframes = [...new Set(records.map((record) => record.timeframe))];
  if (timeframes.length !== 1) throw new Error("mixed timeframe aggregation is forbidden");
  for (const record of records) assertTemporalIntegrity(record);
  const featureStats = Object.fromEntries(model.featureOrder.map((featureName, index) => [
    featureName,
    normalizedFeatureStats(records, model, featureName, index, referenceRecords),
  ]));
  const symbols = [...new Set(records.map((record) => record.symbol))].sort();
  const bySymbol = Object.fromEntries(symbols.map((symbol) => {
    const subset = records.filter((record) => record.symbol === symbol);
    return [symbol, Object.freeze({ count: subset.length, probabilities: summarizeProbabilities(subset) })];
  }));
  const byRegime = {};
  for (const record of records) {
    const key = record.regime?.key ?? "unknown";
    if (!byRegime[key]) byRegime[key] = [];
    byRegime[key].push(record);
  }
  const regimeSummary = Object.fromEntries(Object.entries(byRegime).map(([key, subset]) => [
    key,
    Object.freeze({ count: subset.length, probabilities: summarizeProbabilities(subset) }),
  ]));
  const temporal = Object.fromEntries(Object.entries(timeBuckets(records)).map(([key, subset]) => [
    key,
    Object.freeze({
      count: subset.length,
      firstAnchorTimestamp: subset[0]?.anchorTimestamp ?? null,
      lastAnchorTimestamp: subset.at(-1)?.anchorTimestamp ?? null,
      probabilities: summarizeProbabilities(subset),
    }),
  ]));
  return Object.freeze({
    count: records.length,
    timeframe: timeframes[0],
    firstAnchorTimestamp: Math.min(...records.map((record) => record.anchorTimestamp)),
    lastAnchorTimestamp: Math.max(...records.map((record) => record.anchorTimestamp)),
    featureOrder: Object.freeze([...canonicalFeatureOrder]),
    features: Object.freeze(featureStats),
    probabilities: summarizeProbabilities(records),
    bySymbol: Object.freeze(bySymbol),
    byRegime: Object.freeze(regimeSummary),
    temporal: Object.freeze(temporal),
  });
}

export function buildShadowFeatureDriftDiagnostic({
  records,
  modelArtifact,
  canonicalFeatureOrder,
  referenceRecords = null,
  researchCodeSha,
  shadowResearchCodeSha,
  modelGroup,
  generatedAt = Date.now(),
}) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("empty shadow sample");
  const model = modelArtifact?.model ?? modelArtifact;
  assertModelContract(model, canonicalFeatureOrder);
  if (typeof researchCodeSha !== "string" || !/^[0-9a-f]{40}$/.test(researchCodeSha)) throw new TypeError("researchCodeSha must be an immutable SHA");
  if (typeof shadowResearchCodeSha !== "string" || !/^[0-9a-f]{40}$/.test(shadowResearchCodeSha)) throw new TypeError("shadowResearchCodeSha must be an immutable SHA");
  if (typeof modelGroup !== "string" || modelGroup.length === 0) throw new TypeError("modelGroup is required");
  const modelRecords = records.filter((record) => record.modelId === model.id);
  if (modelRecords.length === 0) throw new Error(`no records for active model ${model.id}`);
  const slice = buildSlice(modelRecords, model, canonicalFeatureOrder, referenceRecords);
  return Object.freeze({
    schemaVersion: 1,
    kind: "shadow-feature-drift-diagnostic",
    generatedAt,
    researchCodeSha,
    shadowResearchCodeSha,
    modelGroup,
    modelId: model.id,
    referenceModelId: modelRecords[0]?.referenceModelId ?? null,
    sourceDatasets: Object.freeze([...(modelArtifact?.sourceDatasets ?? [])]),
    historicalClassCounts: Object.freeze({ ...(modelArtifact?.classCounts ?? {}) }),
    diagnostics: slice,
    limitations: Object.freeze(referenceRecords?.length ? [] : [
      "raw_train_validation_feature_samples_not_persisted",
      "psi_and_ks_require_reference_feature_samples",
      "model_normalization_mean_scale_are_used_only_as_training_baseline_proxies",
    ]),
    rootCauseVerdict: "INSUFFICIENT_EVIDENCE",
    safety: Object.freeze({
      syntheticDataAllowed: false,
      modelModified: false,
      thresholdModified: false,
      labelModified: false,
      branchWrite: false,
      liveOrderAllowed: false,
      privateAccountRequestAllowed: false,
      orderSubmitted: false,
    }),
  });
}

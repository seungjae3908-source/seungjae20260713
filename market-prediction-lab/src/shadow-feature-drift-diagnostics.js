import {
  compareReferenceEvidenceProvenance,
  sha256Canonical,
  validateReferenceArtifactReceipt,
  validateReferenceEvidenceProvenance,
} from "./research-cache-provenance.js";

const CLASSES = Object.freeze(["bullish", "neutral", "bearish"]);
const REGIMES = Object.freeze(["Bull", "Bear", "Sideways"]);
const MIN_EMPIRICAL_SAMPLE_N = 2;

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

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
    return Object.freeze({
      count: 0,
      missingCount,
      missingRatio: totalCount ? missingCount / totalCount : null,
      zeroCount: 0,
      zeroRatio: null,
      mean: null,
      std: null,
      min: null,
      max: null,
      p01: null,
      p05: null,
      p25: null,
      p50: null,
      p75: null,
      p95: null,
      p99: null,
    });
  }
  const average = mean(numeric);
  const variance = mean(numeric.map((value) => (value - average) ** 2));
  const zeroCount = numeric.filter((value) => value === 0).length;
  return Object.freeze({
    count: numeric.length,
    missingCount,
    missingRatio: totalCount ? missingCount / totalCount : null,
    zeroCount,
    zeroRatio: zeroCount / numeric.length,
    mean: average,
    std: Math.sqrt(variance),
    min: sorted[0],
    max: sorted.at(-1),
    p01: quantile(sorted, 0.01),
    p05: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
  });
}

function requireEmpiricalValues(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  if (!values.length) throw new Error(`${label} is empty`);
  if (values.some((value) => !finite(value))) throw new TypeError(`${label} contains a non-finite value`);
  return [...values];
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

export function jensenShannonDivergence(referenceValues, currentValues, { bins = 10 } = {}) {
  const reference = requireEmpiricalValues(referenceValues, "referenceValues");
  const current = requireEmpiricalValues(currentValues, "currentValues");
  if (!Number.isInteger(bins) || bins < 2 || bins > 50) throw new TypeError("bins must be an integer between 2 and 50");
  const pooled = [...reference, ...current].sort((a, b) => a - b);
  const boundaries = Array.from({ length: bins - 1 }, (_, index) => quantile(pooled, (index + 1) / bins));
  const bucket = (value) => {
    let index = 0;
    while (index < boundaries.length && value > boundaries[index]) index += 1;
    return index;
  };
  const ratios = (values) => {
    const counts = Array(bins).fill(0);
    values.forEach((value) => { counts[bucket(value)] += 1; });
    return counts.map((count) => count / values.length);
  };
  const left = ratios(reference);
  const right = ratios(current);
  const mixture = left.map((value, index) => (value + right[index]) / 2);
  const divergence = (distribution) => distribution.reduce((sum, value, index) => (
    value === 0 ? sum : sum + value * Math.log(value / mixture[index])
  ), 0);
  const result = (divergence(left) + divergence(right)) / 2;
  if (!finite(result)) throw new Error("JSD calculation was non-finite");
  return Math.max(result, 0);
}

function validateModel(model, canonicalFeatureOrder) {
  if (!model || !Array.isArray(model.featureOrder) || !model.featureOrder.length) throw new TypeError("model featureOrder is required");
  if (canonicalFeatureOrder && (canonicalFeatureOrder.length !== model.featureOrder.length || canonicalFeatureOrder.some((name, index) => name !== model.featureOrder[index]))) {
    throw new Error("feature order mismatch");
  }
  const normalizationMean = model.normalization?.mean;
  const scale = model.normalization?.scale;
  if (!Array.isArray(normalizationMean) || !Array.isArray(scale) || normalizationMean.length !== model.featureOrder.length || scale.length !== model.featureOrder.length) throw new Error("scaler mismatch");
  scale.forEach((value, index) => {
    if (!finite(normalizationMean[index]) || !finite(value) || Math.abs(value) === 0) throw new Error(`invalid scaler at feature ${model.featureOrder[index]}`);
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
  if (!probabilities || CLASSES.some((name) => !finite(probabilities[name]) || probabilities[name] < 0 || probabilities[name] > 1)) throw new TypeError("candidate probabilities are invalid");
  const probabilityTotal = CLASSES.reduce((sum, name) => sum + probabilities[name], 0);
  if (Math.abs(probabilityTotal - 1) > 1e-6) throw new TypeError("candidate probabilities must sum to one");
  const ranked = CLASSES.map((name) => ({ name, value: probabilities[name] })).sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
  const entropy = CLASSES.reduce((sum, name) => probabilities[name] === 0 ? sum : sum - probabilities[name] * Math.log(probabilities[name]), 0);
  return Object.freeze({
    predicted: record.candidateClass ?? topClass(probabilities),
    actual: record.status === "settled" && CLASSES.includes(record.actualDirection) ? record.actualDirection : null,
    bullish: probabilities.bullish,
    neutral: probabilities.neutral,
    bearish: probabilities.bearish,
    top1: ranked[0].value,
    top2: ranked[1].value,
    margin: ranked[0].value - ranked[1].value,
    entropy,
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

function directionalDistribution(counts) {
  return Object.freeze({ LONG: counts.bullish, NEUTRAL: counts.neutral, SHORT: counts.bearish, unknown: counts.unknown });
}

function directionalQuality(rows) {
  const settled = rows.filter((row) => row.actual !== null);
  const confusionMatrix = Object.fromEntries(CLASSES.map((actual) => [actual, Object.fromEntries(CLASSES.map((predicted) => [predicted, 0]))]));
  settled.forEach((row) => { confusionMatrix[row.actual][row.predicted] += 1; });
  const perClass = {};
  CLASSES.forEach((name) => {
    const truePositive = confusionMatrix[name][name];
    const support = CLASSES.reduce((sum, predicted) => sum + confusionMatrix[name][predicted], 0);
    const predictedSupport = CLASSES.reduce((sum, actual) => sum + confusionMatrix[actual][name], 0);
    const falsePositive = predictedSupport - truePositive;
    const falseNegative = support - truePositive;
    perClass[name] = Object.freeze({
      support,
      predictedSupport,
      precision: predictedSupport ? truePositive / predictedSupport : null,
      recall: support ? truePositive / support : null,
      f1: support ? (2 * truePositive) / (2 * truePositive + falsePositive + falseNegative) : null,
    });
  });
  const supported = CLASSES.filter((name) => perClass[name].support > 0);
  return Object.freeze({
    settledCount: settled.length,
    confusionMatrix: Object.freeze(Object.fromEntries(Object.entries(confusionMatrix).map(([actual, counts]) => [actual, Object.freeze(counts)]))),
    perClass: Object.freeze(perClass),
    macroF1: mean(supported.map((name) => perClass[name].f1)),
    balancedAccuracy: mean(supported.map((name) => perClass[name].recall)),
    longRecall: perClass.bullish.recall,
    neutralRecall: perClass.neutral.recall,
    shortRecall: perClass.bearish.recall,
    bearRecall: perClass.bearish.recall,
  });
}

function summarizeProbabilities(records) {
  const rows = records.map(probabilityRow);
  const settled = rows.filter((row) => row.actual !== null);
  const classConditional = {};
  CLASSES.forEach((actual) => {
    const subset = settled.filter((row) => row.actual === actual);
    classConditional[actual] = Object.freeze({
      count: subset.length,
      bullish: summarize(subset.map((row) => row.bullish)),
      neutral: summarize(subset.map((row) => row.neutral)),
      bearish: summarize(subset.map((row) => row.bearish)),
      top1: summarize(subset.map((row) => row.top1)),
      top2: summarize(subset.map((row) => row.top2)),
      confidenceMargin: summarize(subset.map((row) => row.margin)),
      entropy: summarize(subset.map((row) => row.entropy)),
      predictedClassDistribution: classCounts(subset, "predicted"),
    });
  });
  const predictedClassDistribution = classCounts(rows, "predicted");
  const actualLabelDistribution = classCounts(settled, "actual");
  return Object.freeze({
    count: rows.length,
    settledCount: settled.length,
    bullish: summarize(rows.map((row) => row.bullish)),
    neutral: summarize(rows.map((row) => row.neutral)),
    bearish: summarize(rows.map((row) => row.bearish)),
    top1: summarize(rows.map((row) => row.top1)),
    top2: summarize(rows.map((row) => row.top2)),
    confidenceMargin: summarize(rows.map((row) => row.margin)),
    entropy: summarize(rows.map((row) => row.entropy)),
    predictedClassDistribution,
    predictedDirectionalDistribution: directionalDistribution(predictedClassDistribution),
    actualLabelDistribution,
    actualDirectionalDistribution: directionalDistribution(actualLabelDistribution),
    classConditional: Object.freeze(classConditional),
    directionalQuality: directionalQuality(rows),
  });
}

function provenanceFields(provenance) {
  if (!provenance || typeof provenance !== "object") return null;
  return Object.freeze({
    strategyIdentityDigest: provenance.strategyIdentityDigest ?? null,
    datasetId: provenance.datasetId ?? null,
    datasetDigest: provenance.datasetDigest ?? null,
    modelSha: provenance.modelSha ?? null,
    preprocessingVersion: provenance.preprocessingVersion ?? null,
    featureOrderDigest: provenance.featureOrderDigest ?? null,
    trainSplitDigest: provenance.trainSplitDigest ?? null,
    validationSplitDigest: provenance.validationSplitDigest ?? null,
    rawArtifactDigest: provenance.rawArtifactDigest ?? null,
    researchCodeSha: provenance.researchCodeSha ?? null,
    trainingCodeSha: provenance.trainingCodeSha ?? null,
    measuredAt: provenance.measuredAt ?? null,
    artifactReceiptDigest: provenance.artifactReceiptDigest ?? null,
    provenanceDigest: provenance.provenanceDigest ?? null,
    artifactReceipt: provenance.artifactReceipt ?? null,
  });
}

function referenceDecision({ valid = false, status, reason, provenance = null, provenanceStatus = status, receiptStatus = status, comparisonStatus = status, trainRecords = [], validationRecords = [] }) {
  return Object.freeze({ valid, status, reason, provenance: provenanceFields(provenance), provenanceStatus, receiptStatus, comparisonStatus, trainRecords, validationRecords, records: [...trainRecords, ...validationRecords] });
}

function assessReferenceEvidence({ referenceEvidence, expectedReferenceProvenance, referenceNow, modelArtifactDigest, featureOrderDigest }) {
  if (!referenceEvidence || typeof referenceEvidence !== "object" || Array.isArray(referenceEvidence)) return referenceDecision({ status: "MISSING_EVIDENCE", reason: "raw_train_validation_reference_missing" });
  if (referenceEvidence.sourceKind == null || referenceEvidence.reconstructed == null || referenceEvidence.shadowDerived == null) return referenceDecision({ status: "MISSING_EVIDENCE", reason: "reference_source_attestation_missing", provenance: referenceEvidence.provenance });
  if (referenceEvidence.sourceKind !== "RAW_TRAIN_VALIDATION" || referenceEvidence.reconstructed !== false || referenceEvidence.shadowDerived !== false) return referenceDecision({ status: "IDENTITY_MISMATCH", reason: "reference_source_substitution_rejected", provenance: referenceEvidence.provenance });
  const actual = referenceEvidence.provenance;
  const actualAssessment = validateReferenceEvidenceProvenance(actual, { now: referenceNow });
  const receiptAssessment = validateReferenceArtifactReceipt(actual?.artifactReceipt, { now: referenceNow });
  if (!actualAssessment.valid) return referenceDecision({ status: actualAssessment.status, reason: actualAssessment.reason, provenance: actual, provenanceStatus: actualAssessment.status, receiptStatus: receiptAssessment.status });
  if (!receiptAssessment.valid) return referenceDecision({ status: receiptAssessment.status, reason: receiptAssessment.reason, provenance: actual, provenanceStatus: actualAssessment.status, receiptStatus: receiptAssessment.status });
  if (!expectedReferenceProvenance) return referenceDecision({ status: "MISSING_EVIDENCE", reason: "expected_reference_identity_missing", provenance: actual, provenanceStatus: actualAssessment.status, receiptStatus: receiptAssessment.status });
  const comparison = compareReferenceEvidenceProvenance(expectedReferenceProvenance, actual, { now: referenceNow });
  if (!comparison.match) return referenceDecision({ status: comparison.status, reason: comparison.reason, provenance: actual, provenanceStatus: actualAssessment.status, receiptStatus: receiptAssessment.status, comparisonStatus: comparison.status });
  if (actual.modelSha !== modelArtifactDigest) return referenceDecision({ status: "IDENTITY_MISMATCH", reason: "reference_model_sha_mismatch", provenance: actual, provenanceStatus: actualAssessment.status, receiptStatus: receiptAssessment.status, comparisonStatus: comparison.status });
  if (actual.featureOrderDigest !== featureOrderDigest) return referenceDecision({ status: "IDENTITY_MISMATCH", reason: "reference_feature_order_mismatch", provenance: actual, provenanceStatus: actualAssessment.status, receiptStatus: receiptAssessment.status, comparisonStatus: comparison.status });
  const trainAttestation = referenceEvidence.splitAttestations?.train;
  const validationAttestation = referenceEvidence.splitAttestations?.validation;
  if (!trainAttestation || !validationAttestation) return referenceDecision({ status: "MISSING_EVIDENCE", reason: "reference_split_attestation_missing", provenance: actual, provenanceStatus: actualAssessment.status, receiptStatus: receiptAssessment.status, comparisonStatus: comparison.status });
  if (trainAttestation.sourceKind !== "RAW_TRAIN" || validationAttestation.sourceKind !== "RAW_VALIDATION"
      || trainAttestation.modelSha !== actual.modelSha || validationAttestation.modelSha !== actual.modelSha
      || trainAttestation.splitDigest !== actual.trainSplitDigest || validationAttestation.splitDigest !== actual.validationSplitDigest) {
    return referenceDecision({ status: "IDENTITY_MISMATCH", reason: "reference_split_identity_mismatch", provenance: actual, provenanceStatus: actualAssessment.status, receiptStatus: receiptAssessment.status, comparisonStatus: comparison.status });
  }
  const trainRecords = referenceEvidence.trainRecords;
  const validationRecords = referenceEvidence.validationRecords;
  if (!Array.isArray(trainRecords) || !Array.isArray(validationRecords) || !trainRecords.length || !validationRecords.length) return referenceDecision({ status: "MISSING_EVIDENCE", reason: "raw_train_validation_samples_missing", provenance: actual, provenanceStatus: actualAssessment.status, receiptStatus: receiptAssessment.status, comparisonStatus: comparison.status });
  if ([...trainRecords, ...validationRecords].some((record) => !record || typeof record.features !== "object" || Array.isArray(record.features))) return referenceDecision({ status: "MISSING_EVIDENCE", reason: "raw_reference_feature_sample_malformed", provenance: actual, provenanceStatus: actualAssessment.status, receiptStatus: receiptAssessment.status, comparisonStatus: comparison.status });
  return referenceDecision({ valid: true, status: "EXACT_IDENTITY_MATCH", reason: null, provenance: actual, provenanceStatus: actualAssessment.status, receiptStatus: receiptAssessment.status, comparisonStatus: comparison.status, trainRecords, validationRecords });
}

function featureStats(records, model, featureName, index, reference, modelArtifactDigest) {
  const values = records.map((record) => finite(record.features?.[featureName]) ? record.features[featureName] : null);
  const raw = summarize(values, records.length);
  const baselineMean = model.normalization.mean[index];
  const baselineScale = Math.abs(model.normalization.scale[index]);
  const normalized = values.filter(finite).map((value) => (value - baselineMean) / baselineScale);
  const normalizedSummary = summarize(normalized, records.length);
  const clippingCount = normalized.filter((value) => Math.abs(value) >= 12).length;
  const referenceValues = reference.valid ? reference.records.map((record) => record.features?.[featureName]).filter(finite) : [];
  const trainReferenceSampleN = reference.valid ? reference.trainRecords.map((record) => record.features?.[featureName]).filter(finite).length : 0;
  const validationReferenceSampleN = reference.valid ? reference.validationRecords.map((record) => record.features?.[featureName]).filter(finite).length : 0;
  const currentValues = values.filter(finite);
  const enough = reference.valid && referenceValues.length >= MIN_EMPIRICAL_SAMPLE_N && currentValues.length >= MIN_EMPIRICAL_SAMPLE_N;
  const evidenceStatus = reference.valid ? (enough ? "EXACT_REFERENCE_MEASURED" : "INSUFFICIENT_EVIDENCE") : reference.status;
  const provenance = reference.provenance;
  return Object.freeze({
    feature: featureName,
    raw,
    normalized: normalizedSummary,
    modelNormalization: Object.freeze({ mean: baselineMean, scale: baselineScale }),
    standardizedMeanShift: raw.mean === null ? null : (raw.mean - baselineMean) / baselineScale,
    stdRatioToTrainingScale: raw.std === null ? null : raw.std / baselineScale,
    clippingCount,
    clippingRatio: normalized.length ? clippingCount / normalized.length : null,
    driftEvidenceStatus: evidenceStatus,
    referenceSampleN: referenceValues.length,
    trainReferenceSampleN,
    validationReferenceSampleN,
    shadowSampleN: currentValues.length,
    modelSha: modelArtifactDigest,
    referenceModelSha: provenance?.modelSha ?? null,
    strategyIdentityDigest: provenance?.strategyIdentityDigest ?? null,
    datasetDigest: provenance?.datasetDigest ?? null,
    preprocessingVersion: provenance?.preprocessingVersion ?? null,
    featureOrderDigest: provenance?.featureOrderDigest ?? null,
    trainSplitDigest: provenance?.trainSplitDigest ?? null,
    validationSplitDigest: provenance?.validationSplitDigest ?? null,
    rawArtifactDigest: provenance?.rawArtifactDigest ?? null,
    measuredWindow: Object.freeze({ referenceMeasuredAt: provenance?.measuredAt ?? null, shadowFirstAnchorTimestamp: Math.min(...records.map((record) => record.anchorTimestamp)), shadowLastAnchorTimestamp: Math.max(...records.map((record) => record.anchorTimestamp)) }),
    referenceDistributionAvailable: enough,
    psi: enough ? populationStabilityIndex(referenceValues, currentValues) : null,
    ksDistance: enough ? kolmogorovSmirnovDistance(referenceValues, currentValues) : null,
    jsd: enough ? jensenShannonDivergence(referenceValues, currentValues) : null,
  });
}

function regimeName(record) {
  const value = String(record.regime?.trend ?? record.regime?.key?.split(":")[0] ?? "").toLowerCase();
  if (/(bull|uptrend|upward|rising)/.test(value)) return "Bull";
  if (/(bear|downtrend|downward|falling)/.test(value)) return "Bear";
  if (/(sideways|range|flat)/.test(value)) return "Sideways";
  return "Unknown";
}

function sliceSummary(records) {
  const probabilities = summarizeProbabilities(records);
  return Object.freeze({ count: records.length, probabilities, directionalQuality: probabilities.directionalQuality });
}

function temporalBuckets(records) {
  const sorted = [...records].sort((left, right) => left.anchorTimestamp - right.anchorTimestamp || String(left.id).localeCompare(String(right.id)));
  const firstEnd = Math.ceil(sorted.length / 3);
  const secondEnd = Math.ceil((sorted.length * 2) / 3);
  return Object.freeze({ oldest: sorted.slice(0, firstEnd), middle: sorted.slice(firstEnd, secondEnd), newest: sorted.slice(secondEnd) });
}

export function buildShadowFeatureDriftDiagnostic({ records, modelArtifact, canonicalFeatureOrder, referenceEvidence = null, expectedReferenceProvenance = null, referenceNow = null, researchCodeSha, shadowResearchCodeSha, modelGroup, generatedAt = Date.now() }) {
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
  const modelArtifactDigest = sha256Canonical(modelArtifact);
  const featureOrderDigest = sha256Canonical(model.featureOrder);
  const checkedAt = referenceNow ?? new Date(generatedAt).toISOString();
  const reference = assessReferenceEvidence({ referenceEvidence, expectedReferenceProvenance, referenceNow: checkedAt, modelArtifactDigest, featureOrderDigest });
  const features = Object.freeze(Object.fromEntries(model.featureOrder.map((featureName, index) => [featureName, featureStats(modelRecords, model, featureName, index, reference, modelArtifactDigest)])));
  const featureValues = Object.values(features);
  const driftEvidenceValid = reference.valid && featureValues.every((feature) => feature.driftEvidenceStatus === "EXACT_REFERENCE_MEASURED");
  const driftEvidenceStatus = driftEvidenceValid ? "EXACT_REFERENCE_MEASURED" : (reference.valid ? "INSUFFICIENT_EVIDENCE" : reference.status);
  const symbols = [...new Set(modelRecords.map((record) => record.symbol))].sort();
  const bySymbol = Object.freeze(Object.fromEntries(symbols.map((symbol) => [symbol, sliceSummary(modelRecords.filter((record) => record.symbol === symbol))])));
  const byRegimeEntries = REGIMES.map((regime) => [regime, sliceSummary(modelRecords.filter((record) => regimeName(record) === regime))]);
  const unknownRegime = modelRecords.filter((record) => regimeName(record) === "Unknown");
  if (unknownRegime.length) byRegimeEntries.push(["Unknown", sliceSummary(unknownRegime)]);
  const byRegime = Object.freeze(Object.fromEntries(byRegimeEntries));
  const temporal = Object.freeze(Object.fromEntries(Object.entries(temporalBuckets(modelRecords)).map(([name, subset]) => [name, Object.freeze({ ...sliceSummary(subset), firstAnchorTimestamp: subset[0]?.anchorTimestamp ?? null, lastAnchorTimestamp: subset.at(-1)?.anchorTimestamp ?? null })])));
  const probabilities = summarizeProbabilities(modelRecords);
  const limitations = [];
  if (!reference.valid) limitations.push(reference.reason, "psi_ks_jsd_require_exact_raw_train_validation_reference", "normalization_statistics_are_proxy_metrics_only");
  if (reference.valid && !driftEvidenceValid) limitations.push("insufficient_empirical_feature_samples");
  return Object.freeze({
    schemaVersion: 3,
    kind: "shadow-feature-drift-diagnostic",
    generatedAt,
    researchCodeSha,
    shadowResearchCodeSha,
    modelGroup,
    modelId: model.id,
    modelSha: modelArtifactDigest,
    featureOrderDigest,
    referenceModelId: modelRecords[0]?.referenceModelId ?? null,
    sourceDatasets: Object.freeze([...(modelArtifact?.sourceDatasets ?? [])]),
    historicalClassCounts: Object.freeze({ ...(modelArtifact?.classCounts ?? {}) }),
    referenceEvidence: Object.freeze({
      status: reference.status,
      reason: reference.reason,
      provenanceStatus: reference.provenanceStatus,
      receiptStatus: reference.receiptStatus,
      comparisonStatus: reference.comparisonStatus,
      checkedAt,
      rawTrainSampleN: reference.trainRecords.length,
      rawValidationSampleN: reference.validationRecords.length,
      identity: reference.provenance,
    }),
    DRIFT_EVIDENCE_VALID: driftEvidenceValid,
    DRIFT_PROXY_ONLY: !driftEvidenceValid,
    trueDistributionDriftAvailable: driftEvidenceValid,
    driftEvidenceStatus,
    diagnostics: Object.freeze({
      count: modelRecords.length,
      timeframe: timeframes[0],
      firstAnchorTimestamp: Math.min(...modelRecords.map((record) => record.anchorTimestamp)),
      lastAnchorTimestamp: Math.max(...modelRecords.map((record) => record.anchorTimestamp)),
      featureOrder: Object.freeze([...model.featureOrder]),
      features,
      probabilities,
      directionalQuality: probabilities.directionalQuality,
      bySymbol,
      byRegime,
      temporal,
    }),
    limitations: Object.freeze([...new Set(limitations.filter(Boolean))]),
    rootCauseVerdict: driftEvidenceValid ? "DRIFT_MEASURED_CAUSALITY_UNPROVEN" : driftEvidenceStatus,
    safety: Object.freeze({
      diagnosticsOnly: true,
      syntheticDataAllowed: false,
      modelModified: false,
      thresholdModified: false,
      labelModified: false,
      LIVE_TRADING: false,
      AUTO_TRADING: false,
      REAL_ORDER_ENABLED: false,
      PRIVATE_TRADING_API_ALLOWED: false,
      executionAuthority: "NONE",
      orderSubmitted: false,
    }),
  });
}

import { sha256Canonical } from "./research-cache-provenance.js";
import {
  jensenShannonDivergence,
  kolmogorovSmirnovDistance,
  populationStabilityIndex,
} from "./shadow-feature-drift-diagnostics.js";

export const CANONICAL_SHADOW_DRIFT_POLICY_SCHEMA_VERSION = "prediction-lab-canonical-shadow-drift-policy-v1";
export const CANONICAL_SHADOW_DRIFT_POLICY_ID = "PREDICTION_LAB_CANONICAL_SHADOW_DRIFT";
export const CANONICAL_SHADOW_DRIFT_POLICY_VERSION = "2026-08-26.reference-control-limits.v1";
export const CANONICAL_SHADOW_DRIFT_POLICY_FROZEN_AT = "2026-08-26T05:50:00.000Z";

export const DRIFT_METRIC_COMPUTABLE_MINIMUM_N = 2;
export const DRIFT_VERDICT_MINIMUM_N = 30;
export const DRIFT_CALIBRATION_WINDOW_N = 30;
export const DRIFT_MINIMUM_CALIBRATION_WINDOWS = 20;

const HASH_64 = /^[0-9a-f]{64}$/u;
const EPSILON = 1e-12;
const METRIC_NAMES = Object.freeze([
  "psi",
  "ksStatistic",
  "jsd",
  "standardizedMeanShift",
  "stdRatio",
  "missingRatio",
  "clippingRatio",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function digest(value) {
  return typeof value === "string" && HASH_64.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

function iso(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function standardDeviation(values) {
  if (!values.length) return null;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function failure(reason, extra = {}) {
  return deepFreeze({ valid: false, status: "NOT_EVALUABLE", reason, ...extra });
}

function splitWindows(records) {
  const windows = [];
  for (let index = 0; index + DRIFT_CALIBRATION_WINDOW_N <= records.length; index += DRIFT_CALIBRATION_WINDOW_N) {
    windows.push(records.slice(index, index + DRIFT_CALIBRATION_WINDOW_N));
  }
  return windows;
}

function numericFeature(records, featureName) {
  return records.map((record) => record?.features?.[featureName]).filter(finite);
}

function ratio(records, predicate) {
  return records.length ? records.filter(predicate).length / records.length : null;
}

function clippingRatio(records, featureName, model, featureIndex) {
  const normalizationMean = model.normalization?.mean?.[featureIndex];
  const normalizationScale = Math.abs(model.normalization?.scale?.[featureIndex] ?? 0);
  if (!finite(normalizationMean) || !(normalizationScale > 0)) return null;
  const values = numericFeature(records, featureName);
  return values.length ? values.filter((value) => Math.abs((value - normalizationMean) / normalizationScale) >= 12).length / values.length : null;
}

function calibrationValues(referenceRecords, windows, featureOrder, model) {
  const values = Object.fromEntries(METRIC_NAMES.map((name) => [name, []]));
  featureOrder.forEach((featureName, featureIndex) => {
    const referenceValues = numericFeature(referenceRecords, featureName);
    if (referenceValues.length < DRIFT_CALIBRATION_WINDOW_N) return;
    const referenceMean = mean(referenceValues);
    const referenceStd = standardDeviation(referenceValues);
    const referenceMissing = ratio(referenceRecords, (record) => !finite(record?.features?.[featureName]));
    for (const window of windows) {
      const currentValues = numericFeature(window, featureName);
      if (currentValues.length < DRIFT_METRIC_COMPUTABLE_MINIMUM_N) continue;
      const currentMean = mean(currentValues);
      const currentStd = standardDeviation(currentValues);
      const currentMissing = ratio(window, (record) => !finite(record?.features?.[featureName]));
      values.psi.push(populationStabilityIndex(referenceValues, currentValues));
      values.ksStatistic.push(kolmogorovSmirnovDistance(referenceValues, currentValues));
      values.jsd.push(jensenShannonDivergence(referenceValues, currentValues));
      values.standardizedMeanShift.push(Math.abs((currentMean - referenceMean) / Math.max(Math.abs(referenceStd), EPSILON)));
      values.stdRatio.push(Math.abs(Math.log(Math.max(currentStd, EPSILON) / Math.max(referenceStd, EPSILON))));
      values.missingRatio.push(Math.max((currentMissing ?? 0) - (referenceMissing ?? 0), 0));
      const clipped = clippingRatio(window, featureName, model, featureIndex);
      if (finite(clipped)) values.clippingRatio.push(clipped);
    }
  });
  return values;
}

function policyBody(policy) {
  const body = structuredClone(policy);
  delete body.policyDigest;
  return body;
}

export function buildCanonicalShadowDriftPolicyV1({
  producerManifest,
  strategyResolution,
  modelResolution,
  referenceResolution,
} = {}) {
  if (!object(producerManifest) || strategyResolution?.valid !== true || modelResolution?.valid !== true || referenceResolution?.valid !== true) {
    return failure("POLICY_INPUT_EVIDENCE_MISSING");
  }
  if (producerManifest.sourceAttestation?.sourceKind !== "GENUINE_MARKET_DATA"
      || producerManifest.sourceAttestation?.reconstructed !== false
      || producerManifest.sourceAttestation?.synthetic !== false
      || producerManifest.sourceAttestation?.shadowDerived !== false
      || producerManifest.sourceAttestation?.finalHoldoutIncluded !== false) {
    return failure("POLICY_REFERENCE_PROVENANCE_INVALID");
  }
  const featureOrder = modelResolution.exactModel?.featureOrder;
  if (!Array.isArray(featureOrder) || !featureOrder.length) return failure("POLICY_FEATURE_ORDER_MISSING");
  const trainWindows = splitWindows(referenceResolution.trainRecords ?? []);
  const validationWindows = splitWindows(referenceResolution.validationRecords ?? []);
  const windows = [...trainWindows, ...validationWindows];
  if (windows.length < DRIFT_MINIMUM_CALIBRATION_WINDOWS) {
    return failure("POLICY_REFERENCE_SAMPLE_INSUFFICIENT", {
      calibrationWindowN: DRIFT_CALIBRATION_WINDOW_N,
      calibrationWindowCount: windows.length,
      minimumCalibrationWindows: DRIFT_MINIMUM_CALIBRATION_WINDOWS,
    });
  }
  const calibrated = calibrationValues(referenceResolution.referenceRecords, windows, featureOrder, modelResolution.exactModel);
  if (METRIC_NAMES.some((name) => !calibrated[name].length || calibrated[name].some((value) => !finite(value) || value < 0))) {
    return failure("POLICY_CALIBRATION_METRIC_MISSING");
  }
  const rules = Object.fromEntries(METRIC_NAMES.map((name) => [name, Object.freeze({
    comparison: "GT",
    watch: quantile(calibrated[name], 0.95),
    brake: quantile(calibrated[name], 0.99),
  })]));
  const strategy = strategyResolution.strategyIdentity;
  const referenceIdentityDigest = sha256Canonical(referenceResolution.referenceIdentity);
  const expiresAt = iso(referenceResolution.freshness?.expiresAt ?? producerManifest.artifactReceipt?.expiresAt);
  if (!expiresAt) return failure("POLICY_REFERENCE_EXPIRY_MISSING");
  const body = {
    schemaVersion: CANONICAL_SHADOW_DRIFT_POLICY_SCHEMA_VERSION,
    policyId: CANONICAL_SHADOW_DRIFT_POLICY_ID,
    policyVersion: CANONICAL_SHADOW_DRIFT_POLICY_VERSION,
    source: "CANONICAL_REFERENCE_CALIBRATED_POLICY",
    hindsightTuned: false,
    provenance: {
      authority: "PREDICTION_LAB_CANONICAL_SHADOW_DRIFT_POLICY_V1",
      metricPrimitives: "market-prediction-lab/src/shadow-feature-drift-diagnostics.js",
      calibrationContract: "TRAIN_VALIDATION_CHRONOLOGICAL_CONTROL_LIMITS_V1",
      referenceIdentity: structuredClone(referenceResolution.referenceIdentity),
      referenceIdentityDigest,
      strategyIdentityDigest: strategyResolution.strategyIdentityDigest,
      modelIdentityDigest: modelResolution.modelIdentityDigest,
    },
    generatedFrom: {
      sources: ["TRAIN", "VALIDATION"],
      trainSplitDigest: producerManifest.trainSplitDigest,
      validationSplitDigest: producerManifest.validationSplitDigest,
      rawArtifactDigest: producerManifest.rawArtifactDigest,
      referenceN: referenceResolution.referenceRecords.length,
      calibrationWindowN: DRIFT_CALIBRATION_WINDOW_N,
      calibrationWindowCount: windows.length,
      watchQuantile: 0.95,
      brakeQuantile: 0.99,
      currentShadowUsed: false,
      settledShadowUsed: false,
      finalHoldoutUsed: false,
      replayUsed: false,
      historicalBackfillUsed: false,
      syntheticUsed: false,
    },
    frozenAt: CANONICAL_SHADOW_DRIFT_POLICY_FROZEN_AT,
    expiresAt,
    applicableMarkets: [strategy.market],
    applicableTimeframes: [strategy.timeframe],
    minimumSamplePolicy: {
      metricComputableMinimumN: DRIFT_METRIC_COMPUTABLE_MINIMUM_N,
      verdictMinimumN: DRIFT_VERDICT_MINIMUM_N,
      profitabilitySufficientMinimumN: null,
      profitabilityPolicySeparated: true,
      rationale: "GENERAL_STATISTICAL_SAFETY_MINIMUM_30_AND_MATCHED_REFERENCE_WINDOWS",
    },
    rules,
    multiSignalAggregation: {
      watchMinimumMetricFamilies: 1,
      brakeMinimumMetricFamilies: 2,
      crossFeatureDuplicatesCountOncePerMetricFamily: true,
    },
    failClosedRules: [
      "POLICY_MISSING",
      "POLICY_PROVENANCE_INVALID",
      "POLICY_DIGEST_MISMATCH",
      "POLICY_EXPIRED",
      "POLICY_VERSION_MISMATCH",
      "POLICY_MARKET_MISMATCH",
      "POLICY_TIMEFRAME_MISMATCH",
      "REFERENCE_IDENTITY_MISMATCH",
      "INSUFFICIENT_SAMPLE",
      "DRIFT_METRIC_MISSING",
    ],
  };
  return deepFreeze({ valid: true, status: "VALID", reason: null, policy: { ...body, policyDigest: sha256Canonical(body) } });
}

export function validateCanonicalShadowDriftPolicyV1({
  policy,
  strategyIdentityDigest,
  modelIdentityDigest,
  referenceIdentity,
  market,
  timeframe,
  asOf,
} = {}) {
  if (!object(policy)) return failure("CANONICAL_DRIFT_POLICY_MISSING");
  if (policy.schemaVersion !== CANONICAL_SHADOW_DRIFT_POLICY_SCHEMA_VERSION
      || policy.policyId !== CANONICAL_SHADOW_DRIFT_POLICY_ID
      || policy.policyVersion !== CANONICAL_SHADOW_DRIFT_POLICY_VERSION) return failure("POLICY_VERSION_MISMATCH");
  if (policy.source !== "CANONICAL_REFERENCE_CALIBRATED_POLICY" || policy.hindsightTuned !== false) return failure("POLICY_PROVENANCE_INVALID");
  if (!digest(policy.policyDigest) || sha256Canonical(policyBody(policy)) !== policy.policyDigest.toLowerCase()) return failure("POLICY_DIGEST_MISMATCH");
  if (!object(policy.provenance)
      || policy.provenance.authority !== "PREDICTION_LAB_CANONICAL_SHADOW_DRIFT_POLICY_V1"
      || policy.provenance.strategyIdentityDigest !== strategyIdentityDigest
      || policy.provenance.modelIdentityDigest !== modelIdentityDigest
      || policy.provenance.referenceIdentityDigest !== sha256Canonical(referenceIdentity)
      || policy.generatedFrom?.currentShadowUsed !== false
      || policy.generatedFrom?.settledShadowUsed !== false
      || policy.generatedFrom?.finalHoldoutUsed !== false
      || policy.generatedFrom?.replayUsed !== false
      || policy.generatedFrom?.historicalBackfillUsed !== false
      || policy.generatedFrom?.syntheticUsed !== false) return failure("POLICY_PROVENANCE_INVALID");
  if (!Array.isArray(policy.applicableMarkets) || !policy.applicableMarkets.includes(market)) return failure("POLICY_MARKET_MISMATCH");
  if (!Array.isArray(policy.applicableTimeframes) || !policy.applicableTimeframes.includes(timeframe)) return failure("POLICY_TIMEFRAME_MISMATCH");
  const checkedAt = iso(asOf);
  const frozenAt = iso(policy.frozenAt);
  const expiresAt = iso(policy.expiresAt);
  if (!checkedAt || !frozenAt || Date.parse(frozenAt) > Date.parse(checkedAt)) return failure("POLICY_NOT_YET_FROZEN");
  if (!expiresAt || Date.parse(expiresAt) <= Date.parse(checkedAt)) return failure("POLICY_EXPIRED");
  if (policy.minimumSamplePolicy?.metricComputableMinimumN !== DRIFT_METRIC_COMPUTABLE_MINIMUM_N
      || policy.minimumSamplePolicy?.verdictMinimumN !== DRIFT_VERDICT_MINIMUM_N
      || policy.minimumSamplePolicy?.profitabilitySufficientMinimumN !== null
      || policy.minimumSamplePolicy?.profitabilityPolicySeparated !== true) return failure("POLICY_MINIMUM_SAMPLE_CONTRACT_INVALID");
  if (METRIC_NAMES.some((name) => {
    const rule = policy.rules?.[name];
    return rule?.comparison !== "GT" || !finite(rule.watch) || !finite(rule.brake) || rule.watch < 0 || rule.brake < rule.watch;
  })) return failure("POLICY_RULES_INVALID");
  if (policy.multiSignalAggregation?.watchMinimumMetricFamilies !== 1
      || !Number.isInteger(policy.multiSignalAggregation?.brakeMinimumMetricFamilies)
      || policy.multiSignalAggregation.brakeMinimumMetricFamilies < 2
      || policy.multiSignalAggregation?.crossFeatureDuplicatesCountOncePerMetricFamily !== true) return failure("POLICY_AGGREGATION_INVALID");
  return deepFreeze({ valid: true, status: "VALID", reason: null, policy });
}

function metricValue(item, metricName) {
  if (metricName === "standardizedMeanShift") return finite(item.standardizedMeanShift) ? Math.abs(item.standardizedMeanShift) : null;
  if (metricName === "stdRatio") {
    if (finite(item.stdRatio) && item.stdRatio > 0) return Math.abs(Math.log(Math.max(item.stdRatio, EPSILON)));
    if ((item.reference?.std ?? null) === 0 && (item.shadow?.std ?? null) === 0) return 0;
    return null;
  }
  if (metricName === "missingRatio") return finite(item.missingRatio?.delta) ? Math.max(item.missingRatio.delta, 0) : null;
  if (metricName === "clippingRatio") return finite(item.clippingRatio?.shadow) ? item.clippingRatio.shadow : null;
  return finite(item[metricName]) ? item[metricName] : null;
}

export function evaluateCanonicalShadowDriftPolicyV1({
  policy,
  featureMetrics,
  sampleN,
  strategyIdentityDigest,
  modelIdentityDigest,
  referenceIdentity,
  market,
  timeframe,
  asOf,
} = {}) {
  const validated = validateCanonicalShadowDriftPolicyV1({ policy, strategyIdentityDigest, modelIdentityDigest, referenceIdentity, market, timeframe, asOf });
  if (!validated.valid) return validated;
  const metricComputable = Number.isInteger(sampleN) && sampleN >= DRIFT_METRIC_COMPUTABLE_MINIMUM_N;
  const verdictSufficient = Number.isInteger(sampleN) && sampleN >= DRIFT_VERDICT_MINIMUM_N;
  if (!verdictSufficient) return failure("INSUFFICIENT_SAMPLE", {
    metricComputable,
    verdictSufficient: false,
    sampleN,
    metricComputableMinimumN: DRIFT_METRIC_COMPUTABLE_MINIMUM_N,
    verdictMinimumN: DRIFT_VERDICT_MINIMUM_N,
    policy: validated.policy,
  });
  const metrics = Array.isArray(featureMetrics) ? featureMetrics : [];
  if (!metrics.length || metrics.some((item) => item?.status !== "MEASURED")) return failure("DRIFT_METRIC_MISSING", { metricComputable, verdictSufficient });
  const watchSignals = [];
  const brakeSignals = [];
  const maxima = Object.fromEntries(METRIC_NAMES.map((name) => [name, 0]));
  for (const item of metrics) {
    for (const metricName of METRIC_NAMES) {
      const value = metricValue(item, metricName);
      if (!finite(value)) return failure("DRIFT_METRIC_MISSING", { metricComputable, verdictSufficient, feature: item.feature, metricName });
      maxima[metricName] = Math.max(maxima[metricName], value);
      if (value > validated.policy.rules[metricName].watch) watchSignals.push(`${item.feature}:${metricName}`);
      if (value > validated.policy.rules[metricName].brake) brakeSignals.push(`${item.feature}:${metricName}`);
    }
  }
  const watchFamilies = [...new Set(watchSignals.map((signal) => signal.split(":").at(-1)))];
  const brakeFamilies = [...new Set(brakeSignals.map((signal) => signal.split(":").at(-1)))];
  const status = brakeFamilies.length >= validated.policy.multiSignalAggregation.brakeMinimumMetricFamilies
    ? "BRAKE"
    : (watchFamilies.length >= validated.policy.multiSignalAggregation.watchMinimumMetricFamilies ? "WATCH" : "STABLE");
  return deepFreeze({
    valid: true,
    status,
    reason: status === "STABLE" ? "CANONICAL_POLICY_WITHIN_LIMITS" : (status === "WATCH" ? "CANONICAL_POLICY_WATCH_SIGNAL" : "CANONICAL_POLICY_MULTI_SIGNAL_BRAKE"),
    metricComputable,
    verdictSufficient,
    watchSignals,
    brakeSignals,
    watchMetricFamilies: watchFamilies,
    brakeMetricFamilies: brakeFamilies,
    maxima,
    policy: validated.policy,
  });
}

export function canonicalShadowDriftPolicyMetricNamesV1() {
  return METRIC_NAMES;
}

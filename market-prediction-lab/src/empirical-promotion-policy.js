export const EMPIRICAL_PROMOTION_POLICY_SCHEMA_VERSION = 1;

const METRICS = Object.freeze([
  Object.freeze({ key: "minTrials", path: ["selectionBias", "trialCount"], direction: "min" }),
  Object.freeze({ key: "maxPbo", path: ["selectionBias", "pbo"], direction: "max" }),
  Object.freeze({ key: "minDsrProbability", path: ["selectionBias", "dsrProbability"], direction: "min" }),
  Object.freeze({ key: "minOosTrades", path: ["backtest", "oosTrades"], direction: "min" }),
  Object.freeze({ key: "minWalkForwardWindows", path: ["backtest", "walkForwardWindows"], direction: "min" }),
  Object.freeze({ key: "minShadowSettled", path: ["shadow", "settled"], direction: "min" }),
  Object.freeze({ key: "minShadowElapsedMs", path: ["shadow", "elapsedMs"], direction: "min" }),
  Object.freeze({ key: "minPaperSettled", path: ["paper", "settledTrades"], direction: "min" }),
  Object.freeze({ key: "minPaperProfitFactor", path: ["paper", "profitFactor"], direction: "min" }),
  Object.freeze({ key: "minPaperExpectancyCiLower", path: ["paper", "expectancyCiLower"], direction: "min" }),
  Object.freeze({ key: "maxPaperMdd", path: ["paper", "maximumDrawdown"], direction: "max" }),
]);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function atPath(value, path) {
  let current = value;
  for (const key of path) current = current?.[key];
  return current;
}

function candidateThresholds(values) {
  const unique = [...new Set(values.filter(finite))].sort((a, b) => a - b);
  if (unique.length === 0) return [];
  if (unique.length === 1) return unique;
  const candidates = [unique[0], unique[unique.length - 1]];
  for (let i = 0; i < unique.length - 1; i += 1) {
    candidates.push((unique[i] + unique[i + 1]) / 2);
  }
  return [...new Set(candidates)].sort((a, b) => a - b);
}

function classify(value, threshold, direction) {
  return direction === "min" ? value >= threshold : value <= threshold;
}

function scoreThreshold(rows, descriptor, threshold) {
  let tp = 0; let tn = 0; let fp = 0; let fn = 0;
  for (const row of rows) {
    const success = row.outcome === "PASS";
    const predicted = classify(atPath(row, descriptor.path), threshold, descriptor.direction);
    if (success && predicted) tp += 1;
    else if (success) fn += 1;
    else if (predicted) fp += 1;
    else tn += 1;
  }
  const tpr = tp + fn > 0 ? tp / (tp + fn) : 0;
  const tnr = tn + fp > 0 ? tn / (tn + fp) : 0;
  return Object.freeze({ threshold, balancedAccuracy: (tpr + tnr) / 2, tpr, tnr, tp, tn, fp, fn });
}

function chooseThreshold(rows, descriptor) {
  const values = rows.map((row) => atPath(row, descriptor.path));
  const candidates = candidateThresholds(values).map((threshold) => scoreThreshold(rows, descriptor, threshold));
  candidates.sort((a, b) => {
    const primary = b.balancedAccuracy - a.balancedAccuracy;
    if (Math.abs(primary) > 1e-12) return primary;
    return descriptor.direction === "min" ? b.threshold - a.threshold : a.threshold - b.threshold;
  });
  return candidates[0] ?? null;
}

function calibrationRowEligible(row, cohortId) {
  return row
    && row.calibrationRole === "PROMOTION_POLICY_CALIBRATION"
    && row.cohortId === cohortId
    && row.frozenBeforeOutcome === true
    && row.usedForCandidateTuning !== true
    && (row.outcome === "PASS" || row.outcome === "FAIL");
}

export function calibrateEmpiricalPromotionPolicy(records = [], {
  cohortId,
  minimumPositiveStrategies,
  minimumNegativeStrategies,
} = {}) {
  if (typeof cohortId !== "string" || cohortId.trim().length === 0) throw new TypeError("cohortId is required");
  if (!Number.isInteger(minimumPositiveStrategies) || minimumPositiveStrategies < 1) {
    throw new TypeError("minimumPositiveStrategies must be a positive integer");
  }
  if (!Number.isInteger(minimumNegativeStrategies) || minimumNegativeStrategies < 1) {
    throw new TypeError("minimumNegativeStrategies must be a positive integer");
  }

  const eligible = (Array.isArray(records) ? records : []).filter((row) => calibrationRowEligible(row, cohortId));
  const positives = eligible.filter((row) => row.outcome === "PASS").length;
  const negatives = eligible.filter((row) => row.outcome === "FAIL").length;
  const blockers = [];
  if (positives < minimumPositiveStrategies) blockers.push("calibration:positive_strategy_sample_insufficient");
  if (negatives < minimumNegativeStrategies) blockers.push("calibration:negative_strategy_sample_insufficient");

  const diagnostics = {};
  const policyValues = {};
  if (blockers.length === 0) {
    for (const descriptor of METRICS) {
      const metricRows = eligible.filter((row) => finite(atPath(row, descriptor.path)));
      const metricPositives = metricRows.filter((row) => row.outcome === "PASS").length;
      const metricNegatives = metricRows.filter((row) => row.outcome === "FAIL").length;
      if (metricPositives < minimumPositiveStrategies || metricNegatives < minimumNegativeStrategies) {
        blockers.push(`calibration:${descriptor.key}_sample_insufficient`);
        continue;
      }
      const selected = chooseThreshold(metricRows, descriptor);
      if (!selected || !finite(selected.threshold)) {
        blockers.push(`calibration:${descriptor.key}_threshold_unavailable`);
        continue;
      }
      policyValues[descriptor.key] = selected.threshold;
      diagnostics[descriptor.key] = Object.freeze({
        metricPath: descriptor.path.join("."),
        direction: descriptor.direction,
        sampleCount: metricRows.length,
        ...selected,
      });
    }
  }

  const status = blockers.length === 0 ? "empirically_calibrated" : "not_calibrated";
  return Object.freeze({
    schemaVersion: EMPIRICAL_PROMOTION_POLICY_SCHEMA_VERSION,
    status,
    cohortId,
    calibrationRole: "PROMOTION_POLICY_CALIBRATION",
    calibrationSampleCount: eligible.length,
    positiveStrategies: positives,
    negativeStrategies: negatives,
    blockers: Object.freeze([...new Set(blockers)]),
    diagnostics: Object.freeze(diagnostics),
    ...(status === "empirically_calibrated" ? policyValues : {}),
    safety: Object.freeze({
      currentCandidateForwardEvidenceUsed: false,
      finalHoldoutUsedForCurrentCandidateTuning: false,
      liveTradingAllowed: false,
      orderAuthority: false,
    }),
  });
}

export const EMPIRICAL_PROMOTION_METRICS = METRICS;

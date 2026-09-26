export const STRATEGY_LIFECYCLE_SCHEMA_VERSION = 1;

const LIFECYCLE_METRICS = Object.freeze([
  Object.freeze({ key: "minExpectancyRatio", field: "expectancyRatio", direction: "min" }),
  Object.freeze({ key: "minProfitFactorRatio", field: "profitFactorRatio", direction: "min" }),
  Object.freeze({ key: "maxDrawdownRatio", field: "drawdownRatio", direction: "max" }),
  Object.freeze({ key: "minDirectionalQualityRatio", field: "directionalQualityRatio", direction: "min" }),
  Object.freeze({ key: "maxKsStatistic", field: "ksStatistic", direction: "max" }),
  Object.freeze({ key: "minConsecutiveDegradedWindowsForRetire", field: "degradedRunLength", direction: "max", reverseMeaning: true }),
]);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function thresholdCandidates(values) {
  const unique = [...new Set(values.filter(finite))].sort((a, b) => a - b);
  if (unique.length < 2) return unique;
  const out = [unique[0], unique[unique.length - 1]];
  for (let i = 0; i < unique.length - 1; i += 1) out.push((unique[i] + unique[i + 1]) / 2);
  return [...new Set(out)].sort((a, b) => a - b);
}

function predictsHealthy(value, threshold, descriptor) {
  if (descriptor.reverseMeaning) return value < threshold;
  return descriptor.direction === "min" ? value >= threshold : value <= threshold;
}

function bestThreshold(rows, descriptor) {
  const candidates = thresholdCandidates(rows.map((row) => row[descriptor.field]));
  let best = null;
  for (const threshold of candidates) {
    let tp = 0; let tn = 0; let fp = 0; let fn = 0;
    for (const row of rows) {
      const healthy = row.outcome === "HEALTHY";
      const predicted = predictsHealthy(row[descriptor.field], threshold, descriptor);
      if (healthy && predicted) tp += 1;
      else if (healthy) fn += 1;
      else if (predicted) fp += 1;
      else tn += 1;
    }
    const tpr = tp + fn ? tp / (tp + fn) : 0;
    const tnr = tn + fp ? tn / (tn + fp) : 0;
    const score = (tpr + tnr) / 2;
    const candidate = { threshold, balancedAccuracy: score, tpr, tnr };
    if (!best || score > best.balancedAccuracy + 1e-12) best = candidate;
    else if (Math.abs(score - best.balancedAccuracy) <= 1e-12) {
      const conservativeWins = descriptor.direction === "min" && !descriptor.reverseMeaning
        ? threshold > best.threshold
        : threshold < best.threshold;
      if (conservativeWins) best = candidate;
    }
  }
  return best;
}

export function calibrateEmpiricalLifecyclePolicy(episodes = [], {
  cohortId,
  minimumHealthyEpisodes,
  minimumDegradedEpisodes,
  minimumRecentReturnSamples,
} = {}) {
  if (typeof cohortId !== "string" || !cohortId.trim()) throw new TypeError("cohortId is required");
  for (const [key, value] of Object.entries({ minimumHealthyEpisodes, minimumDegradedEpisodes, minimumRecentReturnSamples })) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`${key} must be a positive integer`);
  }
  const eligible = (Array.isArray(episodes) ? episodes : []).filter((row) =>
    row?.cohortId === cohortId
    && row?.calibrationRole === "LIFECYCLE_POLICY_CALIBRATION"
    && row?.frozenBeforeOutcome === true
    && row?.usedForCandidateTuning !== true
    && (row?.outcome === "HEALTHY" || row?.outcome === "DEGRADED"));
  const healthy = eligible.filter((row) => row.outcome === "HEALTHY").length;
  const degraded = eligible.filter((row) => row.outcome === "DEGRADED").length;
  const blockers = [];
  if (healthy < minimumHealthyEpisodes) blockers.push("lifecycle_calibration:healthy_sample_insufficient");
  if (degraded < minimumDegradedEpisodes) blockers.push("lifecycle_calibration:degraded_sample_insufficient");
  const values = {};
  const diagnostics = {};
  if (blockers.length === 0) {
    for (const descriptor of LIFECYCLE_METRICS) {
      const rows = eligible.filter((row) => finite(row[descriptor.field]));
      if (rows.filter((row) => row.outcome === "HEALTHY").length < minimumHealthyEpisodes
        || rows.filter((row) => row.outcome === "DEGRADED").length < minimumDegradedEpisodes) {
        blockers.push(`lifecycle_calibration:${descriptor.key}_sample_insufficient`);
        continue;
      }
      const selected = bestThreshold(rows, descriptor);
      if (!selected) {
        blockers.push(`lifecycle_calibration:${descriptor.key}_threshold_unavailable`);
        continue;
      }
      values[descriptor.key] = selected.threshold;
      diagnostics[descriptor.key] = Object.freeze({ field: descriptor.field, ...selected });
    }
  }
  const status = blockers.length ? "not_calibrated" : "empirically_calibrated";
  return Object.freeze({
    schemaVersion: STRATEGY_LIFECYCLE_SCHEMA_VERSION,
    status,
    cohortId,
    minimumRecentReturnSamples,
    healthyEpisodes: healthy,
    degradedEpisodes: degraded,
    blockers: Object.freeze([...new Set(blockers)]),
    diagnostics: Object.freeze(diagnostics),
    ...(status === "empirically_calibrated" ? values : {}),
  });
}

function safeRatio(current, baseline, { drawdown = false } = {}) {
  if (!finite(current) || !finite(baseline)) return null;
  const denominator = Math.abs(baseline);
  if (denominator <= 1e-12) {
    if (drawdown) return current <= 1e-12 ? 1 : Number.POSITIVE_INFINITY;
    return current > 0 ? Number.POSITIVE_INFINITY : current < 0 ? Number.NEGATIVE_INFINITY : 1;
  }
  return drawdown ? Math.abs(current) / denominator : current / baseline;
}

export function twoSampleKsStatistic(left = [], right = []) {
  const a = left.filter(finite).sort((x, y) => x - y);
  const b = right.filter(finite).sort((x, y) => x - y);
  if (a.length === 0 || b.length === 0) return null;
  const values = [...new Set([...a, ...b])].sort((x, y) => x - y);
  let i = 0; let j = 0; let max = 0;
  for (const value of values) {
    while (i < a.length && a[i] <= value) i += 1;
    while (j < b.length && b[j] <= value) j += 1;
    max = Math.max(max, Math.abs(i / a.length - j / b.length));
  }
  return max;
}

function mean(values) {
  const filtered = values.filter(finite);
  return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : null;
}

export function evaluateStrategyLifecycle({
  strategyFingerprint,
  baseline = {},
  current = {},
  baselineReturnSamples = [],
  recentReturnSamples = [],
  consecutiveDegradedWindows = 0,
  previousState = "CHAMPION",
  policy,
} = {}) {
  if (typeof strategyFingerprint !== "string" || !strategyFingerprint) throw new TypeError("strategyFingerprint is required");
  const reasons = [];
  if (!policy || policy.status !== "empirically_calibrated") {
    reasons.push("lifecycle:policy_not_empirically_calibrated");
    return Object.freeze({
      schemaVersion: STRATEGY_LIFECYCLE_SCHEMA_VERSION,
      strategyFingerprint,
      state: "WATCH",
      action: "NO_AUTOMATIC_CHANGE",
      reasons: Object.freeze(reasons),
      safety: Object.freeze({ liveTradingAllowed: false, orderAuthority: false, capitalMutationAllowed: false }),
    });
  }

  if (recentReturnSamples.filter(finite).length < policy.minimumRecentReturnSamples) {
    reasons.push("lifecycle:recent_return_sample_insufficient");
  }

  const expectancyRatio = safeRatio(current.paperExpectancy, baseline.paperExpectancy);
  const profitFactorRatio = safeRatio(current.paperProfitFactor, baseline.paperProfitFactor);
  const drawdownRatio = safeRatio(current.paperMaximumDrawdown, baseline.paperMaximumDrawdown, { drawdown: true });
  const directionalQualityRatio = safeRatio(current.shadowDirectionalQuality, baseline.shadowDirectionalQuality);
  const ksStatistic = twoSampleKsStatistic(baselineReturnSamples, recentReturnSamples);
  const baselineMean = mean(baselineReturnSamples);
  const recentMean = mean(recentReturnSamples);

  const metrics = Object.freeze({
    expectancyRatio,
    profitFactorRatio,
    drawdownRatio,
    directionalQualityRatio,
    ksStatistic,
    baselineMean,
    recentMean,
    consecutiveDegradedWindows,
  });

  if (!finite(expectancyRatio) || expectancyRatio < policy.minExpectancyRatio) reasons.push("lifecycle:expectancy_decay");
  if (!finite(profitFactorRatio) || profitFactorRatio < policy.minProfitFactorRatio) reasons.push("lifecycle:profit_factor_decay");
  if (!finite(drawdownRatio) || drawdownRatio > policy.maxDrawdownRatio) reasons.push("lifecycle:drawdown_expansion");
  if (!finite(directionalQualityRatio) || directionalQualityRatio < policy.minDirectionalQualityRatio) reasons.push("lifecycle:directional_quality_decay");
  if (!finite(ksStatistic)) reasons.push("lifecycle:structural_break_evidence_missing");
  else if (ksStatistic > policy.maxKsStatistic && finite(recentMean) && finite(baselineMean) && recentMean < baselineMean) {
    reasons.push("lifecycle:adverse_structural_break");
  }
  if (current.neutralCollapse === true) reasons.push("lifecycle:neutral_collapse_reappeared");
  if (current.lineageValid !== true) reasons.push("lifecycle:lineage_invalid");

  const performanceReasons = reasons.filter((reason) =>
    reason.includes("decay") || reason.includes("expansion") || reason.includes("structural_break") || reason.includes("neutral_collapse"));
  let state = "CHAMPION";
  let action = "KEEP_CHAMPION";
  if (performanceReasons.length > 0 || current.lineageValid !== true) {
    state = "WATCH";
    action = "DEMOTE_TO_WATCH";
    if (previousState === "WATCH"
      && finite(policy.minConsecutiveDegradedWindowsForRetire)
      && consecutiveDegradedWindows >= policy.minConsecutiveDegradedWindowsForRetire) {
      state = "RETIRE_REVIEW";
      action = "RETIRE_REVIEW_REQUIRED";
    }
  } else if (reasons.length > 0) {
    state = "WATCH";
    action = "NO_AUTOMATIC_CHANGE";
  }

  return Object.freeze({
    schemaVersion: STRATEGY_LIFECYCLE_SCHEMA_VERSION,
    strategyFingerprint,
    previousState,
    state,
    action,
    reasons: Object.freeze([...new Set(reasons)]),
    metrics,
    policyCohortId: policy.cohortId ?? null,
    safety: Object.freeze({
      liveTradingAllowed: false,
      orderAuthority: false,
      automaticReplacementAllowed: false,
      capitalMutationAllowed: false,
    }),
  });
}

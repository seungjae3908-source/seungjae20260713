export const CAPACITY_IMPACT_SCHEMA_VERSION = 1;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function bucketCount(values, buckets) {
  if (!values.length) return 0;
  const min = Math.min(...values); const max = Math.max(...values);
  if (Math.abs(max - min) <= 1e-12) return 1;
  const occupied = new Set();
  for (const value of values) {
    const normalized = (value - min) / (max - min);
    occupied.add(Math.min(buckets - 1, Math.floor(normalized * buckets)));
  }
  return occupied.size;
}

function fitSqrtImpact(rows) {
  const x = rows.map((row) => Math.sqrt(row.participationRate));
  const y = rows.map((row) => row.implementationShortfallBps);
  const mx = mean(x); const my = mean(y);
  const denominator = x.reduce((sum, value) => sum + (value - mx) ** 2, 0);
  if (!(denominator > 0)) return null;
  const slope = x.reduce((sum, value, index) => sum + (value - mx) * (y[index] - my), 0) / denominator;
  const intercept = my - slope * mx;
  const fitted = x.map((value) => intercept + slope * value);
  const sst = y.reduce((sum, value) => sum + (value - my) ** 2, 0);
  const sse = y.reduce((sum, value, index) => sum + (value - fitted[index]) ** 2, 0);
  const rSquared = sst > 0 ? 1 - sse / sst : 1;
  return { intercept, slope, rSquared };
}

export function estimateEmpiricalExecutionCapacity({
  observations = [],
  expectedNetEdgeBps,
  advNotional,
  policy,
} = {}) {
  if (!policy || policy.status !== "empirically_calibrated") {
    return Object.freeze({
      schemaVersion: CAPACITY_IMPACT_SCHEMA_VERSION,
      status: "NOT_READY",
      blockers: Object.freeze(["capacity:policy_not_empirically_calibrated"]),
      permanentImpactAvailable: false,
      orderAuthority: false,
    });
  }
  for (const key of ["minimumRealExecutions", "minimumParticipationBuckets", "participationBucketCount", "edgeSafetyMarginBps", "minimumRSquared"]) {
    if (!finite(policy[key])) throw new TypeError(`policy.${key} is required`);
  }
  if (!finite(expectedNetEdgeBps) || !finite(advNotional) || !(advNotional > 0)) throw new TypeError("expectedNetEdgeBps and positive advNotional are required");

  const eligible = (Array.isArray(observations) ? observations : []).filter((row) =>
    row?.realExecutionObserved === true
    && row?.preOrderSnapshotFrozen === true
    && row?.postTradeMeasurementComplete === true
    && finite(row?.participationRate)
    && row.participationRate > 0
    && row.participationRate <= 1
    && finite(row?.implementationShortfallBps)
    && row?.usedForModelTuning !== true);

  const blockers = [];
  if (eligible.length < policy.minimumRealExecutions) blockers.push("capacity:real_execution_sample_insufficient");
  const buckets = bucketCount(eligible.map((row) => row.participationRate), policy.participationBucketCount);
  if (buckets < policy.minimumParticipationBuckets) blockers.push("capacity:participation_coverage_insufficient");

  const fit = blockers.length ? null : fitSqrtImpact(eligible);
  if (!fit) blockers.push("capacity:impact_fit_unavailable");
  else {
    if (!(fit.slope >= 0)) blockers.push("capacity:non_monotonic_empirical_impact");
    if (!(fit.rSquared >= policy.minimumRSquared)) blockers.push("capacity:impact_fit_quality_insufficient");
  }

  if (blockers.length) {
    return Object.freeze({
      schemaVersion: CAPACITY_IMPACT_SCHEMA_VERSION,
      status: "NOT_READY",
      blockers: Object.freeze([...new Set(blockers)]),
      eligibleRealExecutions: eligible.length,
      participationBuckets: buckets,
      permanentImpactAvailable: false,
      orderAuthority: false,
      liveTradingAllowed: false,
    });
  }

  const availableEdge = expectedNetEdgeBps - policy.edgeSafetyMarginBps - fit.intercept;
  let maxParticipationRate = 0;
  if (availableEdge > 0) {
    if (fit.slope <= 1e-12) maxParticipationRate = Math.max(...eligible.map((row) => row.participationRate));
    else maxParticipationRate = Math.min(1, Math.max(0, (availableEdge / fit.slope) ** 2));
  }
  const observedMaxParticipation = Math.max(...eligible.map((row) => row.participationRate));
  maxParticipationRate = Math.min(maxParticipationRate, observedMaxParticipation);
  const maxNotional = advNotional * maxParticipationRate;

  return Object.freeze({
    schemaVersion: CAPACITY_IMPACT_SCHEMA_VERSION,
    status: maxParticipationRate > 0 ? "CAPACITY_REVIEW_READY" : "NO_POSITIVE_CAPACITY",
    blockers: Object.freeze([]),
    eligibleRealExecutions: eligible.length,
    participationBuckets: buckets,
    model: Object.freeze({
      form: "implementationShortfallBps = intercept + slope * sqrt(participationRate)",
      interceptBps: fit.intercept,
      slopeBps: fit.slope,
      rSquared: fit.rSquared,
      extrapolationAllowed: false,
    }),
    expectedNetEdgeBps,
    edgeSafetyMarginBps: policy.edgeSafetyMarginBps,
    maxParticipationRate,
    maxNotional,
    advNotional,
    permanentImpactAvailable: true,
    safety: Object.freeze({
      researchCapacityOnly: true,
      liveTradingAllowed: false,
      orderAuthority: false,
      automaticSizeMutationAllowed: false,
    }),
  });
}

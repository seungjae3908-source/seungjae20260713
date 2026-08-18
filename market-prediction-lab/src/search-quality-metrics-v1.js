function freeze(value) { return Object.freeze(value); }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function ratio(numerator, denominator) { return denominator > 0 ? numerator / denominator : null; }
function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function direction(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized === "LONG" || normalized === "BUY" ? "LONG" : normalized === "SHORT" ? "SHORT" : "UNSPECIFIED";
}
function directionalReturn(row) {
  if (!finite(row?.returnPct)) return null;
  return direction(row.direction) === "SHORT" ? -row.returnPct : row.returnPct;
}
function key(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }

function summarize(signals, opportunities) {
  const settled = signals.filter((row) => typeof row?.hit === "boolean");
  const hits = settled.filter((row) => row.hit === true);
  const opportunityIds = new Set(opportunities.map((row) => key(row?.opportunityId)).filter(Boolean));
  const matchedOpportunityIds = new Set(hits.map((row) => key(row?.matchedOpportunityId ?? row?.opportunityId)).filter((id) => id && opportunityIds.has(id)));
  const returns = settled.map(directionalReturn).filter(finite);
  const mfe = settled.map((row) => row?.mfePct).filter(finite);
  const mae = settled.map((row) => row?.maePct).filter(finite);
  const lead = hits.map((row) => row?.leadTimeMs).filter(finite);

  return freeze({
    signalCount: signals.length,
    settledSignalCount: settled.length,
    hitCount: hits.length,
    falsePositiveCount: settled.length - hits.length,
    groundTruthOpportunityCount: opportunityIds.size,
    matchedOpportunityCount: matchedOpportunityIds.size,
    falseNegativeCount: opportunityIds.size ? Math.max(0, opportunityIds.size - matchedOpportunityIds.size) : null,
    precision: ratio(hits.length, settled.length),
    recall: ratio(matchedOpportunityIds.size, opportunityIds.size),
    averageDirectionalReturnPct: average(returns),
    medianDirectionalReturnPct: median(returns),
    averageMfePct: average(mfe),
    averageMaePct: average(mae),
    averageLeadTimeMs: average(lead),
  });
}

export function computeSearchQualityMetrics({ settledSignals = [], groundTruthOpportunities = [] } = {}) {
  if (!Array.isArray(settledSignals) || !Array.isArray(groundTruthOpportunities)) throw new TypeError("arrays are required");
  const horizonKeys = [...new Set([
    ...settledSignals.map((row) => key(row?.horizonKey)).filter(Boolean),
    ...groundTruthOpportunities.map((row) => key(row?.horizonKey)).filter(Boolean),
  ])].sort();
  const byHorizon = Object.fromEntries(horizonKeys.map((horizonKey) => [
    horizonKey,
    summarize(
      settledSignals.filter((row) => key(row?.horizonKey) === horizonKey),
      groundTruthOpportunities.filter((row) => key(row?.horizonKey) === horizonKey),
    ),
  ]));

  return freeze({
    schemaVersion: "search-quality-metrics-v1",
    overall: summarize(settledSignals, groundTruthOpportunities),
    byHorizon: freeze(byHorizon),
    missingDenominatorsRemainNull: true,
    searchQualityIsNotProfitabilityProof: true,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  });
}

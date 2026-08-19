export const MULTIPLE_TESTING_REALITY_CHECK_SCHEMA_VERSION = 1;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function lcg(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function circularBlockIndices(n, blockLength, random) {
  const indices = [];
  while (indices.length < n) {
    const start = Math.floor(random() * n);
    for (let offset = 0; offset < blockLength && indices.length < n; offset += 1) {
      indices.push((start + offset) % n);
    }
  }
  return indices;
}

function validateSeries(strategyReturns, benchmarkReturns) {
  const entries = Object.entries(strategyReturns ?? {});
  if (!entries.length) throw new TypeError("strategyReturns must contain at least one strategy");
  const n = entries[0][1]?.length ?? 0;
  if (n < 2) throw new TypeError("strategy return series must have at least two observations");
  for (const [id, values] of entries) {
    if (!Array.isArray(values) || values.length !== n || values.some((value) => !finite(value))) {
      throw new TypeError(`strategy ${id} must have aligned finite returns`);
    }
  }
  const benchmark = benchmarkReturns == null
    ? Array(n).fill(0)
    : benchmarkReturns;
  if (!Array.isArray(benchmark) || benchmark.length !== n || benchmark.some((value) => !finite(value))) {
    throw new TypeError("benchmarkReturns must be aligned finite returns");
  }
  return { entries, benchmark, n };
}

function pValue(samples, observed) {
  const count = samples.filter((value) => value >= observed - 1e-15).length;
  return (count + 1) / (samples.length + 1);
}

export function evaluateRealityCheckAndSpa({
  strategyReturns,
  benchmarkReturns = null,
  policy,
} = {}) {
  if (!policy || policy.status !== "empirically_calibrated") {
    return Object.freeze({
      schemaVersion: MULTIPLE_TESTING_REALITY_CHECK_SCHEMA_VERSION,
      status: "RESEARCH_HOLD",
      reason: "multiple_testing_policy_not_empirically_calibrated",
      safety: Object.freeze({ promotionAuthority: false, liveTradingAllowed: false, orderAuthority: false }),
    });
  }
  for (const key of ["bootstrapIterations", "blockLength", "seed", "alpha"]) {
    if (!finite(policy[key])) throw new TypeError(`policy.${key} is required`);
  }
  if (!Number.isInteger(policy.bootstrapIterations) || policy.bootstrapIterations < 200) throw new RangeError("bootstrapIterations must be >= 200");
  if (!Number.isInteger(policy.blockLength) || policy.blockLength < 1) throw new RangeError("blockLength must be a positive integer");
  if (!Number.isInteger(policy.seed)) throw new RangeError("seed must be an integer");
  if (!(policy.alpha > 0 && policy.alpha < 0.5)) throw new RangeError("alpha must be in (0,0.5)");

  const { entries, benchmark, n } = validateSeries(strategyReturns, benchmarkReturns);
  if (policy.blockLength > n) throw new RangeError("blockLength cannot exceed sample length");

  const excess = Object.fromEntries(entries.map(([id, values]) => [
    id,
    values.map((value, index) => value - benchmark[index]),
  ]));
  const observed = Object.fromEntries(Object.entries(excess).map(([id, values]) => {
    const m = mean(values);
    const sd = sampleStdev(values);
    const t = sd > 0 ? Math.sqrt(n) * m / sd : m > 0 ? Number.POSITIVE_INFINITY : 0;
    return [id, Object.freeze({ meanExcessReturn: m, stdev: sd, tStatistic: t })];
  }));

  const observedRealityStatistic = Math.max(0, ...Object.values(observed).map((row) => Math.sqrt(n) * row.meanExcessReturn));
  const observedSpaStatistic = Math.max(0, ...Object.values(observed).map((row) => row.tStatistic));

  const centered = Object.fromEntries(Object.entries(excess).map(([id, values]) => {
    const m = mean(values);
    return [id, values.map((value) => value - m)];
  }));

  const logLog = Math.log(Math.max(Math.log(Math.max(n, 3)), 1));
  const spaRecentering = Object.fromEntries(Object.entries(observed).map(([id, row]) => {
    const cutoffT = -Math.sqrt(2 * logLog);
    return [id, row.tStatistic < cutoffT ? row.meanExcessReturn : 0];
  }));

  const random = lcg(policy.seed);
  const rcBootstrap = [];
  const spaBootstrap = [];
  for (let iteration = 0; iteration < policy.bootstrapIterations; iteration += 1) {
    const indices = circularBlockIndices(n, policy.blockLength, random);
    let rcMax = 0;
    let spaMax = 0;
    for (const [id, values] of Object.entries(excess)) {
      const centeredValues = centered[id];
      const rcMean = mean(indices.map((index) => centeredValues[index]));
      rcMax = Math.max(rcMax, Math.sqrt(n) * rcMean);

      const recenteredSpa = indices.map((index) => centeredValues[index] + spaRecentering[id]);
      const spaMean = mean(recenteredSpa);
      const spaSd = sampleStdev(recenteredSpa);
      const spaT = spaSd > 0 ? Math.sqrt(n) * spaMean / spaSd : spaMean > 0 ? Number.POSITIVE_INFINITY : 0;
      spaMax = Math.max(spaMax, spaT);
    }
    rcBootstrap.push(Math.max(0, rcMax));
    spaBootstrap.push(Math.max(0, spaMax));
  }

  const realityCheckPValue = pValue(rcBootstrap, observedRealityStatistic);
  const spaPValue = pValue(spaBootstrap, observedSpaStatistic);
  const selected = Object.entries(observed)
    .sort(([, a], [, b]) => b.meanExcessReturn - a.meanExcessReturn)[0];

  return Object.freeze({
    schemaVersion: MULTIPLE_TESTING_REALITY_CHECK_SCHEMA_VERSION,
    status: "EVIDENCE_READY",
    sampleCount: n,
    strategyCount: entries.length,
    benchmarkProvided: benchmarkReturns != null,
    selectedStrategyFingerprint: selected?.[0] ?? null,
    observed: Object.freeze(observed),
    realityCheck: Object.freeze({
      statistic: observedRealityStatistic,
      pValue: realityCheckPValue,
      rejectsNoSuperiorStrategyNull: realityCheckPValue <= policy.alpha,
    }),
    spa: Object.freeze({
      statistic: observedSpaStatistic,
      pValue: spaPValue,
      rejectsNoSuperiorStrategyNull: spaPValue <= policy.alpha,
      recentering: "HANSEN_STYLE_DATA_DEPENDENT",
    }),
    policy: Object.freeze({
      alpha: policy.alpha,
      bootstrapIterations: policy.bootstrapIterations,
      blockLength: policy.blockLength,
      seed: policy.seed,
    }),
    safety: Object.freeze({
      promotionAuthority: false,
      liveTradingAllowed: false,
      orderAuthority: false,
      evidenceOnly: true,
    }),
  });
}

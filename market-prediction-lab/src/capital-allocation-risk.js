export const CAPITAL_ALLOCATION_RISK_SCHEMA_VERSION = 1;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function mean(values) {
  const rows = values.filter(finite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function stdev(values) {
  const rows = values.filter(finite);
  if (rows.length < 2) return null;
  const m = mean(rows);
  return Math.sqrt(rows.reduce((sum, value) => sum + (value - m) ** 2, 0) / (rows.length - 1));
}

function expectedShortfallLoss(values, alpha) {
  const losses = values.filter(finite).map((value) => Math.max(0, -value)).sort((a, b) => b - a);
  if (losses.length === 0) return null;
  const count = Math.max(1, Math.ceil(losses.length * alpha));
  return mean(losses.slice(0, count));
}

function correlation(left, right) {
  const pairs = [];
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i += 1) if (finite(left[i]) && finite(right[i])) pairs.push([left[i], right[i]]);
  if (pairs.length < 3) return null;
  const a = pairs.map(([x]) => x); const b = pairs.map(([, y]) => y);
  const ma = mean(a); const mb = mean(b);
  const sa = stdev(a); const sb = stdev(b);
  if (!(sa > 0) || !(sb > 0)) return 0;
  return pairs.reduce((sum, [x, y]) => sum + (x - ma) * (y - mb), 0) / ((pairs.length - 1) * sa * sb);
}

function capWeights(rawWeights, maxWeight) {
  const entries = Object.entries(rawWeights);
  const weights = Object.fromEntries(entries.map(([key]) => [key, 0]));
  let remaining = 1;
  let active = new Set(entries.map(([key]) => key));
  let guard = 0;
  while (remaining > 1e-12 && active.size && guard < 100) {
    guard += 1;
    const scoreSum = [...active].reduce((sum, key) => sum + Math.max(0, rawWeights[key]), 0);
    if (!(scoreSum > 0)) break;
    let consumed = 0;
    for (const key of [...active]) {
      const proposed = remaining * Math.max(0, rawWeights[key]) / scoreSum;
      const room = maxWeight - weights[key];
      const add = Math.max(0, Math.min(room, proposed));
      weights[key] += add;
      consumed += add;
      if (maxWeight - weights[key] <= 1e-12) active.delete(key);
    }
    if (!(consumed > 1e-12)) break;
    remaining -= consumed;
  }
  return weights;
}

function lcg(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function alignedPortfolioReturns(strategies, weights) {
  const minLength = Math.min(...strategies.map((strategy) => strategy.netReturnSamples?.length ?? 0));
  if (!Number.isFinite(minLength) || minLength <= 0) return [];
  const rows = [];
  for (let index = 0; index < minLength; index += 1) {
    let value = 0;
    let valid = true;
    for (const strategy of strategies) {
      const sample = strategy.netReturnSamples[index];
      if (!finite(sample)) { valid = false; break; }
      value += (weights[strategy.strategyFingerprint] ?? 0) * sample;
    }
    if (valid) rows.push(value);
  }
  return rows;
}

function simulateRuinProbability(returns, exposure, {
  paths, horizon, ruinThreshold, blockLength, seed,
}) {
  if (returns.length < blockLength) return null;
  const random = lcg(seed);
  let ruined = 0;
  for (let path = 0; path < paths; path += 1) {
    let wealth = 1;
    let produced = 0;
    while (produced < horizon) {
      const start = Math.floor(random() * returns.length);
      for (let offset = 0; offset < blockLength && produced < horizon; offset += 1) {
        const r = returns[(start + offset) % returns.length] * exposure;
        wealth *= Math.max(0, 1 + r);
        produced += 1;
        if (wealth <= ruinThreshold) {
          ruined += 1;
          produced = horizon;
          break;
        }
      }
    }
  }
  return ruined / paths;
}

function findSafeExposure(returns, policy) {
  let low = 0; let high = 1;
  const full = simulateRuinProbability(returns, 1, policy);
  if (full == null) return { exposure: 0, ruinProbability: null };
  if (full <= policy.maxRuinProbability) return { exposure: 1, ruinProbability: full };
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const mid = (low + high) / 2;
    const probability = simulateRuinProbability(returns, mid, policy);
    if (probability != null && probability <= policy.maxRuinProbability) low = mid;
    else high = mid;
  }
  return {
    exposure: low,
    ruinProbability: simulateRuinProbability(returns, low, policy),
  };
}

export function evaluateResearchCapitalAllocation({
  strategies = [],
  policy,
} = {}) {
  if (!policy || policy.status !== "empirically_calibrated") {
    return Object.freeze({
      schemaVersion: CAPITAL_ALLOCATION_RISK_SCHEMA_VERSION,
      status: "RESEARCH_HOLD",
      reason: "capital_policy_not_empirically_calibrated",
      weights: Object.freeze({}),
      cashWeight: 1,
      safety: Object.freeze({ capitalMutationAllowed: false, orderAuthority: false, liveTradingAllowed: false }),
    });
  }
  const required = ["maxStrategyWeight", "expectedShortfallAlpha", "maxRuinProbability", "ruinThreshold", "paths", "horizon", "blockLength", "seed"];
  for (const key of required) if (!finite(policy[key])) throw new TypeError(`policy.${key} is required`);
  if (!(policy.maxStrategyWeight > 0 && policy.maxStrategyWeight <= 1)) throw new RangeError("maxStrategyWeight must be in (0,1]");
  if (!(policy.expectedShortfallAlpha > 0 && policy.expectedShortfallAlpha < 0.5)) throw new RangeError("expectedShortfallAlpha must be in (0,0.5)");
  if (!(policy.maxRuinProbability >= 0 && policy.maxRuinProbability < 1)) throw new RangeError("maxRuinProbability must be in [0,1)");
  if (!(policy.ruinThreshold > 0 && policy.ruinThreshold < 1)) throw new RangeError("ruinThreshold must be in (0,1)");

  const eligible = (Array.isArray(strategies) ? strategies : []).filter((strategy) =>
    typeof strategy?.strategyFingerprint === "string"
    && strategy?.promotionAssessment?.status === "PROMOTION_REVIEW_READY"
    && !["RETIRE_REVIEW"].includes(strategy?.lifecycleAssessment?.state)
    && Array.isArray(strategy?.netReturnSamples)
    && strategy.netReturnSamples.filter(finite).length >= policy.blockLength);

  if (eligible.length === 0) {
    return Object.freeze({
      schemaVersion: CAPITAL_ALLOCATION_RISK_SCHEMA_VERSION,
      status: "RESEARCH_HOLD",
      reason: "no_eligible_promoted_strategy",
      weights: Object.freeze({}),
      cashWeight: 1,
      safety: Object.freeze({ capitalMutationAllowed: false, orderAuthority: false, liveTradingAllowed: false }),
    });
  }

  const stats = {};
  for (const strategy of eligible) {
    const samples = strategy.netReturnSamples.filter(finite);
    const expected = mean(samples);
    const es = expectedShortfallLoss(samples, policy.expectedShortfallAlpha);
    const positiveCorrelations = eligible
      .filter((other) => other !== strategy)
      .map((other) => correlation(samples, other.netReturnSamples ?? []))
      .filter((value) => finite(value) && value > 0);
    const correlationPenalty = 1 + (positiveCorrelations.length ? mean(positiveCorrelations) : 0);
    const score = expected > 0 && finite(es) ? expected / Math.max(es, 1e-12) / correlationPenalty : 0;
    stats[strategy.strategyFingerprint] = Object.freeze({
      expectedReturn: expected,
      expectedShortfallLoss: es,
      positiveCorrelationPenalty: correlationPenalty,
      rawScore: score,
      sampleCount: samples.length,
    });
  }

  const rawScoreSum = Object.values(stats).reduce((sum, row) => sum + Math.max(0, row.rawScore), 0);
  if (!(rawScoreSum > 0)) {
    return Object.freeze({
      schemaVersion: CAPITAL_ALLOCATION_RISK_SCHEMA_VERSION,
      status: "RESEARCH_HOLD",
      reason: "no_positive_risk_adjusted_edge",
      weights: Object.freeze({}),
      cashWeight: 1,
      stats: Object.freeze(stats),
      safety: Object.freeze({ capitalMutationAllowed: false, orderAuthority: false, liveTradingAllowed: false }),
    });
  }

  const rawWeights = Object.fromEntries(Object.entries(stats).map(([key, row]) => [key, row.rawScore / rawScoreSum]));
  const capped = capWeights(rawWeights, policy.maxStrategyWeight);
  const normalizedSum = Object.values(capped).reduce((sum, value) => sum + value, 0);
  const normalized = Object.fromEntries(Object.entries(capped).map(([key, value]) => [key, normalizedSum > 0 ? value / normalizedSum : 0]));
  const portfolioReturns = alignedPortfolioReturns(eligible, normalized);
  const safe = findSafeExposure(portfolioReturns, policy);
  const weights = Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, value * safe.exposure]));
  const cashWeight = Math.max(0, 1 - Object.values(weights).reduce((sum, value) => sum + value, 0));

  return Object.freeze({
    schemaVersion: CAPITAL_ALLOCATION_RISK_SCHEMA_VERSION,
    status: safe.ruinProbability == null ? "RESEARCH_HOLD" : "ALLOCATION_REVIEW_READY",
    reason: safe.ruinProbability == null ? "ruin_evidence_insufficient" : null,
    weights: Object.freeze(weights),
    cashWeight,
    grossExposure: safe.exposure,
    ruinProbability: safe.ruinProbability,
    ruinThreshold: policy.ruinThreshold,
    maxAllowedRuinProbability: policy.maxRuinProbability,
    stats: Object.freeze(stats),
    safety: Object.freeze({
      capitalMutationAllowed: false,
      orderAuthority: false,
      liveTradingAllowed: false,
      researchAllocationOnly: true,
    }),
  });
}

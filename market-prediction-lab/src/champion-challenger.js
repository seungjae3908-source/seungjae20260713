export const CHAMPION_CHALLENGER_SCHEMA_VERSION = 1;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function mean(values) {
  const rows = values.filter(finite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function lcg(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function quantile(values, q) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index); const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

export function pairedBootstrapSuperiority(championReturns = [], challengerReturns = [], {
  confidence,
  iterations,
  seed,
  blockLength,
} = {}) {
  if (!(confidence > 0.5 && confidence < 1)) throw new TypeError("confidence must be in (0.5,1)");
  if (!Number.isInteger(iterations) || iterations < 100) throw new TypeError("iterations must be an integer >= 100");
  if (!Number.isInteger(blockLength) || blockLength < 1) throw new TypeError("blockLength must be a positive integer");
  if (!Number.isInteger(seed)) throw new TypeError("seed must be an integer");
  const n = Math.min(championReturns.length, challengerReturns.length);
  const differences = [];
  for (let i = 0; i < n; i += 1) {
    if (finite(championReturns[i]) && finite(challengerReturns[i])) differences.push(challengerReturns[i] - championReturns[i]);
  }
  if (differences.length < blockLength) return Object.freeze({ status: "INSUFFICIENT_SAMPLE", sampleCount: differences.length });
  const random = lcg(seed);
  const boot = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = [];
    while (sample.length < differences.length) {
      const start = Math.floor(random() * differences.length);
      for (let offset = 0; offset < blockLength && sample.length < differences.length; offset += 1) {
        sample.push(differences[(start + offset) % differences.length]);
      }
    }
    boot.push(mean(sample));
  }
  const alpha = 1 - confidence;
  return Object.freeze({
    status: "READY",
    sampleCount: differences.length,
    observedMeanDifference: mean(differences),
    confidence,
    ciLower: quantile(boot, alpha / 2),
    ciUpper: quantile(boot, 1 - alpha / 2),
    iterations,
    blockLength,
    seed,
  });
}

export function evaluateChampionChallenger({
  champion,
  challengers = [],
  policy,
} = {}) {
  if (!champion || typeof champion.strategyFingerprint !== "string") throw new TypeError("champion strategyFingerprint is required");
  if (!policy || policy.status !== "empirically_calibrated") {
    return Object.freeze({
      schemaVersion: CHAMPION_CHALLENGER_SCHEMA_VERSION,
      status: "RESEARCH_HOLD",
      decision: "KEEP_CHAMPION",
      reason: "challenger_policy_not_empirically_calibrated",
      safety: Object.freeze({ automaticSwapAllowed: false, liveTradingAllowed: false, orderAuthority: false }),
    });
  }
  for (const key of ["minimumPairedSamples", "superiorityConfidence", "bootstrapIterations", "blockLength", "seed"]) {
    if (!finite(policy[key])) throw new TypeError(`policy.${key} is required`);
  }

  const evaluated = [];
  for (const challenger of Array.isArray(challengers) ? challengers : []) {
    const blockers = [];
    if (challenger?.promotionAssessment?.status !== "PROMOTION_REVIEW_READY") blockers.push("challenger_not_promotion_ready");
    if (challenger?.promotionAssessment?.strategyFingerprint !== challenger?.strategyFingerprint) blockers.push("challenger_identity_mismatch");
    const paired = pairedBootstrapSuperiority(champion.netReturnSamples ?? [], challenger.netReturnSamples ?? [], {
      confidence: policy.superiorityConfidence,
      iterations: policy.bootstrapIterations,
      seed: policy.seed,
      blockLength: policy.blockLength,
    });
    if (paired.status !== "READY" || paired.sampleCount < policy.minimumPairedSamples) blockers.push("paired_sample_insufficient");
    if (paired.status === "READY" && !(paired.ciLower > 0)) blockers.push("superiority_not_proven");
    evaluated.push(Object.freeze({
      strategyFingerprint: challenger.strategyFingerprint,
      blockers: Object.freeze(blockers),
      paired,
      promotionStatus: challenger?.promotionAssessment?.status ?? null,
    }));
  }

  const eligible = evaluated.filter((row) => row.blockers.length === 0)
    .sort((a, b) => (b.paired.ciLower - a.paired.ciLower)
      || (b.paired.observedMeanDifference - a.paired.observedMeanDifference)
      || a.strategyFingerprint.localeCompare(b.strategyFingerprint));
  const best = eligible[0] ?? null;
  const championDegraded = ["WATCH", "RETIRE_REVIEW"].includes(champion?.lifecycleAssessment?.state);
  const decision = best ? "SWAP_REVIEW_READY" : championDegraded ? "NO_ELIGIBLE_CHALLENGER" : "KEEP_CHAMPION";

  return Object.freeze({
    schemaVersion: CHAMPION_CHALLENGER_SCHEMA_VERSION,
    status: best ? "REVIEW_READY" : "RESEARCH_HOLD",
    decision,
    championFingerprint: champion.strategyFingerprint,
    championLifecycleState: champion?.lifecycleAssessment?.state ?? null,
    recommendedChallengerFingerprint: best?.strategyFingerprint ?? null,
    evaluated: Object.freeze(evaluated),
    safety: Object.freeze({
      automaticSwapAllowed: false,
      liveTradingAllowed: false,
      orderAuthority: false,
      humanOrPolicyReviewRequired: best !== null,
    }),
  });
}

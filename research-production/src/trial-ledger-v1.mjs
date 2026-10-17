// Cumulative multiple-testing ledger for the combination search.
//
// The lane runner already counts every trial of ONE experiment (one atom
// library + one symbol set) in its Benjamini-Hochberg denominator. Re-running
// the search on the same pre-2026 data after a library, exit-profile or
// universe change is a NEW experiment on the SAME data, and those earlier
// attempts are forgotten by a per-experiment correction. Over months that
// silently lets a lucky rule through.
//
// This ledger keeps, per data source, every experiment that ever searched it
// and how many trials it evaluated. The false-discovery correction then uses
// the cumulative count as its denominator (unseen earlier trials enter as
// p = 1, which is the conservative choice), and the one-time 2026 holdout has
// a fixed per-source budget that is never refilled.
//
// Research only: no orders, no account access, executionAuthority NONE.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const TRIAL_LEDGER_CONTRACT_V1 = 'combination-trial-ledger/v1';

export const TRIAL_LEDGER_POLICY_V1 = Object.freeze({
  // Survivors per data source that may ever spend the sealed 2026 check.
  // After that, only the live forward paper sample (2026-08-10 onward) can
  // validate a rule.
  holdoutChecksPerSource: 12,
});

function emptyLedger() {
  return { contract: TRIAL_LEDGER_CONTRACT_V1, sources: {}, holdoutUses: [] };
}

export function trialLedgerPathV1(root) {
  return join(root, 'combination-research', 'trial-ledger.json');
}

export async function readTrialLedgerV1(root) {
  try {
    const value = JSON.parse(await readFile(trialLedgerPathV1(root), 'utf8'));
    if (value?.contract !== TRIAL_LEDGER_CONTRACT_V1 || typeof value.sources !== 'object' || !Array.isArray(value.holdoutUses)) {
      throw new Error('TRIAL_LEDGER_CORRUPT');
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyLedger();
    // A corrupt ledger must never reset the count to zero.
    throw error instanceof SyntaxError ? new Error('TRIAL_LEDGER_CORRUPT') : error;
  }
}

export async function writeTrialLedgerV1(root, ledger) {
  const path = trialLedgerPathV1(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(ledger)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

/**
 * Records that `experimentKey` (lane + library + symbols + exits) has now
 * evaluated `trials` trials on `source`. Counts only ever grow: a smaller
 * number (a restarted experiment) never lowers the stored count.
 */
export function recordExperimentTrialsV1(ledger, { source, laneId, experimentKey, trials, observedAt }) {
  if (!source || !laneId || !experimentKey) throw new Error('TRIAL_LEDGER_KEY_REQUIRED');
  if (!Number.isSafeInteger(trials) || trials < 0) throw new Error('TRIAL_LEDGER_COUNT_INVALID');
  const sources = ledger.sources;
  sources[source] ??= { experiments: {} };
  const experiments = sources[source].experiments;
  const prior = experiments[experimentKey];
  experiments[experimentKey] = {
    laneId,
    firstSeenAt: prior?.firstSeenAt ?? observedAt,
    lastSeenAt: observedAt,
    trials: Math.max(Number(prior?.trials ?? 0), trials),
  };
  return ledger;
}

/** Cumulative trials ever evaluated on a data source (all lanes, all experiments). */
export function cumulativeTrialsV1(ledger, source) {
  const experiments = ledger?.sources?.[source]?.experiments ?? {};
  return Object.values(experiments).reduce((sum, row) => sum + Number(row.trials ?? 0), 0);
}

/** Trials on a source excluding one experiment (so the current one is not double counted). */
export function priorTrialsExcludingV1(ledger, source, experimentKey) {
  const experiments = ledger?.sources?.[source]?.experiments ?? {};
  return Object.entries(experiments).filter(([key]) => key !== experimentKey)
    .reduce((sum, [, row]) => sum + Number(row.trials ?? 0), 0);
}

/**
 * Benjamini-Hochberg q-values with a denominator of at least `totalTrials`.
 * Trials outside `pValues` (earlier experiments on the same data) are treated
 * as p = 1. With totalTrials = pValues.length this equals plain BH.
 */
export function benjaminiHochbergCumulativeV1(pValues, totalTrials = pValues.length) {
  const m = Math.max(pValues.length, Number.isFinite(totalTrials) ? Math.floor(totalTrials) : 0);
  const order = pValues.map((p, index) => ({ p: Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 1, index }))
    .sort((a, b) => a.p - b.p || a.index - b.index);
  const q = new Array(pValues.length);
  let running = 1;
  for (let rank = order.length; rank >= 1; rank -= 1) {
    const { p, index } = order[rank - 1];
    running = Math.min(running, (p * m) / rank);
    q[index] = running;
  }
  return q;
}

export function holdoutUsesForSourceV1(ledger, source) {
  return ledger.holdoutUses.filter((row) => row.source === source).length;
}

/** True when this trial already spent its check, or the source still has budget. */
export function holdoutAllowedV1(ledger, { source, trialId, policy = TRIAL_LEDGER_POLICY_V1 }) {
  if (ledger.holdoutUses.some((row) => row.source === source && row.trialId === trialId)) return { allowed: true, reused: true };
  const used = holdoutUsesForSourceV1(ledger, source);
  return { allowed: used < policy.holdoutChecksPerSource, reused: false, used, budget: policy.holdoutChecksPerSource };
}

export function recordHoldoutUseV1(ledger, { source, laneId, trialId, observedAt, pass }) {
  if (ledger.holdoutUses.some((row) => row.source === source && row.trialId === trialId)) return ledger;
  ledger.holdoutUses.push({ source, laneId, trialId, observedAt, pass: pass === true });
  return ledger;
}

// ---------- deflated Sharpe ratio (Bailey & Lopez de Prado, 2014) ----------

function normalCdf(z) {
  // Abramowitz-Stegun 26.2.17; |error| < 7.5e-8.
  const t = 1 / (1 + (0.2316419 * Math.abs(z)));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const tail = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}

function normalQuantile(p) {
  // Acklam's rational approximation; relative error < 1.2e-9.
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export { normalCdf as normalCdfV1, normalQuantile as normalQuantileV1 };

/** Per-trade Sharpe, skewness and (non-excess) kurtosis of a return sample. */
export function sharpeMomentsV1(returns) {
  const n = returns.length;
  if (n < 3) return { n, sharpe: 0, skew: 0, kurtosis: 3 };
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const m2 = returns.reduce((s, r) => s + ((r - mean) ** 2), 0) / n;
  if (!(m2 > 0)) return { n, sharpe: 0, skew: 0, kurtosis: 3 };
  const sd = Math.sqrt(m2);
  const m3 = returns.reduce((s, r) => s + ((r - mean) ** 3), 0) / n;
  const m4 = returns.reduce((s, r) => s + ((r - mean) ** 4), 0) / n;
  return { n, sharpe: mean / sd, skew: m3 / (sd ** 3), kurtosis: m4 / (m2 ** 2) };
}

/**
 * Expected maximum Sharpe among `trials` independent zero-skill strategies
 * whose Sharpe estimates have variance `sharpeVariance`.
 */
export function expectedMaxSharpeV1(trials, sharpeVariance) {
  const n = Math.max(2, Math.floor(trials));
  const gamma = 0.5772156649015329;
  const sd = Math.sqrt(Math.max(0, sharpeVariance));
  return sd * (((1 - gamma) * normalQuantile(1 - (1 / n))) + (gamma * normalQuantile(1 - (1 / (n * Math.E)))));
}

/**
 * Probability that the true Sharpe exceeds the best Sharpe expected by luck
 * after `trials` attempts. ~0.95+ is strong; below 0.5 means "luck explains it".
 */
export function deflatedSharpeProbabilityV1({ returns, trials, sharpeVariance }) {
  const { n, sharpe, skew, kurtosis } = sharpeMomentsV1(returns);
  if (n < 3) return { probability: 0, sharpe: 0, benchmark: null, n };
  const variance = Number.isFinite(sharpeVariance) && sharpeVariance > 0 ? sharpeVariance : 1 / n;
  const benchmark = expectedMaxSharpeV1(trials, variance);
  const denominator = Math.sqrt(Math.max(1e-12, 1 - (skew * sharpe) + (((kurtosis - 1) / 4) * sharpe * sharpe)));
  const z = ((sharpe - benchmark) * Math.sqrt(n - 1)) / denominator;
  return { probability: normalCdf(z), sharpe, benchmark, n };
}

/** DSR from summary statistics only (normal skew/kurtosis assumed). */
export function deflatedSharpeFromStatsV1({ sharpe, n, trials, sharpeVariance }) {
  if (!(n >= 3) || !Number.isFinite(sharpe)) return { probability: 0, sharpe: 0, benchmark: null, n: n ?? 0 };
  const variance = Number.isFinite(sharpeVariance) && sharpeVariance > 0 ? sharpeVariance : 1 / n;
  const benchmark = expectedMaxSharpeV1(trials, variance);
  const denominator = Math.sqrt(Math.max(1e-12, 1 + (0.5 * sharpe * sharpe)));
  return { probability: normalCdf(((sharpe - benchmark) * Math.sqrt(n - 1)) / denominator), sharpe, benchmark, n };
}

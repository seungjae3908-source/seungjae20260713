import { buildSelectedStrategyFingerprint, selectionTrials } from "./research-trial-registry.js";

const EULER_MASCHERONI = 0.5772156649015329;

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values) {
  if (values.length < 2) return 0;
  const center = mean(values);
  return values.reduce((sum, value) => sum + ((value - center) ** 2), 0) / (values.length - 1);
}

function sampleSharpe(values) {
  if (!Array.isArray(values) || values.length < 2 || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("return series must contain at least two finite observations");
  }
  const avg = mean(values);
  const variance = sampleVariance(values);
  if (!(variance > 0)) return avg > 0 ? Number.POSITIVE_INFINITY : avg < 0 ? Number.NEGATIVE_INFINITY : 0;
  return avg / Math.sqrt(variance);
}

function moments(values) {
  const avg = mean(values);
  const deviations = values.map((value) => value - avg);
  const m2 = mean(deviations.map((value) => value ** 2));
  if (!(m2 > 0)) return Object.freeze({ skewness: 0, kurtosis: 3 });
  const m3 = mean(deviations.map((value) => value ** 3));
  const m4 = mean(deviations.map((value) => value ** 4));
  return Object.freeze({
    skewness: m3 / (m2 ** 1.5),
    kurtosis: m4 / (m2 ** 2),
  });
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-(ax ** 2));
  return sign * y;
}

function normalCdf(x) {
  if (x === Number.POSITIVE_INFINITY) return 1;
  if (x === Number.NEGATIVE_INFINITY) return 0;
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function inverseNormalCdf(p) {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return Number.NEGATIVE_INFINITY;
    if (p === 1) return Number.POSITIVE_INFINITY;
    throw new RangeError("normal probability must be in [0, 1]");
  }
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function combinations(n, k, maxCombinations) {
  const result = [];
  const current = [];
  function visit(start) {
    if (result.length > maxCombinations) throw new RangeError("CSCV combination cap exceeded");
    if (current.length === k) {
      result.push(Object.freeze([...current]));
      return;
    }
    for (let index = start; index <= n - (k - current.length); index += 1) {
      current.push(index);
      visit(index + 1);
      current.pop();
    }
  }
  visit(0);
  if (result.length > maxCombinations) throw new RangeError("CSCV combination cap exceeded");
  return result;
}

function blockMeans(returnSeries, blockCount) {
  if (!Number.isInteger(blockCount) || blockCount < 4 || blockCount % 2 !== 0) {
    throw new RangeError("blockCount must be an even integer >= 4");
  }
  if (!Array.isArray(returnSeries) || returnSeries.length < blockCount) {
    throw new RangeError("return series is too short for requested CSCV blocks");
  }
  const result = [];
  for (let block = 0; block < blockCount; block += 1) {
    const start = Math.floor((block * returnSeries.length) / blockCount);
    const end = Math.floor(((block + 1) * returnSeries.length) / blockCount);
    const rows = returnSeries.slice(start, end);
    if (rows.length === 0) throw new RangeError("empty CSCV block");
    result.push(mean(rows));
  }
  return Object.freeze(result);
}

export function computeCscvPbo(trials, { blockCount = 8, maxCombinations = 5000 } = {}) {
  if (!Array.isArray(trials) || trials.length < 3) throw new TypeError("PBO requires at least three trials");
  const lengths = new Set(trials.map((trial) => trial.returnSeries?.length));
  if (lengths.size !== 1) throw new Error("PBO trials must share one aligned observation count");
  const blocksByTrial = trials.map((trial) => blockMeans(trial.returnSeries, blockCount));
  const splits = combinations(blockCount, blockCount / 2, maxCombinations);
  let overfit = 0;
  const logits = [];

  for (const inSample of splits) {
    const inSet = new Set(inSample);
    const outSample = Array.from({ length: blockCount }, (_, index) => index).filter((index) => !inSet.has(index));
    const inScores = blocksByTrial.map((blocks) => mean(inSample.map((index) => blocks[index])));
    const winner = inScores.reduce((best, value, index) => value > inScores[best] ? index : best, 0);
    const outScores = blocksByTrial.map((blocks) => mean(outSample.map((index) => blocks[index])));
    const sorted = outScores.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value || left.index - right.index);
    const rank = sorted.findIndex((row) => row.index === winner) + 1;
    const relativeRank = rank / (trials.length + 1);
    const logit = Math.log(relativeRank / (1 - relativeRank));
    logits.push(logit);
    if (logit <= 0) overfit += 1;
  }

  return Object.freeze({
    method: "CSCV_PBO",
    trialCount: trials.length,
    blockCount,
    combinationCount: splits.length,
    pbo: overfit / splits.length,
    overfitCombinations: overfit,
    logits: Object.freeze(logits),
  });
}

export function computeDeflatedSharpeRatio(selectedReturns, trialReturnSeries) {
  if (!Array.isArray(trialReturnSeries) || trialReturnSeries.length === 0) throw new TypeError("trialReturnSeries is required");
  if (!Array.isArray(selectedReturns) || selectedReturns.length < 3) throw new TypeError("selectedReturns requires at least three observations");
  const selectedSharpe = sampleSharpe(selectedReturns);
  if (!Number.isFinite(selectedSharpe)) {
    return Object.freeze({
      method: "DEFLATED_SHARPE_RATIO",
      probability: selectedSharpe > 0 ? 1 : 0,
      selectedSharpe,
      expectedMaxSharpe: 0,
      trialCount: trialReturnSeries.length,
      observations: selectedReturns.length,
      skewness: 0,
      kurtosis: 3,
      trialSharpeVariance: 0,
    });
  }
  const trialSharpes = trialReturnSeries.map(sampleSharpe).filter(Number.isFinite);
  if (trialSharpes.length === 0) throw new Error("no finite trial Sharpe estimates");
  const sharpeVariance = sampleVariance(trialSharpes);
  const trialCount = trialSharpes.length;
  const expectedMaxSharpe = trialCount <= 1 || !(sharpeVariance > 0)
    ? 0
    : Math.sqrt(sharpeVariance) * (
      (1 - EULER_MASCHERONI) * inverseNormalCdf(1 - (1 / trialCount))
      + EULER_MASCHERONI * inverseNormalCdf(1 - (1 / (trialCount * Math.E)))
    );
  const { skewness, kurtosis } = moments(selectedReturns);
  const denominatorSquared = 1 - (skewness * selectedSharpe)
    + (((kurtosis - 1) / 4) * (selectedSharpe ** 2));
  if (!(denominatorSquared > 0)) throw new Error("invalid Deflated Sharpe denominator");
  const statistic = ((selectedSharpe - expectedMaxSharpe) * Math.sqrt(selectedReturns.length - 1))
    / Math.sqrt(denominatorSquared);

  return Object.freeze({
    method: "DEFLATED_SHARPE_RATIO",
    probability: normalCdf(statistic),
    statistic,
    selectedSharpe,
    expectedMaxSharpe,
    trialCount,
    observations: selectedReturns.length,
    skewness,
    kurtosis,
    trialSharpeVariance: sharpeVariance,
  });
}

export function buildSelectionBiasEvidence(registry, selectedTrialId, { blockCount = 8, maxCombinations = 5000 } = {}) {
  const trials = selectionTrials(registry);
  if (trials.length < 3) throw new Error("at least three selection-eligible trials are required");
  const selected = trials.find((trial) => trial.trialId === selectedTrialId);
  if (!selected) throw new Error("selected trial is missing from selection registry");
  const pbo = computeCscvPbo(trials, { blockCount, maxCombinations });
  const dsr = computeDeflatedSharpeRatio(selected.returnSeries, trials.map((trial) => trial.returnSeries));
  return Object.freeze({
    schemaVersion: 2,
    experimentId: registry.experimentId,
    strategyFamilyFingerprint: registry.strategyIdentity.familyFingerprint,
    strategyFingerprint: buildSelectedStrategyFingerprint(registry, selected),
    registryDigest: registry.registryDigest,
    selectedTrialId,
    selectedCandidateId: selected.candidateId,
    selectedParameterHash: selected.parameterHash,
    trialCount: trials.length,
    pbo,
    dsr,
    policyPass: null,
    policyStatus: "thresholds_not_applied_in_statistics_layer",
  });
}

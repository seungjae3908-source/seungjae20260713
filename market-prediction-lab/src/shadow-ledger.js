import { createHash } from "node:crypto";

const CLASS_NAMES = Object.freeze(["bullish", "neutral", "bearish"]);

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function normalizeProbabilities(probabilities, label) {
  if (!probabilities || typeof probabilities !== "object") throw new TypeError(`${label} is required`);
  const values = CLASS_NAMES.map((name) => Math.max(0, finite(probabilities[name], `${label}.${name}`)));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) throw new TypeError(`${label} total must be positive`);
  return Object.freeze(Object.fromEntries(CLASS_NAMES.map((name, index) => [name, values[index] / total])));
}

function predictedClass(probabilities) {
  return CLASS_NAMES.reduce((best, name) => probabilities[name] > probabilities[best] ? name : best, CLASS_NAMES[0]);
}

function actualDirection(actualReturn, atrPct) {
  const threshold = Math.max(Math.abs(atrPct) * 0.35, 0.002);
  if (actualReturn > threshold) return "bullish";
  if (actualReturn < -threshold) return "bearish";
  return "neutral";
}

function brier(probabilities, actual) {
  return CLASS_NAMES.reduce((sum, name) => sum + (probabilities[name] - (name === actual ? 1 : 0)) ** 2, 0);
}

function classifyRegime(features = {}) {
  const emaGap = Number.isFinite(features.emaGap) ? features.emaGap : 0;
  const trendSlope = Number.isFinite(features.trendSlope) ? features.trendSlope : 0;
  const atrPct = Math.abs(Number.isFinite(features.atrPct) ? features.atrPct : 0);
  const trend = emaGap > 0.002 && trendSlope > 0 ? "bull_trend"
    : emaGap < -0.002 && trendSlope < 0 ? "bear_trend"
      : "range";
  const volatility = atrPct >= 0.015 ? "high_volatility" : atrPct <= 0.005 ? "low_volatility" : "normal_volatility";
  return Object.freeze({ trend, volatility, key: `${trend}:${volatility}` });
}

function modelPairKey(record) {
  return `${record.modelId}::${record.referenceModelId}`;
}

export function createShadowPrediction({
  modelGroup,
  modelId,
  referenceModelId,
  market = "CRYPTO_FUTURES",
  symbol,
  timeframe,
  anchorTimestamp,
  horizon,
  lastClose,
  atrPct,
  candidateProbabilities,
  referenceProbabilities,
  features = {},
  featureAvailability = {},
  generatedAt = Date.now(),
}) {
  if (typeof modelGroup !== "string" || modelGroup.length === 0) throw new TypeError("modelGroup is required");
  if (typeof modelId !== "string" || typeof referenceModelId !== "string") throw new TypeError("model identifiers are required");
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/.test(symbol)) throw new TypeError("invalid symbol");
  if (!new Set(["15m", "1h", "4h", "1d"]).has(timeframe)) throw new TypeError("invalid timeframe");
  if (!Number.isInteger(anchorTimestamp) || anchorTimestamp <= 0) throw new TypeError("anchorTimestamp must be positive");
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 20) throw new TypeError("invalid horizon");
  finite(lastClose, "lastClose");
  finite(atrPct, "atrPct");
  const candidate = normalizeProbabilities(candidateProbabilities, "candidateProbabilities");
  const reference = normalizeProbabilities(referenceProbabilities, "referenceProbabilities");
  const id = createHash("sha256").update([modelGroup, modelId, referenceModelId, symbol, timeframe, anchorTimestamp, horizon].join("|")).digest("hex");
  return Object.freeze({
    schemaVersion: 2,
    id,
    status: "pending",
    modelGroup,
    modelId,
    referenceModelId,
    modelPair: `${modelId}::${referenceModelId}`,
    market,
    symbol,
    timeframe,
    anchorTimestamp,
    horizon,
    lastClose,
    atrPct,
    generatedAt,
    candidateProbabilities: candidate,
    referenceProbabilities: reference,
    candidateClass: predictedClass(candidate),
    referenceClass: predictedClass(reference),
    regime: classifyRegime(features),
    features: Object.freeze({ ...features }),
    featureAvailability: Object.freeze({ ...featureAvailability }),
  });
}

export function settleShadowPrediction(record, futureCandles, evaluatedAt = Date.now()) {
  if (!record || record.status !== "pending") throw new TypeError("pending shadow record is required");
  if (!Array.isArray(futureCandles) || futureCandles.length < record.horizon) throw new RangeError("not enough future candles");
  const selected = futureCandles.slice(0, record.horizon);
  if (selected.some((candle) => !candle || !Number.isFinite(candle.close) || !Number.isInteger(candle.timestamp)
      || candle.timestamp <= record.anchorTimestamp)) throw new TypeError("future candles are invalid");
  for (let index = 1; index < selected.length; index += 1) {
    if (selected[index].timestamp <= selected[index - 1].timestamp) throw new TypeError("future candles must be ascending");
  }
  const actualReturn = (selected.at(-1).close / record.lastClose) - 1;
  const actual = actualDirection(actualReturn, record.atrPct);
  return Object.freeze({
    ...record,
    status: "settled",
    evaluatedAt,
    futureEndTimestamp: selected.at(-1).timestamp,
    actualReturn,
    actualDirection: actual,
    candidateHit: record.candidateClass === actual,
    referenceHit: record.referenceClass === actual,
    candidateLogLoss: -Math.log(Math.max(record.candidateProbabilities[actual], 1e-12)),
    referenceLogLoss: -Math.log(Math.max(record.referenceProbabilities[actual], 1e-12)),
    candidateBrier: brier(record.candidateProbabilities, actual),
    referenceBrier: brier(record.referenceProbabilities, actual),
  });
}

export function upsertShadowPrediction(state, prediction, { maxRecords = 10000 } = {}) {
  if (!state || typeof state !== "object") throw new TypeError("state is required");
  if (!prediction?.id) throw new TypeError("prediction is required");
  if (!Number.isInteger(maxRecords) || maxRecords < 100 || maxRecords > 100000) throw new TypeError("maxRecords is invalid");
  const records = Array.isArray(state.records) ? [...state.records] : [];
  const index = records.findIndex((record) => record.id === prediction.id);
  if (index >= 0) {
    if (JSON.stringify(records[index]) !== JSON.stringify(prediction)) throw new Error(`shadow prediction conflict: ${prediction.id}`);
    return Object.freeze({ ...state, records: Object.freeze(records), updatedAt: Date.now() });
  }
  records.push(prediction);
  records.sort((left, right) => left.anchorTimestamp - right.anchorTimestamp || left.id.localeCompare(right.id));
  return Object.freeze({
    schemaVersion: 2,
    createdAt: state.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    openInterestSnapshots: Object.freeze([...(state.openInterestSnapshots ?? [])]),
    records: Object.freeze(records.slice(-maxRecords)),
  });
}

function metricRows(records, prefix) {
  return records.map((record) => ({
    actual: record.actualDirection,
    predicted: record[`${prefix}Class`],
    logLoss: record[`${prefix}LogLoss`],
    brier: record[`${prefix}Brier`],
  }));
}

function metrics(rows) {
  if (rows.length === 0) return null;
  const confusion = Object.fromEntries(CLASS_NAMES.map((actual) => [actual, Object.fromEntries(CLASS_NAMES.map((predicted) => [predicted, 0]))]));
  let hits = 0;
  let logLoss = 0;
  let brierScore = 0;
  for (const row of rows) {
    confusion[row.actual][row.predicted] += 1;
    hits += row.actual === row.predicted ? 1 : 0;
    logLoss += row.logLoss;
    brierScore += row.brier;
  }
  const perClass = {};
  for (const name of CLASS_NAMES) {
    const tp = confusion[name][name];
    const fp = CLASS_NAMES.reduce((sum, actual) => sum + (actual === name ? 0 : confusion[actual][name]), 0);
    const fn = CLASS_NAMES.reduce((sum, predicted) => sum + (predicted === name ? 0 : confusion[name][predicted]), 0);
    const support = CLASS_NAMES.reduce((sum, predicted) => sum + confusion[name][predicted], 0);
    const precision = tp / Math.max(tp + fp, 1);
    const recall = tp / Math.max(tp + fn, 1);
    const f1 = 2 * precision * recall / Math.max(precision + recall, 1e-12);
    perClass[name] = { support, precision, recall, f1 };
  }
  return Object.freeze({
    sampleCount: rows.length,
    accuracy: hits / rows.length,
    macroF1: CLASS_NAMES.reduce((sum, name) => sum + perClass[name].f1, 0) / CLASS_NAMES.length,
    balancedAccuracy: CLASS_NAMES.reduce((sum, name) => sum + perClass[name].recall, 0) / CLASS_NAMES.length,
    logLoss: logLoss / rows.length,
    brier: brierScore / rows.length,
    perClass: Object.freeze(perClass),
    confusion: Object.freeze(confusion),
  });
}

function groupMetrics(records, keySelector) {
  const groups = new Map();
  for (const record of records) {
    const key = keySelector(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return Object.fromEntries([...groups.entries()].map(([key, rows]) => [key, {
    candidate: metrics(metricRows(rows, "candidate")),
    reference: metrics(metricRows(rows, "reference")),
  }]));
}

function comparison(candidate, reference) {
  return candidate && reference ? Object.freeze({
    accuracyDelta: candidate.accuracy - reference.accuracy,
    macroF1Delta: candidate.macroF1 - reference.macroF1,
    logLossImprovement: reference.logLoss - candidate.logLoss,
    brierImprovement: reference.brier - candidate.brier,
  }) : null;
}

export function summarizeShadowState(state, { modelId, referenceModelId } = {}) {
  const allRecords = Array.isArray(state?.records) ? state.records : [];
  const records = allRecords.filter((record) => (modelId === undefined || record.modelId === modelId)
    && (referenceModelId === undefined || record.referenceModelId === referenceModelId));
  const settled = records.filter((record) => record.status === "settled");
  const pending = records.length - settled.length;
  const candidate = metrics(metricRows(settled, "candidate"));
  const reference = metrics(metricRows(settled, "reference"));
  return Object.freeze({
    schemaVersion: 2,
    generatedAt: Date.now(),
    filter: Object.freeze({ modelId: modelId ?? null, referenceModelId: referenceModelId ?? null }),
    totalAllModelPairs: allRecords.length,
    total: records.length,
    settled: settled.length,
    pending,
    firstAnchorTimestamp: records[0]?.anchorTimestamp ?? null,
    lastAnchorTimestamp: records.at(-1)?.anchorTimestamp ?? null,
    candidate,
    reference,
    comparison: comparison(candidate, reference),
    bySymbol: groupMetrics(settled, (record) => record.symbol),
    byRegime: groupMetrics(settled, (record) => record.regime.key),
    byModelPair: groupMetrics(allRecords.filter((record) => record.status === "settled"), modelPairKey),
  });
}

export function evaluateShadowPromotion(summary, {
  minSettled = 300,
  minPerSymbol = 100,
  minElapsedMs = 28 * 24 * 60 * 60 * 1000,
  minRegimeSamples = 30,
  minQualifiedRegimes = 2,
} = {}) {
  const reasons = [];
  if (!summary || typeof summary !== "object") throw new TypeError("summary is required");
  if (summary.settled < minSettled) reasons.push("insufficient_settled_samples");
  if (!summary.firstAnchorTimestamp || !summary.lastAnchorTimestamp
      || summary.lastAnchorTimestamp - summary.firstAnchorTimestamp < minElapsedMs) reasons.push("insufficient_elapsed_shadow_period");
  for (const [symbol, group] of Object.entries(summary.bySymbol ?? {})) {
    if ((group.candidate?.sampleCount ?? 0) < minPerSymbol) reasons.push(`${symbol}:insufficient_samples`);
    if (group.candidate && group.reference) {
      if (group.candidate.logLoss > group.reference.logLoss + 0.01) reasons.push(`${symbol}:log_loss_regressed`);
      if (group.candidate.macroF1 < group.reference.macroF1 - 0.01) reasons.push(`${symbol}:macro_f1_regressed`);
    }
  }
  const qualifiedRegimes = Object.entries(summary.byRegime ?? {})
    .filter(([, group]) => (group.candidate?.sampleCount ?? 0) >= minRegimeSamples);
  if (qualifiedRegimes.length < minQualifiedRegimes) reasons.push("insufficient_regime_coverage");
  for (const [regime, group] of qualifiedRegimes) {
    if (group.candidate.logLoss > group.reference.logLoss + 0.015) reasons.push(`${regime}:log_loss_regressed`);
    if (group.candidate.macroF1 < group.reference.macroF1 - 0.02) reasons.push(`${regime}:macro_f1_regressed`);
  }
  if (!summary.comparison) reasons.push("no_settled_comparison");
  else {
    if (summary.comparison.logLossImprovement < 0.01) reasons.push("log_loss_improvement_below_gate");
    if (summary.comparison.macroF1Delta < 0) reasons.push("macro_f1_regressed");
    if (summary.comparison.accuracyDelta < -0.005) reasons.push("accuracy_regressed");
  }
  return Object.freeze({
    approved: reasons.length === 0,
    status: reasons.length === 0 ? "integration_review_ready" : "shadow_continue",
    qualifiedRegimes: qualifiedRegimes.map(([regime]) => regime),
    reasons: Object.freeze(reasons),
  });
}

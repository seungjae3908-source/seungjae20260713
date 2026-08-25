const CLASSES = Object.freeze(["bullish", "neutral", "bearish"]);
const PREDICTIONS = Object.freeze([...CLASSES, "abstain"]);

function safeRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function mean(values) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function normalizePrediction(record) {
  const predicted = record.predictedDirection ?? record.candidateClass ?? record.predicted;
  const actual = record.actualDirection ?? record.actual;
  if (!PREDICTIONS.includes(predicted)) throw new TypeError(`invalid predicted direction: ${predicted}`);
  if (!CLASSES.includes(actual)) throw new TypeError(`invalid actual direction: ${actual}`);
  return { predicted, actual };
}

export function buildShadowDirectionalMetrics(records) {
  if (!Array.isArray(records) || records.length === 0) throw new TypeError("directional records are required");
  const rows = records.map(normalizePrediction);
  const confusion = Object.fromEntries(CLASSES.map((actual) => [actual, Object.fromEntries(PREDICTIONS.map((predicted) => [predicted, 0]))]));
  const actualCounts = Object.fromEntries(CLASSES.map((name) => [name, 0]));
  const predictedCounts = Object.fromEntries(PREDICTIONS.map((name) => [name, 0]));
  rows.forEach(({ actual, predicted }) => {
    actualCounts[actual] += 1;
    predictedCounts[predicted] += 1;
    confusion[actual][predicted] += 1;
  });
  const perClass = {};
  for (const name of CLASSES) {
    const tp = confusion[name][name];
    const support = PREDICTIONS.reduce((sum, predicted) => sum + confusion[name][predicted], 0);
    const predictedSupport = CLASSES.reduce((sum, actual) => sum + confusion[actual][name], 0);
    const precision = predictedSupport > 0 ? tp / predictedSupport : 0;
    const recall = safeRatio(tp, support);
    const f1 = recall === null ? null : precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
    perClass[name] = Object.freeze({ support, predictedSupport, precision, precisionEvaluable: predictedSupport > 0, recall, f1, recallEvaluable: support > 0 });
  }
  const allClassRecallEvaluable = CLASSES.every((name) => perClass[name].recallEvaluable);
  const neutralShare = predictedCounts.neutral / rows.length;
  return Object.freeze({
    sampleCount: rows.length,
    actualCounts: Object.freeze(actualCounts),
    predictedCounts: Object.freeze(predictedCounts),
    predictedShares: Object.freeze(Object.fromEntries(PREDICTIONS.map((name) => [name, predictedCounts[name] / rows.length]))),
    confusion: Object.freeze(Object.fromEntries(Object.entries(confusion).map(([key, value]) => [key, Object.freeze(value)]))),
    perClass: Object.freeze(perClass),
    bearRecall: perClass.bearish.recall,
    bearRecallEvaluable: perClass.bearish.recallEvaluable,
    macroF1SupportedClasses: mean(CLASSES.filter((name) => perClass[name].support > 0).map((name) => perClass[name].f1)),
    macroF1AllClasses: allClassRecallEvaluable ? mean(CLASSES.map((name) => perClass[name].f1)) : null,
    balancedAccuracySupportedClasses: mean(CLASSES.map((name) => perClass[name].recall)),
    balancedAccuracyAllClasses: allClassRecallEvaluable ? mean(CLASSES.map((name) => perClass[name].recall)) : null,
    evidence: Object.freeze({ allClassRecallEvaluable, actualBearishSupport: perClass.bearish.support, neutralDominanceObserved: neutralShare >= 0.75, neutralDominanceDiagnosticThreshold: 0.75 }),
  });
}

function validateTimeframe(records, timeframe, label) {
  if (!Array.isArray(records) || !records.length) return;
  const values = [...new Set(records.map((record) => record.timeframe).filter(Boolean))];
  if (values.length > 1) throw new Error(`${label} mixed timeframe aggregation is forbidden`);
  if (timeframe && values.length === 1 && values[0] !== timeframe) throw new Error(`${label} timeframe mismatch`);
}

function economicEvidence(summary) {
  if (!summary) return Object.freeze({ available: false, semanticDomain: "ECONOMIC_BACKTEST", comparableToShadowDirectionalMetrics: false, values: null });
  const allowed = ["totalTrades", "totalReturnPercent", "successRatePercent", "profitFactor", "maximumDrawdownPercent", "expectancy", "finalCapital"];
  return Object.freeze({
    available: true,
    semanticDomain: "ECONOMIC_BACKTEST",
    comparableToShadowDirectionalMetrics: false,
    values: Object.freeze(Object.fromEntries(allowed.filter((key) => summary[key] !== undefined).map((key) => [key, summary[key]]))),
  });
}

function compareDirectional(backtest, shadow) {
  if (!backtest) return Object.freeze({ available: false, reason: "BACKTEST_DIRECTIONAL_EVIDENCE_MISSING", bearRecallDelta: null, neutralShareDelta: null, macroF1Delta: null, balancedAccuracyDelta: null, descriptiveVerdict: "UNRESOLVED" });
  const bearComparable = backtest.bearRecallEvaluable && shadow.bearRecallEvaluable;
  const bearRecallDelta = bearComparable ? shadow.bearRecall - backtest.bearRecall : null;
  const neutralShareDelta = shadow.predictedShares.neutral - backtest.predictedShares.neutral;
  const macroF1Delta = shadow.macroF1SupportedClasses !== null && backtest.macroF1SupportedClasses !== null ? shadow.macroF1SupportedClasses - backtest.macroF1SupportedClasses : null;
  const balancedAccuracyDelta = shadow.balancedAccuracySupportedClasses !== null && backtest.balancedAccuracySupportedClasses !== null ? shadow.balancedAccuracySupportedClasses - backtest.balancedAccuracySupportedClasses : null;
  const degradationObserved = (bearRecallDelta !== null && bearRecallDelta < 0) || neutralShareDelta > 0 || (macroF1Delta !== null && macroF1Delta < 0) || (balancedAccuracyDelta !== null && balancedAccuracyDelta < 0);
  return Object.freeze({ available: true, bearRecallComparable: bearComparable, bearRecallDelta, neutralShareDelta, macroF1Delta, balancedAccuracyDelta, descriptiveVerdict: degradationObserved ? "SHADOW_DIRECTIONAL_DEGRADATION_OBSERVED" : "NO_DIRECTIONAL_DEGRADATION_PROVEN", causalityEstablished: false });
}

export function buildShadowBacktestGapDiagnostic({ shadowRecords, backtestDirectionalRecords = null, backtestEconomicSummary = null, featureDriftDiagnostic = null, timeframe, researchCodeSha, shadowResearchCodeSha, generatedAt = Date.now() }) {
  if (!/^[0-9a-f]{40}$/.test(researchCodeSha ?? "")) throw new TypeError("researchCodeSha must be an immutable SHA");
  if (!/^[0-9a-f]{40}$/.test(shadowResearchCodeSha ?? "")) throw new TypeError("shadowResearchCodeSha must be an immutable SHA");
  validateTimeframe(shadowRecords, timeframe, "shadow");
  validateTimeframe(backtestDirectionalRecords, timeframe, "backtest");
  const shadow = buildShadowDirectionalMetrics(shadowRecords);
  const backtest = Array.isArray(backtestDirectionalRecords) && backtestDirectionalRecords.length ? buildShadowDirectionalMetrics(backtestDirectionalRecords) : null;
  const comparison = compareDirectional(backtest, shadow);
  const featureDrift = Object.freeze({ supplied: Boolean(featureDriftDiagnostic), trueDistributionDriftAvailable: Boolean(featureDriftDiagnostic?.trueDistributionDriftAvailable), rootCauseVerdict: featureDriftDiagnostic?.rootCauseVerdict ?? "NOT_MEASURED", limitations: Object.freeze([...(featureDriftDiagnostic?.limitations ?? [])]) });
  const missingEvidence = [];
  if (!backtest) missingEvidence.push("backtest_directional_records_missing");
  if (!shadow.bearRecallEvaluable) missingEvidence.push("shadow_actual_bearish_sample_missing");
  if (backtest && !backtest.bearRecallEvaluable) missingEvidence.push("backtest_actual_bearish_sample_missing");
  if (!featureDriftDiagnostic) missingEvidence.push("feature_drift_diagnostic_missing");
  else if (!featureDrift.trueDistributionDriftAvailable) missingEvidence.push("raw_reference_feature_distribution_missing_for_true_psi_ks");
  return Object.freeze({
    schemaVersion: 1,
    kind: "shadow-backtest-gap-diagnostic",
    generatedAt,
    researchCodeSha,
    shadowResearchCodeSha,
    timeframe: timeframe ?? shadowRecords[0]?.timeframe ?? null,
    shadow,
    backtestDirectional: backtest,
    backtestEconomic: economicEvidence(backtestEconomicSummary),
    directionalComparison: comparison,
    featureDrift,
    missingEvidence: Object.freeze(missingEvidence),
    collapseObservation: Object.freeze({ neutralDominanceObserved: shadow.evidence.neutralDominanceObserved, actualBearishSupport: shadow.evidence.actualBearishSupport, bearRecall: shadow.bearRecall, bearRecallEvaluable: shadow.bearRecallEvaluable }),
    rootCauseVerdict: "INSUFFICIENT_EVIDENCE_FOR_CAUSAL_ROOT_CAUSE",
    safety: Object.freeze({ diagnosticsOnly: true, modelModified: false, thresholdModified: false, labelModified: false, strategyModified: false, promotionModified: false, scheduleModified: false, finalHoldoutUsedForSelection: false, liveOrderAllowed: false, privateAccountRequestAllowed: false, orderSubmitted: false }),
  });
}

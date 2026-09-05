import { scoreToProbabilities } from "./rules.js";
import { predictTinyModel } from "./tiny-model.js";
import { DEPLOYED_RULE_WEIGHT, predictRuleModelBlend } from "./rule-model-blend-challenger.js";

const CLASSES = Object.freeze(["bullish", "neutral", "bearish"]);
const DECISIONS = Object.freeze([...CLASSES, "abstain"]);

export const SHADOW_DIRECTIONAL_METHODS = Object.freeze([
  "CURRENT_FIXED_BLEND",
  "MODEL_ONLY_DIAGNOSTIC",
  "AGREEMENT_GATE",
  "CONFIDENCE_GATE",
  "DYNAMIC_CALIBRATED_BLEND",
  "REGIME_AWARE_COMBINATION",
  "ABSTAIN_FIRST",
]);

export const SHADOW_DIRECTIONAL_STAGE_ORDER = Object.freeze([
  "development", "oos", "purgedWalkForward", "costStress", "regimeStress", "finalHoldout",
]);

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const topClass = (p) => CLASSES.reduce((best, name) => p[name] > p[best] ? name : best, CLASSES[0]);
const freezeEntries = (entries) => Object.freeze(Object.fromEntries(entries));

function normalize(p) {
  const values = CLASSES.map((name) => Math.max(0, finite(p?.[name]) ? p[name] : 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) throw new TypeError("probabilities must contain positive finite mass");
  return freezeEntries(CLASSES.map((name, index) => [name, values[index] / total]));
}

function validateGrid(grid, name) {
  if (!Array.isArray(grid) || grid.length === 0) throw new TypeError(`${name} is required`);
  return Object.freeze([...new Set(grid.map((value) => {
    if (!finite(value) || value < 0 || value > DEPLOYED_RULE_WEIGHT) {
      throw new RangeError(`${name} values must be in [0, ${DEPLOYED_RULE_WEIGHT}]`);
    }
    return Math.round(value * 1000) / 1000;
  }))].sort((a, b) => a - b));
}

function validatePolicy(raw) {
  if (!raw || typeof raw.version !== "string" || !raw.version) throw new TypeError("versioned policy is required");
  const positive = ["minBullRecallImprovement", "minBearRecallImprovement", "minMacroF1Improvement", "minBalancedAccuracyImprovement"];
  const nonNegative = ["maxLogLossRegression", "maxBrierRegression", "maxCalibrationErrorRegression", "maxCatastrophicRateIncrease", "maxCostAdjustedExpectancyRegression", "maxRegimeMetricRegression"];
  for (const key of ["confidenceThreshold", "abstainMinConfidence", "abstainMargin", ...positive, ...nonNegative]) {
    if (!finite(raw[key])) throw new TypeError(`policy.${key} must be finite`);
  }
  if (!(raw.confidenceThreshold > 0 && raw.confidenceThreshold <= 1)) throw new RangeError("policy.confidenceThreshold must be in (0, 1]");
  if (!(raw.abstainMinConfidence > 0 && raw.abstainMinConfidence <= 1)) throw new RangeError("policy.abstainMinConfidence must be in (0, 1]");
  if (!(raw.abstainMargin >= 0 && raw.abstainMargin <= 1)) throw new RangeError("policy.abstainMargin must be in [0, 1]");
  for (const key of positive) if (!(raw[key] > 0)) throw new RangeError(`policy.${key} must be positive`);
  for (const key of nonNegative) if (raw[key] < 0) throw new RangeError(`policy.${key} must be non-negative`);
  for (const key of ["minDevelopmentSamples", "minStageSamples", "minRegimeSamples"]) {
    if (!Number.isInteger(raw[key]) || raw[key] < 3) throw new RangeError(`policy.${key} must be an integer >= 3`);
  }
  return Object.freeze({
    ...raw,
    dynamicRuleWeightGrid: validateGrid(raw.dynamicRuleWeightGrid, "policy.dynamicRuleWeightGrid"),
    regimeRuleWeightGrid: validateGrid(raw.regimeRuleWeightGrid, "policy.regimeRuleWeightGrid"),
  });
}

function validateRecords(records, name, evidenceId, minimum) {
  if (!Array.isArray(records) || records.length < minimum) throw new TypeError(`${name} must contain at least ${minimum} records`);
  records.forEach((record, index) => {
    if (!record?.features || !CLASSES.includes(record?.label?.direction)) throw new TypeError(`${name}[${index}] is invalid`);
    if (!finite(record.ruleScore)) throw new TypeError(`${name}[${index}].ruleScore is required`);
    if (record.frozenEvidenceId !== evidenceId) throw new Error(`${name}[${index}] frozen evidence identity mismatch`);
  });
  return records;
}

function blend(record, model, weight) {
  const result = predictRuleModelBlend(record, model, weight);
  const probabilities = normalize(result.probabilities);
  return Object.freeze({ predicted: topClass(probabilities), probabilities });
}

function modelOnly(record, model) {
  const probabilities = normalize(predictTinyModel(record.features, model).probabilities);
  return Object.freeze({ predicted: topClass(probabilities), probabilities });
}

function parts(record, model) {
  const rule = normalize(scoreToProbabilities(record.ruleScore));
  const modelProbabilities = normalize(predictTinyModel(record.features, model).probabilities);
  return Object.freeze({ rule, model: modelProbabilities, ruleClass: topClass(rule), modelClass: topClass(modelProbabilities) });
}

function agreement(record, model) {
  const p = parts(record, model);
  const probabilities = normalize(freezeEntries(CLASSES.map((name) => [name, (p.rule[name] + p.model[name]) / 2])));
  return Object.freeze({ predicted: p.ruleClass === p.modelClass ? p.modelClass : "abstain", probabilities });
}

function confidence(record, model, policy) {
  const p = parts(record, model);
  const enough = p.modelClass !== "neutral" && p.model[p.modelClass] >= policy.confidenceThreshold;
  const compatible = p.ruleClass === "neutral" || p.ruleClass === p.modelClass;
  const predicted = p.modelClass === "neutral" ? "neutral" : enough && compatible ? p.modelClass : "abstain";
  return Object.freeze({ predicted, probabilities: p.model });
}

function abstainFirst(record, model, policy) {
  const current = blend(record, model, DEPLOYED_RULE_WEIGHT);
  if (current.predicted === "neutral") return current;
  const ordered = CLASSES.map((name) => current.probabilities[name]).sort((a, b) => b - a);
  const pass = current.probabilities[current.predicted] >= policy.abstainMinConfidence && ordered[0] - ordered[1] >= policy.abstainMargin;
  return Object.freeze({ predicted: pass ? current.predicted : "abstain", probabilities: current.probabilities });
}

function regimeKey(record) {
  return `${record.regime ?? "UNKNOWN_REGIME"}::${record.volatilityBucket ?? "UNKNOWN_VOLATILITY"}`;
}

function baseMetrics(records, predictor) {
  const confusion = freezeEntries(CLASSES.map((actual) => [actual, Object.fromEntries(DECISIONS.map((predicted) => [predicted, 0]))]));
  const predictedCounts = Object.fromEntries(DECISIONS.map((name) => [name, 0]));
  const actualCounts = Object.fromEntries(CLASSES.map((name) => [name, 0]));
  const bins = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, correct: 0 }));
  let correct = 0; let logLoss = 0; let brier = 0; let catastrophic = 0; let costTotal = 0; let costN = 0;

  for (const record of records) {
    const prediction = predictor(record);
    if (!DECISIONS.includes(prediction?.predicted)) throw new TypeError("predictor returned invalid class");
    const probabilities = normalize(prediction.probabilities);
    const actual = record.label.direction;
    predictedCounts[prediction.predicted] += 1; actualCounts[actual] += 1; confusion[actual][prediction.predicted] += 1;
    if (prediction.predicted === actual) correct += 1;
    if ((actual === "bullish" && prediction.predicted === "bearish") || (actual === "bearish" && prediction.predicted === "bullish")) catastrophic += 1;
    logLoss -= Math.log(Math.max(probabilities[actual], 1e-12));
    for (const name of CLASSES) brier += (probabilities[name] - (actual === name ? 1 : 0)) ** 2;
    const top = topClass(probabilities); const conf = probabilities[top]; const bin = bins[Math.min(9, Math.floor(conf * 10))];
    bin.count += 1; bin.confidence += conf; bin.correct += top === actual ? 1 : 0;
    const cost = record?.costAdjustedResultByPrediction?.[prediction.predicted];
    if (finite(cost)) { costTotal += cost; costN += 1; }
  }

  const perClass = {};
  for (const name of CLASSES) {
    const tp = confusion[name][name];
    const fp = CLASSES.reduce((sum, actual) => sum + (actual === name ? 0 : confusion[actual][name]), 0);
    const fn = DECISIONS.reduce((sum, predicted) => sum + (predicted === name ? 0 : confusion[name][predicted]), 0);
    const support = DECISIONS.reduce((sum, predicted) => sum + confusion[name][predicted], 0);
    const precision = tp / Math.max(tp + fp, 1); const recall = tp / Math.max(tp + fn, 1);
    perClass[name] = Object.freeze({ support, precision, recall, f1: 2 * precision * recall / Math.max(precision + recall, 1e-12) });
  }
  const ece = bins.reduce((sum, bin) => !bin.count ? sum : sum + (bin.count / records.length) * Math.abs(bin.correct / bin.count - bin.confidence / bin.count), 0);
  const costAvailable = costN === records.length;
  return Object.freeze({
    sampleCount: records.length,
    actualCounts: Object.freeze(actualCounts), predictedCounts: Object.freeze(predictedCounts),
    predictedShares: freezeEntries(DECISIONS.map((name) => [name, predictedCounts[name] / records.length])),
    confusion, perClass: Object.freeze(perClass), accuracy: correct / records.length,
    macroF1: CLASSES.reduce((sum, name) => sum + perClass[name].f1, 0) / CLASSES.length,
    balancedAccuracy: CLASSES.reduce((sum, name) => sum + perClass[name].recall, 0) / CLASSES.length,
    logLoss: logLoss / records.length, brier: brier / records.length, expectedCalibrationError: ece,
    catastrophicDirectionalErrors: Object.freeze({ count: catastrophic, rate: catastrophic / records.length }),
    costAdjusted: Object.freeze({ available: costAvailable, sampleCount: costN, expectancy: costAvailable ? costTotal / records.length : null, total: costAvailable ? costTotal : null }),
  });
}

function grouped(records, predictor, keyFn, minimum) {
  const map = new Map();
  records.forEach((record) => { const key = keyFn(record); if (key != null && key !== "") { if (!map.has(key)) map.set(key, []); map.get(key).push(record); } });
  return freezeEntries([...map.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, rows]) => [key, Object.freeze({ qualified: rows.length >= minimum, sampleCount: rows.length, metrics: baseMetrics(rows, predictor) })]));
}

function evaluate(records, predictor, policy) {
  return Object.freeze({
    ...baseMetrics(records, predictor),
    bySymbol: grouped(records, predictor, (r) => r.symbol, policy.minRegimeSamples),
    byTimeframe: grouped(records, predictor, (r) => r.timeframe, policy.minRegimeSamples),
    byRegime: grouped(records, predictor, (r) => r.regime, policy.minRegimeSamples),
    byVolatilityBucket: grouped(records, predictor, (r) => r.volatilityBucket, policy.minRegimeSamples),
  });
}

function compare(baseline, candidate) {
  return Object.freeze({
    bullRecallDelta: candidate.perClass.bullish.recall - baseline.perClass.bullish.recall,
    bearRecallDelta: candidate.perClass.bearish.recall - baseline.perClass.bearish.recall,
    neutralRecallDelta: candidate.perClass.neutral.recall - baseline.perClass.neutral.recall,
    macroF1Delta: candidate.macroF1 - baseline.macroF1,
    balancedAccuracyDelta: candidate.balancedAccuracy - baseline.balancedAccuracy,
    logLossImprovement: baseline.logLoss - candidate.logLoss,
    brierImprovement: baseline.brier - candidate.brier,
    calibrationErrorImprovement: baseline.expectedCalibrationError - candidate.expectedCalibrationError,
    catastrophicDirectionalErrorRateDelta: candidate.catastrophicDirectionalErrors.rate - baseline.catastrophicDirectionalErrors.rate,
    costAdjustedExpectancyDelta: baseline.costAdjusted.available && candidate.costAdjusted.available ? candidate.costAdjusted.expectancy - baseline.costAdjusted.expectancy : null,
  });
}

function gate(baseline, candidate, policy) {
  const delta = compare(baseline, candidate); const reasons = [];
  if (candidate.sampleCount < policy.minStageSamples) reasons.push("insufficient_sample");
  if (delta.bullRecallDelta < policy.minBullRecallImprovement) reasons.push("bull_recall_improvement_insufficient");
  if (delta.bearRecallDelta < policy.minBearRecallImprovement) reasons.push("bear_recall_improvement_insufficient");
  if (delta.macroF1Delta < policy.minMacroF1Improvement) reasons.push("macro_f1_improvement_insufficient");
  if (delta.balancedAccuracyDelta < policy.minBalancedAccuracyImprovement) reasons.push("balanced_accuracy_improvement_insufficient");
  if (candidate.logLoss > baseline.logLoss + policy.maxLogLossRegression) reasons.push("log_loss_regressed");
  if (candidate.brier > baseline.brier + policy.maxBrierRegression) reasons.push("brier_regressed");
  if (candidate.expectedCalibrationError > baseline.expectedCalibrationError + policy.maxCalibrationErrorRegression) reasons.push("calibration_error_regressed");
  if (candidate.catastrophicDirectionalErrors.rate > baseline.catastrophicDirectionalErrors.rate + policy.maxCatastrophicRateIncrease) reasons.push("catastrophic_directional_error_increased");
  if (!baseline.costAdjusted.available || !candidate.costAdjusted.available) reasons.push("cost_adjusted_evidence_missing");
  else if (candidate.costAdjusted.expectancy < baseline.costAdjusted.expectancy - policy.maxCostAdjustedExpectancyRegression) reasons.push("cost_adjusted_expectancy_regressed");
  let qualifiedRegimes = 0;
  for (const key of [...new Set([...Object.keys(baseline.byRegime), ...Object.keys(candidate.byRegime)])]) {
    const left = baseline.byRegime[key]; const right = candidate.byRegime[key];
    if (!left?.qualified || !right?.qualified) continue;
    qualifiedRegimes += 1;
    if (right.metrics.macroF1 < left.metrics.macroF1 - policy.maxRegimeMetricRegression || right.metrics.balancedAccuracy < left.metrics.balancedAccuracy - policy.maxRegimeMetricRegression || right.metrics.catastrophicDirectionalErrors.rate > left.metrics.catastrophicDirectionalErrors.rate + policy.maxCatastrophicRateIncrease) reasons.push(`regime_regression:${key}`);
  }
  if (!qualifiedRegimes) reasons.push("regime_robustness_insufficient");
  return Object.freeze({ passed: reasons.length === 0, reasons: Object.freeze([...new Set(reasons)]), comparison: delta, qualifiedRegimes });
}

function sortCandidates(a, b) {
  return b.metrics.macroF1 - a.metrics.macroF1 || b.metrics.balancedAccuracy - a.metrics.balancedAccuracy || (b.metrics.perClass.bullish.recall + b.metrics.perClass.bearish.recall) - (a.metrics.perClass.bullish.recall + a.metrics.perClass.bearish.recall) || a.metrics.expectedCalibrationError - b.metrics.expectedCalibrationError || a.metrics.logLoss - b.metrics.logLoss || String(a.id).localeCompare(String(b.id));
}

function selectWeight(records, model, grid, policy) {
  const baseline = evaluate(records, (r) => blend(r, model, DEPLOYED_RULE_WEIGHT), policy);
  const rows = grid.filter((weight) => weight !== DEPLOYED_RULE_WEIGHT).map((weight) => {
    const metrics = evaluate(records, (r) => blend(r, model, weight), policy);
    return Object.freeze({ id: `weight:${weight}`, weight, metrics, gate: gate(baseline, metrics, policy) });
  });
  return rows.filter((row) => row.gate.passed).sort(sortCandidates)[0] ?? null;
}

function predictors(development, model, policy) {
  const dynamic = selectWeight(development, model, policy.dynamicRuleWeightGrid, policy);
  const buckets = new Map(); development.forEach((r) => { const key = regimeKey(r); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(r); });
  const regimeWeights = {};
  for (const [key, rows] of buckets) {
    if (rows.length < policy.minRegimeSamples) { regimeWeights[key] = null; continue; }
    const localPolicy = { ...policy, minStageSamples: Math.min(policy.minStageSamples, rows.length), minRegimeSamples: Math.min(policy.minRegimeSamples, rows.length) };
    regimeWeights[key] = selectWeight(rows, model, policy.regimeRuleWeightGrid, localPolicy)?.weight ?? null;
  }
  const none = (r) => Object.freeze({ predicted: "abstain", probabilities: blend(r, model, DEPLOYED_RULE_WEIGHT).probabilities });
  return Object.freeze({
    CURRENT_FIXED_BLEND: Object.freeze({ promotable: false, parameters: Object.freeze({ ruleWeight: DEPLOYED_RULE_WEIGHT, modelWeight: 1 - DEPLOYED_RULE_WEIGHT }), predict: (r) => blend(r, model, DEPLOYED_RULE_WEIGHT) }),
    MODEL_ONLY_DIAGNOSTIC: Object.freeze({ promotable: false, parameters: Object.freeze({ diagnosticOnly: true }), predict: (r) => modelOnly(r, model) }),
    AGREEMENT_GATE: Object.freeze({ promotable: true, parameters: Object.freeze({ requireRuleModelClassAgreement: true }), predict: (r) => agreement(r, model) }),
    CONFIDENCE_GATE: Object.freeze({ promotable: true, parameters: Object.freeze({ confidenceThreshold: policy.confidenceThreshold }), predict: (r) => confidence(r, model, policy) }),
    DYNAMIC_CALIBRATED_BLEND: Object.freeze({ promotable: !!dynamic, parameters: Object.freeze({ selectedRuleWeight: dynamic?.weight ?? null, selectionSource: "development_only", calibrationPolicyVersion: policy.version }), predict: dynamic ? (r) => blend(r, model, dynamic.weight) : none }),
    REGIME_AWARE_COMBINATION: Object.freeze({ promotable: Object.values(regimeWeights).some((v) => v != null), parameters: Object.freeze({ regimeWeights: Object.freeze(regimeWeights), selectionSource: "development_only", calibrationPolicyVersion: policy.version }), predict: (r) => regimeWeights[regimeKey(r)] == null ? none(r) : blend(r, model, regimeWeights[regimeKey(r)]) }),
    ABSTAIN_FIRST: Object.freeze({ promotable: true, parameters: Object.freeze({ minConfidence: policy.abstainMinConfidence, minMargin: policy.abstainMargin }), predict: (r) => abstainFirst(r, model, policy) }),
  });
}

function evaluateMethods(records, descriptors, policy) {
  const baseline = evaluate(records, descriptors.CURRENT_FIXED_BLEND.predict, policy);
  return freezeEntries(SHADOW_DIRECTIONAL_METHODS.map((name) => {
    const descriptor = descriptors[name]; const metrics = evaluate(records, descriptor.predict, policy);
    let resultGate;
    if (name === "CURRENT_FIXED_BLEND") resultGate = Object.freeze({ passed: false, reasons: Object.freeze(["deployed_baseline_not_a_challenger"]), comparison: compare(baseline, metrics) });
    else if (name === "MODEL_ONLY_DIAGNOSTIC") resultGate = Object.freeze({ passed: false, reasons: Object.freeze(["diagnostic_only_never_promotable"]), comparison: compare(baseline, metrics) });
    else if (!descriptor.promotable) resultGate = Object.freeze({ passed: false, reasons: Object.freeze(["development_selection_failed_closed"]), comparison: compare(baseline, metrics) });
    else resultGate = gate(baseline, metrics, policy);
    return [name, Object.freeze({ promotable: descriptor.promotable && name !== "MODEL_ONLY_DIAGNOSTIC", parameters: descriptor.parameters, metrics, gate: resultGate })];
  }));
}

function chooseMethod(methods) {
  return SHADOW_DIRECTIONAL_METHODS.filter((name) => !["CURRENT_FIXED_BLEND", "MODEL_ONLY_DIAGNOSTIC"].includes(name)).map((name) => Object.freeze({ id: name, ...methods[name] })).filter((row) => row.promotable && row.gate.passed).sort(sortCandidates)[0] ?? null;
}

function stage(records, descriptors, method, policy) {
  const methods = evaluateMethods(records, descriptors, policy); const selected = method ? methods[method] : null;
  return Object.freeze({ sampleCount: records.length, methods, selectedMethod: method, selectedGate: selected?.gate ?? Object.freeze({ passed: false, reasons: Object.freeze(["no_development_selected_method"]) }) });
}

export function buildShadowDirectionalRecoveryComparison({ frozenEvidenceId, model, policy: rawPolicy, developmentRecords, oosRecords, purgedWalkForwardRecords = null, costStressRecords = null, regimeStressRecords = null, finalHoldoutRecords = null } = {}) {
  if (typeof frozenEvidenceId !== "string" || !frozenEvidenceId) throw new TypeError("frozenEvidenceId is required");
  if (!model?.trained || typeof model.id !== "string") throw new TypeError("trained model is required");
  const policy = validatePolicy(rawPolicy);
  const development = validateRecords(developmentRecords, "developmentRecords", frozenEvidenceId, policy.minDevelopmentSamples);
  const oos = validateRecords(oosRecords, "oosRecords", frozenEvidenceId, policy.minStageSamples);
  const optional = { purgedWalkForward: purgedWalkForwardRecords, costStress: costStressRecords, regimeStress: regimeStressRecords, finalHoldout: finalHoldoutRecords };
  for (const [name, rows] of Object.entries(optional)) if (rows != null) validateRecords(rows, `${name}Records`, frozenEvidenceId, policy.minStageSamples);

  const descriptors = predictors(development, model, policy); const developmentMethods = evaluateMethods(development, descriptors, policy); const selected = chooseMethod(developmentMethods); const selectedMethod = selected?.id ?? null;
  const stages = { development: Object.freeze({ sampleCount: development.length, methods: developmentMethods, selectedMethod, selectedGate: selected?.gate ?? Object.freeze({ passed: false, reasons: Object.freeze(["no_admissible_development_method"]) }) }), oos: stage(oos, descriptors, selectedMethod, policy) };
  for (const [name, rows] of Object.entries(optional)) stages[name] = rows == null ? null : stage(rows, descriptors, selectedMethod, policy);

  const reasons = [];
  if (!selectedMethod) reasons.push("no_admissible_development_method");
  if (!stages.oos.selectedGate.passed) reasons.push(...stages.oos.selectedGate.reasons.map((r) => `oos:${r}`));
  for (const name of ["purgedWalkForward", "costStress", "regimeStress", "finalHoldout"]) {
    if (!stages[name]) reasons.push(`missing_stage:${name}`);
    else if (!stages[name].selectedGate.passed) reasons.push(...stages[name].selectedGate.reasons.map((r) => `${name}:${r}`));
  }
  const ready = reasons.length === 0;
  return Object.freeze({
    schemaVersion: 1, status: ready ? "frozen_candidate_ready_for_shadow_canary" : "research_hold", reason: ready ? null : "directional_recovery_gates_incomplete_or_failed", reasons: Object.freeze([...new Set(reasons)]),
    frozenEvidenceId, modelId: model.id, policyVersion: policy.version, requiredStageOrder: SHADOW_DIRECTIONAL_STAGE_ORDER,
    selection: Object.freeze({ source: "development_only", selectedMethod, selectedParameters: selectedMethod ? descriptors[selectedMethod].parameters : null, oosUsedForSelection: false, purgedWalkForwardUsedForSelection: false, costStressUsedForSelection: false, regimeStressUsedForSelection: false, finalHoldoutUsedForSelection: false, shadowUsedForSelection: false }),
    stages: Object.freeze(stages), nextStage: ready ? "NEW_NATURAL_SHADOW_CANARY" : "RESEARCH_HOLD",
    safety: Object.freeze({ executionAuthority: "NONE", runtimeChanged: false, deployedBlendChanged: false, thresholdChanged: false, classWeightChanged: false, labelChanged: false, modelOnlyPromotionEligible: false, liveTrading: false, autoTrading: false, realOrderEnabled: false, privateTradingApiAllowed: false, transferEnabled: false, withdrawalEnabled: false, orderCount: 0, cancelCount: 0, amendCount: 0, transferCount: 0, withdrawalCount: 0 }),
  });
}

export const SHADOW_DIRECTIONAL_CLASSES = CLASSES;

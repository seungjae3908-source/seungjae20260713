const DIRECTIONS = Object.freeze(["LONG", "NEUTRAL", "SHORT"]);
const ACTIONABLE = new Set(["LONG", "SHORT"]);
const REGIMES = Object.freeze(["BULL", "SIDEWAYS", "BEAR", "UNKNOWN"]);

export const SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY = Object.freeze({
  diagnosticsOnly: true,
  thresholdModified: false,
  modelModified: false,
  labelModified: false,
  classWeightModified: false,
  blendWeightModified: false,
  finalHoldoutOptimizationAllowed: false,
  historicalBackfillPromotionCredit: 0,
  syntheticPromotionCredit: 0,
  profitabilityCredit: 0,
  promotionCredit: 0,
  LIVE_TRADING: false,
  PRIVATE_TRADING_API_ALLOWED: false,
  executionAuthority: "NONE",
  orderSubmitted: false,
});

function direction(value, field) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (["LONG", "BULL", "BULLISH"].includes(normalized)) return "LONG";
  if (["SHORT", "BEAR", "BEARISH"].includes(normalized)) return "SHORT";
  if (["NEUTRAL", "NONE", "NO_TRADE", "FLAT"].includes(normalized)) return "NEUTRAL";
  throw new TypeError(`${field} must be LONG/NEUTRAL/SHORT`);
}

function actualDirection(value) {
  if (value == null || value === "") return null;
  return direction(value, "actualDirection");
}

function regime(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (/(BULL|UPTREND|RISING)/.test(normalized)) return "BULL";
  if (/(BEAR|DOWNTREND|FALLING)/.test(normalized)) return "BEAR";
  if (/(SIDEWAYS|RANGE|FLAT)/.test(normalized)) return "SIDEWAYS";
  return "UNKNOWN";
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function distribution(rows, field) {
  const counts = { LONG: 0, NEUTRAL: 0, SHORT: 0 };
  rows.forEach((row) => { counts[row[field]] += 1; });
  return Object.freeze({
    ...counts,
    total: rows.length,
    longRate: ratio(counts.LONG, rows.length),
    neutralRate: ratio(counts.NEUTRAL, rows.length),
    shortRate: ratio(counts.SHORT, rows.length),
    actionableRate: ratio(counts.LONG + counts.SHORT, rows.length),
  });
}

function directionalQuality(rows, field) {
  const settled = rows.filter((row) => row.actualDirection !== null);
  const matrix = Object.fromEntries(DIRECTIONS.map((actual) => [actual, Object.fromEntries(DIRECTIONS.map((predicted) => [predicted, 0]))]));
  settled.forEach((row) => { matrix[row.actualDirection][row[field]] += 1; });
  const perClass = {};
  for (const name of DIRECTIONS) {
    const tp = matrix[name][name];
    const support = DIRECTIONS.reduce((sum, predicted) => sum + matrix[name][predicted], 0);
    const predictedSupport = DIRECTIONS.reduce((sum, actual) => sum + matrix[actual][name], 0);
    const fp = predictedSupport - tp;
    const fn = support - tp;
    const precision = predictedSupport ? tp / predictedSupport : null;
    const recall = support ? tp / support : null;
    const f1 = (2 * tp + fp + fn) > 0 ? (2 * tp) / (2 * tp + fp + fn) : null;
    perClass[name] = Object.freeze({ support, predictedSupport, precision, recall, f1 });
  }
  const supported = DIRECTIONS.filter((name) => perClass[name].support > 0);
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return Object.freeze({
    settledN: settled.length,
    confusionMatrix: Object.freeze(Object.fromEntries(Object.entries(matrix).map(([key, value]) => [key, Object.freeze(value)]))),
    perClass: Object.freeze(perClass),
    macroF1: mean(supported.map((name) => perClass[name].f1)),
    balancedAccuracy: mean(supported.map((name) => perClass[name].recall)),
  });
}

function normalizeObservation(raw, timeframe) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("observation must be an object");
  const id = String(raw.id ?? "").trim();
  if (!id) throw new TypeError("observation id is required");
  if (String(raw.timeframe ?? "") !== timeframe) throw new Error(`mixed timeframe is forbidden: ${raw.timeframe ?? "MISSING"}`);
  return Object.freeze({
    id,
    timeframe,
    actualDirection: actualDirection(raw.actualDirection),
    ruleDirection: direction(raw.ruleDirection, "ruleDirection"),
    modelDirection: direction(raw.modelDirection, "modelDirection"),
    blendDirection: direction(raw.blendDirection, "blendDirection"),
    regime: regime(raw.regime),
  });
}

function support(rows, field, expectedValues) {
  return Object.freeze(Object.fromEntries(expectedValues.map((value) => [value, rows.filter((row) => row[field] === value).length])));
}

export function buildShadowBlendCollapseDiagnostic({
  observations,
  timeframe = "15m",
  minSettledN = 12,
  declaredBlendWeights = Object.freeze({ rule: 0.65, model: 0.35 }),
  researchCodeSha = null,
  generatedAt = Date.now(),
} = {}) {
  if (!Array.isArray(observations) || observations.length === 0) throw new Error("shadow blend observations are required");
  if (timeframe !== "15m") throw new Error("this diagnostic is intentionally scoped to 15m only");
  if (!Number.isInteger(minSettledN) || minSettledN < 3) throw new TypeError("minSettledN must be an integer >= 3");
  if (researchCodeSha != null && !/^[0-9a-f]{40}$/u.test(researchCodeSha)) throw new TypeError("researchCodeSha must be a 40-character lowercase SHA");
  const ruleWeight = declaredBlendWeights?.rule;
  const modelWeight = declaredBlendWeights?.model;
  if (!Number.isFinite(ruleWeight) || !Number.isFinite(modelWeight) || Math.abs(ruleWeight + modelWeight - 1) > 1e-9 || ruleWeight < 0 || modelWeight < 0) {
    throw new TypeError("declared blend weights must be non-negative and sum to one");
  }

  const rows = observations.map((row) => normalizeObservation(row, timeframe));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("duplicate observation id is forbidden");

  const settled = rows.filter((row) => row.actualDirection !== null);
  const rule = Object.freeze({ distribution: distribution(rows, "ruleDirection"), quality: directionalQuality(rows, "ruleDirection") });
  const model = Object.freeze({ distribution: distribution(rows, "modelDirection"), quality: directionalQuality(rows, "modelDirection") });
  const blend = Object.freeze({ distribution: distribution(rows, "blendDirection"), quality: directionalQuality(rows, "blendDirection") });

  const disagreements = rows.filter((row) => row.ruleDirection !== row.modelDirection);
  const upstreamActionable = rows.filter((row) => ACTIONABLE.has(row.ruleDirection) || ACTIONABLE.has(row.modelDirection));
  const neutralized = upstreamActionable.filter((row) => row.blendDirection === "NEUTRAL");
  const modelOnlyActionable = rows.filter((row) => row.ruleDirection === "NEUTRAL" && ACTIONABLE.has(row.modelDirection));
  const modelOnlySuppressed = modelOnlyActionable.filter((row) => row.blendDirection === "NEUTRAL");
  const ruleOnlyActionable = rows.filter((row) => row.modelDirection === "NEUTRAL" && ACTIONABLE.has(row.ruleDirection));
  const ruleOnlySuppressed = ruleOnlyActionable.filter((row) => row.blendDirection === "NEUTRAL");
  const opposed = rows.filter((row) => ACTIONABLE.has(row.ruleDirection) && ACTIONABLE.has(row.modelDirection) && row.ruleDirection !== row.modelDirection);
  const opposedNeutralized = opposed.filter((row) => row.blendDirection === "NEUTRAL");
  const agreedActionable = rows.filter((row) => ACTIONABLE.has(row.ruleDirection) && row.ruleDirection === row.modelDirection);
  const agreedRetained = agreedActionable.filter((row) => row.blendDirection === row.ruleDirection);

  const disagreementFollowsRule = disagreements.filter((row) => row.blendDirection === row.ruleDirection).length;
  const disagreementFollowsModel = disagreements.filter((row) => row.blendDirection === row.modelDirection).length;
  const disagreementNeutral = disagreements.filter((row) => row.blendDirection === "NEUTRAL").length;

  const actualSupport = support(settled, "actualDirection", DIRECTIONS);
  const regimeSupport = support(rows, "regime", REGIMES);
  const missingActualClasses = DIRECTIONS.filter((name) => actualSupport[name] === 0);
  const missingRegimes = ["BULL", "SIDEWAYS", "BEAR"].filter((name) => regimeSupport[name] === 0);

  const metrics = Object.freeze({
    sampleN: rows.length,
    settledN: settled.length,
    ruleModelDisagreementN: disagreements.length,
    ruleModelDisagreementRate: ratio(disagreements.length, rows.length),
    upstreamActionableN: upstreamActionable.length,
    upstreamActionableNeutralizedByBlendN: neutralized.length,
    upstreamActionableNeutralizedByBlendRate: ratio(neutralized.length, upstreamActionable.length),
    modelOnlyActionableN: modelOnlyActionable.length,
    modelOnlyActionableSuppressedN: modelOnlySuppressed.length,
    modelOnlyActionableSuppressionRate: ratio(modelOnlySuppressed.length, modelOnlyActionable.length),
    ruleOnlyActionableN: ruleOnlyActionable.length,
    ruleOnlyActionableSuppressedN: ruleOnlySuppressed.length,
    ruleOnlyActionableSuppressionRate: ratio(ruleOnlySuppressed.length, ruleOnlyActionable.length),
    opposingActionableN: opposed.length,
    opposingActionableNeutralizedN: opposedNeutralized.length,
    opposingActionableNeutralizedRate: ratio(opposedNeutralized.length, opposed.length),
    agreedActionableN: agreedActionable.length,
    agreedActionableRetentionRate: ratio(agreedRetained.length, agreedActionable.length),
    disagreementFollowsRuleRate: ratio(disagreementFollowsRule, disagreements.length),
    disagreementFollowsModelRate: ratio(disagreementFollowsModel, disagreements.length),
    disagreementNeutralRate: ratio(disagreementNeutral, disagreements.length),
  });

  let failureModeVerdict = "NO_SINGLE_FAILURE_MODE_PROVEN";
  if (settled.length < minSettledN) {
    failureModeVerdict = "NOT_EVALUABLE_INSUFFICIENT_SETTLED";
  } else if (modelOnlyActionable.length >= 3 && metrics.modelOnlyActionableSuppressionRate >= 0.6) {
    failureModeVerdict = "BLEND_ARBITRATION_SUPPRESSES_MODEL_ONLY_ACTIONABLE";
  } else if (rule.distribution.neutralRate >= 0.75 && blend.distribution.neutralRate >= 0.6 && model.distribution.neutralRate < 0.5) {
    failureModeVerdict = "RULE_NEUTRAL_DOMINANCE_PROPAGATES_TO_BLEND";
  } else if (upstreamActionable.length >= 3 && metrics.upstreamActionableNeutralizedByBlendRate >= 0.5) {
    failureModeVerdict = "BLEND_ARBITRATION_NEUTRALIZATION";
  } else if (model.distribution.neutralRate >= 0.75 && blend.distribution.neutralRate >= 0.6) {
    failureModeVerdict = "MODEL_NEUTRAL_COLLAPSE_PROPAGATES_TO_BLEND";
  }

  const limitations = [];
  if (settled.length < minSettledN) limitations.push("insufficient_settled_sample");
  if (missingActualClasses.length) limitations.push("actual_class_coverage_incomplete");
  if (missingRegimes.length) limitations.push("regime_coverage_incomplete");
  limitations.push("diagnostic_association_is_not_causal_proof", "no_threshold_or_blend_weight_retuning_authorized");

  return Object.freeze({
    schemaVersion: 1,
    kind: "shadow-15m-blend-collapse-diagnostic",
    timeframe,
    generatedAt,
    researchCodeSha,
    declaredBlendWeights: Object.freeze({ rule: ruleWeight, model: modelWeight }),
    evaluationStatus: settled.length >= minSettledN ? "EVALUABLE_DIAGNOSTIC_ONLY" : "NOT_EVALUABLE",
    failureModeVerdict,
    causalProof: false,
    lanes: Object.freeze({ rule, model, blend }),
    metrics,
    coverage: Object.freeze({ actualSupport, regimeSupport, missingActualClasses: Object.freeze(missingActualClasses), missingRegimes: Object.freeze(missingRegimes) }),
    limitations: Object.freeze(limitations),
    nextEvidenceNeeded: Object.freeze([
      "genuine future Shadow observations with stable exact strategy/model identity",
      "sufficient settled support across LONG/NEUTRAL/SHORT",
      "Bull/Sideways/Bear regime coverage before regime claims",
      "provenance-valid TRAIN/VALIDATION reference evidence before drift causality claims",
    ]),
    safety: SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY,
  });
}

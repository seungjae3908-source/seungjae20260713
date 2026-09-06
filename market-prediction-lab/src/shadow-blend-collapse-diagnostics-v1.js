import { createHash } from "node:crypto";
import { evaluateRules, scoreToProbabilities } from "./rules.js";
import { predictTinyModel } from "./tiny-model.js";
import {
  DEPLOYED_MODEL_WEIGHT,
  DEPLOYED_RULE_WEIGHT,
  blendDeployedProbabilities,
} from "./deployment-inference.js";

const DIRECTIONS = Object.freeze(["LONG", "NEUTRAL", "SHORT"]);
const ACTIONABLE = new Set(["LONG", "SHORT"]);
const REGIMES = Object.freeze(["BULL", "SIDEWAYS", "BEAR", "UNKNOWN"]);
const CLASSES = Object.freeze(["bullish", "neutral", "bearish"]);
const RECONSTRUCTION_TOLERANCE = 1e-6;

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

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseJsonBytes(bytes, label) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError(`${label} bytes are required`);
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

function direction(value, field) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (["LONG", "BULL", "BULLISH"].includes(normalized)) return "LONG";
  if (["SHORT", "BEAR", "BEARISH"].includes(normalized)) return "SHORT";
  if (["NEUTRAL", "NONE", "NO_TRADE", "FLAT"].includes(normalized)) return "NEUTRAL";
  throw new TypeError(`${field} must be LONG/NEUTRAL/SHORT`);
}

function classDirection(probabilities) {
  if (!probabilities || CLASSES.some((name) => !finite(probabilities[name]))) throw new TypeError("probabilities are invalid");
  const best = CLASSES.reduce((current, name) => probabilities[name] > probabilities[current] ? name : current, CLASSES[0]);
  return direction(best, "probability class");
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

function quantile(values, probability) {
  const sorted = values.filter(finite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function summarizeValues(values) {
  const numeric = values.filter(finite);
  return Object.freeze({
    n: numeric.length,
    min: numeric.length ? Math.min(...numeric) : null,
    p05: quantile(numeric, 0.05),
    p25: quantile(numeric, 0.25),
    p50: quantile(numeric, 0.5),
    p75: quantile(numeric, 0.75),
    p95: quantile(numeric, 0.95),
    max: numeric.length ? Math.max(...numeric) : null,
    mean: mean(numeric),
  });
}

function probabilityShape(rows, field) {
  const vectors = rows.map((row) => row[field]).filter(Boolean);
  if (!vectors.length) return null;
  const top1 = [];
  const top2 = [];
  const margin = [];
  const entropy = [];
  for (const vector of vectors) {
    const ranked = CLASSES.map((name) => vector[name]).sort((left, right) => right - left);
    top1.push(ranked[0]);
    top2.push(ranked[1]);
    margin.push(ranked[0] - ranked[1]);
    entropy.push(-CLASSES.reduce((sum, name) => sum + (vector[name] > 0 ? vector[name] * Math.log(vector[name]) : 0), 0));
  }
  return Object.freeze({
    count: vectors.length,
    bullish: summarizeValues(vectors.map((row) => row.bullish)),
    neutral: summarizeValues(vectors.map((row) => row.neutral)),
    bearish: summarizeValues(vectors.map((row) => row.bearish)),
    top1: summarizeValues(top1),
    top2: summarizeValues(top2),
    margin: summarizeValues(margin),
    entropy: summarizeValues(entropy),
  });
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
    const f1 = support && (2 * tp + fp + fn) > 0 ? (2 * tp) / (2 * tp + fp + fn) : (support ? 0 : null);
    perClass[name] = Object.freeze({ support, predictedSupport, precision, recall, f1 });
  }
  const supported = DIRECTIONS.filter((name) => perClass[name].support > 0);
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
    symbol: raw.symbol ? String(raw.symbol) : null,
    anchorTimestamp: Number.isInteger(raw.anchorTimestamp) ? raw.anchorTimestamp : null,
    actualDirection: actualDirection(raw.actualDirection),
    ruleDirection: direction(raw.ruleDirection, "ruleDirection"),
    modelDirection: direction(raw.modelDirection, "modelDirection"),
    blendDirection: direction(raw.blendDirection, "blendDirection"),
    regime: regime(raw.regime),
    ruleScore: finite(raw.ruleScore) ? raw.ruleScore : null,
    ruleProbabilities: raw.ruleProbabilities ?? null,
    modelProbabilities: raw.modelProbabilities ?? null,
    blendProbabilities: raw.blendProbabilities ?? null,
    reconstructionError: finite(raw.reconstructionError) ? raw.reconstructionError : null,
  });
}

function support(rows, field, expectedValues) {
  return Object.freeze(Object.fromEntries(expectedValues.map((value) => [value, rows.filter((row) => row[field] === value).length])));
}

function suppressionMetrics(rows) {
  const disagreements = rows.filter((row) => row.ruleDirection !== row.modelDirection);
  const upstreamActionable = rows.filter((row) => ACTIONABLE.has(row.ruleDirection) || ACTIONABLE.has(row.modelDirection));
  const neutralized = upstreamActionable.filter((row) => row.blendDirection === "NEUTRAL");
  const modelOnlyActionable = rows.filter((row) => row.ruleDirection === "NEUTRAL" && ACTIONABLE.has(row.modelDirection));
  const modelOnlySuppressed = modelOnlyActionable.filter((row) => row.blendDirection === "NEUTRAL");
  const ruleOnlyActionable = rows.filter((row) => row.modelDirection === "NEUTRAL" && ACTIONABLE.has(row.ruleDirection));
  const ruleOnlySuppressed = ruleOnlyActionable.filter((row) => row.blendDirection === "NEUTRAL");
  const opposed = rows.filter((row) => ACTIONABLE.has(row.ruleDirection) && ACTIONABLE.has(row.modelDirection) && row.ruleDirection !== row.modelDirection);
  const agreed = rows.filter((row) => ACTIONABLE.has(row.ruleDirection) && row.ruleDirection === row.modelDirection);
  return Object.freeze({
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
    opposingActionableNeutralizedN: opposed.filter((row) => row.blendDirection === "NEUTRAL").length,
    agreedActionableN: agreed.length,
    agreedActionableRetentionRate: ratio(agreed.filter((row) => row.blendDirection === row.ruleDirection).length, agreed.length),
    disagreementFollowsRuleRate: ratio(disagreements.filter((row) => row.blendDirection === row.ruleDirection).length, disagreements.length),
    disagreementFollowsModelRate: ratio(disagreements.filter((row) => row.blendDirection === row.modelDirection).length, disagreements.length),
    disagreementNeutralRate: ratio(disagreements.filter((row) => row.blendDirection === "NEUTRAL").length, disagreements.length),
  });
}

function compactSlice(rows) {
  return Object.freeze({
    sampleN: rows.length,
    rule: Object.freeze({ distribution: distribution(rows, "ruleDirection"), quality: directionalQuality(rows, "ruleDirection") }),
    model: Object.freeze({ distribution: distribution(rows, "modelDirection"), quality: directionalQuality(rows, "modelDirection") }),
    blend: Object.freeze({ distribution: distribution(rows, "blendDirection"), quality: directionalQuality(rows, "blendDirection") }),
    suppression: suppressionMetrics(rows),
  });
}

function temporalThirds(rows) {
  const sorted = rows.filter((row) => Number.isInteger(row.anchorTimestamp)).sort((left, right) => left.anchorTimestamp - right.anchorTimestamp || left.id.localeCompare(right.id));
  if (!sorted.length) return null;
  const firstEnd = Math.ceil(sorted.length / 3);
  const secondEnd = Math.ceil(sorted.length * 2 / 3);
  return Object.freeze({
    oldest: compactSlice(sorted.slice(0, firstEnd)),
    middle: compactSlice(sorted.slice(firstEnd, secondEnd)),
    newest: compactSlice(sorted.slice(secondEnd)),
  });
}

export function buildShadowBlendCollapseDiagnostic({
  observations,
  timeframe = "15m",
  minSettledN = 12,
  declaredBlendWeights = Object.freeze({ rule: DEPLOYED_RULE_WEIGHT, model: DEPLOYED_MODEL_WEIGHT }),
  researchCodeSha = null,
  generatedAt = Date.now(),
} = {}) {
  if (!Array.isArray(observations) || observations.length === 0) throw new Error("shadow blend observations are required");
  if (timeframe !== "15m") throw new Error("this diagnostic is intentionally scoped to 15m only");
  if (!Number.isInteger(minSettledN) || minSettledN < 3) throw new TypeError("minSettledN must be an integer >= 3");
  if (researchCodeSha != null && !/^[0-9a-f]{40}$/u.test(researchCodeSha)) throw new TypeError("researchCodeSha must be a 40-character lowercase SHA");
  const ruleWeight = declaredBlendWeights?.rule;
  const modelWeight = declaredBlendWeights?.model;
  if (ruleWeight !== DEPLOYED_RULE_WEIGHT || modelWeight !== DEPLOYED_MODEL_WEIGHT) throw new Error("declared blend weights do not match frozen deployed contract");

  const rows = observations.map((row) => normalizeObservation(row, timeframe));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("duplicate observation id is forbidden");
  const settled = rows.filter((row) => row.actualDirection !== null);
  const root = compactSlice(rows);
  const actualSupport = support(settled, "actualDirection", DIRECTIONS);
  const regimeSupport = support(rows, "regime", REGIMES);
  const missingActualClasses = DIRECTIONS.filter((name) => actualSupport[name] === 0);
  const missingRegimes = ["BULL", "SIDEWAYS", "BEAR"].filter((name) => regimeSupport[name] === 0);

  let failureModeVerdict = "NO_SINGLE_FAILURE_MODE_PROVEN";
  if (settled.length < minSettledN) failureModeVerdict = "NOT_EVALUABLE_INSUFFICIENT_SETTLED";
  else if (root.rule.distribution.neutralRate >= 0.75 && root.blend.distribution.neutralRate >= 0.6 && root.model.distribution.neutralRate < 0.5) failureModeVerdict = "RULE_NEUTRAL_DOMINANCE_PROPAGATES_TO_BLEND";
  else if (root.suppression.modelOnlyActionableN >= 3 && root.suppression.modelOnlyActionableSuppressionRate >= 0.6) failureModeVerdict = "BLEND_ARBITRATION_SUPPRESSES_MODEL_ONLY_ACTIONABLE";
  else if (root.suppression.upstreamActionableN >= 3 && root.suppression.upstreamActionableNeutralizedByBlendRate >= 0.5) failureModeVerdict = "BLEND_ARBITRATION_NEUTRALIZATION";
  else if (root.model.distribution.neutralRate >= 0.75 && root.blend.distribution.neutralRate >= 0.6) failureModeVerdict = "MODEL_NEUTRAL_COLLAPSE_PROPAGATES_TO_BLEND";

  const bySymbol = Object.freeze(Object.fromEntries([...new Set(rows.map((row) => row.symbol).filter(Boolean))].sort().map((symbol) => [symbol, compactSlice(rows.filter((row) => row.symbol === symbol))])));
  const byRegime = Object.freeze(Object.fromEntries(REGIMES.map((name) => [name, compactSlice(rows.filter((row) => row.regime === name))])));
  const limitations = [];
  if (settled.length < minSettledN) limitations.push("insufficient_settled_sample");
  if (missingActualClasses.length) limitations.push("actual_class_coverage_incomplete");
  if (missingRegimes.length) limitations.push("regime_coverage_incomplete");
  limitations.push("no_threshold_or_blend_weight_retuning_authorized");

  return Object.freeze({
    schemaVersion: 2,
    kind: "shadow-15m-blend-collapse-diagnostic",
    timeframe,
    generatedAt,
    researchCodeSha,
    declaredBlendWeights: Object.freeze({ rule: ruleWeight, model: modelWeight }),
    evaluationStatus: settled.length >= minSettledN ? "EVALUABLE_DIAGNOSTIC_ONLY" : "NOT_EVALUABLE",
    failureModeVerdict,
    causalProof: false,
    lanes: Object.freeze({ rule: root.rule, model: root.model, blend: root.blend }),
    metrics: Object.freeze({ sampleN: rows.length, settledN: settled.length, ...root.suppression }),
    probabilityShape: Object.freeze({
      rule: probabilityShape(rows, "ruleProbabilities"),
      model: probabilityShape(rows, "modelProbabilities"),
      blend: probabilityShape(rows, "blendProbabilities"),
    }),
    slices: Object.freeze({ bySymbol, byRegime, temporal: temporalThirds(rows) }),
    coverage: Object.freeze({ actualSupport, regimeSupport, missingActualClasses: Object.freeze(missingActualClasses), missingRegimes: Object.freeze(missingRegimes) }),
    limitations: Object.freeze(limitations),
    safety: SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY,
  });
}

function reconstructRsi14(features) {
  if (!finite(features?.rsiCentered)) throw new Error("rsiCentered is required for exact Rule reconstruction");
  const raw = (features.rsiCentered * 50) + 50;
  if (Math.abs(raw - 25) < 1e-4 || Math.abs(raw - 75) < 1e-4) throw new Error("RSI threshold reconstruction is rounding-ambiguous");
  return round(raw, 4);
}

function reconstructObservation(record, model, tolerance) {
  if (!record || record.timeframe !== "15m" || record.modelGroup !== "crypto-futures-15m") throw new Error("artifact contains an invalid 15m Shadow record");
  if (record.modelId !== model.id) throw new Error("Shadow record model identity mismatch");
  const features = record.features;
  if (!features || typeof features !== "object") throw new Error("Shadow record features are missing");
  const rule = evaluateRules({ market: "CRYPTO_FUTURES" }, { features, indicators: { rsi14: reconstructRsi14(features) } });
  const ruleProbabilities = scoreToProbabilities(rule.score);
  const modelProbabilities = predictTinyModel(features, model).probabilities;
  const blendProbabilities = blendDeployedProbabilities(rule.score, modelProbabilities).probabilities;
  if (!record.candidateProbabilities || CLASSES.some((name) => !finite(record.candidateProbabilities[name]))) throw new Error("persisted candidate probabilities are missing");
  const reconstructionError = Math.max(...CLASSES.map((name) => Math.abs(blendProbabilities[name] - record.candidateProbabilities[name])));
  if (reconstructionError > tolerance) throw new Error(`persisted Blend reconstruction mismatch: ${reconstructionError}`);
  if (classDirection(blendProbabilities) !== direction(record.candidateClass, "candidateClass")) throw new Error("persisted candidate class does not match reconstructed Blend");
  return Object.freeze({
    id: record.id,
    timeframe: record.timeframe,
    symbol: record.symbol,
    anchorTimestamp: record.anchorTimestamp,
    actualDirection: record.status === "settled" ? record.actualDirection : null,
    ruleDirection: classDirection(ruleProbabilities),
    modelDirection: classDirection(modelProbabilities),
    blendDirection: classDirection(blendProbabilities),
    regime: record.regime?.trend ?? record.regime?.key ?? null,
    ruleScore: rule.score,
    ruleProbabilities,
    modelProbabilities,
    blendProbabilities,
    reconstructionError,
  });
}

function findRuleDirectionalCrossover(sign) {
  let low = 0;
  let high = 100;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (low + high) / 2;
    const score = sign > 0 ? middle : -middle;
    const directional = classDirection(scoreToProbabilities(score)) !== "NEUTRAL";
    if (directional) high = middle;
    else low = middle;
  }
  return sign > 0 ? high : -high;
}

export function buildAuthenticatedShadowBlendCollapseDiagnostic({
  manifestBytes,
  stateBytes,
  summaryBytes,
  modelArtifactBytes,
  artifactIdentity,
  modelBlobSha,
  minSettledN = 12,
  reconstructionTolerance = RECONSTRUCTION_TOLERANCE,
  generatedAt = Date.now(),
} = {}) {
  const manifest = parseJsonBytes(manifestBytes, "manifest");
  const state = parseJsonBytes(stateBytes, "shadow state");
  const summary = parseJsonBytes(summaryBytes, "shadow summary");
  const modelArtifact = parseJsonBytes(modelArtifactBytes, "candidate model artifact");
  if (manifest.schemaVersion !== 1 || manifest.kind !== "prediction-lab-shadow-state") throw new Error("unsupported Shadow artifact manifest");
  if (!/^[0-9a-f]{40}$/u.test(String(manifest.researchCodeSha ?? ""))) throw new Error("Shadow artifact researchCodeSha is invalid");
  if (manifest.stateSha256 !== sha256(stateBytes) || manifest.summarySha256 !== sha256(summaryBytes)) throw new Error("Shadow artifact state/summary digest mismatch");
  const combined = sha256(Buffer.concat([Buffer.from(stateBytes), Buffer.from([0]), Buffer.from(summaryBytes)]));
  if (manifest.sha256 !== combined) throw new Error("Shadow artifact combined digest mismatch");
  if (manifest.branchWrite !== false || manifest.liveOrderAllowed !== false || manifest.privateAccountRequestAllowed !== false) throw new Error("Shadow artifact safety flags are not fail-closed");
  if (!Number.isInteger(Number(artifactIdentity?.workflowRunId)) || !Number.isInteger(Number(artifactIdentity?.artifactId))) throw new Error("immutable artifact run/id is required");
  if (!/^sha256:[0-9a-f]{64}$/u.test(String(artifactIdentity?.artifactDigest ?? ""))) throw new Error("immutable artifact digest is required");
  if (!/^[0-9a-f]{40}$/u.test(String(modelBlobSha ?? ""))) throw new Error("exact model Git blob SHA is required");

  const groupSummary = summary.groups?.["crypto-futures-15m"];
  const groupState = state.groups?.["crypto-futures-15m"];
  const model = modelArtifact.model;
  if (!groupState || !Array.isArray(groupState.records) || !groupState.records.length) throw new Error("15m Shadow state is missing");
  if (!model?.trained || typeof model.id !== "string") throw new Error("trained exact candidate model is missing");
  if (modelArtifact.group !== "crypto-futures-15m" || groupSummary?.modelSelection?.source !== "v1-vs-rule-baseline") throw new Error("15m model selection is not the expected frozen v1 lane");
  if (groupSummary.modelSelection.candidateModelId !== model.id || !manifest.candidateModelIds?.includes(model.id)) throw new Error("candidate model identity is not bound to Shadow artifact");

  const observations = groupState.records.map((record) => reconstructObservation(record, model, reconstructionTolerance));
  const diagnostic = buildShadowBlendCollapseDiagnostic({
    observations,
    minSettledN,
    declaredBlendWeights: { rule: DEPLOYED_RULE_WEIGHT, model: DEPLOYED_MODEL_WEIGHT },
    researchCodeSha: manifest.researchCodeSha,
    generatedAt,
  });
  const scores = observations.map((row) => row.ruleScore);
  const positiveCrossover = findRuleDirectionalCrossover(1);
  const negativeCrossover = findRuleDirectionalCrossover(-1);
  const ruleScoresStayNeutral = Math.max(...scores) < positiveCrossover && Math.min(...scores) > negativeCrossover;
  const maxReconstructionError = Math.max(...observations.map((row) => row.reconstructionError));
  const mechanicalCausalityProven = maxReconstructionError <= reconstructionTolerance
    && ruleScoresStayNeutral
    && diagnostic.lanes.rule.distribution.neutralRate === 1
    && diagnostic.metrics.modelOnlyActionableN > 0
    && diagnostic.metrics.modelOnlyActionableSuppressedN > 0;

  return Object.freeze({
    ...diagnostic,
    kind: "authenticated-shadow-15m-blend-collapse-diagnostic",
    authenticatedEvidence: Object.freeze({
      workflowRunId: Number(artifactIdentity.workflowRunId),
      artifactId: Number(artifactIdentity.artifactId),
      artifactDigest: artifactIdentity.artifactDigest,
      researchCodeSha: manifest.researchCodeSha,
      sourceGeneratedHead: manifest.sourceGeneratedHead ?? null,
      stateSha256: manifest.stateSha256,
      summarySha256: manifest.summarySha256,
      combinedSha256: manifest.sha256,
      modelId: model.id,
      modelBlobSha,
      modelArtifactSha256: sha256(modelArtifactBytes),
      modelSelectionSource: groupSummary.modelSelection.source,
      reconstructionTolerance,
      maxReconstructionError,
      exactBlendParity: maxReconstructionError <= reconstructionTolerance,
    }),
    mechanicalRootCause: Object.freeze({
      P1_1_MECHANICAL_ROOT_CAUSE_PROVEN: mechanicalCausalityProven,
      NEUTRAL_COLLAPSE_FIXED: false,
      ruleDirectionalCrossoverScore: Object.freeze({ SHORT_below: negativeCrossover, LONG_above: positiveCrossover }),
      observedRuleScore: Object.freeze({ min: Math.min(...scores), max: Math.max(...scores), mean: mean(scores) }),
      ruleNeutralN: diagnostic.lanes.rule.distribution.NEUTRAL,
      ruleTotalN: diagnostic.lanes.rule.distribution.total,
      modelActionableN: diagnostic.metrics.modelOnlyActionableN,
      modelActionableSuppressedByBlendN: diagnostic.metrics.modelOnlyActionableSuppressedN,
      modelActionableSuppressionRate: diagnostic.metrics.modelOnlyActionableSuppressionRate,
      conclusion: mechanicalCausalityProven
        ? "RULE_SCORE_RANGE_NEVER_CROSSES_DIRECTIONAL_BOUNDARY_AND_65PCT_RULE_WEIGHT_SUPPRESSES_MODEL_DIRECTION"
        : "MECHANICAL_ROOT_CAUSE_NOT_PROVEN",
    }),
    referenceDriftEvidence: Object.freeze({
      status: "MISSING_EVIDENCE",
      reason: "genuine_exact_identity_train_validation_reference_package_not_supplied",
      psi: null,
      ks: null,
      jsd: null,
      profitabilityCredit: 0,
    }),
  });
}

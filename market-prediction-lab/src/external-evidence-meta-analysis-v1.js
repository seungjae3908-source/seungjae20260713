import { verifyGlobalStrategyResearchRecord } from "./global-alpha-literature-registry-v1.js";
import { researchDigest } from "./research-trial-registry.js";

const DIRECTIONS = Object.freeze(new Set(["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED", "UNKNOWN"]));
const NATURAL_CONTRADICTIONS = Object.freeze(new Set(["NEGATIVE", "DEGRADED", "SUSPENDED", "REJECTED"]));

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function optionalString(value) {
  if (value == null || value === "") return null;
  return requiredString(value, "value");
}

function finite(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${name} must be finite`);
  return number;
}

function positiveFinite(value, name) {
  const number = finite(value, name);
  if (!(number > 0)) throw new RangeError(`${name} must be positive`);
  return number;
}

function normalizedSet(values) {
  return new Set((values ?? []).map((value) => String(value).trim().toLowerCase()).filter(Boolean));
}

function jaccard(leftValues, rightValues) {
  const left = normalizedSet(leftValues);
  const right = normalizedSet(rightValues);
  if (left.size === 0 || right.size === 0) return null;
  const intersection = [...left].filter((value) => right.has(value)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}

function samplePeriodOverlap(left, right) {
  const leftStart = Date.parse(left?.startDate ?? "");
  const leftEnd = Date.parse(left?.endDate ?? "");
  const rightStart = Date.parse(right?.startDate ?? "");
  const rightEnd = Date.parse(right?.endDate ?? "");
  if (![leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite)) return null;
  const intersection = Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
  const shorter = Math.min(Math.max(1, leftEnd - leftStart), Math.max(1, rightEnd - rightStart));
  return intersection / shorter;
}

function datasetIdentity(record) {
  const reference = record.sourceMetadata.datasetReference;
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) return null;
  return optionalString(reference.datasetId ?? reference.id ?? reference.fingerprint);
}

function metaSafety() {
  return Object.freeze({
    evidenceTier: "E1",
    reportedMetricsCanBecomeOurMetrics: false,
    externalSampleCanBecomePaperSample: false,
    metaAnalysisCanProveProfitability: false,
    bayesianPriorCanOverrideNaturalEvidence: false,
    aiCanCreateNumericEvidence: false,
    aiCanPromoteStrategy: false,
    eligibleForScannerResearchConsideration: false,
    executionAuthority: "NONE",
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    actualOrders: 0,
    actualCancels: 0,
    actualAmends: 0,
    actualTransfers: 0,
    actualWithdrawals: 0,
  });
}

export function compareExternalStudyOverlap(left, right) {
  if (!left?.researchRecord || !right?.researchRecord) throw new TypeError("two external study evidence records are required");
  if (!verifyGlobalStrategyResearchRecord(left.researchRecord) || !verifyGlobalStrategyResearchRecord(right.researchRecord)) {
    throw new Error("GLOBAL_STRATEGY_RESEARCH_RECORD_INVALID");
  }
  const leftRecord = left.researchRecord;
  const rightRecord = right.researchRecord;
  const leftDataset = datasetIdentity(leftRecord);
  const rightDataset = datasetIdentity(rightRecord);
  const sameDataset = leftDataset != null && rightDataset != null && leftDataset === rightDataset;
  const samplePeriodOverlapRatio = samplePeriodOverlap(leftRecord.sourceMetadata.samplePeriod, rightRecord.sourceMetadata.samplePeriod);
  const authorOverlapRatio = jaccard(leftRecord.sourceMetadata.authors, rightRecord.sourceMetadata.authors);
  const sameStrategyFamily = leftRecord.strategyDna.strategyFamilyId === rightRecord.strategyDna.strategyFamilyId;
  const sameMarket = leftRecord.sourceMetadata.market === rightRecord.sourceMetadata.market;

  let overlapCategory = "NO_KNOWN_OVERLAP";
  let independenceStatus = "NOT_ESTABLISHED";
  if (sameDataset && (samplePeriodOverlapRatio ?? 0) > 0) {
    overlapCategory = "DUPLICATE_SAMPLE";
    independenceStatus = "NOT_INDEPENDENT";
  } else if ((samplePeriodOverlapRatio ?? 0) >= 0.8 && sameStrategyFamily && sameMarket) {
    overlapCategory = "HIGH_OVERLAP";
    independenceStatus = "POTENTIALLY_DEPENDENT";
  } else if (sameDataset || (samplePeriodOverlapRatio ?? 0) > 0 || (authorOverlapRatio ?? 0) > 0) {
    overlapCategory = "POTENTIAL_SAMPLE_OVERLAP";
    independenceStatus = "POTENTIALLY_DEPENDENT";
  } else if (sameStrategyFamily && sameMarket) {
    overlapCategory = "STRATEGY_FAMILY_OVERLAP_ONLY";
    independenceStatus = "NOT_ESTABLISHED";
  }

  const core = Object.freeze({
    leftResearchSourceId: leftRecord.researchSourceId,
    rightResearchSourceId: rightRecord.researchSourceId,
    sameDataset,
    samplePeriodOverlapRatio,
    authorOverlapRatio,
    sameStrategyFamily,
    sameMarket,
    overlapScore: null,
    overlapScoreStatus: "NOT_COMPUTED_WITHOUT_CALIBRATED_WEIGHTS",
    overlapCategory,
    independenceStatus,
  });
  return Object.freeze({ ...core, overlapDigest: researchDigest(core) });
}

function normalizeEffectEvidence(raw, record) {
  if (raw == null) {
    return Object.freeze({
      status: "NOT_REPORTED",
      metric: null,
      effectDefinition: null,
      effectScale: null,
      estimate: null,
      standardError: null,
      direction: "UNKNOWN",
      market: record.sourceMetadata.market,
      timeframe: record.sourceMetadata.timeframe,
      costAssumptionFingerprint: null,
    });
  }
  const direction = requiredString(raw.direction ?? "UNKNOWN", "effectEvidence.direction").toUpperCase();
  if (!DIRECTIONS.has(direction)) throw new RangeError("effectEvidence.direction is unsupported");
  const hasEstimate = raw.estimate != null || raw.standardError != null;
  if (!hasEstimate) {
    return Object.freeze({
      status: "DIRECTION_ONLY",
      metric: optionalString(raw.metric),
      effectDefinition: optionalString(raw.effectDefinition),
      effectScale: optionalString(raw.effectScale),
      estimate: null,
      standardError: null,
      direction,
      market: requiredString(raw.market ?? record.sourceMetadata.market, "effectEvidence.market"),
      timeframe: optionalString(raw.timeframe ?? record.sourceMetadata.timeframe),
      costAssumptionFingerprint: raw.costAssumptionFingerprint == null ? null : requiredString(raw.costAssumptionFingerprint, "costAssumptionFingerprint"),
    });
  }
  return Object.freeze({
    status: "COMPATIBLE_EFFECT_ESTIMATE",
    metric: requiredString(raw.metric, "effectEvidence.metric"),
    effectDefinition: requiredString(raw.effectDefinition, "effectEvidence.effectDefinition"),
    effectScale: requiredString(raw.effectScale, "effectEvidence.effectScale"),
    estimate: finite(raw.estimate, "effectEvidence.estimate"),
    standardError: positiveFinite(raw.standardError, "effectEvidence.standardError"),
    direction,
    market: requiredString(raw.market ?? record.sourceMetadata.market, "effectEvidence.market"),
    timeframe: requiredString(raw.timeframe ?? record.sourceMetadata.timeframe, "effectEvidence.timeframe"),
    costAssumptionFingerprint: requiredString(raw.costAssumptionFingerprint, "effectEvidence.costAssumptionFingerprint"),
  });
}

function normalizeIndependenceEvidence(raw) {
  const status = requiredString(raw?.status ?? "NOT_ESTABLISHED", "independenceEvidence.status").toUpperCase();
  if (!new Set(["VERIFIED_INDEPENDENT", "NOT_ESTABLISHED"]).has(status)) throw new RangeError("independenceEvidence.status is unsupported");
  const provenance = raw?.provenance == null ? null : requiredString(raw.provenance, "independenceEvidence.provenance");
  if (status === "VERIFIED_INDEPENDENT" && provenance == null) throw new Error("verified independence requires provenance");
  return Object.freeze({ status, provenance });
}

export function createExternalStudyEvidence({ researchRecord, effectEvidence, independenceEvidence } = {}) {
  if (!verifyGlobalStrategyResearchRecord(researchRecord)) throw new Error("GLOBAL_STRATEGY_RESEARCH_RECORD_INVALID");
  const core = Object.freeze({
    researchSourceId: researchRecord.researchSourceId,
    strategyFamilyId: researchRecord.strategyDna.strategyFamilyId,
    researchRecord,
    effectEvidence: normalizeEffectEvidence(effectEvidence, researchRecord),
    independenceEvidence: normalizeIndependenceEvidence(independenceEvidence),
    evidenceTier: "E1",
    profitabilityProven: false,
    promotionEligible: false,
  });
  return Object.freeze({ ...core, studyEvidenceDigest: researchDigest(core) });
}

function buildDependenceClusters(studies, overlaps) {
  const parent = studies.map((_, index) => index);
  const find = (index) => {
    let current = index;
    while (parent[current] !== current) current = parent[current];
    return current;
  };
  const join = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  overlaps.forEach(({ leftIndex, rightIndex, comparison }) => {
    if (!new Set(["NO_KNOWN_OVERLAP", "STRATEGY_FAMILY_OVERLAP_ONLY"]).has(comparison.overlapCategory)) join(leftIndex, rightIndex);
  });
  return new Set(parent.map((_, index) => find(index))).size;
}

function compatibilityReasons(studies, overlaps) {
  const reasons = [];
  if (studies.length < 2) reasons.push("AT_LEAST_TWO_STUDIES_REQUIRED");
  if (studies.some((study) => study.effectEvidence.status !== "COMPATIBLE_EFFECT_ESTIMATE")) reasons.push("COMPATIBLE_EFFECT_ESTIMATES_REQUIRED");
  if (studies.some((study) => study.independenceEvidence.status !== "VERIFIED_INDEPENDENT")) reasons.push("INDEPENDENCE_NOT_VERIFIED");
  if (overlaps.some(({ comparison }) => !new Set(["NO_KNOWN_OVERLAP", "STRATEGY_FAMILY_OVERLAP_ONLY"]).has(comparison.overlapCategory))) {
    reasons.push("STUDY_OR_SAMPLE_OVERLAP_DETECTED");
  }
  if (new Set(studies.map((study) => study.strategyFamilyId)).size > 1) reasons.push("INCOMPATIBLE_STRATEGY_FAMILY");
  const fields = ["metric", "effectDefinition", "effectScale", "market", "timeframe", "costAssumptionFingerprint"];
  for (const field of fields) {
    if (new Set(studies.map((study) => study.effectEvidence[field])).size > 1) reasons.push(`INCOMPATIBLE_${field.toUpperCase()}`);
  }
  return Object.freeze([...new Set(reasons)].sort());
}

function effectDirections(studies) {
  return Object.freeze(Object.fromEntries([...DIRECTIONS].map((direction) => [
    direction,
    studies.filter((study) => study.effectEvidence.direction === direction).length,
  ])));
}

function fixedEffectPool(studies) {
  const rows = studies.map((study) => ({
    estimate: study.effectEvidence.estimate,
    variance: study.effectEvidence.standardError ** 2,
  }));
  const totalWeight = rows.reduce((sum, row) => sum + (1 / row.variance), 0);
  const pooledEstimate = rows.reduce((sum, row) => sum + (row.estimate / row.variance), 0) / totalWeight;
  const pooledStandardError = Math.sqrt(1 / totalWeight);
  const cochranQ = rows.reduce((sum, row) => sum + ((1 / row.variance) * ((row.estimate - pooledEstimate) ** 2)), 0);
  const degreesOfFreedom = rows.length - 1;
  const iSquaredPct = cochranQ > 0 ? Math.max(0, ((cochranQ - degreesOfFreedom) / cochranQ) * 100) : 0;
  return Object.freeze({
    pooledEstimate,
    pooledStandardError,
    cochranQ,
    degreesOfFreedom,
    iSquaredPct,
    pValue: null,
    pValueStatus: "NOT_IMPLEMENTED",
  });
}

export function buildExternalEvidenceMetaAnalysis(studies, { model = "FIXED_EFFECT" } = {}) {
  if (!Array.isArray(studies) || studies.length === 0) throw new TypeError("external studies are required");
  if (studies.some((study) => study?.studyEvidenceDigest !== researchDigest({
    researchSourceId: study.researchSourceId,
    strategyFamilyId: study.strategyFamilyId,
    researchRecord: study.researchRecord,
    effectEvidence: study.effectEvidence,
    independenceEvidence: study.independenceEvidence,
    evidenceTier: study.evidenceTier,
    profitabilityProven: study.profitabilityProven,
    promotionEligible: study.promotionEligible,
  }))) throw new Error("EXTERNAL_STUDY_EVIDENCE_TAMPERED");

  const overlaps = [];
  for (let leftIndex = 0; leftIndex < studies.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < studies.length; rightIndex += 1) {
      overlaps.push(Object.freeze({ leftIndex, rightIndex, comparison: compareExternalStudyOverlap(studies[leftIndex], studies[rightIndex]) }));
    }
  }
  const reasons = compatibilityReasons(studies, overlaps);
  const effectiveStudyCountConservative = buildDependenceClusters(studies, overlaps);
  const sampleCounts = studies.map((study) => study.researchRecord.sourceMetadata.sampleN).filter(Number.isFinite);
  const base = {
    schemaVersion: 1,
    model,
    evidenceTier: "E1",
    studyCount: studies.length,
    rawReportedSampleN: sampleCounts.reduce((sum, value) => sum + value, 0),
    effectiveSampleN: null,
    effectiveSampleNStatus: "NOT_COMPUTED_WHEN_STUDY_SAMPLES_MAY_OVERLAP",
    effectiveStudyCount: effectiveStudyCountConservative,
    effectiveStudyCountStatus: "CONSERVATIVE_DEPENDENCE_CLUSTER_COUNT",
    effectDirections: effectDirections(studies),
    pairwiseOverlap: Object.freeze(overlaps.map((row) => row.comparison)),
    compatibilityReasons: reasons,
    reportedMetricsAggregationStatus: "NOT_AGGREGATED",
    profitabilityProven: false,
    promotionEligible: false,
    safety: metaSafety(),
  };
  if (model !== "FIXED_EFFECT") {
    return Object.freeze({ ...base, status: "NOT_IMPLEMENTED", pooledEffect: null, blocker: "ONLY_EXPLICIT_FIXED_EFFECT_MODEL_IMPLEMENTED" });
  }
  if (reasons.length > 0) {
    return Object.freeze({ ...base, status: studies.length < 2 ? "INSUFFICIENT_EVIDENCE" : "NOT_COMPARABLE", pooledEffect: null, blocker: reasons[0] });
  }
  const pooledEffect = fixedEffectPool(studies);
  return Object.freeze({
    ...base,
    status: "POOLED_FIXED_EFFECT",
    metric: studies[0].effectEvidence.metric,
    effectDefinition: studies[0].effectEvidence.effectDefinition,
    effectScale: studies[0].effectEvidence.effectScale,
    market: studies[0].effectEvidence.market,
    timeframe: studies[0].effectEvidence.timeframe,
    costAssumptionFingerprint: studies[0].effectEvidence.costAssumptionFingerprint,
    pooledEffect,
    blocker: null,
  });
}

function bayesianNotApplicable(reason, naturalEvidenceStatus = "NOT_COLLECTED") {
  return Object.freeze({
    status: "BAYESIAN_UPDATE_NOT_APPLICABLE",
    reason,
    naturalEvidenceStatus,
    posterior: null,
    profitabilityProven: false,
    promotionEligible: false,
    safety: metaSafety(),
  });
}

export function buildNormalNormalResearchUpdate({ externalMetaAnalysis, ourReplication, naturalEvidenceStatus = "NOT_COLLECTED" } = {}) {
  const normalizedNaturalStatus = requiredString(naturalEvidenceStatus, "naturalEvidenceStatus").toUpperCase();
  if (NATURAL_CONTRADICTIONS.has(normalizedNaturalStatus)) return bayesianNotApplicable("NATURAL_EVIDENCE_CONTRADICTS_EXTERNAL_PRIOR", normalizedNaturalStatus);
  if (externalMetaAnalysis?.status !== "POOLED_FIXED_EFFECT") return bayesianNotApplicable("VALID_EXTERNAL_FIXED_EFFECT_PRIOR_REQUIRED", normalizedNaturalStatus);
  if (ourReplication?.tier !== "E2") return bayesianNotApplicable("E2_REPLICATION_LIKELIHOOD_REQUIRED", normalizedNaturalStatus);
  if (ourReplication.effectDefinition !== externalMetaAnalysis.effectDefinition || ourReplication.effectScale !== externalMetaAnalysis.effectScale) {
    return bayesianNotApplicable("PRIOR_LIKELIHOOD_SCALE_MISMATCH", normalizedNaturalStatus);
  }
  const priorMean = finite(externalMetaAnalysis.pooledEffect.pooledEstimate, "external prior mean");
  const priorStandardError = positiveFinite(externalMetaAnalysis.pooledEffect.pooledStandardError, "external prior standard error");
  const likelihoodMean = finite(ourReplication.estimate, "replication estimate");
  const likelihoodStandardError = positiveFinite(ourReplication.standardError, "replication standard error");
  const priorPrecision = 1 / (priorStandardError ** 2);
  const likelihoodPrecision = 1 / (likelihoodStandardError ** 2);
  const posteriorVariance = 1 / (priorPrecision + likelihoodPrecision);
  const posteriorMean = posteriorVariance * ((priorPrecision * priorMean) + (likelihoodPrecision * likelihoodMean));
  return Object.freeze({
    status: "RESEARCH_PRIOR_UPDATED_NORMAL_NORMAL",
    model: "NORMAL_PRIOR_NORMAL_LIKELIHOOD_KNOWN_STANDARD_ERRORS",
    assumptions: Object.freeze([
      "compatible effect definition and scale",
      "verified independent external studies",
      "fixed-effect external model",
      "normally distributed estimate errors",
      "known standard errors",
    ]),
    prior: Object.freeze({ mean: priorMean, standardError: priorStandardError, evidenceTier: "E1" }),
    likelihood: Object.freeze({ mean: likelihoodMean, standardError: likelihoodStandardError, evidenceTier: "E2" }),
    posterior: Object.freeze({ mean: posteriorMean, standardError: Math.sqrt(posteriorVariance) }),
    posteriorProbability: null,
    posteriorProbabilityStatus: "NOT_COMPUTED",
    naturalEvidenceStatus: normalizedNaturalStatus,
    naturalEvidenceRemainsAuthoritative: true,
    profitabilityProven: false,
    promotionEligible: false,
    safety: metaSafety(),
  });
}

import {
  appendResearchTrial,
  createResearchTrialRegistry,
  researchDigest,
} from "./research-trial-registry.js";

export const GLOBAL_ALPHA_LITERATURE_SCHEMA_VERSION = 1;
const SHA40 = /^[0-9a-f]{40}$/i;

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function optionalString(value) {
  if (value == null || value === "") return null;
  return requiredString(value, "value");
}

function optionalBoolean(value, name) {
  if (value == null) return null;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean or null`);
  return value;
}

function optionalFinite(value, name, { min = -Infinity, max = Infinity } = {}) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new RangeError(`${name} is out of range`);
  return number;
}

function optionalPositiveInteger(value, name) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new RangeError(`${name} must be a positive integer or null`);
  return number;
}

function optionalNonNegativeInteger(value, name) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new RangeError(`${name} must be a non-negative integer or null`);
  return number;
}

function optionalDate(value, name) {
  if (value == null || value === "") return null;
  const text = requiredString(value, name);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${name} must be a valid date`);
  return new Date(timestamp).toISOString().slice(0, 10);
}

function normalizeDoi(value) {
  if (value == null || value === "") return null;
  let doi = requiredString(value, "doi").toLowerCase();
  doi = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "");
  if (!/^10\.\d{4,9}\/.+/.test(doi)) throw new TypeError("doi must be canonicalizable");
  return doi;
}

function normalizeReportedMetrics(raw = {}) {
  return Object.freeze({
    annualReturnPct: optionalFinite(raw.annualReturnPct, "reportedMetrics.annualReturnPct", { min: -100 }),
    cagrPct: optionalFinite(raw.cagrPct, "reportedMetrics.cagrPct", { min: -100 }),
    sharpe: optionalFinite(raw.sharpe, "reportedMetrics.sharpe"),
    sortino: optionalFinite(raw.sortino, "reportedMetrics.sortino"),
    maxDrawdownPct: optionalFinite(raw.maxDrawdownPct, "reportedMetrics.maxDrawdownPct", { min: -100, max: 0 }),
    winRatePct: optionalFinite(raw.winRatePct, "reportedMetrics.winRatePct", { min: 0, max: 100 }),
    profitFactor: optionalFinite(raw.profitFactor, "reportedMetrics.profitFactor", { min: 0 }),
  });
}

function normalizeSample(raw = {}) {
  const startDate = optionalDate(raw.startDate, "sample.startDate");
  const endDate = optionalDate(raw.endDate, "sample.endDate");
  if (startDate && endDate && Date.parse(startDate) > Date.parse(endDate)) throw new RangeError("sample date range is inverted");
  return Object.freeze({
    startDate,
    endDate,
    observationCount: optionalPositiveInteger(raw.observationCount, "sample.observationCount"),
    assetCount: optionalPositiveInteger(raw.assetCount, "sample.assetCount"),
    marketCount: optionalPositiveInteger(raw.marketCount, "sample.marketCount"),
  });
}

function normalizeValidation(raw = {}) {
  return Object.freeze({
    outOfSample: optionalBoolean(raw.outOfSample, "validation.outOfSample"),
    walkForward: optionalBoolean(raw.walkForward, "validation.walkForward"),
    finalHoldout: optionalBoolean(raw.finalHoldout, "validation.finalHoldout"),
    transactionCostsIncluded: optionalBoolean(raw.transactionCostsIncluded, "validation.transactionCostsIncluded"),
    slippageIncluded: optionalBoolean(raw.slippageIncluded, "validation.slippageIncluded"),
    fundingIncluded: optionalBoolean(raw.fundingIncluded, "validation.fundingIncluded"),
    independentReplicationCount: optionalNonNegativeInteger(raw.independentReplicationCount, "validation.independentReplicationCount"),
    contradictoryEvidenceCount: optionalNonNegativeInteger(raw.contradictoryEvidenceCount, "validation.contradictoryEvidenceCount"),
  });
}

function canonicalSourceKey({ doi, sourceUrl }) {
  if (doi) return `doi:${doi}`;
  if (sourceUrl) return `url:${sourceUrl.trim().toLowerCase()}`;
  throw new TypeError("doi or sourceUrl is required for deduplication");
}

function studyCore(raw) {
  const doi = normalizeDoi(raw?.doi);
  const sourceUrl = optionalString(raw?.sourceUrl);
  const publishedYear = optionalPositiveInteger(raw?.publishedYear, "publishedYear");
  if (publishedYear != null && (publishedYear < 1900 || publishedYear > 2200)) throw new RangeError("publishedYear is out of range");
  const core = Object.freeze({
    studyId: requiredString(raw?.studyId, "studyId"),
    title: requiredString(raw?.title, "title"),
    authors: Array.isArray(raw?.authors) ? Object.freeze(raw.authors.map((value) => requiredString(value, "author"))) : Object.freeze([]),
    venue: optionalString(raw?.venue),
    publishedYear,
    doi,
    sourceUrl,
    sourceKey: canonicalSourceKey({ doi, sourceUrl }),
    market: requiredString(raw?.market, "market"),
    strategyFamily: requiredString(raw?.strategyFamily, "strategyFamily"),
    strategySummary: requiredString(raw?.strategySummary, "strategySummary"),
    formulaSummary: optionalString(raw?.formulaSummary),
    sample: normalizeSample(raw?.sample),
    reportedMetrics: normalizeReportedMetrics(raw?.reportedMetrics),
    validation: normalizeValidation(raw?.validation),
  });
  return core;
}

export function createLiteratureStudy(raw) {
  const core = studyCore(raw);
  return Object.freeze({
    schemaVersion: GLOBAL_ALPHA_LITERATURE_SCHEMA_VERSION,
    ...core,
    literatureDigest: researchDigest(core),
    evidenceAuthority: "LITERATURE_ONLY",
    profitabilityProven: false,
    promotionEligible: false,
    executionAuthority: "NONE",
  });
}

export function verifyLiteratureStudy(study) {
  if (!study || study.schemaVersion !== GLOBAL_ALPHA_LITERATURE_SCHEMA_VERSION) return false;
  try {
    const core = studyCore(study);
    return study.literatureDigest === researchDigest(core)
      && study.evidenceAuthority === "LITERATURE_ONLY"
      && study.profitabilityProven === false
      && study.promotionEligible === false
      && study.executionAuthority === "NONE";
  } catch {
    return false;
  }
}

function registryCore({ registryId, studies }) {
  return Object.freeze({ registryId, studies });
}

function withRegistryDigest(core) {
  return Object.freeze({
    schemaVersion: GLOBAL_ALPHA_LITERATURE_SCHEMA_VERSION,
    ...core,
    registryDigest: researchDigest(core),
    safety: Object.freeze({
      literatureCanProveProfitability: false,
      literatureCanPromoteStrategy: false,
      literatureCanSelectForwardCandidate: false,
      liveTradingAllowed: false,
      privateApiAllowed: false,
      orderAuthority: false,
    }),
  });
}

export function createGlobalAlphaLiteratureRegistry({ registryId = "GLOBAL_ALPHA_LITERATURE_V1" } = {}) {
  return withRegistryDigest(registryCore({ registryId: requiredString(registryId, "registryId"), studies: Object.freeze([]) }));
}

export function verifyGlobalAlphaLiteratureRegistry(registry) {
  if (!registry || registry.schemaVersion !== GLOBAL_ALPHA_LITERATURE_SCHEMA_VERSION || !Array.isArray(registry.studies)) return false;
  if (registry.studies.some((study) => !verifyLiteratureStudy(study))) return false;
  const keys = registry.studies.map((study) => study.sourceKey);
  if (keys.length !== new Set(keys).size) return false;
  const core = registryCore({ registryId: registry.registryId, studies: registry.studies });
  return registry.registryDigest === researchDigest(core)
    && registry.safety?.literatureCanProveProfitability === false
    && registry.safety?.literatureCanPromoteStrategy === false
    && registry.safety?.orderAuthority === false;
}

export function appendLiteratureStudy(registry, rawStudy) {
  if (!verifyGlobalAlphaLiteratureRegistry(registry)) throw new Error("LITERATURE_REGISTRY_INVALID");
  const study = createLiteratureStudy(rawStudy);
  if (registry.studies.some((item) => item.sourceKey === study.sourceKey)) throw new Error(`DUPLICATE_LITERATURE_SOURCE:${study.sourceKey}`);
  const studies = Object.freeze([...registry.studies, study]);
  return withRegistryDigest(registryCore({ registryId: registry.registryId, studies }));
}

function assertExactSha(value) {
  const sha = requiredString(value, "researchCodeSha").toLowerCase();
  if (!SHA40.test(sha)) throw new TypeError("researchCodeSha must be an exact 40-character SHA");
  return sha;
}

function verifyTrialRegistry(registry) {
  if (!registry || registry.schemaVersion !== 2 || !Array.isArray(registry.trials)) return false;
  const expected = researchDigest({ experimentId: registry.experimentId, strategyIdentity: registry.strategyIdentity, trials: registry.trials });
  if (expected !== registry.registryDigest) return false;
  return registry.trials.every((trial) => trial.trialDigest === researchDigest({
    trialId: trial.trialId,
    candidateId: trial.candidateId,
    stage: trial.stage,
    selectionEligible: trial.selectionEligible,
    parameterHash: trial.parameterHash,
    returnSeries: trial.returnSeries,
    metrics: trial.metrics ?? {},
  }));
}

function replicationSafety() {
  return Object.freeze({
    literatureMetricsCanPopulateLocalMetrics: false,
    literatureMetricsCanProveProfitability: false,
    literatureMetricsCanPromoteStrategy: false,
    forwardEvidenceCanSelectCandidate: false,
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderAuthority: false,
  });
}

export function createLiteratureReplicationCase({ study, experimentId, identity } = {}) {
  if (!verifyLiteratureStudy(study)) throw new Error("LITERATURE_STUDY_INVALID");
  const normalizedIdentity = Object.freeze({ ...identity, researchCodeSha: assertExactSha(identity?.researchCodeSha) });
  const trialRegistry = createResearchTrialRegistry({ experimentId: requiredString(experimentId, "experimentId"), identity: normalizedIdentity });
  return Object.freeze({
    schemaVersion: 1,
    status: "REPLICATION_NOT_STARTED",
    literatureStudyId: study.studyId,
    literatureDigest: study.literatureDigest,
    literatureReportedMetrics: study.reportedMetrics,
    trialRegistry,
    localEvidence: Object.freeze({
      trialCount: 0,
      selectedTrialId: null,
      annualReturnPct: null,
      cagrPct: null,
      sharpe: null,
      maxDrawdownPct: null,
      winRatePct: null,
      profitFactor: null,
      profitabilityProven: false,
      promotionEligible: false,
    }),
    safety: replicationSafety(),
  });
}

export function appendLiteratureReplicationTrial(replication, trial) {
  if (!replication || replication.schemaVersion !== 1 || !verifyTrialRegistry(replication.trialRegistry)) throw new Error("LITERATURE_REPLICATION_INVALID");
  const trialRegistry = appendResearchTrial(replication.trialRegistry, trial);
  return Object.freeze({
    ...replication,
    status: "REPLICATION_COLLECTING",
    trialRegistry,
    localEvidence: Object.freeze({ ...replication.localEvidence, trialCount: trialRegistry.trials.length }),
    safety: replicationSafety(),
  });
}

function computeLocalMetrics(returnSeries, periodsPerYear) {
  if (!Number.isInteger(periodsPerYear) || periodsPerYear <= 0 || periodsPerYear > 1_000_000) throw new RangeError("periodsPerYear must be a positive integer");
  const values = [...returnSeries];
  const count = values.length;
  const average = values.reduce((sum, value) => sum + value, 0) / count;
  const variance = count > 1 ? values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (count - 1) : 0;
  const std = Math.sqrt(Math.max(variance, 0));
  const wealth = values.reduce((value, row) => value * (1 + row), 1);
  const years = count / periodsPerYear;
  const cagrPct = wealth > 0 && years > 0 ? ((wealth ** (1 / years)) - 1) * 100 : null;
  const sharpe = std > 0 ? (average / std) * Math.sqrt(periodsPerYear) : null;
  let equity = 1;
  let peak = 1;
  let maxDrawdownPct = 0;
  let positive = 0;
  let gains = 0;
  let losses = 0;
  for (const value of values) {
    equity *= (1 + value);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, ((equity / peak) - 1) * 100);
    if (value > 0) { positive += 1; gains += value; }
    else if (value < 0) losses += -value;
  }
  return Object.freeze({
    observationCount: count,
    cumulativeReturnPct: (wealth - 1) * 100,
    annualReturnPct: cagrPct,
    cagrPct,
    sharpe,
    maxDrawdownPct,
    winRatePct: (positive / count) * 100,
    profitFactor: losses > 0 ? gains / losses : null,
  });
}

export function buildLiteratureReplicationComparison({ replication, selectedTrialId, periodsPerYear } = {}) {
  if (!replication || replication.schemaVersion !== 1) throw new Error("LITERATURE_REPLICATION_INVALID");
  if (!verifyTrialRegistry(replication.trialRegistry)) throw new Error("TRIAL_REGISTRY_TAMPERED");
  const trialId = requiredString(selectedTrialId, "selectedTrialId");
  const selected = replication.trialRegistry.trials.find((trial) => trial.trialId === trialId);
  if (!selected) throw new Error("SELECTED_TRIAL_NOT_FOUND");
  const local = computeLocalMetrics(selected.returnSeries, periodsPerYear);
  const paper = replication.literatureReportedMetrics;
  const delta = Object.freeze({
    annualReturnPct: paper.annualReturnPct == null || local.annualReturnPct == null ? null : local.annualReturnPct - paper.annualReturnPct,
    sharpe: paper.sharpe == null || local.sharpe == null ? null : local.sharpe - paper.sharpe,
    maxDrawdownPct: paper.maxDrawdownPct == null || local.maxDrawdownPct == null ? null : local.maxDrawdownPct - paper.maxDrawdownPct,
    winRatePct: paper.winRatePct == null || local.winRatePct == null ? null : local.winRatePct - paper.winRatePct,
    profitFactor: paper.profitFactor == null || local.profitFactor == null ? null : local.profitFactor - paper.profitFactor,
  });
  return Object.freeze({
    schemaVersion: 1,
    status: "BACKTEST_COMPARISON_ONLY",
    literatureStudyId: replication.literatureStudyId,
    literatureDigest: replication.literatureDigest,
    strategyFamilyFingerprint: replication.trialRegistry.strategyIdentity.familyFingerprint,
    selectedTrialId: selected.trialId,
    selectedCandidateId: selected.candidateId,
    selectedParameterHash: selected.parameterHash,
    literatureReportedMetrics: paper,
    localBacktestMetrics: local,
    delta,
    profitabilityProven: false,
    promotionEligible: false,
    nextRequiredEvidence: Object.freeze(["OOS_OR_WALK_FORWARD", "FINAL_HOLDOUT", "SHADOW", "NATURAL_PAPER", "SETTLEMENT"]),
    safety: replicationSafety(),
  });
}

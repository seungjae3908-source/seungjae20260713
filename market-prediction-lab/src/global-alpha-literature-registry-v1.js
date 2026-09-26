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

export const GLOBAL_STRATEGY_RESEARCH_SCHEMA_VERSION = 1;
export const PAPER_GENOME_FIELDS = Object.freeze([
  "universe",
  "market",
  "assetClass",
  "timeframe",
  "horizon",
  "direction",
  "dataRequirements",
  "features",
  "formula",
  "signalCondition",
  "entryRule",
  "exitRule",
  "stopRule",
  "targetRule",
  "sizingRule",
  "rebalanceRule",
  "liquidityRequirements",
  "costAssumptions",
  "benchmark",
  "regimeAssumptions",
  "parameterStructure",
  "reportedSampleCount",
  "reportedReturn",
  "reportedSharpe",
  "reportedProfitFactor",
  "reportedMaxDrawdown",
  "reportedHitRate",
  "statisticalTests",
  "knownLimitations",
]);

const EXTRACTION_STATUSES = Object.freeze(new Set([
  "SUPPORTED",
  "AMBIGUOUS",
  "NOT_REPORTED",
  "NOT_APPLICABLE",
]));
const EXTRACTION_CONFIDENCE = Object.freeze(new Set(["HIGH", "MEDIUM", "LOW"]));

function canonicalJson(value, name = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must contain only finite JSON values`);
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((item, index) => canonicalJson(item, `${name}[${index}]`)));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.freeze(Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key], `${name}.${key}`)])));
  }
  throw new TypeError(`${name} must contain only JSON values`);
}

function normalizeStringList(value, name) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return Object.freeze([...new Set(value.map((item) => requiredString(item, name)))].sort());
}

function normalizeCanonicalUrl(value, name) {
  if (value == null || value === "") return null;
  const parsed = new URL(requiredString(value, name));
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new TypeError(`${name} must use http or https`);
  parsed.hash = "";
  return parsed.toString();
}

function normalizeIngestionTimestamp(value) {
  const timestamp = Date.parse(requiredString(value, "ingestionTimestamp"));
  if (!Number.isFinite(timestamp)) throw new TypeError("ingestionTimestamp must be a valid timestamp");
  return new Date(timestamp).toISOString();
}

function sourceFingerprintCore(source) {
  return Object.freeze({
    sourceKey: source.sourceKey,
    title: source.title,
    authors: source.authors,
    publication: source.publication,
    publicationDate: source.publicationDate,
    canonicalUrl: source.canonicalUrl,
    sourceType: source.sourceType,
    market: source.market,
    assetClass: source.assetClass,
    marketsStudied: source.marketsStudied,
    samplePeriod: source.samplePeriod,
    sampleN: source.sampleN,
    tradeN: source.tradeN,
    timeframe: source.timeframe,
    horizon: source.horizon,
    strategyConcept: source.strategyConcept,
    reportedMetrics: source.reportedMetrics,
    transactionCostAssumptions: source.transactionCostAssumptions,
    statedLimitations: source.statedLimitations,
    datasetReference: source.datasetReference,
    licenseStatus: source.licenseStatus,
    provenanceStatus: source.provenanceStatus,
    sourceProvenance: source.sourceProvenance,
    parserVersion: source.parserVersion,
  });
}

export function createResearchSourceMetadata({ study, source } = {}) {
  if (!verifyLiteratureStudy(study)) throw new Error("LITERATURE_STUDY_INVALID");
  const raw = source ?? {};
  const canonicalUrl = normalizeCanonicalUrl(raw.canonicalUrl ?? study.sourceUrl, "canonicalUrl");
  const sourceIdentity = Object.freeze({ sourceKey: study.sourceKey });
  const ingestionTimestamp = normalizeIngestionTimestamp(raw.ingestionTimestamp ?? raw.ingestedAt);
  const base = Object.freeze({
    researchSourceId: `research-source:${researchDigest(sourceIdentity)}`,
    sourceKey: study.sourceKey,
    title: study.title,
    authors: study.authors,
    publication: optionalString(raw.publication ?? study.venue),
    publicationDate: optionalDate(raw.publicationDate, "publicationDate"),
    doi: study.doi,
    canonicalUrl,
    sourceType: requiredString(raw.sourceType, "sourceType"),
    market: study.market,
    assetClass: optionalString(raw.assetClass),
    marketsStudied: normalizeStringList(raw.marketsStudied ?? [study.market], "marketsStudied"),
    samplePeriod: Object.freeze({ startDate: study.sample.startDate, endDate: study.sample.endDate }),
    sampleN: optionalPositiveInteger(raw.sampleN ?? study.sample.observationCount, "sampleN"),
    tradeN: optionalPositiveInteger(raw.tradeN, "tradeN"),
    timeframe: optionalString(raw.timeframe),
    horizon: optionalString(raw.horizon),
    strategyConcept: optionalString(raw.strategyConcept ?? study.strategySummary),
    reportedMetrics: study.reportedMetrics,
    transactionCostAssumptions: raw.transactionCostAssumptions == null ? null : canonicalJson(raw.transactionCostAssumptions, "transactionCostAssumptions"),
    statedLimitations: normalizeStringList(raw.statedLimitations, "statedLimitations"),
    datasetReference: raw.datasetReference == null ? null : canonicalJson(raw.datasetReference, "datasetReference"),
    licenseStatus: requiredString(raw.licenseStatus ?? "NOT_REPORTED", "licenseStatus"),
    provenanceStatus: requiredString(raw.provenanceStatus ?? "DOCUMENTED", "provenanceStatus"),
    sourceProvenance: canonicalJson(raw.sourceProvenance, "sourceProvenance"),
    ingestionTimestamp,
    ingestedAt: ingestionTimestamp,
    parserVersion: requiredString(raw.parserVersion, "parserVersion"),
    availability: Object.freeze({
      publicationDate: raw.publicationDate == null ? "NOT_REPORTED" : "REPORTED",
      assetClass: raw.assetClass == null ? "NOT_REPORTED" : "REPORTED",
      tradeN: raw.tradeN == null ? "NOT_REPORTED" : "REPORTED",
      timeframe: raw.timeframe == null ? "NOT_REPORTED" : "REPORTED",
      horizon: raw.horizon == null ? "NOT_REPORTED" : "REPORTED",
      transactionCostAssumptions: raw.transactionCostAssumptions == null ? "NOT_REPORTED" : "REPORTED",
      datasetReference: raw.datasetReference == null ? "NOT_REPORTED" : "REPORTED",
    }),
  });
  const sourceFingerprint = researchDigest(sourceFingerprintCore(base));
  return Object.freeze({
    ...base,
    sourceFingerprint,
    sourceRecordDigest: researchDigest({
      sourceFingerprint,
      ingestionTimestamp: base.ingestionTimestamp,
      availability: base.availability,
    }),
  });
}

function normalizeGenomeProvenance(value, researchSourceId, fieldName) {
  const provenance = canonicalJson(value, `paperGenome.${fieldName}.sourceProvenance`);
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new TypeError(`paperGenome.${fieldName}.sourceProvenance is required`);
  }
  if (provenance.researchSourceId !== researchSourceId) {
    throw new Error(`paperGenome.${fieldName}.sourceProvenance must match researchSourceId`);
  }
  if (typeof provenance.locator !== "string" || !provenance.locator.trim()) {
    throw new TypeError(`paperGenome.${fieldName}.sourceProvenance.locator is required`);
  }
  return provenance;
}

function normalizeGenomeField(raw, researchSourceId, fieldName) {
  if (raw == null) {
    return Object.freeze({ value: null, sourceProvenance: null, confidence: null, extractionStatus: "NOT_REPORTED" });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`paperGenome.${fieldName} must be an evidence object`);
  const extractionStatus = requiredString(raw.extractionStatus, `paperGenome.${fieldName}.extractionStatus`).toUpperCase();
  if (!EXTRACTION_STATUSES.has(extractionStatus)) throw new RangeError(`paperGenome.${fieldName}.extractionStatus is unsupported`);
  const value = raw.value == null ? null : canonicalJson(raw.value, `paperGenome.${fieldName}.value`);
  if (new Set(["NOT_REPORTED", "NOT_APPLICABLE"]).has(extractionStatus)) {
    if (value !== null || raw.sourceProvenance != null || raw.confidence != null) {
      throw new Error(`paperGenome.${fieldName} cannot carry evidence when ${extractionStatus}`);
    }
    return Object.freeze({ value: null, sourceProvenance: null, confidence: null, extractionStatus });
  }
  if (value === null) throw new Error(`paperGenome.${fieldName}.value is required when ${extractionStatus}`);
  const confidence = requiredString(raw.confidence, `paperGenome.${fieldName}.confidence`).toUpperCase();
  if (!EXTRACTION_CONFIDENCE.has(confidence)) throw new RangeError(`paperGenome.${fieldName}.confidence is unsupported`);
  const sourceProvenance = normalizeGenomeProvenance(raw.sourceProvenance, researchSourceId, fieldName);
  return Object.freeze({ value, sourceProvenance, confidence, extractionStatus });
}

export function createPaperGenome({ researchSourceId, fields = {} } = {}) {
  const sourceId = requiredString(researchSourceId, "researchSourceId");
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new TypeError("paper genome fields are required");
  const unknown = Object.keys(fields).filter((key) => !PAPER_GENOME_FIELDS.includes(key));
  if (unknown.length > 0) throw new Error(`unsupported Paper Genome fields: ${unknown.sort().join(",")}`);
  const normalizedFields = Object.freeze(Object.fromEntries(PAPER_GENOME_FIELDS.map((field) => [
    field,
    normalizeGenomeField(fields[field], sourceId, field),
  ])));
  const genomeCore = Object.freeze({ researchSourceId: sourceId, fields: normalizedFields });
  return Object.freeze({
    schemaVersion: GLOBAL_STRATEGY_RESEARCH_SCHEMA_VERSION,
    ...genomeCore,
    paperGenomeDigest: researchDigest(genomeCore),
  });
}

function supportedGenomeValue(genome, fieldName) {
  const field = genome.fields[fieldName];
  return field.extractionStatus === "SUPPORTED" ? field.value : null;
}

function normalizedSemanticValue(value) {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase();
  if (Array.isArray(value)) return Object.freeze(value.map(normalizedSemanticValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizedSemanticValue(item)])));
  return value;
}

export function createStrategyDna({ study, sourceMetadata, paperGenome } = {}) {
  if (!verifyLiteratureStudy(study)) throw new Error("LITERATURE_STUDY_INVALID");
  if (!sourceMetadata || sourceMetadata.researchSourceId !== paperGenome?.researchSourceId) throw new Error("RESEARCH_SOURCE_ID_MISMATCH");
  const components = Object.freeze({
    featureFactorSet: normalizedSemanticValue(supportedGenomeValue(paperGenome, "features")),
    entryLogic: normalizedSemanticValue(supportedGenomeValue(paperGenome, "entryRule") ?? supportedGenomeValue(paperGenome, "signalCondition")),
    exitLogic: normalizedSemanticValue(supportedGenomeValue(paperGenome, "exitRule")),
    timeframe: normalizedSemanticValue(supportedGenomeValue(paperGenome, "timeframe") ?? sourceMetadata.timeframe),
    universe: normalizedSemanticValue(supportedGenomeValue(paperGenome, "universe")),
    market: normalizedSemanticValue(supportedGenomeValue(paperGenome, "market") ?? study.market),
    direction: normalizedSemanticValue(supportedGenomeValue(paperGenome, "direction")),
    costModel: normalizedSemanticValue(supportedGenomeValue(paperGenome, "costAssumptions") ?? sourceMetadata.transactionCostAssumptions),
    regimeDependency: normalizedSemanticValue(supportedGenomeValue(paperGenome, "regimeAssumptions")),
    parameterStructure: normalizedSemanticValue(supportedGenomeValue(paperGenome, "parameterStructure")),
  });
  const familyComponents = Object.freeze({
    declaredStrategyFamily: normalizedSemanticValue(study.strategyFamily),
    featureFactorSet: components.featureFactorSet,
    entryLogic: components.entryLogic,
    exitLogic: components.exitLogic,
    timeframe: components.timeframe,
    universe: components.universe,
    market: components.market,
    direction: components.direction,
    regimeDependency: components.regimeDependency,
  });
  const strategyDnaHash = `strategy-dna:${researchDigest(components)}`;
  const strategyFamilyId = `strategy-family:${researchDigest(familyComponents)}`;
  return Object.freeze({
    components,
    familyComponents,
    strategyDnaHash,
    strategyFamilyId,
    paperVariantId: `paper-variant:${researchDigest({ researchSourceId: sourceMetadata.researchSourceId, strategyDnaHash })}`,
  });
}

function globalStrategySafety() {
  return Object.freeze({
    literatureCanProveProfitability: false,
    literatureCanPromoteStrategy: false,
    aiCanPromoteStrategy: false,
    eligibleForScannerResearchConsideration: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    transferEnabled: false,
    withdrawalEnabled: false,
    executionAuthority: "NONE",
    actualOrders: 0,
    actualCancels: 0,
    actualAmends: 0,
    actualTransfers: 0,
    actualWithdrawals: 0,
  });
}

export function createGlobalStrategyResearchRecord({ study: rawStudy, source, paperGenome: genomeFields } = {}) {
  const study = createLiteratureStudy(rawStudy);
  const sourceMetadata = createResearchSourceMetadata({ study, source });
  const paperGenome = createPaperGenome({ researchSourceId: sourceMetadata.researchSourceId, fields: genomeFields });
  const strategyDna = createStrategyDna({ study, sourceMetadata, paperGenome });
  const evidenceCore = Object.freeze({
    literatureDigest: study.literatureDigest,
    sourceFingerprint: sourceMetadata.sourceFingerprint,
    sourceRecordDigest: sourceMetadata.sourceRecordDigest,
    paperGenomeDigest: paperGenome.paperGenomeDigest,
    strategyDnaHash: strategyDna.strategyDnaHash,
    strategyFamilyId: strategyDna.strategyFamilyId,
    paperVariantId: strategyDna.paperVariantId,
  });
  return Object.freeze({
    schemaVersion: GLOBAL_STRATEGY_RESEARCH_SCHEMA_VERSION,
    researchSourceId: sourceMetadata.researchSourceId,
    literatureStudy: study,
    sourceMetadata,
    paperGenome,
    strategyDna,
    evidenceFingerprint: researchDigest(evidenceCore),
    evidenceIndependenceStatus: "NOT_ESTABLISHED",
    safety: globalStrategySafety(),
  });
}

export function verifyGlobalStrategyResearchRecord(record) {
  if (!record || record.schemaVersion !== GLOBAL_STRATEGY_RESEARCH_SCHEMA_VERSION) return false;
  if (!verifyLiteratureStudy(record.literatureStudy)) return false;
  const source = record.sourceMetadata;
  if (!source || source.researchSourceId !== `research-source:${researchDigest({ sourceKey: source.sourceKey })}`) return false;
  if (source.sourceFingerprint !== researchDigest(sourceFingerprintCore(source))) return false;
  if (source.sourceRecordDigest !== researchDigest({
    sourceFingerprint: source.sourceFingerprint,
    ingestionTimestamp: source.ingestionTimestamp,
    availability: source.availability,
  })) return false;
  const genomeCore = { researchSourceId: record.paperGenome?.researchSourceId, fields: record.paperGenome?.fields };
  if (record.paperGenome?.paperGenomeDigest !== researchDigest(genomeCore)) return false;
  const dna = record.strategyDna;
  if (dna?.strategyDnaHash !== `strategy-dna:${researchDigest(dna?.components)}`) return false;
  if (dna?.strategyFamilyId !== `strategy-family:${researchDigest(dna?.familyComponents)}`) return false;
  if (dna?.paperVariantId !== `paper-variant:${researchDigest({ researchSourceId: source.researchSourceId, strategyDnaHash: dna.strategyDnaHash })}`) return false;
  const evidenceCore = {
    literatureDigest: record.literatureStudy.literatureDigest,
    sourceFingerprint: source.sourceFingerprint,
    sourceRecordDigest: source.sourceRecordDigest,
    paperGenomeDigest: record.paperGenome.paperGenomeDigest,
    strategyDnaHash: dna.strategyDnaHash,
    strategyFamilyId: dna.strategyFamilyId,
    paperVariantId: dna.paperVariantId,
  };
  return record.researchSourceId === source.researchSourceId
    && record.evidenceFingerprint === researchDigest(evidenceCore)
    && record.evidenceIndependenceStatus === "NOT_ESTABLISHED"
    && record.safety?.eligibleForScannerResearchConsideration === false
    && record.safety?.executionAuthority === "NONE";
}

function buildStrategyFamilies(records) {
  const grouped = new Map();
  for (const record of records) {
    const familyId = record.strategyDna.strategyFamilyId;
    const current = grouped.get(familyId) ?? [];
    current.push(record);
    grouped.set(familyId, current);
  }
  return Object.freeze([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([strategyFamilyId, familyRecords]) => Object.freeze({
    strategyFamilyId,
    researchSourceIds: Object.freeze(familyRecords.map((record) => record.researchSourceId).sort()),
    strategyDnaHashes: Object.freeze([...new Set(familyRecords.map((record) => record.strategyDna.strategyDnaHash))].sort()),
    paperVariantIds: Object.freeze(familyRecords.map((record) => record.strategyDna.paperVariantId).sort()),
    evidenceIndependenceStatus: "NOT_ESTABLISHED",
    independentEvidenceCount: null,
  })));
}

function globalStrategyRegistryCore({ registryId, records, strategyFamilies }) {
  return Object.freeze({ registryId, records, strategyFamilies });
}

function withGlobalStrategyRegistryDigest(core) {
  return Object.freeze({
    schemaVersion: GLOBAL_STRATEGY_RESEARCH_SCHEMA_VERSION,
    ...core,
    registryDigest: researchDigest(core),
    safety: globalStrategySafety(),
  });
}

export function createGlobalStrategyResearchRegistry({ registryId = "GLOBAL_STRATEGY_RESEARCH_V1" } = {}) {
  return withGlobalStrategyRegistryDigest(globalStrategyRegistryCore({
    registryId: requiredString(registryId, "registryId"),
    records: Object.freeze([]),
    strategyFamilies: Object.freeze([]),
  }));
}

export function appendGlobalStrategyResearchRecord(registry, rawRecord) {
  if (!verifyGlobalStrategyResearchRegistry(registry)) throw new Error("GLOBAL_STRATEGY_RESEARCH_REGISTRY_INVALID");
  const record = createGlobalStrategyResearchRecord(rawRecord);
  if (registry.records.some((item) => item.researchSourceId === record.researchSourceId)) {
    throw new Error(`DUPLICATE_RESEARCH_SOURCE:${record.researchSourceId}`);
  }
  const records = Object.freeze([...registry.records, record]);
  return withGlobalStrategyRegistryDigest(globalStrategyRegistryCore({
    registryId: registry.registryId,
    records,
    strategyFamilies: buildStrategyFamilies(records),
  }));
}

export function verifyGlobalStrategyResearchRegistry(registry) {
  if (!registry || registry.schemaVersion !== GLOBAL_STRATEGY_RESEARCH_SCHEMA_VERSION || !Array.isArray(registry.records)) return false;
  if (registry.records.some((record) => !verifyGlobalStrategyResearchRecord(record))) return false;
  const sourceIds = registry.records.map((record) => record.researchSourceId);
  if (sourceIds.length !== new Set(sourceIds).size) return false;
  const expectedFamilies = buildStrategyFamilies(registry.records);
  if (researchDigest(expectedFamilies) !== researchDigest(registry.strategyFamilies)) return false;
  const core = globalStrategyRegistryCore({ registryId: registry.registryId, records: registry.records, strategyFamilies: registry.strategyFamilies });
  return registry.registryDigest === researchDigest(core)
    && registry.safety?.eligibleForScannerResearchConsideration === false
    && registry.safety?.actualOrders === 0
    && registry.safety?.actualTransfers === 0;
}

export const EVIDENCE_TIERS = Object.freeze({
  E1: "EXTERNAL_RESEARCH_EVIDENCE",
  E2: "OUR_INDEPENDENT_HISTORICAL_REPLICATION",
  E3: "OUR_NATURAL_SHADOW",
  E4: "OUR_NATURAL_PAPER_SETTLEMENT",
});

const EVIDENCE_KIND_TIER = Object.freeze({
  EXTERNAL_REPORTED_EVIDENCE: "E1",
  EXTERNAL_RAW_DATA_REFERENCE: "E1",
  EXTERNAL_META_ANALYSIS: "E1",
  OUR_REPLICATION: "E2",
  OUR_REPLICATION_ON_EXTERNAL_DATA: "E2",
  OUR_OOS: "E2",
  OUR_WALK_FORWARD: "E2",
  OUR_FINAL_HOLDOUT: "E2",
  OUR_NATURAL_SHADOW: "E3",
  OUR_NATURAL_PAPER: "E4",
  OUR_SETTLEMENT: "E4",
});

function exactResearchSha(value) {
  const sha = requiredString(value, "researchCodeSha").toLowerCase();
  if (!SHA40.test(sha)) throw new TypeError("researchCodeSha must be an exact 40-character SHA");
  return sha;
}

export function createUnifiedStrategyIdentity(raw) {
  const identity = Object.freeze({
    strategyId: requiredString(raw?.strategyId, "strategyId"),
    strategyFamilyId: requiredString(raw?.strategyFamilyId, "strategyFamilyId"),
    strategyVersion: requiredString(raw?.strategyVersion, "strategyVersion"),
    parameterHash: requiredString(raw?.parameterHash, "parameterHash"),
    researchCodeSha: exactResearchSha(raw?.researchCodeSha),
    market: requiredString(raw?.market, "market"),
    direction: requiredString(raw?.direction, "direction"),
    timeframe: requiredString(raw?.timeframe, "timeframe"),
    costPolicyVersion: requiredString(raw?.costPolicyVersion, "costPolicyVersion"),
  });
  const antiRenameIdentity = Object.freeze({
    strategyFamilyId: identity.strategyFamilyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    researchCodeSha: identity.researchCodeSha,
    market: identity.market,
    direction: identity.direction,
    timeframe: identity.timeframe,
    costPolicyVersion: identity.costPolicyVersion,
  });
  return Object.freeze({
    ...identity,
    strategyIdentityHash: researchDigest(identity),
    antiRenameIdentityHash: researchDigest(antiRenameIdentity),
  });
}

function evidenceTierSafety() {
  return Object.freeze({
    externalEvidenceCanBecomeOurMetrics: false,
    externalSampleCanBecomePaperSample: false,
    historicalEvidenceCanBecomeNaturalForward: false,
    externalEvidenceCanProveProfitability: false,
    aiCanCreateNumericEvidence: false,
    aiCanPromoteStrategy: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
    actualOrders: 0,
    actualCancels: 0,
    actualAmends: 0,
    actualTransfers: 0,
    actualWithdrawals: 0,
  });
}

function evidenceTierCounts(entries) {
  const byKind = (kind) => entries.filter((entry) => entry.evidenceKind === kind).reduce((sum, entry) => sum + entry.sampleCount, 0);
  return Object.freeze({
    externalPaperN: byKind("EXTERNAL_REPORTED_EVIDENCE"),
    externalStudyCount: entries.filter((entry) => entry.tier === "E1" && entry.evidenceKind !== "EXTERNAL_RAW_DATA_REFERENCE").length,
    externalDatasetN: byKind("EXTERNAL_RAW_DATA_REFERENCE"),
    ourReplicationN: byKind("OUR_REPLICATION") + byKind("OUR_REPLICATION_ON_EXTERNAL_DATA"),
    ourOosN: byKind("OUR_OOS"),
    ourWalkForwardN: byKind("OUR_WALK_FORWARD"),
    ourHoldoutN: byKind("OUR_FINAL_HOLDOUT"),
    ourShadowN: byKind("OUR_NATURAL_SHADOW"),
    ourPaperN: byKind("OUR_NATURAL_PAPER"),
    ourSettledN: byKind("OUR_SETTLEMENT"),
  });
}

function tierLedgerCore({ strategyIdentity, entries }) {
  return Object.freeze({ strategyIdentity, entries, counts: evidenceTierCounts(entries) });
}

function withTierLedgerDigest(core) {
  return Object.freeze({
    schemaVersion: 1,
    ...core,
    ledgerDigest: researchDigest(core),
    safety: evidenceTierSafety(),
  });
}

export function createStrategyEvidenceTierLedger({ identity } = {}) {
  return withTierLedgerDigest(tierLedgerCore({
    strategyIdentity: createUnifiedStrategyIdentity(identity),
    entries: Object.freeze([]),
  }));
}

function normalizeEvidenceTierEntry(ledger, raw) {
  const evidenceKind = requiredString(raw?.evidenceKind, "evidenceKind").toUpperCase();
  const tier = EVIDENCE_KIND_TIER[evidenceKind];
  if (!tier) throw new RangeError(`unsupported evidenceKind: ${evidenceKind}`);
  const sampleCount = optionalPositiveInteger(raw?.sampleCount, "sampleCount");
  if (sampleCount == null) throw new TypeError("sampleCount is required");
  const sourceFingerprint = requiredString(raw?.sourceFingerprint, "sourceFingerprint");
  const evaluationSliceId = requiredString(raw?.evaluationSliceId, "evaluationSliceId");
  const reportedMetrics = raw?.reportedMetrics == null ? null : canonicalJson(raw.reportedMetrics, "reportedMetrics");
  const deterministicMetrics = raw?.deterministicMetrics == null ? null : canonicalJson(raw.deterministicMetrics, "deterministicMetrics");
  if (tier === "E1" && deterministicMetrics !== null) throw new Error("E1_EXTERNAL_EVIDENCE_CANNOT_POPULATE_OUR_METRICS");
  if (tier !== "E1" && reportedMetrics !== null) throw new Error("OUR_EVIDENCE_CANNOT_BE_RECORDED_AS_EXTERNAL_REPORTED_METRICS");
  const isNatural = tier === "E3" || tier === "E4";
  const naturalObservationAt = raw?.naturalObservationAt == null ? null : normalizeIngestionTimestamp(raw.naturalObservationAt);
  const sourceRuntime = optionalString(raw?.sourceRuntime);
  if (isNatural) {
    if (!naturalObservationAt) throw new Error(`${tier}_NATURAL_OBSERVATION_TIMESTAMP_REQUIRED`);
    if (sourceRuntime !== "RESEARCH_PRODUCTION_PRIMARY") throw new Error(`${tier}_PRIMARY_RUNTIME_REQUIRED`);
    if (raw?.historicalBackfill !== false) throw new Error(`${tier}_HISTORICAL_BACKFILL_FORBIDDEN`);
  }
  const classification = evidenceKind === "OUR_REPLICATION_ON_EXTERNAL_DATA"
    ? "HISTORICAL_OUR_REPLICATION_ON_EXTERNAL_DATA"
    : (tier === "E1" ? "EXTERNAL_EVIDENCE_ONLY" : (isNatural ? "NATURAL_FORWARD_EVIDENCE" : "OUR_HISTORICAL_EVIDENCE"));
  const evidenceIdentity = Object.freeze({
    antiRenameIdentityHash: ledger.strategyIdentity.antiRenameIdentityHash,
    tier,
    evidenceKind,
    sourceFingerprint,
    evaluationSliceId,
    naturalObservationAt,
  });
  const core = Object.freeze({
    evidenceId: `strategy-evidence:${researchDigest(evidenceIdentity)}`,
    tier,
    tierName: EVIDENCE_TIERS[tier],
    evidenceKind,
    classification,
    sampleCount,
    sourceFingerprint,
    evaluationSliceId,
    naturalObservationAt,
    sourceRuntime,
    historicalBackfill: isNatural ? false : null,
    resultStatus: requiredString(raw?.resultStatus, "resultStatus"),
    failureReason: optionalString(raw?.failureReason),
    reportedMetrics,
    deterministicMetrics,
  });
  return Object.freeze({ ...core, evidenceFingerprint: researchDigest(core) });
}

export function appendStrategyEvidenceTierEntry(ledger, raw) {
  if (!verifyStrategyEvidenceTierLedger(ledger)) throw new Error("STRATEGY_EVIDENCE_TIER_LEDGER_INVALID");
  const entry = normalizeEvidenceTierEntry(ledger, raw);
  if (ledger.entries.some((item) => item.evidenceId === entry.evidenceId)) throw new Error(`DUPLICATE_EVIDENCE:${entry.evidenceId}`);
  const entries = Object.freeze([...ledger.entries, entry]);
  return withTierLedgerDigest(tierLedgerCore({ strategyIdentity: ledger.strategyIdentity, entries }));
}

export function verifyStrategyEvidenceTierLedger(ledger) {
  if (!ledger || ledger.schemaVersion !== 1 || !Array.isArray(ledger.entries)) return false;
  const identity = ledger.strategyIdentity;
  if (!identity || identity.strategyIdentityHash !== researchDigest({
    strategyId: identity.strategyId,
    strategyFamilyId: identity.strategyFamilyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    researchCodeSha: identity.researchCodeSha,
    market: identity.market,
    direction: identity.direction,
    timeframe: identity.timeframe,
    costPolicyVersion: identity.costPolicyVersion,
  })) return false;
  if (identity.antiRenameIdentityHash !== researchDigest({
    strategyFamilyId: identity.strategyFamilyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    researchCodeSha: identity.researchCodeSha,
    market: identity.market,
    direction: identity.direction,
    timeframe: identity.timeframe,
    costPolicyVersion: identity.costPolicyVersion,
  })) return false;
  if (ledger.entries.some((entry) => entry.evidenceFingerprint !== researchDigest(Object.freeze({
    evidenceId: entry.evidenceId,
    tier: entry.tier,
    tierName: entry.tierName,
    evidenceKind: entry.evidenceKind,
    classification: entry.classification,
    sampleCount: entry.sampleCount,
    sourceFingerprint: entry.sourceFingerprint,
    evaluationSliceId: entry.evaluationSliceId,
    naturalObservationAt: entry.naturalObservationAt,
    sourceRuntime: entry.sourceRuntime,
    historicalBackfill: entry.historicalBackfill,
    resultStatus: entry.resultStatus,
    failureReason: entry.failureReason,
    reportedMetrics: entry.reportedMetrics,
    deterministicMetrics: entry.deterministicMetrics,
  })))) return false;
  const ids = ledger.entries.map((entry) => entry.evidenceId);
  if (ids.length !== new Set(ids).size) return false;
  const core = tierLedgerCore({ strategyIdentity: ledger.strategyIdentity, entries: ledger.entries });
  return ledger.ledgerDigest === researchDigest(core)
    && ledger.safety?.externalSampleCanBecomePaperSample === false
    && ledger.safety?.historicalEvidenceCanBecomeNaturalForward === false
    && ledger.safety?.executionAuthority === "NONE";
}

export function summarizeStrategyEvidenceTiers(ledger) {
  if (!verifyStrategyEvidenceTierLedger(ledger)) throw new Error("STRATEGY_EVIDENCE_TIER_LEDGER_INVALID");
  return Object.freeze({
    strategyId: ledger.strategyIdentity.strategyId,
    strategyFamilyId: ledger.strategyIdentity.strategyFamilyId,
    ...ledger.counts,
    externalAndOurSampleCountsCombined: false,
    profitabilityProven: false,
    eligibleForScannerResearchConsideration: false,
    safety: evidenceTierSafety(),
  });
}

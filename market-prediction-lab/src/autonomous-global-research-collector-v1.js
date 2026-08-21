import {
  appendGlobalStrategyResearchRecord,
  verifyGlobalStrategyResearchRegistry,
} from "./global-alpha-literature-registry-v1.js";
import { researchDigest } from "./research-trial-registry.js";

export const AUTONOMOUS_GLOBAL_RESEARCH_COLLECTOR_SCHEMA_VERSION = 1;
export const APPROVED_GLOBAL_RESEARCH_SOURCE_CLASSES = Object.freeze([
  "PEER_REVIEWED_JOURNAL",
  "DOI_METADATA",
  "NBER",
  "UNIVERSITY",
  "SSRN",
  "ARXIV",
  "OFFICIAL_RESEARCH_INSTITUTION",
  "OFFICIAL_EXCHANGE_DATASET",
  "OPEN_RESEARCH_REPOSITORY",
]);
export const GLOBAL_RESEARCH_DISCOVERY_STATES = Object.freeze([
  "DISCOVERED",
  "ALREADY_KNOWN",
  "UPDATED_SOURCE",
  "REJECTED_LOW_QUALITY",
  "BLOCKED_LICENSE",
  "BLOCKED_DATA",
]);

const APPROVED_SOURCE_SET = new Set(APPROVED_GLOBAL_RESEARCH_SOURCE_CLASSES);
const STATE_SET = new Set(GLOBAL_RESEARCH_DISCOVERY_STATES);
const QUALITY_SET = new Set(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]);
const LICENSE_BLOCKERS = new Set(["BLOCKED", "PROPRIETARY_NO_ACCESS", "REDISTRIBUTION_PROHIBITED"]);

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function optionalText(value, name) {
  if (value == null || value === "") return null;
  return requiredText(value, name);
}

function timestamp(value, name) {
  const parsed = Date.parse(requiredText(value, name));
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

function dateOnly(value, name) {
  if (value == null || value === "") return null;
  return timestamp(value, name).slice(0, 10);
}

function canonicalUrl(value, name) {
  if (value == null || value === "") return null;
  const parsed = new URL(requiredText(value, name));
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new TypeError(`${name} must use http or https`);
  parsed.hash = "";
  return parsed.toString();
}

function canonicalDoi(value) {
  if (value == null || value === "") return null;
  const doi = requiredText(value, "doi").toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "");
  if (!/^10\.\d{4,9}\/.+/.test(doi)) throw new TypeError("doi must be canonicalizable");
  return doi;
}

function stringList(value, name) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return Object.freeze([...new Set(value.map((item, index) => requiredText(item, `${name}[${index}]`)))].sort());
}

function canonicalJson(value, name) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must contain finite JSON values`);
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((item, index) => canonicalJson(item, `${name}[${index}]`)));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.freeze(Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key], `${name}.${key}`)])));
  }
  throw new TypeError(`${name} must contain JSON values only`);
}

function optionalPositiveInteger(value, name) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer or null`);
  return value;
}

function normalizedText(value) {
  return value == null ? null : String(value).trim().toLowerCase().replace(/[^a-z0-9가-힣]+/gu, " ").trim();
}

function normalizeSamplePeriod(raw = {}) {
  const startDate = dateOnly(raw.startDate, "samplePeriod.startDate");
  const endDate = dateOnly(raw.endDate, "samplePeriod.endDate");
  if (startDate && endDate && startDate > endDate) throw new RangeError("sample period is inverted");
  return Object.freeze({ startDate, endDate });
}

function collectorSafety() {
  return Object.freeze({
    metadataAndLawfulPublicContentOnly: true,
    copyrightedFullPaperStored: false,
    paidAiFallbackAllowed: false,
    profitabilityAuthority: false,
    promotionAuthority: false,
    scannerAuthority: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
    actualExternalCalls: 0,
    actualPaidProviderCalls: 0,
    actualOrders: 0,
    actualCancels: 0,
    actualAmends: 0,
    actualTransfers: 0,
    actualWithdrawals: 0,
  });
}

function recordCore(raw) {
  if (raw?.fullText != null || raw?.paperBody != null) throw new Error("COPYRIGHT_FULL_TEXT_STORAGE_FORBIDDEN");
  const title = requiredText(raw?.title, "title");
  const authors = stringList(raw?.authors, "authors");
  const doi = canonicalDoi(raw?.doi);
  const canonical = canonicalUrl(raw?.canonicalUrl ?? raw?.sourceUrl, "canonicalUrl");
  if (!doi && !canonical) throw new TypeError("doi or canonicalUrl is required");
  const sourceClass = requiredText(raw?.sourceClass, "sourceClass").toUpperCase();
  const sourceQuality = requiredText(raw?.sourceQuality ?? "UNKNOWN", "sourceQuality").toUpperCase();
  if (!QUALITY_SET.has(sourceQuality)) throw new RangeError("sourceQuality is unsupported");
  const licenseStatus = requiredText(raw?.licenseStatus ?? "NOT_REPORTED", "licenseStatus").toUpperCase();
  const samplePeriod = normalizeSamplePeriod(raw?.samplePeriod);
  const ingestedAt = timestamp(raw?.ingestedAt, "ingestedAt");
  const stableIdentity = Object.freeze({
    sourceKey: doi ? `doi:${doi}` : `url:${canonical.toLowerCase()}`,
  });
  const base = Object.freeze({
    researchSourceId: `research-source:${researchDigest(stableIdentity)}`,
    title,
    authors,
    venue: optionalText(raw?.venue, "venue"),
    publicationDate: dateOnly(raw?.publicationDate, "publicationDate"),
    doi,
    canonicalUrl: canonical,
    sourceClass,
    assetClass: optionalText(raw?.assetClass, "assetClass"),
    market: optionalText(raw?.market, "market"),
    timeframe: optionalText(raw?.timeframe, "timeframe"),
    samplePeriod,
    reportedN: optionalPositiveInteger(raw?.reportedN, "reportedN"),
    datasetReference: canonicalJson(raw?.datasetReference, "datasetReference"),
    reportedMetrics: canonicalJson(raw?.reportedMetrics, "reportedMetrics"),
    costAssumptions: canonicalJson(raw?.costAssumptions, "costAssumptions"),
    strategyFamily: optionalText(raw?.strategyFamily, "strategyFamily"),
    strategySummary: optionalText(raw?.strategySummary, "strategySummary"),
    formulaSummary: optionalText(raw?.formulaSummary, "formulaSummary"),
    abstractText: optionalText(raw?.abstractText, "abstractText"),
    sourceQuality,
    licenseStatus,
    provenanceStatus: requiredText(raw?.provenanceStatus ?? "DOCUMENTED", "provenanceStatus").toUpperCase(),
    sourceProvenance: canonicalJson(raw?.sourceProvenance, "sourceProvenance"),
    ingestedAt,
    parserVersion: requiredText(raw?.parserVersion, "parserVersion"),
    availability: Object.freeze({
      publicationDate: raw?.publicationDate == null ? "NOT_REPORTED" : "REPORTED",
      timeframe: raw?.timeframe == null ? "NOT_REPORTED" : "REPORTED",
      reportedN: raw?.reportedN == null ? "NOT_REPORTED" : "REPORTED",
      datasetReference: raw?.datasetReference == null ? "NOT_REPORTED" : "REPORTED",
      reportedMetrics: raw?.reportedMetrics == null ? "NOT_REPORTED" : "REPORTED",
      costAssumptions: raw?.costAssumptions == null ? "NOT_REPORTED" : "REPORTED",
    }),
    copyrightedFullTextStored: false,
  });
  const { ingestedAt: _observedAt, ...fingerprintCore } = base;
  return Object.freeze({ ...base, sourceFingerprint: researchDigest(fingerprintCore) });
}

function dedupKeys(record) {
  return Object.freeze({
    doi: record.doi,
    titleAuthors: researchDigest({ title: normalizedText(record.title), authors: record.authors.map(normalizedText).sort() }),
    datasetSampleFamily: researchDigest({
      datasetReference: record.datasetReference,
      samplePeriod: record.samplePeriod,
      strategyFamily: normalizedText(record.strategyFamily),
    }),
    sourceFingerprint: record.sourceFingerprint,
  });
}

function stateCore({ collectorId, cursor, records, events, cadencePolicy }) {
  return Object.freeze({
    schemaVersion: AUTONOMOUS_GLOBAL_RESEARCH_COLLECTOR_SCHEMA_VERSION,
    collectorId,
    cursor,
    records,
    events,
    cadencePolicy,
    safety: collectorSafety(),
  });
}

function withStateDigest(core) {
  return Object.freeze({ ...core, stateDigest: researchDigest(core) });
}

export function createGlobalResearchCollector({ collectorId = "AUTONOMOUS_GLOBAL_RESEARCH_COLLECTOR_V1", cursor = null, cadencePolicy = {} } = {}) {
  const cadence = Object.freeze({
    discoveryCadence: optionalText(cadencePolicy.discoveryCadence, "discoveryCadence"),
    sourceRefreshCadence: optionalText(cadencePolicy.sourceRefreshCadence, "sourceRefreshCadence"),
    schedulerOwner: requiredText(cadencePolicy.schedulerOwner ?? "EXTERNAL_CANONICAL_TIMER_OWNER", "schedulerOwner"),
    timerActivated: false,
  });
  return withStateDigest(stateCore({
    collectorId: requiredText(collectorId, "collectorId"),
    cursor: optionalText(cursor, "cursor"),
    records: Object.freeze([]),
    events: Object.freeze([]),
    cadencePolicy: cadence,
  }));
}

export function verifyGlobalResearchCollector(state) {
  if (!state || state.schemaVersion !== AUTONOMOUS_GLOBAL_RESEARCH_COLLECTOR_SCHEMA_VERSION) return false;
  const core = stateCore({
    collectorId: state.collectorId,
    cursor: state.cursor,
    records: state.records,
    events: state.events,
    cadencePolicy: state.cadencePolicy,
  });
  return state.stateDigest === researchDigest(core)
    && state.safety?.copyrightedFullPaperStored === false
    && state.safety?.executionAuthority === "NONE";
}

function classifyAdmission(record) {
  if (!APPROVED_SOURCE_SET.has(record.sourceClass) || record.sourceQuality === "LOW" || record.provenanceStatus === "UNVERIFIED") {
    return "REJECTED_LOW_QUALITY";
  }
  if (LICENSE_BLOCKERS.has(record.licenseStatus)) return "BLOCKED_LICENSE";
  if (record.datasetReference?.status === "UNAVAILABLE" || record.datasetReference?.available === false) return "BLOCKED_DATA";
  return "DISCOVERED";
}

function matchesKnown(left, right) {
  const a = dedupKeys(left);
  const b = dedupKeys(right);
  return (a.doi && a.doi === b.doi)
    || a.titleAuthors === b.titleAuthors
    || a.sourceFingerprint === b.sourceFingerprint
    || (left.datasetReference != null && right.datasetReference != null && a.datasetSampleFamily === b.datasetSampleFamily);
}

export function ingestGlobalResearchMetadata(state, raw, { nextCursor = null } = {}) {
  if (!verifyGlobalResearchCollector(state)) throw new Error("GLOBAL_RESEARCH_COLLECTOR_STATE_INVALID");
  const record = recordCore(raw);
  const knownIndex = state.records.findIndex((item) => matchesKnown(item.record, record));
  let status = classifyAdmission(record);
  let records = [...state.records];
  if (knownIndex >= 0 && status === "DISCOVERED") {
    const known = state.records[knownIndex];
    status = known.record.sourceFingerprint === record.sourceFingerprint ? "ALREADY_KNOWN" : "UPDATED_SOURCE";
    if (status === "UPDATED_SOURCE") {
      records[knownIndex] = Object.freeze({
        record,
        admissionStatus: status,
        revisions: Object.freeze([...known.revisions, known.record.sourceFingerprint]),
      });
    }
  } else if (knownIndex < 0) {
    records.push(Object.freeze({ record, admissionStatus: status, revisions: Object.freeze([]) }));
  }
  if (!STATE_SET.has(status)) throw new Error("GLOBAL_RESEARCH_DISCOVERY_STATE_INVALID");
  const event = Object.freeze({
    status,
    researchSourceId: record.researchSourceId,
    sourceFingerprint: record.sourceFingerprint,
    observedAt: record.ingestedAt,
  });
  const core = stateCore({
    collectorId: state.collectorId,
    cursor: nextCursor == null ? state.cursor : requiredText(nextCursor, "nextCursor"),
    records: Object.freeze(records),
    events: Object.freeze([...state.events, event]),
    cadencePolicy: state.cadencePolicy,
  });
  return Object.freeze({ status, record, state: withStateDigest(core) });
}

export function buildCollectorRegistryRecordInput(discovery, { paperGenome = {} } = {}) {
  const entry = discovery?.record ? discovery : null;
  if (!entry || !new Set(["DISCOVERED", "UPDATED_SOURCE"]).has(entry.admissionStatus)) {
    throw new Error("COLLECTOR_RECORD_NOT_ADMISSIBLE_TO_REGISTRY");
  }
  const row = entry.record;
  if (!row.market || !row.strategyFamily || !row.strategySummary) throw new Error("COLLECTOR_STRATEGY_METADATA_INCOMPLETE");
  return Object.freeze({
    study: Object.freeze({
      studyId: row.researchSourceId,
      title: row.title,
      authors: row.authors,
      venue: row.venue,
      publishedYear: row.publicationDate ? Number(row.publicationDate.slice(0, 4)) : null,
      doi: row.doi,
      sourceUrl: row.canonicalUrl,
      market: row.market,
      strategyFamily: row.strategyFamily,
      strategySummary: row.strategySummary,
      formulaSummary: row.formulaSummary,
      sample: Object.freeze({
        startDate: row.samplePeriod.startDate,
        endDate: row.samplePeriod.endDate,
        observationCount: row.reportedN,
      }),
      reportedMetrics: row.reportedMetrics ?? {},
    }),
    source: Object.freeze({
      sourceType: row.sourceClass,
      publication: row.venue,
      publicationDate: row.publicationDate,
      canonicalUrl: row.canonicalUrl,
      assetClass: row.assetClass,
      marketsStudied: row.market ? [row.market] : [],
      sampleN: row.reportedN,
      timeframe: row.timeframe,
      strategyConcept: row.strategySummary,
      transactionCostAssumptions: row.costAssumptions,
      datasetReference: row.datasetReference,
      licenseStatus: row.licenseStatus,
      provenanceStatus: row.provenanceStatus,
      sourceProvenance: row.sourceProvenance ?? Object.freeze({ locator: row.canonicalUrl }),
      ingestionTimestamp: row.ingestedAt,
      parserVersion: row.parserVersion,
    }),
    paperGenome,
  });
}

export function admitCollectorRecordToRegistry(registry, discovery, options = {}) {
  if (!verifyGlobalStrategyResearchRegistry(registry)) throw new Error("GLOBAL_STRATEGY_RESEARCH_REGISTRY_INVALID");
  return appendGlobalStrategyResearchRecord(registry, buildCollectorRegistryRecordInput(discovery, options));
}

export function summarizeGlobalResearchCollector(state) {
  if (!verifyGlobalResearchCollector(state)) throw new Error("GLOBAL_RESEARCH_COLLECTOR_STATE_INVALID");
  const counts = Object.fromEntries(GLOBAL_RESEARCH_DISCOVERY_STATES.map((status) => [status, state.events.filter((event) => event.status === status).length]));
  const lastDiscovery = state.events.at(-1)?.observedAt ?? null;
  return Object.freeze({
    collectorId: state.collectorId,
    collectorHealth: "READY_NOT_ACTIVATED",
    lastResearchDiscovery: lastDiscovery ?? "MISSING_EVIDENCE",
    uniqueResearchSources: state.records.length,
    eventCounts: Object.freeze(counts),
    cursor: state.cursor ?? "MISSING_EVIDENCE",
    timerActivated: false,
    stateDigest: state.stateDigest,
  });
}

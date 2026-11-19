import { createHash } from "node:crypto";

export const ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID = "ADAPTIVE_MULTI_EVIDENCE_V2";
export const ADAPTIVE_MULTI_EVIDENCE_POINT_IN_TIME_VERSION =
  "adaptive-multi-evidence-point-in-time-v2";

export const ADAPTIVE_MULTI_EVIDENCE_FAMILIES = Object.freeze([
  "PRICE_STRUCTURE",
  "TREND",
  "MOMENTUM",
  "CANDLE",
  "PATTERN",
  "VOLUME",
  "VOLATILITY",
  "NEWS",
  "DISCLOSURE",
  "DERIVATIVES",
  "FUNDAMENTAL_FACTOR",
  "LITERATURE",
  "YOUTUBE",
  "GLOBAL_RISK",
]);

const FAMILY_SET = new Set(ADAPTIVE_MULTI_EVIDENCE_FAMILIES);
const MARKET_SET = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const SIDE_SET = new Set(["LONG", "SHORT", "BUY", "SELL", "EXIT", "NEUTRAL"]);
const DIGEST_64 = /^[0-9a-f]{64}$/iu;

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timestamp(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null;
}

function httpUrl(value) {
  const normalized = text(value);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function strings(value) {
  if (!Array.isArray(value)) return null;
  const normalized = value.map(text);
  return normalized.every(Boolean) ? Object.freeze([...new Set(normalized)]) : null;
}

function failure(blockers, missingEvidence = []) {
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_POINT_IN_TIME_VERSION,
    status: "BLOCKED_DATA",
    evidence: null,
    evidenceId: null,
    blockers: [...new Set(blockers)].sort(),
    missingEvidence: [...new Set(missingEvidence)].sort(),
    economicSampleCredit: 0,
    executionAuthority: "NONE",
  });
}

function temporalIdentity(raw, decisionTime, blockers, missingEvidence) {
  const temporal = {
    eventTime: timestamp(raw?.eventTime),
    publishedAt: timestamp(raw?.publishedAt),
    availableAt: timestamp(raw?.availableAt),
    observedAt: timestamp(raw?.observedAt),
    decisionTime: timestamp(decisionTime),
  };
  const fieldCodes = {
    eventTime: "EVENT_TIME",
    publishedAt: "PUBLISHED_AT",
    availableAt: "AVAILABLE_AT",
    observedAt: "OBSERVED_AT",
    decisionTime: "DECISION_TIME",
  };
  for (const [field, value] of Object.entries(temporal)) {
    if (!value) {
      blockers.push(`POINT_IN_TIME_${fieldCodes[field]}_REQUIRED`);
      missingEvidence.push(field);
    }
  }
  if (Object.values(temporal).every(Boolean)) {
    const times = Object.fromEntries(Object.entries(temporal).map(([key, value]) => [key, Date.parse(value)]));
    if (times.eventTime > times.publishedAt) blockers.push("POINT_IN_TIME_EVENT_AFTER_PUBLICATION");
    if (times.publishedAt > times.availableAt) blockers.push("POINT_IN_TIME_PUBLICATION_AFTER_AVAILABILITY");
    if (times.availableAt > times.observedAt) blockers.push("POINT_IN_TIME_AVAILABILITY_AFTER_OBSERVATION");
    if (times.availableAt > times.decisionTime) blockers.push("POINT_IN_TIME_EVIDENCE_UNAVAILABLE_AT_DECISION");
    if (times.observedAt > times.decisionTime) blockers.push("POINT_IN_TIME_EVIDENCE_UNOBSERVED_AT_DECISION");
  }
  return Object.freeze(temporal);
}

function safetyBlockers(input) {
  const blockers = [];
  if (input?.synthetic !== false) blockers.push("POINT_IN_TIME_SYNTHETIC_PROVENANCE_FORBIDDEN");
  if (input?.replay !== false) blockers.push("POINT_IN_TIME_REPLAY_CREDIT_FORBIDDEN");
  if (input?.backfill !== false) blockers.push("POINT_IN_TIME_BACKFILL_CREDIT_FORBIDDEN");
  if (input?.manualEconomicCredit !== false) blockers.push("POINT_IN_TIME_MANUAL_ECONOMIC_CREDIT_FORBIDDEN");
  if (input?.liveTrading != null && input.liveTrading !== false) blockers.push("LIVE_TRADING_FORBIDDEN");
  if (input?.realOrderEnabled != null && input.realOrderEnabled !== false) blockers.push("REAL_ORDER_FORBIDDEN");
  if (input?.privateTradingApiAllowed != null && input.privateTradingApiAllowed !== false) {
    blockers.push("PRIVATE_TRADING_API_FORBIDDEN");
  }
  if (input?.executionAuthority != null && input.executionAuthority !== "NONE") {
    blockers.push("EXECUTION_AUTHORITY_FORBIDDEN");
  }
  for (const [field, code] of [
    ["probability", "PROBABILITY"],
    ["expectedValue", "EXPECTED_VALUE"],
    ["confidence", "CONFIDENCE"],
  ]) {
    if (input?.[field] != null) blockers.push(`UNVALIDATED_${code}_FORBIDDEN`);
  }
  return blockers;
}

export function buildAdaptiveMultiEvidencePointInTimeV2(input = {}) {
  const blockers = safetyBlockers(input);
  const missingEvidence = [];
  if (input.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID) {
    blockers.push(input.lineageId ? "V1_OR_FOREIGN_LINEAGE_CONTAMINATION_FORBIDDEN" : "V2_LINEAGE_ID_REQUIRED");
  }

  const family = text(input.family)?.toUpperCase() ?? null;
  const market = text(input.market)?.toUpperCase() ?? null;
  const side = text(input.side)?.toUpperCase() ?? null;
  const sourceId = text(input.sourceId);
  const originalSourceId = text(input.originalSourceId);
  const sourceType = text(input.sourceType)?.toUpperCase() ?? null;
  const rawSourceUrl = text(input.sourceUrl);
  const sourceUrl = httpUrl(input.sourceUrl);
  const documentId = text(input.documentId);
  const symbol = text(input.symbol)?.toUpperCase() ?? null;
  const timeframe = text(input.timeframe);
  const contentDigest = text(input.contentDigest)?.toLowerCase() ?? null;
  const facts = strings(input.facts);
  const inferences = strings(input.inferences);
  const uncertainty = strings(input.uncertainty);
  const temporal = temporalIdentity(input, input.decisionTime, blockers, missingEvidence);

  if (!FAMILY_SET.has(family)) blockers.push("V2_EVIDENCE_FAMILY_UNSUPPORTED");
  if (!MARKET_SET.has(market)) blockers.push("V2_EVIDENCE_MARKET_UNSUPPORTED");
  if (!SIDE_SET.has(side)) blockers.push("V2_EVIDENCE_SIDE_UNSUPPORTED");
  if (!sourceId) blockers.push("V2_EVIDENCE_SOURCE_ID_REQUIRED");
  if (!originalSourceId) blockers.push("V2_EVIDENCE_ORIGINAL_SOURCE_ID_REQUIRED");
  if (!sourceType) blockers.push("V2_EVIDENCE_SOURCE_TYPE_REQUIRED");
  if (rawSourceUrl && !sourceUrl) blockers.push("V2_EVIDENCE_SOURCE_URL_INVALID");
  if (!sourceUrl && !documentId) blockers.push("V2_EVIDENCE_SOURCE_REFERENCE_REQUIRED");
  if (!symbol) blockers.push("V2_EVIDENCE_SYMBOL_REQUIRED");
  if (!timeframe) blockers.push("V2_EVIDENCE_TIMEFRAME_REQUIRED");
  if (!DIGEST_64.test(contentDigest ?? "")) blockers.push("V2_EVIDENCE_CONTENT_DIGEST_REQUIRED");
  if (!facts) blockers.push("V2_EVIDENCE_FACTS_INVALID");
  if (!inferences) blockers.push("V2_EVIDENCE_INFERENCES_INVALID");
  if (!uncertainty) blockers.push("V2_EVIDENCE_UNCERTAINTY_INVALID");
  if ((facts?.length ?? 0) === 0) {
    blockers.push("V2_EVIDENCE_FACTS_REQUIRED");
    missingEvidence.push("facts");
  }

  if (blockers.length > 0) return failure(blockers, missingEvidence);

  const identity = deepFreeze({
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    family,
    market,
    symbol,
    timeframe,
    side,
    sourceIdentity: {
      sourceId,
      originalSourceId,
      sourceType,
      sourceUrl,
      documentId,
    },
    temporal,
    contentDigest,
  });
  const identityDigest = digest(identity);
  const evidence = deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_POINT_IN_TIME_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    identity,
    identityDigest,
    facts,
    inferences,
    uncertainty,
    availabilityStatus: "AVAILABLE_AND_OBSERVED_AT_DECISION",
    independenceStatus: "NOT_YET_PROVEN",
    decisionAuthority: "EVIDENCE_ONLY",
    economicSampleCredit: 0,
    v1EconomicIdentityMutable: false,
    synthetic: false,
    replay: false,
    backfill: false,
    liveTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_POINT_IN_TIME_VERSION,
    status: "ADMISSIBLE",
    evidence,
    evidenceId: `adaptive-v2-evidence:${identityDigest}`,
    blockers: [],
    missingEvidence,
    economicSampleCredit: 0,
    executionAuthority: "NONE",
  });
}

export function buildAdaptiveMultiEvidenceDecisionSnapshotV2({ decisionTime, evidence = [] } = {}) {
  const at = timestamp(decisionTime);
  const blockers = [];
  if (!at) blockers.push("V2_DECISION_TIME_REQUIRED");
  if (!Array.isArray(evidence)) blockers.push("V2_DECISION_EVIDENCE_ARRAY_REQUIRED");
  const accepted = Array.isArray(evidence) ? evidence : [];
  const ids = new Set();
  for (const item of accepted) {
    if (item?.status !== "ADMISSIBLE" || item?.evidence?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID) {
      blockers.push("V2_DECISION_EVIDENCE_NOT_ADMISSIBLE");
      continue;
    }
    if (item.evidence.identity.temporal.decisionTime !== at) blockers.push("V2_DECISION_TIME_IDENTITY_MISMATCH");
    if (ids.has(item.evidenceId)) blockers.push("V2_DECISION_DUPLICATE_EVIDENCE_ID");
    ids.add(item.evidenceId);
  }
  if (blockers.length > 0) return failure(blockers);

  const items = Object.freeze(accepted.map((item) => item.evidence));
  const snapshotCore = deepFreeze({
    schemaVersion: "adaptive-multi-evidence-decision-snapshot-v2",
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    decisionTime: at,
    evidenceIds: Object.freeze(accepted.map((item) => item.evidenceId)),
    evidence: items,
    evidenceCount: items.length,
    independenceStatus: "NOT_YET_PROVEN",
    metaDecisionAuthority: "NONE",
    economicSampleCredit: 0,
    v1EconomicIdentityMutable: false,
    executionAuthority: "NONE",
  });
  return deepFreeze({
    status: "READY_FOR_SPECIALIST_RESEARCH_ONLY",
    snapshot: { ...snapshotCore, snapshotDigest: digest(snapshotCore) },
    blockers: [],
    economicSampleCredit: 0,
    executionAuthority: "NONE",
  });
}

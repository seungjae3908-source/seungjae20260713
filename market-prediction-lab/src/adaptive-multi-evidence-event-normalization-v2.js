import { sha256Canonical } from "./research-cache-provenance.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
  buildAdaptiveMultiEvidencePointInTimeV2,
} from "./adaptive-multi-evidence-point-in-time-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_EVENT_NORMALIZATION_V2_VERSION =
  "adaptive-multi-evidence-event-normalization-v2";

const ADMISSIBLE_ROUTE_STATUS = new Set(["READY", "PARTIAL_EVIDENCE", "CONFLICTING_EVIDENCE"]);
const DISCLOSURE_SOURCE_TYPES = new Set(["DISCLOSURE", "FILING"]);
const RELIABILITY_BY_TIER = Object.freeze({
  TIER_1_OFFICIAL: "OFFICIAL",
  TIER_2_ISSUER: "ISSUER_PRIMARY",
  TIER_3_VERIFIED_NEWS: "VERIFIED_NEWS",
  TIER_4_OTHER_VERIFIED: "OTHER_VERIFIED",
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function timestamp(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function safety() {
  return {
    frozenV1Contamination: 0,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function failure(blockers, missingEvidence = []) {
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_EVENT_NORMALIZATION_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "BLOCKED_DATA",
    events: [],
    rejectedEvents: [],
    exactDuplicateCount: 0,
    newsCoverage: "UNKNOWN",
    disclosureCoverage: "UNKNOWN",
    absenceMeansNoRisk: false,
    blockers: unique(blockers),
    missingEvidence: unique(missingEvidence),
    independentVoteCredit: 0,
    economicSampleCredit: 0,
    decisionAuthority: "NONE",
    ...safety(),
  });
}

function importance(score) {
  const value = finite(score);
  if (value == null) return "UNKNOWN";
  if (value >= 80) return "CRITICAL";
  if (value >= 60) return "HIGH";
  if (value >= 30) return "MEDIUM";
  return "LOW";
}

function novelty(score) {
  const value = finite(score);
  if (value == null) return "UNKNOWN";
  if (value >= 70) return "HIGH";
  if (value >= 30) return "MEDIUM";
  return "LOW";
}

function normalizeSurprise(raw, decisionTime) {
  const actual = finite(raw?.actual);
  const expected = finite(raw?.expected);
  if (expected == null) {
    return {
      status: "UNAVAILABLE",
      actual,
      expected: null,
      delta: null,
      deltaPct: null,
      unit: text(raw?.unit),
      expectedSourceId: null,
      expectedAvailableAt: null,
      reason: "EXPECTED_EVIDENCE_UNAVAILABLE",
    };
  }
  const unit = text(raw?.unit);
  const expectedSourceId = text(raw?.expectedSourceId);
  const expectedAvailableAt = timestamp(raw?.expectedAvailableAt);
  if (actual == null || !unit || !expectedSourceId || !expectedAvailableAt
      || Date.parse(expectedAvailableAt) > Date.parse(decisionTime)) {
    return {
      status: "INVALID",
      actual,
      expected,
      delta: null,
      deltaPct: null,
      unit,
      expectedSourceId,
      expectedAvailableAt,
      reason: "SURPRISE_EVIDENCE_NOT_POINT_IN_TIME_ADMISSIBLE",
    };
  }
  const delta = actual - expected;
  return {
    status: "AVAILABLE",
    actual,
    expected,
    delta,
    deltaPct: expected === 0 ? null : delta / Math.abs(expected),
    unit,
    expectedSourceId,
    expectedAvailableAt,
    reason: null,
  };
}

function reject(rawHash, reason) {
  return { rawHash: text(rawHash), reason };
}

function normalizeRoute(route, input, surpriseInput) {
  if (route?.contract !== "MarketIntelAiRouteV1") {
    return { rejected: reject(route?.event?.rawHash, "NEWS_DISCLOSURE_OWNER_CONTRACT_REQUIRED") };
  }
  if (route?.safety?.executionAuthority !== "NONE" || route?.safety?.orderAllowed !== false
      || route?.safety?.sentimentIsPriceDirection !== false
      || route?.safety?.fabricatedEvidenceAllowed !== false) {
    return { rejected: reject(route?.event?.rawHash, "NEWS_DISCLOSURE_OWNER_SAFETY_CONTRACT_INVALID") };
  }
  if (!ADMISSIBLE_ROUTE_STATUS.has(route.status)) {
    return { rejected: reject(route?.event?.rawHash, `NEWS_DISCLOSURE_ROUTE_${route?.status ?? "UNKNOWN"}`) };
  }
  const event = route.event;
  const sourceId = text(event?.sourceId);
  const rawHash = text(event?.rawHash);
  const publishedAt = timestamp(event?.publishedAt);
  const availableAt = timestamp(event?.receivedAt);
  if (!sourceId || !rawHash || !publishedAt || !availableAt) {
    return { rejected: reject(rawHash, "NEWS_DISCLOSURE_TEMPORAL_OR_SOURCE_IDENTITY_MISSING") };
  }
  if (event.market !== input.market || event.symbol !== input.symbol) {
    return { rejected: reject(rawHash, "NEWS_DISCLOSURE_ASSET_IDENTITY_MISMATCH") };
  }
  const sourceType = text(event.sourceType)?.toUpperCase();
  const family = DISCLOSURE_SOURCE_TYPES.has(sourceType) ? "DISCLOSURE" : "NEWS";
  const reliability = RELIABILITY_BY_TIER[event.sourceTier] ?? "UNKNOWN";
  const surprise = normalizeSurprise(surpriseInput, input.decisionTime);
  if (surprise.status === "INVALID") {
    return { rejected: reject(rawHash, surprise.reason) };
  }
  const facts = unique([
    `eventType=${event.eventType}`,
    `affectedAsset=${event.market}:${event.symbol}`,
    `sourceId=${sourceId}`,
    `sourceType=${sourceType}`,
    `sourceTier=${event.sourceTier}`,
    event.sourceName ? `sourceName=${event.sourceName}` : null,
    event.sourceUrl ? `sourceUrl=${event.sourceUrl}` : null,
    `publishedAt=${publishedAt}`,
    `availableAt=${availableAt}`,
    `freshness=${route.freshness?.state ?? "UNKNOWN"}`,
    `reliability=${reliability}`,
    `relevance=DIRECT_ASSET_MATCH`,
    `importance=${importance(event.importanceScore)}`,
    `novelty=${novelty(event.noveltyScore)}`,
    `conflictDetected=${route.conflict?.conflictDetected === true}`,
    ...((event.evidence?.facts ?? []).map((item) => `ownerFact=${item}`)),
    surprise.status === "AVAILABLE" ? `actual=${surprise.actual}${surprise.unit}` : null,
    surprise.status === "AVAILABLE" ? `expected=${surprise.expected}${surprise.unit}` : null,
    surprise.status === "AVAILABLE" ? `expectedSourceId=${surprise.expectedSourceId}` : null,
  ]);
  const inferences = unique([
    `eventNormalization=${event.eventType}`,
    `surprise=${surprise.status}`,
    ...((event.evidence?.inferences ?? []).map((item) => `ownerInference=${item}`)),
  ]);
  const uncertainty = unique([
    "News sentiment is not price direction.",
    "Observed market reaction is unavailable unless separate point-in-time market evidence is supplied.",
    surprise.status === "UNAVAILABLE" ? "Expected evidence is unavailable; surprise is not inferred." : null,
    ...((event.evidence?.uncertainty ?? []).map((item) => `ownerUncertainty=${item}`)),
  ]);
  const contentDigest = sha256Canonical({
    ownerRawHash: rawHash,
    ownerAnalysisKey: route.ai?.analysisKey ?? null,
    publishedAt,
    availableAt,
    facts,
    inferences,
    uncertainty,
    surprise,
  });
  const evidence = buildAdaptiveMultiEvidencePointInTimeV2({
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    family,
    market: event.market,
    symbol: event.symbol,
    timeframe: input.timeframe,
    side: "NEUTRAL",
    sourceId,
    originalSourceId: sourceId,
    sourceType,
    sourceUrl: event.sourceUrl,
    documentId: DISCLOSURE_SOURCE_TYPES.has(sourceType) ? sourceId : null,
    eventTime: publishedAt,
    publishedAt,
    availableAt,
    observedAt: input.observedAt,
    decisionTime: input.decisionTime,
    contentDigest,
    facts,
    inferences,
    uncertainty,
    synthetic: false,
    replay: false,
    backfill: false,
    manualEconomicCredit: false,
    liveTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
  if (evidence.status !== "ADMISSIBLE") {
    return { rejected: reject(rawHash, evidence.blockers[0] ?? "NEWS_DISCLOSURE_POINT_IN_TIME_REJECTED") };
  }
  return {
    normalized: {
      rawHash,
      family,
      eventType: event.eventType,
      affectedAsset: { market: event.market, symbol: event.symbol, companyName: event.companyName },
      source: {
        sourceId,
        sourceType,
        sourceTier: event.sourceTier,
        sourceName: event.sourceName,
        sourceUrl: event.sourceUrl,
      },
      publishedAt,
      availableAt,
      freshness: route.freshness?.state ?? "UNKNOWN",
      reliability,
      relevance: "DIRECT_ASSET_MATCH",
      importance: importance(event.importanceScore),
      novelty: novelty(event.noveltyScore),
      conflictingEvidence: route.conflict?.conflictDetected === true,
      ownerDirectionLabel: event.direction,
      directionalImplication: "NOT_INFERRED",
      observedMarketReaction: "UNAVAILABLE",
      surprise,
      evidence,
      executionAuthority: "NONE",
    },
  };
}

export function buildAdaptiveMultiEvidenceEventNormalizationV2(input = {}) {
  const blockers = [];
  const missingEvidence = [];
  const decisionTime = timestamp(input.decisionTime);
  const observedAt = timestamp(input.observedAt);
  const market = text(input.market)?.toUpperCase() ?? null;
  const symbol = text(input.symbol)?.toUpperCase() ?? null;
  const timeframe = text(input.timeframe) ?? "event";
  if (!decisionTime) missingEvidence.push("decisionTime");
  if (!observedAt) missingEvidence.push("observedAt");
  if (!market) missingEvidence.push("market");
  if (!symbol) missingEvidence.push("symbol");
  if (!Array.isArray(input.routes)) blockers.push("NEWS_DISCLOSURE_ROUTE_ARRAY_REQUIRED");
  if (input.executionAuthority != null && input.executionAuthority !== "NONE") {
    blockers.push("NEWS_DISCLOSURE_EXECUTION_AUTHORITY_FORBIDDEN");
  }
  if (decisionTime && observedAt && Date.parse(observedAt) > Date.parse(decisionTime)) {
    blockers.push("NEWS_DISCLOSURE_OBSERVED_AFTER_DECISION");
  }
  if (blockers.length > 0 || missingEvidence.length > 0) return failure(blockers, missingEvidence);

  const context = { decisionTime, observedAt, market, symbol, timeframe };
  const seen = new Set();
  const events = [];
  const rejectedEvents = [];
  let exactDuplicateCount = 0;
  for (const route of input.routes) {
    const rawHash = text(route?.event?.rawHash);
    if (rawHash && seen.has(rawHash)) {
      exactDuplicateCount += 1;
      continue;
    }
    if (rawHash) seen.add(rawHash);
    const result = normalizeRoute(route, context, input.surpriseEvidenceByRawHash?.[rawHash]);
    if (result.normalized) events.push(result.normalized);
    else rejectedEvents.push(result.rejected);
  }
  events.sort((left, right) => left.availableAt.localeCompare(right.availableAt)
    || left.rawHash.localeCompare(right.rawHash));
  const newsCount = events.filter((item) => item.family === "NEWS").length;
  const disclosureCount = events.filter((item) => item.family === "DISCLOSURE").length;
  const status = events.length === 0 ? "NO_ADMISSIBLE_EVENT_EVIDENCE"
    : rejectedEvents.length > 0 ? "PARTIAL_EVENT_EVIDENCE" : "READY_FOR_DEDUP_RESEARCH_ONLY";

  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_EVENT_NORMALIZATION_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status,
    decisionTime,
    observedAt,
    market,
    symbol,
    timeframe,
    events,
    rejectedEvents,
    exactDuplicateCount,
    newsCoverage: newsCount > 0 ? "EVIDENCE_PRESENT" : "NO_ADMISSIBLE_EVIDENCE",
    disclosureCoverage: disclosureCount > 0 ? "EVIDENCE_PRESENT" : "NO_ADMISSIBLE_EVIDENCE",
    officialDisclosureCount: events.filter((item) => item.family === "DISCLOSURE"
      && item.reliability === "OFFICIAL").length,
    absenceMeansNoRisk: false,
    sentimentIsPriceDirection: false,
    observedMarketReactionFabricated: false,
    independenceStatus: "NOT_YET_PROVEN",
    independentVoteCredit: 0,
    economicSampleCredit: 0,
    blockers: [],
    missingEvidence: [],
    decisionAuthority: "EVIDENCE_ONLY",
    ...safety(),
  });
}

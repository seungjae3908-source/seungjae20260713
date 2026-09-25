import assert from "node:assert/strict";
import test from "node:test";
import { routeMarketIntelAi } from "../../market-intelligence-sidecar/src/news-disclosure-intelligence.mjs";
import {
  ADAPTIVE_MULTI_EVIDENCE_EVENT_NORMALIZATION_V2_VERSION,
  buildAdaptiveMultiEvidenceEventNormalizationV2,
} from "../src/adaptive-multi-evidence-event-normalization-v2.js";

const PUBLISHED_AT = "2026-09-14T01:00:00.000Z";
const AVAILABLE_AT = "2026-09-14T01:01:00.000Z";
const OBSERVED_AT = "2026-09-14T01:02:00.000Z";
const DECISION_TIME = "2026-09-14T01:03:00.000Z";

function ownerRoute(overrides = {}) {
  return routeMarketIntelAi({
    nowMs: Date.parse(OBSERVED_AT),
    freshnessPolicyMs: {
      futureToleranceMs: 0,
      freshMs: 6 * 60 * 60_000,
      agingMs: 24 * 60 * 60_000,
      staleMs: 72 * 60 * 60_000,
    },
    event: {
      sourceId: "DART:202609140001",
      sourceType: "DISCLOSURE",
      sourceTier: "TIER_1_OFFICIAL",
      sourceUrl: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=202609140001",
      sourceName: "DART",
      market: "KR_STOCK",
      symbol: "005930",
      companyName: "삼성전자",
      publishedAt: PUBLISHED_AT,
      receivedAt: AVAILABLE_AT,
      headline: "영업실적 공시",
      originalText: "공식 공시에서 확인된 매출 사실",
      eventType: "EARNINGS",
      direction: "UNKNOWN",
      importanceScore: 85,
      noveltyScore: 75,
      evidence: { facts: ["공식 원문 링크 확인"], inferences: [], uncertainty: [] },
      ...overrides,
    },
  });
}

function normalize(routes, overrides = {}) {
  return buildAdaptiveMultiEvidenceEventNormalizationV2({
    market: "KR_STOCK",
    symbol: "005930",
    timeframe: "event",
    observedAt: OBSERVED_AT,
    decisionTime: DECISION_TIME,
    routes,
    executionAuthority: "NONE",
    ...overrides,
  });
}

test("official disclosure owner output becomes grounded point-in-time V2 event evidence", () => {
  const result = normalize([ownerRoute()]);
  assert.equal(result.schemaVersion, ADAPTIVE_MULTI_EVIDENCE_EVENT_NORMALIZATION_V2_VERSION);
  assert.equal(result.status, "READY_FOR_DEDUP_RESEARCH_ONLY");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].family, "DISCLOSURE");
  assert.equal(result.events[0].reliability, "OFFICIAL");
  assert.equal(result.events[0].publishedAt, PUBLISHED_AT);
  assert.equal(result.events[0].availableAt, AVAILABLE_AT);
  assert.equal(result.events[0].evidence.status, "ADMISSIBLE");
  assert.equal(result.events[0].evidence.evidence.identity.temporal.decisionTime, DECISION_TIME);
  assert.equal(result.officialDisclosureCount, 1);
});

test("news sentiment remains an owner label and never becomes price direction", () => {
  const result = normalize([ownerRoute({
    sourceId: "NEWS:1",
    sourceType: "NEWS",
    sourceTier: "TIER_3_VERIFIED_NEWS",
    sourceName: "Verified News",
    sourceUrl: "https://example.com/news/1",
    direction: "NEGATIVE",
  })]);
  assert.equal(result.events[0].family, "NEWS");
  assert.equal(result.events[0].ownerDirectionLabel, "NEGATIVE");
  assert.equal(result.events[0].directionalImplication, "NOT_INFERRED");
  assert.equal(result.sentimentIsPriceDirection, false);
});

test("surprise is unavailable without expected evidence and computed only with point-in-time source proof", () => {
  const route = ownerRoute();
  const unavailable = normalize([route]);
  assert.equal(unavailable.events[0].surprise.status, "UNAVAILABLE");
  assert.equal(unavailable.events[0].surprise.delta, null);

  const available = normalize([route], {
    surpriseEvidenceByRawHash: {
      [route.event.rawHash]: {
        actual: 120,
        expected: 100,
        unit: "KRW_BILLION",
        expectedSourceId: "CONSENSUS:20260913",
        expectedAvailableAt: "2026-09-13T23:00:00.000Z",
      },
    },
  });
  assert.equal(available.events[0].surprise.status, "AVAILABLE");
  assert.equal(available.events[0].surprise.delta, 20);
  assert.equal(available.events[0].surprise.deltaPct, 0.2);
});

test("future, incomplete, and unverified owner events remain rejected rather than zero evidence", () => {
  const future = ownerRoute({
    publishedAt: "2026-09-14T02:00:00.000Z",
    receivedAt: "2026-09-14T02:01:00.000Z",
  });
  const unverified = ownerRoute({
    sourceId: "UNKNOWN:1",
    sourceType: "NEWS",
    sourceTier: "TIER_5_UNVERIFIED",
    sourceUrl: "https://example.invalid/rumor",
  });
  const result = normalize([future, unverified]);
  assert.equal(result.status, "NO_ADMISSIBLE_EVENT_EVIDENCE");
  assert.equal(result.events.length, 0);
  assert.equal(result.rejectedEvents.length, 2);
  assert.equal(result.disclosureCoverage, "NO_ADMISSIBLE_EVIDENCE");
  assert.equal(result.absenceMeansNoRisk, false);
});

test("exact owner duplicates are collapsed without granting independence credit", () => {
  const route = ownerRoute();
  const result = normalize([route, route]);
  assert.equal(result.events.length, 1);
  assert.equal(result.exactDuplicateCount, 1);
  assert.equal(result.independenceStatus, "NOT_YET_PROVEN");
  assert.equal(result.independentVoteCredit, 0);
  assert.equal(result.economicSampleCredit, 0);
});

test("safety contracts and execution authority fail closed", () => {
  const route = ownerRoute();
  const unsafeOwner = { ...route, safety: { ...route.safety, orderAllowed: true } };
  const rejected = normalize([unsafeOwner]);
  assert.equal(rejected.events.length, 0);
  assert.equal(rejected.rejectedEvents[0].reason, "NEWS_DISCLOSURE_OWNER_SAFETY_CONTRACT_INVALID");

  const blocked = normalize([route], { executionAuthority: "PAPER" });
  assert.equal(blocked.status, "BLOCKED_DATA");
  assert.ok(blocked.blockers.includes("NEWS_DISCLOSURE_EXECUTION_AUTHORITY_FORBIDDEN"));
  assert.equal(blocked.liveTrading, false);
  assert.equal(blocked.autoTrading, false);
  assert.equal(blocked.realOrderEnabled, false);
  assert.equal(blocked.privateTradingApiAllowed, false);
  assert.equal(blocked.executionAuthority, "NONE");
});

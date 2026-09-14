import assert from "node:assert/strict";
import test from "node:test";
import { createGlobalEvidenceLedger } from "../src/global-evidence-dedup-ledger-v1.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
  buildAdaptiveMultiEvidencePointInTimeV2,
} from "../src/adaptive-multi-evidence-point-in-time-v2.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_INDEPENDENCE_V2_VERSION,
  buildAdaptiveMultiEvidenceIndependenceV2,
} from "../src/adaptive-multi-evidence-independence-v2.js";

const DECISION_TIME = "2026-09-14T05:00:00.000Z";

function evidence({ family = "NEWS", sourceId, originalSourceId = sourceId, sourceUrl, documentId, digest } = {}) {
  return buildAdaptiveMultiEvidencePointInTimeV2({
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    family,
    market: "US_STOCK",
    symbol: "AAPL",
    timeframe: "event",
    side: "NEUTRAL",
    sourceId,
    originalSourceId,
    sourceType: family,
    sourceUrl,
    documentId,
    eventTime: "2026-09-14T04:00:00.000Z",
    publishedAt: "2026-09-14T04:01:00.000Z",
    availableAt: "2026-09-14T04:02:00.000Z",
    observedAt: "2026-09-14T04:03:00.000Z",
    decisionTime: DECISION_TIME,
    contentDigest: digest,
    facts: [`source=${sourceId}`],
    inferences: [],
    uncertainty: ["independence not yet proven"],
    synthetic: false,
    replay: false,
    backfill: false,
    manualEconomicCredit: false,
    executionAuthority: "NONE",
  });
}

const digest = (character) => character.repeat(64);

test("exact duplicates count once and never receive another vote or economic sample", () => {
  const item = evidence({ sourceId: "news-1", sourceUrl: "https://example.com/story", digest: digest("a") });
  const result = buildAdaptiveMultiEvidenceIndependenceV2({
    decisionTime: DECISION_TIME,
    entries: [{ evidence: item }, { evidence: item }],
    economicEvidenceLedger: createGlobalEvidenceLedger(),
  });
  assert.equal(result.schemaVersion, ADAPTIVE_MULTI_EVIDENCE_INDEPENDENCE_V2_VERSION);
  assert.equal(result.canonicalEvidenceCount, 1);
  assert.equal(result.exactDuplicateCount, 1);
  assert.equal(result.independentVoteCredit, 0);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.economicLedgerOwnerStatus, "VALIDATED_SEPARATE_ECONOMIC_OUTCOME_LEDGER");
});

test("tracking parameters do not turn one URL into independent reporting", () => {
  const left = evidence({ sourceId: "syndication-1", sourceUrl: "https://example.com/story?utm_source=a", digest: digest("b") });
  const right = evidence({ sourceId: "syndication-2", sourceUrl: "https://example.com/story?utm_source=b", digest: digest("c") });
  const result = buildAdaptiveMultiEvidenceIndependenceV2({
    decisionTime: DECISION_TIME,
    entries: [{ evidence: left }, { evidence: right }],
  });
  assert.equal(result.canonicalEvidenceCount, 2);
  assert.equal(result.independenceGroupCount, 1);
  assert.equal(result.groups[0].status, "DEPENDENT_OR_DUPLICATED_SOURCES");
  assert.equal(result.groups[0].canonicalSourceContribution, 1);
});

test("news and video restating the same upstream claim share an independence group", () => {
  const news = evidence({ sourceId: "news-2", sourceUrl: "https://news.example/item", digest: digest("d") });
  const video = evidence({ family: "YOUTUBE", sourceId: "video-1", sourceUrl: "https://youtube.com/watch?v=1", digest: digest("e") });
  const result = buildAdaptiveMultiEvidenceIndependenceV2({
    decisionTime: DECISION_TIME,
    entries: [
      { evidence: news, relationship: { upstreamSourceId: "original-report-1" } },
      { evidence: video, relationship: { upstreamSourceId: "original-report-1" } },
    ],
  });
  assert.equal(result.independenceGroupCount, 1);
  assert.deepEqual(result.groups[0].families, ["NEWS", "YOUTUBE"]);
});

test("related papers using the same data lineage are not counted as independent", () => {
  const paper1 = evidence({ family: "LITERATURE", sourceId: "paper-1", documentId: "doi:1", digest: digest("f") });
  const paper2 = evidence({ family: "LITERATURE", sourceId: "paper-2", documentId: "doi:2", digest: digest("1") });
  const result = buildAdaptiveMultiEvidenceIndependenceV2({
    decisionTime: DECISION_TIME,
    entries: [
      { evidence: paper1, relationship: { dataLineageId: "dataset-a" } },
      { evidence: paper2, relationship: { dataLineageId: "dataset-a" } },
    ],
  });
  assert.equal(result.independenceGroupCount, 1);
  assert.equal(result.groups[0].status, "DEPENDENT_OR_DUPLICATED_SOURCES");
});

test("a singleton group remains unproven rather than becoming one independent vote", () => {
  const item = evidence({ sourceId: "news-3", sourceUrl: "https://independent.example/story", digest: digest("2") });
  const result = buildAdaptiveMultiEvidenceIndependenceV2({
    decisionTime: DECISION_TIME,
    entries: [{ evidence: item }],
  });
  assert.equal(result.groups[0].status, "INDEPENDENCE_NOT_PROVEN");
  assert.equal(result.groupCountIsNotVoteCount, true);
  assert.equal(result.groups[0].independentVoteCredit, 0);
});

test("foreign lineage and execution authority fail closed", () => {
  const item = evidence({ sourceId: "news-4", sourceUrl: "https://example.com/4", digest: digest("3") });
  const foreign = { ...item, evidence: { ...item.evidence, lineageId: "FROZEN_CHALLENGER_V1" } };
  const result = buildAdaptiveMultiEvidenceIndependenceV2({
    decisionTime: DECISION_TIME,
    entries: [{ evidence: foreign }],
    executionAuthority: "PAPER",
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("V2_INDEPENDENCE_EVIDENCE_0_INVALID"));
  assert.ok(result.blockers.includes("V2_INDEPENDENCE_EXECUTION_AUTHORITY_FORBIDDEN"));
  assert.equal(result.liveTrading, false);
  assert.equal(result.autoTrading, false);
  assert.equal(result.realOrderEnabled, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
});

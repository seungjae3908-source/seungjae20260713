import test from "node:test";
import assert from "node:assert/strict";

import { adaptCrossrefMetadata } from "../../packages/external-research/src/index.js";
import {
  createResearchVideoSourceV1,
  createVideoStrategyHypothesisV1,
} from "../../packages/external-research/src/video-intelligence.js";
import {
  adaptAuthorizedPublicDocumentToWorldKnowledgeReceiptV1,
  adaptResearchPaperV2ToWorldKnowledgeReceiptV1,
  adaptVideoHypothesisToWorldKnowledgeReceiptV1,
  buildWorldKnowledgeFromExistingResearchV1,
} from "../src/world-knowledge-existing-adapters-v1.js";

const retrievedAt = "2026-09-20T03:00:00.000Z";

function paper() {
  return adaptCrossrefMetadata({
    status: "ok",
    "message-type": "work",
    "message-version": "1.0.0",
    message: {
      DOI: "10.1234/alpha.001",
      title: ["Alpha Research"],
      author: [{ given: "Ada", family: "Researcher" }],
      "published-online": { "date-parts": [[2025, 2, 3]] },
      indexed: { "date-time": "2026-09-19T00:00:00Z", version: "1" },
    },
  }, {
    retrievedAt,
    retrievedFrom: "https://api.crossref.org/works/10.1234/alpha.001",
  });
}

function paperClaims() {
  return [{
    claimId: "claim-paper-alpha",
    derivedSummary: "A candidate market effect should be tested out of sample after costs.",
    mechanism: "The proposed feature may proxy persistent information flow.",
    markets: ["US_STOCK"],
    horizons: ["1d"],
    features: ["information_flow"],
    falsifiers: ["no OOS edge", "full cost removes effect"],
    independenceGroupId: "academic-alpha",
    evidenceDigest: "a".repeat(64),
    locator: "authorized-derived-note",
  }];
}

function videoObjects() {
  const source = createResearchVideoSourceV1({
    provider: "YOUTUBE",
    sourceType: "YOUTUBE_VIDEO",
    canonicalUrl: "https://www.youtube.com/watch?v=abc123",
    videoId: "abc123",
    title: "VWAP continuation example",
    channelOrPublisher: "Example Channel",
    publishedAt: "2026-01-10T00:00:00Z",
    discoveredAt: retrievedAt,
    language: "en",
    durationSec: 600,
    transcriptStatus: "AVAILABLE",
    transcriptSource: "AUTHORIZED_CAPTION",
    transcriptAuthorized: true,
    contentAccessStatus: "AVAILABLE",
    timestampProvenance: [{ startSec: 60, endSec: 90, label: "setup" }],
  });
  const hypothesis = createVideoStrategyHypothesisV1({
    source,
    sourceStartSec: 60,
    sourceEndSec: 90,
    sourceQuoteHash: "b".repeat(64),
    market: "CRYPTO_FUTURES",
    symbolScope: ["BTCUSDT"],
    side: "LONG",
    timeframe: "15m",
    strategyFamily: "VWAP_CONTINUATION",
    categories: ["PRICE_ACTION", "VOLUME"],
    entryRules: ["price reclaims VWAP", "relative volume confirms"],
    exitRules: ["strategy invalidation or trailing exit"],
    stopLossRules: ["below invalidation"],
    takeProfitRules: ["adaptive exit"],
    positionSizingRules: ["risk first"],
    indicatorRules: ["VWAP", "RVOL"],
    regimeConstraints: ["trend"],
    invalidations: ["failed reclaim"],
    authorClaims: ["continuation hypothesis"],
    extractedFacts: ["VWAP reclaim described"],
    extractedInferences: ["requires independent validation"],
    uncertainties: ["selection bias unknown"],
  });
  return { source, hypothesis };
}

test("existing ResearchPaperV2 adapts into rights-aware world knowledge without copying full text", () => {
  const receipt = adaptResearchPaperV2ToWorldKnowledgeReceiptV1({
    paper: paper(),
    sourceType: "ACADEMIC_PAPER",
    claims: paperClaims(),
    contentAccessEvidence: {
      accessMode: "PUBLIC_METADATA",
      derivedFactsAllowed: true,
      derivedSummaryAllowed: true,
      fullTextStorageAllowed: false,
      redistributionAllowed: false,
      attributionRequired: true,
      licenseOrTermsUrl: "https://www.crossref.org/documentation/retrieve-metadata/",
    },
  });

  assert.equal(receipt.status, "WORLD_KNOWLEDGE_RECEIPT_READY");
  assert.equal(receipt.source.sourceId, "doi:10.1234/alpha.001");
  assert.equal(receipt.source.rawContentPersisted, false);
  assert.equal(receipt.rawContentPersistenceAuthority, false);
  assert.equal(receipt.executionAuthority, "NONE");
});

test("paper adapter preserves partial-date semantics by not inventing a full publication timestamp", () => {
  const partial = adaptCrossrefMetadata({
    status: "ok",
    "message-type": "work",
    "message-version": "1.0.0",
    message: {
      DOI: "10.1234/alpha.partial",
      title: ["Partial Date Alpha Research"],
      author: [{ given: "Ada", family: "Researcher" }],
      "published-online": { "date-parts": [[2025, 2]] },
      indexed: { "date-time": "2026-09-19T00:00:00Z", version: "1" },
    },
  }, {
    retrievedAt,
    retrievedFrom: "https://api.crossref.org/works/10.1234/alpha.partial",
  });
  const receipt = adaptResearchPaperV2ToWorldKnowledgeReceiptV1({
    paper: partial,
    sourceType: "ACADEMIC_PAPER",
    claims: paperClaims().map((claim) => ({ ...claim, claimId: "claim-paper-alpha-partial" })),
    contentAccessEvidence: {
      accessMode: "PUBLIC_METADATA",
      derivedFactsAllowed: true,
      derivedSummaryAllowed: true,
      fullTextStorageAllowed: false,
      redistributionAllowed: false,
      attributionRequired: true,
      licenseOrTermsUrl: "https://example.org/terms",
    },
  });
  assert.equal(receipt.status, "WORLD_KNOWLEDGE_RECEIPT_READY");
  assert.equal(receipt.source.publishedAt, null);
});

test("authorized existing video hypothesis becomes a derived claim without transcript persistence", () => {
  const { source, hypothesis } = videoObjects();
  const receipt = adaptVideoHypothesisToWorldKnowledgeReceiptV1({
    source,
    hypothesis,
    derivedSummary: "VWAP reclaim with participation is a candidate continuation confirmation.",
    mechanism: "Renewed aggressive participation after reclaim may distinguish continuation from weak bounce.",
    features: ["vwap_distance", "relative_volume"],
    falsifiers: ["no OOS incremental edge", "slippage removes incremental edge"],
    independenceGroupId: "video-vwap-example",
    termsUrl: "https://www.youtube.com/static?template=terms",
  });

  assert.equal(receipt.status, "WORLD_KNOWLEDGE_RECEIPT_READY");
  assert.equal(receipt.source.sourceType, "VIDEO");
  assert.equal(receipt.source.rawContentPersisted, false);
  assert.equal(receipt.claims[0].rawSourceTextPersisted, undefined);
  assert.equal(receipt.executionAuthority, "NONE");
});

test("video adapter refuses unavailable or unauthorized transcript evidence", () => {
  const { source, hypothesis } = videoObjects();
  const unauthorized = { ...source, transcriptAuthorized: false, transcriptStatus: "NOT_AUTHORIZED" };
  assert.throws(() => adaptVideoHypothesisToWorldKnowledgeReceiptV1({
    source: unauthorized,
    hypothesis,
    derivedSummary: "summary",
    mechanism: "mechanism",
    features: ["vwap"],
    falsifiers: ["fails"],
  }), /RESEARCH_VIDEO_SOURCE_V1_SHAPE_INVALID|WORLD_VIDEO_AUTHORIZED_TRANSCRIPT_REQUIRED/);
});

test("broker and public-book records require explicit rights and provenance", () => {
  const receipt = adaptAuthorizedPublicDocumentToWorldKnowledgeReceiptV1({
    sourceType: "BROKER_RESEARCH",
    sourceId: "broker:report:001",
    title: "Broker quant note",
    canonicalUrl: "https://example.org/broker/report",
    publisher: "Example Broker",
    retrievedAt,
    provenanceDigest: "c".repeat(64),
    integrityState: "UNKNOWN",
    rights: {
      accessMode: "TERMS_GOVERNED",
      derivedFactsAllowed: true,
      derivedSummaryAllowed: true,
      fullTextStorageAllowed: false,
      redistributionAllowed: false,
      attributionRequired: true,
      licenseOrTermsUrl: "https://example.org/broker/terms",
    },
    claims: [{
      claimId: "claim-broker-001",
      derivedSummary: "Revision momentum is proposed as a research hypothesis.",
      mechanism: "Analyst estimate revisions may update slower than prices in some segments.",
      markets: ["US_STOCK"],
      horizons: ["1d"],
      features: ["revision_momentum"],
      falsifiers: ["no prospective edge"],
      independenceGroupId: "broker-revision",
      evidenceDigest: "d".repeat(64),
    }],
  });

  assert.equal(receipt.status, "WORLD_KNOWLEDGE_RECEIPT_READY");
  assert.equal(receipt.source.contentPolicy, undefined);
  assert.equal(receipt.source.rights.accessMode, "TERMS_GOVERNED");
  assert.equal(receipt.source.rights.fullTextStorageAllowed, false);
  assert.equal(receipt.source.rawContentPersisted, false);
});

test("existing paper video and public-document adapters feed one canonical ingest", () => {
  const pInput = {
    paper: paper(),
    sourceType: "ACADEMIC_PAPER",
    claims: paperClaims(),
    contentAccessEvidence: {
      accessMode: "PUBLIC_METADATA",
      derivedFactsAllowed: true,
      derivedSummaryAllowed: true,
      fullTextStorageAllowed: false,
      redistributionAllowed: false,
      attributionRequired: true,
      licenseOrTermsUrl: "https://example.org/crossref-terms",
    },
  };
  const { source, hypothesis } = videoObjects();
  const result = buildWorldKnowledgeFromExistingResearchV1({
    paperInputs: [pInput],
    videoInputs: [{
      source,
      hypothesis,
      derivedSummary: "VWAP reclaim is a testable confirmation hypothesis.",
      mechanism: "Participation after reclaim may indicate continuation.",
      features: ["vwap_distance", "relative_volume"],
      falsifiers: ["no OOS edge"],
      independenceGroupId: "video-vwap",
      termsUrl: "https://www.youtube.com/static?template=terms",
    }],
    documentInputs: [{
      sourceType: "PUBLIC_BOOK",
      sourceId: "book:public:001",
      title: "Public-domain market notes",
      canonicalUrl: "https://example.org/public-book",
      publisher: "Public Archive",
      retrievedAt,
      provenanceDigest: "e".repeat(64),
      integrityState: "OK",
      rights: {
        accessMode: "PUBLIC_DOMAIN",
        derivedFactsAllowed: true,
        derivedSummaryAllowed: true,
        fullTextStorageAllowed: true,
        redistributionAllowed: true,
        attributionRequired: false,
        licenseOrTermsUrl: "https://example.org/public-domain",
      },
      claims: [{
        claimId: "claim-book-001",
        derivedSummary: "Risk should be derived before position quantity.",
        mechanism: "Fixed risk budget prevents notional size from moving invalidation.",
        markets: ["US_STOCK"],
        horizons: ["all"],
        features: ["risk_budget", "stop_distance"],
        falsifiers: ["risk-normalized drawdown not improved"],
        independenceGroupId: "book-risk",
        evidenceDigest: "f".repeat(64),
      }],
    }],
  });

  assert.equal(result.status, "WORLD_KNOWLEDGE_ADAPTER_READY");
  assert.equal(result.adaptedReceiptCount, 3);
  assert.equal(result.ingest.status, "WORLD_KNOWLEDGE_READY");
  assert.equal(result.rawContentCopiedIntoCanonicalGraph, false);
  assert.equal(result.executionAuthority, "NONE");
});

import crypto from "node:crypto";

import {
  verifyResearchPaperV2,
} from "../../packages/external-research/src/contract.js";
import {
  assertResearchVideoSourceV1,
  assertVideoStrategyHypothesisV1,
} from "../../packages/external-research/src/video-intelligence.js";
import {
  WORLD_KNOWLEDGE_INGEST_V1,
  buildWorldKnowledgeIngestV1,
  createWorldKnowledgeReceiptV1,
} from "./world-knowledge-ingest-v1.js";

export const WORLD_KNOWLEDGE_EXISTING_ADAPTERS_V1 =
  "world-knowledge-existing-adapters-v1";

const PAPER_TYPES = new Set(["ACADEMIC_PAPER", "PREPRINT"]);
const DOCUMENT_TYPES = new Set(["BROKER_RESEARCH", "PUBLIC_BOOK", "OFFICIAL", "MARKET_DATA"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function precisePublishedAt(value) {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}T/u.test(raw) && Number.isFinite(Date.parse(raw))) return raw;
  return null;
}

function normalizeRights(input) {
  if (!input || input.derivedFactsAllowed !== true || input.derivedSummaryAllowed !== true) {
    throw new Error("WORLD_ADAPTER_DERIVED_USE_AUTHORIZATION_REQUIRED");
  }
  return {
    accessMode: text(input.accessMode)?.toUpperCase(),
    derivedFactsAllowed: true,
    derivedSummaryAllowed: true,
    fullTextStorageAllowed: input.fullTextStorageAllowed === true,
    redistributionAllowed: input.redistributionAllowed === true,
    attributionRequired: input.attributionRequired === true,
    licenseOrTermsUrl: input.licenseOrTermsUrl ?? null,
  };
}

function paperIntegrity(paper) {
  if (paper.retractionState?.status === "RETRACTED") return "RETRACTED";
  if (["CORRECTED", "CORRECTION_NOTICE"].includes(paper.correctionState?.status)) return "CORRECTED";
  return "UNKNOWN";
}

export function adaptResearchPaperV2ToWorldKnowledgeReceiptV1({
  paper,
  sourceType,
  claims,
  contentAccessEvidence,
} = {}) {
  const normalizedType = text(sourceType)?.toUpperCase();
  if (!PAPER_TYPES.has(normalizedType)) throw new Error("WORLD_PAPER_SOURCE_TYPE_INVALID");
  if (!verifyResearchPaperV2(paper)) throw new Error("WORLD_RESEARCH_PAPER_V2_INVALID");

  return createWorldKnowledgeReceiptV1({
    sourceType: normalizedType,
    sourceId: paper.paperId,
    title: paper.title,
    canonicalUrl: paper.canonicalUrl,
    publisher: paper.provenance.provider,
    publishedAt: precisePublishedAt(paper.publishedAt),
    retrievedAt: paper.retrievedAt,
    provenanceDigest: paper.metadataHash,
    integrityState: paperIntegrity(paper),
    rights: normalizeRights(contentAccessEvidence),
    claims,
    executionAuthority: "NONE",
  });
}

function videoClaimFromHypothesis({
  source,
  hypothesis,
  derivedSummary,
  mechanism,
  features,
  falsifiers,
  independenceGroupId,
} = {}) {
  const summary = text(derivedSummary);
  const normalizedMechanism = text(mechanism);
  if (!summary || !normalizedMechanism) throw new Error("WORLD_VIDEO_DERIVED_CLAIM_REQUIRED");
  if (!Array.isArray(features) || features.length === 0
      || !Array.isArray(falsifiers) || falsifiers.length === 0) {
    throw new Error("WORLD_VIDEO_FEATURES_AND_FALSIFIERS_REQUIRED");
  }
  const evidenceDigest = digest({
    sourceId: source.sourceId,
    hypothesisId: hypothesis.hypothesisId,
    sourceQuoteHash: hypothesis.sourceQuoteHash,
    extractedFacts: hypothesis.extractedFacts,
    extractedInferences: hypothesis.extractedInferences,
    entryRules: hypothesis.entryRules,
    exitRules: hypothesis.exitRules,
  });
  const start = hypothesis.sourceStartSec;
  const end = hypothesis.sourceEndSec;
  const locator = Number.isFinite(start)
    ? `video:${start}-${Number.isFinite(end) ? end : start}s`
    : "video:hypothesis";

  return {
    claimId: `claim:${hypothesis.hypothesisId}`,
    derivedSummary: summary,
    mechanism: normalizedMechanism,
    markets: [hypothesis.market],
    horizons: [hypothesis.timeframe],
    features,
    falsifiers,
    independenceGroupId: text(independenceGroupId)
      ?? `video:${source.channelOrPublisher}`,
    evidenceDigest,
    locator,
  };
}

export function adaptVideoHypothesisToWorldKnowledgeReceiptV1({
  source,
  hypothesis,
  derivedSummary,
  mechanism,
  features,
  falsifiers,
  independenceGroupId,
  termsUrl = null,
} = {}) {
  assertResearchVideoSourceV1(source);
  assertVideoStrategyHypothesisV1(hypothesis);
  if (hypothesis.sourceId !== source.sourceId || hypothesis.sourceVideoId !== source.videoId) {
    throw new Error("WORLD_VIDEO_SOURCE_HYPOTHESIS_MISMATCH");
  }
  if (!["TESTABLE", "PARTIALLY_TESTABLE"].includes(hypothesis.testabilityStatus)) {
    throw new Error("WORLD_VIDEO_HYPOTHESIS_NOT_TESTABLE");
  }
  if (source.transcriptStatus !== "AVAILABLE" || source.transcriptAuthorized !== true) {
    throw new Error("WORLD_VIDEO_AUTHORIZED_TRANSCRIPT_REQUIRED");
  }
  if (hypothesis.executionAuthority !== "NONE") throw new Error("WORLD_VIDEO_EXECUTION_AUTHORITY_FORBIDDEN");

  const claim = videoClaimFromHypothesis({
    source,
    hypothesis,
    derivedSummary,
    mechanism,
    features,
    falsifiers,
    independenceGroupId,
  });
  const provenanceDigest = digest({
    sourceId: source.sourceId,
    hypothesisId: hypothesis.hypothesisId,
    sourceUrl: hypothesis.sourceUrl,
    sourceQuoteHash: hypothesis.sourceQuoteHash,
  });

  return createWorldKnowledgeReceiptV1({
    sourceType: "VIDEO",
    sourceId: source.sourceId,
    title: source.title,
    canonicalUrl: source.canonicalUrl,
    publisher: source.channelOrPublisher,
    publishedAt: precisePublishedAt(source.publishedAt),
    retrievedAt: source.discoveredAt,
    provenanceDigest,
    integrityState: "UNKNOWN",
    rights: {
      accessMode: "TERMS_GOVERNED",
      derivedFactsAllowed: true,
      derivedSummaryAllowed: true,
      fullTextStorageAllowed: false,
      redistributionAllowed: false,
      attributionRequired: true,
      licenseOrTermsUrl: termsUrl,
    },
    claims: [claim],
    executionAuthority: "NONE",
  });
}

export function adaptAuthorizedPublicDocumentToWorldKnowledgeReceiptV1({
  sourceType,
  sourceId,
  title,
  canonicalUrl,
  publisher,
  publishedAt = null,
  retrievedAt,
  provenanceDigest,
  integrityState = "UNKNOWN",
  rights,
  claims,
} = {}) {
  const normalizedType = text(sourceType)?.toUpperCase();
  if (!DOCUMENT_TYPES.has(normalizedType)) throw new Error("WORLD_DOCUMENT_SOURCE_TYPE_INVALID");
  return createWorldKnowledgeReceiptV1({
    sourceType: normalizedType,
    sourceId,
    title,
    canonicalUrl,
    publisher,
    publishedAt: precisePublishedAt(publishedAt),
    retrievedAt,
    provenanceDigest,
    integrityState,
    rights: normalizeRights(rights),
    claims,
    executionAuthority: "NONE",
  });
}

export function buildWorldKnowledgeFromExistingResearchV1({
  paperInputs = [],
  videoInputs = [],
  documentInputs = [],
  edges = [],
} = {}) {
  if (!Array.isArray(paperInputs) || !Array.isArray(videoInputs)
      || !Array.isArray(documentInputs) || !Array.isArray(edges)) {
    throw new TypeError("WORLD_EXISTING_ADAPTER_INPUT_ARRAYS_REQUIRED");
  }

  const receipts = [];
  const adapterErrors = [];
  const adapt = (kind, index, fn) => {
    try {
      const receipt = fn();
      if (receipt.status !== "WORLD_KNOWLEDGE_RECEIPT_READY") {
        adapterErrors.push({
          kind,
          index,
          code: receipt.blockers.join("|") || "WORLD_RECEIPT_BLOCKED",
        });
      } else {
        receipts.push(receipt);
      }
    } catch (error) {
      adapterErrors.push({
        kind,
        index,
        code: text(error?.message) ?? "WORLD_ADAPTER_FAILED",
      });
    }
  };

  paperInputs.forEach((input, index) =>
    adapt("PAPER", index, () => adaptResearchPaperV2ToWorldKnowledgeReceiptV1(input)));
  videoInputs.forEach((input, index) =>
    adapt("VIDEO", index, () => adaptVideoHypothesisToWorldKnowledgeReceiptV1(input)));
  documentInputs.forEach((input, index) =>
    adapt("DOCUMENT", index, () => adaptAuthorizedPublicDocumentToWorldKnowledgeReceiptV1(input)));

  const ingest = buildWorldKnowledgeIngestV1({ receipts, edges, executionAuthority: "NONE" });
  const core = {
    receiptDigests: receipts.map((receipt) => receipt.receiptDigest).sort(),
    adapterErrors,
    ingestDigest: ingest.ingestDigest ?? null,
  };

  return deepFreeze({
    schemaVersion: WORLD_KNOWLEDGE_EXISTING_ADAPTERS_V1,
    artifactType: "WORLD_KNOWLEDGE_EXISTING_ADAPTER_RESULT",
    status: ingest.status === "BLOCKED_DATA"
      ? "BLOCKED_DATA"
      : adapterErrors.length > 0
        ? "WORLD_KNOWLEDGE_ADAPTER_PARTIAL"
        : "WORLD_KNOWLEDGE_ADAPTER_READY",
    adapterErrors,
    adaptedReceiptCount: receipts.length,
    ingest,
    adapterDigest: digest(core),
    upstreamContracts: {
      papers: "ResearchPaperV2",
      video: "ResearchVideoSourceV1 + VideoStrategyHypothesisV1",
      publicDocuments: "EXPLICIT_RIGHTS_AND_PROVENANCE_RECEIPT",
    },
    rawContentCopiedIntoCanonicalGraph: false,
    executionAuthority: "NONE",
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    profitabilityProven: false,
  });
}

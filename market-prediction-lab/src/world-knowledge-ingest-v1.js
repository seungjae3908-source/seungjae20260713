import crypto from "node:crypto";

import {
  AUTONOMOUS_ALPHA_SCIENTIST_FOUNDATION_V1,
  buildAutonomousAlphaEvidenceGraphV1,
} from "./autonomous-alpha-scientist-foundation-v1.js";

export const WORLD_KNOWLEDGE_INGEST_V1 = "world-knowledge-ingest-v1";

export const WORLD_KNOWLEDGE_SOURCE_TYPES = Object.freeze([
  "OFFICIAL",
  "ACADEMIC_PAPER",
  "PREPRINT",
  "BROKER_RESEARCH",
  "PUBLIC_BOOK",
  "VIDEO",
  "MARKET_DATA",
]);

const SOURCE_TYPES = new Set(WORLD_KNOWLEDGE_SOURCE_TYPES);
const ACCESS_MODES = new Set([
  "PUBLIC_METADATA",
  "PUBLIC_DOMAIN",
  "LICENSED",
  "USER_PROVIDED",
  "TERMS_GOVERNED",
]);
const INTEGRITY_STATES = new Set(["OK", "CORRECTED", "UNKNOWN", "RETRACTED"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
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

function httpsUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function timestamp(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function stringList(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rows = value.map(text);
  if (rows.some((row) => !row)) return null;
  const unique = [...new Set(rows)].sort();
  return unique.length === rows.length ? unique : null;
}

function safety() {
  return {
    researchOnly: true,
    networkFetchAuthority: false,
    privateSourceAuthority: false,
    rawContentPersistenceAuthority: false,
    executionAuthority: "NONE",
    mayPlaceOrder: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    automaticPromotionAllowed: false,
    economicSampleCredit: 0,
    profitabilityProven: false,
  };
}

function normalizeRights(raw) {
  const accessMode = text(raw?.accessMode)?.toUpperCase();
  const derivedFactsAllowed = raw?.derivedFactsAllowed === true;
  const derivedSummaryAllowed = raw?.derivedSummaryAllowed === true;
  const fullTextStorageAllowed = raw?.fullTextStorageAllowed === true;
  const redistributionAllowed = raw?.redistributionAllowed === true;
  const attributionRequired = raw?.attributionRequired === true;
  const licenseOrTermsUrl = raw?.licenseOrTermsUrl == null
    ? null
    : httpsUrl(raw.licenseOrTermsUrl);

  if (!ACCESS_MODES.has(accessMode)) return null;
  if (!derivedFactsAllowed || !derivedSummaryAllowed) return null;
  if (raw?.licenseOrTermsUrl != null && !licenseOrTermsUrl) return null;

  return {
    accessMode,
    derivedFactsAllowed,
    derivedSummaryAllowed,
    fullTextStorageAllowed,
    redistributionAllowed,
    attributionRequired,
    licenseOrTermsUrl,
  };
}

export function createWorldKnowledgeReceiptV1(input = {}) {
  const blockers = [];
  const sourceType = text(input.sourceType)?.toUpperCase();
  const sourceId = text(input.sourceId);
  const title = text(input.title);
  const canonicalUrl = httpsUrl(input.canonicalUrl);
  const publisher = text(input.publisher);
  const publishedAt = input.publishedAt == null ? null : timestamp(input.publishedAt);
  const retrievedAt = timestamp(input.retrievedAt);
  const provenanceDigest = text(input.provenanceDigest);
  const integrityState = text(input.integrityState)?.toUpperCase();
  const rights = normalizeRights(input.rights);

  if (!SOURCE_TYPES.has(sourceType)) blockers.push("WORLD_SOURCE_TYPE_INVALID");
  if (!sourceId) blockers.push("WORLD_SOURCE_ID_REQUIRED");
  if (!title) blockers.push("WORLD_TITLE_REQUIRED");
  if (!canonicalUrl) blockers.push("WORLD_CANONICAL_HTTPS_URL_REQUIRED");
  if (!publisher) blockers.push("WORLD_PUBLISHER_REQUIRED");
  if (input.publishedAt != null && !publishedAt) blockers.push("WORLD_PUBLISHED_AT_INVALID");
  if (!retrievedAt) blockers.push("WORLD_RETRIEVED_AT_INVALID");
  if (!provenanceDigest || !/^[0-9a-f]{64}$/u.test(provenanceDigest)) {
    blockers.push("WORLD_PROVENANCE_DIGEST_REQUIRED");
  }
  if (!INTEGRITY_STATES.has(integrityState)) blockers.push("WORLD_INTEGRITY_STATE_INVALID");
  if (integrityState === "RETRACTED") blockers.push("WORLD_SOURCE_RETRACTED");
  if (!rights) blockers.push("WORLD_RIGHTS_INVALID");
  if (input.executionAuthority != null && input.executionAuthority !== "NONE") {
    blockers.push("WORLD_EXECUTION_AUTHORITY_FORBIDDEN");
  }
  if (input.rawContent != null || input.fullText != null || input.transcriptText != null) {
    blockers.push("WORLD_CANONICAL_RAW_CONTENT_FORBIDDEN");
  }

  const claims = Array.isArray(input.claims) ? input.claims.map((claim, index) => {
    const claimId = text(claim?.claimId);
    const derivedSummary = text(claim?.derivedSummary);
    const mechanism = text(claim?.mechanism);
    const markets = stringList(claim?.markets);
    const horizons = stringList(claim?.horizons);
    const features = stringList(claim?.features);
    const falsifiers = stringList(claim?.falsifiers);
    const independenceGroupId = text(claim?.independenceGroupId);
    const evidenceDigest = text(claim?.evidenceDigest);
    const locator = text(claim?.locator);
    const reasons = [];
    if (!claimId) reasons.push("WORLD_CLAIM_ID_REQUIRED");
    if (!derivedSummary) reasons.push("WORLD_CLAIM_SUMMARY_REQUIRED");
    if (!mechanism) reasons.push("WORLD_CLAIM_MECHANISM_REQUIRED");
    if (!markets) reasons.push("WORLD_CLAIM_MARKETS_REQUIRED");
    if (!horizons) reasons.push("WORLD_CLAIM_HORIZONS_REQUIRED");
    if (!features) reasons.push("WORLD_CLAIM_FEATURES_REQUIRED");
    if (!falsifiers) reasons.push("WORLD_CLAIM_FALSIFIERS_REQUIRED");
    if (!independenceGroupId) reasons.push("WORLD_CLAIM_INDEPENDENCE_REQUIRED");
    if (!evidenceDigest || !/^[0-9a-f]{64}$/u.test(evidenceDigest)) {
      reasons.push("WORLD_CLAIM_EVIDENCE_DIGEST_REQUIRED");
    }
    if (claim?.rawQuote != null || claim?.originalText != null) {
      reasons.push("WORLD_CLAIM_RAW_TEXT_FORBIDDEN");
    }
    return {
      claimId: claimId ?? `claim-${index}`,
      derivedSummary: derivedSummary ?? null,
      mechanism: mechanism ?? null,
      markets: markets ?? [],
      horizons: horizons ?? [],
      features: features ?? [],
      falsifiers: falsifiers ?? [],
      independenceGroupId: independenceGroupId ?? null,
      evidenceDigest: evidenceDigest ?? null,
      locator: locator ?? null,
      admissible: reasons.length === 0,
      reasons: [...new Set(reasons)].sort(),
    };
  }) : [];

  if (claims.length === 0) blockers.push("WORLD_CLAIMS_REQUIRED");
  if (claims.some((claim) => !claim.admissible)) blockers.push("WORLD_CLAIM_INVALID");

  const identity = {
    sourceType: sourceType ?? null,
    sourceId: sourceId ?? null,
    canonicalUrl: canonicalUrl ?? null,
    provenanceDigest: provenanceDigest ?? null,
  };

  return deepFreeze({
    schemaVersion: WORLD_KNOWLEDGE_INGEST_V1,
    artifactType: "WORLD_KNOWLEDGE_RECEIPT",
    status: blockers.length === 0 ? "WORLD_KNOWLEDGE_RECEIPT_READY" : "BLOCKED_DATA",
    blockers: [...new Set(blockers)].sort(),
    source: {
      sourceType: sourceType ?? null,
      sourceId: sourceId ?? null,
      title: title ?? null,
      canonicalUrl: canonicalUrl ?? null,
      publisher: publisher ?? null,
      publishedAt,
      retrievedAt,
      provenanceDigest: provenanceDigest ?? null,
      integrityState: integrityState ?? null,
      rights,
      rawContentPersisted: false,
      sourceDigest: digest(identity),
    },
    claims,
    receiptDigest: digest({ identity, claims, rights }),
    ...safety(),
  });
}

function asEvidenceSource(receipt) {
  const source = receipt.source;
  const contentMode = source.rights.accessMode === "PUBLIC_DOMAIN"
    ? "PUBLIC_DOMAIN"
    : source.rights.fullTextStorageAllowed
      ? "LICENSED_CONTENT"
      : "METADATA_ONLY";
  return {
    sourceId: source.sourceId,
    sourceType: source.sourceType,
    title: source.title,
    canonicalUrl: source.canonicalUrl,
    retrievedAt: source.retrievedAt,
    provenanceDigest: source.provenanceDigest,
    integrityState: source.integrityState,
    contentPolicy: {
      mode: contentMode,
      fullTextStorageAllowed: source.rights.fullTextStorageAllowed,
      derivedSummaryAllowed: source.rights.derivedSummaryAllowed,
      redistributionAllowed: source.rights.redistributionAllowed,
      attributionRequired: source.rights.attributionRequired,
    },
  };
}

function asEvidenceClaims(receipt) {
  return receipt.claims.map((claim) => ({
    claimId: claim.claimId,
    sourceId: receipt.source.sourceId,
    derivedSummary: claim.derivedSummary,
    mechanism: claim.mechanism,
    markets: claim.markets,
    horizons: claim.horizons,
    features: claim.features,
    falsifiers: claim.falsifiers,
    independenceGroupId: claim.independenceGroupId,
    evidenceDigest: claim.evidenceDigest,
    locator: claim.locator,
  }));
}

export function buildWorldKnowledgeIngestV1({
  receipts = [],
  edges = [],
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  if (!Array.isArray(receipts) || receipts.length === 0) blockers.push("WORLD_RECEIPTS_REQUIRED");
  if (!Array.isArray(edges)) blockers.push("WORLD_EDGES_ARRAY_REQUIRED");
  if (executionAuthority !== "NONE") blockers.push("WORLD_EXECUTION_AUTHORITY_FORBIDDEN");

  const accepted = [];
  const rejected = [];
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (receipt?.schemaVersion !== WORLD_KNOWLEDGE_INGEST_V1
        || receipt?.artifactType !== "WORLD_KNOWLEDGE_RECEIPT"
        || receipt?.status !== "WORLD_KNOWLEDGE_RECEIPT_READY"
        || receipt?.executionAuthority !== "NONE") {
      rejected.push(receipt?.source?.sourceId ?? null);
      continue;
    }
    accepted.push(receipt);
  }
  if (accepted.length === 0) blockers.push("NO_ADMISSIBLE_WORLD_RECEIPTS");

  const sourceIds = accepted.map((receipt) => receipt.source.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) blockers.push("WORLD_DUPLICATE_SOURCE_ID");

  const claimIds = accepted.flatMap((receipt) => receipt.claims.map((claim) => claim.claimId));
  if (new Set(claimIds).size !== claimIds.length) blockers.push("WORLD_DUPLICATE_CLAIM_ID");

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: WORLD_KNOWLEDGE_INGEST_V1,
      artifactType: "WORLD_KNOWLEDGE_INGEST",
      status: "BLOCKED_DATA",
      blockers: [...new Set(blockers)].sort(),
      acceptedSourceIds: sourceIds.sort(),
      rejectedSourceIds: rejected.filter(Boolean).sort(),
      evidenceGraph: null,
      ...safety(),
    });
  }

  const evidenceGraph = buildAutonomousAlphaEvidenceGraphV1({
    sources: accepted.map(asEvidenceSource),
    claims: accepted.flatMap(asEvidenceClaims),
    edges,
    executionAuthority: "NONE",
  });

  if (!["EVIDENCE_GRAPH_READY", "EVIDENCE_GRAPH_PARTIAL"].includes(evidenceGraph.status)) {
    return deepFreeze({
      schemaVersion: WORLD_KNOWLEDGE_INGEST_V1,
      artifactType: "WORLD_KNOWLEDGE_INGEST",
      status: "BLOCKED_DATA",
      blockers: ["WORLD_EVIDENCE_GRAPH_REJECTED", ...evidenceGraph.blockers].sort(),
      acceptedSourceIds: sourceIds.sort(),
      rejectedSourceIds: rejected.filter(Boolean).sort(),
      evidenceGraph,
      ...safety(),
    });
  }

  const sourceMix = Object.fromEntries(
    WORLD_KNOWLEDGE_SOURCE_TYPES.map((type) => [
      type,
      accepted.filter((receipt) => receipt.source.sourceType === type).length,
    ]),
  );

  const core = {
    acceptedReceiptDigests: accepted.map((receipt) => receipt.receiptDigest).sort(),
    graphDigest: evidenceGraph.graphDigest,
    sourceMix,
  };

  return deepFreeze({
    schemaVersion: WORLD_KNOWLEDGE_INGEST_V1,
    artifactType: "WORLD_KNOWLEDGE_INGEST",
    status: rejected.length > 0 ? "WORLD_KNOWLEDGE_PARTIAL" : "WORLD_KNOWLEDGE_READY",
    blockers: [],
    acceptedSourceIds: sourceIds.sort(),
    rejectedSourceIds: rejected.filter(Boolean).sort(),
    sourceMix,
    evidenceGraph,
    ingestDigest: digest(core),
    canonicalRawContentPersisted: false,
    downstreamStage: "ALPHA_GENOME",
    ...safety(),
  });
}

export function verifyWorldKnowledgeIngestV1(value) {
  return value?.schemaVersion === WORLD_KNOWLEDGE_INGEST_V1
    && ["WORLD_KNOWLEDGE_READY", "WORLD_KNOWLEDGE_PARTIAL"].includes(value?.status)
    && value?.executionAuthority === "NONE"
    && value?.canonicalRawContentPersisted === false
    && value?.evidenceGraph?.schemaVersion === AUTONOMOUS_ALPHA_SCIENTIST_FOUNDATION_V1
    && ["EVIDENCE_GRAPH_READY", "EVIDENCE_GRAPH_PARTIAL"].includes(value?.evidenceGraph?.status)
    && typeof value?.ingestDigest === "string"
    && /^[0-9a-f]{64}$/u.test(value.ingestDigest);
}

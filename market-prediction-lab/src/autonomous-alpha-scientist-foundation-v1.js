import crypto from "node:crypto";

export const AUTONOMOUS_ALPHA_SCIENTIST_FOUNDATION_V1 =
  "autonomous-alpha-scientist-foundation-v1";

export const ALPHA_EVIDENCE_SOURCE_TYPES = Object.freeze([
  "OFFICIAL",
  "ACADEMIC_PAPER",
  "PREPRINT",
  "BROKER_RESEARCH",
  "PUBLIC_BOOK",
  "VIDEO",
  "MARKET_DATA",
  "OTHER",
]);

export const ALPHA_EVIDENCE_CONTENT_MODES = Object.freeze([
  "METADATA_ONLY",
  "LICENSED_CONTENT",
  "PUBLIC_DOMAIN",
  "USER_PROVIDED",
]);

export const ALPHA_EVIDENCE_EDGE_TYPES = Object.freeze([
  "SUPPORTS",
  "CONTRADICTS",
  "EXTENDS",
  "REPLICATES",
  "DERIVES_FROM",
]);

export const ALPHA_GENE_TYPES = Object.freeze([
  "REGIME",
  "SIGNAL",
  "CONFIRMATION",
  "ENTRY",
  "EXIT",
  "SIZING",
  "EXECUTION",
  "RISK",
  "EVENT",
  "COST",
]);

const SOURCE_TYPE_SET = new Set(ALPHA_EVIDENCE_SOURCE_TYPES);
const CONTENT_MODE_SET = new Set(ALPHA_EVIDENCE_CONTENT_MODES);
const EDGE_TYPE_SET = new Set(ALPHA_EVIDENCE_EDGE_TYPES);
const GENE_TYPE_SET = new Set(ALPHA_GENE_TYPES);
const INTEGRITY_STATES = new Set(["OK", "CORRECTED", "UNKNOWN", "RETRACTED"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function digest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function exactStringArray(value) {
  if (!Array.isArray(value)) return null;
  const normalized = [...new Set(value.map(text).filter(Boolean))].sort();
  return normalized.length === value.length && normalized.length > 0 ? normalized : null;
}

function isoTimestamp(value) {
  const normalized = text(value);
  if (!normalized) return null;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function httpsUrl(value) {
  const normalized = text(value);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function safety() {
  return {
    researchOnly: true,
    mayPlaceOrder: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    automaticPromotionAllowed: false,
    executionAuthority: "NONE",
    economicSampleCredit: 0,
    profitabilityProven: false,
  };
}

function normalizeContentPolicy(source) {
  const mode = text(source?.contentPolicy?.mode)?.toUpperCase();
  if (!CONTENT_MODE_SET.has(mode)) return null;
  const fullTextStorageAllowed = source?.contentPolicy?.fullTextStorageAllowed === true;
  const derivedSummaryAllowed = source?.contentPolicy?.derivedSummaryAllowed === true;
  const redistributionAllowed = source?.contentPolicy?.redistributionAllowed === true;
  const attributionRequired = source?.contentPolicy?.attributionRequired === true;

  if (mode === "METADATA_ONLY" && fullTextStorageAllowed) return null;
  if (source?.rawContent != null && !fullTextStorageAllowed) return null;
  if (!derivedSummaryAllowed) return null;

  return {
    mode,
    fullTextStorageAllowed,
    derivedSummaryAllowed,
    redistributionAllowed,
    attributionRequired,
    rawContentPersisted: false,
  };
}

function normalizeSource(source, index) {
  const sourceId = text(source?.sourceId);
  const sourceType = text(source?.sourceType)?.toUpperCase();
  const title = text(source?.title);
  const canonicalUrl = httpsUrl(source?.canonicalUrl);
  const retrievedAt = isoTimestamp(source?.retrievedAt);
  const provenanceDigest = text(source?.provenanceDigest);
  const integrityState = text(source?.integrityState)?.toUpperCase();
  const contentPolicy = normalizeContentPolicy(source);

  const reasons = [];
  if (!sourceId) reasons.push("SOURCE_ID_REQUIRED");
  if (!SOURCE_TYPE_SET.has(sourceType)) reasons.push("SOURCE_TYPE_INVALID");
  if (!title) reasons.push("SOURCE_TITLE_REQUIRED");
  if (!canonicalUrl) reasons.push("SOURCE_HTTPS_URL_REQUIRED");
  if (!retrievedAt) reasons.push("SOURCE_RETRIEVED_AT_INVALID");
  if (!provenanceDigest || !/^[0-9a-f]{64}$/u.test(provenanceDigest)) {
    reasons.push("SOURCE_PROVENANCE_DIGEST_REQUIRED");
  }
  if (!INTEGRITY_STATES.has(integrityState)) reasons.push("SOURCE_INTEGRITY_STATE_INVALID");
  if (!contentPolicy) reasons.push("SOURCE_CONTENT_POLICY_INVALID");
  if (integrityState === "RETRACTED") reasons.push("SOURCE_RETRACTED");

  const normalized = {
    sourceId: sourceId ?? `source-${index}`,
    sourceType: sourceType ?? null,
    title: title ?? null,
    canonicalUrl: canonicalUrl ?? null,
    retrievedAt: retrievedAt ?? null,
    provenanceDigest: provenanceDigest ?? null,
    integrityState: integrityState ?? null,
    contentPolicy,
    reputationPrior: "UNESTABLISHED",
    admissibleForClaimExtraction: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
  };
  normalized.sourceDigest = digest(normalized);
  return deepFreeze(normalized);
}

function normalizeClaim(claim, sourceById, index) {
  const claimId = text(claim?.claimId);
  const sourceId = text(claim?.sourceId);
  const source = sourceById.get(sourceId);
  const derivedSummary = text(claim?.derivedSummary);
  const mechanism = text(claim?.mechanism);
  const markets = exactStringArray(claim?.markets);
  const horizons = exactStringArray(claim?.horizons);
  const features = exactStringArray(claim?.features);
  const falsifiers = exactStringArray(claim?.falsifiers);
  const independenceGroupId = text(claim?.independenceGroupId);
  const evidenceDigest = text(claim?.evidenceDigest);
  const locator = text(claim?.locator);

  const reasons = [];
  if (!claimId) reasons.push("CLAIM_ID_REQUIRED");
  if (!sourceId || !source) reasons.push("CLAIM_SOURCE_NOT_FOUND");
  if (source && !source.admissibleForClaimExtraction) reasons.push("CLAIM_SOURCE_NOT_ADMISSIBLE");
  if (!derivedSummary) reasons.push("CLAIM_DERIVED_SUMMARY_REQUIRED");
  if (!mechanism) reasons.push("CLAIM_MECHANISM_REQUIRED");
  if (!markets) reasons.push("CLAIM_MARKETS_REQUIRED");
  if (!horizons) reasons.push("CLAIM_HORIZONS_REQUIRED");
  if (!features) reasons.push("CLAIM_FEATURES_REQUIRED");
  if (!falsifiers) reasons.push("CLAIM_FALSIFIERS_REQUIRED");
  if (!independenceGroupId) reasons.push("CLAIM_INDEPENDENCE_GROUP_REQUIRED");
  if (!evidenceDigest || !/^[0-9a-f]{64}$/u.test(evidenceDigest)) {
    reasons.push("CLAIM_EVIDENCE_DIGEST_REQUIRED");
  }
  if (claim?.quote != null || claim?.rawQuote != null || claim?.originalText != null) {
    reasons.push("CANONICAL_GRAPH_RAW_QUOTE_FORBIDDEN");
  }

  const normalized = {
    claimId: claimId ?? `claim-${index}`,
    sourceId: sourceId ?? null,
    derivedSummary: derivedSummary ?? null,
    mechanism: mechanism ?? null,
    markets: markets ?? [],
    horizons: horizons ?? [],
    features: features ?? [],
    falsifiers: falsifiers ?? [],
    independenceGroupId: independenceGroupId ?? null,
    evidenceDigest: evidenceDigest ?? null,
    locator: locator ?? null,
    rawSourceTextPersisted: false,
    admissible: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
  };
  normalized.claimDigest = digest(normalized);
  return deepFreeze(normalized);
}

function normalizeEdge(edge, claimIds) {
  const fromClaimId = text(edge?.fromClaimId);
  const toClaimId = text(edge?.toClaimId);
  const type = text(edge?.type)?.toUpperCase();
  const reasons = [];
  if (!fromClaimId || !claimIds.has(fromClaimId)) reasons.push("EDGE_FROM_CLAIM_INVALID");
  if (!toClaimId || !claimIds.has(toClaimId)) reasons.push("EDGE_TO_CLAIM_INVALID");
  if (fromClaimId === toClaimId) reasons.push("EDGE_SELF_REFERENCE_FORBIDDEN");
  if (!EDGE_TYPE_SET.has(type)) reasons.push("EDGE_TYPE_INVALID");

  return deepFreeze({
    fromClaimId: fromClaimId ?? null,
    toClaimId: toClaimId ?? null,
    type: type ?? null,
    admissible: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
  });
}

export function buildAutonomousAlphaEvidenceGraphV1({
  sources = [],
  claims = [],
  edges = [],
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  if (!Array.isArray(sources) || sources.length === 0) blockers.push("EVIDENCE_SOURCES_REQUIRED");
  if (!Array.isArray(claims) || claims.length === 0) blockers.push("EVIDENCE_CLAIMS_REQUIRED");
  if (!Array.isArray(edges)) blockers.push("EVIDENCE_EDGES_ARRAY_REQUIRED");
  if (executionAuthority !== "NONE") blockers.push("EVIDENCE_EXECUTION_AUTHORITY_FORBIDDEN");
  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: AUTONOMOUS_ALPHA_SCIENTIST_FOUNDATION_V1,
      artifactType: "EVIDENCE_GRAPH",
      status: "BLOCKED_DATA",
      blockers: blockers.sort(),
      sources: [],
      claims: [],
      edges: [],
      ...safety(),
    });
  }

  const normalizedSources = sources.map(normalizeSource);
  const sourceIds = normalizedSources.map((source) => source.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) blockers.push("DUPLICATE_SOURCE_ID");

  const sourceById = new Map(normalizedSources.map((source) => [source.sourceId, source]));
  const normalizedClaims = claims.map((claim, index) => normalizeClaim(claim, sourceById, index));
  const claimIds = normalizedClaims.map((claim) => claim.claimId);
  if (new Set(claimIds).size !== claimIds.length) blockers.push("DUPLICATE_CLAIM_ID");

  const admissibleClaimIds = new Set(
    normalizedClaims.filter((claim) => claim.admissible).map((claim) => claim.claimId),
  );
  const normalizedEdges = edges.map((edge) => normalizeEdge(edge, admissibleClaimIds));
  if (normalizedEdges.some((edge) => !edge.admissible)) blockers.push("EVIDENCE_EDGE_INVALID");
  if (admissibleClaimIds.size === 0) blockers.push("NO_ADMISSIBLE_EVIDENCE_CLAIM");

  const excludedSources = normalizedSources.filter((source) => !source.admissibleForClaimExtraction);
  const excludedClaims = normalizedClaims.filter((claim) => !claim.admissible);
  const graphCore = {
    sources: normalizedSources,
    claims: normalizedClaims,
    edges: normalizedEdges,
  };

  const status = blockers.length > 0
    ? "BLOCKED_DATA"
    : excludedSources.length > 0 || excludedClaims.length > 0
      ? "EVIDENCE_GRAPH_PARTIAL"
      : "EVIDENCE_GRAPH_READY";

  return deepFreeze({
    schemaVersion: AUTONOMOUS_ALPHA_SCIENTIST_FOUNDATION_V1,
    artifactType: "EVIDENCE_GRAPH",
    status,
    graphDigest: digest(graphCore),
    blockers: [...new Set(blockers)].sort(),
    sources: normalizedSources,
    claims: normalizedClaims,
    edges: normalizedEdges,
    admissibleClaimIds: [...admissibleClaimIds].sort(),
    excludedSourceIds: excludedSources.map((source) => source.sourceId).sort(),
    excludedClaimIds: excludedClaims.map((claim) => claim.claimId).sort(),
    sourceReputationAutoWeightingAllowed: false,
    fullTextRedistributionByDefault: false,
    ...safety(),
  });
}

function normalizeGene(gene, claimById, index) {
  const geneId = text(gene?.geneId);
  const type = text(gene?.type)?.toUpperCase();
  const claimIds = exactStringArray(gene?.claimIds);
  const logic = gene?.logic;
  const reasons = [];

  if (!geneId) reasons.push("GENE_ID_REQUIRED");
  if (!GENE_TYPE_SET.has(type)) reasons.push("GENE_TYPE_INVALID");
  if (!claimIds) reasons.push("GENE_CLAIMS_REQUIRED");
  if (!logic || typeof logic !== "object" || Array.isArray(logic)) reasons.push("GENE_LOGIC_OBJECT_REQUIRED");
  if (claimIds && claimIds.some((claimId) => !claimById.has(claimId))) {
    reasons.push("GENE_REFERENCES_NON_ADMISSIBLE_CLAIM");
  }

  const normalized = {
    geneId: geneId ?? `gene-${index}`,
    type: type ?? null,
    claimIds: claimIds ?? [],
    logic: logic && typeof logic === "object" && !Array.isArray(logic) ? canonical(logic) : null,
    admissible: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
  };
  normalized.geneDigest = digest(normalized);
  return deepFreeze(normalized);
}

export function buildAlphaGenomeV1({
  candidateId,
  hypothesis,
  evidenceGraph,
  genes = [],
  trialAccounting,
  minimumIndependentGroups = 2,
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  const normalizedCandidateId = text(candidateId);
  const normalizedHypothesis = text(hypothesis);
  if (!normalizedCandidateId) blockers.push("ALPHA_CANDIDATE_ID_REQUIRED");
  if (!normalizedHypothesis) blockers.push("ALPHA_HYPOTHESIS_REQUIRED");
  if (!evidenceGraph
      || evidenceGraph.schemaVersion !== AUTONOMOUS_ALPHA_SCIENTIST_FOUNDATION_V1
      || !["EVIDENCE_GRAPH_READY", "EVIDENCE_GRAPH_PARTIAL"].includes(evidenceGraph.status)
      || evidenceGraph.executionAuthority !== "NONE") {
    blockers.push("ALPHA_EVIDENCE_GRAPH_INVALID");
  }
  if (!Array.isArray(genes) || genes.length === 0) blockers.push("ALPHA_GENES_REQUIRED");
  if (!Number.isSafeInteger(minimumIndependentGroups) || minimumIndependentGroups < 1) {
    blockers.push("ALPHA_MINIMUM_INDEPENDENCE_INVALID");
  }
  if (executionAuthority !== "NONE") blockers.push("ALPHA_EXECUTION_AUTHORITY_FORBIDDEN");

  const priorEvaluatedCandidateCount = trialAccounting?.priorEvaluatedCandidateCount;
  const declaredCandidateFamilySize = trialAccounting?.declaredCandidateFamilySize;
  const candidateOrdinal = trialAccounting?.candidateOrdinal;
  if (!Number.isSafeInteger(priorEvaluatedCandidateCount) || priorEvaluatedCandidateCount < 0
      || !Number.isSafeInteger(declaredCandidateFamilySize) || declaredCandidateFamilySize < 1
      || !Number.isSafeInteger(candidateOrdinal) || candidateOrdinal < 1
      || candidateOrdinal > declaredCandidateFamilySize
      || declaredCandidateFamilySize < priorEvaluatedCandidateCount + 1) {
    blockers.push("ALPHA_TRIAL_ACCOUNTING_INVALID");
  }

  const claimById = new Map(
    (evidenceGraph?.claims ?? [])
      .filter((claim) => claim.admissible)
      .map((claim) => [claim.claimId, claim]),
  );
  const normalizedGenes = Array.isArray(genes)
    ? genes.map((gene, index) => normalizeGene(gene, claimById, index))
    : [];
  if (normalizedGenes.some((gene) => !gene.admissible)) blockers.push("ALPHA_GENE_INVALID");

  const geneIds = normalizedGenes.map((gene) => gene.geneId);
  if (new Set(geneIds).size !== geneIds.length) blockers.push("DUPLICATE_ALPHA_GENE_ID");

  const geneTypes = new Set(normalizedGenes.filter((gene) => gene.admissible).map((gene) => gene.type));
  if (!geneTypes.has("SIGNAL")) blockers.push("ALPHA_SIGNAL_GENE_REQUIRED");
  if (!geneTypes.has("RISK")) blockers.push("ALPHA_RISK_GENE_REQUIRED");

  const referencedClaims = new Set(
    normalizedGenes.filter((gene) => gene.admissible).flatMap((gene) => gene.claimIds),
  );
  const independenceGroups = new Set(
    [...referencedClaims]
      .map((claimId) => claimById.get(claimId)?.independenceGroupId)
      .filter(Boolean),
  );
  if (independenceGroups.size < minimumIndependentGroups) {
    blockers.push("ALPHA_INDEPENDENT_EVIDENCE_INSUFFICIENT");
  }

  const core = {
    candidateId: normalizedCandidateId,
    hypothesis: normalizedHypothesis,
    evidenceGraphDigest: evidenceGraph?.graphDigest ?? null,
    genes: normalizedGenes,
    independentEvidenceGroups: [...independenceGroups].sort(),
    trialAccounting: {
      priorEvaluatedCandidateCount: priorEvaluatedCandidateCount ?? null,
      declaredCandidateFamilySize: declaredCandidateFamilySize ?? null,
      candidateOrdinal: candidateOrdinal ?? null,
    },
  };

  return deepFreeze({
    schemaVersion: AUTONOMOUS_ALPHA_SCIENTIST_FOUNDATION_V1,
    artifactType: "ALPHA_GENOME",
    status: blockers.length === 0 ? "ALPHA_GENOME_READY_FOR_FALSIFICATION" : "BLOCKED_DATA",
    blockers: [...new Set(blockers)].sort(),
    ...core,
    genomeDigest: digest(core),
    requiredNextStage: blockers.length === 0 ? "ALPHA_RED_TEAM" : null,
    multipleTestingAccountingRequired: true,
    finalHoldoutMaySelectCandidate: false,
    sourceReputationAutoWeightingAllowed: false,
    promotionEligible: false,
    ...safety(),
  });
}

import { sha256Canonical } from "./research-cache-provenance.js";
import { verifyGlobalAlphaLiteratureRegistry } from "./global-alpha-literature-registry-v1.js";
import {
  assertResearchVideoSourceV1,
  assertVideoStrategyHypothesisV1,
} from "../../packages/external-research/src/video-intelligence.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
  buildAdaptiveMultiEvidencePointInTimeV2,
} from "./adaptive-multi-evidence-point-in-time-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_RESEARCH_INGEST_V2_VERSION =
  "adaptive-multi-evidence-research-ingest-v2";

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

function strings(value) {
  if (!Array.isArray(value)) return null;
  const normalized = value.map(text);
  return normalized.every(Boolean) ? [...new Set(normalized)] : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function safety() {
  return {
    researchOnly: true,
    literatureCanProveProfitability: false,
    youtubeCanProveProfitability: false,
    popularityCanProveProfitability: false,
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
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_RESEARCH_INGEST_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "BLOCKED_DATA",
    literature: [],
    videos: [],
    rejected: [],
    blockers: unique(blockers),
    missingEvidence: unique(missingEvidence),
    independenceStatus: "NOT_YET_PROVEN",
    independentVoteCredit: 0,
    economicSampleCredit: 0,
    profitabilityCredit: 0,
    decisionAuthority: "NONE",
    ...safety(),
  });
}

function implementation(raw) {
  const parameters = raw?.parameters && typeof raw.parameters === "object" && !Array.isArray(raw.parameters)
    ? raw.parameters
    : null;
  const normalized = {
    timeframe: text(raw?.timeframe),
    formula: text(raw?.formula),
    entryCondition: text(raw?.entryCondition),
    exitCondition: text(raw?.exitCondition),
    invalidation: text(raw?.invalidation),
    parameters,
    risks: strings(raw?.risks),
  };
  const missing = Object.entries(normalized)
    .filter(([, value]) => value == null || (Array.isArray(value) && value.length === 0))
    .map(([key]) => key);
  return { normalized, missing };
}

function literatureEvidence(study, input, availability, spec) {
  const publishedAt = timestamp(availability?.publishedAt);
  const availableAt = timestamp(availability?.availableAt);
  const observedAt = timestamp(availability?.observedAt ?? input.observedAt);
  const implementationSpec = implementation(spec);
  const blockers = [];
  if (study.market !== input.market) blockers.push("LITERATURE_MARKET_SCOPE_MISMATCH");
  if (!study.formulaSummary) blockers.push("LITERATURE_REPRODUCIBLE_FORMULA_MISSING");
  if (!publishedAt || !availableAt || !observedAt) blockers.push("LITERATURE_POINT_IN_TIME_AVAILABILITY_MISSING");
  if (implementationSpec.missing.length > 0) blockers.push("LITERATURE_MARKET_IMPLEMENTATION_INCOMPLETE");
  if (blockers.length > 0) return { rejected: { sourceId: study.studyId, reasons: blockers } };
  const facts = unique([
    `studyId=${study.studyId}`,
    `title=${study.title}`,
    `market=${study.market}`,
    `strategyFamily=${study.strategyFamily}`,
    `sourceKey=${study.sourceKey}`,
    `publishedAt=${publishedAt}`,
    `availableAt=${availableAt}`,
    `formula=${implementationSpec.normalized.formula}`,
    `entryCondition=${implementationSpec.normalized.entryCondition}`,
    `exitCondition=${implementationSpec.normalized.exitCondition}`,
    `invalidation=${implementationSpec.normalized.invalidation}`,
  ]);
  const inferences = unique([
    `literatureStrategySummary=${study.strategySummary}`,
    `marketImplementationTimeframe=${implementationSpec.normalized.timeframe}`,
  ]);
  const uncertainty = unique([
    "Published findings are research input and do not prove local or forward profitability.",
    ...implementationSpec.normalized.risks,
  ]);
  const evidence = buildAdaptiveMultiEvidencePointInTimeV2({
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    family: "LITERATURE",
    market: input.market,
    symbol: input.symbol,
    timeframe: implementationSpec.normalized.timeframe,
    side: input.side,
    sourceId: study.studyId,
    originalSourceId: study.sourceKey,
    sourceType: "LITERATURE_STUDY",
    sourceUrl: study.sourceUrl ?? (study.doi ? `https://doi.org/${study.doi}` : null),
    documentId: study.doi ?? study.studyId,
    eventTime: publishedAt,
    publishedAt,
    availableAt,
    observedAt,
    decisionTime: input.decisionTime,
    contentDigest: sha256Canonical({ studyDigest: study.literatureDigest, implementation: implementationSpec.normalized }),
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
    return { rejected: { sourceId: study.studyId, reasons: evidence.blockers } };
  }
  return {
    item: {
      sourceId: study.studyId,
      sourceKey: study.sourceKey,
      strategyFamily: study.strategyFamily,
      implementation: implementationSpec.normalized,
      reportedMetrics: study.reportedMetrics,
      reportedMetricsAuthority: "LITERATURE_ONLY",
      localReplicationStatus: "NOT_EVALUATED",
      evidence,
      profitabilityProven: false,
      promotionEligible: false,
      executionAuthority: "NONE",
    },
  };
}

function validHandoff(handoff, source, hypothesis) {
  return handoff?.schemaVersion === "video-research-canonical-handoff-v1"
    && handoff.status === "AWAITING_FORMULA_EVALUATION"
    && handoff.videoProvenance?.sourceId === source.sourceId
    && handoff.videoProvenance?.videoHypothesisId === hypothesis.hypothesisId
    && text(handoff.canonicalHypothesisId)
    && Array.isArray(handoff.candidates)
    && handoff.candidates.length > 0
    && handoff.candidates.every((candidate) => candidate?.evaluationStatus === "NOT_EVALUATED"
      && candidate?.formulaPassed === false
      && candidate?.safety?.executionAuthority === "NONE")
    && handoff.economicEvidenceCredit === 0
    && handoff.profitabilityCredit === 0
    && handoff.executionAuthority === "NONE";
}

function videoEvidence(row, input) {
  const source = row?.source;
  const hypothesis = row?.hypothesis;
  try {
    assertResearchVideoSourceV1(source);
    assertVideoStrategyHypothesisV1(hypothesis);
  } catch (error) {
    return { rejected: { sourceId: source?.sourceId ?? null, reasons: [error.message] } };
  }
  const blockers = [];
  if (source.sourceId !== hypothesis.sourceId) blockers.push("VIDEO_SOURCE_HYPOTHESIS_MISMATCH");
  if (hypothesis.market !== input.market || !hypothesis.symbolScope.includes(input.symbol)) {
    blockers.push("VIDEO_MARKET_OR_SYMBOL_SCOPE_MISMATCH");
  }
  if (hypothesis.testabilityStatus !== "TESTABLE") blockers.push("VIDEO_HYPOTHESIS_NOT_TESTABLE");
  if (hypothesis.sourceStartSec == null || hypothesis.sourceEndSec == null || !hypothesis.sourceQuoteHash) {
    blockers.push("VIDEO_TIMESTAMP_OR_SECTION_PROVENANCE_MISSING");
  }
  if (hypothesis.invalidations.length === 0) blockers.push("VIDEO_INVALIDATION_MISSING");
  if (hypothesis.uncertainties.length === 0) blockers.push("VIDEO_RISKS_MISSING");
  if (!validHandoff(row.handoff, source, hypothesis)) blockers.push("VIDEO_CANONICAL_FORMULA_HANDOFF_REQUIRED");
  const publishedAt = timestamp(source.publishedAt);
  const availableAt = timestamp(source.discoveredAt);
  if (!publishedAt || !availableAt) blockers.push("VIDEO_POINT_IN_TIME_AVAILABILITY_MISSING");
  if (blockers.length > 0) return { rejected: { sourceId: source.sourceId, reasons: blockers } };

  const facts = unique([
    `sourceId=${source.sourceId}`,
    `videoId=${source.videoId}`,
    `video=${source.canonicalUrl}`,
    `section=${hypothesis.sourceStartSec}-${hypothesis.sourceEndSec}`,
    `claimHash=${hypothesis.sourceQuoteHash}`,
    `market=${hypothesis.market}`,
    `timeframe=${hypothesis.timeframe}`,
    `strategyFamily=${hypothesis.strategyFamily}`,
    ...hypothesis.extractedFacts.map((item) => `extractedFact=${item}`),
  ]);
  const inferences = unique([
    ...hypothesis.authorClaims.map((item) => `authorClaim=${item}`),
    ...hypothesis.entryRules.map((item) => `entryCondition=${item}`),
    ...hypothesis.exitRules.map((item) => `exitCondition=${item}`),
    ...hypothesis.invalidations.map((item) => `invalidation=${item}`),
    ...hypothesis.extractedInferences.map((item) => `extractedInference=${item}`),
  ]);
  const uncertainty = unique([
    "YouTube is an idea source, not trading authority or profitability evidence.",
    "Popularity and view count receive no economic or independence credit.",
    ...hypothesis.uncertainties,
  ]);
  const evidence = buildAdaptiveMultiEvidencePointInTimeV2({
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    family: "YOUTUBE",
    market: input.market,
    symbol: input.symbol,
    timeframe: hypothesis.timeframe,
    side: hypothesis.side,
    sourceId: hypothesis.hypothesisId,
    originalSourceId: source.sourceId,
    sourceType: source.sourceType,
    sourceUrl: source.canonicalUrl,
    documentId: hypothesis.sourceQuoteHash,
    eventTime: publishedAt,
    publishedAt,
    availableAt,
    observedAt: input.observedAt,
    decisionTime: input.decisionTime,
    contentDigest: sha256Canonical({
      sourceId: source.sourceId,
      hypothesisId: hypothesis.hypothesisId,
      canonicalHypothesisId: row.handoff.canonicalHypothesisId,
      candidateIds: row.handoff.candidates.map((candidate) => candidate.candidateId).sort(),
    }),
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
    return { rejected: { sourceId: source.sourceId, reasons: evidence.blockers } };
  }
  return {
    item: {
      sourceId: source.sourceId,
      hypothesisId: hypothesis.hypothesisId,
      canonicalHypothesisId: row.handoff.canonicalHypothesisId,
      sourceSection: { startSec: hypothesis.sourceStartSec, endSec: hypothesis.sourceEndSec },
      claimHash: hypothesis.sourceQuoteHash,
      strategyFamily: hypothesis.strategyFamily,
      formulaCandidateIds: row.handoff.candidates.map((candidate) => candidate.candidateId).sort(),
      formulaEvaluationStatus: "NOT_EVALUATED",
      evidence,
      popularityCredit: 0,
      profitabilityProven: false,
      promotionEligible: false,
      executionAuthority: "NONE",
    },
  };
}

export function buildAdaptiveMultiEvidenceResearchIngestV2(input = {}) {
  const blockers = [];
  const missingEvidence = [];
  const decisionTime = timestamp(input.decisionTime);
  const observedAt = timestamp(input.observedAt);
  const market = text(input.market)?.toUpperCase() ?? null;
  const symbol = text(input.symbol)?.toUpperCase() ?? null;
  const side = text(input.side)?.toUpperCase() ?? "NEUTRAL";
  if (!decisionTime) missingEvidence.push("decisionTime");
  if (!observedAt) missingEvidence.push("observedAt");
  if (!market) missingEvidence.push("market");
  if (!symbol) missingEvidence.push("symbol");
  if (!verifyGlobalAlphaLiteratureRegistry(input.literatureRegistry)) {
    blockers.push("GLOBAL_ALPHA_LITERATURE_REGISTRY_OWNER_INVALID");
  }
  if (!Array.isArray(input.videoResearch)) blockers.push("VIDEO_RESEARCH_ARRAY_REQUIRED");
  if (input.executionAuthority != null && input.executionAuthority !== "NONE") {
    blockers.push("RESEARCH_INGEST_EXECUTION_AUTHORITY_FORBIDDEN");
  }
  if (decisionTime && observedAt && Date.parse(observedAt) > Date.parse(decisionTime)) {
    blockers.push("RESEARCH_INGEST_OBSERVED_AFTER_DECISION");
  }
  if (blockers.length > 0 || missingEvidence.length > 0) return failure(blockers, missingEvidence);

  const context = { decisionTime, observedAt, market, symbol, side };
  const literature = [];
  const videos = [];
  const rejected = [];
  for (const study of input.literatureRegistry.studies) {
    const result = literatureEvidence(
      study,
      context,
      input.literatureAvailabilityByStudyId?.[study.studyId],
      input.literatureImplementationByStudyId?.[study.studyId],
    );
    if (result.item) literature.push(result.item);
    else rejected.push({ lane: "LITERATURE", ...result.rejected });
  }
  for (const row of input.videoResearch) {
    const result = videoEvidence(row, context);
    if (result.item) videos.push(result.item);
    else rejected.push({ lane: "YOUTUBE", ...result.rejected });
  }
  const sourceKeys = literature.map((item) => item.sourceKey);
  const sourceIds = videos.map((item) => item.sourceId);
  if (sourceKeys.length !== new Set(sourceKeys).size) blockers.push("DUPLICATE_LITERATURE_SOURCE");
  if (sourceIds.length !== new Set(sourceIds).size) blockers.push("DUPLICATE_VIDEO_SOURCE");
  if (blockers.length > 0) return failure(blockers);
  const count = literature.length + videos.length;
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_RESEARCH_INGEST_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: count === 0 ? "NO_ADMISSIBLE_RESEARCH_EVIDENCE"
      : rejected.length > 0 ? "PARTIAL_RESEARCH_EVIDENCE" : "READY_FOR_DEDUP_RESEARCH_ONLY",
    decisionTime,
    observedAt,
    market,
    symbol,
    literature,
    videos,
    rejected,
    literatureCount: literature.length,
    videoCount: videos.length,
    missingDoesNotMeanZero: true,
    canonicalBacktestRequired: true,
    oosValidationRequired: true,
    independenceStatus: "NOT_YET_PROVEN",
    independentVoteCredit: 0,
    economicSampleCredit: 0,
    profitabilityCredit: 0,
    blockers: [],
    missingEvidence: [],
    decisionAuthority: "EVIDENCE_ONLY",
    ...safety(),
  });
}

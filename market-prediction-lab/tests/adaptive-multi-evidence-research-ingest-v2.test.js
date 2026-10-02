import assert from "node:assert/strict";
import test from "node:test";
import {
  appendLiteratureStudy,
  createGlobalAlphaLiteratureRegistry,
} from "../src/global-alpha-literature-registry-v1.js";
import {
  createResearchVideoSourceV1,
  createVideoStrategyHypothesisV1,
} from "../../packages/external-research/src/video-intelligence.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_RESEARCH_INGEST_V2_VERSION,
  buildAdaptiveMultiEvidenceResearchIngestV2,
} from "../src/adaptive-multi-evidence-research-ingest-v2.js";

const OBSERVED_AT = "2026-09-14T03:00:00.000Z";
const DECISION_TIME = "2026-09-14T03:01:00.000Z";

function registry() {
  return appendLiteratureStudy(createGlobalAlphaLiteratureRegistry(), {
    studyId: "tsm-study",
    title: "Time-series momentum evidence",
    authors: ["Researcher"],
    venue: "Journal",
    publishedYear: 2025,
    doi: "10.1234/tsm.2025",
    sourceUrl: "https://example.org/paper/tsm",
    market: "US_STOCK",
    strategyFamily: "TIME_SERIES_MOMENTUM",
    strategySummary: "Past return sign is evaluated against later return.",
    formulaSummary: "sign(r_12m) * r_next",
    sample: { observationCount: 1000 },
    reportedMetrics: { sharpe: 0.8 },
    validation: { outOfSample: true, transactionCostsIncluded: false },
  });
}

function source() {
  return createResearchVideoSourceV1({
    provider: "YOUTUBE",
    sourceType: "YOUTUBE_VIDEO",
    canonicalUrl: "https://www.youtube.com/watch?v=research",
    videoId: "research",
    title: "Research idea",
    channelOrPublisher: "Research Channel",
    publishedAt: "2026-09-12T00:00:00.000Z",
    discoveredAt: "2026-09-13T00:00:00.000Z",
    language: "en",
    durationSec: 600,
    transcriptStatus: "AVAILABLE",
    transcriptSource: "AUTHORIZED_FIXTURE",
    transcriptAuthorized: true,
    contentAccessStatus: "AVAILABLE",
    timestampProvenance: [{ startSec: 120, endSec: 180, label: "rules" }],
  });
}

function videoRow(overrides = {}) {
  const s = source();
  const hypothesis = createVideoStrategyHypothesisV1({
    source: s,
    sourceStartSec: 120,
    sourceEndSec: 180,
    sourceQuoteHash: "quote-hash",
    market: "US_STOCK",
    symbolScope: ["AAPL"],
    assetClass: "EQUITY",
    side: "LONG",
    timeframe: "1d",
    strategyFamily: "BREAKOUT",
    categories: ["BREAKOUT"],
    entryRules: ["close exceeds prior 20-day high"],
    exitRules: ["close falls below 10-day low"],
    stopLossRules: ["ATR stop"],
    takeProfitRules: [],
    positionSizingRules: ["risk budget only"],
    indicatorRules: ["20-day high", "10-day low"],
    regimeConstraints: ["trend regime"],
    invalidations: ["no longer testable with available bars"],
    authorClaims: ["breakouts may persist"],
    extractedFacts: ["rules stated between 120s and 180s"],
    extractedInferences: ["requires canonical backtest"],
    uncertainties: ["transaction costs may erase the result"],
  });
  const handoff = {
    schemaVersion: "video-research-canonical-handoff-v1",
    status: "AWAITING_FORMULA_EVALUATION",
    videoProvenance: { sourceId: s.sourceId, videoHypothesisId: hypothesis.hypothesisId },
    canonicalHypothesisId: "canonical-hypothesis-1",
    candidates: [{
      candidateId: "formula-candidate-1",
      evaluationStatus: "NOT_EVALUATED",
      formulaPassed: false,
      safety: { executionAuthority: "NONE" },
    }],
    economicEvidenceCredit: 0,
    profitabilityCredit: 0,
    executionAuthority: "NONE",
  };
  return { source: s, hypothesis, handoff, ...overrides };
}

function input(overrides = {}) {
  return {
    market: "US_STOCK",
    symbol: "AAPL",
    side: "LONG",
    observedAt: OBSERVED_AT,
    decisionTime: DECISION_TIME,
    literatureRegistry: registry(),
    literatureAvailabilityByStudyId: {
      "tsm-study": {
        publishedAt: "2025-01-02T00:00:00.000Z",
        availableAt: "2025-01-03T00:00:00.000Z",
        observedAt: OBSERVED_AT,
      },
    },
    literatureImplementationByStudyId: {
      "tsm-study": {
        timeframe: "1d",
        formula: "sign(roc(close,252))",
        entryCondition: "12-month return is positive",
        exitCondition: "12-month return is non-positive",
        invalidation: "required adjusted price history is unavailable",
        parameters: { lookback: 252 },
        risks: ["turnover and gaps may invalidate reported economics"],
      },
    },
    videoResearch: [videoRow()],
    executionAuthority: "NONE",
    ...overrides,
  };
}

test("existing literature and video owners feed point-in-time V2 research evidence", () => {
  const result = buildAdaptiveMultiEvidenceResearchIngestV2(input());
  assert.equal(result.schemaVersion, ADAPTIVE_MULTI_EVIDENCE_RESEARCH_INGEST_V2_VERSION);
  assert.equal(result.status, "READY_FOR_DEDUP_RESEARCH_ONLY");
  assert.equal(result.literatureCount, 1);
  assert.equal(result.videoCount, 1);
  assert.equal(result.literature[0].evidence.status, "ADMISSIBLE");
  assert.equal(result.videos[0].evidence.status, "ADMISSIBLE");
  assert.equal(result.videos[0].formulaEvaluationStatus, "NOT_EVALUATED");
});

test("reported paper metrics and video popularity receive no profitability credit", () => {
  const result = buildAdaptiveMultiEvidenceResearchIngestV2(input());
  assert.equal(result.literature[0].reportedMetrics.sharpe, 0.8);
  assert.equal(result.literature[0].reportedMetricsAuthority, "LITERATURE_ONLY");
  assert.equal(result.literature[0].profitabilityProven, false);
  assert.equal(result.videos[0].popularityCredit, 0);
  assert.equal(result.videos[0].profitabilityProven, false);
  assert.equal(result.profitabilityCredit, 0);
});

test("literature without exact availability or reproducible implementation is rejected", () => {
  const result = buildAdaptiveMultiEvidenceResearchIngestV2(input({
    literatureAvailabilityByStudyId: {},
    literatureImplementationByStudyId: {},
    videoResearch: [],
  }));
  assert.equal(result.status, "NO_ADMISSIBLE_RESEARCH_EVIDENCE");
  assert.equal(result.literatureCount, 0);
  assert.deepEqual(result.rejected[0].reasons, [
    "LITERATURE_POINT_IN_TIME_AVAILABILITY_MISSING",
    "LITERATURE_MARKET_IMPLEMENTATION_INCOMPLETE",
  ]);
  assert.equal(result.missingDoesNotMeanZero, true);
});

test("YouTube requires timestamp, invalidation, risk, and canonical formula handoff", () => {
  const valid = videoRow();
  const unsafeHandoff = { ...valid.handoff, executionAuthority: "PAPER" };
  const result = buildAdaptiveMultiEvidenceResearchIngestV2(input({
    literatureRegistry: createGlobalAlphaLiteratureRegistry(),
    literatureAvailabilityByStudyId: {},
    literatureImplementationByStudyId: {},
    videoResearch: [{ ...valid, handoff: unsafeHandoff }],
  }));
  assert.equal(result.videoCount, 0);
  assert.ok(result.rejected[0].reasons.includes("VIDEO_CANONICAL_FORMULA_HANDOFF_REQUIRED"));
});

test("future availability is rejected and cannot earn historical economic credit", () => {
  const result = buildAdaptiveMultiEvidenceResearchIngestV2(input({
    literatureAvailabilityByStudyId: {
      "tsm-study": {
        publishedAt: "2025-01-02T00:00:00.000Z",
        availableAt: "2026-09-15T00:00:00.000Z",
        observedAt: "2026-09-15T00:00:01.000Z",
      },
    },
    videoResearch: [],
  }));
  assert.equal(result.literatureCount, 0);
  assert.ok(result.rejected[0].reasons.includes("POINT_IN_TIME_EVIDENCE_UNAVAILABLE_AT_DECISION"));
  assert.equal(result.economicSampleCredit, 0);
});

test("V2 research ingest remains research-only with no execution authority", () => {
  const result = buildAdaptiveMultiEvidenceResearchIngestV2(input());
  assert.equal(result.researchOnly, true);
  assert.equal(result.literatureCanProveProfitability, false);
  assert.equal(result.youtubeCanProveProfitability, false);
  assert.equal(result.liveTrading, false);
  assert.equal(result.autoTrading, false);
  assert.equal(result.realOrderEnabled, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.executionAuthority, "NONE");

  const blocked = buildAdaptiveMultiEvidenceResearchIngestV2(input({ executionAuthority: "PAPER" }));
  assert.equal(blocked.status, "BLOCKED_DATA");
  assert.ok(blocked.blockers.includes("RESEARCH_INGEST_EXECUTION_AUTHORITY_FORBIDDEN"));
  assert.equal(blocked.executionAuthority, "NONE");
});

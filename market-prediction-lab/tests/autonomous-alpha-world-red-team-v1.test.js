import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAlphaGenomeV1,
  buildAutonomousAlphaEvidenceGraphV1,
} from "../src/autonomous-alpha-scientist-foundation-v1.js";
import {
  WORLD_KNOWLEDGE_INGEST_V1,
  buildWorldKnowledgeIngestV1,
  createWorldKnowledgeReceiptV1,
  verifyWorldKnowledgeIngestV1,
} from "../src/world-knowledge-ingest-v1.js";
import {
  ALPHA_RED_TEAM_V1,
  REQUIRED_ALPHA_RED_TEAM_SCENARIOS,
  buildAlphaRedTeamAttackPlanV1,
  evaluateAlphaRedTeamV1,
} from "../src/alpha-red-team-v1.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);

function knowledgeReceipt({
  sourceId,
  sourceType,
  publisher,
  url,
  independenceGroupId,
  evidenceDigest,
  accessMode = "PUBLIC_METADATA",
  fullTextStorageAllowed = false,
} = {}) {
  return createWorldKnowledgeReceiptV1({
    sourceType,
    sourceId,
    title: `Research source ${sourceId}`,
    canonicalUrl: url,
    publisher,
    publishedAt: "2025-01-01",
    retrievedAt: "2026-09-20T03:00:00.000Z",
    provenanceDigest: evidenceDigest,
    integrityState: "OK",
    rights: {
      accessMode,
      derivedFactsAllowed: true,
      derivedSummaryAllowed: true,
      fullTextStorageAllowed,
      redistributionAllowed: accessMode === "PUBLIC_DOMAIN",
      attributionRequired: accessMode !== "PUBLIC_DOMAIN",
      licenseOrTermsUrl: "https://example.org/terms",
    },
    claims: [{
      claimId: `claim-${sourceId}`,
      derivedSummary: "The source proposes a falsifiable market mechanism.",
      mechanism: "A measurable imbalance may precede a short-horizon price response.",
      markets: ["CRYPTO_FUTURES"],
      horizons: ["5m", "15m"],
      features: ["imbalance", "spread"],
      falsifiers: ["no OOS edge after costs", "effect disappears after delay"],
      independenceGroupId,
      evidenceDigest,
      locator: "derived-research-location",
    }],
  });
}

function evidenceGraphForGenome() {
  return buildAutonomousAlphaEvidenceGraphV1({
    sources: [
      {
        sourceId: "paper-a",
        sourceType: "ACADEMIC_PAPER",
        title: "Paper A",
        canonicalUrl: "https://example.org/a",
        retrievedAt: "2026-09-20T03:00:00.000Z",
        provenanceDigest: A,
        integrityState: "OK",
        contentPolicy: {
          mode: "METADATA_ONLY",
          fullTextStorageAllowed: false,
          derivedSummaryAllowed: true,
          redistributionAllowed: false,
          attributionRequired: true,
        },
      },
      {
        sourceId: "official-b",
        sourceType: "OFFICIAL",
        title: "Official B",
        canonicalUrl: "https://example.org/b",
        retrievedAt: "2026-09-20T03:00:00.000Z",
        provenanceDigest: B,
        integrityState: "OK",
        contentPolicy: {
          mode: "METADATA_ONLY",
          fullTextStorageAllowed: false,
          derivedSummaryAllowed: true,
          redistributionAllowed: false,
          attributionRequired: true,
        },
      },
    ],
    claims: [
      {
        claimId: "claim-a",
        sourceId: "paper-a",
        derivedSummary: "Order-flow imbalance is a candidate signal.",
        mechanism: "Aggressive flow consumes one side of visible liquidity.",
        markets: ["CRYPTO_FUTURES"],
        horizons: ["5m"],
        features: ["order_flow_imbalance"],
        falsifiers: ["no OOS edge"],
        independenceGroupId: "academic-a",
        evidenceDigest: C,
        locator: "results",
      },
      {
        claimId: "claim-b",
        sourceId: "official-b",
        derivedSummary: "Venue constraints define executable risk.",
        mechanism: "Tick, lot and margin rules constrain practical execution.",
        markets: ["CRYPTO_FUTURES"],
        horizons: ["all"],
        features: ["lot_size", "tick_size"],
        falsifiers: ["venue specification mismatch"],
        independenceGroupId: "official-b",
        evidenceDigest: D,
        locator: "spec",
      },
    ],
    edges: [{ fromClaimId: "claim-b", toClaimId: "claim-a", type: "SUPPORTS" }],
  });
}

function genome() {
  return buildAlphaGenomeV1({
    candidateId: "alpha-rt-001",
    hypothesis: "A cost-aware imbalance signal may survive adversarial validation.",
    evidenceGraph: evidenceGraphForGenome(),
    genes: [
      {
        geneId: "signal",
        type: "SIGNAL",
        claimIds: ["claim-a"],
        logic: { feature: "order_flow_imbalance", op: ">", parameter: "threshold" },
      },
      {
        geneId: "risk",
        type: "RISK",
        claimIds: ["claim-b"],
        logic: { maxRiskPct: 0.0025, lossAveragingAllowed: false },
      },
    ],
    trialAccounting: {
      priorEvaluatedCandidateCount: 10,
      declaredCandidateFamilySize: 64,
      candidateOrdinal: 11,
    },
  });
}

const redTeamPolicy = {
  minNetExpectancy: 0,
  minProfitFactor: 1,
  maxDrawdown: 0.2,
  minTradeCount: 30,
  maxCalibrationError: 0.2,
  minimumScenarioPassRatio: 0.9,
};

function redTeamReceipts(g, overrides = {}) {
  return REQUIRED_ALPHA_RED_TEAM_SCENARIOS.map((scenarioId) => ({
    scenarioId,
    candidateId: g.candidateId,
    genomeDigest: g.genomeDigest,
    evidenceId: `red-team:${scenarioId.toLowerCase()}`,
    netExpectancy: 0.002,
    profitFactor: 1.2,
    maximumDrawdown: 0.08,
    tradeCount: 80,
    calibrationError: 0.08,
    frozenParameters: true,
    fullCostApplied: true,
    pointInTimeSafe: true,
    finalHoldoutUsed: false,
    executionAuthority: "NONE",
    ...(overrides[scenarioId] ?? {}),
  }));
}

test("world knowledge ingest combines heterogeneous evidence without raw-content authority", () => {
  const receipts = [
    knowledgeReceipt({
      sourceId: "paper-1",
      sourceType: "ACADEMIC_PAPER",
      publisher: "Academic Publisher",
      url: "https://example.org/paper",
      independenceGroupId: "academic",
      evidenceDigest: A,
    }),
    knowledgeReceipt({
      sourceId: "broker-1",
      sourceType: "BROKER_RESEARCH",
      publisher: "Broker Research",
      url: "https://example.org/broker",
      independenceGroupId: "broker",
      evidenceDigest: B,
      accessMode: "TERMS_GOVERNED",
    }),
    knowledgeReceipt({
      sourceId: "book-1",
      sourceType: "PUBLIC_BOOK",
      publisher: "Public Domain Archive",
      url: "https://example.org/book",
      independenceGroupId: "book",
      evidenceDigest: C,
      accessMode: "PUBLIC_DOMAIN",
      fullTextStorageAllowed: true,
    }),
    knowledgeReceipt({
      sourceId: "video-1",
      sourceType: "VIDEO",
      publisher: "Video Channel",
      url: "https://www.youtube.com/watch?v=example",
      independenceGroupId: "video",
      evidenceDigest: D,
      accessMode: "TERMS_GOVERNED",
    }),
  ];

  const ingest = buildWorldKnowledgeIngestV1({
    receipts,
    edges: [
      { fromClaimId: "claim-broker-1", toClaimId: "claim-paper-1", type: "EXTENDS" },
      { fromClaimId: "claim-book-1", toClaimId: "claim-paper-1", type: "SUPPORTS" },
      { fromClaimId: "claim-video-1", toClaimId: "claim-paper-1", type: "CONTRADICTS" },
    ],
  });

  assert.equal(ingest.schemaVersion, WORLD_KNOWLEDGE_INGEST_V1);
  assert.equal(ingest.status, "WORLD_KNOWLEDGE_READY");
  assert.equal(ingest.sourceMix.ACADEMIC_PAPER, 1);
  assert.equal(ingest.sourceMix.BROKER_RESEARCH, 1);
  assert.equal(ingest.sourceMix.PUBLIC_BOOK, 1);
  assert.equal(ingest.sourceMix.VIDEO, 1);
  assert.equal(ingest.canonicalRawContentPersisted, false);
  assert.equal(ingest.networkFetchAuthority, false);
  assert.equal(ingest.executionAuthority, "NONE");
  assert.equal(ingest.profitabilityProven, false);
  assert.equal(verifyWorldKnowledgeIngestV1(ingest), true);
});

test("world knowledge receipt fails closed on raw text persistence", () => {
  const receipt = createWorldKnowledgeReceiptV1({
    sourceType: "BROKER_RESEARCH",
    sourceId: "broker-raw",
    title: "Broker report",
    canonicalUrl: "https://example.org/broker/raw",
    publisher: "Broker",
    retrievedAt: "2026-09-20T03:00:00.000Z",
    provenanceDigest: A,
    integrityState: "OK",
    rights: {
      accessMode: "TERMS_GOVERNED",
      derivedFactsAllowed: true,
      derivedSummaryAllowed: true,
      fullTextStorageAllowed: false,
      redistributionAllowed: false,
      attributionRequired: true,
      licenseOrTermsUrl: "https://example.org/terms",
    },
    rawContent: "forbidden canonical raw report content",
    claims: [{
      claimId: "claim-broker-raw",
      derivedSummary: "Derived fact only.",
      mechanism: "Test mechanism.",
      markets: ["US_STOCK"],
      horizons: ["1d"],
      features: ["revision"],
      falsifiers: ["no forward edge"],
      independenceGroupId: "broker",
      evidenceDigest: B,
    }],
  });

  assert.equal(receipt.status, "BLOCKED_DATA");
  assert.ok(receipt.blockers.includes("WORLD_CANONICAL_RAW_CONTENT_FORBIDDEN"));
  assert.equal(receipt.rawContentPersistenceAuthority, false);
});

test("world knowledge ingest never upgrades rejected evidence into a graph vote", () => {
  const good = knowledgeReceipt({
    sourceId: "official-1",
    sourceType: "OFFICIAL",
    publisher: "Exchange",
    url: "https://example.org/official",
    independenceGroupId: "official",
    evidenceDigest: A,
  });
  const bad = createWorldKnowledgeReceiptV1({
    sourceType: "VIDEO",
    sourceId: "video-bad",
    title: "Untrusted video",
    canonicalUrl: "https://example.org/video",
    publisher: "Channel",
    retrievedAt: "2026-09-20T03:00:00.000Z",
    provenanceDigest: B,
    integrityState: "RETRACTED",
    rights: {
      accessMode: "TERMS_GOVERNED",
      derivedFactsAllowed: true,
      derivedSummaryAllowed: true,
      fullTextStorageAllowed: false,
      redistributionAllowed: false,
      attributionRequired: true,
      licenseOrTermsUrl: "https://example.org/terms",
    },
    claims: [{
      claimId: "claim-video-bad",
      derivedSummary: "Bad claim.",
      mechanism: "Bad mechanism.",
      markets: ["CRYPTO_SPOT"],
      horizons: ["5m"],
      features: ["price"],
      falsifiers: ["fails"],
      independenceGroupId: "video",
      evidenceDigest: C,
    }],
  });

  const ingest = buildWorldKnowledgeIngestV1({ receipts: [good, bad] });
  assert.equal(ingest.status, "WORLD_KNOWLEDGE_PARTIAL");
  assert.deepEqual(ingest.acceptedSourceIds, ["official-1"]);
  assert.deepEqual(ingest.rejectedSourceIds, ["video-bad"]);
  assert.deepEqual(ingest.evidenceGraph.admissibleClaimIds, ["claim-official-1"]);
});

test("red team produces a frozen attack plan without trading authority", () => {
  const g = genome();
  const plan = buildAlphaRedTeamAttackPlanV1({ genome: g });

  assert.equal(plan.schemaVersion, ALPHA_RED_TEAM_V1);
  assert.equal(plan.status, "RED_TEAM_PLAN_READY");
  assert.equal(plan.attacks.length, REQUIRED_ALPHA_RED_TEAM_SCENARIOS.length);
  assert.equal(plan.frozenGenomeRequired, true);
  assert.equal(plan.retuningDuringRedTeamForbidden, true);
  assert.equal(plan.finalHoldoutAccessAllowed, false);
  assert.equal(plan.executionAuthority, "NONE");
});

test("red team survivor requires all critical cost execution and data robustness shocks", () => {
  const g = genome();
  const plan = buildAlphaRedTeamAttackPlanV1({ genome: g });
  const result = evaluateAlphaRedTeamV1({
    genome: g,
    attackPlan: plan,
    policy: redTeamPolicy,
    receipts: redTeamReceipts(g),
  });

  assert.equal(result.status, "RED_TEAM_SURVIVOR_RESEARCH_ONLY");
  assert.equal(result.passedCount, REQUIRED_ALPHA_RED_TEAM_SCENARIOS.length);
  assert.equal(result.passRatio, 1);
  assert.equal(result.mandatoryBaselinePass, true);
  assert.equal(result.allCostExecutionShocksPass, true);
  assert.equal(result.allDataRobustnessPass, true);
  assert.equal(result.nextStage, "MULTI_HORIZON_FORECAST_UNCERTAINTY");
  assert.equal(result.promotionEligible, false);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("red team rejects an apparently profitable candidate that breaks under slippage", () => {
  const g = genome();
  const plan = buildAlphaRedTeamAttackPlanV1({ genome: g });
  const result = evaluateAlphaRedTeamV1({
    genome: g,
    attackPlan: plan,
    policy: redTeamPolicy,
    receipts: redTeamReceipts(g, {
      SLIPPAGE_MULTIPLIER_3X: {
        netExpectancy: -0.004,
        profitFactor: 0.7,
      },
    }),
  });

  assert.equal(result.status, "RED_TEAM_REJECTED");
  assert.equal(result.allCostExecutionShocksPass, false);
  assert.equal(result.nextStage, null);
  const slip = result.scenarioResults.find((row) => row.scenarioId === "SLIPPAGE_MULTIPLIER_3X");
  assert.ok(slip.reasons.includes("RED_TEAM_EXPECTANCY_FAILED"));
  assert.ok(slip.reasons.includes("RED_TEAM_PROFIT_FACTOR_FAILED"));
});

test("red team blocks incomplete evidence instead of silently treating missing scenarios as passes", () => {
  const g = genome();
  const plan = buildAlphaRedTeamAttackPlanV1({ genome: g });
  const receipts = redTeamReceipts(g).filter((row) => row.scenarioId !== "PARTIAL_FILL");
  const result = evaluateAlphaRedTeamV1({
    genome: g,
    attackPlan: plan,
    policy: redTeamPolicy,
    receipts,
  });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("RED_TEAM_REQUIRED_SCENARIOS_MISSING"));
  assert.equal(result.nextStage, null);
});

test("red team refuses retuned or final-holdout-contaminated receipts", () => {
  const g = genome();
  const plan = buildAlphaRedTeamAttackPlanV1({ genome: g });
  const result = evaluateAlphaRedTeamV1({
    genome: g,
    attackPlan: plan,
    policy: redTeamPolicy,
    receipts: redTeamReceipts(g, {
      REGIME_FLIP: { frozenParameters: false },
      OUTLIER_SHOCK: { finalHoldoutUsed: true },
    }),
  });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("RED_TEAM_RECEIPT_CONTRACT_INVALID"));
  assert.equal(result.nextStage, null);
});

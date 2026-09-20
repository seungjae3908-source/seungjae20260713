import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTONOMOUS_ALPHA_CHAMPION_CHALLENGER_V1,
  buildChampionChallengerResearchPlanV1,
  buildSourceResearchReputationV1,
} from "../src/autonomous-alpha-champion-challenger-v1.js";
import { MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1 } from "../src/market-digital-twin-microstructure-v1.js";
import {
  buildWorldKnowledgeIngestV1,
  createWorldKnowledgeReceiptV1,
} from "../src/world-knowledge-ingest-v1.js";

function receipt(sourceId, sourceType, group, digestChar) {
  return createWorldKnowledgeReceiptV1({
    sourceType,
    sourceId,
    title: `Source ${sourceId}`,
    canonicalUrl: `https://example.org/${sourceId}`,
    publisher: "Publisher",
    retrievedAt: "2026-09-20T03:00:00.000Z",
    provenanceDigest: digestChar.repeat(64),
    integrityState: "OK",
    rights: {
      accessMode: "PUBLIC_METADATA",
      derivedFactsAllowed: true,
      derivedSummaryAllowed: true,
      fullTextStorageAllowed: false,
      redistributionAllowed: false,
      attributionRequired: true,
      licenseOrTermsUrl: "https://example.org/terms",
    },
    claims: [{
      claimId: `claim-${sourceId}`,
      derivedSummary: "A derived claim.",
      mechanism: "A falsifiable mechanism.",
      markets: ["US_STOCK"],
      horizons: ["1d"],
      features: ["feature"],
      falsifiers: ["no OOS effect"],
      independenceGroupId: group,
      evidenceDigest: digestChar.repeat(64),
    }],
  });
}

function world() {
  return buildWorldKnowledgeIngestV1({
    receipts: [
      receipt("academic", "ACADEMIC_PAPER", "g-academic", "a"),
      receipt("broker", "BROKER_RESEARCH", "g-broker", "b"),
      receipt("video", "VIDEO", "g-video", "c"),
    ],
  });
}

function digitalTwinResult(candidateId = "balanced") {
  return Object.freeze({
    schemaVersion: MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1,
    artifactType: "MARKET_DIGITAL_TWIN_RESULT",
    status: "MARKET_DIGITAL_TWIN_EVALUATED_RESEARCH_ONLY",
    candidateId,
    resultDigest: "d".repeat(64),
    executionAuthority: "NONE",
  });
}

function candidate(candidateId, metrics) {
  return {
    candidateId,
    metrics,
    evidenceDigests: {
      sealedOos: "a".repeat(64),
      redTeam: "b".repeat(64),
      digitalTwin: "d".repeat(64),
      strategyHealth: "c".repeat(64),
      fullCost: "e".repeat(64),
    },
    sealedOosPassed: true,
    redTeamPassed: true,
    digitalTwinEvaluated: true,
    strategyHealthOk: true,
    fullCostApplied: true,
    pointInTimeSafe: true,
    finalHoldoutReused: false,
    executionAuthority: "NONE",
  };
}

test("source reputation is research-priority only and cannot become trust or trading authority", () => {
  const ingest = world();
  const reputation = buildSourceResearchReputationV1({
    worldKnowledgeIngest: ingest,
    claimOutcomes: [
      {
        claimId: "claim-academic",
        oosPass: true,
        redTeamPass: true,
        forwardPass: true,
        failed: false,
        pointInTimeSafe: true,
        frozenCandidate: true,
        finalHoldoutUsed: false,
        executionAuthority: "NONE",
      },
      {
        claimId: "claim-broker",
        oosPass: true,
        redTeamPass: false,
        forwardPass: false,
        failed: true,
        pointInTimeSafe: true,
        frozenCandidate: true,
        finalHoldoutUsed: false,
        executionAuthority: "NONE",
      },
    ],
    prior: { alpha: 1, beta: 1 },
  });

  assert.equal(reputation.schemaVersion, AUTONOMOUS_ALPHA_CHAMPION_CHALLENGER_V1);
  assert.equal(reputation.status, "SOURCE_REPUTATION_READY_RESEARCH_ONLY");
  assert.equal(reputation.sources[0].researchQueuePriorityOnly, true);
  assert.equal(reputation.sources.every((row) => row.autoTrustAllowed === false), true);
  assert.equal(reputation.sourceReputationCanBypassEvidenceGate, false);
  assert.equal(reputation.sourceReputationCanChangePositionSize, false);
  assert.equal(reputation.executionAuthority, "NONE");
});

test("source reputation rejects duplicate claim outcomes instead of inflating research priority", () => {
  const row = {
    claimId: "claim-academic",
    oosPass: true,
    redTeamPass: true,
    forwardPass: true,
    failed: false,
    pointInTimeSafe: true,
    frozenCandidate: true,
    finalHoldoutUsed: false,
    executionAuthority: "NONE",
  };
  const reputation = buildSourceResearchReputationV1({
    worldKnowledgeIngest: world(),
    claimOutcomes: [row, { ...row }],
  });

  assert.equal(reputation.status, "BLOCKED_DATA");
  assert.ok(reputation.blockers.includes("SOURCE_REPUTATION_DUPLICATE_CLAIM_OUTCOME"));
});

test("source reputation rejects contaminated final-holdout outcomes", () => {
  const reputation = buildSourceResearchReputationV1({
    worldKnowledgeIngest: world(),
    claimOutcomes: [{
      claimId: "claim-academic",
      oosPass: true,
      redTeamPass: true,
      forwardPass: true,
      failed: false,
      pointInTimeSafe: true,
      frozenCandidate: true,
      finalHoldoutUsed: true,
      executionAuthority: "NONE",
    }],
  });

  assert.equal(reputation.status, "BLOCKED_DATA");
  assert.ok(reputation.blockers.includes("SOURCE_REPUTATION_OUTCOME_CONTRACT_INVALID"));
});

test("champion challenger plan uses Pareto comparison instead of a scalar score", () => {
  const candidates = [
    candidate("balanced", {
      costAdjustedExpectancy: 0.012,
      profitFactor: 1.4,
      maximumDrawdown: 0.08,
      walkForwardStability: 0.82,
      calibrationError: 0.07,
    }),
    candidate("dominated", {
      costAdjustedExpectancy: 0.008,
      profitFactor: 1.2,
      maximumDrawdown: 0.12,
      walkForwardStability: 0.70,
      calibrationError: 0.10,
    }),
    candidate("low-drawdown", {
      costAdjustedExpectancy: 0.010,
      profitFactor: 1.35,
      maximumDrawdown: 0.05,
      walkForwardStability: 0.79,
      calibrationError: 0.06,
    }),
  ];

  const result = buildChampionChallengerResearchPlanV1({
    digitalTwinResult: digitalTwinResult("balanced"),
    candidates,
    incumbentCandidateId: "balanced",
  });

  assert.equal(result.status, "CHAMPION_CHALLENGER_READY_FOR_NATURAL_PAPER");
  assert.equal(result.comparisonMethod, "PARETO_NO_SCALAR_SCORE");
  assert.equal(result.paretoChallengerIds.includes("dominated"), false);
  assert.equal(result.paretoChallengerIds.includes("balanced"), true);
  assert.equal(result.paretoChallengerIds.includes("low-drawdown"), true);
  assert.equal(result.incumbentReplacementDecision, "NOT_AUTHORIZED");
  assert.equal(result.championAuthority, false);
  assert.equal(result.automaticChampionReplacementAllowed, false);
  assert.equal(result.nextStage, "NATURAL_PAPER_PROFITABILITY_CERTIFICATION");
});

test("source reputation is explicitly excluded from candidate performance ranking", () => {
  const sourceReputation = buildSourceResearchReputationV1({
    worldKnowledgeIngest: world(),
    claimOutcomes: [],
  });
  const result = buildChampionChallengerResearchPlanV1({
    digitalTwinResult: digitalTwinResult("a"),
    candidates: [
      candidate("a", {
        costAdjustedExpectancy: 0.01,
        profitFactor: 1.3,
        maximumDrawdown: 0.08,
        walkForwardStability: 0.8,
        calibrationError: 0.08,
      }),
      candidate("b", {
        costAdjustedExpectancy: 0.011,
        profitFactor: 1.2,
        maximumDrawdown: 0.06,
        walkForwardStability: 0.75,
        calibrationError: 0.07,
      }),
    ],
    sourceReputation,
  });

  assert.equal(result.sourceReputationUsedInPerformanceRanking, false);
  assert.equal(result.sourceReputationDigest, sourceReputation.reputationDigest);
  assert.equal(result.executionAuthority, "NONE");
});

test("champion challenger rejects candidates missing any evidence firewall", () => {
  const broken = candidate("broken", {
    costAdjustedExpectancy: 0.02,
    profitFactor: 2,
    maximumDrawdown: 0.05,
    walkForwardStability: 0.9,
    calibrationError: 0.04,
  });
  broken.fullCostApplied = false;

  const result = buildChampionChallengerResearchPlanV1({
    digitalTwinResult: digitalTwinResult("broken"),
    candidates: [broken],
  });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("CHALLENGER_CANDIDATE_CONTRACT_INVALID"));
  assert.equal(result.nextStage, null);
});

test("failure-memory persistence remains delegated to the existing owner", () => {
  const result = buildChampionChallengerResearchPlanV1({
    digitalTwinResult: digitalTwinResult("a"),
    candidates: [
      candidate("a", {
        costAdjustedExpectancy: 0.01,
        profitFactor: 1.3,
        maximumDrawdown: 0.08,
        walkForwardStability: 0.8,
        calibrationError: 0.08,
      }),
    ],
  });

  assert.equal(result.failureMemoryPersistenceOwner, "EXISTING_RESEARCH_FAILURE_MEMORY_OWNER");
  assert.equal(result.duplicateFailureMemoryImplementationAllowed, false);
});

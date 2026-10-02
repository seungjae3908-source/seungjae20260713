import test from "node:test";
import assert from "node:assert/strict";

import { AUTONOMOUS_ALPHA_CHAMPION_CHALLENGER_V1 } from "../src/autonomous-alpha-champion-challenger-v1.js";
import {
  AUTONOMOUS_ALPHA_CERTIFICATION_V1,
  buildAutonomousAlphaArchitectureReadinessV1,
  buildAutonomousAlphaCertificationV1,
} from "../src/autonomous-alpha-certification-v1.js";
import { ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION } from "../src/adaptive-multi-evidence-natural-paper-v2.js";
import { UNIFIED_PROFITABILITY_PROMOTION_SCHEMA_VERSION } from "../src/unified-profitability-promotion-gate-v1.js";
import { PROFITABILITY_LIFECYCLE_CONTROL_SCHEMA_VERSION } from "../src/profitability-lifecycle-orchestrator.js";

const candidateId = "generated-formula-candidate:sha256:" + "a".repeat(64);

const championPlan = Object.freeze({
  schemaVersion: AUTONOMOUS_ALPHA_CHAMPION_CHALLENGER_V1,
  artifactType: "CHAMPION_CHALLENGER_RESEARCH_PLAN",
  status: "CHAMPION_CHALLENGER_READY_FOR_NATURAL_PAPER",
  planDigest: "b".repeat(64),
  candidates: [{
    candidateId,
    evidenceDigests: { redTeam: "3".repeat(64) },
  }],
  executionAuthority: "NONE",
});

const naturalPaperCandidate = Object.freeze({
  schemaVersion: ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION,
  status: "NATURAL_PAPER_CANDIDATE_READY_INACTIVE",
  candidate: { candidateId },
  handoffDigest: "c".repeat(64),
  scheduleActive: false,
  runtimeActivated: false,
  activationRequiresSeparateApproval: true,
  executionAuthority: "NONE",
});

const activationReceipt = Object.freeze({
  schemaVersion: "autonomous-alpha-natural-paper-activation-receipt-v1",
  candidateId,
  humanApprovalId: "approval-paper-only-001",
  runtimeSourceSha: "d".repeat(40),
  paperOnly: true,
  scheduleActive: true,
  naturalCronObserved: true,
  replay: false,
  backfill: false,
  synthetic: false,
  actualOrders: 0,
  privateAccountRequests: 0,
  liveTrading: false,
  autoTrading: false,
  executionAuthority: "NONE",
});

function settlementGate(overrides = {}) {
  return {
    schemaVersion: "settlement-profitability-evidence-gate-v1",
    settlementSetDigest: "e".repeat(64),
    sampleCountStatus: "READY",
    naturalEligibility: { status: "PRESENT" },
    fullCostEvidence: { status: "PRESENT" },
    pathEvidence: { status: "PRESENT" },
    regimeEvidence: { status: "PRESENT" },
    prerequisiteEvidenceComplete: true,
    p1_5Complete: true,
    profitabilityProven: true,
    profitabilityClaimAllowed: true,
    executionAuthority: "NONE",
    ...overrides,
  };
}

function unified(overrides = {}) {
  return {
    schemaVersion: UNIFIED_PROFITABILITY_PROMOTION_SCHEMA_VERSION,
    promotionEligible: true,
    status: "PROMOTION_REVIEW_READY",
    safety: {
      orderAuthority: false,
      liveTradingAllowed: false,
    },
    ...overrides,
  };
}

function lifecycle(overrides = {}) {
  return {
    schemaVersion: PROFITABILITY_LIFECYCLE_CONTROL_SCHEMA_VERSION,
    status: "LIFECYCLE_REVIEW_READY",
    safety: {
      orderAuthority: false,
      liveTradingAllowed: false,
      automaticPromotionAllowed: false,
    },
    ...overrides,
  };
}

test("certification stops before activation and asks for separate paper-only approval", () => {
  const result = buildAutonomousAlphaCertificationV1({
    championChallengerPlan: championPlan,
    naturalPaperCandidate,
  });

  assert.equal(result.schemaVersion, AUTONOMOUS_ALPHA_CERTIFICATION_V1);
  assert.equal(result.status, "READY_FOR_SEPARATE_NATURAL_PAPER_ACTIVATION_APPROVAL");
  assert.equal(result.activationPerformed, false);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.nextAction, "SEPARATE_HUMAN_APPROVAL_FOR_PAPER_ONLY_24_7_ACTIVATION");
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("activation receipt is paper-only and never authorizes real orders", () => {
  const badReceipt = { ...activationReceipt, actualOrders: 1 };
  const result = buildAutonomousAlphaCertificationV1({
    championChallengerPlan: championPlan,
    naturalPaperCandidate,
    activationReceipt: badReceipt,
  });

  assert.equal(result.status, "READY_FOR_SEPARATE_NATURAL_PAPER_ACTIVATION_APPROVAL");
  assert.equal(result.activationPerformed, false);
  assert.equal(result.realOrderAllowed, false);
});

test("canonical gates can make profitability review-ready but still cannot enable live trading", () => {
  const result = buildAutonomousAlphaCertificationV1({
    championChallengerPlan: championPlan,
    naturalPaperCandidate,
    activationReceipt,
    settlementProfitabilityGate: settlementGate(),
    unifiedProfitabilityPromotion: unified(),
    lifecycleControl: lifecycle(),
  });

  assert.equal(result.status, "PROFITABILITY_REVIEW_READY_NOT_LIVE");
  assert.equal(result.profitabilityProven, true);
  assert.equal(result.livePromotionEligible, false);
  assert.equal(result.finalHumanReviewRequired, true);
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.autoTradingAllowed, false);
  assert.equal(result.realOrderAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("missing canonical profitability proof remains research hold after paper activation", () => {
  const result = buildAutonomousAlphaCertificationV1({
    championChallengerPlan: championPlan,
    naturalPaperCandidate,
    activationReceipt,
    settlementProfitabilityGate: settlementGate({
      p1_5Complete: false,
      profitabilityProven: false,
      profitabilityClaimAllowed: false,
    }),
    unifiedProfitabilityPromotion: unified({
      promotionEligible: false,
      status: "RESEARCH_HOLD",
    }),
    lifecycleControl: lifecycle({ status: "RESEARCH_HOLD" }),
  });

  assert.equal(result.status, "RESEARCH_HOLD_COLLECT_GENUINE_FORWARD_EVIDENCE");
  assert.equal(result.profitabilityProven, false);
  assert.ok(result.holdReasons.includes("CERT_CANONICAL_PROFITABILITY_NOT_PROVEN"));
  assert.ok(result.holdReasons.includes("CERT_SETTLEMENT_PROFITABILITY_POLICY_NOT_COMPLETE"));
  assert.equal(result.nextAction, "CONTINUE_GENUINE_NATURAL_PAPER_SETTLEMENT_COLLECTION");
});

test("architecture readiness distinguishes completed code path from profitability proof", () => {
  const certification = buildAutonomousAlphaCertificationV1({
    championChallengerPlan: championPlan,
    naturalPaperCandidate,
  });

  const graphDigest = "1".repeat(64);
  const genomeDigest = "2".repeat(64);
  const redTeamDigest = "3".repeat(64);
  const forecastDigest = "4".repeat(64);
  const counterfactualDigest = "5".repeat(64);
  const digitalTwinDigest = "6".repeat(64);
  const readiness = buildAutonomousAlphaArchitectureReadinessV1({
    worldKnowledge: {
      status: "WORLD_KNOWLEDGE_READY",
      executionAuthority: "NONE",
      evidenceGraph: { graphDigest },
    },
    alphaGenome: {
      status: "ALPHA_GENOME_READY_FOR_FALSIFICATION",
      candidateId,
      evidenceGraphDigest: graphDigest,
      genomeDigest,
      executionAuthority: "NONE",
    },
    redTeam: {
      status: "RED_TEAM_SURVIVOR_RESEARCH_ONLY",
      candidateId,
      genomeDigest,
      resultDigest: redTeamDigest,
      executionAuthority: "NONE",
    },
    forecast: {
      status: "FORECAST_READY_RESEARCH_ONLY",
      candidateId,
      redTeamResultDigest: redTeamDigest,
      forecastDigest,
      executionAuthority: "NONE",
    },
    counterfactual: {
      status: "COUNTERFACTUAL_TWIN_EVALUATED_RESEARCH_ONLY",
      candidateId,
      forecastDigest,
      resultDigest: counterfactualDigest,
      executionAuthority: "NONE",
    },
    digitalTwin: {
      status: "MARKET_DIGITAL_TWIN_EVALUATED_RESEARCH_ONLY",
      candidateId,
      counterfactualResultDigest: counterfactualDigest,
      resultDigest: digitalTwinDigest,
      executionAuthority: "NONE",
    },
    championChallenger: {
      ...championPlan,
      digitalTwinResultDigest: digitalTwinDigest,
    },
    certification,
  });

  assert.equal(readiness.status, "ARCHITECTURE_READY_EVIDENCE_PENDING_INACTIVE");
  assert.equal(readiness.architectureReady, true);
  assert.equal(readiness.profitabilityProven, false);
  assert.equal(readiness.lineageChecks.every((row) => row.passed), true);
  assert.equal(readiness.finalHumanStop, "NO_LIVE_REVIEW_UNTIL_PROFITABILITY_EVIDENCE_PROVEN");
});

test("architecture readiness never treats a missing stage as complete", () => {
  const readiness = buildAutonomousAlphaArchitectureReadinessV1({
    worldKnowledge: { status: "WORLD_KNOWLEDGE_READY", executionAuthority: "NONE" },
  });

  assert.equal(readiness.status, "ARCHITECTURE_BLOCKED");
  assert.equal(readiness.architectureReady, false);
  assert.ok(readiness.blockers.length > 0);
  assert.equal(readiness.liveTradingAllowed, false);
});

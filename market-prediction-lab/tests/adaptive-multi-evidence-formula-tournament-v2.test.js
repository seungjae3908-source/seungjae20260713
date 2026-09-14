import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_MULTI_EVIDENCE_FORMULA_TOURNAMENT_V2_VERSION,
  buildAdaptiveMultiEvidenceFormulaTournamentV2,
  createAdaptiveMultiEvidenceFormulaCandidateIdentityV2,
} from "../src/adaptive-multi-evidence-formula-tournament-v2.js";

const CANDIDATE_ID = "formula-candidate-1";

function router(overrides = {}) {
  return {
    schemaVersion: "adaptive-multi-evidence-regime-router-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "READY_FOR_STRATEGY_ROUTING_RESEARCH_ONLY",
    regime: "TREND_UP",
    routing: { allowedStrategyFamilies: ["TREND_FOLLOWING"] },
    executionAuthority: "NONE",
    ...overrides,
  };
}

function independence(overrides = {}) {
  return {
    schemaVersion: "adaptive-multi-evidence-independence-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "GROUPED_FOR_RESEARCH_ONLY",
    independenceGroupCount: 3,
    executionAuthority: "NONE",
    ...overrides,
  };
}

function ownerResult(overrides = {}) {
  return {
    contract: "evidence-backed-formula-tournament-adapter/v1",
    status: "COMPLETED",
    formulaCandidateIds: [CANDIDATE_ID],
    globalPlannedCandidateFamilySize: 8,
    tournament: {
      tournamentId: "tournament-1",
      status: "COMPLETED",
      candidates: Array.from({ length: 8 }, (_, index) => ({ generatedCandidateId: `trial-${index}` })),
      researchSurvivorCount: 2,
      profitable: false,
      champion: null,
    },
    safety: {
      profitabilityClaimAllowed: false,
      championPromotionAllowed: false,
      finalHoldoutPreAccessAllowed: false,
      executionAuthority: "NONE",
    },
    ...overrides,
  };
}

function identity(overrides = {}) {
  return createAdaptiveMultiEvidenceFormulaCandidateIdentityV2({
    formulaCandidateId: CANDIDATE_ID,
    strategyId: "strategy:trend-1",
    strategyFamily: "TREND_FOLLOWING",
    strategyVersion: "2.0.0",
    parameterDigest: "a".repeat(64),
    parameterHash: "b".repeat(64),
    market: "US_STOCK",
    timeframe: "1h",
    side: "BUY",
    researchCodeSha: "c".repeat(40),
    costPolicyVersion: "COST_V2",
    ...overrides,
  });
}

test("canonical owner tournament binds immutable strategy identities and trial count", () => {
  const result = buildAdaptiveMultiEvidenceFormulaTournamentV2({
    regimeRouter: router(),
    independence: independence(),
    tournamentResult: ownerResult(),
    candidateIdentities: [identity()],
    maxTrialBudget: 32,
  });
  assert.equal(result.schemaVersion, ADAPTIVE_MULTI_EVIDENCE_FORMULA_TOURNAMENT_V2_VERSION);
  assert.equal(result.status, "READY_FOR_VALIDATION_PIPELINE");
  assert.equal(result.candidateIdentities[0].immutable, true);
  assert.equal(result.totalTrialCount, 8);
  assert.equal(result.globalCandidateFamilySize, 8);
  assert.equal(result.tournamentOwnerContract, "evidence-backed-formula-tournament-adapter/v1");
});

test("multiple-testing risk stays visible before the statistical firewall", () => {
  const result = buildAdaptiveMultiEvidenceFormulaTournamentV2({
    regimeRouter: router(),
    independence: independence(),
    tournamentResult: ownerResult(),
    candidateIdentities: [identity()],
    maxTrialBudget: 32,
  });
  assert.equal(result.multipleTesting.correctionRequired, true);
  assert.equal(result.multipleTesting.riskVisible, true);
  assert.equal(result.multipleTesting.finalHoldoutAccess, false);
  assert.equal(result.multipleTestingRisk, "REQUIRES_STATISTICAL_FIREWALL");
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.promotionEligible, false);
});

test("owner candidate ids must exactly match immutable identity manifests", () => {
  const result = buildAdaptiveMultiEvidenceFormulaTournamentV2({
    regimeRouter: router(),
    independence: independence(),
    tournamentResult: ownerResult(),
    candidateIdentities: [identity({ formulaCandidateId: "different" })],
    maxTrialBudget: 32,
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("V2_FORMULA_OWNER_IDENTITY_BINDING_MISMATCH"));
});

test("unbounded parameter search and premature owner promotion fail closed", () => {
  const exceeded = buildAdaptiveMultiEvidenceFormulaTournamentV2({
    regimeRouter: router(),
    independence: independence(),
    tournamentResult: ownerResult(),
    candidateIdentities: [identity()],
    maxTrialBudget: 4,
  });
  assert.ok(exceeded.blockers.includes("V2_FORMULA_TRIAL_BUDGET_EXCEEDED"));

  const promoted = buildAdaptiveMultiEvidenceFormulaTournamentV2({
    regimeRouter: router(),
    independence: independence(),
    tournamentResult: ownerResult({ tournament: { ...ownerResult().tournament, profitable: true } }),
    candidateIdentities: [identity()],
    maxTrialBudget: 32,
  });
  assert.ok(promoted.blockers.includes("FORMULA_TOURNAMENT_OWNER_RESULT_INVALID"));
});

test("Frozen V1 lineage and execution authority are rejected", () => {
  const result = buildAdaptiveMultiEvidenceFormulaTournamentV2({
    regimeRouter: router({ lineageId: "FROZEN_CHALLENGER_V1" }),
    independence: independence(),
    tournamentResult: ownerResult(),
    candidateIdentities: [identity()],
    maxTrialBudget: 32,
    executionAuthority: "PAPER",
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("V2_FORMULA_REGIME_ROUTER_INVALID"));
  assert.ok(result.blockers.includes("V2_FORMULA_EXECUTION_AUTHORITY_FORBIDDEN"));
  assert.equal(result.liveTrading, false);
  assert.equal(result.autoTrading, false);
  assert.equal(result.realOrderEnabled, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
});

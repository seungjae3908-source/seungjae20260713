import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_MULTI_EVIDENCE_FORMULA_TOURNAMENT_V2_VERSION,
  buildAdaptiveMultiEvidenceFormulaTournamentV2,
  createAdaptiveMultiEvidenceFormulaCandidateIdentityV2,
} from "../src/adaptive-multi-evidence-formula-tournament-v2.js";
import { sha256Canonical } from "../src/research-cache-provenance.js";

const CANDIDATE_ID = "formula-candidate-1";

function router(overrides = {}) {
  const base = {
    schemaVersion: "adaptive-multi-evidence-regime-router-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "READY_FOR_STRATEGY_ROUTING_RESEARCH_ONLY",
    sourceContentDigest: "c".repeat(64),
    regime: "TREND_UP",
    regimeDigest: "d".repeat(64),
    routing: {
      allowedStrategyFamilies: ["TREND_FOLLOWING"],
      priceActionAction: "CONTEXT_RECORDED_NO_AUTOMATIC_ROUTE_OVERRIDE",
    },
    priceActionContext: {
      status: "AVAILABLE",
      authority: "CONTEXT_ONLY_NO_INDEPENDENT_VOTE",
      structureTransition: "BOS_UP",
    },
    priceActionAuthority: "CONTEXT_ONLY_NO_INDEPENDENT_VOTE",
    executionAuthority: "NONE",
  };
  const merged = { ...base, ...overrides };
  if (!Object.prototype.hasOwnProperty.call(overrides, "priceActionContextDigest")) {
    merged.priceActionContextDigest = sha256Canonical({
      sourceContentDigest: merged.sourceContentDigest,
      priceAction: merged.priceActionContext,
    });
  }
  return merged;
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


test("regime and price-action context are retained only as non-ranking tournament provenance", () => {
  const base = buildAdaptiveMultiEvidenceFormulaTournamentV2({
    regimeRouter: router(),
    independence: independence(),
    tournamentResult: ownerResult(),
    candidateIdentities: [identity()],
    maxTrialBudget: 32,
  });
  assert.equal(base.status, "READY_FOR_VALIDATION_PIPELINE");
  assert.equal(base.researchContext.regime, "TREND_UP");
  assert.equal(base.researchContext.regimeDigest, "d".repeat(64));
  assert.equal(base.researchContext.priceActionStatus, "AVAILABLE");
  assert.equal(base.researchContext.priceActionContextDigest, router().priceActionContextDigest);
  assert.equal(base.researchContext.priceActionAuthority, "CONTEXT_ONLY_NO_INDEPENDENT_VOTE");
  assert.equal(base.researchContext.affectsTrialRanking, false);
  assert.equal(base.researchContext.affectsChampionSelection, false);
  assert.equal(base.researchContext.countedAsIndependentVote, false);
  assert.equal(base.researchContext.economicSampleCredit, 0);
  assert.match(base.researchContextDigest, /^[a-f0-9]{64}$/u);

  const changedContext = buildAdaptiveMultiEvidenceFormulaTournamentV2({
    regimeRouter: router({
      priceActionContext: {
        ...router().priceActionContext,
        structureTransition: "CHOCH_DOWN",
      },
    }),
    independence: independence(),
    tournamentResult: ownerResult(),
    candidateIdentities: [identity()],
    maxTrialBudget: 32,
  });
  assert.equal(changedContext.totalTrialCount, base.totalTrialCount);
  assert.deepEqual(changedContext.candidateIdentities, base.candidateIdentities);
  assert.equal(changedContext.researchSurvivorCount, base.researchSurvivorCount);
  assert.equal(changedContext.ownerChampion, null);
  assert.notEqual(changedContext.researchContextDigest, base.researchContextDigest);
});

test("Formula Tournament rejects price-action provenance that tries to become independent authority", () => {
  const result = buildAdaptiveMultiEvidenceFormulaTournamentV2({
    regimeRouter: router({ priceActionAuthority: "INDEPENDENT_VOTE" }),
    independence: independence(),
    tournamentResult: ownerResult(),
    candidateIdentities: [identity()],
    maxTrialBudget: 32,
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("V2_FORMULA_PRICE_ACTION_CONTEXT_PROVENANCE_INVALID"));
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.executionAuthority, "NONE");
});

test("Formula Tournament rejects a forged price-action digest even when it is SHA-shaped", () => {
  const result = buildAdaptiveMultiEvidenceFormulaTournamentV2({
    regimeRouter: router({ priceActionContextDigest: "f".repeat(64) }),
    independence: independence(),
    tournamentResult: ownerResult(),
    candidateIdentities: [identity()],
    maxTrialBudget: 32,
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("V2_FORMULA_PRICE_ACTION_CONTEXT_PROVENANCE_INVALID"));
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.executionAuthority, "NONE");
});

test("missing price-action context remains non-authoritative and does not leak an inner digest downstream", () => {
  const result = buildAdaptiveMultiEvidenceFormulaTournamentV2({
    regimeRouter: router({
      priceActionContext: { status: "MISSING", authority: "NONE" },
      priceActionAuthority: "NONE",
    }),
    independence: independence(),
    tournamentResult: ownerResult(),
    candidateIdentities: [identity()],
    maxTrialBudget: 32,
  });
  assert.equal(result.status, "READY_FOR_VALIDATION_PIPELINE");
  assert.equal(result.researchContext.priceActionStatus, "MISSING");
  assert.equal(result.researchContext.priceActionContextDigest, null);
  assert.equal(result.researchContext.priceActionAuthority, "NONE");
  assert.equal(result.researchContext.economicSampleCredit, 0);
});

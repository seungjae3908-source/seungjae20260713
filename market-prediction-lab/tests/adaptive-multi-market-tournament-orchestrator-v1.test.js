import assert from "node:assert/strict";
import test from "node:test";

import {
  ADAPTIVE_MULTI_MARKET_PROFILES_V1,
  ADAPTIVE_TOURNAMENT_STAGES_V1,
  allocateAdaptiveTournamentBudgetV1,
  assessAdaptiveProfileReadinessV1,
  buildAdaptiveMultiMarketTournamentPlanV1,
  buildAdaptiveParetoFrontierV1,
  canonicalSerializeAdaptiveTournamentV1,
  planAdaptiveSuccessiveHalvingV1,
  verifyAdaptiveMultiMarketTournamentPlanV1,
} from "../src/adaptive-multi-market-tournament-orchestrator-v1.js";

const SOURCE_SHA = "a".repeat(40);
const CREATED_AT = "2026-09-02T00:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function present(requirement, suffix = "v1") {
  return {
    status: "PRESENT",
    evidenceId: `evidence:${requirement}:${suffix}`,
    observedAt: CREATED_AT,
  };
}

function completeEvidence(profile, suffix = "v1") {
  return Object.fromEntries(profile.requiredEvidence.map((requirement) => [requirement, present(requirement, suffix)]));
}

function basePolicy(overrides = {}) {
  const stageMaximums = [32, 32, 24, 20, 12, 8, 6, 4, 3, 2, 2, 1, 1];
  const stageRatios = [1, 1, 0.75, 0.625, 0.375, 0.25, 0.1875, 0.125, 0.09375, 0.0625, 0.0625, 0.03125, 0.03125];
  return {
    policyId: "human-approved-policy-v1",
    totalCandidateBudget: 64,
    minimumCandidatesPerReadyProfile: 16,
    maximumCandidatesPerReadyProfile: 32,
    diagnosticWeights: {
      dataCompleteness: 0.3,
      signalCoverage: 0.2,
      costCoverage: 0.2,
      familyDiversity: 0.2,
      computeCapacity: 0.1,
    },
    stagePolicy: ADAPTIVE_TOURNAMENT_STAGES_V1.map((stage, index) => ({
      stage,
      retentionRatio: stageRatios[index],
      maximumPerProfile: stageMaximums[index],
    })),
    maximumParetoSurvivorsPerSpecialist: 2,
    ...overrides,
  };
}

function diagnostic(seed = 1) {
  const offset = seed * 0.01;
  return {
    sourceRole: "DEVELOPMENT_ONLY",
    evidenceId: `development-diagnostic:${seed}`,
    dataCompleteness: Math.min(1, 0.8 + offset),
    signalCoverage: Math.min(1, 0.7 + offset),
    costCoverage: Math.min(1, 0.75 + offset),
    familyDiversity: Math.min(1, 0.65 + offset),
    computeCapacity: Math.min(1, 0.9 + offset),
  };
}

function twoReadyProfiles() {
  const profiles = [
    ADAPTIVE_MULTI_MARKET_PROFILES_V1.find((row) => row.profileId === "CRYPTO_SPOT:SHORT"),
    ADAPTIVE_MULTI_MARKET_PROFILES_V1.find((row) => row.profileId === "US_STOCK:SWING"),
  ];
  const evidenceCatalog = Object.fromEntries(profiles.map((profile, index) => [
    profile.profileId,
    completeEvidence(profile, `ready-${index}`),
  ]));
  const developmentDiagnostics = Object.fromEntries(profiles.map((profile, index) => [
    profile.profileId,
    diagnostic(index + 1),
  ]));
  return { profiles, evidenceCatalog, developmentDiagnostics };
}

function metrics(overrides = {}) {
  return {
    netExpectancy: 1,
    profitFactor: 1.5,
    independentN: 100,
    walkForwardConsistency: 0.75,
    regimeCoverage: 0.8,
    maximumDrawdown: 0.1,
    costSensitivity: 0.2,
    turnover: 1,
    parameterInstability: 0.1,
    concentration: 0.2,
    ...overrides,
  };
}

function paretoCandidate({
  candidateId,
  profileId = "CRYPTO_SPOT:SHORT",
  direction = "BUY",
  strategyHash = HASH_A,
  parameterIdentity = HASH_B,
  hardGateStatus = "PASS",
  statisticalFirewallStatus = "PASS",
  candidateMetrics = metrics(),
}) {
  return {
    candidateId,
    profileId,
    direction,
    strategyHash,
    parameterIdentity,
    hardGateStatus,
    statisticalFirewallStatus,
    metrics: candidateMetrics,
  };
}

test("defines exactly four markets by three horizons without collapsing specialist identities", () => {
  assert.equal(ADAPTIVE_MULTI_MARKET_PROFILES_V1.length, 12);
  assert.deepEqual(
    [...new Set(ADAPTIVE_MULTI_MARKET_PROFILES_V1.map((row) => row.market))].sort(),
    ["CRYPTO_FUTURES", "CRYPTO_SPOT", "KR_STOCK", "US_STOCK"],
  );
  assert.deepEqual(
    [...new Set(ADAPTIVE_MULTI_MARKET_PROFILES_V1.map((row) => row.horizon))].sort(),
    ["POSITION", "SHORT", "SWING"],
  );
  const futures = ADAPTIVE_MULTI_MARKET_PROFILES_V1.filter((row) => row.market === "CRYPTO_FUTURES");
  assert.ok(futures.every((row) => JSON.stringify(row.directions) === JSON.stringify(["LONG", "SHORT"])));
  const cash = ADAPTIVE_MULTI_MARKET_PROFILES_V1.filter((row) => row.market !== "CRYPTO_FUTURES");
  assert.ok(cash.every((row) => JSON.stringify(row.directions) === JSON.stringify(["BUY"])));
});

test("fails closed when stock point-in-time, delisted, or corporate-action evidence is absent", () => {
  const profile = ADAPTIVE_MULTI_MARKET_PROFILES_V1.find((row) => row.profileId === "KR_STOCK:SHORT");
  const partial = completeEvidence(profile);
  delete partial.POINT_IN_TIME_UNIVERSE;
  delete partial.DELISTED_UNIVERSE_INCLUDED;
  delete partial.CORPORATE_ACTIONS;
  const result = assessAdaptiveProfileReadinessV1({ evidenceCatalog: { [profile.profileId]: partial } });
  const row = result.profiles.find((candidate) => candidate.profileId === profile.profileId);
  assert.equal(row.status, "BLOCKED_MISSING_EVIDENCE");
  assert.deepEqual(row.missingRequirements, [
    "POINT_IN_TIME_UNIVERSE",
    "DELISTED_UNIVERSE_INCLUDED",
    "CORPORATE_ACTIONS",
  ]);
  assert.equal(row.candidateBudgetEligible, false);
  assert.equal(row.missingEvidenceNumericSubstitutionAllowed, false);
});

test("blocks futures unless mark, index, funding, open-interest, basis, and liquidation-risk evidence is present", () => {
  const profile = ADAPTIVE_MULTI_MARKET_PROFILES_V1.find((row) => row.profileId === "CRYPTO_FUTURES:SWING");
  const partial = completeEvidence(profile);
  for (const requirement of ["MARK_PRICE", "INDEX_PRICE", "FUNDING", "OPEN_INTEREST", "BASIS", "LIQUIDATION_RISK"]) {
    delete partial[requirement];
  }
  const result = assessAdaptiveProfileReadinessV1({ evidenceCatalog: { [profile.profileId]: partial } });
  const row = result.profiles.find((candidate) => candidate.profileId === profile.profileId);
  assert.equal(row.status, "BLOCKED_MISSING_EVIDENCE");
  assert.deepEqual(row.missingRequirements, [
    "MARK_PRICE",
    "INDEX_PRICE",
    "FUNDING",
    "OPEN_INTEREST",
    "BASIS",
    "LIQUIDATION_RISK",
  ]);
});

test("requires missing evidence to preserve null rather than fabricating zero", () => {
  const profile = ADAPTIVE_MULTI_MARKET_PROFILES_V1.find((row) => row.profileId === "CRYPTO_SPOT:POSITION");
  const invalid = completeEvidence(profile);
  invalid.LISTING_HISTORY = { status: "MISSING", evidenceId: "fake-zero", observedAt: CREATED_AT };
  assert.throws(
    () => assessAdaptiveProfileReadinessV1({ evidenceCatalog: { [profile.profileId]: invalid } }),
    (error) => error.code === "MISSING_EVIDENCE_MUST_PRESERVE_NULL",
  );
});

test("allocates budget only to ready profiles using development-only diagnostics", () => {
  const { profiles, evidenceCatalog, developmentDiagnostics } = twoReadyProfiles();
  const readiness = assessAdaptiveProfileReadinessV1({ evidenceCatalog });
  const allocation = allocateAdaptiveTournamentBudgetV1({
    readiness,
    developmentDiagnostics,
    policy: basePolicy(),
  });
  assert.equal(allocation.status, "ALLOCATED");
  assert.equal(allocation.initialCandidateFamilySize, 64);
  assert.equal(allocation.allocations.reduce((sum, row) => sum + row.allocatedCandidates, 0), 64);
  for (const profile of profiles) {
    assert.ok(allocation.allocations.find((row) => row.profileId === profile.profileId).allocatedCandidates >= 16);
  }
  assert.ok(allocation.allocations
    .filter((row) => !profiles.some((profile) => profile.profileId === row.profileId))
    .every((row) => row.allocatedCandidates === 0 && row.status === "BLOCKED_MISSING_EVIDENCE"));
  assert.equal(allocation.oosFeedbackConsumed, false);
  assert.equal(allocation.forwardFeedbackConsumed, false);
  assert.equal(allocation.paperFeedbackConsumed, false);
});

test("rejects OOS, Forward, Paper, profit, and holdout feedback in adaptive allocation", () => {
  const { evidenceCatalog, developmentDiagnostics } = twoReadyProfiles();
  const readiness = assessAdaptiveProfileReadinessV1({ evidenceCatalog });
  const profileId = Object.keys(developmentDiagnostics)[0];
  developmentDiagnostics[profileId] = { ...developmentDiagnostics[profileId], oosReturn: 0.4 };
  assert.throws(
    () => allocateAdaptiveTournamentBudgetV1({ readiness, developmentDiagnostics, policy: basePolicy() }),
    (error) => error.code === "HINDSIGHT_FEEDBACK_FORBIDDEN",
  );
});

test("does not invent numeric candidate or halving policy", () => {
  const { evidenceCatalog, developmentDiagnostics } = twoReadyProfiles();
  const readiness = assessAdaptiveProfileReadinessV1({ evidenceCatalog });
  assert.throws(
    () => allocateAdaptiveTournamentBudgetV1({ readiness, developmentDiagnostics }),
    (error) => error.code === "ADAPTIVE_POLICY_SHAPE_INVALID",
  );
});

test("requires explicit diagnostic weights to sum to one", () => {
  const { evidenceCatalog, developmentDiagnostics } = twoReadyProfiles();
  const readiness = assessAdaptiveProfileReadinessV1({ evidenceCatalog });
  const policy = basePolicy({
    diagnosticWeights: {
      dataCompleteness: 0.3,
      signalCoverage: 0.3,
      costCoverage: 0.3,
      familyDiversity: 0.3,
      computeCapacity: 0.3,
    },
  });
  assert.throws(
    () => allocateAdaptiveTournamentBudgetV1({ readiness, developmentDiagnostics, policy }),
    (error) => error.code === "DIAGNOSTIC_WEIGHTS_MUST_SUM_TO_ONE",
  );
});

test("successive-halving caps never increase and preserve initial family size for multiple-testing", () => {
  const { evidenceCatalog, developmentDiagnostics } = twoReadyProfiles();
  const readiness = assessAdaptiveProfileReadinessV1({ evidenceCatalog });
  const allocation = allocateAdaptiveTournamentBudgetV1({ readiness, developmentDiagnostics, policy: basePolicy() });
  const plan = planAdaptiveSuccessiveHalvingV1({ allocation });
  assert.equal(plan.initialCandidateFamilySize, 64);
  assert.equal(plan.candidateFamilySizeMayBeUnderstated, false);
  for (const profile of plan.stagePlans) {
    for (let index = 1; index < profile.stages.length; index += 1) {
      assert.ok(profile.stages[index].candidateCap <= profile.stages[index - 1].candidateCap);
    }
    assert.ok(profile.stages.every((stage) => stage.globalInitialCandidateFamilySize === 64));
    assert.equal(profile.stages.find((stage) => stage.stage === "BLIND_OOS").selectionFeedbackAllowed, false);
    assert.equal(profile.stages.find((stage) => stage.stage === "FORWARD_CANDIDATE").candidateCap <= 1, true);
  }
  assert.equal(plan.finalHoldoutUsedForSelection, false);
  assert.equal(plan.blindOosFeedbackToGeneratorAllowed, false);
  assert.equal(plan.forwardFeedbackToGeneratorAllowed, false);
  assert.equal(plan.paperFeedbackToGeneratorAllowed, false);
});

test("rejects halving policies whose retention or absolute caps increase later", () => {
  const policy = basePolicy();
  const stagePolicy = policy.stagePolicy.map((row) => ({ ...row }));
  stagePolicy[5].maximumPerProfile = stagePolicy[4].maximumPerProfile + 1;
  const invalid = { ...policy, stagePolicy };
  const { evidenceCatalog, developmentDiagnostics } = twoReadyProfiles();
  const readiness = assessAdaptiveProfileReadinessV1({ evidenceCatalog });
  assert.throws(
    () => allocateAdaptiveTournamentBudgetV1({ readiness, developmentDiagnostics, policy: invalid }),
    (error) => error.code === "STAGE_MAXIMUM_MUST_NOT_INCREASE",
  );
});

test("returns NO_READY_PROFILES and consumes no candidate budget when evidence is absent", () => {
  const readiness = assessAdaptiveProfileReadinessV1({ evidenceCatalog: {} });
  const allocation = allocateAdaptiveTournamentBudgetV1({ readiness, developmentDiagnostics: {}, policy: basePolicy() });
  assert.equal(allocation.status, "NO_READY_PROFILES");
  assert.equal(allocation.initialCandidateFamilySize, 0);
  assert.equal(allocation.unallocatedCandidates, 64);
  assert.ok(allocation.allocations.every((row) => row.allocatedCandidates === 0));
});

test("Pareto frontier removes a candidate dominated across every objective", () => {
  const strong = paretoCandidate({
    candidateId: "strong",
    candidateMetrics: metrics({
      netExpectancy: 2,
      profitFactor: 2,
      independentN: 150,
      walkForwardConsistency: 0.9,
      regimeCoverage: 0.9,
      maximumDrawdown: 0.05,
      costSensitivity: 0.1,
      turnover: 0.8,
      parameterInstability: 0.05,
      concentration: 0.1,
    }),
  });
  const weak = paretoCandidate({
    candidateId: "weak",
    strategyHash: HASH_C,
    parameterIdentity: HASH_D,
    candidateMetrics: metrics(),
  });
  const result = buildAdaptiveParetoFrontierV1({ candidates: [weak, strong], policy: basePolicy() });
  const specialist = result.specialists[0];
  assert.equal(specialist.status, "PARETO_FRONTIER_READY_FOR_REVIEW");
  assert.deepEqual(specialist.frontier.map((row) => row.candidateId), ["strong"]);
  assert.deepEqual(specialist.dominatedCandidateIds, ["weak"]);
  assert.equal(result.currentValidatedChampion, "NONE");
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.promotionAllowed, false);
});

test("keeps non-dominated trade-offs and requires explicit tie-break policy above the cap", () => {
  const rows = [
    paretoCandidate({
      candidateId: "high-edge",
      candidateMetrics: metrics({ netExpectancy: 3, profitFactor: 2, maximumDrawdown: 0.2 }),
    }),
    paretoCandidate({
      candidateId: "low-drawdown",
      strategyHash: HASH_C,
      parameterIdentity: HASH_D,
      candidateMetrics: metrics({ netExpectancy: 0.8, profitFactor: 1.3, maximumDrawdown: 0.02 }),
    }),
    paretoCandidate({
      candidateId: "high-independence",
      strategyHash: "e".repeat(64),
      parameterIdentity: "f".repeat(64),
      candidateMetrics: metrics({ independentN: 500, concentration: 0.05, turnover: 2 }),
    }),
  ];
  const result = buildAdaptiveParetoFrontierV1({ candidates: rows, policy: basePolicy() });
  const specialist = result.specialists[0];
  assert.equal(specialist.frontier.length, 3);
  assert.equal(specialist.status, "PARETO_FRONTIER_REQUIRES_TIEBREAK_POLICY");
  assert.equal(specialist.automaticChampionSelectionAllowed, false);
  assert.equal(specialist.noTradeAllowed, true);
});

test("separates market, horizon, and direction specialists", () => {
  const rows = [
    paretoCandidate({ candidateId: "spot", profileId: "CRYPTO_SPOT:SHORT", direction: "BUY" }),
    paretoCandidate({
      candidateId: "futures-long",
      profileId: "CRYPTO_FUTURES:SHORT",
      direction: "LONG",
      strategyHash: HASH_C,
      parameterIdentity: HASH_D,
    }),
    paretoCandidate({
      candidateId: "futures-short",
      profileId: "CRYPTO_FUTURES:SHORT",
      direction: "SHORT",
      strategyHash: "e".repeat(64),
      parameterIdentity: "f".repeat(64),
    }),
  ];
  const result = buildAdaptiveParetoFrontierV1({ candidates: rows, policy: basePolicy() });
  assert.deepEqual(result.specialists.map((row) => row.specialistKey), [
    "CRYPTO_FUTURES:SHORT:LONG",
    "CRYPTO_FUTURES:SHORT:SHORT",
    "CRYPTO_SPOT:SHORT:BUY",
  ]);
});

test("preserves NO_CANDIDATE when hard gates or statistical firewall do not pass", () => {
  const rows = [
    paretoCandidate({ candidateId: "hard-fail", hardGateStatus: "FAIL" }),
    paretoCandidate({
      candidateId: "stats-missing",
      strategyHash: HASH_C,
      parameterIdentity: HASH_D,
      statisticalFirewallStatus: "MISSING_EVIDENCE",
    }),
  ];
  const result = buildAdaptiveParetoFrontierV1({ candidates: rows, policy: basePolicy() });
  const specialist = result.specialists[0];
  assert.equal(specialist.status, "NO_CANDIDATE");
  assert.equal(specialist.frontier.length, 0);
  assert.deepEqual(specialist.excluded.map((row) => row.reason).sort(), [
    "HARD_GATE_NOT_PASSED",
    "STATISTICAL_FIREWALL_NOT_PASSED",
  ]);
});

test("builds a deterministic immutable non-activating plan and detects tampering", () => {
  const { evidenceCatalog, developmentDiagnostics } = twoReadyProfiles();
  const input = {
    sourceSha: SOURCE_SHA,
    createdAt: CREATED_AT,
    evidenceCatalog,
    developmentDiagnostics,
    policy: basePolicy(),
  };
  const first = buildAdaptiveMultiMarketTournamentPlanV1(input);
  const second = buildAdaptiveMultiMarketTournamentPlanV1(input);
  assert.equal(first.planDigest, second.planDigest);
  assert.equal(verifyAdaptiveMultiMarketTournamentPlanV1(first), true);
  assert.equal(first.localFirstZero, "ADAPTIVE_TOURNAMENT_RUNTIME_ADAPTER_NOT_CONNECTED");
  assert.equal(first.owners.canonicalBacktester, "#690");
  assert.equal(first.owners.statisticalFirewall, "#547");
  assert.equal(first.owners.forwardCanonicalIngest, "#811");
  assert.equal(first.owners.settlement, "#828");
  assert.equal(first.safety.planningOnly, true);
  assert.equal(first.safety.runtimeActivationAllowed, false);
  assert.equal(first.safety.scheduleMutationAllowed, false);
  assert.equal(first.safety.liveTrading, false);
  assert.equal(first.safety.autoTrading, false);
  assert.equal(first.safety.realOrderEnabled, false);
  assert.equal(first.safety.privateTradingApiAllowed, false);
  assert.equal(first.safety.executionAuthority, "NONE");
  assert.equal(first.safety.realOrderCount, 0);
  assert.equal(first.safety.profitabilityClaimAllowed, false);
  assert.equal(first.safety.championPromotionAllowed, false);

  const tampered = JSON.parse(JSON.stringify(first));
  tampered.allocation.initialCandidateFamilySize += 1;
  assert.equal(verifyAdaptiveMultiMarketTournamentPlanV1(tampered), false);
});

test("canonical serializer rejects NaN and remains key-order stable", () => {
  assert.equal(
    canonicalSerializeAdaptiveTournamentV1({ z: 1, a: { y: 2, x: 3 } }),
    canonicalSerializeAdaptiveTournamentV1({ a: { x: 3, y: 2 }, z: 1 }),
  );
  assert.throws(
    () => canonicalSerializeAdaptiveTournamentV1({ invalid: Number.NaN }),
    (error) => error.code === "CANONICAL_NON_FINITE_NUMBER",
  );
});

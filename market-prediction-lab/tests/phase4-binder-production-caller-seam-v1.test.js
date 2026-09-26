import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE4_ADAPTIVE_RUNTIME_OWNER_ROUTES_V1,
  bindPhase4ChallengerToAdaptiveRuntimeOwnersV1,
} from "../src/adaptive-multi-market-tournament-runtime-adapter-v1.js";
import { runPhase4FrozenChallengerCoreV1 } from "../src/phase4-frozen-challenger-core-v1.js";
import {
  buildPhase3StrategyFamilyRegistryV1,
  createPhase3CandidateIdentityV1,
} from "../src/phase3-strategy-tournament-core-v1.js";

const D = (char) => char.repeat(64);
const SOURCE_SHA = "a".repeat(40);
const FREEZE_TIME = "2026-09-12T00:00:00.000Z";

function family() {
  return {
    strategyFamilyId: "MOMENTUM_CROSS",
    strategyVersion: "1.0.0",
    sourceContract: "FormulaCandidateV1",
    sourceIdentity: "formula-family:MOMENTUM_CROSS",
    marketType: "CRYPTO_SPOT",
    allowedSides: ["BUY"],
    supportedTimeframes: ["15m"],
    parameterSchema: {
      fast: { type: "integer", minimum: 2, maximum: 8, step: 1, default: 3, coarseValues: [3] },
      slow: { type: "integer", minimum: 5, maximum: 12, step: 1, default: 8, coarseValues: [8] },
    },
    constraints: [{ left: "fast", operator: "LT", rightParameter: "slow" }],
    requiredIndicators: ["EMA"],
    minimumWarmup: 12,
    backtestCompatibility: {
      owner: "#690",
      engine: "runIndependentSignalBacktest",
      executionEquivalentRequired: true,
    },
    status: "ACTIVE",
  };
}

function universe() {
  return {
    marketType: "CRYPTO_SPOT",
    market: "BINANCE_SPOT_PUBLIC",
    symbol: "BTCUSDT",
    timeframe: "15m",
    side: "BUY",
    datasetRole: "TRAIN",
    datasetIdentity: "dataset:phase3:train:v1",
    datasetDigest: D("1"),
    sourceFrameIdentity: "binance-public-klines:BTCUSDT:15m",
    eventWindow: "closed-candle:15m",
  };
}

function phase4Result() {
  const registry = buildPhase3StrategyFamilyRegistryV1([family()]);
  const candidate = createPhase3CandidateIdentityV1({
    family: registry.families[0],
    universeEntry: universe(),
    parameters: { fast: 3, slow: 8 },
  });
  const tournamentRunId = `phase3-tournament:sha256:${D("a")}`;
  const finalist = Object.freeze({
    schemaVersion: 1,
    candidateId: candidate.candidateId,
    strategyFamilyId: candidate.strategyFamilyId,
    strategyVersion: candidate.strategyVersion,
    parameterDigest: candidate.parameterDigest,
    parameters: candidate.parameters,
    rankingVersion: "ranking-v1",
    rank: 1,
    score: 0.91,
    scoreComponents: [],
    scoreDigest: D("2"),
    selectionReason: "PHASE3_FINALIST",
    datasetIdentity: candidate.datasetIdentity,
    datasetDigest: candidate.datasetDigest,
    searchPolicyDigest: D("3"),
    hardFilterPolicyDigest: D("4"),
    rankingPolicyDigest: D("5"),
    statisticalPolicyDigest: D("6"),
    costPolicyDigest: D("7"),
    tournamentRunId,
    evidenceRole: "ALPHA_CANDIDATE_ONLY",
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    PROFITABILITY_PROVEN: false,
    NET_ALPHA_PROVEN: false,
    CHAMPION: "NONE",
    phase4CandidateFreezePerformed: false,
    parameterMutationAllowed: false,
    statisticalFirewall: { status: "PASS", policyDigest: D("6") },
  });
  const tournamentResult = Object.freeze({
    schemaVersion: 1,
    status: "COMPLETE",
    tournamentRunId,
    finalists: Object.freeze([finalist]),
    executionRealismEvidence: Object.freeze({ credited: false, observations: Object.freeze([]) }),
    PROFITABILITY_PROVEN: false,
    NET_ALPHA_PROVEN: false,
    CHAMPION: "NONE",
  });
  const selectionPolicy = Object.freeze({
    schemaVersion: "phase4-finalist-selection-policy-v1",
    policyVersion: "human-precommit-v1",
    selectionRule: "PRECOMMITTED_EXPLICIT_FINALIST_ID",
    selectionAuthority: "HUMAN_FROZEN_POLICY",
    tournamentRunId,
    selectedCandidateId: candidate.candidateId,
    validationOutcomeConsulted: false,
    oosOutcomeConsulted: false,
    paperOutcomeConsulted: false,
    settlementOutcomeConsulted: false,
    futurePnlConsulted: false,
    futureFillConsulted: false,
    championStatusConsulted: false,
    postOutcomeManualSelection: false,
    postFreezeMutationAllowed: false,
  });
  const result = runPhase4FrozenChallengerCoreV1({
    tournamentResult,
    tournamentInput: Object.freeze({ families: Object.freeze([family()]), universe: Object.freeze([universe()]) }),
    candidateId: candidate.candidateId,
    selectionPolicy,
    freezeTimestamp: FREEZE_TIME,
  });
  assert.equal(result.status, "PROSPECTIVE_ADMISSION_READY");
  return result;
}

function runtimeIdentity(result = phase4Result(), overrides = {}) {
  return {
    strategyId: "phase4-runtime-strategy-v1",
    strategyVersion: result.challenger.strategyVersion,
    parameterHash: result.challenger.parameterDigest,
    researchCodeSha: SOURCE_SHA,
    costPolicyVersion: "cost-v1",
    executionPolicyVersion: "execution-v1",
    candidateId: result.challenger.candidateId,
    strategyFamily: result.challenger.strategyFamily,
    parameterDigest: result.challenger.parameterDigest,
    accountMode: "PAPER",
    ...overrides,
  };
}

test("production adapter consumes the Phase4 binder and exposes only existing-owner non-activating routes", () => {
  const result = phase4Result();
  const identity = runtimeIdentity(result);
  const routed = bindPhase4ChallengerToAdaptiveRuntimeOwnersV1({
    phase4Result: result,
    runtimeStrategyIdentity: identity,
  });

  assert.equal(routed.status, "BOUND_TO_EXISTING_OWNERS_NON_ACTIVATING");
  assert.equal(routed.FIRST_ZERO, null);
  assert.equal(routed.binding.candidateId, result.challenger.candidateId);
  assert.deepEqual(routed.binding.candidateStrategyIdentity, identity);
  assert.deepEqual(
    Object.fromEntries(Object.entries(routed.ownerRoutes).map(([key, route]) => [key, route.ownerTarget])),
    {
      forward: "CANONICAL_FORWARD_OWNER_CHAIN",
      shadow: "CANONICAL_SHADOW_OWNER",
      paper: "CANONICAL_PAPER_OWNER_CHAIN",
    },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(PHASE4_ADAPTIVE_RUNTIME_OWNER_ROUTES_V1)
      .map(([key, route]) => [key, route.stage])),
    { forward: "FORWARD", shadow: "SHADOW", paper: "PAPER" },
  );
  for (const route of Object.values(routed.ownerRoutes)) {
    assert.equal(route.candidateId, result.challenger.candidateId);
    assert.strictEqual(route.candidateStrategyIdentity, routed.binding.candidateStrategyIdentity);
    assert.equal(route.status, "ROUTED_NON_ACTIVATING");
    assert.equal(route.activationAllowed, false);
    assert.equal(route.dispatchAllowed, false);
    assert.equal(route.economicCreditCreated, false);
    assert.equal(route.executionAuthority, "NONE");
  }
});

test("production caller seam fails closed for missing or mismatched runtime identity", () => {
  const result = phase4Result();
  const missing = bindPhase4ChallengerToAdaptiveRuntimeOwnersV1({ phase4Result: result });
  assert.equal(missing.status, "BLOCKED");
  assert.equal(missing.FIRST_ZERO, "PHASE4_RUNTIME_STRATEGY_IDENTITY_BINDING_MISSING");
  assert.equal(missing.ownerRoutes, null);
  assert.equal(missing.actualOwnerCalls, 0);

  const mismatch = bindPhase4ChallengerToAdaptiveRuntimeOwnersV1({
    phase4Result: result,
    runtimeStrategyIdentity: runtimeIdentity(result, { parameterHash: D("f") }),
  });
  assert.equal(mismatch.status, "BLOCKED");
  assert.equal(mismatch.FIRST_ZERO, "PHASE4_RUNTIME_STRATEGY_IDENTITY_MISMATCH");
  assert.equal(mismatch.ownerRoutes, null);
  assert.equal(mismatch.actualOwnerCalls, 0);
});

test("owner routing creates zero activation dispatch economic credit and execution authority", () => {
  const result = phase4Result();
  const routed = bindPhase4ChallengerToAdaptiveRuntimeOwnersV1({
    phase4Result: result,
    runtimeStrategyIdentity: runtimeIdentity(result),
  });

  assert.equal(routed.runtimeActivationAllowed, false);
  assert.equal(routed.dispatchAllowed, false);
  assert.equal(routed.economicCreditCreated, false);
  assert.equal(routed.sampleCredit, 0);
  assert.equal(routed.executionRealismCredit, 0);
  assert.equal(routed.profitabilityCredit, 0);
  assert.equal(routed.FULL_COST_READY, false);
  assert.equal(routed.NET_ALPHA_PROVEN, false);
  assert.equal(routed.PROFITABILITY_PROVEN, false);
  assert.equal(routed.CHAMPION, "NONE");
  assert.equal(routed.executionAuthority, "NONE");
  assert.equal(routed.actualOwnerCalls, 0);
  assert.equal(routed.actualForwardHandoffs, 0);
  assert.equal(routed.actualShadowHandoffs, 0);
  assert.equal(routed.actualPaperHandoffs, 0);
});

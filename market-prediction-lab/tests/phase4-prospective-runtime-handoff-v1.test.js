import assert from "node:assert/strict";
import test from "node:test";

import { bindPhase4ProspectiveRuntimeIdentityV1 } from "../src/phase4-prospective-runtime-handoff-v1.js";
import { runPhase4FrozenChallengerCoreV1 } from "../src/phase4-frozen-challenger-core-v1.js";
import {
  buildPhase3StrategyFamilyRegistryV1,
  createPhase3CandidateIdentityV1,
} from "../src/phase3-strategy-tournament-core-v1.js";

const D = (char) => char.repeat(64);
const SHA = "b".repeat(40);
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
    researchCodeSha: SHA,
    costPolicyVersion: "cost-v1",
    executionPolicyVersion: "execution-v1",
    candidateId: result.challenger.candidateId,
    strategyFamily: result.challenger.strategyFamily,
    parameterDigest: result.challenger.parameterDigest,
    accountMode: "PAPER",
    ...overrides,
  };
}

test("binds a verified Frozen Challenger to the recurring candidate strategy identity without activation", () => {
  const result = phase4Result();
  const identity = runtimeIdentity(result);
  const bound = bindPhase4ProspectiveRuntimeIdentityV1({ phase4Result: result, runtimeStrategyIdentity: identity });

  assert.equal(bound.status, "BOUND_NON_ACTIVATING");
  assert.equal(bound.FIRST_ZERO, null);
  assert.deepEqual(bound.binding.candidateStrategyIdentity, identity);
  assert.equal(bound.binding.candidateId, result.challenger.candidateId);
  assert.equal(bound.binding.candidateIdentityPreserved, true);
  assert.equal(bound.binding.secondIdentityCreated, false);
  assert.equal(bound.binding.remapPerformed, false);
  assert.equal(bound.binding.rehashPerformed, false);
  assert.equal(bound.binding.fallbackIdentityUsed, false);
  assert.equal(Object.isFrozen(bound.binding.candidateStrategyIdentity), true);
});

test("binds all four Phase4 stages as non-activating handoffs", () => {
  const result = phase4Result();
  const bound = bindPhase4ProspectiveRuntimeIdentityV1({ phase4Result: result, runtimeStrategyIdentity: runtimeIdentity(result) });
  assert.deepEqual(
    Object.values(bound.binding.stageBindings).map((row) => row.stage),
    ["PROSPECTIVE_SAMPLE_ADMISSION", "FORWARD", "SHADOW", "PAPER"],
  );
  for (const row of Object.values(bound.binding.stageBindings)) {
    assert.equal(row.status, "BOUND_NON_ACTIVATING");
    assert.equal(row.activationAllowed, false);
    assert.equal(row.dispatchAllowed, false);
    assert.equal(row.economicCreditCreated, false);
    assert.equal(row.executionAuthority, "NONE");
  }
});

test("preserves the exact Phase3 candidate and parameter identity expected by recurring Paper", () => {
  const result = phase4Result();
  const identity = runtimeIdentity(result);
  const bound = bindPhase4ProspectiveRuntimeIdentityV1({ phase4Result: result, runtimeStrategyIdentity: identity });
  assert.equal(bound.binding.candidateStrategyIdentity.candidateId, result.challenger.candidateId);
  assert.equal(bound.binding.candidateStrategyIdentity.strategyFamily, result.challenger.strategyFamily);
  assert.equal(bound.binding.candidateStrategyIdentity.strategyVersion, result.challenger.strategyVersion);
  assert.equal(bound.binding.candidateStrategyIdentity.parameterDigest, result.challenger.parameterDigest);
  assert.equal(bound.binding.candidateStrategyIdentity.parameterHash, result.challenger.parameterDigest);
  assert.equal(bound.binding.candidateStrategyIdentity.accountMode, "PAPER");
});

test("missing or structurally incomplete runtime identity fails closed", () => {
  const result = phase4Result();
  const missing = bindPhase4ProspectiveRuntimeIdentityV1({ phase4Result: result });
  assert.equal(missing.FIRST_ZERO, "PHASE4_RUNTIME_STRATEGY_IDENTITY_BINDING_MISSING");

  const invalid = bindPhase4ProspectiveRuntimeIdentityV1({
    phase4Result: result,
    runtimeStrategyIdentity: runtimeIdentity(result, { researchCodeSha: "not-a-sha" }),
  });
  assert.equal(invalid.FIRST_ZERO, "PHASE4_RUNTIME_STRATEGY_IDENTITY_INVALID");
});

test("every overlap with the Frozen Challenger must match exactly", () => {
  const result = phase4Result();
  const mutations = [
    { candidateId: `phase3-candidate:sha256:${D("f")}` },
    { strategyFamily: "OTHER" },
    { strategyVersion: "2.0.0" },
    { parameterDigest: D("e") },
    { parameterHash: D("e") },
    { accountMode: "LIVE" },
  ];
  for (const patch of mutations) {
    const bound = bindPhase4ProspectiveRuntimeIdentityV1({
      phase4Result: result,
      runtimeStrategyIdentity: runtimeIdentity(result, patch),
    });
    assert.equal(bound.status, "BLOCKED");
    assert.equal(
      bound.FIRST_ZERO,
      patch.accountMode === "LIVE"
        ? "PHASE4_RUNTIME_STRATEGY_IDENTITY_INVALID"
        : "PHASE4_RUNTIME_STRATEGY_IDENTITY_MISMATCH",
    );
  }
});

test("tampered Frozen Challenger is rejected", () => {
  const result = phase4Result();
  const tampered = structuredClone(result);
  tampered.challenger.symbol = "ETHUSDT";
  const bound = bindPhase4ProspectiveRuntimeIdentityV1({
    phase4Result: tampered,
    runtimeStrategyIdentity: runtimeIdentity(result),
  });
  assert.equal(bound.FIRST_ZERO, "PHASE4_FROZEN_CHALLENGER_INVALID");
});

test("tampered or authority-elevated Phase4 handoff is rejected", () => {
  const result = phase4Result();
  for (const patch of [
    { stage: "WRONG_STAGE" },
    { activationAllowed: true },
    { dispatchAllowed: true },
    { economicCreditCreated: true },
  ]) {
    const tampered = structuredClone(result);
    Object.assign(tampered.handoffs.paper, patch);
    const bound = bindPhase4ProspectiveRuntimeIdentityV1({
      phase4Result: tampered,
      runtimeStrategyIdentity: runtimeIdentity(result),
    });
    assert.equal(bound.FIRST_ZERO, "PHASE4_HANDOFF_IDENTITY_INVALID");
  }
});

test("runtime identity cannot elevate execution authority", () => {
  const result = phase4Result();
  const bound = bindPhase4ProspectiveRuntimeIdentityV1({
    phase4Result: result,
    runtimeStrategyIdentity: runtimeIdentity(result, { executionAuthority: "LIVE" }),
  });
  assert.equal(bound.FIRST_ZERO, "PHASE4_RUNTIME_SAFETY_ENVELOPE_INVALID");
});

test("binding creates no sample, execution-realism, profitability, champion, or trading credit", () => {
  const result = phase4Result();
  const bound = bindPhase4ProspectiveRuntimeIdentityV1({ phase4Result: result, runtimeStrategyIdentity: runtimeIdentity(result) });
  for (const value of [bound, bound.binding]) {
    assert.equal(value.runtimeActivationAllowed, false);
    assert.equal(value.dispatchAllowed, false);
    assert.equal(value.economicCreditCreated, false);
    assert.equal(value.sampleCredit, 0);
    assert.equal(value.executionRealismCredit, 0);
    assert.equal(value.profitabilityCredit, 0);
    assert.equal(value.FULL_COST_READY, false);
    assert.equal(value.NET_ALPHA_PROVEN, false);
    assert.equal(value.PROFITABILITY_PROVEN, false);
    assert.equal(value.CHAMPION, "NONE");
    assert.equal(value.executionAuthority, "NONE");
    assert.equal(value.LIVE_TRADING, false);
    assert.equal(value.AUTO_TRADING, false);
    assert.equal(value.REAL_ORDER_ENABLED, false);
    assert.equal(value.PRIVATE_TRADING_API_ALLOWED, false);
  }
});

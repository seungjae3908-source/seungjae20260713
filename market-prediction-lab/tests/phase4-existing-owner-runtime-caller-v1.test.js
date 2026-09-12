import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE4_EXISTING_OWNER_RUNTIME_CALLER_CONTRACT_V1,
  runPhase4ExistingOwnerRuntimeCallerV1,
} from "../src/phase4-existing-owner-runtime-caller-v1.js";
import {
  buildPhase3StrategyFamilyRegistryV1,
  createPhase3CandidateIdentityV1,
} from "../src/phase3-strategy-tournament-core-v1.js";

const D = (char) => char.repeat(64);
const SHA = "a".repeat(40);
const FREEZE_TIME = "2026-09-12T11:30:00.000Z";
const FREEZE_MS = Date.parse(FREEZE_TIME);

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

function fixture() {
  const registry = buildPhase3StrategyFamilyRegistryV1([family()]);
  const identity = createPhase3CandidateIdentityV1({
    family: registry.families[0],
    universeEntry: universe(),
    parameters: { fast: 3, slow: 8 },
  });
  const tournamentRunId = `phase3-tournament:sha256:${D("a")}`;
  const finalist = Object.freeze({
    schemaVersion: 1,
    candidateId: identity.candidateId,
    strategyFamilyId: identity.strategyFamilyId,
    strategyVersion: identity.strategyVersion,
    parameterDigest: identity.parameterDigest,
    parameters: identity.parameters,
    rankingVersion: "ranking-v1",
    rank: 1,
    score: 0.91,
    scoreComponents: [],
    scoreDigest: D("2"),
    selectionReason: "PASSED_TRAIN_HARD_FILTER_RANKING_AND_STATISTICAL_FIREWALL",
    datasetIdentity: identity.datasetIdentity,
    datasetDigest: identity.datasetDigest,
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
    alphaCandidateEvidence: Object.freeze([]),
    executionRealismEvidence: Object.freeze({ credited: false, observations: Object.freeze([]) }),
    phase4Handoff: Object.freeze({
      status: "AWAITING_PHASE4_CANDIDATE_FREEZE",
      candidateFreezePerformed: false,
      finalistIds: Object.freeze([identity.candidateId]),
    }),
    PROFITABILITY_PROVEN: false,
    NET_ALPHA_PROVEN: false,
    CHAMPION: "NONE",
  });
  const tournamentInput = Object.freeze({
    families: Object.freeze([family()]),
    universe: Object.freeze([universe()]),
  });
  return { identity, finalist, tournamentResult, tournamentInput };
}

function authoritativeSource(f) {
  return Object.freeze({
    tournamentResult: f.tournamentResult,
    tournamentInput: f.tournamentInput,
  });
}

function runtimeIdentity(f, overrides = {}) {
  return {
    strategyId: "phase4-runtime-strategy-v1",
    strategyFamily: f.identity.strategyFamilyId,
    strategyVersion: f.identity.strategyVersion,
    parameterHash: f.identity.parameterDigest,
    researchCodeSha: SHA,
    costPolicyVersion: "cost-v1",
    executionPolicyVersion: "execution-v1",
    candidateId: f.identity.candidateId,
    parameterDigest: f.identity.parameterDigest,
    accountMode: "PAPER",
    ...overrides,
  };
}

function strategyIdentity(f, overrides = {}) {
  return {
    strategyId: "phase4-runtime-strategy-v1",
    strategyFamily: f.identity.strategyFamilyId,
    strategyVersion: f.identity.strategyVersion,
    market: f.identity.market,
    direction: f.identity.side,
    timeframe: f.identity.timeframe,
    formulaIdentity: { family: f.identity.strategyFamilyId, version: f.identity.strategyVersion },
    parameterHash: f.identity.parameterDigest,
    researchCodeSha: SHA,
    datasetId: "phase4-prospective-dataset-v1",
    datasetDigest: D("d"),
    datasetStart: "2026-09-12T11:30:01.000Z",
    datasetEnd: "2026-09-12T11:45:01.000Z",
    costPolicyVersion: "cost-v1",
    riskPolicyVersion: "risk-v1",
    evidenceSchemaVersion: "phase4-existing-owner-evidence-v1",
    ...overrides,
  };
}

function baseEvidence(f, overrides = {}) {
  return {
    strategyIdentity: strategyIdentity(f),
    researchSurvivorEvidence: {},
    observedAt: "2026-09-12T11:46:00.000Z",
    ...overrides,
  };
}

function fullEvidence(f) {
  return baseEvidence(f, {
    forwardObservation: { observationId: "forward-1" },
    canonicalShadowHandoff: { schemaVersion: "prediction-lab-strategy-health-shadow-handoff-v1" },
    additionalShadowObservations: [],
    paperAdmissionBundle: { schemaVersion: "scanner-paper-admission-evidence-bundle-v1" },
  });
}

function fakeOwners(f, { paperIdentity = runtimeIdentity(f) } = {}) {
  return {
    shadowAdmission() {
      return {
        status: "PASS",
        admitted: true,
        shadowCandidate: {
          schemaVersion: "shadow-candidate-v1",
          status: "PASS",
          strategyIdentityDigest: D("e"),
        },
      };
    },
    forwardObservation() {
      return {
        status: "PASS",
        observation: {
          schemaVersion: "shadow-forward-observation-v1",
          observationId: "forward-1",
        },
      };
    },
    shadowSufficiency() {
      return {
        status: "PASS",
        sufficient: true,
        metrics: { totalN: 30 },
      };
    },
    paperAdmission() {
      return {
        status: "BRIDGE_READY",
        candidate: {
          signal: {
            strategyIdentity: paperIdentity,
          },
        },
      };
    },
  };
}

function baseCallerInput(f = fixture()) {
  return {
    authoritativePhase3Sources: [authoritativeSource(f)],
    freezeTimestamp: FREEZE_TIME,
    runtimeStrategyIdentity: runtimeIdentity(f),
    ownerEvidence: fullEvidence(f),
    paperNowMs: FREEZE_MS + 60_000,
  };
}

test("runtime caller contract is production-callable but remains non-activating", () => {
  assert.equal(PHASE4_EXISTING_OWNER_RUNTIME_CALLER_CONTRACT_V1.productionCallable, true);
  assert.equal(PHASE4_EXISTING_OWNER_RUNTIME_CALLER_CONTRACT_V1.runtimeActivationAllowed, false);
  assert.equal(PHASE4_EXISTING_OWNER_RUNTIME_CALLER_CONTRACT_V1.schedulerActivationAllowed, false);
  assert.equal(PHASE4_EXISTING_OWNER_RUNTIME_CALLER_CONTRACT_V1.dispatchAllowed, false);
  assert.equal(PHASE4_EXISTING_OWNER_RUNTIME_CALLER_CONTRACT_V1.economicCreditCreated, false);
  assert.equal(PHASE4_EXISTING_OWNER_RUNTIME_CALLER_CONTRACT_V1.executionAuthority, "NONE");
});

test("missing authoritative Phase3 source fails closed before route or owner calls", () => {
  const result = runPhase4ExistingOwnerRuntimeCallerV1({ freezeTimestamp: FREEZE_TIME });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.stage, "SOURCE");
  assert.equal(result.FIRST_ZERO, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_MISSING");
  assert.equal(result.routed, null);
  assert.equal(result.consumer, null);
  assert.equal(result.actualOwnerCalls, 0);
  assert.equal(result.actualForwardHandoffs, 0);
  assert.equal(result.actualShadowHandoffs, 0);
  assert.equal(result.actualPaperHandoffs, 0);
});

test("ambiguous authoritative Phase3 sources fail closed without latest-source selection", () => {
  const f = fixture();
  const source = authoritativeSource(f);
  const result = runPhase4ExistingOwnerRuntimeCallerV1({
    authoritativePhase3Sources: [source, source],
    freezeTimestamp: FREEZE_TIME,
    runtimeStrategyIdentity: runtimeIdentity(f),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.stage, "SOURCE");
  assert.equal(result.FIRST_ZERO, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_AMBIGUOUS");
  assert.equal(result.actualOwnerCalls, 0);
});

test("valid source with missing runtime identity fails closed at existing-owner route", () => {
  const f = fixture();
  const result = runPhase4ExistingOwnerRuntimeCallerV1({
    authoritativePhase3Sources: [authoritativeSource(f)],
    freezeTimestamp: FREEZE_TIME,
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.stage, "ROUTE");
  assert.equal(result.FIRST_ZERO, "PHASE4_RUNTIME_STRATEGY_IDENTITY_BINDING_MISSING");
  assert.equal(result.source.status, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_READY");
  assert.equal(result.actualOwnerCalls, 0);
});

test("production caller reaches the real existing Shadow owner and fails closed on missing survivor evidence", () => {
  const f = fixture();
  const result = runPhase4ExistingOwnerRuntimeCallerV1({
    authoritativePhase3Sources: [authoritativeSource(f)],
    freezeTimestamp: FREEZE_TIME,
    runtimeStrategyIdentity: runtimeIdentity(f),
    ownerEvidence: baseEvidence(f),
    paperNowMs: FREEZE_MS + 60_000,
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.stage, "CONSUMER");
  assert.equal(result.FIRST_ZERO, "PHASE4_SHADOW_OWNER_ADMISSION_BLOCKED");
  assert.equal(result.source.status, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_READY");
  assert.equal(result.routed.status, "BOUND_TO_EXISTING_OWNERS_NON_ACTIVATING");
  assert.equal(result.actualOwnerCalls, 1);
  assert.equal(result.ownerContractAcceptances, 0);
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.economicCreditCreated, false);
});

test("owner overrides remain forbidden outside explicit test-only mode", () => {
  const f = fixture();
  const result = runPhase4ExistingOwnerRuntimeCallerV1({
    ...baseCallerInput(f),
    ownerFunctions: fakeOwners(f),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.stage, "CONSUMER");
  assert.equal(result.FIRST_ZERO, "PHASE4_EXISTING_OWNER_OVERRIDE_FORBIDDEN");
  assert.equal(result.actualOwnerCalls, 0);
  assert.equal(result.economicCreditCreated, false);
});

test("test-only proof connects source route and all existing-owner preflight contracts without activation or credit", () => {
  const f = fixture();
  const calls = [];
  const owners = Object.fromEntries(Object.entries(fakeOwners(f)).map(([key, fn]) => [key, (...args) => {
    calls.push(key);
    return fn(...args);
  }]));
  const result = runPhase4ExistingOwnerRuntimeCallerV1({
    ...baseCallerInput(f),
    ownerFunctions: owners,
    testOnly: true,
  });

  assert.equal(result.status, "PHASE4_EXISTING_OWNER_RUNTIME_CALLER_READY_NON_ACTIVATING");
  assert.equal(result.FIRST_ZERO, null);
  assert.deepEqual(calls, ["shadowAdmission", "forwardObservation", "shadowSufficiency", "paperAdmission"]);
  assert.equal(result.source.status, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_READY");
  assert.equal(result.routed.status, "BOUND_TO_EXISTING_OWNERS_NON_ACTIVATING");
  assert.equal(result.consumer.status, "EXISTING_OWNERS_CONNECTED_NON_ACTIVATING");
  assert.equal(result.candidateId, f.identity.candidateId);
  assert.equal(result.routed.binding.candidateId, f.identity.candidateId);
  assert.equal(result.consumer.candidateId, f.identity.candidateId);
  assert.equal(result.parameterDigest, f.identity.parameterDigest);
  assert.equal(result.prospectiveBoundary, FREEZE_TIME);
  assert.equal(result.candidateIdentityPreserved, true);
  assert.equal(result.secondIdentityCreated, false);
  assert.equal(result.remapPerformed, false);
  assert.equal(result.rehashPerformed, false);
  assert.equal(result.fallbackIdentityUsed, false);
  assert.equal(result.actualOwnerCalls, 4);
  assert.equal(result.ownerContractAcceptances, 4);
  assert.equal(result.ownerPreflightOnly, true);
  assert.equal(result.runtimeActivationAllowed, false);
  assert.equal(result.schedulerActivationAllowed, false);
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.economicCreditCreated, false);
  assert.equal(result.sampleCredit, 0);
  assert.equal(result.executionRealismCredit, 0);
  assert.equal(result.profitabilityCredit, 0);
  assert.equal(result.FULL_COST_READY, false);
  assert.equal(result.NET_ALPHA_PROVEN, false);
  assert.equal(result.PROFITABILITY_PROVEN, false);
  assert.equal(result.CHAMPION, "NONE");
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.actualForwardHandoffs, 0);
  assert.equal(result.actualShadowHandoffs, 0);
  assert.equal(result.actualPaperHandoffs, 0);
  assert.equal(result.realOrderCount, 0);
});

test("Paper candidate identity remap still fails closed after all prior caller stages", () => {
  const f = fixture();
  const result = runPhase4ExistingOwnerRuntimeCallerV1({
    ...baseCallerInput(f),
    ownerFunctions: fakeOwners(f, {
      paperIdentity: runtimeIdentity(f, { candidateId: `phase3-candidate:sha256:${D("f")}` }),
    }),
    testOnly: true,
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.stage, "CONSUMER");
  assert.equal(result.FIRST_ZERO, "PHASE4_PAPER_OWNER_IDENTITY_MISMATCH");
  assert.equal(result.actualOwnerCalls, 4);
  assert.equal(result.ownerContractAcceptances, 3);
  assert.equal(result.actualPaperHandoffs, 0);
  assert.equal(result.economicCreditCreated, false);
});

test("prebuilt source route consumer candidate or policy overrides are rejected at caller input", () => {
  for (const patch of [
    { phase4Result: {} },
    { sourceResult: {} },
    { routed: {} },
    { consumer: {} },
    { consumerResult: {} },
    { candidateId: `phase3-candidate:sha256:${D("f")}` },
    { selectionPolicy: {} },
  ]) {
    const result = runPhase4ExistingOwnerRuntimeCallerV1(patch);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.stage, "INPUT");
    assert.equal(result.FIRST_ZERO, "PHASE4_EXISTING_OWNER_RUNTIME_CALLER_OVERRIDE_REJECTED");
    assert.equal(result.actualOwnerCalls, 0);
  }
});

test("caller never invents an order action while preserving BUY as immutable side identity", () => {
  const f = fixture();
  const result = runPhase4ExistingOwnerRuntimeCallerV1({
    ...baseCallerInput(f),
    ownerFunctions: fakeOwners(f),
    testOnly: true,
  });
  assert.equal(result.status, "PHASE4_EXISTING_OWNER_RUNTIME_CALLER_READY_NON_ACTIVATING");
  assert.equal(result.phase4Result.challenger.sidePolicy, "BUY");
  for (const object of [result, result.source, result.routed, result.consumer]) {
    for (const key of ["order", "orderAction", "tradeAction", "executionAction", "signalAction"]) {
      assert.equal(Object.hasOwn(object, key), false);
    }
  }
  assert.equal(result.realOrderCount, 0);
});

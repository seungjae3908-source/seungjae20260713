import assert from "node:assert/strict";
import test from "node:test";

import { runPhase4ProspectiveResultRuntimeSourceV1 } from "../src/phase4-prospective-result-runtime-source-v1.js";
import {
  buildPhase3StrategyFamilyRegistryV1,
  createPhase3CandidateIdentityV1,
} from "../src/phase3-strategy-tournament-core-v1.js";

const D = (char) => char.repeat(64);
const FREEZE_TIME = "2026-09-12T09:45:00.000Z";

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

function authoritativeSource(f, tournamentResult = f.tournamentResult, tournamentInput = f.tournamentInput) {
  return Object.freeze({ tournamentResult, tournamentInput });
}

function runValid(f = fixture()) {
  return runPhase4ProspectiveResultRuntimeSourceV1({
    authoritativePhase3Sources: [authoritativeSource(f)],
    freezeTimestamp: FREEZE_TIME,
  });
}

test("authoritative Phase3 source produces the exact immutable Phase4 frozen challenger result", () => {
  const f = fixture();
  const result = runValid(f);

  assert.equal(result.status, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_READY");
  assert.equal(result.sourceCount, 1);
  assert.equal(result.phase4Result.status, "PROSPECTIVE_ADMISSION_READY");
  assert.equal(result.candidateId, f.identity.candidateId);
  assert.equal(result.parameterDigest, f.identity.parameterDigest);
  assert.equal(result.datasetIdentity, f.identity.datasetIdentity);
  assert.equal(result.datasetDigest, f.identity.datasetDigest);
  assert.equal(result.phase4Result.challenger.candidateId, f.identity.candidateId);
  assert.equal(result.phase4Result.challenger.prospectiveBoundary, FREEZE_TIME);
  assert.equal(Object.isFrozen(result.phase4Result.challenger), true);
});

test("missing authoritative source fails closed", () => {
  for (const authoritativePhase3Sources of [undefined, []]) {
    const result = runPhase4ProspectiveResultRuntimeSourceV1({ authoritativePhase3Sources, freezeTimestamp: FREEZE_TIME });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.reason, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_MISSING");
    assert.equal(result.phase4Result, null);
  }
});

test("multiple authoritative sources fail closed without latest-file selection", () => {
  const f = fixture();
  const conflictingResult = {
    ...f.tournamentResult,
    tournamentRunId: `phase3-tournament:sha256:${D("b")}`,
  };
  const result = runPhase4ProspectiveResultRuntimeSourceV1({
    authoritativePhase3Sources: [authoritativeSource(f), authoritativeSource(f, conflictingResult)],
    freezeTimestamp: FREEZE_TIME,
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_AMBIGUOUS");
  assert.equal(result.sourceCount, 2);
  assert.equal(result.phase4Result, null);
});

test("candidate identity mismatch fails closed", () => {
  const f = fixture();
  const forgedCandidateId = `phase3-candidate:sha256:${D("f")}`;
  const forgedFinalist = { ...f.finalist, candidateId: forgedCandidateId };
  const tournamentResult = {
    ...f.tournamentResult,
    finalists: [forgedFinalist],
    phase4Handoff: {
      ...f.tournamentResult.phase4Handoff,
      finalistIds: [forgedCandidateId],
    },
  };
  const result = runPhase4ProspectiveResultRuntimeSourceV1({
    authoritativePhase3Sources: [authoritativeSource(f, tournamentResult)],
    freezeTimestamp: FREEZE_TIME,
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "FINALIST_IDENTITY_INVALID");
  assert.equal(result.phase4Result, null);
});

test("parameter digest mismatch fails closed", () => {
  const f = fixture();
  const tournamentResult = {
    ...f.tournamentResult,
    finalists: [{ ...f.finalist, parameterDigest: D("f") }],
  };
  const result = runPhase4ProspectiveResultRuntimeSourceV1({
    authoritativePhase3Sources: [authoritativeSource(f, tournamentResult)],
    freezeTimestamp: FREEZE_TIME,
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "FINALIST_IDENTITY_INVALID");
  assert.equal(result.phase4Result, null);
});

test("missing dataset identity or required policy digest fails closed", () => {
  const f = fixture();
  const missingDataset = {
    ...f.tournamentResult,
    finalists: [{ ...f.finalist, datasetIdentity: "" }],
  };
  const datasetResult = runPhase4ProspectiveResultRuntimeSourceV1({
    authoritativePhase3Sources: [authoritativeSource(f, missingDataset)],
    freezeTimestamp: FREEZE_TIME,
  });
  assert.equal(datasetResult.status, "BLOCKED");
  assert.equal(datasetResult.reason, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_IDENTITY_MISMATCH");

  const missingPolicy = {
    ...f.tournamentResult,
    finalists: [{ ...f.finalist, costPolicyDigest: "" }],
  };
  const policyResult = runPhase4ProspectiveResultRuntimeSourceV1({
    authoritativePhase3Sources: [authoritativeSource(f, missingPolicy)],
    freezeTimestamp: FREEZE_TIME,
  });
  assert.equal(policyResult.status, "BLOCKED");
  assert.equal(policyResult.reason, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_POLICY_MISMATCH");
});

test("statistical policy digest mismatch fails closed", () => {
  const f = fixture();
  const tournamentResult = {
    ...f.tournamentResult,
    finalists: [{
      ...f.finalist,
      statisticalFirewall: { ...f.finalist.statisticalFirewall, policyDigest: D("8") },
    }],
  };
  const result = runPhase4ProspectiveResultRuntimeSourceV1({
    authoritativePhase3Sources: [authoritativeSource(f, tournamentResult)],
    freezeTimestamp: FREEZE_TIME,
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_POLICY_MISMATCH");
  assert.equal(result.detail, "PHASE3_STATISTICAL_POLICY_DIGEST_MISMATCH");
});

test("missing prospective boundary fails closed", () => {
  const f = fixture();
  const result = runPhase4ProspectiveResultRuntimeSourceV1({
    authoritativePhase3Sources: [authoritativeSource(f)],
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "PROSPECTIVE_BOUNDARY_MISSING");
  assert.equal(result.phase4Result, null);
});

test("source seam does not mutate the authoritative Phase3 source", () => {
  const f = fixture();
  const sources = [authoritativeSource(f)];
  const before = JSON.stringify(sources);
  const result = runPhase4ProspectiveResultRuntimeSourceV1({
    authoritativePhase3Sources: sources,
    freezeTimestamp: FREEZE_TIME,
  });

  assert.equal(result.status, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_READY");
  assert.equal(JSON.stringify(sources), before);
  assert.equal(sources[0].tournamentResult, f.tournamentResult);
  assert.equal(sources[0].tournamentInput, f.tournamentInput);
});

test("successful source remains non-activating and performs zero owner handoffs", () => {
  const result = runValid();

  assert.equal(result.runtimeActivationAllowed, false);
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.LIVE_TRADING, false);
  assert.equal(result.AUTO_TRADING, false);
  assert.equal(result.REAL_ORDER_ENABLED, false);
  assert.equal(result.PRIVATE_TRADING_API_ALLOWED, false);
  assert.equal(result.actualForwardHandoffs, 0);
  assert.equal(result.actualShadowHandoffs, 0);
  assert.equal(result.actualPaperHandoffs, 0);
  assert.equal(result.realOrderCount, 0);
  assert.equal(result.phase4Result.handoffs.forward.activationAllowed, false);
  assert.equal(result.phase4Result.handoffs.shadow.activationAllowed, false);
  assert.equal(result.phase4Result.handoffs.paper.activationAllowed, false);
});

test("successful source creates no sample, execution-realism, profitability, or full-cost credit", () => {
  const result = runValid();

  assert.equal(result.economicCreditCreated, false);
  assert.equal(result.sampleCredit, 0);
  assert.equal(result.executionRealismCredit, 0);
  assert.equal(result.profitabilityCredit, 0);
  assert.equal(result.FULL_COST_READY, false);
  assert.equal(result.NET_ALPHA_PROVEN, false);
  assert.equal(result.PROFITABILITY_PROVEN, false);
  assert.equal(result.CHAMPION, "NONE");
});

test("source preserves side identity but invents no BUY/SELL order action", () => {
  const result = runValid();

  assert.equal(result.phase4Result.challenger.sidePolicy, "BUY");
  assert.equal(result.phase4Result.handoffs.forward.sidePolicy, "BUY");
  assert.equal(result.phase4Result.handoffs.shadow.sidePolicy, "BUY");
  assert.equal(result.phase4Result.handoffs.paper.sidePolicy, "BUY");
  for (const key of ["order", "orderAction", "signalAction", "tradeAction", "executionAction"]) {
    assert.equal(Object.hasOwn(result, key), false);
    assert.equal(Object.hasOwn(result.phase4Result, key), false);
  }
  assert.equal(result.realOrderCount, 0);
});

test("invalid rank-1 never falls back, remaps, or rehashes to a valid lower-rank candidate", () => {
  const f = fixture();
  const forgedCandidateId = `phase3-candidate:sha256:${D("f")}`;
  const invalidRankOne = { ...f.finalist, candidateId: forgedCandidateId, rank: 1 };
  const validRankTwo = { ...f.finalist, rank: 2 };
  const tournamentResult = {
    ...f.tournamentResult,
    finalists: [invalidRankOne, validRankTwo],
    phase4Handoff: {
      ...f.tournamentResult.phase4Handoff,
      finalistIds: [forgedCandidateId, f.identity.candidateId],
    },
  };
  const result = runPhase4ProspectiveResultRuntimeSourceV1({
    authoritativePhase3Sources: [authoritativeSource(f, tournamentResult)],
    freezeTimestamp: FREEZE_TIME,
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "FINALIST_IDENTITY_INVALID");
  assert.equal(result.detail, "CANONICAL_RANK_1_FAILED_ADMISSION_NO_FALLBACK");
  assert.equal(result.phase4Result, null);
});

test("manual candidate, selection-policy, or prebuilt Phase4 result overrides are rejected", () => {
  const f = fixture();
  for (const patch of [
    { candidateId: f.identity.candidateId },
    { selectionPolicy: {} },
    { phase4Result: {} },
  ]) {
    const result = runPhase4ProspectiveResultRuntimeSourceV1({
      authoritativePhase3Sources: [authoritativeSource(f)],
      freezeTimestamp: FREEZE_TIME,
      ...patch,
    });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.reason, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_OVERRIDE_REJECTED");
    assert.equal(result.phase4Result, null);
  }
});

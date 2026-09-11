import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE4_CANONICAL_SELECTION_POLICY_VERSION,
  PHASE4_CANONICAL_SELECTION_RULE,
  resolvePhase4CanonicalFinalistV1,
  runPhase4CanonicalFrozenChallengerV1,
} from "../src/phase4-canonical-finalist-selection-policy-v1.js";
import {
  buildPhase3StrategyFamilyRegistryV1,
  createPhase3CandidateIdentityV1,
} from "../src/phase3-strategy-tournament-core-v1.js";

const D = (char) => char.repeat(64);
const FREEZE_TIME = "2026-09-11T11:00:00.000Z";

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
    backtestCompatibility: { owner: "#690", engine: "runIndependentSignalBacktest", executionEquivalentRequired: true },
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
    executionRealismEvidence: Object.freeze({ credited: false, observations: Object.freeze([]) }),
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

test("canonical policy selects the unique Phase3 rank-1 finalist only", () => {
  const f = fixture();
  const result = resolvePhase4CanonicalFinalistV1(f);
  assert.equal(result.status, "CANONICAL_FINALIST_SELECTED");
  assert.equal(result.candidateId, f.identity.candidateId);
  assert.equal(result.admission.rank, 1);
  assert.equal(result.selectionPolicy.policyVersion, PHASE4_CANONICAL_SELECTION_POLICY_VERSION);
  assert.equal(result.selectionPolicy.canonicalSelectionRule, PHASE4_CANONICAL_SELECTION_RULE);
  assert.equal(result.selectionPolicy.requiredRank, 1);
  assert.equal(result.selectionPolicy.fallbackToLowerRankAllowed, false);
  assert.equal(result.selectionPolicy.skipInvalidHigherRankAllowed, false);
  assert.equal(result.selectionPolicy.validationOutcomeConsulted, false);
  assert.equal(result.selectionPolicy.oosOutcomeConsulted, false);
  assert.equal(result.selectionPolicy.paperOutcomeConsulted, false);
  assert.equal(result.selectionPolicy.settlementOutcomeConsulted, false);
  assert.equal(result.selectionPolicy.futurePnlConsulted, false);
  assert.equal(result.selectionPolicy.futureFillConsulted, false);
});

test("missing canonical rank-1 does not fall through to rank 2", () => {
  const f = fixture();
  const tournamentResult = { ...f.tournamentResult, finalists: [{ ...f.finalist, rank: 2 }] };
  const result = resolvePhase4CanonicalFinalistV1({ tournamentResult, tournamentInput: f.tournamentInput });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "FINALIST_NOT_ADMISSIBLE");
  assert.equal(result.detail, "CANONICAL_RANK_1_MISSING");
  assert.equal(result.candidateId, null);
});

test("duplicate canonical rank-1 is rejected deterministically", () => {
  const f = fixture();
  const tournamentResult = { ...f.tournamentResult, finalists: [f.finalist, { ...f.finalist }] };
  const result = resolvePhase4CanonicalFinalistV1({ tournamentResult, tournamentInput: f.tournamentInput });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "FINALIST_NOT_ADMISSIBLE");
  assert.equal(result.detail, "CANONICAL_RANK_1_DUPLICATED");
});

test("invalid rank-1 blocks instead of cherry-picking a valid lower rank", () => {
  const f = fixture();
  const invalidRankOne = { ...f.finalist, candidateId: `phase3-candidate:sha256:${D("f")}`, rank: 1 };
  const validRankTwo = { ...f.finalist, rank: 2 };
  const tournamentResult = { ...f.tournamentResult, finalists: [invalidRankOne, validRankTwo] };
  const result = resolvePhase4CanonicalFinalistV1({ tournamentResult, tournamentInput: f.tournamentInput });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "FINALIST_IDENTITY_INVALID");
  assert.equal(result.detail, "CANONICAL_RANK_1_FAILED_ADMISSION_NO_FALLBACK");
});

test("canonical runner rejects manual candidate or selection-policy overrides", () => {
  const f = fixture();
  const candidateOverride = runPhase4CanonicalFrozenChallengerV1({
    ...f,
    candidateId: f.identity.candidateId,
    freezeTimestamp: FREEZE_TIME,
  });
  assert.equal(candidateOverride.status, "BLOCKED");
  assert.equal(candidateOverride.detail, "MANUAL_FINALIST_OVERRIDE_REJECTED");

  const policyOverride = runPhase4CanonicalFrozenChallengerV1({
    ...f,
    selectionPolicy: {},
    freezeTimestamp: FREEZE_TIME,
  });
  assert.equal(policyOverride.status, "BLOCKED");
  assert.equal(policyOverride.detail, "MANUAL_FINALIST_OVERRIDE_REJECTED");
});

test("canonical rank-1 path reaches frozen challenger contract without creating economic credit", () => {
  const f = fixture();
  const result = runPhase4CanonicalFrozenChallengerV1({
    tournamentResult: f.tournamentResult,
    tournamentInput: f.tournamentInput,
    freezeTimestamp: FREEZE_TIME,
  });
  assert.equal(result.status, "PROSPECTIVE_ADMISSION_READY");
  assert.equal(result.admission.rank, 1);
  assert.equal(result.challenger.candidateId, f.identity.candidateId);
  assert.equal(result.challenger.prospectiveOnly, true);
  assert.equal(result.challenger.retroactiveCreditAllowed, false);
  assert.equal(result.executionRealismCredit, 0);
  assert.equal(result.profitabilityCredit, 0);
  assert.equal(result.FULL_COST_READY, false);
  assert.equal(result.NET_ALPHA_PROVEN, false);
  assert.equal(result.PROFITABILITY_PROVEN, false);
  assert.equal(result.CHAMPION, "NONE");
  assert.equal(result.handoffs.forward.activationAllowed, false);
  assert.equal(result.handoffs.shadow.activationAllowed, false);
  assert.equal(result.handoffs.paper.activationAllowed, false);
});

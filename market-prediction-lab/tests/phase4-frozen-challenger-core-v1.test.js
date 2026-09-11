import assert from "node:assert/strict";
import test from "node:test";

import {
  admitPhase3FinalistV1,
  assertPhase4OutcomeFirewallV1,
  auditCurrentPhase1PaperNamespaceV1,
  bindPhase4FinalistSelectionPolicyV1,
  buildPhase4ProspectiveHandoffsV1,
  evaluatePhase4ProspectiveEvidenceV1,
  freezePhase4ChallengerV1,
  runPhase4FrozenChallengerCoreV1,
  verifyPhase4FrozenChallengerV1,
  verifyPhase4HandoffIdentityV1,
} from "../src/phase4-frozen-challenger-core-v1.js";
import {
  PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1,
  verifyPublicForwardLiquidityMultiLanePolicyV1,
} from "../../market-intelligence-sidecar/src/public-forward-liquidity-multi-lane-policy-v1.mjs";
import {
  buildPhase3StrategyFamilyRegistryV1,
  createPhase3CandidateIdentityV1,
  phase3DigestV1,
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

function universe(overrides = {}) {
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
    ...overrides,
  };
}

function fixture() {
  const registry = buildPhase3StrategyFamilyRegistryV1([family()]);
  const identity = createPhase3CandidateIdentityV1({
    family: registry.families[0],
    universeEntry: universe(),
    parameters: { fast: 3, slow: 8 },
  });
  const tournamentRunId = "phase3-tournament:sha256:" + D("a");
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
    selectionReason: "PHASE3_FINALIST",
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
  const tournamentInput = Object.freeze({ families: Object.freeze([family()]), universe: Object.freeze([universe()]) });
  const selectionPolicy = Object.freeze({
    schemaVersion: "phase4-finalist-selection-policy-v1",
    policyVersion: "human-precommit-v1",
    selectionRule: "PRECOMMITTED_EXPLICIT_FINALIST_ID",
    selectionAuthority: "HUMAN_FROZEN_POLICY",
    tournamentRunId,
    selectedCandidateId: identity.candidateId,
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
  return { identity, finalist, tournamentResult, tournamentInput, selectionPolicy };
}

function admitted() {
  const f = fixture();
  const result = admitPhase3FinalistV1({
    tournamentResult: f.tournamentResult,
    tournamentInput: f.tournamentInput,
    candidateId: f.identity.candidateId,
  });
  assert.equal(result.status, "ACCEPTED");
  return { ...f, admission: result.admission };
}

function frozen() {
  const f = admitted();
  const bound = bindPhase4FinalistSelectionPolicyV1({ admission: f.admission, selectionPolicy: f.selectionPolicy });
  assert.equal(bound.status, "BOUND");
  const result = freezePhase4ChallengerV1({ admission: f.admission, selection: bound.selection, freezeTimestamp: FREEZE_TIME });
  assert.equal(result.status, "FROZEN");
  return { ...f, selection: bound.selection, challenger: result.challenger };
}

function futureEvidence(challenger, overrides = {}) {
  return {
    observedAtMs: challenger.prospectiveBoundaryMs + 1,
    candidateId: challenger.candidateId,
    strategyFamily: challenger.strategyFamily,
    parameterDigest: challenger.parameterDigest,
    market: challenger.market,
    symbol: challenger.symbol,
    timeframe: challenger.timeframe,
    side: challenger.sidePolicy,
    accountMode: challenger.accountMode,
    replay: false,
    backfill: false,
    synthetic: false,
    manual: false,
    historical: false,
    retroactive: false,
    ...overrides,
  };
}

test("valid Phase3 finalist is admitted from its original immutable tournament input", () => {
  const f = admitted();
  assert.equal(f.admission.candidateId, f.identity.candidateId);
  assert.equal(f.admission.market, "BINANCE_SPOT_PUBLIC");
  assert.equal(f.admission.symbol, "BTCUSDT");
  assert.equal(f.admission.timeframe, "15m");
  assert.equal(f.admission.sidePolicy, "BUY");
  assert.equal(f.admission.provider, null);
});

test("non-finalist candidate is rejected", () => {
  const f = fixture();
  const result = admitPhase3FinalistV1({ ...f, candidateId: `phase3-candidate:sha256:${D("f")}` });
  assert.equal(result.reason, "FINALIST_NOT_ADMISSIBLE");
});

test("missing tournament lineage is rejected", () => {
  const f = fixture();
  const tournamentResult = { ...f.tournamentResult, tournamentRunId: "" };
  const result = admitPhase3FinalistV1({ tournamentResult, tournamentInput: f.tournamentInput, candidateId: f.identity.candidateId });
  assert.equal(result.reason, "TOURNAMENT_LINEAGE_MISSING");
});

test("forged finalist candidate digest is rejected", () => {
  const f = fixture();
  const finalist = { ...f.finalist, candidateId: `phase3-candidate:sha256:${D("f")}` };
  const tournamentResult = { ...f.tournamentResult, finalists: [finalist] };
  const result = admitPhase3FinalistV1({ tournamentResult, tournamentInput: f.tournamentInput, candidateId: finalist.candidateId });
  assert.equal(result.reason, "FINALIST_IDENTITY_INVALID");
});

test("ambiguous identity reconstruction fails closed", () => {
  const f = fixture();
  const result = admitPhase3FinalistV1({
    tournamentResult: f.tournamentResult,
    tournamentInput: { ...f.tournamentInput, universe: [universe(), universe()] },
    candidateId: f.identity.candidateId,
  });
  assert.equal(result.reason, "FINALIST_IDENTITY_INVALID");
});

test("selection policy is mandatory and rank 1 is never an implicit default", () => {
  const f = admitted();
  const result = bindPhase4FinalistSelectionPolicyV1({ admission: f.admission });
  assert.equal(result.reason, "FINALIST_SELECTION_POLICY_MISSING");
  assert.equal(result.PROFITABILITY_PROVEN, false);
});

test("selection policy must bind the exact finalist and prohibit outcome consultation", () => {
  const f = admitted();
  for (const patch of [
    { selectedCandidateId: `phase3-candidate:sha256:${D("e")}` },
    { validationOutcomeConsulted: true },
    { oosOutcomeConsulted: true },
    { paperOutcomeConsulted: true },
    { settlementOutcomeConsulted: true },
    { futurePnlConsulted: true },
    { futureFillConsulted: true },
    { championStatusConsulted: true },
    { postOutcomeManualSelection: true },
  ]) {
    const result = bindPhase4FinalistSelectionPolicyV1({ admission: f.admission, selectionPolicy: { ...f.selectionPolicy, ...patch } });
    assert.equal(result.reason, "FREEZE_POLICY_MISSING");
  }
});

test("selection policy binding is deterministic", () => {
  const f = admitted();
  const a = bindPhase4FinalistSelectionPolicyV1({ admission: f.admission, selectionPolicy: f.selectionPolicy });
  const reordered = Object.fromEntries(Object.entries(f.selectionPolicy).reverse());
  const b = bindPhase4FinalistSelectionPolicyV1({ admission: f.admission, selectionPolicy: reordered });
  assert.equal(a.selection.selectionPolicyDigest, b.selection.selectionPolicyDigest);
});

test("same finalist and same policy produce the same freeze identity independent of timestamp", () => {
  const f = admitted();
  const bound = bindPhase4FinalistSelectionPolicyV1({ admission: f.admission, selectionPolicy: f.selectionPolicy });
  const a = freezePhase4ChallengerV1({ admission: f.admission, selection: bound.selection, freezeTimestamp: FREEZE_TIME });
  const b = freezePhase4ChallengerV1({ admission: f.admission, selection: bound.selection, freezeTimestamp: "2026-09-11T12:00:00.000Z" });
  assert.equal(a.challenger.freezeDigest, b.challenger.freezeDigest);
  assert.equal(a.challenger.challengerId, b.challenger.challengerId);
  assert.notEqual(a.challenger.freezeTimestamp, b.challenger.freezeTimestamp);
});

test("freeze digest is canonical under parameter key order", () => {
  const f = fixture();
  const reversedFinalist = { ...f.finalist, parameters: { slow: 8, fast: 3 } };
  const tournamentResult = { ...f.tournamentResult, finalists: [reversedFinalist] };
  const admission = admitPhase3FinalistV1({ tournamentResult, tournamentInput: f.tournamentInput, candidateId: f.identity.candidateId });
  assert.equal(admission.status, "ACCEPTED");
  const bound = bindPhase4FinalistSelectionPolicyV1({ admission: admission.admission, selectionPolicy: f.selectionPolicy });
  const a = freezePhase4ChallengerV1({ admission: admitted().admission, selection: bindPhase4FinalistSelectionPolicyV1({ admission: admitted().admission, selectionPolicy: f.selectionPolicy }).selection, freezeTimestamp: FREEZE_TIME });
  const b = freezePhase4ChallengerV1({ admission: admission.admission, selection: bound.selection, freezeTimestamp: FREEZE_TIME });
  assert.equal(a.challenger.freezeDigest, b.challenger.freezeDigest);
});

test("parameter mutation changes the canonical Phase3 candidate identity instead of rewriting a frozen challenger", () => {
  const f = fixture();
  const registry = buildPhase3StrategyFamilyRegistryV1([family()]);
  const changed = createPhase3CandidateIdentityV1({ family: registry.families[0], universeEntry: universe(), parameters: { fast: 4, slow: 8 } });
  assert.notEqual(changed.candidateId, f.identity.candidateId);
  assert.notEqual(changed.parameterDigest, f.identity.parameterDigest);
});

test("post-freeze parameter mutation is rejected", () => {
  const f = frozen();
  const changed = { ...f.challenger, canonicalParameters: { fast: 4, slow: 8 } };
  assert.equal(verifyPhase4FrozenChallengerV1(changed).reason, "FREEZE_IDENTITY_MISMATCH");
});

test("post-freeze strategy mutation is rejected", () => {
  const f = frozen();
  assert.equal(verifyPhase4FrozenChallengerV1({ ...f.challenger, strategyFamily: "OTHER" }).reason, "FREEZE_IDENTITY_MISMATCH");
});

test("post-freeze symbol mutation is rejected", () => {
  const f = frozen();
  assert.equal(verifyPhase4FrozenChallengerV1({ ...f.challenger, symbol: "ETHUSDT" }).reason, "FREEZE_IDENTITY_MISMATCH");
});

test("post-freeze timeframe mutation is rejected", () => {
  const f = frozen();
  assert.equal(verifyPhase4FrozenChallengerV1({ ...f.challenger, timeframe: "1h" }).reason, "FREEZE_IDENTITY_MISMATCH");
});

test("post-freeze side mutation is rejected", () => {
  const f = frozen();
  assert.equal(verifyPhase4FrozenChallengerV1({ ...f.challenger, sidePolicy: "SELL" }).reason, "FREEZE_IDENTITY_MISMATCH");
});

test("validation result cannot enter freeze input", () => {
  assert.equal(assertPhase4OutcomeFirewallV1({ validationResult: { net: 1 } }).reason, "VALIDATION_LEAKAGE_REJECTED");
});

test("OOS result cannot enter freeze input", () => {
  assert.equal(assertPhase4OutcomeFirewallV1({ oosResult: { net: 1 } }).reason, "OOS_LEAKAGE_REJECTED");
});

test("Paper and Settlement outcomes cannot enter freeze input", () => {
  assert.equal(assertPhase4OutcomeFirewallV1({ paperResult: { net: 1 } }).reason, "VALIDATION_LEAKAGE_REJECTED");
  assert.equal(assertPhase4OutcomeFirewallV1({ settlementResult: { net: 1 } }).reason, "VALIDATION_LEAKAGE_REJECTED");
});

test("pre-freeze observation cannot receive new prospective credit", () => {
  const f = frozen();
  const handoff = buildPhase4ProspectiveHandoffsV1(f.challenger).handoffs.prospective;
  const result = evaluatePhase4ProspectiveEvidenceV1({ handoff, evidence: futureEvidence(f.challenger, { observedAtMs: f.challenger.prospectiveBoundaryMs }) });
  assert.equal(result.reason, "RETROACTIVE_CREDIT_REJECTED");
  assert.equal(result.economicCreditCreated, false);
});

test("replay backfill synthetic manual and historical evidence are rejected", () => {
  const f = frozen();
  const handoff = buildPhase4ProspectiveHandoffsV1(f.challenger).handoffs.prospective;
  for (const flag of ["replay", "backfill", "synthetic", "manual", "historical", "retroactive"]) {
    const result = evaluatePhase4ProspectiveEvidenceV1({ handoff, evidence: futureEvidence(f.challenger, { [flag]: true }) });
    assert.equal(result.reason, "RETROACTIVE_CREDIT_REJECTED");
    assert.equal(result.sampleCredit ?? 0, 0);
  }
});

test("genuine future evidence may become an admission candidate but creates zero economic credit", () => {
  const f = frozen();
  const handoff = buildPhase4ProspectiveHandoffsV1(f.challenger).handoffs.prospective;
  const result = evaluatePhase4ProspectiveEvidenceV1({ handoff, evidence: futureEvidence(f.challenger) });
  assert.equal(result.admitted, true);
  assert.equal(result.sampleCredit, 0);
  assert.equal(result.executionRealismCredit, 0);
  assert.equal(result.profitabilityCredit, 0);
});

test("future evidence identity mismatch fails closed", () => {
  const f = frozen();
  const handoff = buildPhase4ProspectiveHandoffsV1(f.challenger).handoffs.prospective;
  const result = evaluatePhase4ProspectiveEvidenceV1({ handoff, evidence: futureEvidence(f.challenger, { symbol: "ETHUSDT" }) });
  assert.equal(result.reason, "HANDOFF_IDENTITY_MISMATCH");
});

test("Forward handoff preserves the frozen identity and never activates or dispatches", () => {
  const f = frozen();
  const handoff = buildPhase4ProspectiveHandoffsV1(f.challenger).handoffs.forward;
  const result = verifyPhase4HandoffIdentityV1({ challenger: f.challenger, handoff });
  assert.equal(result.valid, true);
  assert.equal(handoff.activationAllowed, false);
  assert.equal(handoff.dispatchAllowed, false);
});

test("Shadow handoff preserves the frozen identity", () => {
  const f = frozen();
  const handoff = buildPhase4ProspectiveHandoffsV1(f.challenger).handoffs.shadow;
  assert.equal(verifyPhase4HandoffIdentityV1({ challenger: f.challenger, handoff }).valid, true);
});

test("Paper handoff preserves the frozen identity without creating a second candidate ID", () => {
  const f = frozen();
  const handoff = buildPhase4ProspectiveHandoffsV1(f.challenger).handoffs.paper;
  assert.equal(verifyPhase4HandoffIdentityV1({ challenger: f.challenger, handoff }).valid, true);
  assert.equal(handoff.candidateId, f.challenger.candidateId);
});

test("tampered handoff candidate identity fails closed", () => {
  const f = frozen();
  const handoff = buildPhase4ProspectiveHandoffsV1(f.challenger).handoffs.forward;
  const result = verifyPhase4HandoffIdentityV1({ challenger: f.challenger, handoff: { ...handoff, candidateId: `phase3-candidate:sha256:${D("e")}` } });
  assert.equal(result.reason, "HANDOFF_IDENTITY_MISMATCH");
});

test("freeze keeps alpha evidence separate from execution realism and profitability", () => {
  const f = frozen();
  assert.equal(f.challenger.executionRealismCredit, 0);
  assert.equal(f.challenger.profitabilityCredit, 0);
  assert.equal(f.challenger.FULL_COST_READY, false);
});

test("truth locks remain false after successful freeze", () => {
  const f = frozen();
  assert.equal(f.challenger.PROFITABILITY_PROVEN, false);
  assert.equal(f.challenger.NET_ALPHA_PROVEN, false);
  assert.equal(f.challenger.CHAMPION, "NONE");
  assert.equal(f.challenger.FULL_COST_READY, false);
});

test("same finalist freeze is idempotent and resolves to one canonical challenger ID", () => {
  const a = frozen().challenger;
  const b = frozen().challenger;
  assert.equal(a.challengerId, b.challengerId);
  assert.equal(a.freezeDigest, b.freezeDigest);
});

test("orchestrator stops at FINALIST_SELECTION_POLICY_MISSING when no human frozen policy is supplied", () => {
  const f = fixture();
  const result = runPhase4FrozenChallengerCoreV1({
    tournamentResult: f.tournamentResult,
    tournamentInput: f.tournamentInput,
    candidateId: f.identity.candidateId,
    freezeTimestamp: FREEZE_TIME,
  });
  assert.equal(result.reason, "FINALIST_SELECTION_POLICY_MISSING");
  assert.equal(result.PROFITABILITY_PROVEN, false);
  assert.equal(result.CHAMPION, "NONE");
});

test("orchestrator reaches prospective-admission-ready only with an explicit precommitted policy", () => {
  const f = fixture();
  const result = runPhase4FrozenChallengerCoreV1({
    tournamentResult: f.tournamentResult,
    tournamentInput: f.tournamentInput,
    candidateId: f.identity.candidateId,
    selectionPolicy: f.selectionPolicy,
    freezeTimestamp: FREEZE_TIME,
  });
  assert.equal(result.status, "PROSPECTIVE_ADMISSION_READY");
  assert.equal(result.observability.FROZEN_CHALLENGER_COUNT, 1);
  assert.equal(result.observability.FORWARD_HANDOFF_STATUS, "CONTRACT_READY");
  assert.equal(result.observability.SHADOW_HANDOFF_STATUS, "CONTRACT_READY");
  assert.equal(result.observability.PAPER_HANDOFF_STATUS, "CONTRACT_READY");
  assert.equal(result.PROFITABILITY_PROVEN, false);
});

test("current Phase1 Paper namespace incompatibility is surfaced, never silently translated", () => {
  const f = frozen();
  const audit = auditCurrentPhase1PaperNamespaceV1(f.challenger);
  assert.equal(audit.compatible, false);
  assert.equal(audit.reason, "PAPER_CANDIDATE_ID_NAMESPACE_INCOMPATIBLE");
  assert.equal(audit.candidateIdPreserved, true);
  assert.equal(audit.secondIdentityCreated, false);
});

test("source finalist digest changes when finalist provenance changes", () => {
  const f = admitted();
  const first = f.admission.sourceFinalistDigest;
  const changed = phase3DigestV1({ ...f.finalist, selectionReason: "DIFFERENT" });
  assert.notEqual(first, changed);
});

test("Phase 2 frozen multi-lane policy remains valid and grants no retroactive or UTC27 credit", () => {
  const verdict = verifyPublicForwardLiquidityMultiLanePolicyV1();
  assert.equal(verdict.valid, true);
  const config = PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.config;
  assert.equal(config.utc27Policy.additionalIndependentCredit, 0);
  assert.equal(config.utc27Policy.thirdLaneAllowed, false);
  assert.equal(config.activationPolicy.preBoundaryObservationCredit, 0);
  assert.equal(config.activationPolicy.manualWorkflowDispatchEligible, false);
  assert.equal(config.activationPolicy.replayEligible, false);
  assert.equal(config.activationPolicy.backfillEligible, false);
  for (const key of ["manualCredit", "replayCredit", "backfillCredit", "syntheticCredit", "operatorSelectedCredit", "rerunCredit"]) {
    assert.equal(config.creditPolicy[key], 0);
  }
});

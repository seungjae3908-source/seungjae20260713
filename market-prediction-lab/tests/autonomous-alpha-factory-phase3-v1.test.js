import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE3_DEFAULT_BUDGET,
  PHASE3_DEFAULT_SETTLEMENT_POLICY,
  PHASE3_DEFAULT_SHADOW_POLICY,
  PHASE3_EVIDENCE_STATUSES,
  PHASE3_HEALTH_DIMENSIONS,
  PHASE3_NATURAL_PAPER_STAGE_ORDER,
  PHASE3_SAFETY,
  admitResearchSurvivorToShadowV1,
  admitShadowToNaturalPaperV1,
  buildFailureResearchRestartV1,
  buildPhase3ResearchReadModelV1,
  buildPhase3StrategyHealthV1,
  buildProfitabilityTruthV1,
  createResearchFailureObservationV1,
  createShadowForwardObservationV1,
  evaluateNaturalPaperSufficiencyV1,
  evaluateSettlementEvidenceV1,
  evaluateShadowSufficiencyV1,
  selectPhase3ChampionsV1,
  validateNaturalPaperCycleV1,
} from "../src/autonomous-alpha-factory-phase3-v1.js";
import { resolveCanonicalStrategyIdentity } from "../src/canonical-strategy-identity-v1.js";
import { sha256Canonical } from "../src/research-cache-provenance.js";

const OBSERVED_AT = "2026-08-26T02:00:00.000Z";

function identityInput(overrides = {}) {
  const formulaIdentity = {
    strategyFamily: "PHASE3_TEST",
    entry: { kind: "CROSSOVER", fast: 5, slow: 20 },
    exit: { kind: "TIME", bars: 4 },
  };
  return {
    strategyId: "strategy-phase3-v1",
    strategyFamily: "PHASE3_TEST",
    strategyVersion: "1.0.0",
    market: "US_STOCK",
    direction: "LONG",
    timeframe: "15m",
    formulaIdentity,
    formulaHash: sha256Canonical(formulaIdentity),
    parameterHash: "a".repeat(64),
    researchCodeSha: "b".repeat(40),
    datasetId: "dataset:phase3:v1",
    datasetDigest: "c".repeat(64),
    datasetStart: "2025-01-01T00:00:00.000Z",
    datasetEnd: "2026-01-01T00:00:00.000Z",
    costPolicyVersion: "COST_V1",
    riskPolicyVersion: "RISK_V1",
    evidenceSchemaVersion: "EVIDENCE_V1",
    ...overrides,
  };
}

function digestEvidence(label, boundStrategyIdentityDigest = null) {
  return {
    status: "VALID",
    evidenceDigest: sha256Canonical({ label, boundStrategyIdentityDigest }),
    ...(boundStrategyIdentityDigest ? { boundStrategyIdentityDigest } : {}),
  };
}

function survivor(overrides = {}) {
  const identity = identityInput();
  const tournamentStages = Object.fromEntries([
    "SANITY_CHECK",
    "HISTORICAL_BACKTEST",
    "OOS",
    "PURGED_OOS",
    "WALK_FORWARD",
    "COST_STRESS",
    "REGIME_STRESS",
    "STATISTICAL_FIREWALL",
    "FINAL_HOLDOUT",
  ].map((stage) => [stage, { status: "PASS", evidenceDigest: sha256Canonical({ stage }) }]));
  return {
    schemaVersion: "research-survivor-evidence-v1",
    status: "PASS",
    researchSurvivor: true,
    strategyId: identity.strategyId,
    formulaHash: identity.formulaHash,
    hypothesisId: "hypothesis-phase3-v1",
    parameterIdentity: identity.parameterHash,
    datasetIdentity: { datasetId: identity.datasetId, datasetDigest: identity.datasetDigest },
    costPolicyIdentity: identity.costPolicyVersion,
    riskPolicyIdentity: identity.riskPolicyVersion,
    finalHoldout: { status: "PASS", evidenceDigest: sha256Canonical({ stage: "FINAL_HOLDOUT" }) },
    statisticalFirewall: { status: "PASS", evidenceDigest: sha256Canonical({ stage: "STATISTICAL_FIREWALL" }) },
    tournamentStages,
    provenance: digestEvidence("survivor"),
    ...overrides,
  };
}

function shadowCandidate() {
  const result = admitResearchSurvivorToShadowV1({
    survivorEvidence: survivor(),
    strategyIdentity: identityInput(),
    observedAt: OBSERVED_AT,
  });
  assert.equal(result.status, "PASS");
  return result.shadowCandidate;
}

function shadowObservation(candidate, index, overrides = {}) {
  const timestamp = new Date(Date.parse("2026-08-01T00:00:00.000Z") + (index * 86_400_000)).toISOString();
  const input = {
    observationId: `shadow-${index}`,
    timestamp,
    outcomeObservedAt: new Date(Date.parse(timestamp) + 900_000).toISOString(),
    symbol: index % 2 ? "MSFT" : "AAPL",
    timeframe: "15m",
    market: "US_STOCK",
    strategyIdentityDigest: candidate.strategyIdentityDigest,
    signal: ["LONG", "SHORT", "NEUTRAL"][index % 3],
    confidence: 0.7,
    expectedAction: "OBSERVE_ONLY",
    actualDirection: ["LONG", "SHORT", "NEUTRAL"][index % 3],
    regime: ["BULL", "BEAR", "SIDEWAYS"][index % 3],
    chronologicalSlice: index < 10 ? "OLDEST" : index < 20 ? "MIDDLE" : "NEWEST",
    featureProvenance: digestEvidence(`feature-${index}`, candidate.strategyIdentityDigest),
    modelRuleProvenance: digestEvidence(`model-${index}`, candidate.strategyIdentityDigest),
    datasetFreshness: { status: "FRESH", ageMs: 100, maxAgeMs: 1_000 },
    sourceKind: "NATURAL_FORWARD",
    replay: false,
    historical: false,
    synthetic: false,
    executionAuthority: "NONE",
    orderSubmitted: false,
    ...overrides,
  };
  const result = createShadowForwardObservationV1({ shadowCandidate: candidate, observation: input });
  assert.equal(result.status, "PASS");
  return result.observation;
}

function shadowHandoff(candidate, overrides = {}) {
  const body = {
    schemaVersion: "prediction-lab-strategy-health-shadow-handoff-v1",
    strategyIdentity: candidate.strategyIdentity,
    strategyIdentityDigest: candidate.strategyIdentityDigest,
    directionalQuality: { sampleN: 30, settledN: 30 },
    driftVerdict: { status: "STABLE" },
    driftMetrics: [{ status: "MEASURED", psi: 0.01, ksStatistic: 0.02, jsd: 0.03 }],
    referenceRawSampleAvailable: true,
    freshness: {
      status: "FRESH",
      checkedAt: "2026-08-26T01:00:00.000Z",
      expiresAt: "2026-09-26T00:00:00.000Z",
    },
    executionAuthority: "NONE",
    ...overrides,
  };
  return { ...body, evidenceDigest: sha256Canonical(body) };
}

function passingShadow(candidate = shadowCandidate()) {
  const observations = Array.from({ length: 30 }, (_, index) => shadowObservation(candidate, index));
  const evaluation = evaluateShadowSufficiencyV1({
    shadowCandidate: candidate,
    observations,
    canonicalShadowHandoff: shadowHandoff(candidate),
    observedAt: OBSERVED_AT,
  });
  assert.equal(evaluation.status, "PASS");
  return { candidate, observations, evaluation };
}

function naturalCandidate() {
  const shadow = passingShadow();
  const admission = admitShadowToNaturalPaperV1({
    shadowCandidate: shadow.candidate,
    shadowEvaluation: shadow.evaluation,
    paperCapability: { paperOnly: true, executionAuthority: "NONE", safety: PHASE3_SAFETY },
    observedAt: OBSERVED_AT,
  });
  assert.equal(admission.status, "PASS");
  return admission.naturalPaperCandidate;
}

function stageRows(overrides = {}) {
  return PHASE3_NATURAL_PAPER_STAGE_ORDER.map((stage) => ({
    stage,
    status: "PASS",
    count: 1,
    reason: null,
    ...overrides[stage],
  }));
}

function naturalCycleInput(candidate, index = 0, overrides = {}) {
  return {
    naturalCycleId: `natural-${index}`,
    candidateId: candidate.candidateId,
    strategyId: candidate.strategyId,
    strategyIdentityDigest: candidate.strategyIdentityDigest,
    timestamp: new Date(Date.parse("2026-08-01T00:00:00.000Z") + (index * 86_400_000)).toISOString(),
    market: "US_STOCK",
    symbol: "AAPL",
    timeframe: "15m",
    provenance: digestEvidence(`natural-${index}`, candidate.strategyIdentityDigest),
    triggerSource: "NATURAL_FORWARD",
    flags: {},
    mutationIdentity: candidate.strategyIdentityDigest,
    stages: stageRows(),
    executionAuthority: "NONE",
    networkCalls: 0,
    privateApiCalls: 0,
    orderCalls: 0,
    ...overrides,
  };
}

function naturalCycle(candidate, index = 0, overrides = {}) {
  const result = validateNaturalPaperCycleV1({
    naturalPaperCandidate: candidate,
    cycle: naturalCycleInput(candidate, index, overrides),
  });
  assert.equal(result.status, "PASS");
  return result.evidence;
}

function costCells(overrides = {}) {
  return Object.fromEntries([
    ["commission", 0.1],
    ["spread", 0.1],
    ["slippage", 0.1],
    ["funding", 0.1],
    ["tax", 0.1],
    ["latency", 0.1],
    ["liquidityImpact", 0.1],
  ].map(([field, value]) => [field, overrides[field] ?? { value, evidenceId: `cost:${field}` }]));
}

function settlement(candidate, cycle, index = 0, overrides = {}) {
  const day = new Date(Date.parse("2026-08-01T10:00:00.000Z") + (index * 86_400_000));
  const netPnl = index % 4 === 0 ? -0.2 : 1;
  return {
    settlementId: `settlement-${index}`,
    naturalCycleId: cycle.naturalCycleId,
    strategyIdentityDigest: candidate.strategyIdentityDigest,
    entryTimestamp: day.toISOString(),
    exitTimestamp: new Date(day.getTime() + 3_600_000).toISOString(),
    entryPrice: 100,
    exitPrice: 101,
    quantity: 1,
    side: index % 2 ? "SHORT" : "LONG",
    leverage: 1,
    grossPnl: netPnl + 0.7,
    costs: costCells(),
    netPnl,
    return: netPnl / 100,
    mfe: 0.02,
    mae: 0.01,
    holdingPeriodMs: 3_600_000,
    exitReason: "TIME_EXIT",
    marketRegime: ["BULL", "BEAR", "SIDEWAYS"][index % 3],
    provenance: digestEvidence(`settlement-${index}`, candidate.strategyIdentityDigest),
    replay: false,
    duplicate: false,
    synthetic: false,
    historical: false,
    ...overrides,
  };
}

function historicalPass() {
  return Object.fromEntries([
    "historicalRobustness",
    "oosRobustness",
    "walkForwardStability",
    "costRobustness",
    "regimeRobustness",
    "statisticalConfidence",
  ].map((key) => [key, "PASS"]));
}

test("contract exposes exact status, funnel, health, budget, and no-authority vocabularies", () => {
  assert.deepEqual(PHASE3_EVIDENCE_STATUSES, ["PASS", "FAIL", "MISSING_EVIDENCE", "NOT_EVALUABLE"]);
  assert.equal(PHASE3_NATURAL_PAPER_STAGE_ORDER.length, 8);
  assert.equal(PHASE3_HEALTH_DIMENSIONS.length, 11);
  assert.equal(PHASE3_DEFAULT_BUDGET.maxActiveShadowStrategies, 8);
  assert.equal(PHASE3_SAFETY.executionAuthority, "NONE");
  assert.equal(PHASE3_SAFETY.REAL_ORDER_ENABLED, false);
});

test("only a strict Research Survivor can enter Shadow", () => {
  const pass = admitResearchSurvivorToShadowV1({ survivorEvidence: survivor(), strategyIdentity: identityInput(), observedAt: OBSERVED_AT });
  assert.equal(pass.status, "PASS");
  assert.equal(pass.shadowCandidate.identityFrozen, true);
  assert.equal(pass.shadowCandidate.executionAuthority, "NONE");
  const failed = survivor({ status: "FAIL", researchSurvivor: false });
  const rejected = admitResearchSurvivorToShadowV1({ survivorEvidence: failed, strategyIdentity: identityInput(), observedAt: OBSERVED_AT });
  assert.notEqual(rejected.status, "PASS");
  assert.equal(rejected.admitted, false);
});

test("Tournament FAIL, MISSING_EVIDENCE, and NOT_EVALUABLE never enter Shadow", () => {
  for (const status of ["FAIL", "MISSING_EVIDENCE", "NOT_EVALUABLE"]) {
    const evidence = survivor();
    evidence.tournamentStages.OOS = { status, evidenceDigest: sha256Canonical({ status }) };
    const result = admitResearchSurvivorToShadowV1({ survivorEvidence: evidence, strategyIdentity: identityInput(), observedAt: OBSERVED_AT });
    assert.notEqual(result.status, "PASS");
    assert.equal(result.shadowCandidate, null);
  }
});

test("formula and parameter identity mutations are blocked before Shadow", () => {
  const formula = admitResearchSurvivorToShadowV1({
    survivorEvidence: survivor({ formulaHash: "d".repeat(64) }),
    strategyIdentity: identityInput(),
    observedAt: OBSERVED_AT,
  });
  assert.ok(formula.blockers.includes("FORMULA_IDENTITY_MISMATCH"));
  const parameter = admitResearchSurvivorToShadowV1({
    survivorEvidence: survivor({ parameterIdentity: "e".repeat(64) }),
    strategyIdentity: identityInput(),
    observedAt: OBSERVED_AT,
  });
  assert.ok(parameter.blockers.includes("PARAMETER_IDENTITY_MISMATCH"));
});

test("resource pressure is NOT_EVALUABLE_RESOURCE_LIMIT rather than fabricated FAIL", () => {
  const result = admitResearchSurvivorToShadowV1({
    survivorEvidence: survivor(),
    strategyIdentity: identityInput(),
    observedAt: OBSERVED_AT,
    resourceUsage: { activeShadowStrategies: PHASE3_DEFAULT_BUDGET.maxActiveShadowStrategies },
  });
  assert.equal(result.status, "NOT_EVALUABLE");
  assert.deepEqual(result.blockers, ["NOT_EVALUABLE_RESOURCE_LIMIT"]);
});

test("Shadow observation is forward-only and has structurally zero order authority", () => {
  const candidate = shadowCandidate();
  const valid = shadowObservation(candidate, 1);
  assert.equal(valid.sourceKind, "NATURAL_FORWARD");
  assert.equal(valid.executionAuthority, "NONE");
  assert.equal(valid.orderSubmitted, false);
  const rejected = createShadowForwardObservationV1({
    shadowCandidate: candidate,
    observation: {
      ...valid,
      observationId: "unsafe",
      outcomeObservedAt: "2026-08-27T00:00:00.000Z",
      executionAuthority: "LIVE",
    },
  });
  assert.equal(rejected.status, "FAIL");
  assert.ok(rejected.blockers.includes("SHADOW_ORDER_AUTHORITY_FORBIDDEN"));
});

test("support=0 keeps class recall N/A instead of numeric zero", () => {
  const candidate = shadowCandidate();
  const observations = [shadowObservation(candidate, 0, { signal: "LONG", actualDirection: "LONG", regime: "BULL" })];
  const policy = {
    ...PHASE3_DEFAULT_SHADOW_POLICY,
    minimumTotalN: 1,
    minimumIndependentDays: 1,
    minimumLongSupport: 1,
    minimumShortSupport: 0,
    minimumNeutralSupport: 0,
    minimumBullRegimeN: 1,
    minimumBearRegimeN: 0,
    minimumSidewaysRegimeN: 0,
    maximumCalibrationError: 1,
  };
  const result = evaluateShadowSufficiencyV1({ shadowCandidate: candidate, observations, canonicalShadowHandoff: shadowHandoff(candidate), observedAt: OBSERVED_AT, policy });
  assert.equal(result.status, "PASS");
  assert.equal(result.metrics.perClass.SHORT.support, 0);
  assert.equal(result.metrics.perClass.SHORT.recall, null);
  assert.equal(result.metrics.perClass.NEUTRAL.recall, null);
});

test("missing raw reference leaves PSI KS and JSD N/A and blocks sufficiency", () => {
  const candidate = shadowCandidate();
  const observations = Array.from({ length: 30 }, (_, index) => shadowObservation(candidate, index));
  const handoff = shadowHandoff(candidate, {
    driftVerdict: { status: "NOT_EVALUABLE" },
    driftMetrics: [],
    referenceRawSampleAvailable: false,
  });
  const result = evaluateShadowSufficiencyV1({ shadowCandidate: candidate, observations, canonicalShadowHandoff: handoff, observedAt: OBSERVED_AT });
  assert.equal(result.status, "MISSING_EVIDENCE");
  assert.equal(result.metrics.drift.status, "N/A");
  assert.equal(result.metrics.drift.psi, null);
  assert.equal(result.metrics.drift.ks, null);
  assert.equal(result.metrics.drift.jsd, null);
});

test("stale data and provenance substitution fail closed", () => {
  const candidate = shadowCandidate();
  const observations = Array.from({ length: 30 }, (_, index) => shadowObservation(candidate, index));
  const stale = shadowHandoff(candidate, { freshness: { status: "FRESH", expiresAt: "2026-08-25T00:00:00.000Z" } });
  const staleResult = evaluateShadowSufficiencyV1({ shadowCandidate: candidate, observations, canonicalShadowHandoff: stale, observedAt: OBSERVED_AT });
  assert.equal(staleResult.status, "FAIL");
  assert.ok(staleResult.blockers.includes("CANONICAL_SHADOW_HANDOFF_STALE"));

  const tampered = structuredClone(observations[0]);
  tampered.featureProvenance = digestEvidence("substituted-feature", "f".repeat(64));
  const body = { ...tampered };
  delete body.evidenceDigest;
  tampered.evidenceDigest = sha256Canonical(body);
  const provenance = evaluateShadowSufficiencyV1({
    shadowCandidate: candidate,
    observations: [tampered, ...observations.slice(1)],
    canonicalShadowHandoff: shadowHandoff(candidate),
    observedAt: OBSERVED_AT,
  });
  assert.equal(provenance.status, "FAIL");
  assert.ok(provenance.blockers.includes("SHADOW_PROVENANCE_MISMATCH"));
  assert.notEqual(tampered.featureProvenance.evidenceDigest, observations[0].featureProvenance.evidenceDigest);
});

test("Shadow collapse creates immutable failure observation and requires a new identity", () => {
  const candidate = shadowCandidate();
  const observations = Array.from({ length: 12 }, (_, index) => shadowObservation(candidate, index, {
    signal: "NEUTRAL",
    actualDirection: ["LONG", "SHORT", "NEUTRAL"][index % 3],
    regime: ["BULL", "BEAR", "SIDEWAYS"][index % 3],
  }));
  const policy = {
    ...PHASE3_DEFAULT_SHADOW_POLICY,
    minimumTotalN: 12,
    minimumIndependentDays: 1,
    minimumLongSupport: 1,
    minimumShortSupport: 1,
    minimumNeutralSupport: 1,
    minimumBullRegimeN: 1,
    minimumBearRegimeN: 1,
    minimumSidewaysRegimeN: 1,
    maximumCalibrationError: 1,
  };
  const result = evaluateShadowSufficiencyV1({ shadowCandidate: candidate, observations, canonicalShadowHandoff: shadowHandoff(candidate), observedAt: OBSERVED_AT, policy });
  assert.equal(result.status, "FAIL");
  assert.ok(result.blockers.includes("NEUTRAL_DOMINANCE"));
  assert.equal(result.failureObservation.sameStrategyMutationAllowed, false);
  assert.equal(result.failureObservation.newStrategyIdentityRequired, true);
  assert.equal(Object.isFrozen(result.failureObservation), true);
  const restart = buildFailureResearchRestartV1(result.failureObservation);
  assert.deepEqual(restart.next, ["NEW_HYPOTHESIS", "NEW_FORMULA_CANDIDATE", "NEW_STRATEGY_IDENTITY", "TOURNAMENT_RESTART"]);
  assert.equal(restart.priorSampleCreditInheritanceAllowed, false);
});

test("only sufficient stable Shadow enters Natural Paper", () => {
  const shadow = passingShadow();
  const pass = admitShadowToNaturalPaperV1({
    shadowCandidate: shadow.candidate,
    shadowEvaluation: shadow.evaluation,
    paperCapability: { paperOnly: true, executionAuthority: "NONE", safety: PHASE3_SAFETY },
    observedAt: OBSERVED_AT,
  });
  assert.equal(pass.status, "PASS");
  assert.equal(pass.naturalPaperCandidate.paperOnly, true);
  assert.equal(pass.naturalPaperCandidate.strategyIdentityFrozen, true);

  const missing = admitShadowToNaturalPaperV1({
    shadowCandidate: shadow.candidate,
    shadowEvaluation: { ...shadow.evaluation, status: "MISSING_EVIDENCE", sufficient: false },
    paperCapability: { paperOnly: true, executionAuthority: "NONE", safety: PHASE3_SAFETY },
    observedAt: OBSERVED_AT,
  });
  assert.equal(missing.status, "MISSING_EVIDENCE");
  assert.equal(missing.admitted, false);
});

test("natural trigger gets credit while replay duplicate historical and synthetic sources get zero", async (t) => {
  const candidate = naturalCandidate();
  const natural = naturalCycle(candidate);
  assert.equal(natural.naturalCredit, 1);
  assert.equal(natural.settlementCredit, 1);
  for (const [name, overrides, seen] of [
    ["replay", { flags: { replay: true } }, []],
    ["manual replay", { flags: { manualReplay: true } }, []],
    ["historical", { flags: { historicalBackfill: true } }, []],
    ["synthetic", { flags: { synthetic: true } }, []],
    ["duplicate", {}, ["natural-0"]],
  ]) {
    await t.test(name, () => {
      const result = validateNaturalPaperCycleV1({
        naturalPaperCandidate: candidate,
        cycle: naturalCycleInput(candidate, 0, overrides),
        seenCycleIds: seen,
      });
      assert.equal(result.evidence.naturalCredit, 0);
      assert.equal(result.evidence.replayCredit, 0);
      assert.equal(result.evidence.duplicateCredit, 0);
      assert.equal(result.evidence.historicalCredit, 0);
      assert.equal(result.evidence.syntheticCredit, 0);
    });
  }
});

test("Natural Paper enforces exact funnel ordering and records Entry Position Exit Eligible Settlement", () => {
  const candidate = naturalCandidate();
  const input = naturalCycleInput(candidate);
  [input.stages[3], input.stages[4]] = [input.stages[4], input.stages[3]];
  const result = validateNaturalPaperCycleV1({ naturalPaperCandidate: candidate, cycle: input });
  assert.equal(result.status, "FAIL");
  assert.ok(result.blockers.includes("NATURAL_FUNNEL_STAGE_ORDER_INVALID"));
  const valid = naturalCycle(candidate);
  assert.deepEqual(valid.stageOrder, PHASE3_NATURAL_PAPER_STAGE_ORDER);
  assert.equal(valid.stages.find((row) => row.stage === "ENTRY").status, "PASS");
  assert.equal(valid.stages.find((row) => row.stage === "POSITION").status, "PASS");
  assert.equal(valid.stages.find((row) => row.stage === "EXIT_ELIGIBLE").status, "PASS");
  assert.equal(valid.stages.find((row) => row.stage === "SETTLEMENT").status, "PASS");
});

test("FIRST_ZERO uses the first measured zero and UNKNOWN never becomes zero", () => {
  const candidate = naturalCandidate();
  const zero = naturalCycle(candidate, 0, {
    stages: stageRows({ QUALITY_PASSED: { status: "FAIL", count: 0, reason: "QUALITY_REJECTED" } }),
  });
  assert.equal(zero.firstZeroStage, "QUALITY_PASSED");
  assert.equal(zero.firstZeroReason, "QUALITY_REJECTED");

  const unknown = naturalCycle(candidate, 1, {
    stages: stageRows({ SIGNAL_CANDIDATE: { status: "MISSING_EVIDENCE", count: null, reason: "SCANNER_TELEMETRY_MISSING" } }),
  });
  assert.equal(unknown.firstZeroStage, "UNKNOWN");
  assert.equal(unknown.firstZeroReason, "SCANNER_TELEMETRY_MISSING");
});

test("Natural Paper sufficiency counts only natural immutable forward cycles", () => {
  const candidate = naturalCandidate();
  const cycles = Array.from({ length: 5 }, (_, index) => naturalCycle(candidate, index));
  const result = evaluateNaturalPaperSufficiencyV1({ naturalPaperCandidate: candidate, cycleEvidence: cycles });
  assert.equal(result.status, "PASS");
  assert.equal(result.sufficient, true);
  assert.equal(result.naturalCycleN, 5);
  assert.equal(result.replayCredit, 0);
});

test("Paper execution evidence proves zero network private and real-order calls", () => {
  const candidate = naturalCandidate();
  const cycle = naturalCycle(candidate);
  assert.equal(cycle.networkCalls, 0);
  assert.equal(cycle.privateApiCalls, 0);
  assert.equal(cycle.orderCalls, 0);
  assert.equal(cycle.executionAuthority, "NONE");
});

test("N=0 settlement metrics stay null and profitability stays NOT_PROVEN", () => {
  const candidate = naturalCandidate();
  const result = evaluateSettlementEvidenceV1({ naturalPaperCandidate: candidate, cycleEvidence: [], settlements: [] });
  assert.equal(result.status, "MISSING_EVIDENCE");
  assert.equal(result.metrics.settledN, 0);
  assert.equal(result.metrics.profitFactor, null);
  assert.equal(result.metrics.expectancy, null);
  assert.equal(result.metrics.maximumDrawdown, null);
  assert.equal(result.metrics.winRate, null);
  assert.equal(result.metrics.sharpe, null);
  assert.equal(result.profitability, "NOT_PROVEN");
});

test("an actually measured zero remains numeric zero", () => {
  const candidate = naturalCandidate();
  const cycle = naturalCycle(candidate);
  const measured = settlement(candidate, cycle, 0, { grossPnl: 0.7, netPnl: 0, return: 0, mfe: 0, mae: 0 });
  const result = evaluateSettlementEvidenceV1({
    naturalPaperCandidate: candidate,
    cycleEvidence: [cycle],
    settlements: [measured],
    policy: { ...PHASE3_DEFAULT_SETTLEMENT_POLICY, minimumSettledN: 1, minimumIndependentDays: 1, minimumBullRegimeN: 1, minimumBearRegimeN: 0, minimumSidewaysRegimeN: 0, minimumLongN: 1, minimumShortN: 0 },
  });
  assert.equal(result.metrics.expectancy, 0);
  assert.equal(result.metrics.profitFactor, 0);
  assert.equal(result.metrics.winRate, 0);
  assert.equal(result.metrics.maximumDrawdown, 0);
  assert.equal(result.metrics.sharpe, 0);
  assert.equal(result.metrics.mfe, 0);
  assert.equal(result.metrics.mae, 0);
  assert.equal(result.profitabilityProven, false);
});

test("missing costs block profitability while cost-complete settlement preserves MFE MAE and identity", () => {
  const candidate = naturalCandidate();
  const cycle = naturalCycle(candidate);
  const missing = settlement(candidate, cycle);
  delete missing.costs.liquidityImpact;
  const blocked = evaluateSettlementEvidenceV1({ naturalPaperCandidate: candidate, cycleEvidence: [cycle], settlements: [missing] });
  assert.equal(blocked.status, "FAIL");
  assert.ok(blocked.blockers.includes("SETTLEMENT_COST_EVIDENCE_MISSING"));
  assert.equal(blocked.profitabilityProven, false);

  const complete = settlement(candidate, cycle);
  const measured = evaluateSettlementEvidenceV1({ naturalPaperCandidate: candidate, cycleEvidence: [cycle], settlements: [complete] });
  assert.equal(measured.settlements[0].mfe, 0.02);
  assert.equal(measured.settlements[0].mae, 0.01);
  assert.equal(measured.settlements[0].strategyIdentityDigest, candidate.strategyIdentityDigest);
});

test("duplicate settlements and strategy identity mutation fail closed", () => {
  const candidate = naturalCandidate();
  const cycle = naturalCycle(candidate);
  const row = settlement(candidate, cycle);
  const duplicate = evaluateSettlementEvidenceV1({ naturalPaperCandidate: candidate, cycleEvidence: [cycle], settlements: [row, { ...row }] });
  assert.equal(duplicate.status, "FAIL");
  assert.ok(duplicate.blockers.includes("DUPLICATE_SETTLEMENT"));
  const mutation = evaluateSettlementEvidenceV1({
    naturalPaperCandidate: candidate,
    cycleEvidence: [cycle],
    settlements: [settlement(candidate, cycle, 0, { strategyIdentityDigest: "f".repeat(64) })],
  });
  assert.ok(mutation.blockers.includes("SETTLEMENT_STRATEGY_IDENTITY_MISMATCH"));
});

test("sufficient cost-complete forward settlements can prove evidence without granting authority", () => {
  const candidate = naturalCandidate();
  const cycles = Array.from({ length: 30 }, (_, index) => naturalCycle(candidate, index));
  const settlements = cycles.map((cycle, index) => settlement(candidate, cycle, index));
  const result = evaluateSettlementEvidenceV1({ naturalPaperCandidate: candidate, cycleEvidence: cycles, settlements });
  assert.equal(result.status, "PASS");
  assert.equal(result.sufficient, true);
  assert.equal(result.forwardEvidenceSufficient, true);
  assert.equal(result.profitabilityProven, true);
  assert.equal(result.safety.executionAuthority, "NONE");
});

test("Strategy Health is HEALTHY only when every dimension and canonical binding pass", () => {
  const identity = resolveCanonicalStrategyIdentity(identityInput());
  const health = buildPhase3StrategyHealthV1({
    strategyIdentityDigest: identity.strategyIdentityDigest,
    historicalEvidence: historicalPass(),
    shadowEvaluation: { status: "PASS", canonicalShadowHandoffDigest: "d".repeat(64), metrics: { drift: { status: "STABLE" } } },
    naturalPaperEvidence: { status: "PASS", sufficient: true },
    settlementEvidence: { status: "PASS", sufficient: true },
    canonicalHealthBinding: { status: "HEALTHY" },
    safety: PHASE3_SAFETY,
  });
  assert.equal(health.status, "HEALTHY");
  assert.equal(Object.keys(health.dimensions).length, 11);
  assert.ok(Object.values(health.dimensions).every((row) => row.status === "PASS"));
});

test("Health preserves FAIL, Missing Evidence, drift N/A, Paper and Settlement insufficiency", async (t) => {
  const identity = resolveCanonicalStrategyIdentity(identityInput());
  const base = {
    strategyIdentityDigest: identity.strategyIdentityDigest,
    historicalEvidence: historicalPass(),
    shadowEvaluation: { status: "PASS", metrics: { drift: { status: "STABLE" } } },
    naturalPaperEvidence: { status: "PASS", sufficient: true },
    settlementEvidence: { status: "PASS", sufficient: true },
    canonicalHealthBinding: { status: "HEALTHY" },
    safety: PHASE3_SAFETY,
  };
  await t.test("one FAIL", () => {
    const result = buildPhase3StrategyHealthV1({ ...base, historicalEvidence: { ...historicalPass(), costRobustness: "FAIL" } });
    assert.equal(result.status, "UNSTABLE");
    assert.equal(result.dimensions.costRobustness.status, "FAIL");
  });
  await t.test("one missing", () => {
    const result = buildPhase3StrategyHealthV1({ ...base, historicalEvidence: { ...historicalPass(), oosRobustness: "MISSING_EVIDENCE" } });
    assert.equal(result.status, "INSUFFICIENT_EVIDENCE");
    assert.notEqual(result.status, "HEALTHY");
  });
  await t.test("drift N/A", () => {
    const result = buildPhase3StrategyHealthV1({ ...base, shadowEvaluation: { status: "MISSING_EVIDENCE", metrics: { drift: { status: "N/A" } } } });
    assert.equal(result.dimensions.driftHealth.status, "MISSING_EVIDENCE");
    assert.equal(result.status, "INSUFFICIENT_EVIDENCE");
  });
  await t.test("Paper insufficient", () => {
    const result = buildPhase3StrategyHealthV1({ ...base, naturalPaperEvidence: { status: "MISSING_EVIDENCE", sufficient: false } });
    assert.equal(result.dimensions.naturalPaperMaturity.status, "MISSING_EVIDENCE");
  });
  await t.test("Settlement insufficient", () => {
    const result = buildPhase3StrategyHealthV1({ ...base, settlementEvidence: { status: "MISSING_EVIDENCE", sufficient: false } });
    assert.equal(result.dimensions.settlementMaturity.status, "MISSING_EVIDENCE");
  });
  await t.test("Safety blocked", () => {
    const result = buildPhase3StrategyHealthV1({ ...base, safety: { ...PHASE3_SAFETY, REAL_ORDER_ENABLED: true } });
    assert.equal(result.status, "BLOCKED");
  });
});

test("Champion selectors return NONE without every forward gate and never use a first-place fallback", () => {
  const digest = resolveCanonicalStrategyIdentity(identityInput()).strategyIdentityDigest;
  const verdict = selectPhase3ChampionsV1({
    historicalChampionVerdict: { status: "PROVISIONAL_CHAMPION", strategyIdentityDigest: digest },
    candidates: [{ strategyId: "strategy-phase3-v1", strategyIdentityDigest: digest, researchScore: 999 }],
  });
  assert.equal(verdict.currentProvisionalChampion, "NONE");
  assert.equal(verdict.currentValidatedChampion, "NONE");
  assert.equal(verdict.fallbackWinnerAllowed, false);
});

test("Provisional may exist with sufficient research evidence while Validated remains NONE without forward profitability", () => {
  const digest = resolveCanonicalStrategyIdentity(identityInput()).strategyIdentityDigest;
  const candidate = {
    strategyId: "strategy-phase3-v1",
    strategyIdentityDigest: digest,
    tournamentSurvivor: true,
    identityFrozen: true,
    shadowEvaluation: { status: "PASS", sufficient: true },
    naturalPaperEvidence: { status: "PASS", sufficient: true },
    settlementEvidence: { status: "PASS", sufficient: true, profitabilityProven: false },
    health: { status: "HEALTHY" },
    historicalGatesPass: true,
    holdoutPass: true,
    criticalDrift: false,
    safety: PHASE3_SAFETY,
    researchScore: 10,
  };
  const verdict = selectPhase3ChampionsV1({
    historicalChampionVerdict: { status: "PROVISIONAL_CHAMPION", strategyIdentityDigest: digest },
    candidates: [candidate],
  });
  assert.equal(verdict.currentProvisionalChampion.status, "PROVISIONAL_CHAMPION");
  assert.equal(verdict.currentValidatedChampion, "NONE");
  assert.ok(verdict.evaluations[0].validatedBlockers.includes("FORWARD_PROFITABILITY_EVIDENCE_REQUIRED"));
  assert.equal(verdict.liveTradingEligible, false);
});

test("Validated selection requires proven forward profitability but still grants no trading authority", () => {
  const digest = resolveCanonicalStrategyIdentity(identityInput()).strategyIdentityDigest;
  const verdict = selectPhase3ChampionsV1({
    historicalChampionVerdict: { status: "PROVISIONAL_CHAMPION", strategyIdentityDigest: digest },
    candidates: [{
      strategyId: "strategy-phase3-v1",
      strategyIdentityDigest: digest,
      tournamentSurvivor: true,
      identityFrozen: true,
      shadowEvaluation: { status: "PASS", sufficient: true },
      naturalPaperEvidence: { status: "PASS", sufficient: true },
      settlementEvidence: { status: "PASS", sufficient: true, profitabilityProven: true },
      health: { status: "HEALTHY" },
      historicalGatesPass: true,
      holdoutPass: true,
      criticalDrift: false,
      safety: PHASE3_SAFETY,
      researchScore: 10,
    }],
  });
  assert.equal(verdict.currentValidatedChampion.status, "VALIDATED_CHAMPION");
  assert.equal(verdict.liveTradingEligible, false);
  assert.equal(verdict.executionAuthority, "NONE");
});

test("profitability truth separates historical edge, forward sufficiency, and proof", () => {
  const historicalOnly = buildProfitabilityTruthV1({ historicalEdgeObserved: true });
  assert.equal(historicalOnly.HISTORICAL_EDGE_OBSERVED, true);
  assert.equal(historicalOnly.FORWARD_EVIDENCE_SUFFICIENT, false);
  assert.equal(historicalOnly.PROFITABILITY_PROVEN, false);
  const forwardNotProfitable = buildProfitabilityTruthV1({
    historicalEdgeObserved: true,
    shadowEvaluation: { status: "PASS" },
    naturalPaperEvidence: { sufficient: true },
    settlementEvidence: { sufficient: true, profitabilityProven: false },
  });
  assert.equal(forwardNotProfitable.FORWARD_EVIDENCE_SUFFICIENT, true);
  assert.equal(forwardNotProfitable.PROFITABILITY_PROVEN, false);
});

test("read model exposes Stage 4 counts without inventing a Champion", () => {
  const readModel = buildPhase3ResearchReadModelV1({
    generated: 10,
    tournament: 8,
    survivors: [{}],
    shadowEvaluations: [{ status: "MISSING_EVIDENCE" }],
    naturalPaperCycles: [],
    settlementEvidence: [],
    health: [{ status: "INSUFFICIENT_EVIDENCE" }],
    championVerdict: { currentProvisionalChampion: "NONE", currentValidatedChampion: "NONE" },
  });
  assert.equal(readModel.autonomousResearchStage, 4);
  assert.equal(readModel.pipeline.Survivor, 1);
  assert.equal(readModel.pipeline.Shadow, 0);
  assert.equal(readModel.pipeline.ProvisionalChampion, 0);
  assert.equal(readModel.pipeline.ValidatedChampion, 0);
  assert.equal(readModel.labels.MISSING_EVIDENCE, "증거 부족");
});

test("failure observation constructor is immutable and never permits same-strategy tuning", () => {
  const digest = resolveCanonicalStrategyIdentity(identityInput()).strategyIdentityDigest;
  const observation = createResearchFailureObservationV1({
    strategyIdentityDigest: digest,
    stage: "SHADOW",
    status: "FAIL",
    failureCodes: ["BEAR_RECALL_COLLAPSE"],
    observedAt: OBSERVED_AT,
    evidence: { bearRecall: 0 },
  });
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(observation.sameStrategyMutationAllowed, false);
  assert.equal(observation.sameParameterMutationAllowed, false);
  assert.equal(observation.priorEvidenceInheritanceAllowed, false);
  assert.equal(observation.executionAuthority, "NONE");
});


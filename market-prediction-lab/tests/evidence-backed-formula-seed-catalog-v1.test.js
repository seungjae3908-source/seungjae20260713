import assert from "node:assert/strict";
import test from "node:test";

import { adaptCrossrefMetadata } from "../../packages/external-research/src/index.js";
import {
  createHypothesisDecisionV1,
  createStrategyHypothesisV1,
} from "../../packages/strategy-hypothesis/src/index.js";
import {
  compileStrategyHypothesisToFormulaCandidatesV1,
  createSafeStrategyDslV1,
} from "../src/autonomous-strategy-formula-generator-v1.js";
import {
  EVIDENCE_BACKED_FORMULA_FAMILIES,
  EVIDENCE_BACKED_REFERENCE_RECIPES,
  FUTURES_DERIVATIVES_EVIDENCE_REQUIREMENTS,
  buildEvidenceBackedFormulaSeedCatalogV1,
  createEvidenceBackedFormulaTemplatesV1,
} from "../src/evidence-backed-formula-seed-catalog-v1.js";

const CREATED_AT = "2026-08-26T00:00:00.000Z";
const DECIDED_AT = "2026-08-26T01:00:00.000Z";
const OHLCV = ["close", "high", "low", "open", "volume"];

function fakeBinding() {
  return {
    hypothesisId: "hypothesis:seed-test",
    hypothesisConfigHash: "config:seed-test",
    decisionId: "decision:seed-test",
    decisionHash: "decision-hash:seed-test",
  };
}

function supportingPaper() {
  return adaptCrossrefMetadata({
    status: "ok",
    "message-type": "work",
    "message-version": "1.0.0",
    message: {
      DOI: "10.1234/evidence.seed.catalog",
      title: ["Evidence-backed seed catalog fixture"],
      author: [{ given: "Ada", family: "Lovelace" }],
      published: { "date-parts": [[2025, 1, 2]] },
      indexed: { "date-time": "2026-08-25T00:00:00Z", version: "3.51.4" },
      license: [{
        URL: "https://creativecommons.org/licenses/by/4.0/",
        "content-version": "vor",
        "delay-in-days": 0,
        start: { "date-parts": [[2025, 1, 2]] },
      }],
    },
  }, {
    retrievedAt: "2026-08-25T01:00:00.000Z",
    retrievedFrom: "https://api.crossref.org/v1/works/10.1234/evidence.seed.catalog",
  });
}

function hypothesisAndDecision() {
  const paper = supportingPaper();
  const hypothesis = createStrategyHypothesisV1({
    title: "US swing evidence-backed formula seed hypothesis",
    statement: "Trend-breakout, time-series momentum, and trend-pullback structures may justify bounded out-of-sample research.",
    marketScope: ["US_LARGE_CAP"],
    assetClass: "EQUITY",
    timeframeScope: ["1h"],
    directionality: "POSITIVE",
    rationale: "Formula seeds are research candidates only and require independent validation.",
    supportingPaperIds: [paper.paperId],
    contradictoryPaperIds: [],
    evidenceStrength: { supporting: "STRONG", contradictory: "NONE" },
    expectedEffect: {
      observable: "NEXT_WINDOW_EXCESS_RETURN",
      direction: "INCREASE",
      minimumMagnitude: null,
      unit: "DECIMAL_RETURN",
      evaluationWindow: "1h",
    },
    falsificationCriteria: {
      observable: "NEXT_WINDOW_EXCESS_RETURN",
      metric: "MEAN_CONDITIONAL_EXCESS_RETURN",
      operator: "LTE",
      threshold: 0,
      unit: "DECIMAL_RETURN",
      evaluationWindow: "1h",
      minimumObservations: 200,
      rejectionStatement: "Reject when the measured conditional mean is non-positive.",
    },
    requiredData: [{
      dataset: "LICENSED_INTRADAY_EQUITY_BARS",
      fields: ["security_id", "open", "high", "low", "close", "volume"],
      frequency: "1h",
      provenanceRequired: true,
      licenseRequired: true,
    }],
    knownLimitations: ["Regime, execution costs, and forward generalization require separate validation."],
    createdAt: CREATED_AT,
    generator: { name: "evidence-seed-catalog-test", version: "1.0.0" },
    evidencePolicy: { requireKnownContentLicense: true, requireResolvedCorrections: true },
  }, [paper]);
  const decision = createHypothesisDecisionV1({
    hypothesis,
    papers: [paper],
    verdict: "APPROVE_FOR_RESEARCH",
    rationale: "Approved only for bounded deterministic testing.",
    decidedAt: DECIDED_AT,
    committee: { name: "Research Committee", version: "1.0.0", members: ["reviewer-a", "reviewer-b"] },
  });
  return { hypothesis, decision };
}

function compilerPolicy() {
  return {
    compilerId: "evidence-seed-catalog-compiler",
    compilerVersion: "1.0.0",
    costPolicyIdentity: "US_SWING_COST_V1",
    riskPolicyIdentity: "RESEARCH_RISK_V1",
    datasetIdentity: "dataset:train:evidence-seed-v1",
    datasetRole: "TRAIN",
    budget: {
      maxCandidatesPerHypothesis: 8,
      maxCandidatesPerRun: 16,
      maxGenerations: 2,
      maxParameterCombinations: 128,
      maxAstNodes: 64,
      maxRuntimeMs: 5_000,
      maxCpuMs: 5_000,
      maxMemoryBytes: 1024 * 1024,
    },
  };
}

test("catalog exposes exactly 12 market-horizon profiles with 9 cash READY and 3 futures fail-closed", () => {
  const catalog = buildEvidenceBackedFormulaSeedCatalogV1();
  assert.equal(catalog.profileCount, 12);
  assert.equal(catalog.readyProfileCount, 9);
  assert.equal(catalog.blockedProfileCount, 3);
  assert.equal(new Set(catalog.profiles.map((profile) => profile.profileId)).size, 12);
  assert.deepEqual(catalog.families, EVIDENCE_BACKED_FORMULA_FAMILIES);
  assert.equal(catalog.safety.executionAuthority, "NONE");
  assert.equal(catalog.safety.profitabilityClaimAllowed, false);
  assert.equal(catalog.safety.tournamentValidationRequired, true);

  for (const profile of catalog.profiles.filter((entry) => entry.market !== "CRYPTO_FUTURES")) {
    assert.equal(profile.status, "READY");
    assert.deepEqual(profile.directions, ["LONG"]);
    assert.deepEqual(profile.formulaFamilies, EVIDENCE_BACKED_FORMULA_FAMILIES);
  }
});

test("catalog carries primary-source strategy recipes before any local formula invention", () => {
  const catalog = buildEvidenceBackedFormulaSeedCatalogV1();
  assert.equal(catalog.referenceRecipeCount, 12);
  assert.deepEqual(catalog.referenceRecipes, EVIDENCE_BACKED_REFERENCE_RECIPES);
  assert.equal(new Set(catalog.referenceRecipes.map((recipe) => recipe.recipeId)).size, 12);
  assert.equal(Object.isFrozen(catalog.referenceRecipes), true);

  const ep = catalog.referenceRecipes.find((recipe) => recipe.recipeId === "QULLAMAGGIE_EP_V1");
  assert.equal(ep.confirmation.gapUpMinFraction, 0.10);
  assert.deepEqual(ep.confirmation.openingRangeHighMinutes, [1, 5, 60]);
  assert.equal(ep.sourceEvidence[0].independentlyAuditedPerformance, false);
  assert.equal(ep.localReplicationRequired, true);
  assert.equal(ep.automaticActivationAllowed, false);

  const breakout = catalog.referenceRecipes.find((recipe) => recipe.recipeId === "QULLAMAGGIE_COMMON_BREAKOUT_V1");
  assert.ok(breakout.candidatePreparation.includes("RANK_TOP_1_TO_2_PERCENT_BY_1M_3M_6M_PERFORMANCE"));
  assert.deepEqual(breakout.confirmation.typicalConsolidationWeeksRange, [2, 8]);

  for (const id of [
    "CROSS_SECTIONAL_PRICE_MOMENTUM_V1",
    "PEAD_EARNINGS_SURPRISE_V1",
    "FIFTY_TWO_WEEK_HIGH_MOMENTUM_V1",
    "TIME_SERIES_MOMENTUM_V1",
    "LIU_TSYVINSKI_WU_CRYPTO_CROSS_SECTIONAL_MOMENTUM_V1",
  ]) {
    const recipe = catalog.referenceRecipes.find((entry) => entry.recipeId === id);
    assert.equal(recipe.origin, "ACADEMIC_PEER_REVIEWED", id);
    assert.match(recipe.sourceEvidence[0].doi, /^10\./u, id);
    assert.equal(recipe.localReplicationRequired, true, id);
    assert.equal(recipe.automaticActivationAllowed, false, id);
  }

  const cryptoCrossSectional = catalog.referenceRecipes.find((recipe) => recipe.recipeId === "LIU_TSYVINSKI_WU_CRYPTO_CROSS_SECTIONAL_MOMENTUM_V1");
  assert.deepEqual(cryptoCrossSectional.confirmation.publishedMomentumLookbackWeeks, [1, 2, 3, 4]);
  assert.equal(cryptoCrossSectional.confirmation.rebalanceFrequency, "WEEKLY");
  assert.equal(cryptoCrossSectional.confirmation.portfolioCount, 5);
  assert.equal(cryptoCrossSectional.confirmation.portfolioWeighting, "VALUE_WEIGHTED");
  assert.equal(cryptoCrossSectional.requiredDataEvidence.pointInTimeUniverseRequired, true);
  assert.equal(cryptoCrossSectional.requiredDataEvidence.listingDelistingHistoryRequired, true);
  assert.equal(cryptoCrossSectional.requiredDataEvidence.weeklyMarketCapRequired, true);
  assert.equal(cryptoCrossSectional.requiredDataEvidence.currentMembershipBackfillForbidden, true);
  assert.equal(cryptoCrossSectional.localReadiness.status, "BLOCKED_DATA");
  assert.deepEqual(cryptoCrossSectional.localReadiness.blockers, [
    "CRYPTO_PIT_LISTING_DELISTING_HISTORY_NOT_MATERIALIZED",
    "CRYPTO_WEEKLY_MARKET_CAP_HISTORY_NOT_MATERIALIZED",
  ]);
  assert.equal(cryptoCrossSectional.localReadiness.currentUpbitBitgetUniverseMayCount, false);
  assert.equal(cryptoCrossSectional.localReadiness.threeCoinProxyMayCountAsReplication, false);
  assert.equal(cryptoCrossSectional.automaticActivationAllowed, false);

  const turtle = catalog.referenceRecipes.find((recipe) => recipe.recipeId === "TURTLE_SYSTEM_2_DONCHIAN_V1");
  assert.equal(turtle.origin, "PRACTITIONER_PUBLIC_METHOD");
  assert.equal(turtle.confirmation.entryBreakoutDays, 55);
  assert.equal(turtle.confirmation.exitBreakoutDays, 20);
  assert.equal(turtle.confirmation.initialStopNMultiple, 2);
  assert.equal(turtle.confirmation.addUnitEveryNMultiple, 0.5);
  assert.equal(turtle.confirmation.maxUnits, 4);
  assert.equal(turtle.confirmation.priorWinnerFilterApplied, false);
  assert.equal(turtle.riskFramework.fixedProfitTarget, false);
  assert.equal(turtle.sourceEvidence[0].independentlyAuditedPerformance, false);
  assert.equal(turtle.automaticActivationAllowed, false);

  const connors = catalog.referenceRecipes.find((recipe) => recipe.recipeId === "CONNORS_RSI2_CLASSIC_V1");
  assert.equal(connors.origin, "PRACTITIONER_BOOK_METHOD");
  assert.equal(connors.confirmation.rsiPeriod, 2);
  assert.equal(connors.confirmation.rsiEntryBelow, 5);
  assert.equal(connors.confirmation.trendSmaDays, 200);
  assert.equal(connors.confirmation.exitSmaDays, 5);
  assert.equal(connors.confirmation.fixedStopInClassicBaseline, false);
  assert.equal(connors.localReplicationEvidence.prNumber, 1503);
  assert.equal(connors.localReplicationEvidence.status, "RESEARCH_HOLD_CROSS_SYMBOL_OR_WINDOW_GENERALIZATION_FAILED");
  assert.equal(connors.localReplicationEvidence.sourceCloseMayCountAsExecutableFill, false);
  assert.equal(connors.automaticActivationAllowed, false);

  const williams = catalog.referenceRecipes.find((recipe) => recipe.recipeId === "LARRY_WILLIAMS_VOLATILITY_BREAKOUT_K05_V1");
  assert.equal(williams.origin, "PRACTITIONER_BOOK_METHOD");
  assert.equal(williams.confirmation.k, 0.5);
  assert.equal(williams.confirmation.exit, "SAME_SESSION_CLOSE");
  assert.equal(williams.confirmation.stopAddedToBaseline, false);
  assert.equal(williams.confirmation.trendFilterAddedToBaseline, false);
  assert.equal(williams.localReplicationEvidence.prNumber, 1504);
  assert.equal(williams.localReplicationEvidence.status, "RESEARCH_HOLD_CROSS_SYMBOL_OR_WINDOW_GENERALIZATION_FAILED");
  assert.equal(williams.localReplicationEvidence.kOptimizationAllowed, false);
  assert.equal(williams.automaticActivationAllowed, false);

  const faber = catalog.referenceRecipes.find((recipe) => recipe.recipeId === "FABER_GTAA_10M_SMA_V1");
  assert.equal(faber.origin, "ACADEMIC_PEER_REVIEWED");
  assert.equal(faber.confirmation.movingAverageMonths, 10);
  assert.equal(faber.confirmation.rebalanceFrequency, "MONTHLY");
  assert.equal(faber.confirmation.parameterSearchAllowed, false);
  assert.equal(faber.sourceEvidence[0].ssrnAbstractId, "962461");
  assert.equal(faber.localReplicationEvidence.prNumber, 1506);
  assert.equal(faber.localReplicationEvidence.status, "REFERENCE_CANDIDATE_REQUIRES_FUTURE_OOS");
  assert.equal(faber.localReplicationEvidence.crossWindowStressPositive, true);
  assert.equal(faber.localReplicationEvidence.leaveOneAssetOutStressPositive, true);
  assert.equal(faber.automaticActivationAllowed, false);

  const orb = catalog.referenceRecipes.find((recipe) => recipe.recipeId === "ORB_STANDALONE_COST_CONTROL_V1");
  assert.equal(orb.researchRole, "NEGATIVE_CONTROL");
  assert.equal(orb.confirmation.preRegisteredCells, 225);
  assert.equal(orb.confirmation.simpleCellsPassingPositiveBarAfterCosts, 0);
  assert.equal(orb.automaticActivationAllowed, false);
});

test("every ready profile builds three deterministic early-profit safe DSL templates", () => {
  const catalog = buildEvidenceBackedFormulaSeedCatalogV1();
  for (const profile of catalog.profiles.filter((entry) => entry.status === "READY")) {
    const first = createEvidenceBackedFormulaTemplatesV1({ profileId: profile.profileId, hypothesisBinding: fakeBinding() });
    const second = createEvidenceBackedFormulaTemplatesV1({ profileId: profile.profileId, hypothesisBinding: fakeBinding() });
    assert.equal(first.status, "READY", profile.profileId);
    assert.equal(first.templates.length, 3, profile.profileId);
    assert.deepEqual(first, second, profile.profileId);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.templates), true);

    for (const template of first.templates) {
      const dsl = createSafeStrategyDslV1({
        market: template.market,
        timeframe: template.timeframe,
        direction: template.direction,
        availableDataFields: OHLCV,
        entryDsl: template.entryDsl,
        exitDsl: template.exitDsl,
        parameterSpace: template.parameterSpace,
        limits: template.limits,
      });
      assert.equal(dsl.safety.executionAuthority, "NONE");
      assert.equal(dsl.safety.arbitraryExecutableCodeAllowed, false);
      assert.equal(template.direction, "LONG");
      assert.ok(EVIDENCE_BACKED_FORMULA_FAMILIES.includes(template.strategyFamily));
    }
  }
});

test("three seed families preserve the intended entry structure and common ATR/target/time exits", () => {
  const result = createEvidenceBackedFormulaTemplatesV1({
    profileId: "US_STOCK:SWING",
    hypothesisBinding: fakeBinding(),
  });
  assert.equal(result.status, "READY");
  const families = Object.fromEntries(result.templates.map((template) => [template.strategyFamily, template]));
  assert.deepEqual(Object.keys(families).sort(), [...EVIDENCE_BACKED_FORMULA_FAMILIES].sort());

  const breakout = JSON.stringify(families.TREND_BREAKOUT.entryDsl);
  for (const token of ["EMA", "ADX", "BREAKOUT", "RVOL"]) assert.match(breakout, new RegExp(token));

  const momentum = JSON.stringify(families.TIME_SERIES_MOMENTUM.entryDsl);
  for (const token of ["EMA", "ROC", "ADX"]) assert.match(momentum, new RegExp(token));

  const pullback = JSON.stringify(families.TREND_PULLBACK.entryDsl);
  for (const token of ["EMA", "ADX", "RSI", "CROSSOVER"]) assert.match(pullback, new RegExp(token));

  for (const template of result.templates) {
    assert.deepEqual(template.exitDsl.rules.map((rule) => rule.type), ["ATR_STOP", "TARGET", "TIME_EXIT"]);
  }
});

test("futures profiles generate zero technical-only candidates until derivative evidence can survive FormulaCandidate provenance", () => {
  const catalog = buildEvidenceBackedFormulaSeedCatalogV1();
  const futuresProfiles = catalog.profiles.filter((profile) => profile.market === "CRYPTO_FUTURES");
  assert.equal(futuresProfiles.length, 3);
  for (const profile of futuresProfiles) {
    assert.equal(profile.status, "BLOCKED_DERIVATIVES_EVIDENCE");
    assert.deepEqual(profile.directions, ["LONG", "SHORT"]);
    assert.deepEqual(profile.requiredDerivativesEvidence, FUTURES_DERIVATIVES_EVIDENCE_REQUIREMENTS);
    const result = createEvidenceBackedFormulaTemplatesV1({ profileId: profile.profileId, hypothesisBinding: fakeBinding() });
    assert.equal(result.status, "BLOCKED_DERIVATIVES_EVIDENCE");
    assert.deepEqual(result.templates, []);
    assert.ok(result.blockers.includes("DERIVATIVES_FORMULA_EVIDENCE_CONTRACT_REQUIRED"));
    assert.equal(result.safety.profitabilityClaimAllowed, false);
    assert.equal(result.safety.executionAuthority, "NONE");
  }
});

test("US swing seeds compile into FormulaCandidateV1 only as NOT_EVALUATED research candidates", () => {
  const { hypothesis, decision } = hypothesisAndDecision();
  const hypothesisBinding = {
    hypothesisId: hypothesis.hypothesisId,
    hypothesisConfigHash: hypothesis.configHash,
    decisionId: decision.decisionId,
    decisionHash: decision.decisionHash,
  };
  const seedResult = createEvidenceBackedFormulaTemplatesV1({
    profileId: "US_STOCK:SWING",
    hypothesisBinding,
  });
  assert.equal(seedResult.status, "READY");
  const candidates = compileStrategyHypothesisToFormulaCandidatesV1({
    hypothesis,
    decision,
    templates: seedResult.templates,
    policy: compilerPolicy(),
  });
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((candidate) => candidate.strategyFamily).sort(), [...EVIDENCE_BACKED_FORMULA_FAMILIES].sort());
  for (const candidate of candidates) {
    assert.equal(candidate.market, "US_STOCK");
    assert.equal(candidate.timeframe, "1h");
    assert.equal(candidate.direction, "LONG");
    assert.equal(candidate.evaluationStatus, "NOT_EVALUATED");
    assert.equal(candidate.formulaPassed, false);
    assert.equal(candidate.safety.executionAuthority, "NONE");
    assert.equal(candidate.safety.liveTrading, false);
    assert.equal(candidate.provenance.datasetRole, "TRAIN");
  }
});

test("unknown profiles are rejected rather than silently falling back to a generic formula", () => {
  assert.throws(
    () => createEvidenceBackedFormulaTemplatesV1({ profileId: "GENERIC:SWING", hypothesisBinding: fakeBinding() }),
    /UNKNOWN_FORMULA_SEED_PROFILE/u,
  );
});

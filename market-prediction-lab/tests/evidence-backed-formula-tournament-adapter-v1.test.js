import assert from "node:assert/strict";
import test from "node:test";

import { adaptCrossrefMetadata } from "../../packages/external-research/src/index.js";
import {
  createHypothesisDecisionV1,
  createStrategyHypothesisV1,
} from "../../packages/strategy-hypothesis/src/index.js";
import {
  EVIDENCE_BACKED_FORMULA_TOURNAMENT_ADAPTER_CONTRACT,
  runEvidenceBackedFormulaTournamentAdapterV1,
} from "../src/evidence-backed-formula-tournament-adapter-v1.js";

const TRAIN_DATASET = "dataset:train:evidence-seed-adapter-v1";
const OBSERVED_AT = "2026-08-26T10:00:00.000Z";
const FAMILIES = Object.freeze([
  "TREND_ADX",
  "MOMENTUM_RVOL",
  "BREAKOUT_RVOL",
  "MEAN_REVERSION_RECOVERY",
]);

function paper() {
  return adaptCrossrefMetadata({
    status: "ok",
    "message-type": "work",
    "message-version": "1.0.0",
    message: {
      DOI: "10.1234/evidence.seed.tournament.adapter",
      title: ["Evidence-backed seed tournament adapter fixture"],
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
    retrievedFrom: "https://api.crossref.org/v1/works/10.1234/evidence.seed.tournament.adapter",
  });
}

function hypothesisAndDecision() {
  const source = paper();
  const hypothesis = createStrategyHypothesisV1({
    title: "US swing evidence-backed tournament adapter hypothesis",
    statement: "Evidence-backed trend, momentum, breakout, and recovery families may justify bounded research.",
    marketScope: ["US_LARGE_CAP"],
    assetClass: "EQUITY",
    timeframeScope: ["1h"],
    directionality: "POSITIVE",
    rationale: "Research candidates must survive the canonical strict tournament before any downstream use.",
    supportingPaperIds: [source.paperId],
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
      rejectionStatement: "Reject when measured conditional mean is non-positive.",
    },
    requiredData: [{
      dataset: "LICENSED_INTRADAY_EQUITY_BARS",
      fields: ["security_id", "open", "high", "low", "close", "volume"],
      frequency: "1h",
      provenanceRequired: true,
      licenseRequired: true,
    }],
    knownLimitations: ["Costs, regime robustness, statistical multiplicity, and forward generalization require separate evidence."],
    createdAt: "2026-08-26T08:00:00.000Z",
    generator: { name: "seed-tournament-adapter-test", version: "1.0.0" },
    evidencePolicy: { requireKnownContentLicense: true, requireResolvedCorrections: true },
  }, [source]);
  const decision = createHypothesisDecisionV1({
    hypothesis,
    papers: [source],
    verdict: "APPROVE_FOR_RESEARCH",
    rationale: "Approved only for bounded deterministic tournament testing.",
    decidedAt: "2026-08-26T08:30:00.000Z",
    committee: { name: "Research Committee", version: "1.0.0", members: ["reviewer-a", "reviewer-b"] },
  });
  return { hypothesis, decision };
}

function binding(hypothesis, decision) {
  return {
    hypothesisId: hypothesis.hypothesisId,
    hypothesisConfigHash: hypothesis.configHash,
    decisionId: decision.decisionId,
    decisionHash: decision.decisionHash,
  };
}

const parameter = (name, domain, valueType, min, max, step) => ({ name, domain, valueType, min, max, step });
const indicator = (name, input, parameters = {}) => ({ kind: "INDICATOR", name, input, parameters });
const operator = (name, operands) => ({ kind: "OPERATOR", operator: name, operands });

function template(strategyFamily, hypothesisBinding) {
  return {
    templateId: `adapter-${strategyFamily.toLowerCase().replaceAll("_", "-")}-v1`,
    hypothesisBinding,
    strategyFamily,
    market: "US_STOCK",
    timeframe: "1h",
    direction: "LONG",
    entryDsl: {
      action: "LONG",
      rules: [
        operator("CROSSOVER", [
          indicator("EMA", "close", { period: "emaFast" }),
          indicator("EMA", "close", { period: "emaSlow" }),
        ]),
      ],
    },
    exitDsl: {
      rules: [
        { type: "FIXED_STOP", distanceParameter: "stopDistance" },
        { type: "TARGET", distanceParameter: "targetDistance" },
        { type: "TIME_EXIT", barsParameter: "timeBars" },
      ],
    },
    parameterSpace: [
      parameter("emaFast", "PERIOD", "INTEGER", 10, 30, 10),
      parameter("emaSlow", "PERIOD", "INTEGER", 40, 100, 20),
      parameter("stopDistance", "PRICE_FRACTION", "NUMBER", 0.01, 0.03, 0.01),
      parameter("targetDistance", "PRICE_FRACTION", "NUMBER", 0.02, 0.1, 0.02),
      parameter("timeBars", "BAR_COUNT", "INTEGER", 8, 24, 8),
    ],
    limits: { maxAstDepth: 6, maxIndicatorCount: 8, maxRuleCount: 8, maxAstNodes: 64 },
  };
}

function readyProducerFixture(hypothesis, decision) {
  const profile = {
    profileId: "US_STOCK:SWING",
    market: "US_STOCK",
    horizon: "SWING",
    timeframe: "1h",
    directions: ["LONG"],
    status: "READY",
    formulaFamilies: [...FAMILIES],
    requiredDerivativesEvidence: [],
    blockers: [],
  };
  const safety = {
    researchCandidateOnly: true,
    tournamentValidationRequired: true,
    profitabilityClaimAllowed: false,
    formulaPassed: false,
    scannerRuntimeMutationAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
  const hypothesisBinding = binding(hypothesis, decision);
  return {
    catalog: {
      schemaVersion: 1,
      contract: "evidence-backed-formula-seed-catalog/v1",
      profileCount: 12,
      readyProfileCount: 9,
      blockedProfileCount: 3,
      profiles: [profile],
      families: [...FAMILIES],
      futuresEvidenceRequirements: ["MARK_PRICE", "INDEX_PRICE", "FUNDING", "OPEN_INTEREST", "BASIS", "LIQUIDATION_RISK"],
      safety,
    },
    seedResult: {
      status: "READY",
      profile,
      templates: FAMILIES.map((family) => template(family, hypothesisBinding)),
      blockers: [],
      safety,
    },
  };
}

function blockedFuturesProducerFixture() {
  const profile = {
    profileId: "CRYPTO_FUTURES:SWING",
    market: "CRYPTO_FUTURES",
    horizon: "SWING",
    timeframe: "1h",
    directions: ["LONG", "SHORT"],
    status: "BLOCKED_DERIVATIVES_EVIDENCE",
    formulaFamilies: [],
    requiredDerivativesEvidence: ["MARK_PRICE", "INDEX_PRICE", "FUNDING", "OPEN_INTEREST", "BASIS", "LIQUIDATION_RISK"],
    blockers: ["DERIVATIVES_FORMULA_EVIDENCE_CONTRACT_REQUIRED"],
  };
  const safety = {
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
  };
  return {
    catalog: {
      schemaVersion: 1,
      contract: "evidence-backed-formula-seed-catalog/v1",
      profiles: [profile],
      families: [...FAMILIES],
      safety,
    },
    seedResult: {
      status: "BLOCKED_DERIVATIVES_EVIDENCE",
      profile,
      templates: [],
      blockers: ["DERIVATIVES_FORMULA_EVIDENCE_CONTRACT_REQUIRED"],
      safety,
    },
  };
}

function generationBudget() {
  return {
    maxCandidatesPerHypothesis: 8,
    maxCandidatesPerRun: 16,
    maxGenerations: 2,
    maxParameterCombinations: 128,
    maxAstNodes: 64,
    maxRuntimeMs: 5_000,
    maxCpuMs: 5_000,
    maxMemoryBytes: 1024 * 1024,
  };
}

function compilerPolicy() {
  return {
    compilerId: "evidence-seed-tournament-adapter-compiler",
    compilerVersion: "1.0.0",
    costPolicyIdentity: "US_SWING_COST_V1",
    riskPolicyIdentity: "RESEARCH_RISK_V1",
    datasetIdentity: TRAIN_DATASET,
    datasetRole: "TRAIN",
    budget: generationBudget(),
  };
}

function tournamentConfig(overrides = {}) {
  const base = {
    generationBudget: generationBudget(),
    search: {
      method: "BOUNDED_GRID",
      seed: 17,
      datasetIdentity: TRAIN_DATASET,
      finalHoldoutAccess: false,
    },
    budget: {
      maxCandidatesPerRun: 16,
      maxConcurrentBacktests: 2,
      maxTotalCandles: 100_000,
      maxRuntimeMs: 60_000,
      maxCpuPercent: 80,
      maxMemoryMb: 4096,
      maxWalkForwardWindows: 12,
      maxStressScenarios: 8,
    },
    policy: {
      minimumCandles: 100,
      minimumTrades: 30,
      minimumIndependentPeriods: 3,
      minimumRegimeSamples: { BULL: 10, BEAR: 10, SIDEWAYS: 10 },
      minimumWalkForwardWindows: 3,
      minimumPositiveWalkForwardRatio: 0.5,
      maximumFailureConcentration: 0.5,
      minimumNeighborhoodWidth: 2,
      multipleTestingBaseAlpha: 0.05,
    },
    resourceSnapshot: { cpuPercent: 20, memoryMb: 512, activeBacktests: 0 },
    observedAt: OBSERVED_AT,
  };
  return { ...base, ...overrides };
}

function adapterInput(producer, hypothesis, decision, overrides = {}) {
  return {
    catalog: producer.catalog,
    seedResult: producer.seedResult,
    hypothesis,
    decision,
    compilerPolicy: compilerPolicy(),
    candidatesPerFormula: 1,
    tournament: tournamentConfig(),
    ...overrides,
  };
}

test("#721-style READY families all reach #551 tournament and auto-eliminate without family starvation", async () => {
  const { hypothesis, decision } = hypothesisAndDecision();
  const producer = readyProducerFixture(hypothesis, decision);
  let historicalCalls = 0;
  const result = await runEvidenceBackedFormulaTournamentAdapterV1(
    adapterInput(producer, hypothesis, decision),
    {
      loadDatasetMetadata: async ({ formulaCandidate, datasetIdentity }) => ({
        datasetIdentity,
        datasetRole: "TRAIN",
        market: formulaCandidate.market,
        timeframe: formulaCandidate.timeframe,
        direction: formulaCandidate.direction,
        candleCount: 5000,
        independentPeriods: 8,
        availableFields: ["security_id", "open", "high", "low", "close", "volume"],
      }),
      runHistoricalBacktest: async () => {
        historicalCalls += 1;
        return {
          status: "MISSING_EVIDENCE",
          failureCode: "INSUFFICIENT_SAMPLE",
          failureReason: "fixture intentionally stops after proving seed-to-tournament handoff",
        };
      },
    },
  );

  assert.equal(result.contract, EVIDENCE_BACKED_FORMULA_TOURNAMENT_ADAPTER_CONTRACT);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.seedTemplateCount, 4);
  assert.equal(result.formulaCandidateCount, 4);
  assert.equal(result.globalPlannedCandidateFamilySize, 4);
  assert.equal(result.runs.length, 4);
  assert.equal(historicalCalls, 4);
  assert.deepEqual(new Set(result.runs.map((run) => run.strategyFamily)), new Set(FAMILIES));
  assert.equal(result.tournament.candidates.length, 4);
  assert.equal(result.tournament.researchSurvivorCount, 0);
  assert.equal(result.tournament.profitable, false);
  assert.equal(result.tournament.champion, null);
  assert.equal(result.safety.executionAuthority, "NONE");
  assert.equal(result.safety.profitabilityClaimAllowed, false);

  for (const run of result.runs) {
    assert.equal(run.result.candidates.length, 1, run.strategyFamily);
    const candidate = run.result.candidates[0];
    assert.equal(candidate.stageRecords[0].stage, "FORMULA_CANDIDATE");
    assert.equal(candidate.stageRecords[0].status, "PASS");
    assert.equal(candidate.stageRecords[1].stage, "SANITY_CHECK");
    assert.equal(candidate.stageRecords[1].status, "PASS");
    assert.equal(candidate.failure.failedStage, "HISTORICAL_BACKTEST");
    assert.equal(candidate.failure.failureCode, "INSUFFICIENT_SAMPLE");
    assert.equal(candidate.researchSurvivor, false);
    assert.equal(candidate.profitable, false);
    assert.equal(candidate.tradingAuthority, false);
  }
});

test("blocked crypto futures profile produces zero tournament work and preserves derivatives blocker", async () => {
  const { hypothesis, decision } = hypothesisAndDecision();
  const producer = blockedFuturesProducerFixture();
  let callbackCalls = 0;
  const result = await runEvidenceBackedFormulaTournamentAdapterV1(
    adapterInput(producer, hypothesis, decision),
    {
      loadDatasetMetadata: async () => {
        callbackCalls += 1;
        throw new Error("must not be called for blocked futures seed profile");
      },
    },
  );
  assert.equal(result.status, "BLOCKED_DERIVATIVES_EVIDENCE");
  assert.equal(result.formulaCandidateCount, 0);
  assert.equal(result.globalPlannedCandidateFamilySize, 0);
  assert.deepEqual(result.runs, []);
  assert.equal(result.tournament, null);
  assert.ok(result.blockers.includes("DERIVATIVES_FORMULA_EVIDENCE_CONTRACT_REQUIRED"));
  assert.equal(callbackCalls, 0);
  assert.equal(result.safety.executionAuthority, "NONE");
});

test("adapter rejects any pre-holdout search access before tournament execution", async () => {
  const { hypothesis, decision } = hypothesisAndDecision();
  const producer = readyProducerFixture(hypothesis, decision);
  const tournament = tournamentConfig({
    search: {
      method: "BOUNDED_GRID",
      seed: 17,
      datasetIdentity: TRAIN_DATASET,
      finalHoldoutAccess: true,
    },
  });
  await assert.rejects(
    () => runEvidenceBackedFormulaTournamentAdapterV1(
      adapterInput(producer, hypothesis, decision, { tournament }),
      {},
    ),
    /FINAL_HOLDOUT_PREACCESS_FORBIDDEN/u,
  );
});

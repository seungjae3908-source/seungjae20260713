import assert from "node:assert/strict";
import test from "node:test";

import { adaptCrossrefMetadata } from "../../packages/external-research/src/index.js";
import {
  createHypothesisDecisionV1,
  createStrategyHypothesisV1,
} from "../../packages/strategy-hypothesis/src/index.js";
import {
  compileStrategyHypothesisToFormulaCandidatesV1,
  generateBoundedFormulaCandidatesV1,
} from "../src/autonomous-strategy-formula-generator-v1.js";
import { runIndependentSignalBacktest } from "../src/independent-strategy-backtest.js";
import {
  RESEARCH_TOURNAMENT_STAGE_STATUSES,
  RESEARCH_TOURNAMENT_STAGES,
  advanceResearchTournamentFsmV1,
  buildResearchTournamentReadModelV1,
  createResearchTournamentFsmV1,
  rankResearchSurvivorsV1,
  runOnePassCandidateBacktestV1,
  runResearchTournamentV1,
} from "../src/research-tournament-engine-v1.js";

const OBSERVED_AT = "2026-08-26T00:30:00.000Z";
const TRAIN_DATASET = "dataset:train:phase2-v1";
const OOS_DATASET = "dataset:oos:phase2-v1";
const PURGED_DATASET = "dataset:purged-oos:phase2-v1";
const HOLDOUT_DATASET = "dataset:final-holdout:phase2-v1";

function paper() {
  return adaptCrossrefMetadata({
    status: "ok",
    "message-type": "work",
    "message-version": "1.0.0",
    message: {
      DOI: "10.1234/phase2.tournament",
      title: ["Phase 2 tournament evidence"],
      author: [{ given: "Ada", family: "Lovelace" }],
      published: { "date-parts": [[2025, 1, 2]] },
      indexed: { "date-time": "2026-08-24T00:00:00Z", version: "3.51.4" },
      license: [{
        URL: "https://creativecommons.org/licenses/by/4.0/",
        "content-version": "vor",
        "delay-in-days": 0,
        start: { "date-parts": [[2025, 1, 2]] },
      }],
    },
  }, {
    retrievedAt: "2026-08-24T01:00:00.000Z",
    retrievedFrom: "https://api.crossref.org/v1/works/10.1234/phase2.tournament",
  });
}

function generationBudget(overrides = {}) {
  return {
    maxCandidatesPerHypothesis: 8,
    maxCandidatesPerRun: 16,
    maxGenerations: 2,
    maxParameterCombinations: 128,
    maxAstNodes: 64,
    maxRuntimeMs: 5_000,
    maxCpuMs: 5_000,
    maxMemoryBytes: 1024 * 1024,
    ...overrides,
  };
}

function formulaCandidates() {
  const source = paper();
  const hypothesis = createStrategyHypothesisV1({
    title: "Phase 2 continuation hypothesis",
    statement: "Volume-confirmed momentum may support bounded continuation research.",
    marketScope: ["US_LARGE_CAP"],
    assetClass: "EQUITY",
    timeframeScope: ["15m"],
    directionality: "POSITIVE",
    rationale: "Research-only hypothesis for strict tournament evaluation.",
    supportingPaperIds: [source.paperId],
    contradictoryPaperIds: [],
    evidenceStrength: { supporting: "STRONG", contradictory: "NONE" },
    expectedEffect: {
      observable: "NEXT_WINDOW_EXCESS_RETURN",
      direction: "INCREASE",
      minimumMagnitude: null,
      unit: "DECIMAL_RETURN",
      evaluationWindow: "15m",
    },
    falsificationCriteria: {
      observable: "NEXT_WINDOW_EXCESS_RETURN",
      metric: "MEAN_CONDITIONAL_EXCESS_RETURN",
      operator: "LTE",
      threshold: 0,
      unit: "DECIMAL_RETURN",
      evaluationWindow: "15m",
      minimumObservations: 200,
      rejectionStatement: "Reject when measured conditional mean is non-positive.",
    },
    requiredData: [{
      dataset: "LICENSED_INTRADAY_EQUITY_BARS",
      fields: ["security_id", "open", "high", "low", "close", "volume"],
      frequency: "15m",
      provenanceRequired: true,
      licenseRequired: true,
    }],
    knownLimitations: ["Regime and execution cost robustness require independent evaluation."],
    createdAt: "2026-08-25T00:00:00.000Z",
    generator: { name: "phase2-test", version: "1.0.0" },
    evidencePolicy: { requireKnownContentLicense: true, requireResolvedCorrections: true },
  }, [source]);
  const decision = createHypothesisDecisionV1({
    hypothesis,
    papers: [source],
    verdict: "APPROVE_FOR_RESEARCH",
    rationale: "Research-only approval.",
    decidedAt: "2026-08-25T01:00:00.000Z",
    committee: { name: "Research Committee", version: "1.0.0", members: ["reviewer-a", "reviewer-b"] },
  });
  const parameterSpace = [
    { name: "atrPeriod", domain: "PERIOD", valueType: "INTEGER", min: 7, max: 21, step: 7 },
    { name: "atrStop", domain: "POSITIVE_MULTIPLIER", valueType: "NUMBER", min: 0.5, max: 1.5, step: 0.5 },
    { name: "emaFast", domain: "PERIOD", valueType: "INTEGER", min: 5, max: 15, step: 5 },
    { name: "emaSlow", domain: "PERIOD", valueType: "INTEGER", min: 20, max: 60, step: 20 },
    { name: "rsiLower", domain: "RSI_LEVEL", valueType: "NUMBER", min: 40, max: 50, step: 5 },
    { name: "rsiPeriod", domain: "PERIOD", valueType: "INTEGER", min: 7, max: 21, step: 7 },
    { name: "rsiUpper", domain: "RSI_LEVEL", valueType: "NUMBER", min: 60, max: 70, step: 5 },
    { name: "targetDistance", domain: "PRICE_FRACTION", valueType: "NUMBER", min: 0.01, max: 0.03, step: 0.01 },
    { name: "timeBars", domain: "BAR_COUNT", valueType: "INTEGER", min: 2, max: 8, step: 2 },
  ];
  const indicator = (name, input, parameters = {}) => ({ kind: "INDICATOR", name, input, parameters });
  const parameter = (name) => ({ kind: "PARAMETER", name });
  const operator = (name, operands) => ({ kind: "OPERATOR", operator: name, operands });
  const template = {
    templateId: "phase2-continuation-v1",
    hypothesisBinding: {
      hypothesisId: hypothesis.hypothesisId,
      hypothesisConfigHash: hypothesis.configHash,
      decisionId: decision.decisionId,
      decisionHash: decision.decisionHash,
    },
    strategyFamily: "VOLUME_MOMENTUM_CONTINUATION",
    market: "US_STOCK",
    timeframe: "15m",
    direction: "LONG",
    entryDsl: {
      action: "LONG",
      rules: [
        operator("CROSSOVER", [
          indicator("EMA", "close", { period: "emaFast" }),
          indicator("EMA", "close", { period: "emaSlow" }),
        ]),
        operator("BETWEEN", [
          indicator("RSI", "close", { period: "rsiPeriod" }),
          parameter("rsiLower"),
          parameter("rsiUpper"),
        ]),
      ],
    },
    exitDsl: {
      rules: [
        { type: "ATR_STOP", atrIndicator: indicator("ATR", "ohlc", { period: "atrPeriod" }), multiplierParameter: "atrStop" },
        { type: "TARGET", distanceParameter: "targetDistance" },
        { type: "TIME_EXIT", barsParameter: "timeBars" },
      ],
    },
    parameterSpace,
    limits: { maxAstDepth: 6, maxIndicatorCount: 8, maxRuleCount: 8, maxAstNodes: 64 },
  };
  return compileStrategyHypothesisToFormulaCandidatesV1({
    hypothesis,
    decision,
    templates: [template],
    policy: {
      compilerId: "safe-hypothesis-formula-compiler",
      compilerVersion: "1.0.0",
      costPolicyIdentity: "US_INTRADAY_COST_V1",
      riskPolicyIdentity: "RESEARCH_RISK_V1",
      datasetIdentity: TRAIN_DATASET,
      datasetRole: "TRAIN",
      budget: generationBudget(),
    },
  });
}

function tournamentInput(overrides = {}) {
  return {
    formulaCandidates: formulaCandidates(),
    generationBudget: generationBudget(),
    search: {
      method: "GRID",
      seed: 7,
      requestedCandidates: 1,
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
    ...overrides,
  };
}

function metrics(overrides = {}) {
  return {
    totalTrades: 60,
    initialCapital: 10_000,
    finalCapital: 11_000,
    metrics: {
      totalReturn: 0.1,
      winRate: 0.55,
      profitFactor: 1.5,
      expectancy: 1.5,
      maximumDrawdown: 0.1,
      sharpe: 1.2,
      sortino: 1.4,
      calmar: 1,
      turnover: 2,
      ...overrides,
    },
    sample: {
      tradeCount: 60,
      independentPeriods: 6,
      regimeCounts: { BULL: 20, BEAR: 20, SIDEWAYS: 20 },
    },
  };
}

function costCell(value, id) { return { value, evidenceId: id }; }
function costScenario(name, multiplier = 1) {
  const costs = {
    commission: costCell(0.05 * multiplier, `${name}:commission`),
    spread: costCell(0.04 * multiplier, `${name}:spread`),
    slippage: costCell(0.03 * multiplier, `${name}:slippage`),
    tax: costCell(0.02 * multiplier, `${name}:tax`),
    funding: costCell(0, `${name}:funding-observed-zero`),
    latency: costCell(0.01 * multiplier, `${name}:latency`),
    liquidityImpact: costCell(0.05 * multiplier, `${name}:liquidity`),
  };
  const explicitCosts = Object.values(costs).reduce((sum, cell) => sum + cell.value, 0);
  const grossEdge = 1;
  return { name, status: "PASS", costs, grossEdge, explicitCosts, netEdge: grossEdge - explicitCosts };
}
function regimeEvidence() {
  return Object.fromEntries([
    "BULL", "BEAR", "SIDEWAYS", "HIGH_VOLATILITY", "LOW_VOLATILITY", "HIGH_SPREAD", "LOW_LIQUIDITY",
  ].map((name) => [name, {
    availability: "AVAILABLE",
    sampleCount: 20,
    passed: true,
    metrics: { winRate: 0.55, profitFactor: 1.3, expectancy: 0.5, maximumDrawdown: 0.12, return: 0.05 },
  }]));
}
function wfWindows(strategyHash, parameterIdentity, count = 3) {
  return Array.from({ length: count }, (_, index) => {
    const base = 1_600_000_000_000 + (index * 100_000);
    return {
      trainPeriod: { startTime: base, endTime: base + 10_000 },
      validationPeriod: { startTime: base + 20_000, endTime: base + 30_000 },
      oosPeriod: { startTime: base + 40_000, endTime: base + 50_000 },
      strategyHash,
      parameterIdentity,
      trades: 20,
      return: index === 2 ? -0.01 : 0.04,
      profitFactor: index === 2 ? 0.95 : 1.3,
      expectancy: index === 2 ? -0.1 : 0.5,
      maximumDrawdown: 0.1 + (index * 0.01),
    };
  });
}

function happyDependencies(overrides = {}) {
  let holdoutCalls = 0;
  const base = {
    loadDatasetMetadata: async () => ({
      datasetIdentity: TRAIN_DATASET,
      datasetRole: "TRAIN",
      market: "US_STOCK",
      timeframe: "15m",
      direction: "LONG",
      candleCount: 5000,
      independentPeriods: 8,
      availableFields: ["security_id", "open", "high", "low", "close", "volume"],
    }),
    runHistoricalBacktest: async ({ formulaCandidate, generatedCandidate }) => ({
      status: "PASS",
      canonicalBacktestOwner: "#690",
      executionEquivalent: true,
      strategyHash: formulaCandidate.formulaHash,
      parameterIdentity: generatedCandidate.parameterIdentity,
      datasetIdentity: TRAIN_DATASET,
      ...metrics(),
    }),
    runOos: async ({ formulaCandidate, generatedCandidate }) => ({
      status: "PASS",
      strategyHash: formulaCandidate.formulaHash,
      parameterIdentity: generatedCandidate.parameterIdentity,
      trainDatasetIdentity: TRAIN_DATASET,
      oosDatasetIdentity: OOS_DATASET,
      trainPeriod: { startTime: 1_600_000_000_000, endTime: 1_600_100_000_000 },
      oosPeriod: { startTime: 1_600_200_000_000, endTime: 1_600_300_000_000 },
      parameterFrozen: true,
      strategyFrozen: true,
      ...metrics({ totalReturn: 0.06, expectancy: 0.8 }),
    }),
    runPurgedOos: async ({ formulaCandidate, generatedCandidate }) => ({
      status: "PASS",
      strategyHash: formulaCandidate.formulaHash,
      parameterIdentity: generatedCandidate.parameterIdentity,
      purgedOosDatasetIdentity: PURGED_DATASET,
      purgeWindowBars: 20,
      embargoWindowBars: 5,
      featureLookbackBars: 20,
      overlappingLabelLeakage: false,
      timestampIntegrity: true,
      parameterFrozen: true,
      strategyFrozen: true,
    }),
    runWalkForward: async ({ formulaCandidate, generatedCandidate }) => ({
      status: "PASS",
      mode: "ROLLING",
      windows: wfWindows(formulaCandidate.formulaHash, generatedCandidate.parameterIdentity),
    }),
    runCostStress: async () => ({
      status: "PASS",
      scenarios: [costScenario("BASE_COST", 1), costScenario("MODERATE_STRESS", 1.5), costScenario("HIGH_STRESS", 2)],
    }),
    runRegimeStress: async () => ({ status: "PASS", regimes: regimeEvidence() }),
    runParameterNeighborhood: async () => ({
      status: "PASS",
      width: 2,
      points: [-2, -1, 0, 1, 2].map((offset) => ({
        offset,
        expectancy: 0.5 - (Math.abs(offset) * 0.05),
        maximumDrawdown: 0.1 + (Math.abs(offset) * 0.01),
        tradeCount: 50 - Math.abs(offset),
      })),
      performanceDecay: 0.1,
      signConsistency: true,
      maximumDrawdownConsistency: true,
      tradeCountConsistency: true,
      needleOptimum: false,
      passed: true,
    }),
    runStatisticalFirewall: async ({ candidateFamilySize, requiredAdjustedAlpha }) => ({
      status: "PASS",
      canonicalOwner: "#547",
      candidateFamilySize,
      multipleTesting: { method: "HOLM", adjustedAlpha: requiredAdjustedAlpha, passed: true },
      dsr: { value: 0.8, passed: true },
      pbo: { value: 0.1, passed: true },
      minimumN: { passed: true },
      parameterStability: { passed: true },
      walkForwardStability: { passed: true },
      regimeStability: { passed: true },
      confidenceScore: 0.85,
    }),
    runFinalHoldout: async ({ frozenStrategy, capabilityId, selectionAllowed, parameterTuningAllowed }) => {
      holdoutCalls += 1;
      return {
        status: "PASS",
        strategyHash: frozenStrategy.strategyHash,
        parameterIdentity: frozenStrategy.parameterIdentity,
        datasetIdentity: HOLDOUT_DATASET,
        capabilityId,
        evaluationCount: holdoutCalls,
        selectionAllowed,
        parameterTuningAllowed,
        metrics: { trades: 30, return: 0.03, expectancy: 0.2, profitFactor: 1.2, maximumDrawdown: 0.08 },
      };
    },
  };
  return { ...base, ...overrides, holdoutCalls: () => holdoutCalls };
}

test("canonical FSM enforces exact stage order, no skip, and no re-entry after non-PASS", () => {
  assert.deepEqual(RESEARCH_TOURNAMENT_STAGES, [
    "FORMULA_CANDIDATE", "SANITY_CHECK", "HISTORICAL_BACKTEST", "OOS", "PURGED_OOS",
    "WALK_FORWARD", "COST_STRESS", "REGIME_STRESS", "STATISTICAL_FIREWALL", "FINAL_HOLDOUT",
    "RESEARCH_SURVIVOR",
  ]);
  assert.deepEqual(RESEARCH_TOURNAMENT_STAGE_STATUSES, ["PASS", "FAIL", "MISSING_EVIDENCE", "NOT_EVALUABLE"]);
  const formula = formulaCandidates()[0];
  let fsm = createResearchTournamentFsmV1({ strategyHash: formula.formulaHash, observedAt: OBSERVED_AT });
  assert.throws(() => advanceResearchTournamentFsmV1(fsm, { stage: "HISTORICAL_BACKTEST", status: "PASS" }), /STAGE_SKIP/);
  fsm = advanceResearchTournamentFsmV1(fsm, { stage: "FORMULA_CANDIDATE", status: "PASS" });
  fsm = advanceResearchTournamentFsmV1(fsm, { stage: "SANITY_CHECK", status: "FAIL" });
  assert.throws(() => advanceResearchTournamentFsmV1(fsm, { stage: "HISTORICAL_BACKTEST", status: "PASS" }), /TERMINAL_REENTRY/);
});

test("FormulaCandidateV1 automatically traverses the strict tournament and only then becomes RESEARCH_SURVIVOR", async () => {
  const deps = happyDependencies();
  const result = await runResearchTournamentV1(tournamentInput(), deps);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.researchSurvivor, true);
  assert.equal(candidate.profitable, false);
  assert.equal(candidate.validatedChampion, false);
  assert.equal(candidate.tradingAuthority, false);
  assert.deepEqual(candidate.stageRecords.map((row) => row.stage), RESEARCH_TOURNAMENT_STAGES);
  assert.equal(candidate.stageRecords.every((row) => row.status === "PASS"), true);
  assert.equal(deps.holdoutCalls(), 1);
  assert.equal(result.ranking.length, 1);
  assert.equal(Object.keys(result.ranking[0].components).length, 10);
  assert.equal(result.safety.REAL_ORDER_ENABLED, false);
  assert.equal(result.safety.executionAuthority, "NONE");
});

test("sample sufficiency runs before performance: N=0 becomes MISSING_EVIDENCE and measured metrics stay null", async () => {
  let oosCalls = 0;
  const deps = happyDependencies({
    runHistoricalBacktest: async ({ formulaCandidate, generatedCandidate }) => ({
      status: "PASS",
      canonicalBacktestOwner: "#690",
      executionEquivalent: true,
      strategyHash: formulaCandidate.formulaHash,
      parameterIdentity: generatedCandidate.parameterIdentity,
      datasetIdentity: TRAIN_DATASET,
      totalTrades: 0,
      initialCapital: 10_000,
      finalCapital: 10_000,
      metrics: { totalReturn: 0, winRate: 0, profitFactor: 0, expectancy: 0, maximumDrawdown: 0 },
      sample: { tradeCount: 0, independentPeriods: 0, regimeCounts: { BULL: 0, BEAR: 0, SIDEWAYS: 0 } },
    }),
    runOos: async () => { oosCalls += 1; return {}; },
  });
  const result = await runResearchTournamentV1(tournamentInput(), deps);
  const candidate = result.candidates[0];
  assert.equal(candidate.failure.failedStage, "HISTORICAL_BACKTEST");
  assert.equal(candidate.failure.failureCode, "INSUFFICIENT_SAMPLE");
  assert.equal(candidate.stageRecords.at(-1).status, "MISSING_EVIDENCE");
  const measured = candidate.stageRecords.at(-1).evidence.metrics;
  assert.equal(measured.trades, 0);
  assert.equal(measured.expectancy, null);
  assert.equal(measured.profitFactor, null);
  assert.equal(measured.maximumDrawdown, null);
  assert.equal(measured.winRate, null);
  assert.equal(oosCalls, 0);
});

test("OOS detects overlap, strategy mutation, and parameter mutation without tuning or re-entry", async (t) => {
  for (const [name, mutate, expected] of [
    ["overlap", (row) => ({ ...row, oosDatasetIdentity: TRAIN_DATASET }), "OOS_OVERLAP"],
    ["strategy", (row) => ({ ...row, strategyHash: "f".repeat(64) }), "STRATEGY_HASH_MUTATION"],
    ["parameter", (row) => ({ ...row, parameterIdentity: "e".repeat(64) }), "PARAMETER_MUTATION"],
  ]) {
    await t.test(name, async () => {
      const base = happyDependencies();
      const original = base.runOos;
      const deps = happyDependencies({ runOos: async (payload) => mutate(await original(payload)) });
      const result = await runResearchTournamentV1(tournamentInput(), deps);
      assert.equal(result.candidates[0].failure.failedStage, "OOS");
      assert.equal(result.candidates[0].failure.failureCode, expected);
      assert.equal(deps.holdoutCalls(), 0);
    });
  }
});

test("Purged OOS rejects insufficient purge/lookback and overlapping-label leakage", async (t) => {
  for (const [name, override] of [
    ["short-purge", { purgeWindowBars: 5, featureLookbackBars: 20 }],
    ["label-leak", { overlappingLabelLeakage: true }],
  ]) {
    await t.test(name, async () => {
      const base = happyDependencies();
      const original = base.runPurgedOos;
      const deps = happyDependencies({ runPurgedOos: async (payload) => ({ ...(await original(payload)), ...override }) });
      const result = await runResearchTournamentV1(tournamentInput(), deps);
      assert.equal(result.candidates[0].failure.failedStage, "PURGED_OOS");
      assert.equal(result.candidates[0].failure.failureCode, "LEAKAGE_DETECTED");
    });
  }
});

test("Walk Forward supports rolling/expanding windows and preserves every window; insufficient windows are not evaluable as success", async (t) => {
  for (const mode of ["ROLLING", "EXPANDING"]) {
    await t.test(mode, async () => {
      const deps = happyDependencies({
        runWalkForward: async ({ formulaCandidate, generatedCandidate }) => ({
          status: "PASS",
          mode,
          windows: wfWindows(formulaCandidate.formulaHash, generatedCandidate.parameterIdentity, 3),
        }),
      });
      const result = await runResearchTournamentV1(tournamentInput(), deps);
      assert.equal(result.candidates[0].researchSurvivor, true);
      assert.equal(result.candidates[0].stageRecords.find((row) => row.stage === "WALK_FORWARD").evidence.windows.length, 3);
    });
  }
  await t.test("insufficient", async () => {
    const deps = happyDependencies({
      runWalkForward: async ({ formulaCandidate, generatedCandidate }) => ({
        status: "PASS",
        mode: "ROLLING",
        windows: wfWindows(formulaCandidate.formulaHash, generatedCandidate.parameterIdentity, 2),
      }),
    });
    const result = await runResearchTournamentV1(tournamentInput(), deps);
    assert.equal(result.candidates[0].failure.failureCode, "WALK_FORWARD_INSUFFICIENT");
    assert.equal(result.candidates[0].stageRecords.at(-1).status, "MISSING_EVIDENCE");
  });
});

test("Cost Stress requires evidenced commission/spread/slippage/tax/funding/latency/liquidity and rejects high stress fragility", async (t) => {
  await t.test("missing cost evidence", async () => {
    const scenarios = [costScenario("BASE_COST"), costScenario("MODERATE_STRESS", 1.5), costScenario("HIGH_STRESS", 2)];
    delete scenarios[1].costs.liquidityImpact;
    const deps = happyDependencies({ runCostStress: async () => ({ status: "PASS", scenarios }) });
    const result = await runResearchTournamentV1(tournamentInput(), deps);
    assert.equal(result.candidates[0].failure.failedStage, "COST_STRESS");
    assert.equal(result.candidates[0].failure.failureCode, "COST_EVIDENCE_MISSING");
    assert.equal(result.candidates[0].stageRecords.at(-1).status, "MISSING_EVIDENCE");
  });
  await t.test("high slippage/funding/liquidity fragility", async () => {
    const high = costScenario("HIGH_STRESS", 2);
    high.costs.slippage = costCell(0.45, "HIGH_STRESS:slippage");
    high.costs.funding = costCell(0.2, "HIGH_STRESS:funding");
    high.costs.liquidityImpact = costCell(0.35, "HIGH_STRESS:liquidity");
    high.explicitCosts = Object.values(high.costs).reduce((sum, cell) => sum + cell.value, 0);
    high.netEdge = high.grossEdge - high.explicitCosts;
    const deps = happyDependencies({
      runCostStress: async () => ({ status: "PASS", scenarios: [costScenario("BASE_COST"), costScenario("MODERATE_STRESS", 1.5), high] }),
    });
    const result = await runResearchTournamentV1(tournamentInput(), deps);
    assert.equal(result.candidates[0].failure.failureCode, "COST_FRAGILE");
  });
});

test("Regime Stress uses explicit N/A with nulls and never rewrites missing samples to zero", async () => {
  const regimes = regimeEvidence();
  regimes.HIGH_SPREAD = { availability: "N/A", sampleCount: null, metrics: null, reason: "no high-spread sample" };
  const deps = happyDependencies({ runRegimeStress: async () => ({ status: "PASS", regimes }) });
  const result = await runResearchTournamentV1(tournamentInput(), deps);
  assert.equal(result.candidates[0].researchSurvivor, true);
  const highSpread = result.candidates[0].stageRecords.find((row) => row.stage === "REGIME_STRESS").evidence.regimes.HIGH_SPREAD;
  assert.equal(highSpread.availability, "N/A");
  assert.equal(highSpread.sampleCount, null);
  assert.equal(highSpread.metrics, null);
});

test("Statistical Firewall enforces multiple testing, DSR, PBO, minimum N, and neighborhood stability", async (t) => {
  const cases = [
    ["DSR_FAIL", { runStatisticalFirewall: async ({ candidateFamilySize, requiredAdjustedAlpha }) => ({
      status: "PASS", canonicalOwner: "#547", candidateFamilySize,
      multipleTesting: { adjustedAlpha: requiredAdjustedAlpha, passed: true },
      dsr: { value: 0.2, passed: false }, pbo: { value: 0.1, passed: true },
      minimumN: { passed: true }, parameterStability: { passed: true }, walkForwardStability: { passed: true }, regimeStability: { passed: true },
    }) }],
    ["PBO_FAIL", { runStatisticalFirewall: async ({ candidateFamilySize, requiredAdjustedAlpha }) => ({
      status: "PASS", canonicalOwner: "#547", candidateFamilySize,
      multipleTesting: { adjustedAlpha: requiredAdjustedAlpha, passed: true },
      dsr: { value: 0.8, passed: true }, pbo: { value: 0.8, passed: false },
      minimumN: { passed: true }, parameterStability: { passed: true }, walkForwardStability: { passed: true }, regimeStability: { passed: true },
    }) }],
    ["MULTIPLE_TESTING_FAIL", { runStatisticalFirewall: async ({ candidateFamilySize }) => ({
      status: "PASS", canonicalOwner: "#547", candidateFamilySize,
      multipleTesting: { adjustedAlpha: 0.2, passed: true },
      dsr: { value: 0.8, passed: true }, pbo: { value: 0.1, passed: true },
      minimumN: { passed: true }, parameterStability: { passed: true }, walkForwardStability: { passed: true }, regimeStability: { passed: true },
    }) }],
    ["PARAMETER_INSTABILITY", { runParameterNeighborhood: async () => ({
      status: "PASS", width: 2,
      points: [-2, -1, 0, 1, 2].map((offset) => ({ offset, expectancy: offset === 0 ? 5 : -0.2, maximumDrawdown: 0.1, tradeCount: 50 })),
      performanceDecay: 1, signConsistency: false, maximumDrawdownConsistency: true, tradeCountConsistency: true, needleOptimum: true, passed: false,
    }) }],
  ];
  for (const [expected, override] of cases) {
    await t.test(expected, async () => {
      const deps = happyDependencies(override);
      const result = await runResearchTournamentV1(tournamentInput(), deps);
      assert.equal(result.candidates[0].failure.failedStage, "STATISTICAL_FIREWALL");
      assert.equal(result.candidates[0].failure.failureCode, expected);
      assert.equal(deps.holdoutCalls(), 0);
    });
  }
});

test("Final Holdout is inaccessible before the last stage, receives a restricted one-shot context, and cannot tune parameters", async () => {
  await assert.rejects(runResearchTournamentV1(tournamentInput({ holdoutEvidence: { leaked: true } }), happyDependencies()), /FINAL_HOLDOUT_PREACCESS_FORBIDDEN/);
  let payloadKeys = [];
  const deps = happyDependencies({
    runFinalHoldout: async (payload) => {
      payloadKeys = Object.keys(payload).sort();
      assert.equal(payload.formulaCompilerAccess, false);
      assert.equal(payload.candidateGeneratorAccess, false);
      assert.equal(payload.failureFeedbackAccess, false);
      assert.equal(payload.llmPromptContextAccess, false);
      assert.equal(payload.parameterTuningAllowed, false);
      assert.equal(payload.selectionAllowed, false);
      assert.equal(Object.hasOwn(payload, "search"), false);
      assert.equal(Object.hasOwn(payload, "formulaCandidates"), false);
      return {
        status: "PASS",
        strategyHash: payload.frozenStrategy.strategyHash,
        parameterIdentity: payload.frozenStrategy.parameterIdentity,
        datasetIdentity: HOLDOUT_DATASET,
        capabilityId: payload.capabilityId,
        evaluationCount: 1,
        selectionAllowed: false,
        parameterTuningAllowed: false,
        metrics: { trades: 30, return: 0.03, expectancy: 0.2, profitFactor: 1.2, maximumDrawdown: 0.08 },
      };
    },
  });
  const result = await runResearchTournamentV1(tournamentInput(), deps);
  assert.equal(result.candidates[0].researchSurvivor, true);
  assert.deepEqual(payloadKeys, [
    "candidateGeneratorAccess", "capabilityId", "evaluationOrdinal", "failureFeedbackAccess", "formulaCompilerAccess",
    "frozenStrategy", "llmPromptContextAccess", "parameterTuningAllowed", "selectionAllowed",
  ]);
});

test("Final Holdout rejects a second evaluation contract and creates immutable elimination evidence", async () => {
  const deps = happyDependencies({
    runFinalHoldout: async ({ frozenStrategy, capabilityId }) => ({
      status: "PASS",
      strategyHash: frozenStrategy.strategyHash,
      parameterIdentity: frozenStrategy.parameterIdentity,
      datasetIdentity: HOLDOUT_DATASET,
      capabilityId,
      evaluationCount: 2,
      selectionAllowed: false,
      parameterTuningAllowed: false,
      metrics: {},
    }),
  });
  const result = await runResearchTournamentV1(tournamentInput(), deps);
  const candidate = result.candidates[0];
  assert.equal(candidate.failure.failedStage, "FINAL_HOLDOUT");
  assert.equal(candidate.failure.failureCode, "HOLDOUT_CONTRACT_INVALID");
  assert.equal(candidate.researchFailureObservation.type, "ResearchFailureObservation");
  assert.equal(candidate.researchFailureObservation.formulaMutationAllowed, false);
  assert.equal(candidate.researchFailureObservation.performanceOverwriteAllowed, false);
});

test("resource exhaustion is NOT_EVALUABLE_RESOURCE_LIMIT, never FAIL or fabricated poor performance", async () => {
  let backtestCalls = 0;
  const deps = happyDependencies({
    loadDatasetMetadata: async () => ({
      datasetIdentity: TRAIN_DATASET,
      datasetRole: "TRAIN",
      market: "US_STOCK",
      timeframe: "15m",
      direction: "LONG",
      candleCount: 5000,
      availableFields: ["security_id", "open", "high", "low", "close", "volume"],
    }),
    runHistoricalBacktest: async () => { backtestCalls += 1; return {}; },
  });
  const input = tournamentInput({ budget: { ...tournamentInput().budget, maxTotalCandles: 1000 } });
  const result = await runResearchTournamentV1(input, deps);
  const record = result.candidates[0].stageRecords.at(-1);
  assert.equal(record.stage, "HISTORICAL_BACKTEST");
  assert.equal(record.status, "NOT_EVALUABLE");
  assert.equal(result.candidates[0].failure.failureCode, "NOT_EVALUABLE_RESOURCE_LIMIT");
  assert.equal(backtestCalls, 0);
});

test("invalid/duplicate FormulaCandidate is eliminated before any backtest and does not receive sample credit", async () => {
  const valid = formulaCandidates()[0];
  const duplicate = structuredClone(valid);
  const invalid = { ...structuredClone(valid), formulaHash: "0".repeat(64) };
  let metadataCalls = 0;
  const deps = happyDependencies({
    loadDatasetMetadata: async (...args) => {
      metadataCalls += 1;
      return happyDependencies().loadDatasetMetadata(...args);
    },
  });
  const result = await runResearchTournamentV1(tournamentInput({ formulaCandidates: [valid, duplicate, invalid] }), deps);
  assert.equal(result.candidates.filter((row) => row.failure?.failureCode === "DUPLICATE_FORMULA").length, 1);
  assert.equal(result.candidates.filter((row) => row.failure?.failureCode === "FORMULA_INVALID").length, 1);
  assert.equal(result.candidates.filter((row) => row.researchSurvivor).length, 1);
  assert.equal(metadataCalls, 1);
});

test("#690 one-pass adapter is execution-equivalent and does not create a second backtest engine", () => {
  const formula = formulaCandidates()[0];
  const generation = generateBoundedFormulaCandidatesV1({
    formulaCandidates: [formula],
    budget: generationBudget(),
    search: { method: "GRID", seed: 7, requestedCandidates: 1, datasetIdentity: TRAIN_DATASET, finalHoldoutAccess: false },
  });
  const generated = generation.generatedCandidates[0];
  const start = Date.UTC(2020, 0, 1);
  const candles = Array.from({ length: 120 }, (_, index) => {
    const base = 100 + (index * 0.1);
    return {
      timestamp: start + (index * 15 * 60 * 1000),
      open: base,
      high: base + 1.2,
      low: Math.max(1, base - 0.8),
      close: base + 0.4,
      volume: 1000 + index,
    };
  });
  const backtestInput = {
    market: "US_STOCK",
    symbol: "AAPL",
    timeframe: "15m",
    side: "long",
    candles,
    initialCapital: 10_000,
    costModel: {
      entryFeeRate: 0.001,
      exitFeeRate: 0.001,
      taxRate: 0,
      slippageRate: 0.0005,
      spreadRate: 0.0002,
      latencyBars: 0,
      latencyDriftRate: 0,
    },
  };
  const executionParameters = { atrPeriod: 7, stopAtrMultiple: 1, targetRiskMultiple: 1 };
  const signalEvaluator = ({ index }) => (index > 10 && index % 15 === 0 ? { safeDslSignal: true } : null);
  const period = { startTime: candles[0].timestamp, endTime: candles.at(-1).timestamp, includeFinalHoldout: false };
  const direct = runIndependentSignalBacktest({
    backtestInput,
    strategy: formula.strategyFamily,
    strategyVersion: "FORMULA_CANDIDATE_V1",
    parameters: executionParameters,
    signalEvaluator,
    period,
  });
  const adapter = runOnePassCandidateBacktestV1({
    formulaCandidate: formula,
    generatedCandidate: generated,
    datasetIdentity: TRAIN_DATASET,
    backtestInput,
    executionParameters,
    signalEvaluator,
    evaluatorContract: {
      source: "CANONICAL_SAFE_DSL_INTERPRETER",
      arbitraryExecutableCodeAllowed: false,
      formulaHash: formula.formulaHash,
    },
    period,
    liquidityImpactEvidence: { value: 0, evidenceId: "fixture:liquidity-observed-zero" },
  });
  assert.equal(adapter.canonicalBacktestOwner, "#690");
  assert.equal(adapter.executionEquivalent, true);
  assert.equal(adapter.executionEngine, "runIndependentSignalBacktest");
  assert.deepEqual(adapter.trades, direct.trades);
  assert.equal(adapter.metrics.trades, direct.totalTrades);
  assert.equal(adapter.metrics.expectancy, direct.expectancy);
  assert.equal(adapter.safety.executionAuthority, "NONE");
});

test("read model exposes compact tournament counts and ranking never includes missing-evidence candidates", async () => {
  const result = await runResearchTournamentV1(tournamentInput(), happyDependencies());
  const readModel = buildResearchTournamentReadModelV1(result);
  assert.equal(readModel.totals.totalCandidates, 1);
  assert.equal(readModel.totals.researchSurvivors, 1);
  assert.equal(readModel.labels.total, "전체 후보");
  assert.equal(readModel.labels.elimination, "탈락 이유");
  assert.equal(rankResearchSurvivorsV1(result.candidates).length, 1);

  const missing = await runResearchTournamentV1(tournamentInput(), happyDependencies({
    runHistoricalBacktest: async ({ formulaCandidate, generatedCandidate }) => ({
      status: "PASS",
      canonicalBacktestOwner: "#690",
      executionEquivalent: true,
      strategyHash: formulaCandidate.formulaHash,
      parameterIdentity: generatedCandidate.parameterIdentity,
      datasetIdentity: TRAIN_DATASET,
      totalTrades: 0,
      initialCapital: 10_000,
      finalCapital: 10_000,
      sample: { tradeCount: 0, independentPeriods: 0, regimeCounts: { BULL: 0, BEAR: 0, SIDEWAYS: 0 } },
    }),
  }));
  assert.equal(missing.ranking.length, 0);
  assert.equal(missing.researchSurvivorCount, 0);
});

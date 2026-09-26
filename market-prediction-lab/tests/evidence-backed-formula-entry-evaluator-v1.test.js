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
import {
  FormulaEntryEvaluatorError,
  buildEvidenceBackedFormulaExecutionParametersV1,
  createEvidenceBackedFormulaEntryRuntimeV1,
  createEvidenceBackedFormulaSignalEvaluatorV1,
} from "../src/evidence-backed-formula-entry-evaluator-v1.js";
import { runOnePassCandidateBacktestV1 } from "../src/research-tournament-engine-v1.js";

const START = Date.UTC(2020, 0, 2);
const STEP = 15 * 60 * 1000;

const parameter = (name) => ({ kind: "PARAMETER", name });
const indicator = (name, input, periodName) => ({
  kind: "INDICATOR",
  name,
  input,
  parameters: { period: periodName },
  lag: 1,
});
const operator = (name, operands) => ({ kind: "OPERATOR", operator: name, operands });

function candles(closes, volumes = closes.map(() => 100)) {
  return closes.map((close, index) => ({
    timestamp: START + (index * STEP),
    open: close,
    high: close + 0.5,
    low: Math.max(0.01, close - 0.5),
    close,
    volume: volumes[index],
  }));
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof FormulaEntryEvaluatorError && error.code === code);
}

test("EMA crossover uses the closed signal candle and crosses before next-open execution", () => {
  const runtime = createEvidenceBackedFormulaEntryRuntimeV1({
    selectedParameters: { emaFast: 2, emaSlow: 3 },
    entryDsl: {
      action: "LONG",
      rules: [operator("CROSSOVER", [
        indicator("EMA", "close", "emaFast"),
        indicator("EMA", "close", "emaSlow"),
      ])],
    },
  });
  const result = runtime.evaluate({ candles: candles([1, 1, 1, 2, 2]), index: 3 });
  assert.equal(result.status, "EVALUATED");
  assert.equal(result.signal, true);
  assert.equal(result.timestamp, START + (3 * STEP));
});

test("RSI recovery crossover and ceiling reproduce the #721 mean-reversion entry shape", () => {
  const runtime = createEvidenceBackedFormulaEntryRuntimeV1({
    selectedParameters: { rsiPeriod: 2, rsiRecover: 30, rsiCeiling: 60 },
    entryDsl: {
      action: "LONG",
      rules: [
        operator("CROSSOVER", [indicator("RSI", "close", "rsiPeriod"), parameter("rsiRecover")]),
        operator("LT", [indicator("RSI", "close", "rsiPeriod"), parameter("rsiCeiling")]),
      ],
    },
  });
  const result = runtime.evaluate({ candles: candles([3, 2, 1, 2, 2]), index: 3 });
  assert.equal(result.status, "EVALUATED");
  assert.equal(result.signal, true);
});

test("BREAKOUT and RVOL use prior windows only and reproduce the #721 breakout entry shape", () => {
  const runtime = createEvidenceBackedFormulaEntryRuntimeV1({
    selectedParameters: { breakoutPeriod: 3, breakoutThreshold: 0.5, rvolPeriod: 3, rvolMin: 1.5 },
    entryDsl: {
      action: "LONG",
      rules: [
        operator("GT", [indicator("BREAKOUT", "close", "breakoutPeriod"), parameter("breakoutThreshold")]),
        operator("GT", [indicator("RVOL", "volume", "rvolPeriod"), parameter("rvolMin")]),
      ],
    },
  });
  const result = runtime.evaluate({ candles: candles([1, 1, 1, 2, 2], [100, 100, 100, 300, 100]), index: 3 });
  assert.equal(result.status, "EVALUATED");
  assert.equal(result.signal, true);
});

test("ADX becomes evaluable causally and reproduces the #721 trend strength gate", () => {
  const runtime = createEvidenceBackedFormulaEntryRuntimeV1({
    selectedParameters: { adxPeriod: 2, adxMin: 10 },
    entryDsl: {
      action: "LONG",
      rules: [operator("GT", [indicator("ADX", "ohlc", "adxPeriod"), parameter("adxMin")])],
    },
  });
  const result = runtime.evaluate({ candles: candles([100, 101, 102, 103, 104]), index: 3 });
  assert.equal(result.status, "EVALUATED");
  assert.equal(result.signal, true);
});

test("evaluation never reads or validates candles after the closed signal index", () => {
  const entryDsl = {
    action: "LONG",
    rules: [operator("GT", [indicator("ROC", "close", "rocPeriod"), parameter("rocMin")])],
  };
  const selectedParameters = { rocPeriod: 2, rocMin: 0.01 };
  const prefix = candles([100, 100, 100, 103]);
  const withInvalidFuture = [...prefix, {
    timestamp: START + (4 * STEP), open: Number.NaN, high: Number.NaN, low: Number.NaN, close: Number.NaN, volume: Number.NaN,
  }];
  const first = createEvidenceBackedFormulaEntryRuntimeV1({ entryDsl, selectedParameters }).evaluate({
    candles: prefix,
    index: 3,
  });
  const second = createEvidenceBackedFormulaEntryRuntimeV1({ entryDsl, selectedParameters }).evaluate({
    candles: withInvalidFuture,
    index: 3,
  });
  assert.deepEqual(second, first);
  assert.equal(first.signal, true);
});

test("globally safe but unsupported DSL vocabulary fails closed instead of being guessed", () => {
  const smaRuntime = createEvidenceBackedFormulaEntryRuntimeV1({
    selectedParameters: { period: 2, threshold: 1 },
    entryDsl: {
      action: "LONG",
      rules: [operator("GT", [indicator("SMA", "close", "period"), parameter("threshold")])],
    },
  });
  expectCode(() => smaRuntime.evaluate({ candles: candles([1, 1, 2]), index: 2 }), "INDICATOR_NOT_SUPPORTED_BY_EVIDENCE_BACKED_EVALUATOR");

  const gteRuntime = createEvidenceBackedFormulaEntryRuntimeV1({
    selectedParameters: { rocPeriod: 2, threshold: 0 },
    entryDsl: {
      action: "LONG",
      rules: [operator("GTE", [indicator("ROC", "close", "rocPeriod"), parameter("threshold")])],
    },
  });
  expectCode(() => gteRuntime.evaluate({ candles: candles([1, 1, 2]), index: 2 }), "OPERATOR_NOT_SUPPORTED_BY_EVIDENCE_BACKED_EVALUATOR");
});

function paper() {
  return adaptCrossrefMetadata({
    status: "ok",
    "message-type": "work",
    "message-version": "1.0.0",
    message: {
      DOI: "10.1234/evidence-backed-formula-evaluator",
      title: ["Evidence backed formula evaluator fixture"],
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
    retrievedFrom: "https://api.crossref.org/v1/works/10.1234/evidence-backed-formula-evaluator",
  });
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

function compiledMomentumFormula() {
  const source = paper();
  const hypothesis = createStrategyHypothesisV1({
    title: "Evidence backed momentum evaluator hypothesis",
    statement: "Positive momentum with relative volume may support bounded continuation research.",
    marketScope: ["US_LARGE_CAP"],
    assetClass: "EQUITY",
    timeframeScope: ["15m"],
    directionality: "POSITIVE",
    rationale: "Fixture validates exact FormulaCandidate execution plumbing only.",
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
    knownLimitations: ["Execution and regime robustness require independent evaluation."],
    createdAt: "2026-08-25T00:00:00.000Z",
    generator: { name: "evaluator-test", version: "1.0.0" },
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
  const param = (name, domain, valueType, min, max, step) => ({ name, domain, valueType, min, max, step });
  const rawIndicator = (name, input, periodName) => ({ kind: "INDICATOR", name, input, parameters: { period: periodName } });
  const template = {
    templateId: "evidence-backed-us-short-momentum-rvol-v1",
    hypothesisBinding: {
      hypothesisId: hypothesis.hypothesisId,
      hypothesisConfigHash: hypothesis.configHash,
      decisionId: decision.decisionId,
      decisionHash: decision.decisionHash,
    },
    strategyFamily: "MOMENTUM_RVOL",
    market: "US_STOCK",
    timeframe: "15m",
    direction: "LONG",
    entryDsl: {
      action: "LONG",
      rules: [
        operator("GT", [rawIndicator("ROC", "close", "rocPeriod"), parameter("rocMin")]),
        operator("GT", [rawIndicator("RVOL", "volume", "rvolPeriod"), parameter("rvolMin")]),
      ],
    },
    exitDsl: {
      rules: [
        { type: "ATR_STOP", atrIndicator: rawIndicator("ATR", "ohlc", "atrPeriod"), multiplierParameter: "atrStop" },
        { type: "TARGET", distanceParameter: "targetDistance" },
        { type: "TIME_EXIT", barsParameter: "timeBars" },
      ],
    },
    parameterSpace: [
      param("atrPeriod", "PERIOD", "INTEGER", 2, 2, 1),
      param("atrStop", "POSITIVE_MULTIPLIER", "NUMBER", 1, 1, 0.5),
      param("rocPeriod", "PERIOD", "INTEGER", 2, 2, 1),
      param("rocMin", "NON_NEGATIVE_VALUE", "NUMBER", 0, 0.02, 0.01),
      param("rvolPeriod", "PERIOD", "INTEGER", 2, 2, 1),
      param("rvolMin", "NON_NEGATIVE_VALUE", "NUMBER", 1.2, 1.2, 0.1),
      param("targetDistance", "PRICE_FRACTION", "NUMBER", 0.02, 0.02, 0.01),
      param("timeBars", "BAR_COUNT", "INTEGER", 2, 2, 1),
    ],
    limits: { maxAstDepth: 6, maxIndicatorCount: 8, maxRuleCount: 8, maxAstNodes: 64 },
  };
  const formula = compileStrategyHypothesisToFormulaCandidatesV1({
    hypothesis,
    decision,
    templates: [template],
    policy: {
      compilerId: "safe-hypothesis-formula-compiler",
      compilerVersion: "1.0.0",
      costPolicyIdentity: "US_INTRADAY_COST_V1",
      riskPolicyIdentity: "RESEARCH_RISK_V1",
      datasetIdentity: "dataset:train:evaluator-v1",
      datasetRole: "TRAIN",
      budget: generationBudget(),
    },
  })[0];
  const generated = generateBoundedFormulaCandidatesV1({
    formulaCandidates: [formula],
    budget: generationBudget(),
    search: {
      method: "BOUNDED_GRID",
      seed: 7,
      requestedCandidates: 1,
      datasetIdentity: "dataset:train:evaluator-v1",
      finalHoldoutAccess: false,
    },
  }).generatedCandidates[0];
  return { formula, generated };
}

test("real FormulaCandidateV1 binds canonical parameter identity, #723 exit semantics, and #690 one-pass execution", () => {
  const { formula, generated } = compiledMomentumFormula();
  const executionParameters = buildEvidenceBackedFormulaExecutionParametersV1({ formulaCandidate: formula, generatedCandidate: generated });
  assert.deepEqual(executionParameters, {
    atrPeriod: 2,
    stopAtrMultiple: 1,
    targetDistance: 0.02,
    timeBars: 2,
  });
  const { signalEvaluator, evaluatorContract } = createEvidenceBackedFormulaSignalEvaluatorV1({ formulaCandidate: formula, generatedCandidate: generated });
  assert.equal(evaluatorContract.source, "CANONICAL_SAFE_DSL_INTERPRETER");
  assert.equal(evaluatorContract.closedCandleSignalOnly, true);
  assert.equal(evaluatorContract.entryUsesNextCandleOpen, true);
  assert.equal(evaluatorContract.indicatorLagBarsFromExecution, 1);
  assert.equal(evaluatorContract.executionAuthority, "NONE");

  const series = candles(
    [100, 100, 100, 103, 104, 105, 106, 107, 108, 109],
    [100, 100, 100, 300, 150, 150, 150, 150, 150, 150],
  );
  const directSignal = signalEvaluator({ market: "US_STOCK", side: "long", timeframe: "15m", candles: series, index: 3 });
  assert.equal(directSignal.safeDslSignal, true);
  assert.equal(directSignal.signalTimestamp, series[3].timestamp);

  const result = runOnePassCandidateBacktestV1({
    formulaCandidate: formula,
    generatedCandidate: generated,
    datasetIdentity: "dataset:train:evaluator-v1",
    backtestInput: {
      market: "US_STOCK",
      symbol: "AAPL",
      timeframe: "15m",
      side: "long",
      candles: series,
      initialCapital: 10_000,
      riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
      costModel: {
        entryFeeRate: 0,
        exitFeeRate: 0,
        taxRate: 0,
        slippageRate: 0,
        spreadRate: 0,
        latencyBars: 0,
        latencyDriftRate: 0,
      },
    },
    executionParameters,
    signalEvaluator,
    evaluatorContract,
    period: { startTime: series[0].timestamp, endTime: series.at(-1).timestamp, includeFinalHoldout: false },
    liquidityImpactEvidence: { value: 0, evidenceId: "fixture:liquidity-observed-zero" },
  });
  assert.equal(result.canonicalBacktestOwner, "#690");
  assert.equal(result.executionEquivalent, true);
  assert.equal(result.executionEngine, "runIndependentSignalBacktest");
  assert.ok(result.trades.length >= 1);
  assert.equal(result.safety.executionAuthority, "NONE");
});

test("valid-grid parameter mutation with stale parameterIdentity is rejected before evaluation", () => {
  const { formula, generated } = compiledMomentumFormula();
  const tampered = structuredClone(generated);
  tampered.selectedParameters = { ...tampered.selectedParameters, rocMin: 0.01 };
  expectCode(
    () => buildEvidenceBackedFormulaExecutionParametersV1({ formulaCandidate: formula, generatedCandidate: tampered }),
    "PARAMETER_IDENTITY_MISMATCH",
  );
});

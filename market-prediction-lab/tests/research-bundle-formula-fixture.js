// TEST_ONLY fixture extracted from the canonical safe evaluator tests. Economic credit: 0.
import { adaptCrossrefMetadata } from '../../packages/external-research/src/index.js';
import { createHypothesisDecisionV1, createStrategyHypothesisV1 } from '../../packages/strategy-hypothesis/src/index.js';
import { compileStrategyHypothesisToFormulaCandidatesV1, generateBoundedFormulaCandidatesV1 } from '../src/autonomous-strategy-formula-generator-v1.js';
const parameter = (name) => ({ kind: 'PARAMETER', name });
const operator = (name, operands) => ({ kind: 'OPERATOR', operator: name, operands });
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



export { compiledMomentumFormula };

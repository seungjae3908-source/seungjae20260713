import assert from "node:assert/strict";
import test from "node:test";

import { adaptCrossrefMetadata } from "../../packages/external-research/src/index.js";
import {
  createHypothesisDecisionV1,
  createStrategyHypothesisV1,
} from "../../packages/strategy-hypothesis/src/index.js";
import {
  SAFE_STRATEGY_ENTRY_ACTIONS,
  SAFE_STRATEGY_EXIT_TYPES,
  SAFE_STRATEGY_INDICATORS,
  SAFE_STRATEGY_OPERATORS,
  canonicalSerializeStrategyFormulaV1,
  compileStrategyHypothesisToFormulaCandidatesV1,
  createBoundedStrategySpecification,
  createDualFreeAiReviewPlan,
  createSafeStrategyDslV1,
  deduplicateFormulaCandidatesV1,
  generateBoundedFormulaCandidatesV1,
  generateBoundedStrategyVariants,
  verifyDualFreeAiReviewPlan,
} from "../src/autonomous-strategy-formula-generator-v1.js";

const CREATED_AT = "2026-08-25T00:00:00.000Z";
const DECIDED_AT = "2026-08-25T01:00:00.000Z";

function paper(doi) {
  return adaptCrossrefMetadata({
    status: "ok",
    "message-type": "work",
    "message-version": "1.0.0",
    message: {
      DOI: doi,
      title: [`Evidence for ${doi}`],
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
    retrievedFrom: `https://api.crossref.org/v1/works/${doi}`,
  });
}

const supportingPaper = paper("10.1234/phase1.supporting");
const contradictoryPaper = paper("10.1234/phase1.contradictory");

function hypothesis({ contradictory = false } = {}) {
  const contradictoryPapers = contradictory ? [contradictoryPaper] : [];
  const supportingPaperIds = [supportingPaper.paperId];
  const contradictoryPaperIds = contradictoryPapers.map((entry) => entry.paperId);
  return createStrategyHypothesisV1({
    title: "Intraday continuation research hypothesis",
    statement: "Volume-confirmed positive momentum may increase next-window continuation probability.",
    marketScope: ["US_LARGE_CAP"],
    assetClass: "EQUITY",
    timeframeScope: ["15m"],
    directionality: "POSITIVE",
    rationale: "The evidence justifies bounded formula research, not a profitability or trading decision.",
    supportingPaperIds,
    contradictoryPaperIds,
    evidenceStrength: { supporting: "STRONG", contradictory: contradictory ? "STRONG" : "NONE" },
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
      rejectionStatement: "Reject when the measured conditional mean is non-positive.",
    },
    requiredData: [{
      dataset: "LICENSED_INTRADAY_EQUITY_BARS",
      fields: ["security_id", "open", "high", "low", "close", "volume"],
      frequency: "15m",
      provenanceRequired: true,
      licenseRequired: true,
    }],
    knownLimitations: ["Market-impact and regime dependence require independent evaluation."],
    createdAt: CREATED_AT,
    generator: { name: "phase1-test", version: "1.0.0" },
    evidencePolicy: { requireKnownContentLicense: true, requireResolvedCorrections: true },
  }, [supportingPaper, ...contradictoryPapers]);
}

function decision(hypothesisValue, verdict = "APPROVE_FOR_RESEARCH", papers = [supportingPaper]) {
  return createHypothesisDecisionV1({
    hypothesis: hypothesisValue,
    papers,
    verdict,
    rationale: "Committee decision remains research-only.",
    decidedAt: DECIDED_AT,
    committee: { name: "Research Committee", version: "1.0.0", members: ["reviewer-a", "reviewer-b"] },
  });
}

function budget(overrides = {}) {
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

function limits(overrides = {}) {
  return {
    maxAstDepth: 6,
    maxIndicatorCount: 8,
    maxRuleCount: 8,
    maxAstNodes: 64,
    ...overrides,
  };
}

function parameters(overrides = {}) {
  const rows = [
    { name: "atrPeriod", domain: "PERIOD", valueType: "INTEGER", min: 7, max: 21, step: 7 },
    { name: "atrStop", domain: "POSITIVE_MULTIPLIER", valueType: "NUMBER", min: 0.5, max: 3, step: 0.5 },
    { name: "emaFast", domain: "PERIOD", valueType: "INTEGER", min: 5, max: 15, step: 5 },
    { name: "emaSlow", domain: "PERIOD", valueType: "INTEGER", min: 20, max: 60, step: 20 },
    { name: "rsiLower", domain: "RSI_LEVEL", valueType: "NUMBER", min: 45, max: 50, step: 5 },
    { name: "rsiPeriod", domain: "PERIOD", valueType: "INTEGER", min: 7, max: 21, step: 7 },
    { name: "rsiUpper", domain: "RSI_LEVEL", valueType: "NUMBER", min: 60, max: 70, step: 5 },
    { name: "targetDistance", domain: "PRICE_FRACTION", valueType: "NUMBER", min: 0.01, max: 0.03, step: 0.01 },
    { name: "timeBars", domain: "BAR_COUNT", valueType: "INTEGER", min: 2, max: 8, step: 2 },
  ];
  return rows.map((row) => overrides[row.name] ? { ...row, ...overrides[row.name] } : row);
}

const parameterNode = (name) => ({ kind: "PARAMETER", name });
const indicator = (name, input, indicatorParameters = {}) => ({ kind: "INDICATOR", name, input, parameters: indicatorParameters });
const operator = (name, operands) => ({ kind: "OPERATOR", operator: name, operands });

function entryDsl() {
  return {
    action: "LONG",
    rules: [
      operator("CROSSOVER", [
        indicator("EMA", "close", { period: "emaFast" }),
        indicator("EMA", "close", { period: "emaSlow" }),
      ]),
      operator("BETWEEN", [
        indicator("RSI", "close", { period: "rsiPeriod" }),
        parameterNode("rsiLower"),
        parameterNode("rsiUpper"),
      ]),
    ],
  };
}

function exitDsl() {
  return {
    rules: [
      {
        type: "ATR_STOP",
        atrIndicator: indicator("ATR", "ohlc", { period: "atrPeriod" }),
        multiplierParameter: "atrStop",
      },
      { type: "TARGET", distanceParameter: "targetDistance" },
      { type: "TIME_EXIT", barsParameter: "timeBars" },
    ],
  };
}

function safeDslInput(overrides = {}) {
  return {
    market: "US_STOCK",
    timeframe: "15m",
    direction: "LONG",
    availableDataFields: ["close", "high", "low", "open", "security_id", "volume"],
    entryDsl: entryDsl(),
    exitDsl: exitDsl(),
    parameterSpace: parameters(),
    limits: limits(),
    ...overrides,
  };
}

function binding(hypothesisValue, decisionValue) {
  return {
    hypothesisId: hypothesisValue.hypothesisId,
    hypothesisConfigHash: hypothesisValue.configHash,
    decisionId: decisionValue.decisionId,
    decisionHash: decisionValue.decisionHash,
  };
}

function template(hypothesisValue, decisionValue, overrides = {}) {
  return {
    templateId: "volume-momentum-continuation-v1",
    hypothesisBinding: binding(hypothesisValue, decisionValue),
    strategyFamily: "VOLUME_MOMENTUM_CONTINUATION",
    market: "US_STOCK",
    timeframe: "15m",
    direction: "LONG",
    entryDsl: entryDsl(),
    exitDsl: exitDsl(),
    parameterSpace: parameters(),
    limits: limits(),
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    compilerId: "safe-hypothesis-formula-compiler",
    compilerVersion: "1.0.0",
    costPolicyIdentity: "US_INTRADAY_COST_V1",
    riskPolicyIdentity: "RESEARCH_RISK_V1",
    datasetIdentity: "dataset:train:phase1-v1",
    datasetRole: "TRAIN",
    budget: budget(),
    ...overrides,
  };
}

function approvedCandidates(templatesFactory = null) {
  const hypothesisValue = hypothesis();
  const decisionValue = decision(hypothesisValue);
  return compileStrategyHypothesisToFormulaCandidatesV1({
    hypothesis: hypothesisValue,
    decision: decisionValue,
    templates: templatesFactory ? templatesFactory(hypothesisValue, decisionValue) : [template(hypothesisValue, decisionValue)],
    policy: policy(),
  });
}

test("valid strategy DSL is canonical, deeply frozen, and deterministically SHA-256 identified", () => {
  const first = createSafeStrategyDslV1(safeDslInput());
  const secondInput = safeDslInput();
  secondInput.availableDataFields = [...secondInput.availableDataFields].reverse();
  secondInput.parameterSpace = [...secondInput.parameterSpace].reverse();
  const second = createSafeStrategyDslV1(secondInput);
  assert.equal(first.dslHash, second.dslHash);
  assert.match(first.dslHash, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(first.entryDsl.rules[0]), true);
  assert.equal(first.safety.executionAuthority, "NONE");
  assert.equal(first.safety.arbitraryExecutableCodeAllowed, false);
});

test("Phase 1 indicator, operator, entry, and exit vocabularies are locked", () => {
  assert.deepEqual(SAFE_STRATEGY_INDICATORS, [
    "SMA", "EMA", "RSI", "MACD", "ATR", "BOLLINGER", "VWAP", "VOLUME",
    "RVOL", "ROC", "MOMENTUM", "ADX", "VOLATILITY", "BREAKOUT", "REGIME",
  ]);
  assert.deepEqual(SAFE_STRATEGY_OPERATORS, [
    "GT", "GTE", "LT", "LTE", "BETWEEN", "CROSSOVER", "CROSSUNDER", "RISING", "FALLING", "PERCENTILE",
  ]);
  assert.deepEqual(SAFE_STRATEGY_ENTRY_ACTIONS, ["LONG", "SHORT", "NO_TRADE"]);
  assert.deepEqual(SAFE_STRATEGY_EXIT_TYPES, [
    "FIXED_STOP", "ATR_STOP", "TARGET", "TRAILING_STOP", "TIME_EXIT", "INVALIDATION_EXIT",
  ]);
});

test("legacy #550/#555 bounded specification and free-review plan APIs remain compatible and stricter", () => {
  const plan = createDualFreeAiReviewPlan({
    evidenceFingerprint: "evidence:legacy-compat",
    providers: [
      { providerId: "free-a", modelId: "model-a", billingTier: "FREE", state: "AVAILABLE", priority: 0 },
      { providerId: "free-b", modelId: "model-b", billingTier: "FREE", state: "AVAILABLE", priority: 1 },
    ],
  });
  assert.equal(plan.status, "DUAL_FREE_AI_READY");
  assert.equal(verifyDualFreeAiReviewPlan(plan), true);

  const legacy = createBoundedStrategySpecification({
    market: "US_STOCK",
    direction: "BUY",
    timeframe: "1d",
    universe: { type: "POINT_IN_TIME" },
    availableFeatures: ["MOMENTUM"],
    entryFormula: { op: "GT", args: [{ op: "FEATURE", feature: "MOMENTUM", lag: 1 }, { op: "CONSTANT", value: 0 }] },
    exitFormula: { op: "LT", args: [{ op: "FEATURE", feature: "MOMENTUM", lag: 1 }, { op: "CONSTANT", value: 0 }] },
    parameters: { lookback: { value: 20, min: 5, max: 60 } },
    limits: { maxDepth: 4, maxNodes: 16, maxIndicatorCount: 4 },
    holdingPeriod: { maxBars: 20 },
    rebalance: { cadence: "DAILY" },
    liquidityRequirement: { state: "REQUIRED" },
    risk: { maxLeverage: 1, supportedLeverageConstraint: 1, sizingRule: { type: "BOUNDED" } },
  });
  assert.equal(generateBoundedStrategyVariants({ baseSpecification: legacy, parameterVariants: { lookback: [10, 20, 30] }, maxCandidates: 3 }).length, 3);
  assert.throws(() => createBoundedStrategySpecification({ ...legacy, process: "spawn" }), /STRATEGY_SPECIFICATION_UNKNOWN_FIELD/);
});

test("DSL rejects invalid indicators, unknown fields, code payloads, and network/process attempts", () => {
  const invalidIndicator = safeDslInput();
  invalidIndicator.entryDsl.rules[0].operands[0].name = "PYTHON_EVAL";
  assert.throws(() => createSafeStrategyDslV1(invalidIndicator), /INDICATOR_INVALID/);

  assert.throws(() => createSafeStrategyDslV1({ ...safeDslInput(), executableCode: "process.exit()" }), /SAFE_STRATEGY_DSL_SHAPE_INVALID/);

  const codePayload = safeDslInput();
  codePayload.entryDsl.rules[0].code = "fetch('https:\/\/example.com')";
  assert.throws(() => createSafeStrategyDslV1(codePayload), /OPERATOR_NODE_SHAPE_INVALID/);

  const processPayload = safeDslInput();
  processPayload.entryDsl.rules[0].operands[0].process = { command: "whoami" };
  assert.throws(() => createSafeStrategyDslV1(processPayload), /INDICATOR_NODE_SHAPE_INVALID/);
});

test("DSL enforces AST depth, indicator count, and rule count bounds", () => {
  const deep = safeDslInput({
    parameterSpace: [
      { name: "percentile", domain: "PERCENTILE_LEVEL", valueType: "NUMBER", min: 10, max: 90, step: 10 },
      { name: "emaPeriod", domain: "PERIOD", valueType: "INTEGER", min: 5, max: 20, step: 5 },
      { name: "stop", domain: "PRICE_FRACTION", valueType: "NUMBER", min: 0.01, max: 0.02, step: 0.01 },
    ],
    exitDsl: { rules: [{ type: "FIXED_STOP", distanceParameter: "stop" }] },
    limits: limits({ maxAstDepth: 3 }),
  });
  let nested = indicator("EMA", "close", { period: "emaPeriod" });
  for (let index = 0; index < 5; index += 1) nested = operator("PERCENTILE", [nested, parameterNode("percentile")]);
  deep.entryDsl = { action: "LONG", rules: [operator("GT", [nested, parameterNode("percentile")])] };
  assert.throws(() => createSafeStrategyDslV1(deep), /STRATEGY_DSL_MAX_DEPTH_EXCEEDED/);

  const indicators = safeDslInput({ limits: limits({ maxIndicatorCount: 2 }) });
  assert.throws(() => createSafeStrategyDslV1(indicators), /STRATEGY_DSL_MAX_INDICATORS_EXCEEDED/);

  const rules = safeDslInput({ limits: limits({ maxRuleCount: 4 }) });
  assert.throws(() => createSafeStrategyDslV1(rules), /STRATEGY_DSL_MAX_RULES_EXCEEDED/);
});

test("DSL rejects out-of-domain, NaN, Infinity, and unused parameters", () => {
  assert.throws(() => createSafeStrategyDslV1(safeDslInput({ parameterSpace: parameters({ rsiLower: { min: -1 } }) })), /PARAMETER_OUTSIDE_DOMAIN/);
  assert.throws(() => createSafeStrategyDslV1(safeDslInput({ parameterSpace: parameters({ atrStop: { max: Number.NaN } }) })), /PARAMETER_NON_FINITE/);
  assert.throws(() => createSafeStrategyDslV1(safeDslInput({ parameterSpace: parameters({ atrStop: { max: Number.POSITIVE_INFINITY } }) })), /PARAMETER_NON_FINITE/);
  assert.throws(() => createSafeStrategyDslV1(safeDslInput({
    parameterSpace: [...parameters(), { name: "unused", domain: "PERIOD", valueType: "INTEGER", min: 2, max: 4, step: 1 }],
  })), /UNUSED_PARAMETERS_FORBIDDEN/);
});

test("all exit forms remain structurally separate from entry and bounded", () => {
  const input = safeDslInput({
    parameterSpace: [
      ...parameters(),
      { name: "fixedStop", domain: "PRICE_FRACTION", valueType: "NUMBER", min: 0.005, max: 0.02, step: 0.005 },
      { name: "trailingStop", domain: "PRICE_FRACTION", valueType: "NUMBER", min: 0.005, max: 0.02, step: 0.005 },
    ],
    exitDsl: {
      rules: [
        { type: "FIXED_STOP", distanceParameter: "fixedStop" },
        {
          type: "ATR_STOP",
          atrIndicator: indicator("ATR", "ohlc", { period: "atrPeriod" }),
          multiplierParameter: "atrStop",
        },
        { type: "TARGET", distanceParameter: "targetDistance" },
        { type: "TRAILING_STOP", distanceParameter: "trailingStop" },
        { type: "TIME_EXIT", barsParameter: "timeBars" },
        {
          type: "INVALIDATION_EXIT",
          rule: operator("LT", [indicator("RSI", "close", { period: "rsiPeriod" }), parameterNode("rsiLower")]),
        },
      ],
    },
  });
  const dsl = createSafeStrategyDslV1(input);
  assert.deepEqual(dsl.exitDsl.rules.map((rule) => rule.type), SAFE_STRATEGY_EXIT_TYPES);
  assert.equal("action" in dsl.exitDsl, false);
  assert.equal("rules" in dsl.entryDsl, true);
});

test("approved StrategyHypothesisV1 compiles to bounded FormulaCandidateV1 without Formula PASS", () => {
  const candidates = approvedCandidates();
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.match(candidate.candidateId, /^formula-candidate:sha256:[0-9a-f]{64}$/u);
  assert.match(candidate.formulaHash, /^[0-9a-f]{64}$/u);
  assert.equal(candidate.hypothesisId.startsWith("hypothesis:sha256:"), true);
  assert.equal(candidate.evaluationStatus, "NOT_EVALUATED");
  assert.equal(candidate.formulaPassed, false);
  assert.equal(candidate.provenance.sourceContract, "StrategyHypothesisV1");
  assert.equal(candidate.provenance.datasetRole, "TRAIN");
  assert.equal(candidate.costPolicyIdentity, "US_INTRADAY_COST_V1");
  assert.equal(candidate.riskPolicyIdentity, "RESEARCH_RISK_V1");
});

test("rejected, conflicted, and missing-evidence decisions compile to zero candidates", () => {
  const rejectedHypothesis = hypothesis();
  const rejectedDecision = decision(rejectedHypothesis, "REJECT");
  assert.deepEqual(compileStrategyHypothesisToFormulaCandidatesV1({
    hypothesis: rejectedHypothesis,
    decision: rejectedDecision,
    templates: [template(rejectedHypothesis, rejectedDecision)],
    policy: policy(),
  }), []);

  const missingHypothesis = hypothesis();
  const missingDecision = decision(missingHypothesis, "MISSING_EVIDENCE", []);
  assert.deepEqual(compileStrategyHypothesisToFormulaCandidatesV1({
    hypothesis: missingHypothesis,
    decision: missingDecision,
    templates: [template(missingHypothesis, missingDecision)],
    policy: policy(),
  }), []);

  const conflictedHypothesis = hypothesis({ contradictory: true });
  const conflictedDecision = decision(conflictedHypothesis, "CONFLICTED", [supportingPaper, contradictoryPaper]);
  assert.deepEqual(compileStrategyHypothesisToFormulaCandidatesV1({
    hypothesis: conflictedHypothesis,
    decision: conflictedDecision,
    templates: [template(conflictedHypothesis, conflictedDecision)],
    policy: policy(),
  }), []);
});

test("compiler rejects parameter-domain overflow and provenance mismatch", () => {
  const hypothesisValue = hypothesis();
  const decisionValue = decision(hypothesisValue);
  assert.throws(() => compileStrategyHypothesisToFormulaCandidatesV1({
    hypothesis: hypothesisValue,
    decision: decisionValue,
    templates: [template(hypothesisValue, decisionValue, { parameterSpace: parameters({ rsiUpper: { max: 101 } }) })],
    policy: policy(),
  }), /PARAMETER_OUTSIDE_DOMAIN/);

  const badBinding = binding(hypothesisValue, decisionValue);
  badBinding.hypothesisConfigHash = "0".repeat(64);
  assert.throws(() => compileStrategyHypothesisToFormulaCandidatesV1({
    hypothesis: hypothesisValue,
    decision: decisionValue,
    templates: [template(hypothesisValue, decisionValue, { hypothesisBinding: badBinding })],
    policy: policy(),
  }), /HYPOTHESIS_PROVENANCE_MISMATCH/);
});

test("exact formula hashes are removed while family and semantic similarity never auto-merge", () => {
  const [candidate] = approvedCandidates();
  const exact = deduplicateFormulaCandidatesV1({ candidates: [candidate, candidate] });
  assert.equal(exact.acceptedCandidates.length, 1);
  assert.equal(exact.decisions.some((row) => row.type === "EXACT_FORMULA_HASH" && row.action === "DROP_EXACT_DUPLICATE"), true);

  const variants = approvedCandidates((hypothesisValue, decisionValue) => [
    template(hypothesisValue, decisionValue, { templateId: "variant-a" }),
    template(hypothesisValue, decisionValue, {
      templateId: "variant-b",
      parameterSpace: parameters({ emaFast: { max: 10 } }),
    }),
  ]);
  const similar = deduplicateFormulaCandidatesV1({ candidates: variants });
  assert.equal(similar.acceptedCandidates.length, 2);
  assert.equal(similar.decisions.some((row) => row.type === "FAMILY_FINGERPRINT" && row.action === "REVIEW_REQUIRED_NO_AUTOMATIC_MERGE"), true);
  assert.equal(similar.decisions.some((row) => row.type === "SEMANTIC_SIMILARITY_CANDIDATE" && row.action === "REVIEW_REQUIRED_NO_AUTOMATIC_MERGE"), true);
});

test("seeded random search is deterministic and records seed, budgets, search space, and dataset", () => {
  const candidates = approvedCandidates();
  const input = {
    formulaCandidates: candidates,
    budget: budget({ maxCandidatesPerHypothesis: 5, maxCandidatesPerRun: 5 }),
    search: {
      method: "SEEDED_RANDOM",
      seed: 424242,
      requestedCandidates: 5,
      datasetIdentity: "dataset:train:phase1-v1",
      finalHoldoutAccess: false,
    },
  };
  const first = generateBoundedFormulaCandidatesV1(input);
  const second = generateBoundedFormulaCandidatesV1(structuredClone(input));
  assert.equal(canonicalSerializeStrategyFormulaV1(first), canonicalSerializeStrategyFormulaV1(second));
  assert.equal(first.generatedCandidates.length, 5);
  assert.equal(first.search.seed, 424242);
  assert.equal(first.generatedCandidates[0].searchProvenance.datasetIdentity, "dataset:train:phase1-v1");
  assert.match(first.generatedCandidates[0].searchProvenance.searchSpaceHash, /^[0-9a-f]{64}$/u);
  assert.equal(first.generatedCandidates[0].searchProvenance.finalHoldoutAccess, false);
});

test("bounded grid and deterministic sampling stop at explicit candidate and combination budgets", () => {
  const candidates = approvedCandidates();
  for (const method of ["BOUNDED_GRID", "DETERMINISTIC_SAMPLING"]) {
    const result = generateBoundedFormulaCandidatesV1({
      formulaCandidates: candidates,
      budget: budget({ maxCandidatesPerHypothesis: 3, maxCandidatesPerRun: 3, maxParameterCombinations: 4 }),
      search: {
        method,
        seed: 7,
        requestedCandidates: 3,
        datasetIdentity: "dataset:train:phase1-v1",
        finalHoldoutAccess: false,
      },
    });
    assert.ok(result.generatedCandidates.length <= 3);
    assert.ok(result.budgetUsage.parameterCombinationsVisited <= 4);
    assert.ok(result.budgetUsage.generationsUsed <= 1);
  }
});

test("generator rejects Final Holdout access, dataset mismatch, and unbounded requests", () => {
  const candidates = approvedCandidates();
  const base = {
    formulaCandidates: candidates,
    budget: budget(),
    search: {
      method: "SEEDED_RANDOM",
      seed: 1,
      requestedCandidates: 4,
      datasetIdentity: "dataset:train:phase1-v1",
      finalHoldoutAccess: false,
    },
  };
  assert.throws(() => generateBoundedFormulaCandidatesV1({
    ...base,
    search: { ...base.search, finalHoldoutAccess: true },
  }), /FINAL_HOLDOUT_PARAMETER_ACCESS_FORBIDDEN/);
  assert.throws(() => generateBoundedFormulaCandidatesV1({
    ...base,
    search: { ...base.search, datasetIdentity: "dataset:validation:other" },
  }), /PARAMETER_SEARCH_DATASET_MISMATCH/);
  assert.throws(() => generateBoundedFormulaCandidatesV1({
    ...base,
    budget: budget({ maxCandidatesPerHypothesis: 8, maxCandidatesPerRun: 8, maxParameterCombinations: 10001 }),
  }), /MAXPARAMETERCOMBINATIONS_INVALID/);
});

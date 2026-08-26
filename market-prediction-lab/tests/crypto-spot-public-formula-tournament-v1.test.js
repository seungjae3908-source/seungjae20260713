import assert from "node:assert/strict";
import test from "node:test";

import { adaptCrossrefMetadata } from "../../packages/external-research/src/index.js";
import {
  createHypothesisDecisionV1,
  createStrategyHypothesisV1,
} from "../../packages/strategy-hypothesis/src/index.js";
import {
  CryptoSpotPublicFormulaTournamentError,
  prepareCryptoSpotPublicFormulaTournamentDatasetV1,
  runCryptoSpotPublicFormulaTournamentV1,
} from "../src/crypto-spot-public-formula-tournament-v1.js";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";

const INTERVAL = 15 * 60 * 1000;
const PLACEHOLDER_DATASET = "dataset:will-be-rebound-to-public-bitget";
const OBSERVED_AT = "2026-08-26T11:45:00.000Z";

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof CryptoSpotPublicFormulaTournamentError && error.code === code);
}

function syntheticCandles({ timeframeMs = INTERVAL, before = 220, after = 780, gapIndex = null } = {}) {
  const first = RESEARCH_BACKTEST_PERIOD.validationStartTime - (before * timeframeMs);
  const rows = [];
  for (let index = 0; index < before + after; index += 1) {
    const adjustedIndex = gapIndex !== null && index >= gapIndex ? index + 1 : index;
    const timestamp = first + (adjustedIndex * timeframeMs);
    const close = 100 * (1.004 ** index);
    const open = close / 1.001;
    const high = close * 1.003;
    const low = open * 0.997;
    const volume = index % 4 === 0 ? 500 : 100;
    rows.push(Object.freeze({ timestamp, open, high, low, close, volume }));
  }
  return Object.freeze(rows);
}

function collectedFixture({ timeframe = "15m", candles = syntheticCandles(), provider = "bitget-public-v2", market = "CRYPTO_SPOT" } = {}) {
  return Object.freeze({
    schemaVersion: 1,
    provider,
    collectedAt: Date.UTC(2026, 7, 26, 11, 40),
    market,
    symbol: "BTCUSDT",
    timeframe,
    candles,
  });
}

function fakeBitgetClient(candles) {
  return Object.freeze({
    async get(_endpoint, params) {
      const eligible = candles.filter((candle) => candle.timestamp < Number(params.endTime));
      const page = eligible.slice(-Number(params.limit ?? 200)).reverse();
      return {
        data: page.map((candle) => [
          String(candle.timestamp),
          String(candle.open),
          String(candle.high),
          String(candle.low),
          String(candle.close),
          String(candle.volume),
        ]),
      };
    },
  });
}

function paper() {
  return adaptCrossrefMetadata({
    status: "ok",
    "message-type": "work",
    "message-version": "1.0.0",
    message: {
      DOI: "10.1234/crypto.spot.public.formula.tournament",
      title: ["Crypto spot public formula tournament fixture"],
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
    retrievedFrom: "https://api.crossref.org/v1/works/10.1234/crypto.spot.public.formula.tournament",
  });
}

function hypothesisAndDecision() {
  const source = paper();
  const hypothesis = createStrategyHypothesisV1({
    title: "Crypto spot momentum and relative-volume public-data hypothesis",
    statement: "Positive short-horizon momentum with relative-volume confirmation may support bounded spot research.",
    marketScope: ["CRYPTO_SPOT"],
    assetClass: "CRYPTO_SPOT",
    timeframeScope: ["15m"],
    directionality: "POSITIVE",
    rationale: "Exact-timeframe public OHLCV is evaluated only through the canonical research path.",
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
      minimumObservations: 100,
      rejectionStatement: "Reject when measured conditional mean is non-positive.",
    },
    requiredData: [{
      dataset: "BITGET_PUBLIC_SPOT_OHLCV",
      fields: ["open", "high", "low", "close", "volume"],
      frequency: "15m",
      provenanceRequired: true,
      licenseRequired: true,
    }],
    knownLimitations: ["Historical bid-ask spread is unavailable in OHLCV and is not fabricated."],
    createdAt: "2026-08-26T11:00:00.000Z",
    generator: { name: "crypto-spot-public-formula-tournament-test", version: "1.0.0" },
    evidencePolicy: { requireKnownContentLicense: true, requireResolvedCorrections: true },
  }, [source]);
  const decision = createHypothesisDecisionV1({
    hypothesis,
    papers: [source],
    verdict: "APPROVE_FOR_RESEARCH",
    rationale: "Approved only for bounded public-data research validation.",
    decidedAt: "2026-08-26T11:10:00.000Z",
    committee: { name: "Research Committee", version: "1.0.0", members: ["reviewer-a", "reviewer-b"] },
  });
  return { hypothesis, decision };
}

const parameter = (name, domain, valueType, min, max, step) => ({ name, domain, valueType, min, max, step });
const indicator = (name, input, parameters = {}) => ({ kind: "INDICATOR", name, input, parameters });
const paramNode = (name) => ({ kind: "PARAMETER", name });
const operator = (name, operands) => ({ kind: "OPERATOR", operator: name, operands });

function producerFixture(hypothesis, decision) {
  const profile = {
    profileId: "CRYPTO_SPOT:SHORT",
    market: "CRYPTO_SPOT",
    horizon: "SHORT",
    timeframe: "15m",
    directions: ["LONG"],
    status: "READY",
    formulaFamilies: ["MOMENTUM_RVOL"],
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
  const hypothesisBinding = {
    hypothesisId: hypothesis.hypothesisId,
    hypothesisConfigHash: hypothesis.configHash,
    decisionId: decision.decisionId,
    decisionHash: decision.decisionHash,
  };
  const template = {
    templateId: "evidence-seed-crypto-spot-short-momentum-rvol-v1",
    hypothesisBinding,
    strategyFamily: "MOMENTUM_RVOL",
    market: "CRYPTO_SPOT",
    timeframe: "15m",
    direction: "LONG",
    entryDsl: {
      action: "LONG",
      rules: [
        operator("GT", [indicator("ROC", "close", { period: "rocPeriod" }), paramNode("rocMin")]),
        operator("GT", [indicator("RVOL", "volume", { period: "rvolPeriod" }), paramNode("rvolMin")]),
      ],
    },
    exitDsl: {
      rules: [
        { type: "ATR_STOP", atrIndicator: indicator("ATR", "ohlc", { period: "atrPeriod" }), multiplierParameter: "atrStop" },
        { type: "TARGET", distanceParameter: "targetDistance" },
        { type: "TIME_EXIT", barsParameter: "timeBars" },
      ],
    },
    parameterSpace: [
      parameter("atrPeriod", "PERIOD", "INTEGER", 2, 2, 1),
      parameter("atrStop", "POSITIVE_MULTIPLIER", "NUMBER", 1, 1, 0.5),
      parameter("rocPeriod", "PERIOD", "INTEGER", 2, 2, 1),
      parameter("rocMin", "NON_NEGATIVE_VALUE", "NUMBER", 0, 0, 0.01),
      parameter("rvolPeriod", "PERIOD", "INTEGER", 2, 2, 1),
      parameter("rvolMin", "NON_NEGATIVE_VALUE", "NUMBER", 1.2, 1.2, 0.1),
      parameter("targetDistance", "PRICE_FRACTION", "NUMBER", 0.01, 0.01, 0.005),
      parameter("timeBars", "BAR_COUNT", "INTEGER", 3, 3, 1),
    ],
    limits: { maxAstDepth: 6, maxIndicatorCount: 8, maxRuleCount: 8, maxAstNodes: 64 },
  };
  return {
    catalog: {
      schemaVersion: 1,
      contract: "evidence-backed-formula-seed-catalog/v1",
      profileCount: 1,
      readyProfileCount: 1,
      blockedProfileCount: 0,
      profiles: [profile],
      families: ["MOMENTUM_RVOL"],
      futuresEvidenceRequirements: [],
      safety,
    },
    seedResult: {
      status: "READY",
      profile,
      templates: [template],
      blockers: [],
      safety,
    },
  };
}

function generationBudget() {
  return {
    maxCandidatesPerHypothesis: 4,
    maxCandidatesPerRun: 4,
    maxGenerations: 1,
    maxParameterCombinations: 32,
    maxAstNodes: 64,
    maxRuntimeMs: 20_000,
    maxCpuMs: 20_000,
    maxMemoryBytes: 1024 * 1024,
  };
}

function adapterInput() {
  const { hypothesis, decision } = hypothesisAndDecision();
  const producer = producerFixture(hypothesis, decision);
  return {
    catalog: producer.catalog,
    seedResult: producer.seedResult,
    hypothesis,
    decision,
    compilerPolicy: {
      compilerId: "crypto-spot-public-formula-compiler",
      compilerVersion: "1.0.0",
      costPolicyIdentity: "BITGET_SPOT_CONSERVATIVE_COST_V1",
      riskPolicyIdentity: "RESEARCH_RISK_V1",
      datasetIdentity: PLACEHOLDER_DATASET,
      datasetRole: "TRAIN",
      budget: generationBudget(),
    },
    candidatesPerFormula: 1,
    tournament: {
      generationBudget: generationBudget(),
      search: {
        method: "BOUNDED_GRID",
        seed: 29,
        datasetIdentity: PLACEHOLDER_DATASET,
        finalHoldoutAccess: false,
      },
      budget: {
        maxCandidatesPerRun: 4,
        maxConcurrentBacktests: 2,
        maxTotalCandles: 100_000,
        maxRuntimeMs: 120_000,
        maxCpuPercent: 80,
        maxMemoryMb: 4096,
        maxWalkForwardWindows: 6,
        maxStressScenarios: 8,
      },
      policy: {
        minimumCandles: 100,
        minimumTrades: 1,
        minimumIndependentPeriods: 1,
        minimumRegimeSamples: { BULL: 0, BEAR: 0, SIDEWAYS: 0 },
        minimumWalkForwardWindows: 3,
        minimumPositiveWalkForwardRatio: 0,
        maximumFailureConcentration: 1,
        minimumNeighborhoodWidth: 2,
        multipleTestingBaseAlpha: 0.05,
        requiredCostScenarios: ["BASE_COST", "MODERATE_STRESS", "HIGH_STRESS"],
        requiredRegimes: ["BULL"],
      },
      resourceSnapshot: { cpuPercent: 10, memoryMb: 256, activeBacktests: 0 },
      observedAt: OBSERVED_AT,
    },
  };
}

test("prepared public dataset is exact-timeframe, gap-free, split by canonical Development/OOS, and excludes Final Holdout", () => {
  for (const [timeframe, timeframeMs] of [["15m", INTERVAL], ["1h", 60 * 60 * 1000], ["1d", 24 * 60 * 60 * 1000]]) {
    const rows = syntheticCandles({ timeframeMs, before: 130, after: 130 });
    const dataset = prepareCryptoSpotPublicFormulaTournamentDatasetV1({
      collected: collectedFixture({ timeframe, candles: rows }),
      requestedStartTime: rows[0].timestamp,
      requestedEndTime: rows.at(-1).timestamp + timeframeMs,
      minimumPartitionCandles: 120,
    });
    assert.equal(dataset.timeframe, timeframe);
    assert.equal(dataset.trainCandles.length, 130);
    assert.equal(dataset.oosCandles.length, 130);
    assert.ok(dataset.trainPeriod.endTime < dataset.oosPeriod.startTime);
    assert.ok(dataset.oosPeriod.endTime < RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime);
    assert.equal(dataset.finalHoldoutExcluded, true);
    assert.equal(dataset.openCandleExcluded, true);
    assert.equal(dataset.safety.executionAuthority, "NONE");
  }
});

test("gap, provider mismatch, and any 2026+ selection boundary fail closed", () => {
  const gapped = syntheticCandles({ before: 130, after: 130, gapIndex: 140 });
  expectCode(() => prepareCryptoSpotPublicFormulaTournamentDatasetV1({
    collected: collectedFixture({ candles: gapped }),
    requestedStartTime: gapped[0].timestamp,
    requestedEndTime: gapped.at(-1).timestamp + INTERVAL,
    minimumPartitionCandles: 120,
  }), "CRYPTO_SPOT_CANDLE_GAP_OR_DUPLICATE");

  const rows = syntheticCandles({ before: 130, after: 130 });
  expectCode(() => prepareCryptoSpotPublicFormulaTournamentDatasetV1({
    collected: collectedFixture({ candles: rows, provider: "unverified-provider" }),
    requestedStartTime: rows[0].timestamp,
    requestedEndTime: rows.at(-1).timestamp + INTERVAL,
    minimumPartitionCandles: 120,
  }), "CRYPTO_SPOT_PUBLIC_PROVIDER_CONTRACT_INVALID");

  expectCode(() => prepareCryptoSpotPublicFormulaTournamentDatasetV1({
    collected: collectedFixture({ candles: rows }),
    requestedStartTime: rows[0].timestamp,
    requestedEndTime: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime + INTERVAL,
    minimumPartitionCandles: 120,
  }), "CRYPTO_SPOT_FINAL_HOLDOUT_PREACCESS_FORBIDDEN");
});

test("Bitget public OHLCV runs through Historical/OOS/Purged/WF/Cost/Regime and stops at external #547 statistical owner", async () => {
  const rows = syntheticCandles();
  const result = await runCryptoSpotPublicFormulaTournamentV1({
    client: fakeBitgetClient(rows),
    symbol: "BTCUSDT",
    startTime: rows[0].timestamp,
    endTime: rows.at(-1).timestamp + INTERVAL,
    maxCandles: 5_000,
    minimumPartitionCandles: 120,
    adapterInput: adapterInput(),
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.dataset.provider, "bitget-public-v2");
  assert.equal(result.dataset.timeframe, "15m");
  assert.equal(result.dataset.finalHoldoutExcluded, true);
  assert.equal(result.dataset.openCandleExcluded, true);
  assert.equal(result.finalHoldoutEvaluated, false);
  assert.equal(result.nextCanonicalOwnerRequired, "#547");
  assert.equal(result.profitabilityClaimAllowed, false);
  assert.equal(result.tradingAuthority, false);
  assert.equal(result.safety.executionAuthority, "NONE");

  const candidates = result.result.tournament.candidates;
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  const byStage = new Map(candidate.stageRecords.map((record) => [record.stage, record]));
  for (const stage of ["FORMULA_CANDIDATE", "SANITY_CHECK", "HISTORICAL_BACKTEST", "OOS", "PURGED_OOS", "WALK_FORWARD", "COST_STRESS", "REGIME_STRESS"]) {
    const stageRecord = byStage.get(stage);
    assert.equal(stageRecord?.status, "PASS", `${stage}: ${JSON.stringify({ stageRecord, candidateFailure: candidate.failure })}`);
  }
  assert.equal(candidate.failure.failedStage, "STATISTICAL_FIREWALL");
  assert.equal(candidate.failure.failureCode, "STATISTICAL_EVIDENCE_MISSING");
  assert.equal(candidate.researchSurvivor, false);
  assert.equal(candidate.profitable, false);
  assert.equal(candidate.tradingAuthority, false);
  assert.equal(result.reachedStatisticalFirewall, 1);

  const costEvidence = byStage.get("COST_STRESS").evidence;
  assert.deepEqual(costEvidence.scenarios.map((scenario) => scenario.name), ["BASE_COST", "MODERATE_STRESS", "HIGH_STRESS"]);
  assert.ok(costEvidence.scenarios.every((scenario) => scenario.netEdge > 0));
  assert.ok(costEvidence.scenarios.every((scenario) => scenario.costs.funding.value === 0));

  const regime = byStage.get("REGIME_STRESS").evidence.regimes.BULL;
  assert.equal(regime.availability, "AVAILABLE");
  assert.ok(regime.sampleCount > 0);
  assert.equal(regime.passed, true);
});
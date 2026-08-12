import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIntegratedResearchArtifact,
  IntegratedResearchContractError,
  normalizeStrategyIdentity,
  summarizeIntegratedResearchArtifacts,
} from "../src/integrated-research-comparison.js";

const PARAMETER_HASH = "a".repeat(64);
const RESEARCH_SHA = "b".repeat(40);

function identity(overrides = {}) {
  return {
    strategyFamily: "V6_INDEPENDENT_BREAKOUT_SCALPING",
    strategyVersion: "v6.1.0",
    parameterHash: PARAMETER_HASH,
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "15m",
    side: "long",
    researchCodeSha: RESEARCH_SHA,
    ...overrides,
  };
}

function metrics(overrides = {}) {
  return {
    status: "available",
    initialCapital: 1_000_000,
    finalCapital: 1_200_000,
    totalReturnPercent: 20,
    netProfit: 200_000,
    winRatePercent: 61,
    lossRatePercent: 39,
    profitFactor: 1.72,
    expectancy: 12_500,
    maxDrawdownPercent: -8,
    averageWin: 35_000,
    averageLoss: -22_000,
    riskReward: 1.59,
    tradeCount: 100,
    averageHoldingDurationMs: 2 * 60 * 60 * 1000,
    consecutiveWins: 5,
    consecutiveLosses: 3,
    feeCost: 25_000,
    slippageCost: 12_000,
    spreadCost: 8_000,
    fundingCost: 4_000,
    exposure: 650_000,
    capitalUtilizationPercent: 65,
    ...overrides,
  };
}

function stage(metricOverrides = {}, extra = {}) {
  return {
    identity: identity(),
    metrics: metrics(metricOverrides),
    validationPassed: true,
    datasetDigest: "c".repeat(64),
    ...extra,
  };
}

function artifactInput(overrides = {}) {
  return {
    identity: identity(),
    backtest: stage(),
    oos: stage({ winRatePercent: 58, profitFactor: 1.6 }),
    walkForward: stage({ winRatePercent: 56, profitFactor: 1.5 }),
    holdout: stage({ winRatePercent: 55, profitFactor: 1.45 }),
    paper: stage({
      finalCapital: 1_120_000,
      totalReturnPercent: 12,
      netProfit: 120_000,
      winRatePercent: 54,
      lossRatePercent: 46,
      profitFactor: 1.34,
      expectancy: 7_000,
      maxDrawdownPercent: -11,
      tradeCount: 80,
      feeCost: 28_000,
      slippageCost: 18_000,
      spreadCost: 11_000,
      fundingCost: 5_000,
    }),
    shadow: stage({
      finalCapital: 1_105_000,
      totalReturnPercent: 10.5,
      netProfit: 105_000,
      winRatePercent: 52,
      lossRatePercent: 48,
      profitFactor: 1.28,
      expectancy: 6_000,
      maxDrawdownPercent: -12,
      tradeCount: 76,
    }),
    validation: {
      oosValidated: true,
      walkForwardValidated: true,
      finalHoldoutValidated: true,
      paperValidated: true,
      shadowValidated: true,
    },
    provenance: { researchCodeSha: RESEARCH_SHA, generatedAt: "2026-08-12T08:00:00.000Z" },
    safety: {
      simulatedOnly: true,
      liveOrderAllowed: false,
      privateAccountRequestAllowed: false,
      orderSubmitted: false,
    },
    ...overrides,
  };
}

test("strategy identity is immutable and cash markets cannot create short identities", () => {
  assert.equal(normalizeStrategyIdentity(identity()).market, "CRYPTO_FUTURES");
  assert.throws(
    () => normalizeStrategyIdentity(identity({ market: "KR_STOCK", symbol: "005930", side: "short" })),
    (error) => error instanceof IntegratedResearchContractError && error.code === "CASH_SHORT_NOT_ALLOWED",
  );
});

test("backtest-to-paper gaps use percentage points and direct metric deltas", () => {
  const artifact = buildIntegratedResearchArtifact(artifactInput());
  assert.equal(artifact.gaps.backtestVsPaper.winRatePercentagePoints, -7);
  assert.ok(Math.abs(artifact.gaps.backtestVsPaper.profitFactorDelta - (-0.38)) < 1e-12);
  assert.equal(artifact.gaps.backtestVsPaper.totalReturnPercentagePoints, -8);
  assert.equal(artifact.gaps.backtestVsPaper.maxDrawdownPercentagePoints, -3);
  assert.equal(artifact.gaps.paperVsShadow.winRatePercentagePoints, -2);
});

test("zero-trade samples cannot fabricate win rate, PF or expectancy", () => {
  const bad = artifactInput({
    paper: stage({ tradeCount: 0, winRatePercent: 0, lossRatePercent: null, profitFactor: null, expectancy: null }),
  });
  assert.throws(
    () => buildIntegratedResearchArtifact(bad),
    (error) => error instanceof IntegratedResearchContractError && error.code === "EMPTY_SAMPLE_METRIC_FORBIDDEN",
  );

  const safe = buildIntegratedResearchArtifact(artifactInput({
    paper: stage({ tradeCount: 0, winRatePercent: null, lossRatePercent: null, profitFactor: null, expectancy: null }),
    validation: { oosValidated: true, walkForwardValidated: true, finalHoldoutValidated: true, paperValidated: false, shadowValidated: false },
  }));
  assert.equal(safe.gaps.backtestVsPaper.winRatePercentagePoints, null);
});

test("stage identity mismatch fails closed instead of mixing research results", () => {
  const input = artifactInput();
  input.paper = {
    ...input.paper,
    identity: identity({ parameterHash: "d".repeat(64) }),
  };
  assert.throws(
    () => buildIntegratedResearchArtifact(input),
    (error) => error instanceof IntegratedResearchContractError && error.code === "STRATEGY_IDENTITY_MISMATCH",
  );
});

test("research code SHA mismatch fails closed", () => {
  assert.throws(
    () => buildIntegratedResearchArtifact(artifactInput({ provenance: { researchCodeSha: "e".repeat(40) } })),
    (error) => error instanceof IntegratedResearchContractError && error.code === "RESEARCH_CODE_SHA_MISMATCH",
  );
});

test("paper validated status requires explicit OOS, WF, holdout, paper and shadow validation", () => {
  const validated = buildIntegratedResearchArtifact(artifactInput());
  assert.equal(validated.status, "PAPER_VALIDATED");
  assert.equal(validated.promotion.livePromotionAllowed, false);

  const missingShadow = buildIntegratedResearchArtifact(artifactInput({
    validation: { oosValidated: true, walkForwardValidated: true, finalHoldoutValidated: true, paperValidated: true, shadowValidated: false },
  }));
  assert.equal(missingShadow.status, "WF_VALIDATED");
});

test("research safety cannot be widened to live trading", () => {
  for (const unsafe of [
    { simulatedOnly: false },
    { liveOrderAllowed: true },
    { privateAccountRequestAllowed: true },
    { orderSubmitted: true },
  ]) {
    assert.throws(
      () => buildIntegratedResearchArtifact(artifactInput({ safety: unsafe })),
      (error) => error instanceof IntegratedResearchContractError && error.code === "UNSAFE_RESEARCH_CONTRACT",
    );
  }
});

test("blocked data remains explicit and does not invent metrics", () => {
  const blocked = buildIntegratedResearchArtifact(artifactInput({
    backtest: {
      identity: identity(),
      metrics: { status: "blocked_data", tradeCount: 0 },
      validationPassed: false,
      validationReason: "BLOCKED_PROVIDER",
    },
    validation: {},
  }));
  assert.equal(blocked.status, "RESEARCHING");
  assert.equal(blocked.stages.backtest.metrics.status, "blocked_data");
  assert.equal(blocked.stages.backtest.metrics.totalReturnPercent, null);
  assert.equal(blocked.gaps.backtestVsPaper.winRatePercentagePoints, null);
});

test("regime gaps compare only matching regimes", () => {
  const input = artifactInput();
  input.backtest = stage({
    regimes: {
      BULL: { status: "available", tradeCount: 20, winRatePercent: 65, lossRatePercent: 35, profitFactor: 1.9 },
      BEAR: { status: "available", tradeCount: 15, winRatePercent: 45, lossRatePercent: 55, profitFactor: 1.1 },
    },
  });
  input.paper = stage({
    regimes: {
      BULL: { status: "available", tradeCount: 10, winRatePercent: 60, lossRatePercent: 40, profitFactor: 1.5 },
      SIDEWAYS: { status: "available", tradeCount: 8, winRatePercent: 40, lossRatePercent: 60, profitFactor: 0.9 },
    },
  });
  const artifact = buildIntegratedResearchArtifact(input);
  assert.deepEqual(Object.keys(artifact.gaps.byRegime.backtestVsPaper), ["BULL"]);
  assert.equal(artifact.gaps.byRegime.backtestVsPaper.BULL.winRatePercentagePoints, -5);
});

test("summary never grants live authority and counts validated research only", () => {
  const validated = buildIntegratedResearchArtifact(artifactInput());
  const researching = buildIntegratedResearchArtifact(artifactInput({ validation: {} }));
  const summary = summarizeIntegratedResearchArtifacts([validated, researching]);
  assert.equal(summary.strategies, 2);
  assert.equal(summary.paperValidated, 1);
  assert.equal(summary.livePromotionAllowed, false);
  assert.equal(summary.actualOrderCount, 0);
  assert.equal(summary.privateTradingApiCalls, 0);
});

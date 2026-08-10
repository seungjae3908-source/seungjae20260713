import test from "node:test";
import assert from "node:assert/strict";
import {
  STATISTICAL_QUALITY_POLICY,
  buildProtectedFinalHoldoutQueue,
  buildStatisticalQuality,
  markCrossSymbolPreliminary,
} from "../src/statistical-quality-contract.js";

function candidate(overrides = {}) {
  return {
    id: "v1:test",
    parameters: { fastPeriod: 10, slowPeriod: 50 },
    developmentMetrics: { tradeCount: 34 },
    oosMetrics: { tradeCount: 4 },
    walkForward: {
      windows: [{ tradeCount: 2 }, { tradeCount: 3 }],
      stability: { stabilityScore: 60 },
    },
    overfitDiagnostics: {
      topTwoWinnerShare: 0.8,
      profitableRegimeRatio: 0.5,
    },
    overfitPenaltyPoints: 4,
    researchStatus: "threshold_calibration_required",
    qualityScore: 70,
    ...overrides,
  };
}

test("OOS below ten stays low sample and ten is not treated as a strategy pass", () => {
  const low = buildStatisticalQuality(candidate());
  assert.equal(low.developmentTradeCount, 34);
  assert.equal(low.oosTradeCount, 4);
  assert.equal(low.wfTradeCount, 5);
  assert.equal(low.totalIndependentTrades, 4);
  assert.equal(low.sampleQuality, "low");
  assert.ok(low.lowSamplePenalty > 0);
  assert.equal(low.statisticalPass, false);

  const ten = buildStatisticalQuality(candidate({ oosMetrics: { tradeCount: 10 } }));
  assert.equal(ten.sampleQuality, "uncalibrated_not_a_pass");
  assert.equal(ten.lowSamplePenalty, 0);
  assert.equal(ten.statisticalPass, false);
  assert.equal(STATISTICAL_QUALITY_POLICY.empiricalPassThresholdCalibrated, false);
});

test("statistical quality exposes concentration and regime dependency without inventing thresholds", () => {
  const quality = buildStatisticalQuality(candidate());
  assert.equal(quality.concentrationPenalty, 4);
  assert.equal(quality.topTradeDependency, 0.8);
  assert.equal(quality.regimeDependency, 0.5);
  assert.equal(quality.symbolDependency, null);
});

test("BTC ETH cross-symbol evaluation is explicitly preliminary and dependency forces research hold", () => {
  const groups = markCrossSymbolPreliminary({
    CRYPTO_FUTURES_SWING_LONG: {
      requiredSymbols: ["BTCUSDT", "ETHUSDT"],
      presentSymbols: ["BTCUSDT", "ETHUSDT"],
      candidateCount: 1,
      candidates: [{
        ...candidate({ researchStatus: "eligible_for_final_holdout" }),
        diagnostics: { positiveSymbolRatio: 0.5 },
        symbolDependencyPenaltyPoints: 5,
      }],
    },
  });
  const group = groups.CRYPTO_FUTURES_SWING_LONG;
  assert.equal(group.crossSymbolValidation, "preliminary");
  assert.equal(group.crossSymbolScope, "btc_eth_only_not_full_market_stability");
  assert.equal(group.finalHoldoutEligibilityFromCrossSymbolStage, false);
  assert.equal(group.candidates[0].researchStatus, "research_hold");
  assert.equal(group.candidates[0].symbolDependency.value, 0.5);
});

test("preliminary cross-symbol stage can never enter one-shot final holdout queue", () => {
  const groups = markCrossSymbolPreliminary({
    CRYPTO_SPOT_SWING: {
      requiredSymbols: ["USDT-BTC", "USDT-ETH"],
      presentSymbols: ["USDT-BTC", "USDT-ETH"],
      candidates: [{
        ...candidate({ researchStatus: "eligible_for_final_holdout", statisticalPass: true }),
        statisticalPass: true,
        diagnostics: { positiveSymbolRatio: 1 },
        symbolDependencyPenaltyPoints: 0,
      }],
    },
  });
  const queue = buildProtectedFinalHoldoutQueue(groups);
  assert.deepEqual(queue.CRYPTO_SPOT_SWING, []);
});

test("even a validated cross-symbol stage requires explicit statistical pass before queue admission", () => {
  const base = {
    crossSymbolValidation: "validated",
    candidates: [{ ...candidate({ researchStatus: "eligible_for_final_holdout" }), statisticalPass: false }],
  };
  assert.deepEqual(buildProtectedFinalHoldoutQueue({ G: base }).G, []);

  const admitted = buildProtectedFinalHoldoutQueue({
    G: { ...base, candidates: [{ ...candidate({ researchStatus: "eligible_for_final_holdout" }), statisticalPass: true }] },
  }).G;
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].parameterRetuningAllowedAfterHoldout, false);
  assert.equal(admitted[0].candidateFamilyReentryAfterHoldoutAllowed, false);
});

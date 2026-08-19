import test from "node:test";
import assert from "node:assert/strict";
import { evaluateUnifiedProfitabilityPromotion } from "../src/unified-profitability-promotion-gate-v1.js";

const fingerprint = "strategy-fingerprint-fixture";

const policy = Object.freeze({
  status: "empirically_calibrated",
  minTrials: 3,
  maxPbo: 0.25,
  minDsrProbability: 0.95,
  minOosTrades: 40,
  minWalkForwardWindows: 4,
  minShadowSettled: 300,
  minShadowElapsedMs: 28 * 24 * 60 * 60 * 1000,
  minPaperSettled: 200,
  minPaperProfitFactor: 1.2,
  minPaperExpectancyCiLower: 0,
  maxPaperMdd: 0.15,
});

function completeEvidence() {
  return {
    backtest: {
      strategyFingerprint: fingerprint,
      lineageValid: true,
      finalHoldoutRetuned: false,
      finalHoldoutStatus: "PASS",
      oos: { tradeCount: 80, expectancy: 0.012 },
      walkForward: { windows: 8, stabilityPass: true },
      costStress: { passed: true },
      regime: { passed: true },
      crossSymbol: { passed: true },
    },
    selectionBias: {
      strategyFingerprint: fingerprint,
      registryComplete: true,
      trialCount: 30,
      pbo: 0.12,
      dsrProbability: 0.985,
      forwardEvidenceUsedForSelection: false,
    },
    shadow: {
      strategyFingerprint: fingerprint,
      lineageValid: true,
      frozenIdentity: true,
      naturalScheduleObserved: true,
      forwardRetuned: false,
      settled: 420,
      elapsedMs: 35 * 24 * 60 * 60 * 1000,
      neutralCollapse: false,
      directionalQualityPass: true,
    },
    paper: {
      strategyFingerprint: fingerprint,
      lineageValid: true,
      scheduleActive: true,
      naturalCronObserved: true,
      settlementLinked: true,
      settledTrades: 260,
      profitFactor: 1.35,
      expectancyCiLower: 0.001,
      maximumDrawdown: 0.09,
      actualOrders: 0,
      privateAccountRequests: 0,
    },
  };
}

test("all scientific stages can reach promotion review but never live authority", () => {
  const evidence = completeEvidence();
  const result = evaluateUnifiedProfitabilityPromotion({ strategyFingerprint: fingerprint, policy, ...evidence });
  assert.equal(result.promotionEligible, true, JSON.stringify(result.reasons));
  assert.equal(result.status, "PROMOTION_REVIEW_READY");
  assert.deepEqual(result.stages, {
    policy: true,
    backtest: true,
    selectionBias: true,
    shadow: true,
    paper: true,
  });
  assert.equal(result.safety.liveTradingAllowed, false);
  assert.equal(result.safety.privateTradingApiAllowed, false);
  assert.equal(result.safety.orderAuthority, false);
});

test("strategy identity mismatch fails closed", () => {
  const evidence = completeEvidence();
  evidence.shadow = { ...evidence.shadow, strategyFingerprint: "different" };
  const result = evaluateUnifiedProfitabilityPromotion({ strategyFingerprint: fingerprint, policy, ...evidence });
  assert.equal(result.promotionEligible, false);
  assert.ok(result.reasons.includes("shadow:strategy_identity_mismatch"));
});

test("uncalibrated policy never grants promotion", () => {
  const evidence = completeEvidence();
  const result = evaluateUnifiedProfitabilityPromotion({
    strategyFingerprint: fingerprint,
    policy: { ...policy, status: "calibration_required" },
    ...evidence,
  });
  assert.equal(result.promotionEligible, false);
  assert.ok(result.reasons.includes("policy:not_empirically_calibrated"));
});

test("insufficient natural Shadow/Paper evidence remains RESEARCH_HOLD", () => {
  const evidence = completeEvidence();
  evidence.shadow = {
    ...evidence.shadow,
    settled: 2,
    elapsedMs: 0,
    neutralCollapse: true,
    directionalQualityPass: false,
  };
  evidence.paper = {
    ...evidence.paper,
    scheduleActive: false,
    naturalCronObserved: false,
    settlementLinked: false,
    settledTrades: 0,
    profitFactor: null,
    expectancyCiLower: null,
    maximumDrawdown: null,
  };
  const result = evaluateUnifiedProfitabilityPromotion({ strategyFingerprint: fingerprint, policy, ...evidence });
  assert.equal(result.promotionEligible, false);
  assert.equal(result.status, "RESEARCH_HOLD");
  assert.ok(result.reasons.includes("shadow:neutral_collapse_not_cleared"));
  assert.ok(result.reasons.includes("paper:natural_cron_unproven"));
});

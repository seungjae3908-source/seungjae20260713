import test from "node:test";
import assert from "node:assert/strict";
import {
  buildScalpingCrossSymbolDiagnostics,
  classifyScalpingSample,
} from "../src/scalping-v1-research.js";

test("OOS below 10 trades is explicitly low sample and 10 is not automatic pass", () => {
  const low = classifyScalpingSample({
    developmentMetrics: { tradeCount: 40 },
    oosMetrics: { tradeCount: 6 },
    walkForward: { windows: [{ tradeCount: 3 }, { tradeCount: 4 }] },
  });
  assert.equal(low.oosTradeCount, 6);
  assert.equal(low.totalIndependentTrades, 13);
  assert.equal(low.sampleQuality, "critical_low_oos_sample");
  assert.equal(low.lowSamplePenalty, 0.4);
  assert.equal(low.tenTradesIsAutomaticPass, false);

  const ten = classifyScalpingSample({
    developmentMetrics: { tradeCount: 40 },
    oosMetrics: { tradeCount: 10 },
    walkForward: { windows: [] },
  });
  assert.equal(ten.sampleQuality, "uncalibrated_sample_quality");
  assert.equal(ten.tenTradesIsAutomaticPass, false);
});

test("cross-symbol validation remains preliminary and cannot queue holdout", () => {
  const mk = (symbol, qualityScore, totalReturn, oosTradeCount, researchStatus = "threshold_calibration_required") => ({
    market: "CRYPTO_SPOT",
    symbol,
    side: "long",
    candidates: [{
      id: "v1:same",
      qualityScore,
      oosTradeCount,
      researchStatus,
      oosMetrics: { totalReturn },
    }],
  });
  const [group] = buildScalpingCrossSymbolDiagnostics([
    mk("USDT-BTC", 70, 0.1, 20),
    mk("USDT-ETH", 60, 0.02, 15),
  ]);
  assert.equal(group.crossSymbolValidation, "preliminary");
  assert.equal(group.fullMarketStabilityValidated, false);
  assert.equal(group.candidateFreezeAllowed, false);
  assert.equal(group.finalHoldoutQueueAllowed, false);
  assert.equal(group.topStrategy, null);
  assert.equal(group.candidates[0].candidateId, "v1:same");
  assert.ok(group.candidates[0].symbolDependency > 0.8);
});

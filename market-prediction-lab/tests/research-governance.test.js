import test from "node:test";
import assert from "node:assert/strict";
import {
  alignResearchSeries,
  calculateSignalExcursion,
  calculateTradeResult,
  comparePaperToBacktest,
  createPurgedWalkForwardFolds,
  createResearchArtifact,
  evaluatePredictionQuality,
  evaluateResearchPromotion,
  normalizeResearchSymbol,
  summarizeTradePerformance,
  validateResearchAction,
  verifyResearchArtifact,
} from "../src/research-governance.js";

const DAY = 24 * 60 * 60 * 1000;

test("market contracts separate long-only cash from two-sided futures", () => {
  assert.equal(validateResearchAction({ market: "KR_STOCK", action: "BUY" }).positionMode, "long_only");
  assert.equal(validateResearchAction({ market: "CRYPTO_FUTURES", action: "SHORT", leverage: 3 }).positionMode, "two_sided");
  assert.throws(() => validateResearchAction({ market: "KR_STOCK", action: "SHORT" }), /not allowed/);
  assert.throws(() => validateResearchAction({ market: "CRYPTO_SPOT", action: "SELL" }), /existing position/);
  assert.throws(() => validateResearchAction({ market: "US_STOCK", action: "BUY", leverage: 2 }), /leverage/);
  assert.throws(() => validateResearchAction({ market: "KR_STOCK", action: "BUY", fundingRate: 0.001 }), /funding/);
});

test("symbols normalize by market without crossing contracts", () => {
  assert.equal(normalizeResearchSymbol("KR_STOCK", "005930"), "005930");
  assert.equal(normalizeResearchSymbol("US_STOCK", "brk.b"), "BRK.B");
  assert.equal(normalizeResearchSymbol("CRYPTO_SPOT", "krw/btc"), "KRW-BTC");
  assert.equal(normalizeResearchSymbol("CRYPTO_FUTURES", "btc-usdt"), "BTCUSDT");
  assert.throws(() => normalizeResearchSymbol("KR_STOCK", "AAPL"), /six digits/);
});

test("exact timestamp alignment blocks missing, duplicate, future and retroactive features", () => {
  const asOf = 3_000;
  const candles = [{ timestamp: 1_000, close: 1 }, { timestamp: 2_000, close: 2 }];
  const aligned = alignResearchSeries({
    candles,
    features: { funding: [{ timestamp: 1_000, observedAt: 1_000, value: 0 }, { timestamp: 2_000, observedAt: 2_000, value: 0.001 }] },
    asOf,
  });
  assert.equal(aligned.rows.length, 2);
  assert.equal(aligned.quality.exactTimestampJoin, true);
  assert.throws(() => alignResearchSeries({ candles, features: { oi: [{ timestamp: 1_000, observedAt: 2_000, value: 10 }, { timestamp: 2_000, observedAt: 2_000, value: 11 }] }, asOf }), /observed after/);
  assert.throws(() => alignResearchSeries({ candles, features: { oi: [{ timestamp: 1_000 }, { timestamp: 1_000 }] }, asOf }), /duplicate/);
  assert.throws(() => alignResearchSeries({ candles, features: { oi: [{ timestamp: 1_000 }, { timestamp: 4_000 }] }, asOf: 3_000 }), /later than asOf/);
  assert.throws(() => alignResearchSeries({ candles, features: { oi: [{ timestamp: 1_000 }] }, asOf }), /missing/);
});

test("purged walk-forward folds remove overlapping future labels and are deterministic", () => {
  const records = Array.from({ length: 80 }, (_, index) => ({
    id: index,
    anchorTimestamp: index * 10,
    futureEndTimestamp: index * 10 + 15,
  }));
  const options = { trainSize: 20, validationSize: 8, testSize: 8, stepSize: 8, embargoMs: 5 };
  const first = createPurgedWalkForwardFolds(records, options);
  const second = createPurgedWalkForwardFolds([...records].reverse(), options);
  assert.deepEqual(first, second);
  assert.ok(first.length > 1);
  for (const fold of first) {
    assert.ok(fold.validation[0].anchorTimestamp > fold.report.maxTrainFuture);
    assert.ok(fold.test[0].anchorTimestamp > fold.report.maxValidationFuture);
  }
});

test("trade results include adverse slippage, fees, taxes and funding", () => {
  const stock = calculateTradeResult({
    market: "KR_STOCK", action: "BUY", entryPrice: 100, exitPrice: 110, quantity: 10,
    entryFeeRate: 0.001, exitFeeRate: 0.001, slippageRate: 0.002, taxRate: 0.002,
  });
  assert.equal(stock.costsIncluded, true);
  assert.ok(stock.netPnl < stock.rawGrossPnl);
  assert.ok(stock.costs.tax > 0);
  const long = calculateTradeResult({
    market: "CRYPTO_FUTURES", action: "LONG", leverage: 3, entryPrice: 100, exitPrice: 110, quantity: 10,
    entryFeeRate: 0.001, exitFeeRate: 0.001, slippageRate: 0.001, fundingRates: [0.001, -0.0002],
  });
  const short = calculateTradeResult({
    market: "CRYPTO_FUTURES", action: "SHORT", leverage: 3, entryPrice: 100, exitPrice: 90, quantity: 10,
    entryFeeRate: 0.001, exitFeeRate: 0.001, slippageRate: 0.001, fundingRates: [0.001],
  });
  assert.ok(long.costs.funding > 0);
  assert.ok(short.costs.funding < 0);
  assert.throws(() => calculateTradeResult({ market: "CRYPTO_SPOT", action: "BUY", entryPrice: 1, exitPrice: 2, quantity: 1, fundingRates: [0.001] }), /funding/);
});

test("signal excursions report maximum favorable and adverse movement", () => {
  const long = calculateSignalExcursion({ action: "BUY", entryPrice: 100, candles: [{ high: 110, low: 95 }, { high: 108, low: 90 }] });
  assert.ok(Math.abs(long.maximumFavorableExcursion - 0.1) < 1e-12);
  assert.ok(Math.abs(long.maximumAdverseExcursion + 0.1) < 1e-12);
  const short = calculateSignalExcursion({ action: "SHORT", entryPrice: 100, candles: [{ high: 105, low: 80 }] });
  assert.equal(short.maximumFavorableExcursion, 0.25);
  assert.ok(short.maximumAdverseExcursion < 0);
});

test("trade performance reports expectancy, drawdown, win rate and payoff ratio", () => {
  const trades = [
    { netPnl: 10, costsIncluded: true, costs: { total: 1 } },
    { netPnl: -5, costsIncluded: true, costs: { total: 1 } },
    { netPnl: 20, costsIncluded: true, costs: { total: 2 } },
    { netPnl: -10, costsIncluded: true, costs: { total: 2 } },
  ];
  const summary = summarizeTradePerformance(trades);
  assert.equal(summary.sampleCount, 4);
  assert.equal(summary.winRate, 0.5);
  assert.equal(summary.expectancy, 3.75);
  assert.equal(summary.maximumDrawdown, 10);
  assert.equal(summary.payoffRatio, 2);
  assert.equal(summary.totalCosts, 6);
});

test("prediction quality includes Brier, Macro F1 and calibration", () => {
  const quality = evaluatePredictionQuality([
    { actual: "bullish", probabilities: { bullish: 0.8, neutral: 0.1, bearish: 0.1 } },
    { actual: "neutral", probabilities: { bullish: 0.2, neutral: 0.7, bearish: 0.1 } },
    { actual: "bearish", probabilities: { bullish: 0.1, neutral: 0.1, bearish: 0.8 } },
  ], { bins: 5 });
  assert.equal(quality.macroF1, 1);
  assert.ok(quality.brier < 0.1);
  assert.ok(quality.expectedCalibrationError > 0);
  assert.equal(quality.calibrationBins.length, 5);
});

test("paper comparison exposes live degradation instead of hiding it", () => {
  const comparison = comparePaperToBacktest({
    backtest: { sampleCount: 300, winRate: 0.6, expectancy: 4, maximumDrawdown: 20, totalCosts: 100 },
    paper: { sampleCount: 80, winRate: 0.52, expectancy: 1.5, maximumDrawdown: 35, totalCosts: 180 },
  });
  assert.ok(Math.abs(comparison.winRateDelta + 0.08) < 1e-12);
  assert.equal(comparison.expectancyDelta, -2.5);
  assert.equal(comparison.maximumDrawdownDelta, 15);
});

test("promotion never enables operations and bad models are automatically held", () => {
  const base = {
    sampleCount: 400,
    perSymbolSamples: { BTCUSDT: 200, ETHUSDT: 200 },
    observationMs: 35 * DAY,
    qualifiedRegimes: 3,
    costsIncluded: true,
    walkForwardValidated: true,
    reproducible: true,
    integrityVerified: true,
    baseline: { brier: 0.22, macroF1: 0.5 },
    candidate: { brier: 0.2, macroF1: 0.55, expectedCalibrationError: 0.05, maximumDrawdown: 12 },
    paperComparison: { expectancyDelta: -0.2 },
  };
  const approved = evaluateResearchPromotion(base, { maxDrawdown: 20, maxPaperExpectancyGap: 1 });
  assert.equal(approved.status, "integration_review_ready");
  assert.equal(approved.automaticOperationsAllowed, false);
  assert.equal(approved.mainMergeAllowed, false);
  const held = evaluateResearchPromotion({ ...base, candidate: { ...base.candidate, brier: 0.3, maximumDrawdown: 30 } }, { maxDrawdown: 20, maxPaperExpectancyGap: 1 });
  assert.equal(held.status, "research_hold");
  assert.ok(held.reasons.includes("brier_regressed"));
  assert.ok(held.reasons.includes("maximum_drawdown_exceeded"));
});

test("research artifacts are reproducible and tamper evident", () => {
  const payload = { evaluatedAt: 1_700_000_000_000, modelVersion: "v1", result: { expectancy: 1.2, samples: 400 } };
  const first = createResearchArtifact(payload);
  const second = createResearchArtifact({ result: { samples: 400, expectancy: 1.2 }, modelVersion: "v1", evaluatedAt: 1_700_000_000_000 });
  assert.equal(first.integrityHash, second.integrityHash);
  assert.equal(verifyResearchArtifact(first), true);
  assert.equal(verifyResearchArtifact({ ...first, payload: { ...first.payload, result: { expectancy: 99 } } }), false);
});

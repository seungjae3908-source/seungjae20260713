import test from "node:test";
import assert from "node:assert/strict";
import {
  calculatePearsonCorrelation,
  evaluatePortfolioAdditionalBuyWithCorrelation,
} from "../src/portfolio-risk-analysis.js";

function baseInput(overrides = {}) {
  return {
    portfolio: { equity: 10_000, totalExposure: 2_000, symbolExposure: 800, ...(overrides.portfolio ?? {}) },
    currentPosition: { quantity: 10, averagePrice: 100, currentPrice: 110, ...(overrides.currentPosition ?? {}) },
    proposal: { amount: 500, price: 108, stop: 100, target1: 120, target2: 130, ...(overrides.proposal ?? {}) },
    risk: {
      correlation: 0,
      maxCorrelation: 0.8,
      maxPortfolioExposure: 5_000,
      maxSymbolExposure: 2_000,
      thesisValid: true,
      dataStale: false,
      partialMarketData: false,
      liquidityOk: true,
      invalidationTriggered: false,
      ...(overrides.risk ?? {}),
    },
    correlationSeries: overrides.correlationSeries ?? {
      assetReturns: [0.01, 0.02, -0.01, 0.03, -0.02, 0.04],
      portfolioReturns: [0.009, 0.018, -0.012, 0.028, -0.018, 0.037],
    },
  };
}

test("Pearson correlation is calculated from aligned return series", () => {
  const positive = calculatePearsonCorrelation(
    [1, 2, 3, 4, 5],
    [2, 4, 6, 8, 10],
  );
  assert.equal(positive.insufficientData, false);
  assert.ok(Math.abs(positive.correlation - 1) < 1e-12);

  const negative = calculatePearsonCorrelation(
    [1, 2, 3, 4, 5],
    [10, 8, 6, 4, 2],
  );
  assert.ok(Math.abs(negative.correlation + 1) < 1e-12);
});

test("portfolio decision uses calculated correlation instead of caller-supplied correlation", () => {
  const result = evaluatePortfolioAdditionalBuyWithCorrelation(baseInput({
    risk: { correlation: 0, maxCorrelation: 0.8 },
    correlationSeries: {
      assetReturns: [1, 2, 3, 4, 5, 6],
      portfolioReturns: [2, 4, 6, 8, 10, 12],
    },
  }));
  assert.equal(result.classification, "conditional_additional_buy");
  assert.ok(result.conditionalReasons.includes("correlation_requires_review"));
  assert.ok(Math.abs(result.correlation - 1) < 1e-12);
  assert.equal(result.correlationAnalysis.insufficientData, false);
});

test("insufficient or zero-variance correlation data is treated as partial market data", () => {
  const tooShort = evaluatePortfolioAdditionalBuyWithCorrelation(baseInput({
    correlationSeries: { assetReturns: [0.01, 0.02], portfolioReturns: [0.01, 0.02] },
  }));
  assert.equal(tooShort.classification, "additional_buy_prohibited");
  assert.ok(tooShort.reasons.includes("partial_market_data"));
  assert.equal(tooShort.correlation, null);
  assert.equal(tooShort.correlationAnalysis.insufficientData, true);

  const zeroVariance = evaluatePortfolioAdditionalBuyWithCorrelation(baseInput({
    correlationSeries: {
      assetReturns: [0.01, 0.01, 0.01, 0.01, 0.01],
      portfolioReturns: [0.01, 0.02, 0.03, 0.04, 0.05],
    },
  }));
  assert.equal(zeroVariance.classification, "additional_buy_prohibited");
  assert.ok(zeroVariance.reasons.includes("partial_market_data"));
  assert.equal(zeroVariance.correlationAnalysis.reason, "zero_variance_correlation_series");
});

test("empty portfolio does not require fabricated return history or correlation", () => {
  const result = evaluatePortfolioAdditionalBuyWithCorrelation(baseInput({
    portfolio: { totalExposure: 0, symbolExposure: 0 },
    currentPosition: { quantity: 0, averagePrice: undefined, currentPrice: 108 },
    correlationSeries: undefined,
  }));
  assert.equal(result.classification, "additional_buy_allowed");
  assert.equal(result.correlation, 0);
  assert.equal(result.correlationAnalysis.notApplicable, true);
  assert.equal(result.correlationAnalysis.insufficientData, false);
});

test("mismatched correlation series are rejected instead of silently truncated", () => {
  assert.throws(() => calculatePearsonCorrelation(
    [0.01, 0.02, 0.03, 0.04, 0.05],
    [0.01, 0.02, 0.03, 0.04],
  ), (error) => error?.code === "CORRELATION_LENGTH_MISMATCH");
});

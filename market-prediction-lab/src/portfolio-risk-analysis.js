import { ResearchContractError } from "./research-governance.js";
import { evaluatePortfolioAdditionalBuy } from "./research-validation-layer.js";

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ResearchContractError("NON_FINITE_NUMBER", `${label} must be finite`, { label, value });
  }
  return value;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function calculatePearsonCorrelation(assetReturns, portfolioReturns, { minimumSamples = 5 } = {}) {
  if (!Number.isInteger(minimumSamples) || minimumSamples < 2) {
    throw new ResearchContractError("INVALID_CORRELATION_SAMPLE_LIMIT", "minimumSamples must be an integer of at least two");
  }
  if (!Array.isArray(assetReturns) || !Array.isArray(portfolioReturns)) {
    throw new ResearchContractError("INVALID_CORRELATION_SERIES", "assetReturns and portfolioReturns must be arrays");
  }
  if (assetReturns.length !== portfolioReturns.length) {
    throw new ResearchContractError("CORRELATION_LENGTH_MISMATCH", "return series must have identical lengths", {
      assetSamples: assetReturns.length,
      portfolioSamples: portfolioReturns.length,
    });
  }
  const sampleCount = assetReturns.length;
  if (sampleCount < minimumSamples) {
    return Object.freeze({
      correlation: null,
      sampleCount,
      minimumSamples,
      insufficientData: true,
      reason: "insufficient_correlation_samples",
    });
  }

  const asset = assetReturns.map((value, index) => finite(value, `assetReturns[${index}]`));
  const portfolio = portfolioReturns.map((value, index) => finite(value, `portfolioReturns[${index}]`));
  const assetMean = mean(asset);
  const portfolioMean = mean(portfolio);
  let covariance = 0;
  let assetVariance = 0;
  let portfolioVariance = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const assetDelta = asset[index] - assetMean;
    const portfolioDelta = portfolio[index] - portfolioMean;
    covariance += assetDelta * portfolioDelta;
    assetVariance += assetDelta ** 2;
    portfolioVariance += portfolioDelta ** 2;
  }

  const denominator = Math.sqrt(assetVariance * portfolioVariance);
  if (!(denominator > 0)) {
    return Object.freeze({
      correlation: null,
      sampleCount,
      minimumSamples,
      insufficientData: true,
      reason: "zero_variance_correlation_series",
    });
  }

  const correlation = Math.max(-1, Math.min(1, covariance / denominator));
  return Object.freeze({
    correlation,
    sampleCount,
    minimumSamples,
    insufficientData: false,
    reason: null,
  });
}

export function evaluatePortfolioAdditionalBuyWithCorrelation(input, { minimumSamples = 5 } = {}) {
  if (!input || typeof input !== "object") {
    throw new ResearchContractError("INVALID_PORTFOLIO_INPUT", "portfolio input is required");
  }
  const quantity = finite(input.currentPosition?.quantity ?? 0, "currentPosition.quantity");
  if (quantity < 0) {
    throw new ResearchContractError("INVALID_POSITION_QUANTITY", "currentPosition.quantity cannot be negative");
  }

  if (quantity === 0) {
    const decision = evaluatePortfolioAdditionalBuy({
      ...input,
      risk: { ...input.risk, correlation: 0 },
    });
    return Object.freeze({
      ...decision,
      correlation: 0,
      correlationAnalysis: Object.freeze({
        correlation: 0,
        sampleCount: 0,
        minimumSamples,
        insufficientData: false,
        notApplicable: true,
        reason: "empty_portfolio_correlation_not_applicable",
      }),
    });
  }

  const analysis = calculatePearsonCorrelation(
    input.correlationSeries?.assetReturns,
    input.correlationSeries?.portfolioReturns,
    { minimumSamples },
  );

  if (analysis.insufficientData) {
    const decision = evaluatePortfolioAdditionalBuy({
      ...input,
      risk: {
        ...input.risk,
        correlation: 0,
        partialMarketData: true,
      },
    });
    return Object.freeze({
      ...decision,
      correlation: null,
      correlationAnalysis: analysis,
    });
  }

  const decision = evaluatePortfolioAdditionalBuy({
    ...input,
    risk: {
      ...input.risk,
      correlation: analysis.correlation,
    },
  });
  return Object.freeze({
    ...decision,
    correlation: analysis.correlation,
    correlationAnalysis: analysis,
  });
}

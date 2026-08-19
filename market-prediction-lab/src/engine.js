import { clamp, round, validatePredictionInput } from "./contracts.js";
import { calculateFeatures } from "./indicators.js";
import { buildForecast } from "./forecast.js";
import { evaluateRules } from "./rules.js";
import { BASELINE_MODEL } from "./tiny-model.js";
import { predictDeployedTinyModel } from "./deployment-inference.js";

function stanceFromProbabilities(probabilities) {
  const entries = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  const [name, probability] = entries[0];
  if (name === "neutral" || probability < 0.46) return "neutral";
  if (name === "bullish") return probability >= 0.62 ? "bullish" : "mild_bullish";
  return probability >= 0.62 ? "bearish" : "mild_bearish";
}

function entropy(probabilities) {
  return -Object.values(probabilities).reduce((sum, probability) =>
    sum + (probability > 0 ? probability * Math.log(probability) : 0), 0);
}

function calculateConfidence(input, probabilities, trained) {
  const maximumEntropy = Math.log(3);
  const certainty = 1 - (entropy(probabilities) / maximumEntropy);
  let completeness = 0.72;
  if (input.marketFeatures.sentimentScore !== undefined) completeness += 0.05;
  if (input.market === "KR_STOCK" || input.market === "US_STOCK") {
    if (input.marketFeatures.foreignNetRatio !== undefined) completeness += 0.05;
    if (input.marketFeatures.institutionNetRatio !== undefined) completeness += 0.05;
  }
  if (input.market === "CRYPTO_FUTURES") {
    if (input.derivativesFeatures.openInterestChange !== undefined) completeness += 0.05;
    if (input.derivativesFeatures.fundingRate !== undefined) completeness += 0.05;
  }
  const modelCap = trained ? 0.9 : 0.72;
  return round(clamp((0.35 + certainty * 0.55) * completeness, 0.25, modelCap), 4);
}

function dataHealth(input) {
  const warnings = [];
  if (input.market === "CRYPTO_FUTURES") {
    if (input.derivativesFeatures.openInterestChange === undefined) warnings.push("open_interest_missing");
    if (input.derivativesFeatures.fundingRate === undefined) warnings.push("funding_rate_missing");
  }
  if ((input.market === "KR_STOCK" || input.market === "US_STOCK")
      && input.marketFeatures.foreignNetRatio === undefined
      && input.marketFeatures.institutionNetRatio === undefined) {
    warnings.push("flow_data_missing");
  }
  if (input.marketFeatures.sentimentScore === undefined) warnings.push("news_sentiment_missing");
  return Object.freeze({
    candleCount: input.candles.length,
    status: warnings.length === 0 ? "complete" : "partial",
    warnings: Object.freeze(warnings),
  });
}

export function analyzeMarket(rawInput, options = {}) {
  const input = validatePredictionInput(rawInput);
  const model = options.model ?? BASELINE_MODEL;
  const featureBundle = calculateFeatures(input);
  const ruleResult = evaluateRules(input, featureBundle);
  const modelResult = predictDeployedTinyModel({
    features: featureBundle.features,
    ruleScore: ruleResult.score,
  }, model);
  const probabilities = modelResult.probabilities;
  const forecast = buildForecast(input, featureBundle.indicators, probabilities);
  const health = dataHealth(input);
  const warnings = [...ruleResult.warnings];
  if (!modelResult.trained) {
    warnings.unshift("현재 초소형 모델은 데이터 수집용 기준 모델이며 학습 완료 모델이 아닙니다.");
  }
  if (health.status === "partial") {
    warnings.push("일부 데이터가 없어 신뢰도가 제한됩니다.");
  }

  return Object.freeze({
    schemaVersion: 1,
    generatedAt: Date.now(),
    modelVersion: modelResult.modelId,
    modelTrained: modelResult.trained,
    input: Object.freeze({
      market: input.market,
      symbol: input.symbol,
      timeframe: input.timeframe,
      horizon: input.horizon,
      lastTimestamp: input.candles.at(-1).timestamp,
      lastClose: input.candles.at(-1).close,
      source: input.source,
    }),
    stance: stanceFromProbabilities(probabilities),
    confidence: calculateConfidence(input, probabilities, modelResult.trained),
    probabilities: Object.freeze({
      bullish: round(probabilities.bullish, 6),
      neutral: round(probabilities.neutral, 6),
      bearish: round(probabilities.bearish, 6),
    }),
    ruleScore: ruleResult.score,
    indicators: featureBundle.indicators,
    features: featureBundle.features,
    reasons: ruleResult.reasons,
    warnings: Object.freeze([...new Set(warnings)].slice(0, 10)),
    dataHealth: health,
    scenarios: forecast.scenarios,
    forecastCandles: forecast.forecastCandles,
    uncertaintyBands: forecast.uncertaintyBands,
  });
}

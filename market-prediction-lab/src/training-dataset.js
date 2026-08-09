import { createHash } from "node:crypto";
import { analyzeMarket } from "./engine.js";
import { evaluatePrediction } from "./outcomes.js";

function recordId(parts) { return createHash("sha256").update(parts.join("|")).digest("hex"); }

function providerResult(provider, context, fallback, label) {
  if (provider === undefined) return { values: fallback ?? {}, availability: {} };
  if (typeof provider !== "function") throw new TypeError(`${label} must be a function`);
  const result = provider(Object.freeze(context));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new TypeError(`${label} returned an invalid value`);
  if (label === "derivativesFeatureProvider" && result.derivativesFeatures) {
    return { values: result.derivativesFeatures, availability: result.featureAvailability ?? {} };
  }
  if (label === "marketFeatureProvider" && result.marketFeatures) {
    return { values: result.marketFeatures, availability: result.featureAvailability ?? {} };
  }
  return { values: result, availability: {} };
}

export function buildTrainingRecords(snapshot, options = {}) {
  if (!snapshot?.metadata || !Array.isArray(snapshot.candles)) throw new TypeError("normalized snapshot is required");
  const lookback = options.lookback ?? 200;
  const horizon = options.horizon ?? 5;
  const stride = options.stride ?? 1;
  if (!Number.isInteger(lookback) || lookback < 60 || lookback > 1000) throw new RangeError("lookback must be between 60 and 1000");
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 20) throw new RangeError("horizon must be between 1 and 20");
  if (!Number.isInteger(stride) || stride < 1) throw new RangeError("stride must be a positive integer");

  const records = [];
  for (let anchorIndex = lookback - 1; anchorIndex + horizon < snapshot.candles.length; anchorIndex += stride) {
    const history = snapshot.candles.slice(anchorIndex - lookback + 1, anchorIndex + 1);
    const future = snapshot.candles.slice(anchorIndex + 1, anchorIndex + horizon + 1);
    const anchor = history.at(-1);
    const providerContext = {
      market: snapshot.metadata.market,
      symbol: snapshot.metadata.symbol,
      timeframe: snapshot.metadata.timeframe,
      anchorTimestamp: anchor.timestamp,
      anchorIndex,
      history: Object.freeze(history),
    };
    const market = providerResult(options.marketFeatureProvider, providerContext, options.marketFeatures, "marketFeatureProvider");
    const derivatives = providerResult(options.derivativesFeatureProvider, providerContext, options.derivativesFeatures, "derivativesFeatureProvider");
    const rawInput = {
      market: snapshot.metadata.market,
      symbol: snapshot.metadata.symbol,
      timeframe: snapshot.metadata.timeframe,
      horizon,
      candles: history,
      marketFeatures: market.values,
      derivativesFeatures: derivatives.values,
      collectedAt: anchor.timestamp,
      source: snapshot.metadata.source,
    };
    const prediction = analyzeMarket(rawInput, options.model ? { model: options.model } : {});
    const outcome = evaluatePrediction(prediction, future);
    const id = recordId([snapshot.metadata.market, snapshot.metadata.symbol, snapshot.metadata.timeframe, anchor.timestamp, horizon, prediction.modelVersion]);
    records.push(Object.freeze({
      schemaVersion: 2,
      id,
      market: snapshot.metadata.market,
      symbol: snapshot.metadata.symbol,
      timeframe: snapshot.metadata.timeframe,
      anchorTimestamp: anchor.timestamp,
      futureStartTimestamp: future[0].timestamp,
      futureEndTimestamp: future.at(-1).timestamp,
      horizon,
      modelVersion: prediction.modelVersion,
      modelTrained: prediction.modelTrained,
      features: prediction.features,
      featureAvailability: Object.freeze({ ...market.availability, ...derivatives.availability }),
      probabilities: prediction.probabilities,
      ruleScore: prediction.ruleScore,
      confidence: prediction.confidence,
      label: Object.freeze({
        direction: outcome.actualDirection,
        return: outcome.actualReturn,
        directionHit: outcome.directionHit,
        rangeHit80: outcome.rangeHit80,
        maxFavorableMove: outcome.maxFavorableMove,
        maxAdverseMove: outcome.maxAdverseMove,
      }),
    }));
  }
  return Object.freeze(records);
}

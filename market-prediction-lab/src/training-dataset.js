import { createHash } from "node:crypto";
import { analyzeMarket } from "./engine.js";
import { evaluatePrediction } from "./outcomes.js";

function recordId(parts) { return createHash("sha256").update(parts.join("|")).digest("hex"); }

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
    const rawInput = {
      market: snapshot.metadata.market,
      symbol: snapshot.metadata.symbol,
      timeframe: snapshot.metadata.timeframe,
      horizon,
      candles: history,
      marketFeatures: options.marketFeatures ?? {},
      derivativesFeatures: options.derivativesFeatures ?? {},
      collectedAt: anchor.timestamp,
      source: snapshot.metadata.source,
    };
    const prediction = analyzeMarket(rawInput, options.model ? { model: options.model } : {});
    const outcome = evaluatePrediction(prediction, future);
    const id = recordId([snapshot.metadata.market, snapshot.metadata.symbol, snapshot.metadata.timeframe, anchor.timestamp, horizon, prediction.modelVersion]);
    records.push(Object.freeze({
      schemaVersion: 1,
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

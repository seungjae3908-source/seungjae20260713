import { round } from "./contracts.js";

function directionFromReturn(value, neutralThreshold) {
  if (value > neutralThreshold) return "bullish";
  if (value < -neutralThreshold) return "bearish";
  return "neutral";
}

export function evaluatePrediction(prediction, actualCandles) {
  if (!prediction || !prediction.input || !Array.isArray(actualCandles) || actualCandles.length === 0) {
    throw new TypeError("prediction and actualCandles are required");
  }
  const initialClose = prediction.input.lastClose;
  const finalClose = actualCandles.at(-1).close;
  const actualReturn = (finalClose / initialClose) - 1;
  const neutralThreshold = Math.max(prediction.indicators.atrPct * 0.35, 0.002);
  const actualDirection = directionFromReturn(actualReturn, neutralThreshold);
  const predictedDirection = prediction.stance === "mild_bullish" || prediction.stance === "bullish"
    ? "bullish"
    : prediction.stance === "mild_bearish" || prediction.stance === "bearish"
      ? "bearish"
      : "neutral";
  const finalBand = prediction.uncertaintyBands.at(-1);
  const rangeHit80 = finalClose >= finalBand.lower80 && finalClose <= finalBand.upper80;
  const maxHigh = Math.max(...actualCandles.map((candle) => candle.high));
  const minLow = Math.min(...actualCandles.map((candle) => candle.low));

  return Object.freeze({
    evaluatedAt: Date.now(),
    actualReturn: round(actualReturn, 8),
    actualDirection,
    predictedDirection,
    directionHit: actualDirection === predictedDirection,
    rangeHit80,
    maxFavorableMove: round((maxHigh / initialClose) - 1, 8),
    maxAdverseMove: round((minLow / initialClose) - 1, 8),
  });
}

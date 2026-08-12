import { PredictionInputError, round } from "./contracts.js";
import {
  buildCryptoWilliamsScannerSignal,
  buildCryptoWilliamsShadowOrderPlan,
  evaluateCryptoWilliamsAtrSignal,
  getKst09SessionKey,
} from "./crypto-williams-atr-strategy.js";

function finitePositive(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new PredictionInputError(`${name} must be a positive finite number`, { name, value });
  }
  return value;
}

function validateCandle(raw, index, previousTimestamp) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError(`candles[${index}] must be an object`);
  }
  if (!Number.isInteger(raw.timestamp) || raw.timestamp <= 0) {
    throw new PredictionInputError(`candles[${index}].timestamp must be a positive integer in milliseconds`);
  }
  if (previousTimestamp !== null && raw.timestamp <= previousTimestamp) {
    throw new PredictionInputError("candles must be strictly increasing by timestamp with no duplicates");
  }

  const open = finitePositive(raw.open, `candles[${index}].open`);
  const high = finitePositive(raw.high, `candles[${index}].high`);
  const low = finitePositive(raw.low, `candles[${index}].low`);
  const close = finitePositive(raw.close, `candles[${index}].close`);

  if (high < Math.max(open, low, close)) {
    throw new PredictionInputError(`candles[${index}].high is inconsistent with OHLC`);
  }
  if (low > Math.min(open, high, close)) {
    throw new PredictionInputError(`candles[${index}].low is inconsistent with OHLC`);
  }

  return Object.freeze({ timestamp: raw.timestamp, open, high, low, close });
}

export function aggregateKst09Sessions(rawCandles) {
  if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
    throw new PredictionInputError("candles must be a non-empty array");
  }

  const validated = [];
  let previousTimestamp = null;
  for (let index = 0; index < rawCandles.length; index += 1) {
    const candle = validateCandle(rawCandles[index], index, previousTimestamp);
    validated.push(candle);
    previousTimestamp = candle.timestamp;
  }

  const sessions = [];
  let current = null;

  for (const candle of validated) {
    const sessionKey = getKst09SessionKey(candle.timestamp);
    if (!current || current.sessionKey !== sessionKey) {
      if (current) sessions.push(Object.freeze(current));
      current = {
        sessionKey,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        firstTimestamp: candle.timestamp,
        lastTimestamp: candle.timestamp,
        candleCount: 1,
      };
      continue;
    }

    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.lastTimestamp = candle.timestamp;
    current.candleCount += 1;
  }

  if (current) sessions.push(Object.freeze(current));
  return Object.freeze(sessions);
}

function simpleMean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function trueRange(session, previousClose) {
  return Math.max(
    session.high - session.low,
    Math.abs(session.high - previousClose),
    Math.abs(session.low - previousClose),
  );
}

export function buildCryptoWilliamsAtrInputFromCandles(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("candle adapter input must be an object");
  }

  const sessions = aggregateKst09Sessions(raw.candles);
  if (sessions.length < 16) {
    throw new PredictionInputError(
      "at least 16 KST09 sessions are required: 15 completed sessions plus the current session",
      { sessionCount: sessions.length },
    );
  }

  const currentSession = sessions.at(-1);
  const completedSessions = sessions.slice(0, -1);
  const previousSession = completedSessions.at(-1);
  const maWindow = completedSessions.slice(-5);
  if (maWindow.length !== 5) {
    throw new PredictionInputError("five completed sessions are required for MA5");
  }

  const trValues = [];
  for (let index = 1; index < completedSessions.length; index += 1) {
    trValues.push(trueRange(completedSessions[index], completedSessions[index - 1].close));
  }
  const atrWindow = trValues.slice(-14);
  if (atrWindow.length !== 14) {
    throw new PredictionInputError("fifteen completed sessions are required to calculate ATR14 without lookahead");
  }

  const movingAverage = simpleMean(maWindow.map((session) => session.close));
  const atr = simpleMean(atrWindow);

  const strategyInput = Object.freeze({
    market: raw.market,
    previousHigh: previousSession.high,
    previousLow: previousSession.low,
    sessionOpen: currentSession.open,
    currentPrice: currentSession.close,
    movingAverage,
    atr,
    capital: raw.capital,
    ...(raw.feeRate !== undefined ? { feeRate: raw.feeRate } : {}),
    ...(raw.spreadRate !== undefined ? { spreadRate: raw.spreadRate } : {}),
    ...(raw.slippageRate !== undefined ? { slippageRate: raw.slippageRate } : {}),
    ...(raw.markPrice !== undefined ? { markPrice: raw.markPrice } : {}),
    ...(raw.fundingRate !== undefined ? { fundingRate: raw.fundingRate } : {}),
    ...(raw.leverage !== undefined ? { leverage: raw.leverage } : {}),
    ...(raw.liquidationPrice !== undefined ? { liquidationPrice: raw.liquidationPrice } : {}),
  });

  return Object.freeze({
    strategyInput,
    indicators: Object.freeze({
      sessionTimezone: "Asia/Seoul",
      sessionOpenHour: 9,
      currentSessionKey: currentSession.sessionKey,
      previousSessionKey: previousSession.sessionKey,
      previousHigh: round(previousSession.high),
      previousLow: round(previousSession.low),
      sessionOpen: round(currentSession.open),
      currentPrice: round(currentSession.close),
      movingAverage5: round(movingAverage),
      atr14: round(atr),
      atrDefinition: "SMA_OF_LAST_14_COMPLETED_SESSION_TRUE_RANGES",
      completedSessionCount: completedSessions.length,
      currentSessionCandleCount: currentSession.candleCount,
      latestTimestamp: currentSession.lastTimestamp,
    }),
  });
}

export function evaluateCryptoWilliamsAtrFromCandles(raw, configOverrides = {}) {
  const built = buildCryptoWilliamsAtrInputFromCandles(raw);
  const strategyResult = evaluateCryptoWilliamsAtrSignal(built.strategyInput, configOverrides);
  const scannerSignal = buildCryptoWilliamsScannerSignal(strategyResult, { symbol: raw.symbol });
  const shadowOrderPlan = strategyResult.eligibleForShadow && typeof raw.symbol === "string" && raw.symbol.length > 0
    ? buildCryptoWilliamsShadowOrderPlan(strategyResult, {
      symbol: raw.symbol,
      timestamp: built.indicators.latestTimestamp,
    })
    : null;

  return Object.freeze({
    indicators: built.indicators,
    strategyResult,
    scannerSignal,
    shadowOrderPlan,
  });
}

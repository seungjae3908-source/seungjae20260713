import { PredictionInputError, round } from "./contracts.js";

export const CRYPTO_WILLIAMS_ATR_STRATEGY_ID = "crypto-williams-atr-v1";

export const CRYPTO_WILLIAMS_ATR_DEFAULTS = Object.freeze({
  k: 0.5,
  atrPeriod: 14,
  atrStopMultiplier: 2,
  riskFraction: 0.005,
  maPeriod: 5,
  sessionTimezone: "Asia/Seoul",
  sessionOpenHour: 9,
  executionMode: "PAPER_SHADOW_ONLY",
  kellyEnabled: false,
});

const SUPPORTED_MARKETS = Object.freeze(["CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const SUPPORTED_DIRECTIONS = Object.freeze(["LONG", "SHORT"]);
const SESSION_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function finite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PredictionInputError(`${name} must be a finite number`, { name, value });
  }
  return value;
}

function positive(value, name) {
  finite(value, name);
  if (!(value > 0)) {
    throw new PredictionInputError(`${name} must be greater than zero`, { name, value });
  }
  return value;
}

function nonNegative(value, name) {
  finite(value, name);
  if (value < 0) {
    throw new PredictionInputError(`${name} cannot be negative`, { name, value });
  }
  return value;
}

function optionalFinite(value, name) {
  if (value === undefined || value === null) return undefined;
  return finite(value, name);
}

function validateMarket(market) {
  if (!SUPPORTED_MARKETS.includes(market)) {
    throw new PredictionInputError(`market must be one of: ${SUPPORTED_MARKETS.join(", ")}`);
  }
  return market;
}

function validateDirection(direction, market) {
  if (!SUPPORTED_DIRECTIONS.includes(direction)) {
    throw new PredictionInputError(`direction must be one of: ${SUPPORTED_DIRECTIONS.join(", ")}`);
  }
  if (market === "CRYPTO_SPOT" && direction !== "LONG") {
    throw new PredictionInputError("CRYPTO_SPOT supports LONG only in V1");
  }
  return direction;
}

function validateSessionKey(value, name = "entrySessionKey") {
  if (typeof value !== "string" || !SESSION_KEY_PATTERN.test(value)) {
    throw new PredictionInputError(`${name} must use YYYY-MM-DD format`, { name, value });
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new PredictionInputError(`${name} must be a valid calendar date`, { name, value });
  }
  return value;
}

function normalizeConfig(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new PredictionInputError("config must be an object");
  }

  const config = { ...CRYPTO_WILLIAMS_ATR_DEFAULTS, ...overrides };
  positive(config.k, "config.k");
  if (config.k > 2) throw new PredictionInputError("config.k must be <= 2");
  if (!Number.isInteger(config.atrPeriod) || config.atrPeriod < 2 || config.atrPeriod > 200) {
    throw new PredictionInputError("config.atrPeriod must be an integer between 2 and 200");
  }
  positive(config.atrStopMultiplier, "config.atrStopMultiplier");
  if (config.atrStopMultiplier > 10) {
    throw new PredictionInputError("config.atrStopMultiplier must be <= 10");
  }
  positive(config.riskFraction, "config.riskFraction");
  if (config.riskFraction > 0.01) {
    throw new PredictionInputError("config.riskFraction must be <= 0.01 for V1");
  }
  if (!Number.isInteger(config.maPeriod) || config.maPeriod < 2 || config.maPeriod > 200) {
    throw new PredictionInputError("config.maPeriod must be an integer between 2 and 200");
  }
  if (config.sessionTimezone !== "Asia/Seoul" || config.sessionOpenHour !== 9) {
    throw new PredictionInputError("V1 session boundary is fixed to Asia/Seoul 09:00 (UTC 00:00)");
  }
  if (config.executionMode !== "PAPER_SHADOW_ONLY") {
    throw new PredictionInputError("V1 executionMode must remain PAPER_SHADOW_ONLY");
  }
  if (config.kellyEnabled !== false) {
    throw new PredictionInputError("Kelly sizing is disabled in V1");
  }

  return Object.freeze(config);
}

export function getKst09SessionKey(timestamp) {
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new PredictionInputError("timestamp must be a positive integer in milliseconds", { timestamp });
  }
  return new Date(timestamp).toISOString().slice(0, 10);
}

function validateInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("input must be an object");
  }
  const market = validateMarket(raw.market);

  const previousHigh = positive(raw.previousHigh, "previousHigh");
  const previousLow = positive(raw.previousLow, "previousLow");
  if (previousHigh < previousLow) {
    throw new PredictionInputError("previousHigh must be >= previousLow");
  }

  const sessionOpen = positive(raw.sessionOpen, "sessionOpen");
  const currentPrice = positive(raw.currentPrice, "currentPrice");
  const movingAverage = positive(raw.movingAverage, "movingAverage");
  const atr = positive(raw.atr, "atr");
  const capital = positive(raw.capital, "capital");

  const feeRate = raw.feeRate === undefined ? 0 : nonNegative(raw.feeRate, "feeRate");
  const spreadRate = raw.spreadRate === undefined ? 0 : nonNegative(raw.spreadRate, "spreadRate");
  const slippageRate = raw.slippageRate === undefined ? 0 : nonNegative(raw.slippageRate, "slippageRate");
  for (const [name, value] of [["feeRate", feeRate], ["spreadRate", spreadRate], ["slippageRate", slippageRate]]) {
    if (value >= 1) throw new PredictionInputError(`${name} must be less than 1`, { name, value });
  }

  const markPrice = optionalFinite(raw.markPrice, "markPrice");
  if (markPrice !== undefined && markPrice <= 0) {
    throw new PredictionInputError("markPrice must be greater than zero");
  }
  const fundingRate = raw.fundingRate === undefined ? 0 : finite(raw.fundingRate, "fundingRate");
  const leverage = raw.leverage === undefined ? 1 : positive(raw.leverage, "leverage");
  const liquidationPrice = optionalFinite(raw.liquidationPrice, "liquidationPrice");
  if (liquidationPrice !== undefined && liquidationPrice <= 0) {
    throw new PredictionInputError("liquidationPrice must be greater than zero");
  }

  if (market === "CRYPTO_SPOT") {
    if (raw.leverage !== undefined && leverage !== 1) {
      throw new PredictionInputError("CRYPTO_SPOT leverage must be 1");
    }
    if (markPrice !== undefined || liquidationPrice !== undefined || raw.fundingRate !== undefined) {
      throw new PredictionInputError("derivatives-only fields are not allowed for CRYPTO_SPOT");
    }
  }

  const derivativesContext = market === "CRYPTO_FUTURES"
    ? Object.freeze({
      markPriceSupplied: raw.markPrice !== undefined && raw.markPrice !== null,
      fundingRateSupplied: raw.fundingRate !== undefined && raw.fundingRate !== null,
      leverageSupplied: raw.leverage !== undefined && raw.leverage !== null,
      liquidationPriceSupplied: raw.liquidationPrice !== undefined && raw.liquidationPrice !== null,
      complete:
        raw.markPrice !== undefined && raw.markPrice !== null
        && raw.fundingRate !== undefined && raw.fundingRate !== null
        && raw.leverage !== undefined && raw.leverage !== null
        && raw.liquidationPrice !== undefined && raw.liquidationPrice !== null,
    })
    : null;

  return Object.freeze({
    market,
    previousHigh,
    previousLow,
    sessionOpen,
    currentPrice,
    movingAverage,
    atr,
    capital,
    feeRate,
    spreadRate,
    slippageRate,
    markPrice,
    fundingRate,
    leverage,
    liquidationPrice,
    derivativesContext,
  });
}

function liquidationSafety({ direction, stopPrice, liquidationPrice, market }) {
  if (market !== "CRYPTO_FUTURES") {
    return Object.freeze({ verified: true, safe: true, reason: "not_applicable_to_spot" });
  }
  if (liquidationPrice === undefined) {
    return Object.freeze({ verified: false, safe: null, reason: "liquidation_price_not_supplied" });
  }
  const safe = direction === "LONG"
    ? liquidationPrice < stopPrice
    : direction === "SHORT"
      ? liquidationPrice > stopPrice
      : true;
  return Object.freeze({
    verified: direction === "LONG" || direction === "SHORT",
    safe,
    reason: safe ? "stop_precedes_liquidation" : "liquidation_can_precede_stop",
  });
}

export function evaluateCryptoWilliamsAtrSignal(rawInput, configOverrides = {}) {
  const input = validateInput(rawInput);
  const config = normalizeConfig(configOverrides);
  const range = input.previousHigh - input.previousLow;
  const longTarget = input.sessionOpen + range * config.k;
  const shortTarget = input.sessionOpen - range * config.k;

  const longBreakout = input.currentPrice >= longTarget;
  const longTrendPass = input.sessionOpen > input.movingAverage;
  const shortBreakout = input.currentPrice <= shortTarget;
  const shortTrendPass = input.sessionOpen < input.movingAverage;

  let direction = null;
  const reasons = [];

  if (longBreakout && longTrendPass) {
    direction = "LONG";
    reasons.push("long_breakout", "long_trend_filter_pass");
  } else if (input.market === "CRYPTO_FUTURES" && shortBreakout && shortTrendPass) {
    direction = "SHORT";
    reasons.push("short_breakout", "short_trend_filter_pass");
  } else {
    if (longBreakout && !longTrendPass) reasons.push("long_trend_filter_rejected");
    if (input.market === "CRYPTO_FUTURES" && shortBreakout && !shortTrendPass) reasons.push("short_trend_filter_rejected");
    if (!longBreakout && !(input.market === "CRYPTO_FUTURES" && shortBreakout)) reasons.push("breakout_not_reached");
    if (input.market === "CRYPTO_SPOT" && shortBreakout) reasons.push("spot_short_disabled");
  }

  const stopDistance = input.atr * config.atrStopMultiplier;
  const riskMoney = input.capital * config.riskFraction;
  const entryPrice = direction ? input.currentPrice : null;
  const stopPrice = direction === "LONG"
    ? entryPrice - stopDistance
    : direction === "SHORT"
      ? entryPrice + stopDistance
      : null;
  const quantity = direction ? riskMoney / stopDistance : 0;

  if (stopPrice !== null && stopPrice <= 0) {
    return Object.freeze({
      strategyId: CRYPTO_WILLIAMS_ATR_STRATEGY_ID,
      status: "REJECTED",
      direction,
      market: input.market,
      reasons: Object.freeze([...reasons, "non_positive_stop_price"]),
      executionMode: config.executionMode,
      liveExecutionAllowed: false,
      kellyEnabled: false,
      eligibleForPaper: false,
      eligibleForShadow: false,
    });
  }

  const liquidation = liquidationSafety({
    direction,
    stopPrice,
    liquidationPrice: input.liquidationPrice,
    market: input.market,
  });
  const liquidationBlocked = Boolean(direction && liquidation.verified && liquidation.safe === false);
  const status = liquidationBlocked ? "REJECTED" : direction ? "ENTRY" : "NO_ENTRY";
  if (liquidationBlocked) reasons.push("liquidation_guard_rejected");

  const estimatedRoundTripExecutionCostRate = input.feeRate * 2 + input.spreadRate + input.slippageRate * 2;
  const futuresShadowContextReady = input.market !== "CRYPTO_FUTURES" || input.derivativesContext?.complete === true;
  const shadowSafetyReady = input.market === "CRYPTO_SPOT"
    || (liquidation.verified && futuresShadowContextReady);
  if (status === "ENTRY" && input.market === "CRYPTO_FUTURES" && !futuresShadowContextReady) {
    reasons.push("shadow_derivatives_context_incomplete");
  }

  return Object.freeze({
    strategyId: CRYPTO_WILLIAMS_ATR_STRATEGY_ID,
    status,
    market: input.market,
    direction,
    executionMode: config.executionMode,
    liveExecutionAllowed: false,
    kellyEnabled: false,
    eligibleForPaper: status === "ENTRY",
    eligibleForShadow: status === "ENTRY" && shadowSafetyReady && !liquidationBlocked,
    levels: Object.freeze({
      previousRange: round(range),
      longTarget: round(longTarget),
      shortTarget: input.market === "CRYPTO_FUTURES" ? round(shortTarget) : null,
      entryPrice: entryPrice === null ? null : round(entryPrice),
      stopPrice: stopPrice === null ? null : round(stopPrice),
      stopDistance: round(stopDistance),
    }),
    sizing: Object.freeze({
      capital: round(input.capital),
      riskFraction: config.riskFraction,
      riskMoney: round(riskMoney),
      quantity: round(quantity),
      leverage: input.market === "CRYPTO_FUTURES" ? input.leverage : 1,
      sizingBasis: "capital_risk_divided_by_atr_stop_distance",
    }),
    diagnostics: Object.freeze({
      k: config.k,
      atrPeriod: config.atrPeriod,
      atrStopMultiplier: config.atrStopMultiplier,
      maPeriod: config.maPeriod,
      longBreakout,
      longTrendPass,
      shortBreakout: input.market === "CRYPTO_FUTURES" ? shortBreakout : false,
      shortTrendPass: input.market === "CRYPTO_FUTURES" ? shortTrendPass : false,
      feeRate: input.feeRate,
      spreadRate: input.spreadRate,
      slippageRate: input.slippageRate,
      estimatedRoundTripExecutionCostRate: round(estimatedRoundTripExecutionCostRate, 10),
      markPrice: input.market === "CRYPTO_FUTURES" ? input.markPrice ?? null : null,
      fundingRate: input.market === "CRYPTO_FUTURES" ? input.fundingRate : null,
      derivativesContext: input.derivativesContext,
      liquidation,
      sessionTimezone: config.sessionTimezone,
      sessionOpenHour: config.sessionOpenHour,
    }),
    exitPolicy: Object.freeze({
      atrStop: true,
      nextSessionOpen: true,
      sessionTimezone: config.sessionTimezone,
      sessionOpenHour: config.sessionOpenHour,
    }),
    reasons: Object.freeze(reasons),
  });
}

export function evaluateCryptoWilliamsAtrExit(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("exit input must be an object");
  }

  const market = validateMarket(raw.market);
  const direction = validateDirection(raw.direction, market);
  const stopPrice = positive(raw.stopPrice, "stopPrice");
  const riskPrice = positive(raw.riskPrice, "riskPrice");
  const entrySessionKey = validateSessionKey(raw.entrySessionKey);
  const currentSessionKey = getKst09SessionKey(raw.timestamp);

  if (currentSessionKey < entrySessionKey) {
    throw new PredictionInputError("timestamp cannot precede the entry session", {
      entrySessionKey,
      currentSessionKey,
    });
  }

  let shouldExit = false;
  let reason = "HOLD";

  if (currentSessionKey > entrySessionKey) {
    shouldExit = true;
    reason = "NEXT_SESSION_OPEN";
  } else if (direction === "LONG" && riskPrice <= stopPrice) {
    shouldExit = true;
    reason = "ATR_STOP";
  } else if (direction === "SHORT" && riskPrice >= stopPrice) {
    shouldExit = true;
    reason = "ATR_STOP";
  }

  return Object.freeze({
    strategyId: CRYPTO_WILLIAMS_ATR_STRATEGY_ID,
    market,
    direction,
    shouldExit,
    reason,
    riskPrice: round(riskPrice),
    stopPrice: round(stopPrice),
    entrySessionKey,
    currentSessionKey,
    side: shouldExit ? (direction === "LONG" ? "SELL" : "BUY") : null,
    orderType: shouldExit ? "MARKET_SIMULATED" : null,
    reduceOnly: shouldExit && market === "CRYPTO_FUTURES",
    liveExecutionAllowed: false,
    privateExchangeApiAllowed: false,
  });
}

export function buildCryptoWilliamsScannerSignal(result, metadata = {}) {
  if (!result || result.strategyId !== CRYPTO_WILLIAMS_ATR_STRATEGY_ID) {
    throw new PredictionInputError("a crypto Williams ATR strategy result is required");
  }
  return Object.freeze({
    strategyId: result.strategyId,
    market: result.market,
    symbol: typeof metadata.symbol === "string" ? metadata.symbol.toUpperCase() : null,
    status: result.status,
    direction: result.direction,
    target: result.direction === "SHORT" ? result.levels?.shortTarget ?? null : result.levels?.longTarget ?? null,
    stopPrice: result.levels?.stopPrice ?? null,
    riskFraction: result.sizing?.riskFraction ?? null,
    quantity: result.sizing?.quantity ?? 0,
    exitPolicy: result.exitPolicy ?? null,
    executionMode: result.executionMode,
    liveExecutionAllowed: false,
    reasons: result.reasons ?? Object.freeze([]),
  });
}

export function buildCryptoWilliamsShadowOrderPlan(result, metadata = {}) {
  if (!result || result.strategyId !== CRYPTO_WILLIAMS_ATR_STRATEGY_ID) {
    throw new PredictionInputError("a crypto Williams ATR strategy result is required");
  }
  if (result.executionMode !== "PAPER_SHADOW_ONLY" || result.liveExecutionAllowed !== false) {
    throw new PredictionInputError("live execution is forbidden for crypto Williams ATR V1");
  }
  if (result.status !== "ENTRY" || !result.eligibleForShadow) return null;
  if (typeof metadata.symbol !== "string" || metadata.symbol.length === 0) {
    throw new PredictionInputError("metadata.symbol is required for a shadow order plan");
  }
  const entrySessionKey = getKst09SessionKey(metadata.timestamp);

  return Object.freeze({
    mode: "SHADOW",
    strategyId: result.strategyId,
    market: result.market,
    symbol: metadata.symbol.toUpperCase(),
    side: result.direction === "LONG" ? "BUY" : "SELL",
    positionDirection: result.direction,
    orderType: "MARKET_SIMULATED",
    quantity: result.sizing.quantity,
    referenceEntryPrice: result.levels.entryPrice,
    protectiveStopPrice: result.levels.stopPrice,
    entrySessionKey,
    exitPolicy: result.exitPolicy,
    reduceOnlyOnExit: result.market === "CRYPTO_FUTURES",
    liveExecutionAllowed: false,
    privateExchangeApiAllowed: false,
  });
}

import { createHash } from "node:crypto";

export const EXECUTION_MARKETS = Object.freeze([
  "KR_STOCK",
  "US_STOCK",
  "CRYPTO_SPOT",
  "CRYPTO_FUTURES",
]);

export const EXECUTION_STAGES = Object.freeze(["BACKTEST", "SHADOW", "PAPER"]);
export const EXECUTION_STYLES = Object.freeze(["SCALPING", "SWING", "MID_LONG"]);
export const EXECUTION_FILL_MODELS = Object.freeze(["BAR_PROXY", "TOP_OF_BOOK", "DEPTH_PARTICIPATION"]);
export const EXECUTION_ORDER_TYPES = Object.freeze(["MARKET", "LIMIT", "STOP_MARKET"]);

export const FOUR_MARKET_EXECUTION_PROFILES = Object.freeze({
  KR_STOCK: Object.freeze({
    provider: "toss",
    settlementCurrency: "KRW",
    directions: Object.freeze(["BUY", "SELL_EXIT"]),
    continuousTrading: false,
    requiresSessionEvidence: true,
    requiresCorporateActionEvidenceForBacktest: true,
    requiresVolatilityInterruptionEvidence: true,
  }),
  US_STOCK: Object.freeze({
    provider: "toss",
    settlementCurrency: "USD",
    directions: Object.freeze(["BUY", "SELL_EXIT"]),
    continuousTrading: false,
    requiresSessionEvidence: true,
    requiresCorporateActionEvidenceForBacktest: true,
    requiresVolatilityInterruptionEvidence: false,
  }),
  CRYPTO_SPOT: Object.freeze({
    provider: "upbit",
    settlementCurrency: "KRW",
    directions: Object.freeze(["BUY", "SELL_EXIT"]),
    continuousTrading: true,
    requiresSessionEvidence: false,
    requiresCorporateActionEvidenceForBacktest: false,
    requiresVolatilityInterruptionEvidence: false,
  }),
  CRYPTO_FUTURES: Object.freeze({
    provider: "bitget",
    settlementCurrency: "USDT",
    directions: Object.freeze(["LONG", "SHORT"]),
    continuousTrading: true,
    requiresSessionEvidence: false,
    requiresCorporateActionEvidenceForBacktest: false,
    requiresVolatilityInterruptionEvidence: false,
  }),
});

const MARKET_SET = new Set(EXECUTION_MARKETS);
const STAGE_SET = new Set(EXECUTION_STAGES);
const STYLE_SET = new Set(EXECUTION_STYLES);
const FILL_MODEL_SET = new Set(EXECUTION_FILL_MODELS);
const ORDER_TYPE_SET = new Set(EXECUTION_ORDER_TYPES);
const NON_NEGATIVE_COST_FIELDS = Object.freeze([
  "commissionRate",
  "taxRate",
  "spreadRate",
  "slippageRate",
  "latencyRate",
  "liquidityImpactRate",
  "partialFillImpactRate",
  "fundingRate",
]);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return isFiniteNumber(value) && value > 0;
}

function nonNegative(value) {
  return isFiniteNumber(value) && value >= 0;
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function addBlocker(blockers, condition, code) {
  if (!condition) blockers.push(code);
}

function validateCosts(costPolicy, blockers) {
  addBlocker(blockers, nonEmptyString(costPolicy?.version), "COST_POLICY_VERSION_REQUIRED");
  for (const field of NON_NEGATIVE_COST_FIELDS) {
    addBlocker(blockers, nonNegative(costPolicy?.[field]), `COST_${field.toUpperCase()}_REQUIRED`);
  }
}

function validateExecutionPolicy(executionPolicy, stage, blockers) {
  addBlocker(blockers, nonEmptyString(executionPolicy?.version), "EXECUTION_POLICY_VERSION_REQUIRED");
  addBlocker(blockers, FILL_MODEL_SET.has(executionPolicy?.fillModel), "FILL_MODEL_REQUIRED");
  addBlocker(blockers, executionPolicy?.sameBarPolicy === "STOP_FIRST", "CONSERVATIVE_STOP_FIRST_REQUIRED");
  addBlocker(blockers, typeof executionPolicy?.allowPartialFill === "boolean", "PARTIAL_FILL_POLICY_REQUIRED");
  addBlocker(blockers, positive(executionPolicy?.maxParticipationRate) && executionPolicy.maxParticipationRate <= 1, "MAX_PARTICIPATION_RATE_REQUIRED");
  if (stage === "BACKTEST") addBlocker(blockers, executionPolicy?.nextBarOnly === true, "BACKTEST_NEXT_BAR_ONLY_REQUIRED");
}

function validateCommonEvidence({ profile, stage, dataEvidence, evaluatedAtMs }, blockers) {
  addBlocker(blockers, dataEvidence?.provider === profile.provider, "CANONICAL_PROVIDER_MISMATCH");
  addBlocker(blockers, dataEvidence?.publicOnly === true, "PUBLIC_EVIDENCE_REQUIRED");
  addBlocker(blockers, dataEvidence?.dataQuality === "READY", "DATA_QUALITY_NOT_READY");
  addBlocker(blockers, nonEmptyString(dataEvidence?.provenance), "DATA_PROVENANCE_REQUIRED");
  addBlocker(blockers, isFiniteNumber(dataEvidence?.asOfMs), "DATA_TIMESTAMP_REQUIRED");
  if (isFiniteNumber(dataEvidence?.asOfMs)) addBlocker(blockers, dataEvidence.asOfMs <= evaluatedAtMs, "FUTURE_DATA_FORBIDDEN");
  if (stage === "BACKTEST") addBlocker(blockers, dataEvidence?.closedDataOnly === true, "BACKTEST_CLOSED_DATA_ONLY_REQUIRED");
}

function validateStockEvidence({ market, stage, style, dataEvidence }, blockers) {
  addBlocker(blockers, positive(dataEvidence?.tickSize), "STOCK_TICK_SIZE_REQUIRED");
  addBlocker(blockers, dataEvidence?.taxPolicyKnown === true, "STOCK_TAX_POLICY_REQUIRED");
  addBlocker(blockers, nonEmptyString(dataEvidence?.session?.version), "STOCK_SESSION_VERSION_REQUIRED");
  addBlocker(blockers, ["OPEN", "CLOSED"].includes(dataEvidence?.session?.status), "STOCK_SESSION_STATUS_REQUIRED");
  if (stage !== "BACKTEST") addBlocker(blockers, dataEvidence?.session?.status === "OPEN", "STOCK_SESSION_NOT_OPEN");
  if (stage === "BACKTEST") addBlocker(blockers, dataEvidence?.corporateActionAdjusted === true, "CORPORATE_ACTION_EVIDENCE_REQUIRED");

  if (market === "KR_STOCK") {
    addBlocker(blockers, typeof dataEvidence?.volatilityInterruptionKnown === "boolean", "KR_VOLATILITY_INTERRUPTION_EVIDENCE_REQUIRED");
    if (style === "SCALPING" && dataEvidence?.volatilityInterruptionKnown === true) {
      addBlocker(blockers, dataEvidence?.volatilityInterruptionActive !== true, "KR_VOLATILITY_INTERRUPTION_ACTIVE");
    }
  }

  if (market === "US_STOCK") {
    addBlocker(blockers, ["REGULAR", "PREMARKET", "AFTER_HOURS"].includes(dataEvidence?.session?.kind), "US_SESSION_KIND_REQUIRED");
    if (["PREMARKET", "AFTER_HOURS"].includes(dataEvidence?.session?.kind)) {
      addBlocker(blockers, dataEvidence?.extendedHoursEvidenceReady === true, "US_EXTENDED_HOURS_EVIDENCE_REQUIRED");
    }
  }
}

function validateSpotEvidence({ dataEvidence }, blockers) {
  addBlocker(blockers, dataEvidence?.marketStatus === "TRADABLE", "UPBIT_MARKET_NOT_TRADABLE");
  addBlocker(blockers, positive(dataEvidence?.tickSize), "UPBIT_TICK_SIZE_REQUIRED");
  addBlocker(blockers, positive(dataEvidence?.minOrderNotional), "UPBIT_MIN_ORDER_NOTIONAL_REQUIRED");
}

function validateFuturesEvidence({ dataEvidence }, blockers) {
  addBlocker(blockers, dataEvidence?.contractStatus === "TRADABLE", "BITGET_CONTRACT_NOT_TRADABLE");
  addBlocker(blockers, positive(dataEvidence?.tickSize), "BITGET_TICK_SIZE_REQUIRED");
  addBlocker(blockers, positive(dataEvidence?.minQty), "BITGET_MIN_QTY_REQUIRED");
  addBlocker(blockers, positive(dataEvidence?.qtyStep), "BITGET_QTY_STEP_REQUIRED");
  addBlocker(blockers, positive(dataEvidence?.markPrice), "BITGET_MARK_PRICE_REQUIRED");
  addBlocker(blockers, positive(dataEvidence?.indexPrice), "BITGET_INDEX_PRICE_REQUIRED");
  addBlocker(blockers, isFiniteNumber(dataEvidence?.fundingRate), "BITGET_FUNDING_RATE_REQUIRED");
  addBlocker(blockers, nonNegative(dataEvidence?.openInterest), "BITGET_OPEN_INTEREST_REQUIRED");
  addBlocker(blockers, positive(dataEvidence?.leverage), "BITGET_LEVERAGE_REQUIRED");
  addBlocker(blockers, positive(dataEvidence?.maxLeverage) && dataEvidence.leverage <= dataEvidence.maxLeverage, "BITGET_LEVERAGE_LIMIT_INVALID");
  addBlocker(blockers, ["ISOLATED", "CROSS"].includes(dataEvidence?.marginMode), "BITGET_MARGIN_MODE_REQUIRED");
  addBlocker(blockers, positive(dataEvidence?.liquidationDistancePct), "BITGET_LIQUIDATION_DISTANCE_REQUIRED");
}

function validateFidelityEvidence({ stage, executionPolicy, dataEvidence }, blockers) {
  if (executionPolicy?.fillModel === "BAR_PROXY") {
    if (stage !== "BACKTEST") addBlocker(blockers, dataEvidence?.barProxyRealtimeAllowed === true, "REALTIME_BAR_PROXY_NOT_EVIDENCED");
    return;
  }

  addBlocker(blockers, dataEvidence?.quoteEvidence?.available === true, "QUOTE_EVIDENCE_REQUIRED");
  addBlocker(blockers, positive(dataEvidence?.quoteEvidence?.bid), "VALID_BID_REQUIRED");
  addBlocker(blockers, positive(dataEvidence?.quoteEvidence?.ask), "VALID_ASK_REQUIRED");
  if (positive(dataEvidence?.quoteEvidence?.bid) && positive(dataEvidence?.quoteEvidence?.ask)) {
    addBlocker(blockers, dataEvidence.quoteEvidence.bid <= dataEvidence.quoteEvidence.ask, "CROSSED_QUOTE_FORBIDDEN");
  }

  if (executionPolicy?.fillModel === "DEPTH_PARTICIPATION") {
    addBlocker(blockers, dataEvidence?.depthEvidence?.available === true, "DEPTH_EVIDENCE_REQUIRED");
    addBlocker(blockers, nonNegative(dataEvidence?.depthEvidence?.bidSize), "DEPTH_BID_SIZE_REQUIRED");
    addBlocker(blockers, nonNegative(dataEvidence?.depthEvidence?.askSize), "DEPTH_ASK_SIZE_REQUIRED");
  }
}

export function buildFourMarketExecutionContext({
  market,
  stage,
  style,
  direction,
  strategyIdentity,
  costPolicy,
  executionPolicy,
  dataEvidence,
  evaluatedAtMs,
} = {}) {
  if (!MARKET_SET.has(market)) throw new TypeError(`unsupported execution market: ${market}`);
  if (!STAGE_SET.has(stage)) throw new TypeError(`unsupported execution stage: ${stage}`);
  if (!STYLE_SET.has(style)) throw new TypeError(`unsupported execution style: ${style}`);
  if (!isFiniteNumber(evaluatedAtMs)) throw new TypeError("evaluatedAtMs is required");

  const profile = FOUR_MARKET_EXECUTION_PROFILES[market];
  const blockers = [];
  addBlocker(blockers, profile.directions.includes(direction), "DIRECTION_NOT_SUPPORTED");
  addBlocker(blockers, nonEmptyString(strategyIdentity?.strategyId), "STRATEGY_ID_REQUIRED");
  addBlocker(blockers, nonEmptyString(strategyIdentity?.strategyVersion), "STRATEGY_VERSION_REQUIRED");
  addBlocker(blockers, nonEmptyString(strategyIdentity?.parameterHash), "PARAMETER_HASH_REQUIRED");
  addBlocker(blockers, immutableSha(strategyIdentity?.researchCodeSha), "IMMUTABLE_RESEARCH_SHA_REQUIRED");

  validateCosts(costPolicy, blockers);
  validateExecutionPolicy(executionPolicy, stage, blockers);
  validateCommonEvidence({ profile, stage, dataEvidence, evaluatedAtMs }, blockers);

  if (market === "KR_STOCK" || market === "US_STOCK") validateStockEvidence({ market, stage, style, dataEvidence }, blockers);
  if (market === "CRYPTO_SPOT") validateSpotEvidence({ dataEvidence }, blockers);
  if (market === "CRYPTO_FUTURES") validateFuturesEvidence({ dataEvidence }, blockers);
  validateFidelityEvidence({ stage, executionPolicy, dataEvidence }, blockers);

  const parityPayload = Object.freeze({
    schemaVersion: 2,
    market,
    style,
    direction,
    provider: profile.provider,
    settlementCurrency: profile.settlementCurrency,
    strategyId: strategyIdentity?.strategyId ?? null,
    strategyVersion: strategyIdentity?.strategyVersion ?? null,
    parameterHash: strategyIdentity?.parameterHash ?? null,
    costPolicyVersion: costPolicy?.version ?? null,
    executionPolicyVersion: executionPolicy?.version ?? null,
    fillModel: executionPolicy?.fillModel ?? null,
    sameBarPolicy: executionPolicy?.sameBarPolicy ?? null,
    allowPartialFill: executionPolicy?.allowPartialFill ?? null,
    maxParticipationRate: executionPolicy?.maxParticipationRate ?? null,
    costRates: NON_NEGATIVE_COST_FIELDS.reduce((acc, field) => ({ ...acc, [field]: costPolicy?.[field] ?? null }), {}),
  });
  const parityFingerprint = createHash("sha256").update(stableSerialize(parityPayload)).digest("hex");

  return Object.freeze({
    schemaVersion: 2,
    status: blockers.length === 0 ? "READY" : "BLOCKED",
    blockers: Object.freeze([...new Set(blockers)]),
    market,
    stage,
    style,
    direction,
    provider: profile.provider,
    settlementCurrency: profile.settlementCurrency,
    profile,
    strategyIdentity: Object.freeze({
      strategyId: strategyIdentity?.strategyId ?? null,
      strategyVersion: strategyIdentity?.strategyVersion ?? null,
      parameterHash: strategyIdentity?.parameterHash ?? null,
      researchCodeSha: immutableSha(strategyIdentity?.researchCodeSha) ? strategyIdentity.researchCodeSha.toLowerCase() : null,
    }),
    costPolicy: Object.freeze({ ...(costPolicy ?? {}) }),
    executionPolicy: Object.freeze({ ...(executionPolicy ?? {}) }),
    parityPayload,
    parityFingerprint,
    evaluatedAtMs,
    safety: Object.freeze({
      simulationOnly: true,
      liveExecutionAllowed: false,
      privateAccountRequestAllowed: false,
      privateTradingRequestAllowed: false,
      orderSubmissionAllowed: false,
      branchWriteAllowed: false,
      productionMutationAllowed: false,
    }),
  });
}

export function compareExecutionStageParity(contexts = []) {
  if (!Array.isArray(contexts) || contexts.length < 2) throw new TypeError("at least two execution contexts are required");
  const invalid = contexts.filter((context) => !context || context.schemaVersion !== 2 || typeof context.parityFingerprint !== "string");
  if (invalid.length > 0) throw new TypeError("valid execution contexts are required");
  const blockedStages = contexts.filter((context) => context.status !== "READY").map((context) => context.stage);
  const reference = contexts[0].parityFingerprint;
  const mismatchedStages = contexts.filter((context) => context.parityFingerprint !== reference).map((context) => context.stage);
  return Object.freeze({
    status: blockedStages.length === 0 && mismatchedStages.length === 0 ? "READY" : "BLOCKED",
    parityFingerprint: mismatchedStages.length === 0 ? reference : null,
    blockedStages: Object.freeze(blockedStages),
    mismatchedStages: Object.freeze(mismatchedStages),
    backtestPaperShadowComparable: blockedStages.length === 0 && mismatchedStages.length === 0,
    livePromotionAllowed: false,
  });
}

function applyAdverseRate(price, side, rate) {
  return side === "BUY" ? price * (1 + rate) : price * (1 - rate);
}

function normalizeSide(direction) {
  return direction === "BUY" || direction === "LONG" ? "BUY" : "SELL";
}

function validateOrder(order, context) {
  if (!ORDER_TYPE_SET.has(order?.type)) throw new TypeError("supported simulated order type is required");
  if (!positive(order?.quantity)) throw new TypeError("positive simulated quantity is required");
  if (order?.direction !== context.direction) throw new Error("ORDER_DIRECTION_CONTEXT_MISMATCH");
  if (order.type === "LIMIT" && !positive(order.limitPrice)) throw new TypeError("limitPrice is required");
  if (order.type === "STOP_MARKET" && !positive(order.stopPrice)) throw new TypeError("stopPrice is required");
}

function barProxyBasePrice(order, side, bar) {
  if (!bar || !positive(bar.nextOpen)) return Object.freeze({ status: "BLOCKED", reason: "NEXT_OPEN_REQUIRED" });
  if (order.type === "MARKET") return Object.freeze({ status: "FILLED", price: bar.nextOpen });
  if (!positive(bar.high) || !positive(bar.low)) return Object.freeze({ status: "BLOCKED", reason: "BAR_HIGH_LOW_REQUIRED" });

  if (order.type === "LIMIT") {
    const touched = side === "BUY" ? bar.low <= order.limitPrice : bar.high >= order.limitPrice;
    if (!touched) return Object.freeze({ status: "PENDING", reason: "LIMIT_NOT_TOUCHED" });
    const price = side === "BUY" ? Math.min(bar.nextOpen, order.limitPrice) : Math.max(bar.nextOpen, order.limitPrice);
    return Object.freeze({ status: "FILLED", price });
  }

  const triggered = side === "BUY" ? bar.high >= order.stopPrice : bar.low <= order.stopPrice;
  if (!triggered) return Object.freeze({ status: "PENDING", reason: "STOP_NOT_TRIGGERED" });
  const price = side === "BUY" ? Math.max(bar.nextOpen, order.stopPrice) : Math.min(bar.nextOpen, order.stopPrice);
  return Object.freeze({ status: "FILLED", price });
}

function quoteBasePrice(order, side, quote) {
  if (!quote || !positive(quote.bid) || !positive(quote.ask) || quote.bid > quote.ask) {
    return Object.freeze({ status: "BLOCKED", reason: "VALID_QUOTE_REQUIRED" });
  }
  if (order.type === "MARKET") return Object.freeze({ status: "FILLED", price: side === "BUY" ? quote.ask : quote.bid });
  if (order.type === "LIMIT") {
    const executable = side === "BUY" ? quote.ask <= order.limitPrice : quote.bid >= order.limitPrice;
    if (!executable) return Object.freeze({ status: "PENDING", reason: "LIMIT_NOT_MARKETABLE" });
    return Object.freeze({ status: "FILLED", price: side === "BUY" ? Math.min(quote.ask, order.limitPrice) : Math.max(quote.bid, order.limitPrice) });
  }
  if (!positive(quote.last)) return Object.freeze({ status: "BLOCKED", reason: "LAST_PRICE_REQUIRED_FOR_STOP" });
  const triggered = side === "BUY" ? quote.last >= order.stopPrice : quote.last <= order.stopPrice;
  if (!triggered) return Object.freeze({ status: "PENDING", reason: "STOP_NOT_TRIGGERED" });
  return Object.freeze({ status: "FILLED", price: side === "BUY" ? Math.max(quote.ask, order.stopPrice) : Math.min(quote.bid, order.stopPrice) });
}

export function simulateFourMarketFill({ context, order, bar = null, quote = null, depth = null } = {}) {
  if (!context || context.schemaVersion !== 2) throw new TypeError("valid execution context is required");
  if (context.status !== "READY") {
    return Object.freeze({ status: "BLOCKED", reason: "EXECUTION_CONTEXT_NOT_READY", blockers: context.blockers, orderSubmitted: false });
  }
  validateOrder(order, context);

  const side = normalizeSide(context.direction);
  const fillModel = context.executionPolicy.fillModel;
  const base = fillModel === "BAR_PROXY" ? barProxyBasePrice(order, side, bar) : quoteBasePrice(order, side, quote);
  if (base.status !== "FILLED") return Object.freeze({ ...base, orderSubmitted: false, exchangeRequestSent: false });

  let filledQuantity = order.quantity;
  let partial = false;
  if (fillModel === "DEPTH_PARTICIPATION") {
    const available = side === "BUY" ? depth?.askSize : depth?.bidSize;
    if (!nonNegative(available)) return Object.freeze({ status: "BLOCKED", reason: "VALID_DEPTH_REQUIRED", orderSubmitted: false, exchangeRequestSent: false });
    const capacity = available * context.executionPolicy.maxParticipationRate;
    filledQuantity = Math.min(order.quantity, capacity);
    partial = filledQuantity + Number.EPSILON < order.quantity;
    if (filledQuantity <= 0) return Object.freeze({ status: "PENDING", reason: "NO_PARTICIPATION_CAPACITY", orderSubmitted: false, exchangeRequestSent: false });
    if (partial && context.executionPolicy.allowPartialFill !== true) {
      return Object.freeze({ status: "PENDING", reason: "PARTIAL_FILL_FORBIDDEN", orderSubmitted: false, exchangeRequestSent: false });
    }
  }

  const rates = context.costPolicy;
  const spreadAdjustment = fillModel === "BAR_PROXY" ? rates.spreadRate / 2 : 0;
  const adverseRate = order.type === "LIMIT" ? 0 : rates.slippageRate + rates.latencyRate + rates.liquidityImpactRate + spreadAdjustment;
  const fillPrice = applyAdverseRate(base.price, side, adverseRate);
  const notional = fillPrice * filledQuantity;
  const commission = notional * rates.commissionRate;
  const tax = side === "SELL" ? notional * rates.taxRate : 0;
  const partialFillImpact = partial ? notional * rates.partialFillImpactRate : 0;
  const immediateCost = commission + tax + partialFillImpact;

  return Object.freeze({
    status: partial ? "PARTIALLY_FILLED" : "FILLED",
    market: context.market,
    stage: context.stage,
    direction: context.direction,
    side,
    orderType: order.type,
    fillModel,
    requestedQuantity: order.quantity,
    filledQuantity,
    unfilledQuantity: order.quantity - filledQuantity,
    fillPrice,
    notional,
    costs: Object.freeze({
      commission,
      tax,
      partialFillImpact,
      immediateCost,
      fundingRatePerInterval: context.market === "CRYPTO_FUTURES" ? rates.fundingRate : 0,
    }),
    parityFingerprint: context.parityFingerprint,
    orderSubmitted: false,
    exchangeRequestSent: false,
    privateTradingRequestSent: false,
    liveExecution: false,
  });
}

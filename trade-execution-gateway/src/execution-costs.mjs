import { GatewayError } from "./gateway.mjs";

const BUY_LIKE = new Set(["BUY", "LONG"]);
const SELL_LIKE = new Set(["SELL", "SHORT"]);
const LIQUIDITY_ROLES = new Set(["MAKER", "TAKER"]);
const MAX_BPS = 10_000;
const MAX_FUNDING_EVENTS = 64;

function requireObject(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError(code, message);
  return value;
}

function requireText(value, name, max = 128) {
  if (typeof value !== "string") throw new GatewayError("INVALID_COST_EVIDENCE", `${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new GatewayError("INVALID_COST_EVIDENCE", `${name} is invalid`);
  return normalized;
}

function boundedBps(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > MAX_BPS) {
    throw new GatewayError("INVALID_COST_EVIDENCE", `${name} must be between 0 and 10000 bps`);
  }
  return number;
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new GatewayError("INVALID_EXECUTION_COST_INPUT", `${name} must be positive`);
  }
  return number;
}

function timestampMs(value, name) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new GatewayError("INVALID_COST_EVIDENCE", `${name} must be a valid timestamp`);
  }
  return parsed;
}

function normalizeFundingEvents(events, market) {
  if (events == null) return Object.freeze([]);
  if (!Array.isArray(events) || events.length > MAX_FUNDING_EVENTS) {
    throw new GatewayError("INVALID_COST_EVIDENCE", `fundingEvents must contain at most ${MAX_FUNDING_EVENTS} events`);
  }
  if (market !== "CRYPTO_FUTURES" && events.length > 0) {
    throw new GatewayError("FUNDING_NOT_ALLOWED", "funding events are allowed for CRYPTO_FUTURES only");
  }
  return Object.freeze(events.map((raw, index) => {
    requireObject(raw, "INVALID_COST_EVIDENCE", "funding event must be an object");
    const payerSide = requireText(raw.payerSide, "fundingEvent.payerSide", 16).toUpperCase();
    if (!new Set(["LONG", "SHORT"]).has(payerSide)) {
      throw new GatewayError("INVALID_COST_EVIDENCE", "fundingEvent.payerSide must be LONG or SHORT");
    }
    return Object.freeze({
      sequence: index + 1,
      rateBps: boundedBps(raw.rateBps, "fundingEvent.rateBps"),
      payerSide,
      effectiveAt: new Date(timestampMs(raw.effectiveAt, "fundingEvent.effectiveAt")).toISOString(),
      source: requireText(raw.source, "fundingEvent.source", 96),
      serverAttested: raw.serverAttested === true,
      actualPrivateAccountEvidence: false,
    });
  }));
}

export function normalizeExecutionCostSchedule(schedule, context = {}) {
  requireObject(schedule, "COST_SCHEDULE_REQUIRED", "explicit execution cost schedule is required");
  const market = requireText(schedule.market, "market", 32).toUpperCase();
  const expectedMarket = context.market == null ? null : String(context.market).trim().toUpperCase();
  if (expectedMarket && market !== expectedMarket) {
    throw new GatewayError("COST_EVIDENCE_IDENTITY_MISMATCH", "cost schedule market must match execution market");
  }

  const provider = schedule.provider == null ? null : requireText(schedule.provider, "provider", 64).toLowerCase();
  const expectedProvider = context.provider == null ? null : String(context.provider).trim().toLowerCase();
  if (expectedProvider && provider !== expectedProvider) {
    throw new GatewayError("COST_EVIDENCE_IDENTITY_MISMATCH", "cost schedule provider must match execution provider");
  }

  const symbol = schedule.symbol == null ? null : requireText(schedule.symbol, "symbol", 64).toUpperCase();
  const expectedSymbol = context.symbol == null ? null : String(context.symbol).trim().toUpperCase();
  if (expectedSymbol && symbol !== expectedSymbol) {
    throw new GatewayError("COST_EVIDENCE_IDENTITY_MISMATCH", "cost schedule symbol must match execution symbol");
  }

  const effectiveFromMs = timestampMs(schedule.effectiveFrom, "effectiveFrom");
  const effectiveToMs = timestampMs(schedule.effectiveTo, "effectiveTo");
  if (effectiveToMs < effectiveFromMs) {
    throw new GatewayError("INVALID_COST_EVIDENCE", "effectiveTo must not precede effectiveFrom");
  }
  const atMs = context.atMs == null ? Date.now() : timestampMs(context.atMs, "executionAt");
  if (atMs < effectiveFromMs || atMs > effectiveToMs) {
    throw new GatewayError("COST_EVIDENCE_NOT_EFFECTIVE", "cost schedule is not effective for the execution timestamp");
  }

  const rates = requireObject(schedule.rates, "COST_SCHEDULE_REQUIRED", "cost schedule rates are required");
  return Object.freeze({
    evidenceVersion: "EXECUTION_COST_SCHEDULE_V1",
    authority: "CALLER_SUPPLIED_COST_EVIDENCE",
    source: requireText(schedule.source, "source", 128),
    scheduleVersion: requireText(schedule.scheduleVersion, "scheduleVersion", 64),
    market,
    provider,
    symbol,
    currency: requireText(schedule.currency, "currency", 16).toUpperCase(),
    effectiveFrom: new Date(effectiveFromMs).toISOString(),
    effectiveTo: new Date(effectiveToMs).toISOString(),
    rates: Object.freeze({
      makerFeeBps: boundedBps(rates.makerFeeBps, "makerFeeBps"),
      takerFeeBps: boundedBps(rates.takerFeeBps, "takerFeeBps"),
      buyTaxBps: boundedBps(rates.buyTaxBps, "buyTaxBps"),
      sellTaxBps: boundedBps(rates.sellTaxBps, "sellTaxBps"),
      fxConversionBps: boundedBps(rates.fxConversionBps, "fxConversionBps"),
    }),
    hardCodedProviderRates: false,
    actualBrokerChargeEvidence: false,
    privateApiUsed: false,
    serverAttested: false,
  });
}

export function estimateExecutionCosts({
  market,
  provider = null,
  symbol = null,
  side,
  liquidityRole,
  quantity,
  price,
  executionAt,
  schedule,
  fundingEvents = [],
}) {
  const normalizedMarket = requireText(market, "market", 32).toUpperCase();
  const normalizedSide = requireText(side, "side", 16).toUpperCase();
  if (!BUY_LIKE.has(normalizedSide) && !SELL_LIKE.has(normalizedSide)) {
    throw new GatewayError("INVALID_EXECUTION_COST_INPUT", "side must be BUY/SELL/LONG/SHORT");
  }
  const role = requireText(liquidityRole, "liquidityRole", 16).toUpperCase();
  if (!LIQUIDITY_ROLES.has(role)) {
    throw new GatewayError("INVALID_EXECUTION_COST_INPUT", "liquidityRole must be MAKER or TAKER");
  }

  const qty = positive(quantity, "quantity");
  const px = positive(price, "price");
  const notional = qty * px;
  const normalizedSchedule = normalizeExecutionCostSchedule(schedule, {
    market: normalizedMarket,
    provider,
    symbol,
    atMs: executionAt,
  });
  const normalizedFunding = normalizeFundingEvents(fundingEvents, normalizedMarket);

  const feeRateBps = role === "MAKER" ? normalizedSchedule.rates.makerFeeBps : normalizedSchedule.rates.takerFeeBps;
  const taxRateBps = BUY_LIKE.has(normalizedSide) ? normalizedSchedule.rates.buyTaxBps : normalizedSchedule.rates.sellTaxBps;
  const estimatedTradingFee = notional * feeRateBps / 10_000;
  const estimatedTax = notional * taxRateBps / 10_000;
  const estimatedFxConversionCost = notional * normalizedSchedule.rates.fxConversionBps / 10_000;

  let estimatedFundingCost = 0;
  if (normalizedMarket === "CRYPTO_FUTURES") {
    if (!new Set(["LONG", "SHORT"]).has(normalizedSide)) {
      throw new GatewayError("INVALID_EXECUTION_COST_INPUT", "CRYPTO_FUTURES cost estimate requires LONG or SHORT side");
    }
    for (const event of normalizedFunding) {
      const signedDirection = event.payerSide === normalizedSide ? 1 : -1;
      estimatedFundingCost += notional * event.rateBps / 10_000 * signedDirection;
    }
  }

  const estimatedTotalCost = estimatedTradingFee + estimatedTax + estimatedFxConversionCost + estimatedFundingCost;
  return Object.freeze({
    costVersion: "EXECUTION_COST_ESTIMATE_V1",
    authority: "READ_ONLY_PAPER_COST_ESTIMATE",
    market: normalizedMarket,
    provider: provider == null ? null : String(provider).trim().toLowerCase(),
    symbol: symbol == null ? null : String(symbol).trim().toUpperCase(),
    side: normalizedSide,
    liquidityRole: role,
    quantity: qty,
    price: px,
    notional,
    currency: normalizedSchedule.currency,
    components: Object.freeze({
      estimatedTradingFee,
      estimatedTax,
      estimatedFxConversionCost,
      estimatedFundingCost,
    }),
    rates: normalizedSchedule.rates,
    fundingEvents: normalizedFunding,
    estimatedTotalCost,
    estimatedTotalCostBps: estimatedTotalCost / notional * 10_000,
    costSchedule: normalizedSchedule,
    hardCodedProviderRates: false,
    actualBrokerChargeEvidence: false,
    executionAuthority: "NONE",
    liveOrderSubmitted: false,
    privateApiUsed: false,
  });
}

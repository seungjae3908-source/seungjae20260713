const FOREIGN_QUOTE_CURRENCY = Object.freeze({
  US_STOCK: "USD",
  CRYPTO_FUTURES: "USDT",
});

export const KRW_VALUATION_V11_CONTRACT = Object.freeze({
  version: "V1_1",
  schemaVersion: 1,
  source: "CALLER_SUPPLIED_PUBLIC_REFERENCE",
  valuationCurrency: "KRW",
  maxEvidenceAgeMs: 300_000,
  maxFutureSkewMs: 1_000,
  supportedForeignMarkets: Object.freeze(Object.keys(FOREIGN_QUOTE_CURRENCY)),
  directKrwMarketsUnchanged: Object.freeze(["KR_STOCK", "CRYPTO_SPOT:UPBIT:KRW-*"]),
  brokerNetworkReadPerformed: false,
  privateProviderRequestPerformed: false,
  realAccountReadPerformed: false,
  executionAuthority: "NONE",
  liveActivationAllowed: false,
});

export class KrwValuationEvidenceError extends Error {
  constructor(code, message, statusCode = 503) {
    super(message);
    this.name = "KrwValuationEvidenceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function object(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KrwValuationEvidenceError(code, message);
  }
  return value;
}

function text(value, code, message, max = 128) {
  if (typeof value !== "string") throw new KrwValuationEvidenceError(code, message);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new KrwValuationEvidenceError(code, message);
  return normalized;
}

function positive(value, code, message) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new KrwValuationEvidenceError(code, message);
  return number;
}

function timestamp(value, code, message) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw new KrwValuationEvidenceError(code, message);
  return parsed;
}

function expectedQuoteCurrency(market) {
  return FOREIGN_QUOTE_CURRENCY[market] ?? null;
}

export function isForeignKrwValuationMarket(marketValue) {
  return expectedQuoteCurrency(String(marketValue ?? "").trim().toUpperCase()) != null;
}

export function normalizeCapitalValuationEvidence(evidence, intent, options = {}) {
  if (evidence == null) return null;
  object(intent, "CAPITAL_KRW_VALUATION_INTENT_INVALID", "valuation intent is required");
  object(evidence, "CAPITAL_KRW_VALUATION_SCHEMA_INVALID", "KRW valuation evidence must be an object");

  const market = text(intent.market, "CAPITAL_KRW_VALUATION_INTENT_INVALID", "intent market is required", 32).toUpperCase();
  const expectedQuote = expectedQuoteCurrency(market);
  if (!expectedQuote) {
    throw new KrwValuationEvidenceError(
      "CAPITAL_KRW_VALUATION_MARKET_UNSUPPORTED",
      `${market} does not accept foreign-currency KRW valuation evidence`,
      400,
    );
  }
  const symbol = text(intent.symbol, "CAPITAL_KRW_VALUATION_INTENT_INVALID", "intent symbol is required", 64).toUpperCase();

  if (evidence.schemaVersion !== KRW_VALUATION_V11_CONTRACT.schemaVersion) {
    throw new KrwValuationEvidenceError("CAPITAL_KRW_VALUATION_SCHEMA_INVALID", "unsupported KRW valuation evidence schema");
  }
  const source = text(evidence.source, "CAPITAL_KRW_VALUATION_SOURCE_INVALID", "valuation source is required", 64).toUpperCase();
  if (source !== KRW_VALUATION_V11_CONTRACT.source) {
    throw new KrwValuationEvidenceError("CAPITAL_KRW_VALUATION_SOURCE_INVALID", "only caller-supplied public reference evidence is accepted");
  }
  if (
    evidence.publicData !== true
    || evidence.privateApiUsed !== false
    || evidence.realAccountData !== false
    || evidence.realOrderData === true
    || evidence.liveTrading === true
    || evidence.executionAuthority === true
  ) {
    throw new KrwValuationEvidenceError(
      "CAPITAL_KRW_VALUATION_UNSAFE_EVIDENCE",
      "valuation evidence must be public-reference only and must not claim private/live/order authority",
      403,
    );
  }

  const evidenceMarket = text(evidence.market, "CAPITAL_KRW_VALUATION_MARKET_MISMATCH", "valuation market is required", 32).toUpperCase();
  if (evidenceMarket !== market) {
    throw new KrwValuationEvidenceError("CAPITAL_KRW_VALUATION_MARKET_MISMATCH", "valuation market does not match order intent");
  }
  const evidenceSymbol = text(evidence.symbol, "CAPITAL_KRW_VALUATION_SYMBOL_MISMATCH", "valuation symbol is required", 64).toUpperCase();
  if (evidenceSymbol !== symbol) {
    throw new KrwValuationEvidenceError("CAPITAL_KRW_VALUATION_SYMBOL_MISMATCH", "valuation symbol does not match order intent");
  }

  const quoteCurrency = text(evidence.quoteCurrency, "CAPITAL_KRW_VALUATION_QUOTE_CURRENCY_MISMATCH", "quoteCurrency is required", 16).toUpperCase();
  if (quoteCurrency !== expectedQuote) {
    throw new KrwValuationEvidenceError(
      "CAPITAL_KRW_VALUATION_QUOTE_CURRENCY_MISMATCH",
      `${market} requires ${expectedQuote}/KRW valuation evidence`,
    );
  }
  const valuationCurrency = text(evidence.valuationCurrency, "CAPITAL_KRW_VALUATION_CURRENCY_MISMATCH", "valuationCurrency is required", 16).toUpperCase();
  if (valuationCurrency !== "KRW") {
    throw new KrwValuationEvidenceError("CAPITAL_KRW_VALUATION_CURRENCY_MISMATCH", "valuationCurrency must be KRW");
  }

  const krwPerQuote = positive(
    evidence.krwPerQuote,
    "CAPITAL_KRW_VALUATION_RATE_INVALID",
    "krwPerQuote must be a positive finite rate",
  );
  const evidenceId = text(evidence.evidenceId, "CAPITAL_KRW_VALUATION_EVIDENCE_ID_INVALID", "evidenceId is required", 128);
  if (evidenceId.length < 8 || !/^[A-Za-z0-9._:-]+$/.test(evidenceId)) {
    throw new KrwValuationEvidenceError(
      "CAPITAL_KRW_VALUATION_EVIDENCE_ID_INVALID",
      "evidenceId must be 8-128 safe characters",
      400,
    );
  }

  const observedMs = timestamp(
    evidence.observedAt,
    "CAPITAL_KRW_VALUATION_TIMESTAMP_INVALID",
    "valuation observedAt is invalid",
  );
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  if (observedMs > nowMs + KRW_VALUATION_V11_CONTRACT.maxFutureSkewMs) {
    throw new KrwValuationEvidenceError("CAPITAL_KRW_VALUATION_FROM_FUTURE", "valuation evidence is from the future");
  }
  if (nowMs - observedMs > KRW_VALUATION_V11_CONTRACT.maxEvidenceAgeMs) {
    throw new KrwValuationEvidenceError("CAPITAL_KRW_VALUATION_STALE", "valuation evidence is stale");
  }

  return Object.freeze({
    schemaVersion: 1,
    source: KRW_VALUATION_V11_CONTRACT.source,
    evidenceId,
    market,
    symbol,
    quoteCurrency,
    valuationCurrency: "KRW",
    krwPerQuote,
    observedAt: new Date(observedMs).toISOString(),
    publicData: true,
    privateApiUsed: false,
    realAccountData: false,
    brokerNetworkReadPerformed: false,
    privateProviderRequestPerformed: false,
    realAccountReadPerformed: false,
    executionAuthority: "NONE",
  });
}

export function valueForeignQuoteNotionalKrw({ intent, quoteNotional, evidence, nowMs = Date.now() } = {}) {
  const normalized = normalizeCapitalValuationEvidence(evidence, intent, { nowMs });
  if (!normalized) {
    throw new KrwValuationEvidenceError(
      "CAPITAL_KRW_VALUATION_REQUIRED",
      `${String(intent?.market ?? "UNKNOWN")} new exposure requires fresh authoritative KRW valuation evidence`,
    );
  }
  const notional = positive(
    quoteNotional,
    "CAPITAL_KRW_VALUATION_NOTIONAL_INVALID",
    "foreign quote notional must be positive",
  );
  const rawKrw = notional * normalized.krwPerQuote;
  if (!Number.isFinite(rawKrw) || rawKrw <= 0) {
    throw new KrwValuationEvidenceError("CAPITAL_KRW_VALUATION_NOTIONAL_INVALID", "converted KRW notional is invalid");
  }
  const krwNotional = Math.ceil(rawKrw);
  if (!Number.isSafeInteger(krwNotional)) {
    throw new KrwValuationEvidenceError("CAPITAL_KRW_VALUATION_OVERFLOW", "converted KRW notional exceeds safe integer bounds");
  }
  return Object.freeze({
    krwNotional,
    quoteNotional: notional,
    quoteCurrency: normalized.quoteCurrency,
    krwPerQuote: normalized.krwPerQuote,
    valuationEvidence: normalized,
    executionAuthority: "NONE",
    privateProviderRequestPerformed: false,
    realOrderSubmitted: false,
  });
}

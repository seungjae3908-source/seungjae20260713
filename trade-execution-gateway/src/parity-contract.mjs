import { GatewayError } from "./gateway.mjs";
import { MARKETS, ORDER_STATES, ORDER_TYPES, sidesForMarket } from "./contracts.mjs";

const CANONICAL_PROVIDER = Object.freeze({
  KR_STOCK: "toss",
  US_STOCK: "toss",
  CRYPTO_SPOT: "upbit",
  CRYPTO_FUTURES: "bitget",
});
const REQUIRED_INTENT_FIELDS = Object.freeze(["market", "symbol", "side", "orderType", "quantity", "idempotencyKey"]);
const REQUIRED_FEATURES = Object.freeze([
  "idempotency", "strictPrecision", "partialFills", "cancel", "replace",
  "riskRevalidation", "costEvidence", "reconciliation",
]);

function requireObject(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError(code, message);
  return value;
}

function normalizeStrings(values, name) {
  if (!Array.isArray(values)) throw new GatewayError("INVALID_PARITY_CANDIDATE", `${name} must be an array`);
  return new Set(values.map((value) => String(value).trim().toUpperCase()).filter(Boolean));
}

function missingItems(required, actual) {
  return required.filter((item) => !actual.has(String(item).toUpperCase()));
}

export function comparePaperLiveParity({ market, provider, candidate }) {
  const normalizedMarket = String(market ?? "").trim().toUpperCase();
  if (!MARKETS.includes(normalizedMarket)) {
    throw new GatewayError("UNSUPPORTED_PARITY_MARKET", "parity market is unsupported");
  }
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  if (!normalizedProvider) throw new GatewayError("PARITY_PROVIDER_REQUIRED", "provider is required");
  if (CANONICAL_PROVIDER[normalizedMarket] !== normalizedProvider) {
    throw new GatewayError("PARITY_PROVIDER_MISMATCH", `${normalizedMarket} canonical parity provider is ${CANONICAL_PROVIDER[normalizedMarket]}`);
  }

  requireObject(candidate, "PARITY_CANDIDATE_REQUIRED", "disabled live-candidate contract is required");
  if (String(candidate.runtimeStatus ?? "").trim().toUpperCase() !== "DISABLED") {
    throw new GatewayError("UNSAFE_LIVE_PARITY_CANDIDATE", "v0.6 parity inspection requires runtimeStatus=DISABLED");
  }
  if (
    candidate.privateTradingApiEnabled === true ||
    candidate.orderSubmissionEnabled === true ||
    candidate.cancelEnabled === true ||
    candidate.amendEnabled === true
  ) {
    throw new GatewayError("UNSAFE_LIVE_PARITY_CANDIDATE", "v0.6 parity inspection accepts disabled live candidates only");
  }

  const gaps = [];
  const intentFields = normalizeStrings(candidate.intentFields, "intentFields");
  for (const field of missingItems(REQUIRED_INTENT_FIELDS, intentFields)) gaps.push(`MISSING_INTENT_FIELD:${field}`);

  const orderTypes = normalizeStrings(candidate.orderTypes, "orderTypes");
  for (const value of missingItems(ORDER_TYPES, orderTypes)) gaps.push(`MISSING_ORDER_TYPE:${value}`);

  const sides = normalizeStrings(candidate.sides, "sides");
  for (const value of missingItems(sidesForMarket(normalizedMarket), sides)) gaps.push(`MISSING_SIDE:${value}`);

  const states = normalizeStrings(candidate.orderStates, "orderStates");
  for (const value of missingItems(Object.values(ORDER_STATES), states)) gaps.push(`MISSING_ORDER_STATE:${value}`);

  const features = requireObject(candidate.features, "INVALID_PARITY_CANDIDATE", "candidate.features is required");
  for (const feature of REQUIRED_FEATURES) {
    if (features[feature] !== true) gaps.push(`MISSING_FEATURE:${feature}`);
  }
  if (normalizedMarket === "CRYPTO_FUTURES" && features.reduceOnly !== true) {
    gaps.push("MISSING_FEATURE:reduceOnly");
  }

  return Object.freeze({
    parityVersion: "PAPER_LIVE_CONTRACT_PARITY_V1",
    market: normalizedMarket,
    provider: normalizedProvider,
    parityState: gaps.length === 0 ? "CONTRACT_MATCH_DISABLED" : "GAPS_FOUND",
    gaps: Object.freeze(gaps),
    required: Object.freeze({
      intentFields: REQUIRED_INTENT_FIELDS,
      orderTypes: ORDER_TYPES,
      sides: sidesForMarket(normalizedMarket),
      orderStates: Object.values(ORDER_STATES),
      features: Object.freeze([...REQUIRED_FEATURES, ...(normalizedMarket === "CRYPTO_FUTURES" ? ["reduceOnly"] : [])]),
    }),
    candidateStatus: "DISABLED_READ_ONLY_INSPECTION",
    activationAllowed: false,
    executionAuthority: "NONE",
    liveOrderSubmitted: false,
    privateApiUsed: false,
    actualPaperLiveRuntimeParityProven: false,
  });
}

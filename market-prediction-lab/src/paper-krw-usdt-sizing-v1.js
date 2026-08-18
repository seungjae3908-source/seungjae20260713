const UPBIT_BASE_URL = "https://api.upbit.com";
const FX_MAX_AGE_MS = 15 * 60 * 1000;
const KRW_EVIDENCE_DECIMALS = 6;

export const PAPER_KRW_USDT_SIZING_CONTRACT = Object.freeze({
  version: "paper-krw-usdt-sizing-v1",
  initialCapitalKrw: 1_000_000,
  riskFractionPerTrade: 0.01,
  fxSource: "upbit-public-cross-krw-btc-usdt-btc",
  fxMaxAgeMs: FX_MAX_AGE_MS,
  leverage: 1,
  krwEvidenceDecimals: KRW_EVIDENCE_DECIMALS,
  privateApi: false,
  liveTrading: false,
  profitabilityClaimAllowed: false,
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function number(value, code) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function canonicalKrwEvidence(value) {
  if (!finite(value)) throw new Error("PAPER_SIZING_KRW_EVIDENCE_INVALID");
  const normalized = Number(value.toFixed(KRW_EVIDENCE_DECIMALS));
  if (!finite(normalized)) throw new Error("PAPER_SIZING_KRW_EVIDENCE_INVALID");
  return Object.is(normalized, -0) ? 0 : normalized;
}

function rowFor(rows, market) {
  const row = rows.find((item) => item?.market === market);
  if (!row) throw new Error(`PAPER_FX_${market.replace(/-/gu, "_")}_MISSING`);
  return row;
}

export async function loadUpbitPublicKrwPerUsdt({
  fetchImpl = fetch,
  nowMs = Date.now(),
  maxAgeMs = FX_MAX_AGE_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isInteger(nowMs) || nowMs <= 0 || !Number.isInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new TypeError("positive integer nowMs and maxAgeMs are required");
  }
  const markets = "KRW-BTC,USDT-BTC";
  const response = await fetchImpl(`${UPBIT_BASE_URL}/v1/ticker?markets=${encodeURIComponent(markets)}`, {
    headers: { accept: "application/json", "user-agent": "seungjae-prediction-lab/1.0" },
  });
  if (!response?.ok) {
    throw Object.assign(new Error(`PAPER_FX_UPBIT_HTTP_${response?.status ?? "UNKNOWN"}`), { status: response?.status });
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("PAPER_FX_UPBIT_INVALID_RESPONSE");
  const krwBtc = rowFor(rows, "KRW-BTC");
  const usdtBtc = rowFor(rows, "USDT-BTC");
  const krwPerBtc = number(krwBtc.trade_price, "PAPER_FX_KRW_BTC_PRICE_INVALID");
  const usdtPerBtc = number(usdtBtc.trade_price, "PAPER_FX_USDT_BTC_PRICE_INVALID");
  const krwTradeAtMs = number(krwBtc.trade_timestamp, "PAPER_FX_KRW_BTC_TIMESTAMP_INVALID");
  const usdtTradeAtMs = number(usdtBtc.trade_timestamp, "PAPER_FX_USDT_BTC_TIMESTAMP_INVALID");
  if (!positive(krwPerBtc) || !positive(usdtPerBtc)) throw new Error("PAPER_FX_CROSS_PRICE_INVALID");
  for (const atMs of [krwTradeAtMs, usdtTradeAtMs]) {
    if (atMs > nowMs) throw new Error("PAPER_FX_FUTURE_EVIDENCE_FORBIDDEN");
    if (nowMs - atMs > maxAgeMs) throw new Error("PAPER_FX_STALE_EVIDENCE_FORBIDDEN");
  }
  const krwPerUsdt = krwPerBtc / usdtPerBtc;
  if (!positive(krwPerUsdt)) throw new Error("PAPER_FX_KRW_PER_USDT_INVALID");
  return Object.freeze({
    status: "READY",
    krwPerUsdt,
    asOfMs: Math.min(krwTradeAtMs, usdtTradeAtMs),
    maxAgeMs,
    source: PAPER_KRW_USDT_SIZING_CONTRACT.fxSource,
    markets: Object.freeze(["KRW-BTC", "USDT-BTC"]),
    krwPerBtc,
    usdtPerBtc,
    publicOnly: true,
    privateRequestCount: 0,
  });
}

function floorToStep(value, step) {
  if (!positive(value) || !positive(step)) throw new Error("PAPER_SIZING_STEP_INPUT_INVALID");
  const units = Math.floor((value + Number.EPSILON) / step);
  return units * step;
}

export function sizeOnePercentRiskKrwFuturesPosition({
  entryPrice,
  stopPrice,
  krwPerUsdt,
  qtyStep,
  minQty,
  minNotionalUsdt,
  maxMarketQty,
  initialCapitalKrw = PAPER_KRW_USDT_SIZING_CONTRACT.initialCapitalKrw,
  riskFraction = PAPER_KRW_USDT_SIZING_CONTRACT.riskFractionPerTrade,
} = {}) {
  const values = { entryPrice, stopPrice, krwPerUsdt, qtyStep, minQty, minNotionalUsdt, maxMarketQty, initialCapitalKrw, riskFraction };
  if (Object.values(values).some((value) => !finite(value))) throw new Error("PAPER_SIZING_FINITE_VALUES_REQUIRED");
  if (![entryPrice, krwPerUsdt, qtyStep, minQty, initialCapitalKrw, riskFraction].every(positive)
    || stopPrice <= 0 || stopPrice >= entryPrice || minNotionalUsdt < 0 || maxMarketQty <= 0 || riskFraction > 1) {
    throw new Error("PAPER_SIZING_INPUT_INVALID");
  }
  const riskBudgetKrw = initialCapitalKrw * riskFraction;
  const stopDistanceUsdt = entryPrice - stopPrice;
  const riskBoundQty = riskBudgetKrw / (stopDistanceUsdt * krwPerUsdt);
  const capitalBoundQty = initialCapitalKrw / (entryPrice * krwPerUsdt);
  const rawQuantity = Math.min(riskBoundQty, capitalBoundQty, maxMarketQty);
  const quantity = floorToStep(rawQuantity, qtyStep);
  if (!positive(quantity) || quantity + Number.EPSILON < minQty) throw new Error("PAPER_SIZING_BELOW_MIN_QTY");
  const entryNotionalUsdt = quantity * entryPrice;
  if (entryNotionalUsdt + Number.EPSILON < minNotionalUsdt) throw new Error("PAPER_SIZING_BELOW_MIN_NOTIONAL");
  const entryNotionalKrwRaw = entryNotionalUsdt * krwPerUsdt;
  const stopRiskKrwRaw = quantity * stopDistanceUsdt * krwPerUsdt;
  const tolerance = Math.max(1e-6, initialCapitalKrw * 1e-12);
  if (entryNotionalKrwRaw > initialCapitalKrw + tolerance) throw new Error("PAPER_SIZING_CAPITAL_LIMIT_EXCEEDED");
  if (stopRiskKrwRaw > riskBudgetKrw + tolerance) throw new Error("PAPER_SIZING_RISK_LIMIT_EXCEEDED");
  return Object.freeze({
    quantity,
    initialCapitalKrw: canonicalKrwEvidence(initialCapitalKrw),
    riskFraction,
    riskBudgetKrw: canonicalKrwEvidence(riskBudgetKrw),
    stopDistanceUsdt,
    entryNotionalUsdt,
    entryNotionalKrw: canonicalKrwEvidence(entryNotionalKrwRaw),
    stopRiskKrw: canonicalKrwEvidence(stopRiskKrwRaw),
    krwPerUsdt,
    leverage: 1,
  });
}

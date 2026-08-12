import { V7_FAMILY, calculateV7Signal } from "./v7-vwap-mean-reversion.js";
import { V8_FAMILY, calculateV8Signal, validExchangeSessionMeta } from "./v8-opening-range-retest.js";
import { V9_FAMILY, calculateV9Signal } from "./v9-relative-strength.js";
import { V10_FAMILY, calculateV10Signal, normalizeDerivativesContext } from "./v10-derivatives-positioning.js";
import { assertSpecializedMarket, assertSpecializedSide } from "./market-specialized-alpha-contract.js";

export const MARKET_SPECIALIZED_FAMILIES = Object.freeze({
  V7: Object.freeze({ family: V7_FAMILY, role: "independent_entry", primaryInformation: "rolling_vwap_atr_stretch_reclaim", supportedMarkets: Object.freeze(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]), preferredStyles: Object.freeze(["scalping"]) }),
  V8: Object.freeze({ family: V8_FAMILY, role: "independent_entry", primaryInformation: "exchange_local_session_structure", supportedMarkets: Object.freeze(["KR_STOCK", "US_STOCK"]), preferredStyles: Object.freeze(["scalping"]) }),
  V9: Object.freeze({ family: V9_FAMILY, role: "independent_entry_or_filter", primaryInformation: "asset_vs_benchmark_relative_return", supportedMarkets: Object.freeze(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]), preferredStyles: Object.freeze(["swing"]) }),
  V10: Object.freeze({ family: V10_FAMILY, role: "independent_entry_or_filter", primaryInformation: "price_open_interest_funding_basis", supportedMarkets: Object.freeze(["CRYPTO_FUTURES"]), preferredStyles: Object.freeze(["scalping", "swing"]) }),
});

export const MARKET_RESEARCH_LANES = Object.freeze({
  KR_STOCK_SCALPING: Object.freeze({ market: "KR_STOCK", style: "scalping", direction: "LONG", candidateFamilies: Object.freeze(["V2", "V3", "V4", "V5", "V6", "V7", "V8"]) }),
  KR_STOCK_SWING: Object.freeze({ market: "KR_STOCK", style: "swing", direction: "LONG", candidateFamilies: Object.freeze(["V2", "V4", "V5", "V6", "V9"]) }),
  US_STOCK_SCALPING: Object.freeze({ market: "US_STOCK", style: "scalping", direction: "LONG", candidateFamilies: Object.freeze(["V2", "V3", "V4", "V5", "V6", "V7", "V8"]) }),
  US_STOCK_SWING: Object.freeze({ market: "US_STOCK", style: "swing", direction: "LONG", candidateFamilies: Object.freeze(["V2", "V4", "V5", "V6", "V9"]) }),
  CRYPTO_SPOT_SCALPING: Object.freeze({ market: "CRYPTO_SPOT", style: "scalping", direction: "LONG", candidateFamilies: Object.freeze(["V2", "V3", "V4", "V5", "V6", "V7"]) }),
  CRYPTO_SPOT_SWING: Object.freeze({ market: "CRYPTO_SPOT", style: "swing", direction: "LONG", candidateFamilies: Object.freeze(["V2", "V4", "V5", "V6", "V9"]) }),
  BINANCE_FUTURES_SCALPING_LONG: Object.freeze({ market: "CRYPTO_FUTURES", style: "scalping", direction: "LONG", candidateFamilies: Object.freeze(["V2", "V3", "V4", "V5", "V6", "V7", "V10"]) }),
  BINANCE_FUTURES_SCALPING_SHORT: Object.freeze({ market: "CRYPTO_FUTURES", style: "scalping", direction: "SHORT", candidateFamilies: Object.freeze(["V2", "V3", "V4", "V5", "V6", "V7", "V10"]) }),
  BINANCE_FUTURES_SWING_LONG: Object.freeze({ market: "CRYPTO_FUTURES", style: "swing", direction: "LONG", candidateFamilies: Object.freeze(["V2", "V4", "V5", "V6", "V10"]) }),
  BINANCE_FUTURES_SWING_SHORT: Object.freeze({ market: "CRYPTO_FUTURES", style: "swing", direction: "SHORT", candidateFamilies: Object.freeze(["V2", "V4", "V5", "V6", "V10"]) }),
});

export function calculateMarketSpecializedSignal({ version, market, side = "long", candles, atr, index, filter, benchmarkCandles, derivatives } = {}) {
  if (version === "V7") return calculateV7Signal({ market, side, candles, atr, index, filter });
  if (version === "V8") return calculateV8Signal({ market, side, candles, atr, index, filter });
  if (version === "V9") return calculateV9Signal({ market, side, candles, index, benchmarkCandles, filter });
  if (version === "V10") return calculateV10Signal({ market, side, candles, index, derivatives, filter });
  throw new TypeError(`unsupported market-specialized version: ${version}`);
}

export function familyReadiness({ version, market, side = "long", timeframe, sampleCandle, benchmarkCandles, derivatives } = {}) {
  assertSpecializedMarket(market);
  assertSpecializedSide(side);
  const family = MARKET_SPECIALIZED_FAMILIES[version];
  if (!family) throw new TypeError(`unsupported market-specialized version: ${version}`);
  const reasons = [];
  if (!family.supportedMarkets.includes(market)) reasons.push("market_not_supported");
  if (market !== "CRYPTO_FUTURES" && side === "short") reasons.push("cash_short_not_allowed");
  if (version === "V7" && timeframe === "1d") reasons.push("subdaily_timeframe_required");
  if (version === "V8" && !validExchangeSessionMeta(sampleCandle)) reasons.push("exchange_local_session_metadata_required");
  if (version === "V8" && timeframe === "1d") reasons.push("intraday_timeframe_required");
  if (version === "V9" && (!Array.isArray(benchmarkCandles) || benchmarkCandles.length === 0)) reasons.push("benchmark_history_required");
  if (version === "V10" && !normalizeDerivativesContext(derivatives)) reasons.push("same_venue_fresh_oi_funding_basis_required");
  return Object.freeze({
    version,
    family: family.family,
    ready: reasons.length === 0,
    reasons: Object.freeze(reasons),
    finalHoldoutSelectionAllowed: false,
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
    orderSubmitted: false,
    syntheticResearchDataAllowed: false,
  });
}

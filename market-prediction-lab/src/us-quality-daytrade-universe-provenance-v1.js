import { PredictionInputError } from "./contracts.js";

export const QUALITY_DAYTRADE_UNIVERSE_PROVENANCE_CONTRACT_VERSION = "us-quality-daytrade-universe-provenance-v2";

function safeResult(fields) {
  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_UNIVERSE_PROVENANCE_CONTRACT_VERSION,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...fields,
  });
}

function positiveEvidenceNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sourceId(raw) {
  const value = String(raw?.sourceId ?? raw?.source ?? "").trim();
  return value || null;
}

function normalizedSymbol(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizedToken(value) {
  return String(value ?? "").trim().toUpperCase();
}

function publicPointInTimeBlock(raw, prefix) {
  if (!sourceId(raw)) return `${prefix}_SOURCE_REQUIRED`;
  if (raw.pointInTime !== true) return `${prefix}_POINT_IN_TIME_UNPROVEN`;
  if (raw.publicReadOnly !== true || raw.privateApiUsed === true) return `${prefix}_PUBLIC_READ_ONLY_REQUIRED`;
  return null;
}

function listingEvidenceBlock(raw, instrument, asOfMs) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "LISTING_PROVENANCE_REQUIRED";
  const commonBlock = publicPointInTimeBlock(raw, "LISTING");
  if (commonBlock) return commonBlock;

  const symbol = normalizedSymbol(raw.symbol);
  if (!symbol) return "LISTING_SYMBOL_REQUIRED";
  if (symbol !== instrument.symbol) return "LISTING_SYMBOL_MISMATCH";

  const exchange = normalizedToken(raw.exchange);
  if (!exchange) return "LISTING_EXCHANGE_REQUIRED";
  if (exchange !== instrument.exchange) return "LISTING_EXCHANGE_MISMATCH";

  const securityType = normalizedToken(raw.securityType);
  if (!securityType) return "LISTING_SECURITY_TYPE_REQUIRED";
  if (securityType !== instrument.securityType) return "LISTING_SECURITY_TYPE_MISMATCH";

  const observedAtMs = positiveEvidenceNumber(raw.observedAtMs);
  if (observedAtMs == null) return "LISTING_OBSERVED_AT_REQUIRED";
  if (observedAtMs > asOfMs) return "LISTING_EVIDENCE_FROM_FUTURE";

  const validFromMs = positiveEvidenceNumber(raw.validFromMs);
  const validToMs = positiveEvidenceNumber(raw.validToMs);
  if (validFromMs == null || validToMs == null) return "LISTING_COVERAGE_REQUIRED";
  if (validToMs < validFromMs || validFromMs > asOfMs || validToMs < asOfMs) return "LISTING_COVERAGE_MISMATCH";
  return null;
}

function priceEvidenceBlock(raw, instrument, asOfMs) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "PRICE_PROVENANCE_REQUIRED";
  const commonBlock = publicPointInTimeBlock(raw, "PRICE");
  if (commonBlock) return commonBlock;

  const symbol = normalizedSymbol(raw.symbol);
  if (!symbol) return "PRICE_SYMBOL_REQUIRED";
  if (symbol !== instrument.symbol) return "PRICE_SYMBOL_MISMATCH";

  const priceUsd = positiveEvidenceNumber(raw.priceUsd);
  if (priceUsd == null) return "PRICE_VALUE_REQUIRED";
  if (priceUsd !== instrument.priceUsd) return "PRICE_VALUE_MISMATCH";

  const observedAtMs = positiveEvidenceNumber(raw.observedAtMs);
  if (observedAtMs == null) return "PRICE_OBSERVED_AT_REQUIRED";
  if (observedAtMs > asOfMs) return "PRICE_EVIDENCE_FROM_FUTURE";

  const validUntilMs = positiveEvidenceNumber(raw.validUntilMs);
  if (validUntilMs == null) return "PRICE_VALID_UNTIL_REQUIRED";
  if (validUntilMs < observedAtMs) return "PRICE_VALIDITY_RANGE_INVALID";
  if (validUntilMs < asOfMs) return "PRICE_EVIDENCE_STALE";
  return null;
}

function marketCapEvidenceBlock(raw, instrumentMarketCapUsd, asOfMs) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "MARKET_CAP_PROVENANCE_REQUIRED";
  if (!sourceId(raw)) return "MARKET_CAP_SOURCE_REQUIRED";
  if (raw.pointInTime !== true) return "MARKET_CAP_POINT_IN_TIME_UNPROVEN";

  const valueUsd = positiveEvidenceNumber(raw.marketCapUsd);
  if (valueUsd == null) return "MARKET_CAP_VALUE_REQUIRED";
  if (valueUsd !== instrumentMarketCapUsd) return "MARKET_CAP_VALUE_MISMATCH";

  const observedAtMs = positiveEvidenceNumber(raw.observedAtMs);
  if (observedAtMs == null) return "MARKET_CAP_OBSERVED_AT_REQUIRED";
  if (observedAtMs > asOfMs) return "MARKET_CAP_EVIDENCE_FROM_FUTURE";

  const validFromMs = positiveEvidenceNumber(raw.validFromMs);
  const validToMs = positiveEvidenceNumber(raw.validToMs);
  if (validFromMs == null || validToMs == null) return "MARKET_CAP_COVERAGE_REQUIRED";
  if (validToMs < validFromMs || validFromMs > asOfMs || validToMs < asOfMs) return "MARKET_CAP_COVERAGE_MISMATCH";
  return null;
}

function dollarVolumeEvidenceBlock(raw, instrumentAverageDollarVolumeUsd, asOfMs) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "DOLLAR_VOLUME_PROVENANCE_REQUIRED";
  if (!sourceId(raw)) return "DOLLAR_VOLUME_SOURCE_REQUIRED";
  if (raw.pointInTime !== true) return "DOLLAR_VOLUME_POINT_IN_TIME_UNPROVEN";

  const valueUsd = positiveEvidenceNumber(raw.averageDollarVolumeUsd);
  if (valueUsd == null) return "DOLLAR_VOLUME_VALUE_REQUIRED";
  if (valueUsd !== instrumentAverageDollarVolumeUsd) return "DOLLAR_VOLUME_VALUE_MISMATCH";

  const observedAtMs = positiveEvidenceNumber(raw.observedAtMs);
  if (observedAtMs == null) return "DOLLAR_VOLUME_OBSERVED_AT_REQUIRED";
  if (observedAtMs > asOfMs) return "DOLLAR_VOLUME_EVIDENCE_FROM_FUTURE";

  const windowStartMs = positiveEvidenceNumber(raw.windowStartMs);
  const windowEndMs = positiveEvidenceNumber(raw.windowEndMs);
  if (windowStartMs == null || windowEndMs == null) return "DOLLAR_VOLUME_WINDOW_REQUIRED";
  if (windowEndMs <= windowStartMs) return "DOLLAR_VOLUME_WINDOW_INVALID";
  if (windowEndMs > asOfMs) return "DOLLAR_VOLUME_WINDOW_FROM_FUTURE";

  const validUntilMs = positiveEvidenceNumber(raw.validUntilMs);
  if (validUntilMs == null) return "DOLLAR_VOLUME_VALID_UNTIL_REQUIRED";
  if (validUntilMs < asOfMs) return "DOLLAR_VOLUME_EVIDENCE_STALE";
  return null;
}

export function evaluateQualityDaytradeUniverseProvenance(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("quality day-trade universe provenance input must be an object");
  }

  const asOfMs = positiveEvidenceNumber(raw.asOfMs);
  if (asOfMs == null) return safeResult({ status: "BLOCKED_DATA", reason: "UNIVERSE_ASOF_REQUIRED" });

  const instrumentRaw = raw.instrument;
  if (!instrumentRaw || typeof instrumentRaw !== "object" || Array.isArray(instrumentRaw)) {
    return safeResult({ status: "BLOCKED_DATA", reason: "UNIVERSE_INSTRUMENT_REQUIRED" });
  }

  const instrument = Object.freeze({
    symbol: normalizedSymbol(instrumentRaw.symbol),
    exchange: normalizedToken(instrumentRaw.exchange),
    securityType: normalizedToken(instrumentRaw.securityType),
    priceUsd: positiveEvidenceNumber(instrumentRaw.priceUsd),
    marketCapUsd: positiveEvidenceNumber(instrumentRaw.marketCapUsd),
    averageDollarVolumeUsd: positiveEvidenceNumber(instrumentRaw.averageDollarVolumeUsd),
  });
  if (!instrument.symbol) return safeResult({ status: "BLOCKED_DATA", reason: "INSTRUMENT_SYMBOL_REQUIRED" });
  if (!instrument.exchange) return safeResult({ status: "BLOCKED_DATA", reason: "INSTRUMENT_EXCHANGE_REQUIRED" });
  if (!instrument.securityType) return safeResult({ status: "BLOCKED_DATA", reason: "INSTRUMENT_SECURITY_TYPE_REQUIRED" });
  if (instrument.priceUsd == null) return safeResult({ status: "BLOCKED_DATA", reason: "INSTRUMENT_PRICE_REQUIRED" });
  if (instrument.marketCapUsd == null) return safeResult({ status: "BLOCKED_DATA", reason: "INSTRUMENT_MARKET_CAP_REQUIRED" });
  if (instrument.averageDollarVolumeUsd == null) return safeResult({ status: "BLOCKED_DATA", reason: "INSTRUMENT_DOLLAR_VOLUME_REQUIRED" });

  const evidence = raw.universeEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return safeResult({ status: "BLOCKED_DATA", reason: "UNIVERSE_EVIDENCE_REQUIRED" });
  }

  const listingBlock = listingEvidenceBlock(evidence.listing, instrument, asOfMs);
  if (listingBlock) return safeResult({ status: "BLOCKED_DATA", reason: listingBlock });

  const priceBlock = priceEvidenceBlock(evidence.price, instrument, asOfMs);
  if (priceBlock) return safeResult({ status: "BLOCKED_DATA", reason: priceBlock });

  const marketCapBlock = marketCapEvidenceBlock(evidence.marketCap, instrument.marketCapUsd, asOfMs);
  if (marketCapBlock) return safeResult({ status: "BLOCKED_DATA", reason: marketCapBlock });

  const dollarVolumeBlock = dollarVolumeEvidenceBlock(evidence.averageDollarVolume, instrument.averageDollarVolumeUsd, asOfMs);
  if (dollarVolumeBlock) return safeResult({ status: "BLOCKED_DATA", reason: dollarVolumeBlock });

  return safeResult({
    status: "PASS",
    reason: "POINT_IN_TIME_UNIVERSE_EVIDENCE_VERIFIED",
    asOfMs,
    symbol: instrument.symbol,
    exchange: instrument.exchange,
    securityType: instrument.securityType,
    priceUsd: instrument.priceUsd,
    listingSourceId: sourceId(evidence.listing),
    priceSourceId: sourceId(evidence.price),
    marketCapSourceId: sourceId(evidence.marketCap),
    dollarVolumeSourceId: sourceId(evidence.averageDollarVolume),
    marketCapUsd: instrument.marketCapUsd,
    averageDollarVolumeUsd: instrument.averageDollarVolumeUsd,
  });
}

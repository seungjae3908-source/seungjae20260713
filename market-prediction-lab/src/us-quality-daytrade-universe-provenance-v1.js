import { PredictionInputError } from "./contracts.js";

export const QUALITY_DAYTRADE_UNIVERSE_PROVENANCE_CONTRACT_VERSION = "us-quality-daytrade-universe-provenance-v1";

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

  const instrument = raw.instrument;
  if (!instrument || typeof instrument !== "object" || Array.isArray(instrument)) {
    return safeResult({ status: "BLOCKED_DATA", reason: "UNIVERSE_INSTRUMENT_REQUIRED" });
  }

  const marketCapUsd = positiveEvidenceNumber(instrument.marketCapUsd);
  const averageDollarVolumeUsd = positiveEvidenceNumber(instrument.averageDollarVolumeUsd);
  if (marketCapUsd == null) return safeResult({ status: "BLOCKED_DATA", reason: "INSTRUMENT_MARKET_CAP_REQUIRED" });
  if (averageDollarVolumeUsd == null) return safeResult({ status: "BLOCKED_DATA", reason: "INSTRUMENT_DOLLAR_VOLUME_REQUIRED" });

  const evidence = raw.universeEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return safeResult({ status: "BLOCKED_DATA", reason: "UNIVERSE_EVIDENCE_REQUIRED" });
  }

  const marketCapBlock = marketCapEvidenceBlock(evidence.marketCap, marketCapUsd, asOfMs);
  if (marketCapBlock) return safeResult({ status: "BLOCKED_DATA", reason: marketCapBlock });

  const dollarVolumeBlock = dollarVolumeEvidenceBlock(evidence.averageDollarVolume, averageDollarVolumeUsd, asOfMs);
  if (dollarVolumeBlock) return safeResult({ status: "BLOCKED_DATA", reason: dollarVolumeBlock });

  return safeResult({
    status: "PASS",
    reason: "POINT_IN_TIME_UNIVERSE_EVIDENCE_VERIFIED",
    asOfMs,
    marketCapSourceId: sourceId(evidence.marketCap),
    dollarVolumeSourceId: sourceId(evidence.averageDollarVolume),
    marketCapUsd,
    averageDollarVolumeUsd,
  });
}

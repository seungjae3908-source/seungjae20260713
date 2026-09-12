import { PredictionInputError } from "./contracts.js";

export const QUALITY_DAYTRADE_MARKET_CONTEXT_CONTRACT_VERSION = "us-quality-daytrade-market-context-v1";

const VALID_SESSIONS = new Set(["PREMARKET", "REGULAR", "AFTER_HOURS"]);

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new PredictionInputError(`${name} must be finite`);
  return number;
}

function safeResult(fields) {
  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_MARKET_CONTEXT_CONTRACT_VERSION,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    ...fields,
  });
}

function blocked(reason, fields = {}) {
  return safeResult({ status: "BLOCKED_DATA", reason, ...fields });
}

function normalizeBenchmark(raw, name, asOfMs, maxAgeMs) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { blocked: `${name.toUpperCase()}_EVIDENCE_REQUIRED` };
  }
  const sourceId = String(raw.sourceId ?? "").trim();
  const symbol = String(raw.symbol ?? "").trim().toUpperCase();
  if (!sourceId) return { blocked: `${name.toUpperCase()}_SOURCE_REQUIRED` };
  if (!symbol) return { blocked: `${name.toUpperCase()}_SYMBOL_REQUIRED` };
  if (raw.pointInTime !== true) return { blocked: `${name.toUpperCase()}_POINT_IN_TIME_REQUIRED` };

  const observedAtMs = finiteNumber(raw.observedAtMs, `${name}Evidence.observedAtMs`);
  if (observedAtMs > asOfMs) return { blocked: `${name.toUpperCase()}_EVIDENCE_FROM_FUTURE` };
  const ageMs = asOfMs - observedAtMs;
  if (ageMs > maxAgeMs) return { blocked: `${name.toUpperCase()}_EVIDENCE_STALE`, ageMs };

  const returnPct = finiteNumber(raw.returnPct, `${name}Evidence.returnPct`);
  return {
    value: Object.freeze({ sourceId, symbol, pointInTime: true, observedAtMs, ageMs, returnPct }),
  };
}

function classifyTimeOfDay(session, sessionStartMs, asOfMs) {
  if (session === "PREMARKET") return Object.freeze({ bucket: "PREMARKET", minutesFromSessionOpen: null });
  if (session === "AFTER_HOURS") return Object.freeze({ bucket: "AFTER_HOURS", minutesFromSessionOpen: null });
  const minutesFromSessionOpen = (asOfMs - sessionStartMs) / 60_000;
  let bucket = "REGULAR_POWER_HOUR";
  if (minutesFromSessionOpen < 30) bucket = "REGULAR_OPENING_30";
  else if (minutesFromSessionOpen < 120) bucket = "REGULAR_EARLY_30_120";
  else if (minutesFromSessionOpen < 300) bucket = "REGULAR_MIDDAY_120_300";
  return Object.freeze({ bucket, minutesFromSessionOpen });
}

function classifyMarketRegime(indexReturnPct) {
  if (indexReturnPct >= 0.3) return "RISK_ON";
  if (indexReturnPct <= -0.3) return "RISK_OFF";
  return "NEUTRAL";
}

function classifySectorRegime(relativeReturnPct) {
  if (relativeReturnPct >= 0.3) return "OUTPERFORMING";
  if (relativeReturnPct <= -0.3) return "UNDERPERFORMING";
  return "INLINE";
}

export function evaluateUsQualityDaytradeMarketContext(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("quality day-trade market context input must be an object");
  }

  const asOfMs = finiteNumber(raw.asOfMs, "asOfMs");
  const session = String(raw.session ?? "").toUpperCase();
  if (!VALID_SESSIONS.has(session)) return blocked("MARKET_CONTEXT_SESSION_REQUIRED");

  const evidence = raw.marketContextEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return blocked("MARKET_CONTEXT_EVIDENCE_REQUIRED", { session });
  }
  if (evidence.pointInTime !== true) return blocked("MARKET_CONTEXT_POINT_IN_TIME_REQUIRED", { session });
  if (String(evidence.marketTimezone ?? "") !== "America/New_York") {
    return blocked("MARKET_CONTEXT_TIMEZONE_REQUIRED", { session });
  }
  if (String(evidence.session ?? "").toUpperCase() !== session) {
    return blocked("MARKET_CONTEXT_SESSION_MISMATCH", { session });
  }

  const sourceId = String(evidence.sourceId ?? "").trim();
  if (!sourceId) return blocked("MARKET_CONTEXT_SOURCE_REQUIRED", { session });
  const checkedAtMs = finiteNumber(evidence.checkedAtMs, "marketContextEvidence.checkedAtMs");
  const validUntilMs = finiteNumber(evidence.validUntilMs, "marketContextEvidence.validUntilMs");
  if (checkedAtMs > asOfMs) return blocked("MARKET_CONTEXT_EVIDENCE_FROM_FUTURE", { session, checkedAtMs });
  if (validUntilMs < checkedAtMs) return blocked("MARKET_CONTEXT_VALIDITY_RANGE_INVALID", { session, checkedAtMs, validUntilMs });
  if (validUntilMs < asOfMs) return blocked("MARKET_CONTEXT_EVIDENCE_STALE", { session, checkedAtMs, validUntilMs });

  const sessionStartMs = finiteNumber(evidence.sessionStartMs, "marketContextEvidence.sessionStartMs");
  const sessionEndMs = finiteNumber(evidence.sessionEndMs, "marketContextEvidence.sessionEndMs");
  if (sessionEndMs <= sessionStartMs) return blocked("MARKET_CONTEXT_SESSION_RANGE_INVALID", { session });
  if (asOfMs < sessionStartMs || asOfMs > sessionEndMs) {
    return blocked("MARKET_CONTEXT_ASOF_OUTSIDE_SESSION", { session, asOfMs, sessionStartMs, sessionEndMs });
  }

  const maxBenchmarkAgeMs = finiteNumber(evidence.maxBenchmarkAgeMs ?? 60_000, "marketContextEvidence.maxBenchmarkAgeMs");
  const maxBenchmarkSkewMs = finiteNumber(evidence.maxBenchmarkSkewMs ?? 30_000, "marketContextEvidence.maxBenchmarkSkewMs");
  if (!(maxBenchmarkAgeMs > 0) || !(maxBenchmarkSkewMs >= 0)) {
    throw new PredictionInputError("invalid market context benchmark freshness policy");
  }

  const index = normalizeBenchmark(evidence.indexEvidence, "index", asOfMs, maxBenchmarkAgeMs);
  if (index.blocked) return blocked(index.blocked, { session, ...(index.ageMs == null ? {} : { ageMs: index.ageMs }) });
  const sector = normalizeBenchmark(evidence.sectorEvidence, "sector", asOfMs, maxBenchmarkAgeMs);
  if (sector.blocked) return blocked(sector.blocked, { session, ...(sector.ageMs == null ? {} : { ageMs: sector.ageMs }) });

  const benchmarkSkewMs = Math.abs(index.value.observedAtMs - sector.value.observedAtMs);
  if (benchmarkSkewMs > maxBenchmarkSkewMs) {
    return blocked("MARKET_CONTEXT_BENCHMARK_CLOCK_SKEW_TOO_WIDE", { session, benchmarkSkewMs, maxBenchmarkSkewMs });
  }

  const sectorRelativeReturnPct = sector.value.returnPct - index.value.returnPct;
  const timeOfDay = classifyTimeOfDay(session, sessionStartMs, asOfMs);
  return safeResult({
    status: "PASS",
    reason: "POINT_IN_TIME_MARKET_CONTEXT_READY",
    session,
    sourceId,
    checkedAtMs,
    validUntilMs,
    index: index.value,
    sector: sector.value,
    benchmarkSkewMs,
    sectorRelativeReturnPct,
    marketRegime: classifyMarketRegime(index.value.returnPct),
    sectorRegime: classifySectorRegime(sectorRelativeReturnPct),
    timeOfDayBucket: timeOfDay.bucket,
    minutesFromSessionOpen: timeOfDay.minutesFromSessionOpen,
    pointInTime: true,
  });
}

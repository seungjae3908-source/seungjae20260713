import { PredictionInputError } from "./contracts.js";
import { buildUsQualityDaytradeObservationIdentity } from "./us-quality-daytrade-live-evidence-v1.js";

export const QUALITY_DAYTRADE_CANDIDATE_BINDING_VERSION = "us-quality-daytrade-candidate-binding-v1";

function freeze(value) {
  return Object.freeze(value);
}

function blocked(reason, details = {}) {
  return freeze({
    contractVersion: QUALITY_DAYTRADE_CANDIDATE_BINDING_VERSION,
    status: "BLOCKED_DATA",
    reason,
    candidateBound: false,
    duplicateCountingAllowed: false,
    profitabilityEligible: false,
    selectionEligible: false,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderAuthority: false,
    ...details,
  });
}

function requiredSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!symbol) throw new PredictionInputError("symbol is required");
  if (!/^[A-Z0-9.-]{1,32}$/u.test(symbol)) throw new PredictionInputError("symbol is invalid");
  return symbol;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function approximatelyEqual(left, right, tolerance = 1e-9) {
  const a = finite(left);
  const b = finite(right);
  if (a == null || b == null) return false;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= tolerance * scale;
}

function sessionVwap(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  let numerator = 0;
  let denominator = 0;
  for (const candle of candles) {
    const high = finite(candle?.high);
    const low = finite(candle?.low);
    const close = finite(candle?.close);
    const volume = finite(candle?.volume);
    if (high == null || low == null || close == null || volume == null || volume < 0) return null;
    if (!(volume > 0)) continue;
    numerator += ((high + low + close) / 3) * volume;
    denominator += volume;
  }
  return denominator > 0 ? numerator / denominator : null;
}

function sourceBoundMetrics(bundle) {
  const bid = finite(bundle?.quote?.bid);
  const ask = finite(bundle?.quote?.ask);
  const quoteTimestampMs = finite(bundle?.quote?.timestampMs);
  const asOfMs = finite(bundle?.asOfMs);
  const lastCompleteCandleTimestampMs = finite(bundle?.candleEvidence?.lastCompleteCandleTimestampMs);
  if (bid == null || ask == null || ask < bid || quoteTimestampMs == null || asOfMs == null || lastCompleteCandleTimestampMs == null) {
    return null;
  }
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  const vwap = sessionVwap(bundle.candles);
  if (!(vwap > 0)) return null;
  return freeze({
    spreadBps: ((ask - bid) / mid) * 10_000,
    quoteAgeMs: asOfMs - quoteTimestampMs,
    candleAgeMs: asOfMs - lastCompleteCandleTimestampMs,
    relativeVolume: finite(bundle.relativeVolume),
    vwap,
  });
}

export function bindUsQualityDaytradeCandidateToLiveEvidence({
  preEntryResult,
  bundle,
  strategyIdentity,
  symbol,
} = {}) {
  if (!preEntryResult || typeof preEntryResult !== "object" || Array.isArray(preEntryResult)) {
    throw new PredictionInputError("preEntryResult is required");
  }
  if (preEntryResult.status !== "CANDIDATE") {
    return blocked("PRE_ENTRY_CANDIDATE_REQUIRED");
  }
  if (!bundle || bundle.status !== "READY" || !bundle.provenance?.observationDigest) {
    return blocked("READY_SOURCE_BACKED_LIVE_EVIDENCE_REQUIRED");
  }
  if (bundle.provenance.publicReadOnly !== true || bundle.provenance.privateApiUsed !== false) {
    return blocked("PUBLIC_READ_ONLY_LIVE_EVIDENCE_REQUIRED");
  }

  const technical = preEntryResult.technicalSetup;
  if (!technical || technical.status !== "CANDIDATE") {
    return blocked("TECHNICAL_CANDIDATE_REQUIRED");
  }

  const normalizedSymbol = requiredSymbol(symbol);
  const technicalSymbol = requiredSymbol(technical.universe?.instrument?.symbol);
  if (normalizedSymbol !== technicalSymbol) {
    return blocked("CANDIDATE_SYMBOL_MISMATCH", { symbol: normalizedSymbol, technicalSymbol });
  }
  if (String(bundle.session ?? "").toUpperCase() !== String(technical.session ?? "").toUpperCase()) {
    return blocked("LIVE_EVIDENCE_SESSION_MISMATCH", {
      bundleSession: bundle.session ?? null,
      technicalSession: technical.session ?? null,
    });
  }

  const metrics = sourceBoundMetrics(bundle);
  if (metrics == null || metrics.relativeVolume == null) {
    return blocked("LIVE_EVIDENCE_METRICS_INVALID");
  }
  const checks = [
    ["SPREAD", metrics.spreadBps, technical.spreadBps],
    ["QUOTE_AGE", metrics.quoteAgeMs, technical.quoteAgeMs],
    ["CANDLE_AGE", metrics.candleAgeMs, technical.candleAgeMs],
    ["RVOL", metrics.relativeVolume, technical.relativeVolume],
    ["VWAP", metrics.vwap, technical.vwap],
  ];
  for (const [name, sourceValue, technicalValue] of checks) {
    if (!approximatelyEqual(sourceValue, technicalValue)) {
      return blocked(`LIVE_EVIDENCE_${name}_MISMATCH`, { sourceValue, technicalValue });
    }
  }

  if (preEntryResult.qualityTier !== technical.qualityTier) {
    return blocked("QUALITY_TIER_MISMATCH");
  }
  if (!approximatelyEqual(preEntryResult.riskBudgetMultiplier, technical.riskBudgetMultiplier)) {
    return blocked("RISK_BUDGET_MISMATCH");
  }
  if (preEntryResult.binaryEventRisk?.status !== "PASS" || preEntryResult.catalystEvidence?.status !== "PASS") {
    return blocked("PRE_ENTRY_PROVENANCE_GATES_NOT_PASSED");
  }

  const observationIdentity = buildUsQualityDaytradeObservationIdentity({
    strategyIdentity,
    bundle,
    symbol: normalizedSymbol,
  });

  return freeze({
    contractVersion: QUALITY_DAYTRADE_CANDIDATE_BINDING_VERSION,
    status: "BOUND_CANDIDATE",
    reason: "SOURCE_BOUND_PRE_ENTRY_CANDIDATE",
    candidateBound: true,
    symbol: normalizedSymbol,
    qualityTier: technical.qualityTier,
    session: technical.session,
    evidenceId: observationIdentity.evidenceId,
    observationDigest: observationIdentity.observationDigest,
    strategyIdentity: observationIdentity.strategyIdentity,
    sourceMetrics: metrics,
    duplicateCountingAllowed: false,
    profitabilityEligible: false,
    selectionEligible: false,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderAuthority: false,
  });
}

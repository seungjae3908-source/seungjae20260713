import { PredictionInputError } from "./contracts.js";

export const QUALITY_DAYTRADE_CATALYST_EVIDENCE_VERSION = "us-quality-daytrade-catalyst-evidence-v1";

export const DEFAULT_QUALITY_DAYTRADE_CATALYST_POLICY = Object.freeze({
  lookbackMs: 24 * 60 * 60 * 1_000,
  maxCheckAgeMs: 30 * 60 * 1_000,
});

const VALID_CATALYST_TYPES = new Set([
  "EARNINGS_RESULT",
  "GUIDANCE_CHANGE",
  "REGULATORY_POLICY",
  "FDA_DECISION",
  "MATERIAL_CORPORATE_EVENT",
  "M_AND_A",
  "CONTRACT_AWARD",
  "PRODUCT_LAUNCH",
  "ANALYST_ACTION",
  "OTHER_VERIFIED_NEWS",
]);

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new PredictionInputError(`${name} must be finite`);
  return number;
}

function normalizeSymbol(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizePolicy(raw = DEFAULT_QUALITY_DAYTRADE_CATALYST_POLICY) {
  const lookbackMs = finiteNumber(
    raw?.lookbackMs ?? DEFAULT_QUALITY_DAYTRADE_CATALYST_POLICY.lookbackMs,
    "catalystPolicy.lookbackMs",
  );
  const maxCheckAgeMs = finiteNumber(
    raw?.maxCheckAgeMs ?? DEFAULT_QUALITY_DAYTRADE_CATALYST_POLICY.maxCheckAgeMs,
    "catalystPolicy.maxCheckAgeMs",
  );
  if (!(lookbackMs > 0) || lookbackMs > 7 * 24 * 60 * 60 * 1_000) {
    throw new PredictionInputError("invalid catalystPolicy.lookbackMs");
  }
  if (!(maxCheckAgeMs > 0) || maxCheckAgeMs > 6 * 60 * 60 * 1_000) {
    throw new PredictionInputError("invalid catalystPolicy.maxCheckAgeMs");
  }
  return Object.freeze({ lookbackMs, maxCheckAgeMs });
}

function safeResult(fields) {
  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_CATALYST_EVIDENCE_VERSION,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderAuthority: false,
    ...fields,
  });
}

function blocked(reason, fields = {}) {
  return safeResult({ status: "BLOCKED_DATA", reason, ...fields });
}

function normalizeCatalyst(raw, index, { asOfMs, symbol }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return blocked("CATALYST_ITEM_INVALID", { catalystIndex: index });
  }
  const catalystId = String(raw.catalystId ?? "").trim();
  if (!catalystId) return blocked("CATALYST_ID_REQUIRED", { catalystIndex: index });
  const catalystSymbol = normalizeSymbol(raw.symbol);
  if (!catalystSymbol) return blocked("CATALYST_SYMBOL_REQUIRED", { catalystIndex: index, catalystId });
  if (catalystSymbol !== symbol) {
    return blocked("CATALYST_SYMBOL_MISMATCH", { catalystIndex: index, catalystId, catalystSymbol, symbol });
  }
  const catalystType = String(raw.catalystType ?? "").trim().toUpperCase();
  if (!VALID_CATALYST_TYPES.has(catalystType)) {
    return blocked("CATALYST_TYPE_UNSUPPORTED", { catalystIndex: index, catalystId, catalystType });
  }
  if (raw.pointInTime !== true) {
    return blocked("CATALYST_POINT_IN_TIME_REQUIRED", { catalystIndex: index, catalystId, catalystType });
  }
  if (raw.publicReadOnly !== true || raw.privateApiUsed !== false) {
    return blocked("CATALYST_PUBLIC_READ_ONLY_REQUIRED", { catalystIndex: index, catalystId, catalystType });
  }
  const sourceId = String(raw.sourceId ?? raw.source ?? "").trim();
  if (!sourceId) return blocked("CATALYST_SOURCE_REQUIRED", { catalystIndex: index, catalystId, catalystType });
  const publishedAtMs = finiteNumber(raw.publishedAtMs, `catalystEvidence.catalysts[${index}].publishedAtMs`);
  const marketMovingTimestampMs = finiteNumber(
    raw.marketMovingTimestampMs,
    `catalystEvidence.catalysts[${index}].marketMovingTimestampMs`,
  );
  if (publishedAtMs > asOfMs || marketMovingTimestampMs > asOfMs) {
    return blocked("CATALYST_FROM_FUTURE", {
      catalystIndex: index,
      catalystId,
      catalystType,
      publishedAtMs,
      marketMovingTimestampMs,
      asOfMs,
    });
  }
  const headlineDigest = String(raw.headlineDigest ?? "").trim();
  if (!headlineDigest) return blocked("CATALYST_HEADLINE_DIGEST_REQUIRED", { catalystIndex: index, catalystId, catalystType });

  return Object.freeze({
    status: "READY",
    catalystId,
    symbol: catalystSymbol,
    catalystType,
    sourceId,
    pointInTime: true,
    publicReadOnly: true,
    privateApiUsed: false,
    publishedAtMs,
    marketMovingTimestampMs,
    headlineDigest,
  });
}

export function evaluateUsQualityDaytradeCatalystEvidence(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("quality day-trade catalyst input must be an object");
  }
  const asOfMs = finiteNumber(raw.asOfMs, "asOfMs");
  const symbol = normalizeSymbol(raw.symbol);
  if (!symbol) return blocked("CATALYST_TARGET_SYMBOL_REQUIRED");
  const policy = normalizePolicy(raw.catalystPolicy);
  const evidence = raw.catalystEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return blocked("CATALYST_EVIDENCE_REQUIRED", { symbol, policy });
  }
  if (evidence.publicReadOnly !== true || evidence.privateApiUsed !== false) {
    return blocked("CATALYST_EVIDENCE_PUBLIC_READ_ONLY_REQUIRED", { symbol, policy });
  }
  const evidenceSymbol = normalizeSymbol(evidence.symbol);
  if (!evidenceSymbol) return blocked("CATALYST_EVIDENCE_SYMBOL_REQUIRED", { symbol, policy });
  if (evidenceSymbol !== symbol) {
    return blocked("CATALYST_EVIDENCE_SYMBOL_MISMATCH", { symbol, evidenceSymbol, policy });
  }
  const sourceId = String(evidence.sourceId ?? evidence.source ?? "").trim();
  if (!sourceId) return blocked("CATALYST_EVIDENCE_SOURCE_REQUIRED", { symbol, policy });
  if (evidence.coverageComplete !== true) {
    return blocked("CATALYST_EVIDENCE_COVERAGE_COMPLETE_REQUIRED", { symbol, sourceId, policy });
  }

  const checkedAtMs = finiteNumber(evidence.checkedAtMs, "catalystEvidence.checkedAtMs");
  const validUntilMs = finiteNumber(evidence.validUntilMs, "catalystEvidence.validUntilMs");
  const coverageStartMs = finiteNumber(evidence.coverageStartMs, "catalystEvidence.coverageStartMs");
  const coverageEndMs = finiteNumber(evidence.coverageEndMs, "catalystEvidence.coverageEndMs");
  if (checkedAtMs > asOfMs) return blocked("CATALYST_EVIDENCE_FROM_FUTURE", { symbol, sourceId, policy });
  if (asOfMs - checkedAtMs > policy.maxCheckAgeMs) {
    return blocked("CATALYST_EVIDENCE_STALE", { symbol, sourceId, checkedAtMs, asOfMs, policy });
  }
  if (validUntilMs < checkedAtMs || validUntilMs < asOfMs) {
    return blocked("CATALYST_EVIDENCE_VALIDITY_EXPIRED", { symbol, sourceId, checkedAtMs, validUntilMs, asOfMs, policy });
  }
  if (coverageEndMs < coverageStartMs) {
    return blocked("CATALYST_EVIDENCE_COVERAGE_RANGE_INVALID", { symbol, sourceId, coverageStartMs, coverageEndMs, policy });
  }
  const requiredCoverageStartMs = asOfMs - policy.lookbackMs;
  if (coverageStartMs > requiredCoverageStartMs || coverageEndMs < asOfMs) {
    return blocked("CATALYST_EVIDENCE_COVERAGE_INSUFFICIENT", {
      symbol,
      sourceId,
      coverageStartMs,
      coverageEndMs,
      requiredCoverageStartMs,
      requiredCoverageEndMs: asOfMs,
      policy,
    });
  }
  if (!Array.isArray(evidence.catalysts)) {
    return blocked("CATALYST_LIST_REQUIRED", { symbol, sourceId, policy });
  }
  if (evidence.catalystCount == null) {
    return blocked("CATALYST_COUNT_REQUIRED", { symbol, sourceId, policy });
  }
  const catalystCount = finiteNumber(evidence.catalystCount, "catalystEvidence.catalystCount");
  if (!Number.isInteger(catalystCount) || catalystCount < 0 || catalystCount > 100) {
    return blocked("CATALYST_COUNT_INVALID", { symbol, sourceId, catalystCount, policy });
  }
  if (catalystCount !== evidence.catalysts.length) {
    return blocked("CATALYST_COUNT_MISMATCH", {
      symbol,
      sourceId,
      catalystCount,
      observedCatalystCount: evidence.catalysts.length,
      policy,
    });
  }

  const catalysts = [];
  const seenIds = new Set();
  for (let index = 0; index < evidence.catalysts.length; index += 1) {
    const catalyst = normalizeCatalyst(evidence.catalysts[index], index, { asOfMs, symbol });
    if (catalyst.status !== "READY") return catalyst;
    if (catalyst.marketMovingTimestampMs < requiredCoverageStartMs) {
      return blocked("CATALYST_OUTSIDE_REQUIRED_LOOKBACK", {
        symbol,
        sourceId,
        catalystId: catalyst.catalystId,
        catalystIndex: index,
        requiredCoverageStartMs,
      });
    }
    if (seenIds.has(catalyst.catalystId)) {
      return blocked("CATALYST_DUPLICATE_ID", { symbol, sourceId, catalystId: catalyst.catalystId, catalystIndex: index });
    }
    seenIds.add(catalyst.catalystId);
    catalysts.push(catalyst);
  }

  const ordered = [...catalysts].sort((a, b) => b.marketMovingTimestampMs - a.marketMovingTimestampMs);
  return safeResult({
    status: "PASS",
    reason: ordered.length ? "VERIFIED_PUBLIC_CATALYST_PRESENT" : "NO_VERIFIED_CATALYST_IN_LOOKBACK",
    symbol,
    policy,
    evidence: Object.freeze({
      sourceId,
      checkedAtMs,
      validUntilMs,
      coverageStartMs,
      coverageEndMs,
      coverageComplete: true,
      catalystCount,
      catalysts: Object.freeze(ordered),
    }),
    hasVerifiedCatalyst: ordered.length > 0,
    catalystClass: ordered.length ? "VERIFIED_CATALYST" : "NO_VERIFIED_CATALYST",
    primaryCatalyst: ordered[0] ?? null,
  });
}

import { createHash } from "node:crypto";

function canonical(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
}

export function sha256Canonical(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function assertSha(value, label) {
  if (!/^[0-9a-f]{40}$/i.test(value ?? "")) throw new TypeError(`${label} must be a 40-character commit SHA`);
}

function assertDigest(value, label) {
  if (!/^[0-9a-f]{64}$/i.test(value ?? "")) throw new TypeError(`${label} must be a SHA-256 digest`);
}

export function buildHistoricalCacheProvenance({
  market,
  symbol,
  timeframe,
  provider,
  requestedStartTime,
  requestedEndTime,
  dataDigest,
  providerManifestDigest,
  candleCount,
  actualStartTime,
  actualEndTime,
  closedCandlesOnly = true,
  duplicatesHandled = true,
  missingIntervalsDetected = true,
} = {}) {
  if (![market, symbol, timeframe, provider].every((value) => typeof value === "string" && value.length > 0)) throw new TypeError("market/symbol/timeframe/provider are required");
  for (const [label, value] of Object.entries({ requestedStartTime, requestedEndTime, actualStartTime, actualEndTime })) {
    if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer timestamp`);
  }
  if (requestedEndTime <= requestedStartTime || actualEndTime < actualStartTime) throw new RangeError("invalid historical time range");
  if (!Number.isInteger(candleCount) || candleCount <= 0) throw new RangeError("candleCount must be positive");
  assertDigest(dataDigest, "dataDigest");
  if (providerManifestDigest != null) assertDigest(providerManifestDigest, "providerManifestDigest");
  const identity = Object.freeze({ market, symbol, timeframe, provider, requestedStartTime, requestedEndTime, dataDigest, providerManifestDigest: providerManifestDigest ?? null });
  return Object.freeze({
    schemaVersion: 1,
    cacheType: "historical_raw",
    cacheKey: `historical:${sha256Canonical(identity)}`,
    identity,
    coverage: Object.freeze({ candleCount, actualStartTime, actualEndTime }),
    guards: Object.freeze({
      closedCandlesOnly: closedCandlesOnly === true,
      duplicatesHandled: duplicatesHandled === true,
      missingIntervalsDetected: missingIntervalsDetected === true,
      syntheticDataAllowed: false,
    }),
  });
}

export function buildStrategyResultCacheProvenance({
  researchCodeSha,
  historicalCacheKey,
  strategyVersion,
  parameters,
  costModel,
  splitContract,
  direction,
} = {}) {
  assertSha(researchCodeSha, "researchCodeSha");
  if (typeof historicalCacheKey !== "string" || !historicalCacheKey.startsWith("historical:")) throw new TypeError("historicalCacheKey is required");
  if (typeof strategyVersion !== "string" || strategyVersion.length === 0) throw new TypeError("strategyVersion is required");
  if (typeof direction !== "string" || direction.length === 0) throw new TypeError("direction is required");
  if (!parameters || typeof parameters !== "object" || !costModel || typeof costModel !== "object" || !splitContract || typeof splitContract !== "object") throw new TypeError("parameters, costModel and splitContract are required");
  const identity = Object.freeze({ researchCodeSha, historicalCacheKey, strategyVersion, parameters: canonical(parameters), costModel: canonical(costModel), splitContract: canonical(splitContract), direction });
  return Object.freeze({
    schemaVersion: 1,
    cacheType: "strategy_result",
    cacheKey: `strategy:${sha256Canonical(identity)}`,
    identity,
    guards: Object.freeze({
      exactResearchCodeShaRequired: true,
      exactHistoricalDataDigestRequired: true,
      exactParametersRequired: true,
      exactCostModelRequired: true,
      exactSplitContractRequired: true,
      staleReuseAllowed: false,
    }),
  });
}

export function validateCacheReuse(expected, actual) {
  if (!expected || !actual || expected.cacheType !== actual.cacheType) return Object.freeze({ reusable: false, reason: "cache_type_mismatch" });
  if (expected.cacheKey !== actual.cacheKey) return Object.freeze({ reusable: false, reason: "cache_key_mismatch" });
  if (sha256Canonical(expected.identity) !== sha256Canonical(actual.identity)) return Object.freeze({ reusable: false, reason: "cache_identity_mismatch" });
  if (expected.cacheType === "historical_raw") {
    if (actual.guards?.syntheticDataAllowed !== false) return Object.freeze({ reusable: false, reason: "synthetic_data_guard_failed" });
    if (actual.guards?.closedCandlesOnly !== true || actual.guards?.duplicatesHandled !== true || actual.guards?.missingIntervalsDetected !== true) return Object.freeze({ reusable: false, reason: "historical_quality_guard_failed" });
  }
  if (expected.cacheType === "strategy_result" && actual.guards?.staleReuseAllowed !== false) return Object.freeze({ reusable: false, reason: "stale_reuse_guard_failed" });
  return Object.freeze({ reusable: true, reason: null });
}

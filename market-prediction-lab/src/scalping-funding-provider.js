import { createHash } from "node:crypto";
import { BITGET_ENDPOINTS } from "./bitget-public-client.js";

export const SCALPING_FUNDING_SCHEMA_VERSION = 3;
export const SCALPING_FUNDING_PROVIDER = "bitget-public-v3";
export const SCALPING_FUNDING_PROVIDER_VERSION = "api-v3-history-fund-rate";
export const SCALPING_FUNDING_PROVIDER_API = BITGET_ENDPOINTS.fundingHistoryV3;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function scalpingFundingDigest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizeRow(row) {
  const timestamp = Number(row?.timestamp ?? row?.fundingRateTimestamp ?? row?.fundingTime);
  const rate = Number(row?.rate ?? row?.fundingRate);
  if (!Number.isSafeInteger(timestamp) || !Number.isFinite(rate)) return null;
  return Object.freeze({ timestamp, rate });
}

function sourceRecords(records) {
  return Object.freeze(records.map(normalizeRow).filter(Boolean));
}

function fundingProvenancePayload(artifact) {
  return Object.freeze({
    schemaVersion: artifact.schemaVersion,
    provider: artifact.provider,
    providerVersion: artifact.providerVersion,
    providerApi: artifact.providerApi,
    market: artifact.market,
    symbol: artifact.symbol,
    category: artifact.category,
    requestedStart: artifact.requestedStart,
    requestedEnd: artifact.requestedEnd,
    pageSize: artifact.pageSize,
    maxPages: artifact.maxPages,
    collectionCodeSHA: artifact.collectionCodeSHA,
  });
}

export function inspectFundingHistory({ records, requestedStart, requestedEnd } = {}) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const source = sourceRecords(records);
  let duplicateCount = 0;
  const seen = new Set();
  for (const row of source) {
    if (seen.has(row.timestamp)) duplicateCount += 1;
    seen.add(row.timestamp);
  }
  const sourceOrder = source.length < 2
    ? "single_or_empty"
    : source.every((row, index) => index === 0 || row.timestamp <= source[index - 1].timestamp)
      ? "descending"
      : source.every((row, index) => index === 0 || row.timestamp >= source[index - 1].timestamp)
        ? "ascending"
        : "mixed";
  const normalized = [...new Map(source.map((row) => [row.timestamp, row])).values()]
    .filter((row) => row.timestamp >= requestedStart && row.timestamp <= requestedEnd)
    .sort((a, b) => a.timestamp - b.timestamp);
  let normalizedOutOfOrderCount = 0;
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].timestamp <= normalized[index - 1].timestamp) normalizedOutOfOrderCount += 1;
  }
  const actualFirstFunding = normalized[0]?.timestamp ?? null;
  const actualLastFunding = normalized.at(-1)?.timestamp ?? null;
  const deltas = normalized.slice(1).map((row, index) => row.timestamp - normalized[index].timestamp).filter((value) => value > 0);
  const orderedDeltas = [...deltas].sort((a, b) => a - b);
  const maximumObservedIntervalMs = orderedDeltas.length ? orderedDeltas.at(-1) : null;
  const medianObservedIntervalMs = orderedDeltas.length ? orderedDeltas[Math.floor(orderedDeltas.length / 2)] : null;
  const missingIntervals = medianObservedIntervalMs
    ? deltas.reduce((sum, delta) => sum + Math.max(0, Math.round(delta / medianObservedIntervalMs) - 1), 0)
    : 0;
  // Bitget documents that funding intervals vary by symbol. Edge coverage therefore uses the
  // largest observed real interval; missingIntervals is diagnostic only and never synthesized.
  const edgeToleranceMs = maximumObservedIntervalMs ?? 8 * 60 * 60 * 1000;
  const reachesStart = actualFirstFunding != null && actualFirstFunding <= requestedStart + edgeToleranceMs;
  const reachesEnd = actualLastFunding != null && actualLastFunding >= requestedEnd - edgeToleranceMs;
  const sourceOrderValid = sourceOrder === "descending" || sourceOrder === "single_or_empty";
  const valid = normalized.length > 0
    && duplicateCount === 0
    && normalizedOutOfOrderCount === 0
    && sourceOrderValid
    && reachesStart
    && reachesEnd;
  return Object.freeze({
    status: valid ? "DATA_READY" : "BLOCKED_DATA",
    requestedStart,
    requestedEnd,
    actualFirstFunding,
    actualLastFunding,
    recordCount: normalized.length,
    duplicateCount,
    sourceOrder,
    sourceOrderValid,
    normalizedOrder: normalized.length < 2 ? "single_or_empty" : "ascending",
    normalizedOutOfOrderCount,
    maximumObservedIntervalMs,
    medianObservedIntervalMs,
    missingIntervals,
    missingIntervalMethod: "median_observed_interval_diagnostic_only",
    reachesStart,
    reachesEnd,
    records: Object.freeze(normalized),
    sourceRecords: source,
  });
}

function v3Rows(payload) {
  return Array.isArray(payload?.data?.resultList) ? payload.data.resultList : [];
}

export async function collectScalpingFundingHistory({
  client,
  symbol,
  requestedStart,
  requestedEnd,
  category = "USDT-FUTURES",
  pageSize = 100,
  maxPages = 100,
  collectionCodeSHA = process.env.RESEARCH_CODE_SHA ?? null,
} = {}) {
  if (!client || typeof client.get !== "function") throw new TypeError("public client is required");
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/u.test(symbol)) throw new TypeError("invalid funding symbol");
  if (!Number.isSafeInteger(requestedStart) || !Number.isSafeInteger(requestedEnd) || requestedStart >= requestedEnd) throw new TypeError("invalid funding period");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RangeError("pageSize must be 1..100");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new RangeError("maxPages must be 1..100 for Bitget v3 page-number cursor contract");

  const rawRows = [];
  let cursor = 1;
  let providerExhausted = false;
  let reachedRequestedStart = false;
  let pagesRequested = 0;
  try {
    for (; cursor <= maxPages; cursor += 1) {
      pagesRequested += 1;
      const payload = await client.get(BITGET_ENDPOINTS.fundingHistoryV3, {
        category,
        symbol,
        limit: pageSize,
        cursor,
      });
      const rows = v3Rows(payload);
      if (rows.length === 0) {
        providerExhausted = true;
        break;
      }
      rawRows.push(...rows);
      const timestamps = rows.map((row) => Number(row?.fundingRateTimestamp)).filter(Number.isSafeInteger);
      if (timestamps.length > 0 && Math.min(...timestamps) <= requestedStart) {
        reachedRequestedStart = true;
        break;
      }
      if (rows.length < pageSize) {
        providerExhausted = true;
        break;
      }
    }
  } catch (error) {
    return Object.freeze({
      schemaVersion: SCALPING_FUNDING_SCHEMA_VERSION,
      status: "BLOCKED_DATA",
      market: "CRYPTO_FUTURES",
      symbol,
      provider: SCALPING_FUNDING_PROVIDER,
      providerVersion: SCALPING_FUNDING_PROVIDER_VERSION,
      providerApi: SCALPING_FUNDING_PROVIDER_API,
      category,
      requestedStart,
      requestedEnd,
      pageSize,
      maxPages,
      pagesRequested,
      pageCount: pagesRequested,
      cursorDirection: "increasing_page_number_to_older_history",
      diagnostics: Object.freeze({ reason: "funding_provider_request_failed", message: String(error?.message ?? error).slice(0, 1000) }),
      sourceRecords: Object.freeze([]),
      records: Object.freeze([]),
      rawDigest: null,
      normalizedDigest: null,
      provenanceDigest: null,
      collectionCodeSHA,
      syntheticDataUsed: false,
      interpolationUsed: false,
      privateApiUsed: false,
      orderSubmitted: false,
    });
  }

  const inspected = inspectFundingHistory({ records: rawRows, requestedStart, requestedEnd });
  const rawDigest = scalpingFundingDigest({ provider: SCALPING_FUNDING_PROVIDER, symbol, category, rows: inspected.sourceRecords });
  const normalizedDigest = scalpingFundingDigest({ symbol, category, records: inspected.records });
  const maxPagesReached = cursor > maxPages && !reachedRequestedStart;
  const status = inspected.status === "DATA_READY" ? "DATA_READY" : "BLOCKED_DATA";
  const baseArtifact = {
    schemaVersion: SCALPING_FUNDING_SCHEMA_VERSION,
    status,
    market: "CRYPTO_FUTURES",
    symbol,
    provider: SCALPING_FUNDING_PROVIDER,
    providerVersion: SCALPING_FUNDING_PROVIDER_VERSION,
    providerApi: SCALPING_FUNDING_PROVIDER_API,
    category,
    requestedStart,
    requestedEnd,
    pageSize,
    maxPages,
    pagesRequested,
    pageCount: pagesRequested,
    cursorDirection: "increasing_page_number_to_older_history",
    actualFirstFunding: inspected.actualFirstFunding,
    actualLastFunding: inspected.actualLastFunding,
    recordCount: inspected.recordCount,
    missingIntervals: inspected.missingIntervals,
    duplicateCount: inspected.duplicateCount,
    sourceOrder: inspected.sourceOrder,
    normalizedOrder: inspected.normalizedOrder,
    outOfOrderCount: inspected.normalizedOutOfOrderCount,
    maximumObservedIntervalMs: inspected.maximumObservedIntervalMs,
    medianObservedIntervalMs: inspected.medianObservedIntervalMs,
    reachesStart: inspected.reachesStart,
    reachesEnd: inspected.reachesEnd,
    providerExhausted,
    maxPagesReached,
    reachedRequestedStart,
    rawDigest,
    normalizedDigest,
    sourceRecords: inspected.sourceRecords,
    records: inspected.records,
    collectionCodeSHA,
    syntheticDataUsed: false,
    interpolationUsed: false,
    privateApiUsed: false,
    orderSubmitted: false,
  };
  const diagnostics = status === "DATA_READY" ? null : Object.freeze({
    reason: !inspected.reachesStart
      ? maxPagesReached ? "funding_cursor_limit_before_requested_start" : "funding_history_does_not_reach_requested_start"
      : !inspected.reachesEnd ? "funding_history_does_not_reach_requested_end"
        : inspected.duplicateCount > 0 ? "duplicate_funding_records"
          : inspected.sourceOrderValid === false ? "funding_source_order_invalid"
            : inspected.normalizedOutOfOrderCount > 0 ? "normalized_funding_order_invalid"
              : "funding_data_incomplete",
  });
  const provenanceDigest = scalpingFundingDigest(fundingProvenancePayload(baseArtifact));
  return Object.freeze({ ...baseArtifact, diagnostics, provenanceDigest });
}

export function assertScalpingFundingIntegrity(artifact) {
  if (!artifact || artifact.status !== "DATA_READY") throw new Error("SCALPING_FUNDING_NOT_READY");
  if (artifact.schemaVersion !== SCALPING_FUNDING_SCHEMA_VERSION
    || artifact.provider !== SCALPING_FUNDING_PROVIDER
    || artifact.providerVersion !== SCALPING_FUNDING_PROVIDER_VERSION
    || artifact.providerApi !== SCALPING_FUNDING_PROVIDER_API) {
    throw new Error("SCALPING_FUNDING_PROVENANCE_MISMATCH");
  }
  const expectedProvenance = scalpingFundingDigest(fundingProvenancePayload(artifact));
  if (expectedProvenance !== artifact.provenanceDigest) throw new Error("SCALPING_FUNDING_PROVENANCE_MISMATCH");
  const expectedRaw = scalpingFundingDigest({ provider: artifact.provider, symbol: artifact.symbol, category: artifact.category, rows: artifact.sourceRecords });
  if (expectedRaw !== artifact.rawDigest) throw new Error("SCALPING_FUNDING_RAW_CACHE_CORRUPTION");
  const expectedNormalized = scalpingFundingDigest({ symbol: artifact.symbol, category: artifact.category, records: artifact.records });
  if (expectedNormalized !== artifact.normalizedDigest) throw new Error("SCALPING_FUNDING_CACHE_CORRUPTION");
  if (artifact.sourceOrder !== "descending" && artifact.sourceOrder !== "single_or_empty") throw new Error("SCALPING_FUNDING_SOURCE_ORDER_VIOLATION");
  if (artifact.normalizedOrder !== "ascending" && artifact.normalizedOrder !== "single_or_empty") throw new Error("SCALPING_FUNDING_NORMALIZED_ORDER_VIOLATION");
  if (artifact.outOfOrderCount !== 0 || artifact.duplicateCount !== 0) throw new Error("SCALPING_FUNDING_ORDER_OR_DUPLICATE_VIOLATION");
  if (artifact.syntheticDataUsed !== false || artifact.interpolationUsed !== false || artifact.privateApiUsed !== false || artifact.orderSubmitted !== false) throw new Error("SCALPING_FUNDING_SAFETY_VIOLATION");
  return true;
}

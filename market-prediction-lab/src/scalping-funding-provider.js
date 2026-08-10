import { createHash } from "node:crypto";
import { BITGET_ENDPOINTS } from "./bitget-public-client.js";

export const SCALPING_FUNDING_SCHEMA_VERSION = 1;
export const SCALPING_FUNDING_PROVIDER = "bitget-public-v2";
export const SCALPING_FUNDING_PROVIDER_VERSION = "api-v2-history-fund-rate";
export const SCALPING_FUNDING_PROVIDER_API = BITGET_ENDPOINTS.fundingHistory;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function scalpingFundingDigest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizeRow(row) {
  const timestamp = Number(row?.fundingTime);
  const rate = Number(row?.fundingRate);
  if (!Number.isSafeInteger(timestamp) || !Number.isFinite(rate)) return null;
  return Object.freeze({ timestamp, rate });
}

export function inspectFundingHistory({ records, requestedStart, requestedEnd } = {}) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const orderedInput = records.map(normalizeRow).filter(Boolean);
  let duplicateCount = 0;
  let outOfOrderCount = 0;
  const seen = new Set();
  let previous = null;
  for (const row of orderedInput) {
    if (seen.has(row.timestamp)) duplicateCount += 1;
    seen.add(row.timestamp);
    if (previous != null && row.timestamp < previous) outOfOrderCount += 1;
    previous = row.timestamp;
  }
  const normalized = [...new Map(orderedInput.map((row) => [row.timestamp, row])).values()]
    .filter((row) => row.timestamp >= requestedStart && row.timestamp <= requestedEnd)
    .sort((a, b) => a.timestamp - b.timestamp);
  const actualFirstFunding = normalized[0]?.timestamp ?? null;
  const actualLastFunding = normalized.at(-1)?.timestamp ?? null;
  const deltas = normalized.slice(1).map((row, index) => row.timestamp - normalized[index].timestamp).filter((value) => value > 0);
  const maximumObservedIntervalMs = deltas.length ? Math.max(...deltas) : null;
  // Funding interval is contract-configurable (commonly 8h and may vary). Coverage is therefore
  // judged against the largest interval actually observed, never by synthesizing missing records.
  const edgeToleranceMs = maximumObservedIntervalMs ?? 8 * 60 * 60 * 1000;
  const reachesStart = actualFirstFunding != null && actualFirstFunding <= requestedStart + edgeToleranceMs;
  const reachesEnd = actualLastFunding != null && actualLastFunding >= requestedEnd - edgeToleranceMs;
  const valid = normalized.length > 0 && duplicateCount === 0 && reachesStart && reachesEnd;
  return Object.freeze({
    status: valid ? "DATA_READY" : "BLOCKED_DATA",
    requestedStart,
    requestedEnd,
    actualFirstFunding,
    actualLastFunding,
    recordCount: normalized.length,
    duplicateCount,
    outOfOrderCount,
    maximumObservedIntervalMs,
    reachesStart,
    reachesEnd,
    records: Object.freeze(normalized),
  });
}

export async function collectScalpingFundingHistory({
  client,
  symbol,
  requestedStart,
  requestedEnd,
  productType = "usdt-futures",
  pageSize = 100,
  maxPages = 200,
  collectionCodeSHA = process.env.RESEARCH_CODE_SHA ?? null,
} = {}) {
  if (!client || typeof client.get !== "function") throw new TypeError("public client is required");
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/u.test(symbol)) throw new TypeError("invalid funding symbol");
  if (!Number.isSafeInteger(requestedStart) || !Number.isSafeInteger(requestedEnd) || requestedStart >= requestedEnd) throw new TypeError("invalid funding period");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RangeError("pageSize must be 1..100");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) throw new RangeError("maxPages must be 1..500");

  const rawRows = [];
  let pageNo = 1;
  let providerExhausted = false;
  try {
    for (; pageNo <= maxPages; pageNo += 1) {
      const payload = await client.get(BITGET_ENDPOINTS.fundingHistory, { symbol, productType, pageSize, pageNo });
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      if (rows.length === 0) {
        providerExhausted = true;
        break;
      }
      rawRows.push(...rows);
      const timestamps = rows.map((row) => Number(row?.fundingTime)).filter(Number.isSafeInteger);
      if (timestamps.length > 0 && Math.min(...timestamps) <= requestedStart) break;
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
      requestedStart,
      requestedEnd,
      diagnostics: Object.freeze({ reason: "funding_provider_request_failed", message: String(error?.message ?? error).slice(0, 1000) }),
      records: Object.freeze([]),
      rawDigest: null,
      normalizedDigest: null,
      collectionCodeSHA,
      syntheticDataUsed: false,
      privateApiUsed: false,
      orderSubmitted: false,
    });
  }

  const rawDigest = scalpingFundingDigest({ provider: SCALPING_FUNDING_PROVIDER, symbol, productType, rows: rawRows });
  const inspected = inspectFundingHistory({ records: rawRows, requestedStart, requestedEnd });
  const normalizedDigest = scalpingFundingDigest({ symbol, productType, records: inspected.records });
  const maxPagesReached = pageNo > maxPages;
  const status = inspected.status === "DATA_READY" ? "DATA_READY" : "BLOCKED_DATA";
  return Object.freeze({
    schemaVersion: SCALPING_FUNDING_SCHEMA_VERSION,
    status,
    market: "CRYPTO_FUTURES",
    symbol,
    provider: SCALPING_FUNDING_PROVIDER,
    providerVersion: SCALPING_FUNDING_PROVIDER_VERSION,
    providerApi: SCALPING_FUNDING_PROVIDER_API,
    productType,
    requestedStart,
    requestedEnd,
    actualFirstFunding: inspected.actualFirstFunding,
    actualLastFunding: inspected.actualLastFunding,
    recordCount: inspected.recordCount,
    duplicateCount: inspected.duplicateCount,
    outOfOrderCount: inspected.outOfOrderCount,
    maximumObservedIntervalMs: inspected.maximumObservedIntervalMs,
    reachesStart: inspected.reachesStart,
    reachesEnd: inspected.reachesEnd,
    providerExhausted,
    maxPagesReached,
    pagesRequested: Math.min(pageNo, maxPages),
    rawDigest,
    normalizedDigest,
    records: inspected.records,
    collectionCodeSHA,
    syntheticDataUsed: false,
    privateApiUsed: false,
    orderSubmitted: false,
  });
}

export function assertScalpingFundingIntegrity(artifact) {
  if (!artifact || artifact.status !== "DATA_READY") throw new Error("SCALPING_FUNDING_NOT_READY");
  const expected = scalpingFundingDigest({ symbol: artifact.symbol, productType: artifact.productType, records: artifact.records });
  if (expected !== artifact.normalizedDigest) throw new Error("SCALPING_FUNDING_CACHE_CORRUPTION");
  if (artifact.syntheticDataUsed !== false || artifact.privateApiUsed !== false || artifact.orderSubmitted !== false) throw new Error("SCALPING_FUNDING_SAFETY_VIOLATION");
  return true;
}

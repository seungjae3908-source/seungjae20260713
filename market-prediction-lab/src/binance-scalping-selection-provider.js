import { createHash } from "node:crypto";
import { extractSingleCsvFromZip, parseVisionFunding, parseVisionKlines, buildMonthRange } from "./binance-vision-futures-archive.js";

const MONTHLY_BASE = "https://data.binance.vision/data/futures/um/monthly";
const INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_CONCURRENCY = 4;

export const BINANCE_SELECTION_PROVIDER = "binance-vision-usdm-monthly";
export const BINANCE_SELECTION_PROVIDER_VERSION = "public-data-archive-checksum-selection-v1";
export const BINANCE_SELECTION_SCHEMA_VERSION = 1;
export const BINANCE_SELECTION_TIMEFRAME = "15m";
export const BINANCE_LIVE_TAIL_BLOCKER = "BLOCKED_EXTERNAL_BINANCE_REST_GITHUB_RUNNER_LOCATION";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function binanceSelectionDigest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function assertSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/u.test(symbol)) throw new TypeError("invalid Binance selection symbol");
}

function assertPeriod(startTime, endTime) {
  if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime >= endTime) throw new TypeError("invalid Binance selection period");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseOrThrow(fetchImpl, url, retries = 4) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { "user-agent": "market-prediction-lab/0.9" } });
      if (response.ok) return response;
      const error = new Error(`Binance Vision HTTP ${response.status}: ${url}`);
      error.status = response.status;
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        lastError = error;
        await sleep(Math.min(500 * (2 ** attempt), 5000));
        continue;
      }
      throw error;
    } catch (error) {
      if ((error?.name === "AbortError" || error instanceof TypeError) && attempt < retries) {
        lastError = error;
        await sleep(Math.min(500 * (2 ** attempt), 5000));
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error(`Binance Vision request failed: ${url}`);
}

async function fetchVerifiedCsv(fetchImpl, url) {
  const checksumResponse = await responseOrThrow(fetchImpl, `${url}.CHECKSUM`);
  const checksumText = (await checksumResponse.text()).trim();
  const expected = checksumText.split(/\s+/u)[0]?.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expected ?? "")) throw new Error(`invalid Binance Vision checksum document: ${url}`);
  const zipResponse = await responseOrThrow(fetchImpl, url);
  const bytes = Buffer.from(await zipResponse.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`Binance Vision checksum mismatch: ${url}`);
  const extracted = extractSingleCsvFromZip(bytes);
  return Object.freeze({ text: extracted.text, sha256: actual, checksumUrl: `${url}.CHECKSUM` });
}

async function mapConcurrent(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => run()));
  return output;
}

async function collectMonthly({ fetchImpl, symbol, startTime, endTime, kind, concurrency }) {
  const months = [...buildMonthRange(startTime, endTime)];
  const entries = await mapConcurrent(months, concurrency, async (month) => {
    const file = kind === "klines" ? `${symbol}-15m-${month}.zip` : `${symbol}-fundingRate-${month}.zip`;
    const url = kind === "klines"
      ? `${MONTHLY_BASE}/klines/${symbol}/15m/${file}`
      : `${MONTHLY_BASE}/fundingRate/${symbol}/${file}`;
    const csv = await fetchVerifiedCsv(fetchImpl, url);
    const rows = kind === "klines" ? parseVisionKlines(csv.text, symbol) : parseVisionFunding(csv.text);
    return Object.freeze({ month, url, checksumUrl: csv.checksumUrl, sha256: csv.sha256, rowCount: rows.length, rows });
  });
  return Object.freeze({
    rows: Object.freeze(entries.flatMap((entry) => entry.rows)),
    manifests: Object.freeze(entries.map(({ rows, ...manifest }) => Object.freeze(manifest))),
  });
}

function uniqueSorted(rows, valueKeys) {
  const map = new Map();
  let duplicateCount = 0;
  for (const row of rows) {
    const previous = map.get(row.timestamp);
    if (previous) {
      duplicateCount += 1;
      if (valueKeys.some((key) => previous[key] !== row[key])) throw new Error(`conflicting Binance selection rows at ${row.timestamp}`);
    }
    map.set(row.timestamp, row);
  }
  return Object.freeze({ rows: Object.freeze([...map.values()].sort((a, b) => a.timestamp - b.timestamp)), duplicateCount });
}

export function inspectSelectionCandles({ candles, requestedSelectionStart, requestedSelectionEnd } = {}) {
  if (!Array.isArray(candles)) throw new TypeError("candles must be an array");
  assertPeriod(requestedSelectionStart, requestedSelectionEnd);
  const eligible = candles
    .filter((row) => row.timestamp >= requestedSelectionStart && row.timestamp + INTERVAL_MS <= requestedSelectionEnd)
    .sort((a, b) => a.timestamp - b.timestamp);
  let missingCandleCount = 0;
  let gapCount = 0;
  let maximumGap = 0;
  let outOfOrderCount = 0;
  const seen = new Set();
  let duplicateCount = 0;
  for (let index = 0; index < eligible.length; index += 1) {
    const row = eligible[index];
    if (seen.has(row.timestamp)) duplicateCount += 1;
    seen.add(row.timestamp);
    if (index === 0) continue;
    const delta = row.timestamp - eligible[index - 1].timestamp;
    if (delta <= 0) outOfOrderCount += 1;
    if (delta > INTERVAL_MS) {
      const missing = Math.max(0, Math.round(delta / INTERVAL_MS) - 1);
      missingCandleCount += missing;
      gapCount += 1;
      maximumGap = Math.max(maximumGap, delta - INTERVAL_MS);
    }
  }
  const expectedCandleCount = Math.max(0, Math.floor((requestedSelectionEnd - requestedSelectionStart) / INTERVAL_MS));
  const actualFirstCandle = eligible[0]?.timestamp ?? null;
  const actualLastCandle = eligible.at(-1)?.timestamp ?? null;
  const reachesStart = actualFirstCandle === requestedSelectionStart;
  const reachesEnd = actualLastCandle != null && actualLastCandle >= requestedSelectionEnd - (2 * INTERVAL_MS);
  const status = eligible.length === expectedCandleCount
    && missingCandleCount === 0
    && gapCount === 0
    && duplicateCount === 0
    && outOfOrderCount === 0
    && reachesStart
    && reachesEnd
    ? "DATA_READY"
    : "BLOCKED_PROVIDER_COVERAGE";
  return Object.freeze({ status, actualFirstCandle, actualLastCandle, expectedCandleCount, actualCandleCount: eligible.length, missingCandleCount, gapCount, maximumGap, duplicateCount, outOfOrderCount, candles: Object.freeze(eligible) });
}

export function inspectSelectionFunding({ records, requestedSelectionStart, requestedSelectionEnd } = {}) {
  if (!Array.isArray(records)) throw new TypeError("funding records must be an array");
  assertPeriod(requestedSelectionStart, requestedSelectionEnd);
  const source = records.filter((row) => Number.isSafeInteger(row?.timestamp) && Number.isFinite(row?.rate));
  const unique = uniqueSorted(source, ["rate"]);
  const normalized = unique.rows.filter((row) => row.timestamp >= requestedSelectionStart && row.timestamp <= requestedSelectionEnd);
  const deltas = normalized.slice(1).map((row, index) => row.timestamp - normalized[index].timestamp).filter((value) => value > 0);
  const sortedDeltas = [...deltas].sort((a, b) => a - b);
  const medianObservedIntervalMs = sortedDeltas.length ? sortedDeltas[Math.floor(sortedDeltas.length / 2)] : null;
  const maximumObservedIntervalMs = sortedDeltas.length ? sortedDeltas.at(-1) : null;
  const fundingMissingIntervals = medianObservedIntervalMs ? deltas.reduce((sum, delta) => sum + Math.max(0, Math.round(delta / medianObservedIntervalMs) - 1), 0) : 0;
  const edgeTolerance = maximumObservedIntervalMs ?? 8 * 60 * 60 * 1000;
  const actualFirstFunding = normalized[0]?.timestamp ?? null;
  const actualLastFunding = normalized.at(-1)?.timestamp ?? null;
  const reachesStart = actualFirstFunding != null && actualFirstFunding <= requestedSelectionStart + edgeTolerance;
  const reachesEnd = actualLastFunding != null && actualLastFunding >= requestedSelectionEnd - edgeTolerance;
  let fundingOutOfOrderCount = 0;
  for (let index = 1; index < normalized.length; index += 1) if (normalized[index].timestamp <= normalized[index - 1].timestamp) fundingOutOfOrderCount += 1;
  const status = normalized.length > 0 && unique.duplicateCount === 0 && fundingOutOfOrderCount === 0 && fundingMissingIntervals === 0 && reachesStart && reachesEnd
    ? "DATA_READY"
    : "BLOCKED_PROVIDER_COVERAGE";
  return Object.freeze({ status, actualFirstFunding, actualLastFunding, fundingRecordCount: normalized.length, fundingMissingIntervals, fundingDuplicateCount: unique.duplicateCount, fundingOutOfOrderCount, medianObservedIntervalMs, maximumObservedIntervalMs, records: Object.freeze(normalized) });
}

export async function collectBinanceSelectionDataset({ symbol, requestedSelectionStart, requestedSelectionEnd, collectionCodeSHA, fetchImpl = globalThis.fetch, concurrency = DEFAULT_CONCURRENCY } = {}) {
  assertSymbol(symbol);
  assertPeriod(requestedSelectionStart, requestedSelectionEnd);
  if (!/^[0-9a-f]{40}$/iu.test(collectionCodeSHA ?? "")) throw new TypeError("collectionCodeSHA must be immutable SHA");
  const monthlyKlines = await collectMonthly({ fetchImpl, symbol, startTime: requestedSelectionStart, endTime: requestedSelectionEnd, kind: "klines", concurrency });
  const monthlyFunding = await collectMonthly({ fetchImpl, symbol, startTime: requestedSelectionStart, endTime: requestedSelectionEnd, kind: "funding", concurrency });
  const mergedKlines = uniqueSorted(monthlyKlines.rows, ["open", "high", "low", "close", "volume"]);
  const mergedFunding = uniqueSorted(monthlyFunding.rows, ["rate"]);
  const candle = inspectSelectionCandles({ candles: mergedKlines.rows, requestedSelectionStart, requestedSelectionEnd });
  const funding = inspectSelectionFunding({ records: mergedFunding.rows, requestedSelectionStart, requestedSelectionEnd });
  const monthlyArchiveCount = monthlyKlines.manifests.length + monthlyFunding.manifests.length;
  const checksumVerifiedCount = monthlyArchiveCount;
  const checksumFailureCount = 0;
  const rawCandleDigest = binanceSelectionDigest({ symbol, manifests: monthlyKlines.manifests });
  const normalizedCandleDigest = binanceSelectionDigest({ symbol, candles: candle.candles });
  const rawFundingDigest = binanceSelectionDigest({ symbol, manifests: monthlyFunding.manifests });
  const normalizedFundingDigest = binanceSelectionDigest({ symbol, funding: funding.records });
  const selectionDataStatus = candle.status === "DATA_READY" && funding.status === "DATA_READY" ? "DATA_READY" : "BLOCKED_PROVIDER_COVERAGE";
  const audit = Object.freeze({
    schemaVersion: BINANCE_SELECTION_SCHEMA_VERSION,
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe: BINANCE_SELECTION_TIMEFRAME,
    provider: BINANCE_SELECTION_PROVIDER,
    providerVersion: BINANCE_SELECTION_PROVIDER_VERSION,
    collectionCodeSHA,
    providerBoundary: "SAME_VENUE_BINANCE_USDM",
    priceVenue: "BINANCE_USDM",
    fundingVenue: "BINANCE_USDM",
    crossVenueMix: false,
    compatibilityVerdict: "same_venue_price_and_funding_no_cross_venue_mix",
    selectionDataStatus,
    finalHoldoutDataStatus: "LOCKED_NOT_EVALUATED",
    liveTailStatus: BINANCE_LIVE_TAIL_BLOCKER,
    requestedSelectionStart,
    requestedSelectionEnd,
    actualFirstCandle: candle.actualFirstCandle,
    actualLastCandle: candle.actualLastCandle,
    expectedCandleCount: candle.expectedCandleCount,
    actualCandleCount: candle.actualCandleCount,
    missingCandleCount: candle.missingCandleCount,
    gapCount: candle.gapCount,
    maximumGap: candle.maximumGap,
    duplicateCount: candle.duplicateCount + mergedKlines.duplicateCount,
    outOfOrderCount: candle.outOfOrderCount,
    actualFirstFunding: funding.actualFirstFunding,
    actualLastFunding: funding.actualLastFunding,
    fundingRecordCount: funding.fundingRecordCount,
    fundingMissingIntervals: funding.fundingMissingIntervals,
    fundingDuplicateCount: funding.fundingDuplicateCount + mergedFunding.duplicateCount,
    fundingOutOfOrderCount: funding.fundingOutOfOrderCount,
    monthlyArchiveCount,
    checksumVerifiedCount,
    checksumFailureCount,
    rawCandleDigest,
    normalizedCandleDigest,
    rawFundingDigest,
    normalizedFundingDigest,
    sourcePattern: Object.freeze({ monthlyKlines: `${MONTHLY_BASE}/klines/{symbol}/15m/{symbol}-15m-{YYYY-MM}.zip`, monthlyFunding: `${MONTHLY_BASE}/fundingRate/{symbol}/{symbol}-fundingRate-{YYYY-MM}.zip`, checksumSuffix: ".CHECKSUM" }),
    syntheticDataUsed: false,
    interpolationUsed: false,
    privateApiUsed: false,
    orderSubmitted: false,
    finalHoldoutRead: false,
  });
  return Object.freeze({ audit, candles: candle.candles, fundingRates: funding.records });
}

import { createHash } from "node:crypto";
import { extractSingleCsvFromZip, parseVisionFunding, parseVisionKlines, buildMonthRange, buildDayRange } from "./binance-vision-futures-archive.js";
import { BinanceFuturesPublicClient, collectBinanceFuturesFundingRates } from "./binance-futures-history.js";

const MONTHLY_BASE = "https://data.binance.vision/data/futures/um/monthly";
const DAILY_BASE = "https://data.binance.vision/data/futures/um/daily";
const INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_CONCURRENCY = 4;

export const BINANCE_SCALPING_PROVIDER = "binance-vision-usdm";
export const BINANCE_SCALPING_PROVIDER_VERSION = "public-data-archive-checksum+fapi-funding-tail-v1";
export const BINANCE_SCALPING_TIMEFRAME = "15m";
export const BINANCE_SCALPING_SCHEMA_VERSION = 1;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function binanceScalpingDigest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function assertSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/u.test(symbol)) throw new TypeError("invalid Binance scalping symbol");
  return symbol;
}

function assertPeriod(startTime, endTime) {
  if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime >= endTime) throw new TypeError("invalid Binance scalping period");
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
  return Object.freeze({ text: extracted.text, fileName: extracted.fileName, sha256: actual, checksumUrl: `${url}.CHECKSUM` });
}

function previousMonthEnd(endTime) {
  const end = new Date(endTime);
  return Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1) - 1;
}

function currentMonthStart(endTime) {
  const end = new Date(endTime);
  return Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);
}

function uniqueSorted(rows, valueKeys) {
  const map = new Map();
  let duplicateCount = 0;
  for (const row of rows) {
    const previous = map.get(row.timestamp);
    if (previous) {
      duplicateCount += 1;
      if (valueKeys.some((key) => previous[key] !== row[key])) throw new Error(`conflicting Binance same-venue rows at ${row.timestamp}`);
    }
    map.set(row.timestamp, row);
  }
  return Object.freeze({ rows: Object.freeze([...map.values()].sort((a, b) => a.timestamp - b.timestamp)), duplicateCount });
}

async function mapConcurrent(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => run()));
  return output;
}

async function collectMonthlyKlines({ fetchImpl, symbol, startTime, endTime, concurrency }) {
  if (endTime < startTime) return Object.freeze({ rows: Object.freeze([]), manifests: Object.freeze([]) });
  const months = [...buildMonthRange(startTime, endTime)];
  const entries = await mapConcurrent(months, concurrency, async (month) => {
    const file = `${symbol}-15m-${month}.zip`;
    const url = `${MONTHLY_BASE}/klines/${symbol}/15m/${file}`;
    const csv = await fetchVerifiedCsv(fetchImpl, url);
    return Object.freeze({ month, url, checksumUrl: csv.checksumUrl, sha256: csv.sha256, rows: parseVisionKlines(csv.text, symbol) });
  });
  return Object.freeze({ rows: Object.freeze(entries.flatMap((entry) => entry.rows)), manifests: Object.freeze(entries.map(({ rows, ...manifest }) => Object.freeze({ ...manifest, rowCount: rows.length }))) });
}

async function collectDailyKlines({ fetchImpl, symbol, startTime, endTime, concurrency }) {
  if (endTime < startTime) return Object.freeze({ rows: Object.freeze([]), manifests: Object.freeze([]) });
  const days = [...buildDayRange(startTime, endTime)];
  const entries = await mapConcurrent(days, concurrency, async (day) => {
    const file = `${symbol}-15m-${day}.zip`;
    const url = `${DAILY_BASE}/klines/${symbol}/15m/${file}`;
    const csv = await fetchVerifiedCsv(fetchImpl, url);
    return Object.freeze({ day, url, checksumUrl: csv.checksumUrl, sha256: csv.sha256, rows: parseVisionKlines(csv.text, symbol) });
  });
  return Object.freeze({ rows: Object.freeze(entries.flatMap((entry) => entry.rows)), manifests: Object.freeze(entries.map(({ rows, ...manifest }) => Object.freeze({ ...manifest, rowCount: rows.length }))) });
}

async function collectMonthlyFunding({ fetchImpl, symbol, startTime, endTime, concurrency }) {
  if (endTime < startTime) return Object.freeze({ rows: Object.freeze([]), manifests: Object.freeze([]) });
  const months = [...buildMonthRange(startTime, endTime)];
  const entries = await mapConcurrent(months, concurrency, async (month) => {
    const file = `${symbol}-fundingRate-${month}.zip`;
    const url = `${MONTHLY_BASE}/fundingRate/${symbol}/${file}`;
    const csv = await fetchVerifiedCsv(fetchImpl, url);
    return Object.freeze({ month, url, checksumUrl: csv.checksumUrl, sha256: csv.sha256, rows: parseVisionFunding(csv.text) });
  });
  return Object.freeze({ rows: Object.freeze(entries.flatMap((entry) => entry.rows)), manifests: Object.freeze(entries.map(({ rows, ...manifest }) => Object.freeze({ ...manifest, rowCount: rows.length }))) });
}

export function inspectBinanceScalpingCandles({ candles, requestedStart, requestedEnd } = {}) {
  if (!Array.isArray(candles)) throw new TypeError("candles must be an array");
  assertPeriod(requestedStart, requestedEnd);
  const eligible = candles.filter((row) => row.timestamp >= requestedStart && row.timestamp + INTERVAL_MS <= requestedEnd).sort((a, b) => a.timestamp - b.timestamp);
  let duplicateCount = 0;
  let outOfOrderCount = 0;
  let missingCandleCount = 0;
  let gapCount = 0;
  let maximumGap = 0;
  const seen = new Set();
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
  const expectedCandleCount = Math.max(0, Math.floor((requestedEnd - requestedStart) / INTERVAL_MS));
  const actualFirstCandle = eligible[0]?.timestamp ?? null;
  const actualLastCandle = eligible.at(-1)?.timestamp ?? null;
  const reachesStart = actualFirstCandle != null && actualFirstCandle <= requestedStart;
  const reachesEnd = actualLastCandle != null && actualLastCandle + INTERVAL_MS <= requestedEnd && actualLastCandle >= requestedEnd - (2 * INTERVAL_MS);
  const status = eligible.length === expectedCandleCount && missingCandleCount === 0 && gapCount === 0 && duplicateCount === 0 && outOfOrderCount === 0 && reachesStart && reachesEnd ? "DATA_READY" : "BLOCKED_DATA";
  return Object.freeze({
    status,
    requestedStart,
    requestedEnd,
    actualFirstCandle,
    actualLastCandle,
    expectedCandleCount,
    actualCandleCount: eligible.length,
    missingCandleCount,
    gapCount,
    maximumGap,
    duplicateCount,
    outOfOrderCount,
    expectedCandleCountPolicy: "count_only_intervals_with_close_time_lte_requested_end",
    openBoundaryCandleExcluded: true,
    candles: Object.freeze(eligible),
  });
}

export function inspectBinanceScalpingFunding({ records, requestedStart, requestedEnd } = {}) {
  if (!Array.isArray(records)) throw new TypeError("funding records must be an array");
  assertPeriod(requestedStart, requestedEnd);
  const source = records.filter((row) => Number.isSafeInteger(row?.timestamp) && Number.isFinite(row?.rate));
  const unique = uniqueSorted(source, ["rate"]);
  const normalized = unique.rows.filter((row) => row.timestamp >= requestedStart && row.timestamp <= requestedEnd);
  const deltas = normalized.slice(1).map((row, index) => row.timestamp - normalized[index].timestamp).filter((value) => value > 0);
  const sortedDeltas = [...deltas].sort((a, b) => a - b);
  const medianObservedIntervalMs = sortedDeltas.length ? sortedDeltas[Math.floor(sortedDeltas.length / 2)] : null;
  const maximumObservedIntervalMs = sortedDeltas.length ? sortedDeltas.at(-1) : null;
  const missingIntervals = medianObservedIntervalMs ? deltas.reduce((sum, delta) => sum + Math.max(0, Math.round(delta / medianObservedIntervalMs) - 1), 0) : 0;
  const edgeTolerance = maximumObservedIntervalMs ?? 8 * 60 * 60 * 1000;
  const actualFirstFunding = normalized[0]?.timestamp ?? null;
  const actualLastFunding = normalized.at(-1)?.timestamp ?? null;
  const reachesStart = actualFirstFunding != null && actualFirstFunding <= requestedStart + edgeTolerance;
  const reachesEnd = actualLastFunding != null && actualLastFunding >= requestedEnd - edgeTolerance;
  let outOfOrderCount = 0;
  for (let index = 1; index < normalized.length; index += 1) if (normalized[index].timestamp <= normalized[index - 1].timestamp) outOfOrderCount += 1;
  const status = normalized.length > 0 && unique.duplicateCount === 0 && outOfOrderCount === 0 && missingIntervals === 0 && reachesStart && reachesEnd ? "DATA_READY" : "BLOCKED_DATA";
  return Object.freeze({
    status,
    requestedStart,
    requestedEnd,
    actualFirstFunding,
    actualLastFunding,
    fundingRecordCount: normalized.length,
    fundingMissingIntervals: missingIntervals,
    fundingDuplicateCount: unique.duplicateCount,
    fundingOutOfOrderCount: outOfOrderCount,
    medianObservedIntervalMs,
    maximumObservedIntervalMs,
    reachesStart,
    reachesEnd,
    records: Object.freeze(normalized),
  });
}

export async function collectBinanceSameVenueScalpingDataset({
  symbol,
  requestedStart,
  requestedEnd,
  collectionCodeSHA,
  fetchImpl = globalThis.fetch,
  restClient = null,
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  assertSymbol(symbol);
  assertPeriod(requestedStart, requestedEnd);
  if (!/^[0-9a-f]{40}$/iu.test(collectionCodeSHA ?? "")) throw new TypeError("collectionCodeSHA must be immutable SHA");
  const lastFullMonthEnd = previousMonthEnd(requestedEnd);
  const tailStart = Math.max(requestedStart, currentMonthStart(requestedEnd));
  const monthlyEnd = Math.min(requestedEnd, lastFullMonthEnd);
  const monthlyKlines = await collectMonthlyKlines({ fetchImpl, symbol, startTime: requestedStart, endTime: monthlyEnd, concurrency });
  const dailyKlines = await collectDailyKlines({ fetchImpl, symbol, startTime: tailStart, endTime: requestedEnd, concurrency });
  const mergedKlines = uniqueSorted([...monthlyKlines.rows, ...dailyKlines.rows], ["open", "high", "low", "close", "volume"]);
  const candleDiagnostics = inspectBinanceScalpingCandles({ candles: mergedKlines.rows, requestedStart, requestedEnd });

  const monthlyFunding = await collectMonthlyFunding({ fetchImpl, symbol, startTime: requestedStart, endTime: monthlyEnd, concurrency });
  const client = restClient ?? new BinanceFuturesPublicClient({ fetchImpl });
  const tailFunding = await collectBinanceFuturesFundingRates({ client, symbol, startTime: tailStart, endTime: requestedEnd });
  const mergedFunding = uniqueSorted([...monthlyFunding.rows, ...tailFunding.records], ["rate"]);
  const fundingDiagnostics = inspectBinanceScalpingFunding({ records: mergedFunding.rows, requestedStart, requestedEnd });

  const priceManifests = Object.freeze([...monthlyKlines.manifests, ...dailyKlines.manifests]);
  const fundingManifests = monthlyFunding.manifests;
  const rawDigest = binanceScalpingDigest({ symbol, requestedStart, requestedEnd, priceManifests, fundingManifests, tailFundingRecords: tailFunding.records });
  const normalizedDigest = binanceScalpingDigest({ symbol, candles: candleDiagnostics.candles, funding: fundingDiagnostics.records });
  const providerBoundary = Object.freeze({
    providerBoundary: "SAME_VENUE_BINANCE_USDM",
    priceVenue: "BINANCE_USDM",
    fundingVenue: "BINANCE_USDM",
    compatibilityVerdict: "same_venue_price_and_funding_no_cross_venue_mix",
  });
  const status = candleDiagnostics.status === "DATA_READY" && fundingDiagnostics.status === "DATA_READY" ? "DATA_READY" : "BLOCKED_DATA";
  const audit = Object.freeze({
    schemaVersion: BINANCE_SCALPING_SCHEMA_VERSION,
    status,
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe: BINANCE_SCALPING_TIMEFRAME,
    provider: BINANCE_SCALPING_PROVIDER,
    providerVersion: BINANCE_SCALPING_PROVIDER_VERSION,
    sourcePattern: Object.freeze({
      monthlyKlines: `${MONTHLY_BASE}/klines/{symbol}/15m/{symbol}-15m-{YYYY-MM}.zip`,
      dailyKlines: `${DAILY_BASE}/klines/{symbol}/15m/{symbol}-15m-{YYYY-MM-DD}.zip`,
      monthlyFunding: `${MONTHLY_BASE}/fundingRate/{symbol}/{symbol}-fundingRate-{YYYY-MM}.zip`,
      fundingTailApi: "/fapi/v1/fundingRate",
      checksumSuffix: ".CHECKSUM",
    }),
    checksumMechanism: "SHA256 sibling .CHECKSUM for Binance Vision ZIP archives",
    collectionCodeSHA,
    ...providerBoundary,
    requestedStart,
    requestedEnd,
    actualFirstCandle: candleDiagnostics.actualFirstCandle,
    actualLastCandle: candleDiagnostics.actualLastCandle,
    expectedCandleCount: candleDiagnostics.expectedCandleCount,
    actualCandleCount: candleDiagnostics.actualCandleCount,
    missingCandleCount: candleDiagnostics.missingCandleCount,
    gapCount: candleDiagnostics.gapCount,
    maximumGap: candleDiagnostics.maximumGap,
    duplicateCount: candleDiagnostics.duplicateCount + mergedKlines.duplicateCount,
    outOfOrderCount: candleDiagnostics.outOfOrderCount,
    expectedCandleCountPolicy: candleDiagnostics.expectedCandleCountPolicy,
    openBoundaryCandleExcluded: true,
    actualFirstFunding: fundingDiagnostics.actualFirstFunding,
    actualLastFunding: fundingDiagnostics.actualLastFunding,
    fundingRecordCount: fundingDiagnostics.fundingRecordCount,
    fundingMissingIntervals: fundingDiagnostics.fundingMissingIntervals,
    fundingDuplicateCount: fundingDiagnostics.fundingDuplicateCount + mergedFunding.duplicateCount,
    fundingOutOfOrderCount: fundingDiagnostics.fundingOutOfOrderCount,
    medianObservedFundingIntervalMs: fundingDiagnostics.medianObservedIntervalMs,
    maximumObservedFundingIntervalMs: fundingDiagnostics.maximumObservedIntervalMs,
    priceArchiveCount: priceManifests.length,
    fundingArchiveCount: fundingManifests.length,
    priceArchives: priceManifests,
    fundingArchives: fundingManifests,
    fundingTailRecordCount: tailFunding.records.length,
    rawDigest,
    normalizedDigest,
    syntheticDataUsed: false,
    interpolationUsed: false,
    privateApiUsed: false,
    orderSubmitted: false,
  });
  return Object.freeze({ audit, candles: candleDiagnostics.candles, fundingRates: fundingDiagnostics.records });
}

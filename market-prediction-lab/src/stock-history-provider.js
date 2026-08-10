import { buildHistoricalDataset } from "./long-history-data-layer.js";
import { buildHistoricalCacheProvenance } from "./research-cache-provenance.js";

export const STOCK_HISTORY_PROVIDER_SCHEMA_VERSION = 1;
export const KR_FSC_STOCK_PROVIDER = "kr-fsc-data-go-kr-stock-price-v1";
export const US_ALPHA_VANTAGE_RAW_PROVIDER = "us-alpha-vantage-daily-raw-v1";
export const US_ALPHA_VANTAGE_ADJUSTED_PROVIDER = "us-alpha-vantage-daily-adjusted-v1";

const DAY_MS = 24 * 60 * 60 * 1000;
const FSC_BASE_URL = "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
const ALPHA_VANTAGE_BASE_URL = "https://www.alphavantage.co/query";
const STOCK_RESEARCH_SAFETY = Object.freeze({
  liveOrderAllowed: false,
  privateAccountRequestAllowed: false,
  orderSubmitted: false,
});

function assertFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  return fetchImpl;
}

function assertKey(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}_MISSING`);
  return value.trim();
}

function assertResearchCodeSha(value) {
  if (!/^[0-9a-f]{40}$/iu.test(value ?? "")) throw new TypeError("researchCodeSha must be an immutable 40-character SHA");
  return value.toLowerCase();
}

function assertStockSymbol(symbol, market) {
  if (typeof symbol !== "string" || !symbol.trim()) throw new TypeError("symbol is required");
  const normalized = symbol.trim().toUpperCase();
  if (market === "KR_STOCK" && !/^\d{6}$/u.test(normalized)) throw new TypeError("KR stock symbol must be a 6 digit short code");
  if (market === "US_STOCK" && !/^[A-Z0-9.\-]{1,20}$/u.test(normalized)) throw new TypeError("US stock symbol is invalid");
  return normalized;
}

function assertRange(start, end) {
  if (!Number.isSafeInteger(start) || start <= 0) throw new TypeError("requestedStart must be a positive integer timestamp");
  if (!Number.isSafeInteger(end) || end <= 0) throw new TypeError("requestedEnd must be a positive integer timestamp");
  if (end < start) throw new RangeError("requestedEnd must be >= requestedStart");
}

function yyyymmdd(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) throw new TypeError("invalid timestamp");
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function isoDateToUtc(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError(`invalid ISO date: ${value}`);
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isSafeInteger(timestamp)) throw new TypeError(`invalid ISO date: ${value}`);
  return timestamp;
}

function fscDateToUtc(value) {
  const text = String(value ?? "");
  if (!/^\d{8}$/u.test(text)) throw new Error(`KR_FSC_INVALID_BASE_DATE:${text}`);
  return isoDateToUtc(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`);
}

function finiteNumber(value, label, { positive = false, nonNegative = false } = {}) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").replaceAll(",", ""));
  if (!Number.isFinite(number)) throw new Error(`${label}_INVALID_NUMBER`);
  if (positive && number <= 0) throw new Error(`${label}_NON_POSITIVE`);
  if (nonNegative && number < 0) throw new Error(`${label}_NEGATIVE`);
  return number;
}

function isClosedDailyTimestamp(timestamp, generatedAt) {
  return Number.isSafeInteger(timestamp) && Number.isSafeInteger(generatedAt) && timestamp + DAY_MS <= generatedAt;
}

function assertProviderRowOrder(timestamps, { duplicateCode, outOfOrderCode }) {
  const seen = new Set();
  let previous = null;
  let direction = 0;
  for (const timestamp of timestamps) {
    if (seen.has(timestamp)) throw new Error(`${duplicateCode}:${timestamp}`);
    seen.add(timestamp);
    if (previous != null) {
      const nextDirection = timestamp > previous ? 1 : -1;
      if (direction === 0) direction = nextDirection;
      else if (direction !== nextDirection) throw new Error(`${outOfOrderCode}:${timestamp}`);
    }
    previous = timestamp;
  }
}

function buildCollectionProvenance({
  provider,
  providerVersion,
  source,
  market,
  symbol,
  requestedStart,
  requestedEnd,
  generatedAt,
  adjustmentMode,
  corporateActions,
  survivorshipSafeguard,
  outOfRangeCandleCountDropped,
  openCandleCountDropped,
}) {
  return Object.freeze({
    schemaVersion: 1,
    provider,
    providerVersion,
    source,
    market,
    symbol,
    timeframe: "1d",
    requestedStart,
    requestedEnd,
    generatedAt,
    adjustmentMode,
    corporateActions,
    survivorshipSafeguard,
    closedCandlesOnly: true,
    duplicatePolicy: "fail_closed",
    outOfOrderPolicy: "fail_closed",
    invalidOhlcPolicy: "fail_closed",
    outOfRangePolicy: "drop",
    openCandlePolicy: "drop",
    outOfRangeCandleCountDropped,
    openCandleCountDropped,
    credentialValueExposed: false,
    privateApiUsed: false,
    syntheticDataUsed: false,
  });
}

function normalizeFscBody(payload) {
  const response = payload?.response ?? payload;
  const header = response?.header ?? {};
  const resultCode = String(header.resultCode ?? "00");
  if (resultCode !== "00" && resultCode !== "0") throw new Error(`KR_FSC_PROVIDER_ERROR:${resultCode}`);
  const body = response?.body ?? {};
  const rawItems = body?.items?.item ?? body?.items ?? [];
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  return {
    items,
    totalCount: Number.isFinite(Number(body.totalCount)) ? Number(body.totalCount) : items.length,
    pageNo: Number.isFinite(Number(body.pageNo)) ? Number(body.pageNo) : 1,
    numOfRows: Number.isFinite(Number(body.numOfRows)) ? Number(body.numOfRows) : items.length,
  };
}

export function normalizeKrFscStockItem(item, { symbol, observedAt }) {
  const shortCode = String(item?.srtnCd ?? "").trim();
  if (shortCode !== symbol) throw new Error(`KR_FSC_SYMBOL_MISMATCH:${shortCode}`);
  const timestamp = fscDateToUtc(item.basDt);
  const open = finiteNumber(item.mkp, "KR_FSC_OPEN", { positive: true });
  const high = finiteNumber(item.hipr, "KR_FSC_HIGH", { positive: true });
  const low = finiteNumber(item.lopr, "KR_FSC_LOW", { positive: true });
  const close = finiteNumber(item.clpr, "KR_FSC_CLOSE", { positive: true });
  const volume = finiteNumber(item.trqu ?? 0, "KR_FSC_VOLUME", { nonNegative: true });
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) throw new Error(`KR_FSC_INVALID_OHLC:${item.basDt}`);
  return Object.freeze({ timestamp, open, high, low, close, volume, isClosed: true, observedAt });
}

export function buildStockHistoryProviderCapability({ market, env = process.env } = {}) {
  if (market === "KR_STOCK") {
    const configured = typeof env.KR_FSC_OPEN_DATA_SERVICE_KEY === "string" && env.KR_FSC_OPEN_DATA_SERVICE_KEY.trim().length > 0;
    return Object.freeze({
      schemaVersion: STOCK_HISTORY_PROVIDER_SCHEMA_VERSION,
      market,
      provider: KR_FSC_STOCK_PROVIDER,
      providerVersion: "GetStockSecuritiesInfoService/getStockPriceInfo",
      adjustmentMode: "none",
      status: configured ? "configured" : "blocked_provider",
      credentialEnvironmentVariable: "KR_FSC_OPEN_DATA_SERVICE_KEY",
      credentialPresent: configured,
      credentialValueExposed: false,
      sourceAuthority: "Financial Services Commission / Korea Exchange linked public data",
      dailyHistoryAvailable: true,
      corporateActionAdjustmentAvailable: false,
      corporateActions: "unverified",
      survivorshipSafeguard: "unverified",
      survivorshipSafeguardAvailable: false,
      selectionReady: configured,
      finalHoldoutReady: false,
      reason: configured ? "daily_ohlcv_ready_corporate_action_provenance_still_required" : "missing_public_data_service_key",
      privateApiRequired: false,
      ...STOCK_RESEARCH_SAFETY,
    });
  }
  if (market === "US_STOCK") {
    const configured = typeof env.ALPHA_VANTAGE_API_KEY === "string" && env.ALPHA_VANTAGE_API_KEY.trim().length > 0;
    const adjusted = String(env.ALPHA_VANTAGE_USE_DAILY_ADJUSTED ?? "").toLowerCase() === "true";
    return Object.freeze({
      schemaVersion: STOCK_HISTORY_PROVIDER_SCHEMA_VERSION,
      market,
      provider: adjusted ? US_ALPHA_VANTAGE_ADJUSTED_PROVIDER : US_ALPHA_VANTAGE_RAW_PROVIDER,
      providerVersion: adjusted ? "TIME_SERIES_DAILY_ADJUSTED" : "TIME_SERIES_DAILY",
      adjustmentMode: adjusted ? "adjusted_close_ratio_with_split_volume" : "none",
      status: configured ? "configured" : "blocked_provider",
      credentialEnvironmentVariable: "ALPHA_VANTAGE_API_KEY",
      credentialPresent: configured,
      credentialValueExposed: false,
      sourceAuthority: "Alpha Vantage",
      dailyHistoryAvailable: true,
      corporateActionAdjustmentAvailable: adjusted,
      corporateActions: adjusted ? "verified_provider_events" : "unverified",
      survivorshipSafeguard: "unverified",
      survivorshipSafeguardAvailable: false,
      selectionReady: configured,
      finalHoldoutReady: false,
      reason: configured
        ? adjusted
          ? "adjusted_daily_available_survivorship_provenance_still_required"
          : "raw_daily_corporate_actions_unverified_final_holdout_forbidden"
        : "missing_alpha_vantage_api_key",
      privateApiRequired: false,
      ...STOCK_RESEARCH_SAFETY,
    });
  }
  throw new TypeError(`unsupported stock history market: ${market}`);
}

export function buildStockAutomatedResearchProviderCapability({ market, env = process.env } = {}) {
  const capability = buildStockHistoryProviderCapability({ market, env });
  return Object.freeze({
    source: capability.provider,
    provider: capability.provider,
    providerVersion: capability.providerVersion,
    publicHistoricalOhlcv: capability.status === "configured" && capability.dailyHistoryAvailable === true,
    closedCandlesOnly: true,
    coverageRecorded: true,
    duplicatesHandled: true,
    missingIntervalsDetected: true,
    adjustmentMode: capability.adjustmentMode,
    corporateActions: capability.corporateActions,
    survivorshipSafeguard: capability.survivorshipSafeguard,
    providerStatus: capability.status,
    selectionReady: capability.selectionReady,
    finalHoldoutReady: false,
    reason: capability.reason,
    credentialValueExposed: false,
    fakeHistoricalDataAllowed: false,
    ...STOCK_RESEARCH_SAFETY,
  });
}

export async function collectKrFscStockHistory({
  symbol,
  requestedStart,
  requestedEnd,
  serviceKey,
  fetchImpl = globalThis.fetch,
  pageSize = 1000,
  generatedAt = Date.now(),
} = {}) {
  assertRange(requestedStart, requestedEnd);
  const normalizedSymbol = assertStockSymbol(symbol, "KR_STOCK");
  const key = assertKey(serviceKey, "KR_FSC_OPEN_DATA_SERVICE_KEY");
  const fetcher = assertFetch(fetchImpl);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10000) throw new RangeError("pageSize must be an integer in [1, 10000]");

  const allItems = [];
  let pageNo = 1;
  let totalCount = Number.POSITIVE_INFINITY;
  while (allItems.length < totalCount) {
    const url = new URL(FSC_BASE_URL);
    url.searchParams.set("serviceKey", key);
    url.searchParams.set("resultType", "json");
    url.searchParams.set("numOfRows", String(pageSize));
    url.searchParams.set("pageNo", String(pageNo));
    url.searchParams.set("beginBasDt", yyyymmdd(requestedStart));
    url.searchParams.set("endBasDt", yyyymmdd(requestedEnd + DAY_MS));
    url.searchParams.set("likeSrtnCd", normalizedSymbol);

    const response = await fetcher(url, { method: "GET", headers: { accept: "application/json" } });
    if (!response?.ok) throw new Error(`KR_FSC_HTTP_${response?.status ?? "UNKNOWN"}`);
    const parsed = normalizeFscBody(await response.json());
    totalCount = parsed.totalCount;
    allItems.push(...parsed.items);
    if (parsed.items.length === 0 || allItems.length >= totalCount) break;
    pageNo += 1;
    if (pageNo > 10000) throw new Error("KR_FSC_PAGINATION_GUARD");
  }

  const normalized = allItems.map((item) => normalizeKrFscStockItem(item, { symbol: normalizedSymbol, observedAt: generatedAt }));
  assertProviderRowOrder(normalized.map((candle) => candle.timestamp), {
    duplicateCode: "KR_FSC_DUPLICATE_CANDLE",
    outOfOrderCode: "KR_FSC_OUT_OF_ORDER_CANDLE",
  });

  let outOfRangeCandleCountDropped = 0;
  let openCandleCountDropped = 0;
  const candles = [];
  for (const candle of normalized) {
    if (candle.timestamp < requestedStart || candle.timestamp > requestedEnd) {
      outOfRangeCandleCountDropped += 1;
      continue;
    }
    if (!isClosedDailyTimestamp(candle.timestamp, generatedAt)) {
      openCandleCountDropped += 1;
      continue;
    }
    candles.push(candle);
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);

  const providerVersion = "GetStockSecuritiesInfoService/getStockPriceInfo";
  const source = "FSC/KRX getStockPriceInfo";
  const corporateActions = "unverified";
  const survivorshipSafeguard = "unverified";
  const adjustmentMode = "none";
  return Object.freeze({
    provider: KR_FSC_STOCK_PROVIDER,
    providerVersion,
    source,
    market: "KR_STOCK",
    symbol: normalizedSymbol,
    timeframe: "1d",
    candles: Object.freeze(candles),
    corporateActions,
    survivorshipSafeguard,
    adjustmentMode,
    provenance: buildCollectionProvenance({
      provider: KR_FSC_STOCK_PROVIDER,
      providerVersion,
      source,
      market: "KR_STOCK",
      symbol: normalizedSymbol,
      requestedStart,
      requestedEnd,
      generatedAt,
      adjustmentMode,
      corporateActions,
      survivorshipSafeguard,
      outOfRangeCandleCountDropped,
      openCandleCountDropped,
    }),
    credentialExposed: false,
    privateApiUsed: false,
    syntheticDataUsed: false,
  });
}

function alphaError(payload) {
  const message = payload?.["Error Message"] ?? payload?.Note ?? payload?.Information ?? null;
  return message ? "US_ALPHA_VANTAGE_PROVIDER_REJECTED" : null;
}

function alphaRows(payload, adjusted) {
  const rejection = alphaError(payload);
  if (rejection) throw new Error(rejection);
  const series = payload?.["Time Series (Daily)"];
  if (!series || typeof series !== "object" || Array.isArray(series)) throw new Error("US_ALPHA_VANTAGE_MISSING_DAILY_SERIES");
  const rows = Object.entries(series).map(([date, row]) => {
    const timestamp = isoDateToUtc(date);
    const open = finiteNumber(row?.["1. open"], "US_ALPHA_OPEN", { positive: true });
    const high = finiteNumber(row?.["2. high"], "US_ALPHA_HIGH", { positive: true });
    const low = finiteNumber(row?.["3. low"], "US_ALPHA_LOW", { positive: true });
    const close = finiteNumber(row?.["4. close"], "US_ALPHA_CLOSE", { positive: true });
    const volume = finiteNumber(row?.[adjusted ? "6. volume" : "5. volume"], "US_ALPHA_VOLUME", { nonNegative: true });
    const adjustedClose = adjusted ? finiteNumber(row?.["5. adjusted close"], "US_ALPHA_ADJUSTED_CLOSE", { positive: true }) : null;
    const dividendAmount = adjusted ? finiteNumber(row?.["7. dividend amount"] ?? 0, "US_ALPHA_DIVIDEND", { nonNegative: true }) : 0;
    const splitCoefficient = adjusted ? finiteNumber(row?.["8. split coefficient"] ?? 1, "US_ALPHA_SPLIT", { positive: true }) : 1;
    if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) throw new Error(`US_ALPHA_INVALID_OHLC:${date}`);
    return { timestamp, open, high, low, close, volume, adjustedClose, dividendAmount, splitCoefficient };
  });
  assertProviderRowOrder(rows.map((row) => row.timestamp), {
    duplicateCode: "US_ALPHA_DUPLICATE_CANDLE",
    outOfOrderCode: "US_ALPHA_OUT_OF_ORDER_CANDLE",
  });
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

function adjustAlphaRows(rows, generatedAt) {
  let cumulativeSplitFactor = 1;
  const byTimestamp = new Map();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const ratio = row.adjustedClose / row.close;
    if (!(Number.isFinite(ratio) && ratio > 0)) throw new Error(`US_ALPHA_INVALID_ADJUSTMENT_RATIO:${row.timestamp}`);
    byTimestamp.set(row.timestamp, Object.freeze({
      timestamp: row.timestamp,
      open: row.open * ratio,
      high: row.high * ratio,
      low: row.low * ratio,
      close: row.adjustedClose,
      volume: row.volume * cumulativeSplitFactor,
      isClosed: true,
      observedAt: generatedAt,
    }));
    if (row.splitCoefficient !== 1) cumulativeSplitFactor *= row.splitCoefficient;
  }
  return rows.map((row) => byTimestamp.get(row.timestamp));
}

export async function collectUsAlphaVantageHistory({
  symbol,
  requestedStart,
  requestedEnd,
  apiKey,
  adjusted = false,
  fetchImpl = globalThis.fetch,
  generatedAt = Date.now(),
} = {}) {
  assertRange(requestedStart, requestedEnd);
  const normalizedSymbol = assertStockSymbol(symbol, "US_STOCK");
  const key = assertKey(apiKey, "ALPHA_VANTAGE_API_KEY");
  const fetcher = assertFetch(fetchImpl);
  const url = new URL(ALPHA_VANTAGE_BASE_URL);
  url.searchParams.set("function", adjusted ? "TIME_SERIES_DAILY_ADJUSTED" : "TIME_SERIES_DAILY");
  url.searchParams.set("symbol", normalizedSymbol);
  url.searchParams.set("outputsize", "full");
  url.searchParams.set("apikey", key);
  const response = await fetcher(url, { method: "GET", headers: { accept: "application/json" } });
  if (!response?.ok) throw new Error(`US_ALPHA_VANTAGE_HTTP_${response?.status ?? "UNKNOWN"}`);

  const parsedRows = alphaRows(await response.json(), adjusted);
  let outOfRangeCandleCountDropped = 0;
  let openCandleCountDropped = 0;
  const rows = parsedRows.filter((row) => {
    if (row.timestamp < requestedStart || row.timestamp > requestedEnd) {
      outOfRangeCandleCountDropped += 1;
      return false;
    }
    if (!isClosedDailyTimestamp(row.timestamp, generatedAt)) {
      openCandleCountDropped += 1;
      return false;
    }
    return true;
  });
  const candles = adjusted
    ? adjustAlphaRows(rows, generatedAt)
    : rows.map((row) => Object.freeze({
      timestamp: row.timestamp,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      isClosed: true,
      observedAt: generatedAt,
    }));

  const provider = adjusted ? US_ALPHA_VANTAGE_ADJUSTED_PROVIDER : US_ALPHA_VANTAGE_RAW_PROVIDER;
  const providerVersion = adjusted ? "TIME_SERIES_DAILY_ADJUSTED" : "TIME_SERIES_DAILY";
  const source = `Alpha Vantage ${providerVersion}`;
  const corporateActions = adjusted ? "verified_provider_events" : "unverified";
  const survivorshipSafeguard = "unverified";
  const adjustmentMode = adjusted ? "adjusted_close_ratio_with_split_volume" : "none";
  return Object.freeze({
    provider,
    providerVersion,
    source,
    market: "US_STOCK",
    symbol: normalizedSymbol,
    timeframe: "1d",
    candles: Object.freeze(candles),
    corporateActions,
    survivorshipSafeguard,
    adjustmentMode,
    provenance: buildCollectionProvenance({
      provider,
      providerVersion,
      source,
      market: "US_STOCK",
      symbol: normalizedSymbol,
      requestedStart,
      requestedEnd,
      generatedAt,
      adjustmentMode,
      corporateActions,
      survivorshipSafeguard,
      outOfRangeCandleCountDropped,
      openCandleCountDropped,
    }),
    credentialExposed: false,
    privateApiUsed: false,
    syntheticDataUsed: false,
  });
}

export async function buildStockHistoricalDataset({
  market,
  symbol,
  requestedStart,
  requestedEnd,
  generatedAt = Date.now(),
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  assertRange(requestedStart, requestedEnd);
  const capability = buildStockHistoryProviderCapability({ market, env });
  if (capability.status !== "configured") throw new Error(`STOCK_HISTORY_PROVIDER_BLOCKED:${capability.reason}`);
  const collection = market === "KR_STOCK"
    ? await collectKrFscStockHistory({
      symbol,
      requestedStart,
      requestedEnd,
      generatedAt,
      serviceKey: env.KR_FSC_OPEN_DATA_SERVICE_KEY,
      fetchImpl,
    })
    : await collectUsAlphaVantageHistory({
      symbol,
      requestedStart,
      requestedEnd,
      generatedAt,
      apiKey: env.ALPHA_VANTAGE_API_KEY,
      adjusted: String(env.ALPHA_VANTAGE_USE_DAILY_ADJUSTED ?? "").toLowerCase() === "true",
      fetchImpl,
    });

  const dataset = buildHistoricalDataset({
    market: collection.market,
    symbol: collection.symbol,
    timeframe: collection.timeframe,
    provider: collection.provider,
    providerVersion: collection.providerVersion,
    source: collection.source,
    requestedStart,
    requestedEnd,
    generatedAt,
    expectedIntervalMs: DAY_MS,
    candles: collection.candles,
    adjustmentMode: collection.adjustmentMode,
    corporateActions: collection.corporateActions,
    survivorshipSafeguard: collection.survivorshipSafeguard,
  });
  return Object.freeze({ capability, collection, dataset });
}

export async function prepareStockAutomatedResearchHistory({
  market,
  symbol,
  requestedStart,
  requestedEnd,
  researchCodeSha,
  generatedAt = Date.now(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  providerManifestDigest = null,
} = {}) {
  assertRange(requestedStart, requestedEnd);
  const immutableResearchCodeSha = assertResearchCodeSha(researchCodeSha);
  const capability = buildStockHistoryProviderCapability({ market, env });
  const automatedProviderCapability = buildStockAutomatedResearchProviderCapability({ market, env });
  if (capability.status !== "configured") {
    return Object.freeze({
      status: "blocked_provider",
      reason: capability.reason,
      capability,
      automatedProviderCapability,
      collection: null,
      dataset: null,
      cacheProvenance: null,
      finalHoldoutReady: false,
      ...STOCK_RESEARCH_SAFETY,
    });
  }

  const result = await buildStockHistoricalDataset({
    market,
    symbol,
    requestedStart,
    requestedEnd,
    generatedAt,
    env,
    fetchImpl,
  });
  if (result.dataset.candles.length === 0 || result.dataset.actualStart == null || result.dataset.actualEnd == null) {
    throw new Error("STOCK_HISTORY_DATASET_MISSING");
  }

  const cacheProvenance = buildHistoricalCacheProvenance({
    market: result.dataset.market,
    symbol: result.dataset.symbol,
    timeframe: result.dataset.timeframe,
    provider: result.dataset.provider,
    providerVersion: result.dataset.providerVersion,
    requestedStartTime: result.dataset.requestedStart,
    requestedEndTime: result.dataset.requestedEnd,
    adjustmentMode: result.dataset.adjustmentMode,
    datasetDigest: result.dataset.datasetDigest,
    providerManifestDigest,
    researchCodeSha: immutableResearchCodeSha,
    candleCount: result.dataset.candles.length,
    actualStartTime: result.dataset.actualStart,
    actualEndTime: result.dataset.actualEnd,
    closedCandlesOnly: true,
    duplicatesHandled: true,
    missingIntervalsDetected: true,
  });

  return Object.freeze({
    status: "ready_for_research",
    reason: null,
    capability: result.capability,
    automatedProviderCapability,
    collection: result.collection,
    dataset: result.dataset,
    cacheProvenance,
    finalHoldoutReady: false,
    finalHoldoutReason: result.capability.reason,
    ...STOCK_RESEARCH_SAFETY,
  });
}

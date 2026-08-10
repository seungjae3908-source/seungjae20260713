import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import {
  SCALPING_HISTORY_SCHEMA_VERSION,
  SCALPING_NORMALIZATION_VERSION,
  SCALPING_TIMEFRAME,
  assertScalpingChunkIntegrity,
  buildScalpingChunkPlan,
  buildScalpingHistoryManifest,
  collectScalpingChunk,
} from "../src/scalping-history-provider.js";
import { BITGET_STANDARD_TAKER_RESEARCH_COSTS } from "../src/historical-backtest-data.js";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";

const outputRoot = resolve(process.argv[2] ?? "scalping-history-cache");
const requestedStart = RESEARCH_BACKTEST_PERIOD.startTime;
const requestedEnd = Math.min(RESEARCH_BACKTEST_PERIOD.defaultEndTime, Date.now());
const researchCodeSha = process.env.RESEARCH_CODE_SHA;
if (!/^[0-9a-f]{40}$/i.test(researchCodeSha ?? "")) throw new TypeError("RESEARCH_CODE_SHA must be an immutable 40-character SHA");
const client = new BitgetPublicClient({ minIntervalMs: 160, maxRetries: 4, timeoutMs: 15_000 });

const DATASETS = Object.freeze([
  Object.freeze({ market: "CRYPTO_SPOT", symbol: "BTCUSDT", researchSymbol: "USDT-BTC" }),
  Object.freeze({ market: "CRYPTO_SPOT", symbol: "ETHUSDT", researchSymbol: "USDT-ETH" }),
  Object.freeze({ market: "CRYPTO_FUTURES", symbol: "BTCUSDT", researchSymbol: "BTCUSDT" }),
  Object.freeze({ market: "CRYPTO_FUTURES", symbol: "ETHUSDT", researchSymbol: "ETHUSDT" }),
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function reusableChunk(path, expectedCacheKey) {
  try {
    const cached = await readJson(path);
    if (cached.cacheKey !== expectedCacheKey) return Object.freeze({ cached: null, corruption: "CACHE_KEY_MISMATCH" });
    assertScalpingChunkIntegrity(cached);
    return Object.freeze({ cached, corruption: null });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ cached: null, corruption: null });
    return Object.freeze({ cached: null, corruption: String(error?.message ?? error).slice(0, 1000) });
  }
}

const reports = [];
for (const dataset of DATASETS) {
  const costModelDigest = digest(BITGET_STANDARD_TAKER_RESEARCH_COSTS[dataset.market]);
  const cacheContract = Object.freeze({
    providerVersion: "api-v2-history-candles",
    normalizationVersion: SCALPING_NORMALIZATION_VERSION,
    collectionCodeSha: researchCodeSha,
    costModelDigest,
    splitDefinition: `dev:${RESEARCH_BACKTEST_PERIOD.startTime}-${RESEARCH_BACKTEST_PERIOD.developmentEndTime}|oos:${RESEARCH_BACKTEST_PERIOD.validationStartTime}-${RESEARCH_BACKTEST_PERIOD.validationEndTime}|holdout:${RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime}`,
  });
  const plan = buildScalpingChunkPlan({
    market: dataset.market,
    symbol: dataset.symbol,
    timeframe: SCALPING_TIMEFRAME,
    requestedStart,
    requestedEnd,
    cacheContract,
  });
  const summaries = [];
  const cacheCorruptionEvents = [];
  let providerBoundaryReached = false;
  for (const chunk of plan) {
    if (providerBoundaryReached) {
      summaries.push(Object.freeze({
        status: "blocked_data",
        cacheKey: chunk.cacheKey,
        cacheContract,
        requestedStart: chunk.requestedStart,
        requestedEnd: chunk.requestedEnd,
        actualStart: null,
        actualEnd: null,
        rawDataDigest: null,
        normalizedDataDigest: null,
        diagnostics: Object.freeze({ reason: "not_attempted_after_older_provider_boundary" }),
        syntheticDataUsed: false,
        interpolationUsed: false,
        privateApiUsed: false,
        orderSubmitted: false,
      }));
      continue;
    }
    const chunkPath = resolve(outputRoot, dataset.market.toLowerCase(), dataset.symbol, SCALPING_TIMEFRAME, `${String(chunk.index).padStart(4, "0")}-${chunk.cacheKey}.json`);
    const reusable = await reusableChunk(chunkPath, chunk.cacheKey);
    if (reusable.corruption) {
      cacheCorruptionEvents.push(Object.freeze({ chunk: chunk.index, cacheKey: chunk.cacheKey, reason: reusable.corruption }));
      console.error(JSON.stringify({ market: dataset.market, symbol: dataset.symbol, chunk: chunk.index, status: "cache_corruption_detected", reason: reusable.corruption }));
    }
    const result = reusable.cached ?? await collectScalpingChunk({ client, chunk });
    if (!reusable.cached) await writeJson(chunkPath, result);
    summaries.push(result);
    console.log(JSON.stringify({
      market: dataset.market,
      symbol: dataset.symbol,
      timeframe: SCALPING_TIMEFRAME,
      chunk: chunk.index,
      cache: reusable.cached ? "reused_verified" : reusable.corruption ? "corrupt_refetched" : "written",
      status: result.status,
      actualStart: result.actualStart,
      actualEnd: result.actualEnd,
      rawDataDigest: result.rawDataDigest,
      normalizedDataDigest: result.normalizedDataDigest,
    }));
    if (result.status !== "ready") providerBoundaryReached = true;
  }

  const manifest = buildScalpingHistoryManifest({
    market: dataset.market,
    symbol: dataset.symbol,
    timeframe: SCALPING_TIMEFRAME,
    requestedStart,
    requestedEnd,
    chunkSummaries: summaries,
    cacheContract,
  });
  const completeManifest = Object.freeze({
    ...manifest,
    researchSymbol: dataset.researchSymbol,
    collectionOrder: "newest_to_oldest",
    providerBoundaryFailClosed: true,
    cacheCorruptionDetected: cacheCorruptionEvents.length > 0,
    cacheCorruptionRecoveredByRefetch: cacheCorruptionEvents.length > 0 && manifest.status === "DATA_READY",
    cacheCorruptionEvents: Object.freeze(cacheCorruptionEvents),
  });
  const manifestPath = resolve(outputRoot, dataset.market.toLowerCase(), dataset.symbol, SCALPING_TIMEFRAME, "manifest.json");
  await writeJson(manifestPath, completeManifest);
  reports.push(Object.freeze({
    market: dataset.market,
    symbol: dataset.symbol,
    researchSymbol: dataset.researchSymbol,
    status: completeManifest.status,
    requestedStart: completeManifest.requestedStart,
    requestedEnd: completeManifest.requestedEnd,
    actualFirstCandle: completeManifest.actualFirstCandle,
    actualLastCandle: completeManifest.actualLastCandle,
    expectedCandleCount: completeManifest.expectedCandleCount,
    actualCandleCount: completeManifest.actualCandleCount,
    missingCandleCount: completeManifest.missingCandleCount,
    gapCount: completeManifest.gapCount,
    maximumGap: completeManifest.maximumGap,
    duplicateCount: completeManifest.duplicateCount,
    outOfOrderCount: completeManifest.outOfOrderCount,
    provider: completeManifest.provider,
    providerVersion: completeManifest.providerVersion,
    providerApi: completeManifest.providerApi,
    timeframe: completeManifest.timeframe,
    rawDigest: completeManifest.rawDigest,
    normalizedDigest: completeManifest.normalizedDigest,
    cacheSchemaVersion: completeManifest.cacheSchemaVersion,
    normalizationVersion: completeManifest.normalizationVersion,
    collectionCodeSHA: completeManifest.collectionCodeSHA,
    providerBoundary: completeManifest.providerBoundary,
    semantics: completeManifest.semantics,
    cacheCorruptionDetected: completeManifest.cacheCorruptionDetected,
    cacheCorruptionRecoveredByRefetch: completeManifest.cacheCorruptionRecoveredByRefetch,
    manifestDigest: completeManifest.manifestDigest,
  }));
}

const artifact = Object.freeze({
  schemaVersion: SCALPING_HISTORY_SCHEMA_VERSION,
  mode: "scalping-historical-provider-audit",
  researchCodeSha,
  requestedStart,
  requestedEnd,
  timeframe: SCALPING_TIMEFRAME,
  provider: "bitget-public-v2",
  datasets: Object.freeze(reports),
  groups: Object.freeze([
    "CRYPTO_SPOT_SCALPING",
    "CRYPTO_FUTURES_SCALPING_LONG",
    "CRYPTO_FUTURES_SCALPING_SHORT",
  ]),
  dataReadyDatasets: reports.filter((row) => row.status === "DATA_READY").length,
  blockedDataDatasets: reports.filter((row) => row.status === "BLOCKED_DATA").length,
  blockedProviderBoundaryDatasets: reports.filter((row) => row.status === "BLOCKED_PROVIDER_BOUNDARY").length,
  allRequestedHistoryReady: reports.every((row) => row.status === "DATA_READY"),
  candidateSearchAllowedOnlyForDataReady: true,
  syntheticHistoricalDataAllowed: false,
  interpolationAllowed: false,
  privateApiAllowed: false,
  orderSubmitted: false,
});
await writeJson(resolve(outputRoot, "scalping-history-provider-audit.json"), artifact);
console.log(JSON.stringify({
  status: artifact.allRequestedHistoryReady ? "DATA_READY" : "BLOCKED",
  researchCodeSha,
  datasets: reports.map((row) => ({
    market: row.market,
    symbol: row.symbol,
    status: row.status,
    requestedStart: row.requestedStart,
    requestedEnd: row.requestedEnd,
    actualFirstCandle: row.actualFirstCandle,
    actualLastCandle: row.actualLastCandle,
    expectedCandleCount: row.expectedCandleCount,
    actualCandleCount: row.actualCandleCount,
    missingCandleCount: row.missingCandleCount,
    gapCount: row.gapCount,
  })),
  syntheticHistoricalDataAllowed: false,
  interpolationAllowed: false,
  privateApiAllowed: false,
  orderSubmitted: false,
}));

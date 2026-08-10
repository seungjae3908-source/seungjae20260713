import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import {
  SCALPING_TIMEFRAME,
  assertScalpingChunkIntegrity,
  buildScalpingChunkPlan,
  buildScalpingHistoryManifest,
  collectScalpingChunk,
} from "../src/scalping-history-provider.js";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";

const outputRoot = resolve(process.argv[2] ?? "scalping-history-cache");
const requestedStart = RESEARCH_BACKTEST_PERIOD.startTime;
const requestedEnd = Math.min(RESEARCH_BACKTEST_PERIOD.defaultEndTime, Date.now());
const client = new BitgetPublicClient({ minIntervalMs: 160, maxRetries: 4, timeoutMs: 15_000 });

const DATASETS = Object.freeze([
  Object.freeze({ market: "CRYPTO_SPOT", symbol: "BTCUSDT", researchSymbol: "USDT-BTC" }),
  Object.freeze({ market: "CRYPTO_SPOT", symbol: "ETHUSDT", researchSymbol: "USDT-ETH" }),
  Object.freeze({ market: "CRYPTO_FUTURES", symbol: "BTCUSDT", researchSymbol: "BTCUSDT" }),
  Object.freeze({ market: "CRYPTO_FUTURES", symbol: "ETHUSDT", researchSymbol: "ETHUSDT" }),
]);

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
    if (cached.cacheKey !== expectedCacheKey) return null;
    assertScalpingChunkIntegrity(cached);
    return cached;
  } catch {
    return null;
  }
}

const reports = [];
for (const dataset of DATASETS) {
  const plan = buildScalpingChunkPlan({
    market: dataset.market,
    symbol: dataset.symbol,
    timeframe: SCALPING_TIMEFRAME,
    requestedStart,
    requestedEnd,
  });
  const summaries = [];
  let providerBoundaryReached = false;
  for (const chunk of plan) {
    if (providerBoundaryReached) {
      summaries.push(Object.freeze({
        status: "blocked_data",
        cacheKey: chunk.cacheKey,
        requestedStart: chunk.requestedStart,
        requestedEnd: chunk.requestedEnd,
        actualStart: null,
        actualEnd: null,
        rawDataDigest: null,
        normalizedDataDigest: null,
        diagnostics: Object.freeze({ reason: "not_attempted_after_older_provider_boundary" }),
      }));
      continue;
    }
    const chunkPath = resolve(outputRoot, dataset.market.toLowerCase(), dataset.symbol, SCALPING_TIMEFRAME, `${String(chunk.index).padStart(4, "0")}-${chunk.cacheKey}.json`);
    const cached = await reusableChunk(chunkPath, chunk.cacheKey);
    const result = cached ?? await collectScalpingChunk({ client, chunk });
    if (!cached) await writeJson(chunkPath, result);
    summaries.push(result);
    console.log(JSON.stringify({
      market: dataset.market,
      symbol: dataset.symbol,
      timeframe: SCALPING_TIMEFRAME,
      chunk: chunk.index,
      cache: cached ? "reused" : "written",
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
  });
  const manifestPath = resolve(outputRoot, dataset.market.toLowerCase(), dataset.symbol, SCALPING_TIMEFRAME, "manifest.json");
  await writeJson(manifestPath, {
    ...manifest,
    researchSymbol: dataset.researchSymbol,
    collectionOrder: "newest_to_oldest",
    providerBoundaryFailClosed: true,
  });
  reports.push(Object.freeze({
    market: dataset.market,
    symbol: dataset.symbol,
    researchSymbol: dataset.researchSymbol,
    status: manifest.status,
    requestedPeriod: manifest.requestedPeriod,
    actualAvailablePeriod: manifest.actualAvailablePeriod,
    chunkCount: manifest.chunkCount,
    readyChunkCount: manifest.readyChunkCount,
    blockedChunkCount: manifest.blockedChunkCount,
    missingCandleStatistics: manifest.missingCandleStatistics,
    duplicateCandleCount: manifest.duplicateCandleCount,
    manifestDigest: manifest.manifestDigest,
  }));
}

const artifact = Object.freeze({
  schemaVersion: 1,
  mode: "scalping-historical-provider-audit",
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
  allRequestedHistoryReady: reports.every((row) => row.status === "ready"),
  syntheticHistoricalDataAllowed: false,
  privateApiAllowed: false,
  orderSubmitted: false,
});
await writeJson(resolve(outputRoot, "scalping-history-provider-audit.json"), artifact);
console.log(JSON.stringify({
  status: artifact.allRequestedHistoryReady ? "ready" : "blocked_data",
  datasets: reports.map((row) => ({ market: row.market, symbol: row.symbol, status: row.status, actualAvailablePeriod: row.actualAvailablePeriod })),
  syntheticHistoricalDataAllowed: false,
  privateApiAllowed: false,
  orderSubmitted: false,
}));

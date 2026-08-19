import { runHistoricalMarketReplay } from "./historical-market-replay-v1.js";
import { settleHistoricalDiscoveryReplay } from "./historical-discovery-settlement-v1.js";
import { resolveStrategyHorizon } from "./strategy-horizon-contract-v1.js";

const CRYPTO_MARKETS = new Set(["CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const DAY_MS = 24 * 60 * 60 * 1000;

function freeze(value) { return Object.freeze(value); }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function positive(value) { return finite(value) && value > 0; }
function upper(value) { return String(value ?? "").trim().toUpperCase(); }

function blocked({ market, strategyMode, reason, details = {}, datasetEvidence = null }) {
  return freeze({
    schemaVersion: "crypto-historical-discovery-replay-v1",
    status: "BLOCKED",
    market,
    strategyMode,
    reason,
    details: freeze(details),
    datasetEvidence,
    replayResult: null,
    settlementResult: null,
    pointInTimeOnly: true,
    searchInputContainsFutureData: false,
    syntheticHistoricalDataAllowed: false,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  });
}

function normalizeCandle(raw, symbol, index) {
  const timestamp = Number(raw?.timestamp ?? raw?.timestampMs ?? raw?.time);
  const open = Number(raw?.open);
  const high = Number(raw?.high);
  const low = Number(raw?.low);
  const close = Number(raw?.close ?? raw?.price);
  const volume = Number(raw?.volume ?? 0);
  if (![timestamp, open, high, low, close, volume].every(Number.isFinite)
    || timestamp <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0
    || high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
    throw new TypeError(`invalid historical candle ${symbol}[${index}]`);
  }
  if (raw?.isClosed === false) throw new TypeError(`open historical candle forbidden ${symbol}[${index}]`);
  return freeze({ symbol, timestamp: Math.trunc(timestamp), open, high, low, close, volume, isClosed: true });
}

function normalizeDataset(raw, market) {
  if (!raw || typeof raw !== "object") throw new TypeError("historical dataset is required");
  if (raw.syntheticHistoricalData === true || raw.fakeHistoricalData === true) {
    throw new TypeError("synthetic/fake crypto historical data is forbidden");
  }
  const datasetMarket = upper(raw.market);
  if (datasetMarket !== market) throw new TypeError(`dataset market mismatch: ${datasetMarket || "MISSING"}`);
  const symbol = upper(raw.symbol ?? raw.researchSymbol ?? raw.providerMarket);
  if (!symbol) throw new TypeError("historical dataset symbol is required");
  const provider = String(raw.provider ?? raw.source ?? "").trim();
  const sourceVenue = upper(raw.sourceVenue ?? raw.exchange ?? (provider.includes("binance") ? "BINANCE" : provider.includes("upbit") ? "UPBIT" : provider.includes("bitget") ? "BITGET" : "UNKNOWN"));
  const targetVenue = upper(raw.targetVenue ?? (market === "CRYPTO_SPOT" ? "UPBIT" : "BITGET"));
  const timeframe = String(raw.timeframe ?? "").trim().toLowerCase();
  const intervalMs = Number(raw.intervalMs ?? (timeframe === "1d" ? DAY_MS : Number.NaN));
  if (!provider) throw new TypeError(`provider is required for ${symbol}`);
  if (!positive(intervalMs)) throw new TypeError(`positive intervalMs is required for ${symbol}`);
  if (!Array.isArray(raw.candles) || raw.candles.length < 2) throw new TypeError(`historical candles are insufficient for ${symbol}`);

  const candles = raw.candles.map((row, index) => normalizeCandle(row, symbol, index)).sort((left, right) => left.timestamp - right.timestamp);
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].timestamp === candles[index - 1].timestamp) throw new TypeError(`duplicate historical timestamp for ${symbol}`);
  }
  const crossVenueProxyForExecution = raw.crossVenueProxyForExecution === true;
  if (market === "CRYPTO_FUTURES" && sourceVenue !== targetVenue && !crossVenueProxyForExecution) {
    throw new TypeError(`cross-venue futures history must be explicitly marked as proxy for ${symbol}`);
  }
  const checksumRequired = raw.checksumRequired === true || provider.includes("binance-vision");
  if (checksumRequired && raw.checksumVerified !== true) throw new TypeError(`required historical checksum is not verified for ${symbol}`);

  const listedAtMs = positive(Number(raw.listedAtMs)) ? Number(raw.listedAtMs) : candles[0].timestamp;
  const delistedAtMs = positive(Number(raw.delistedAtMs)) ? Number(raw.delistedAtMs) : null;
  if (delistedAtMs != null && delistedAtMs < listedAtMs) throw new TypeError(`invalid listing range for ${symbol}`);

  const sameVenuePublicMarketHistory = sourceVenue === targetVenue && crossVenueProxyForExecution !== true;
  return freeze({
    schemaVersion: "crypto-historical-dataset-v1",
    market,
    symbol,
    provider,
    sourceVenue,
    targetVenue,
    timeframe: timeframe || null,
    intervalMs,
    candles: freeze(candles),
    listedAtMs,
    delistedAtMs,
    checksumRequired,
    checksumVerified: raw.checksumVerified === true,
    crossVenueProxyForExecution,
    sameVenuePublicMarketHistory,
    publicMarketHistoryOnly: true,
    executionEvidenceAvailable: false,
    exactTargetVenueExecutionHistory: false,
    syntheticHistoricalData: false,
    fakeHistoricalData: false,
  });
}

function activeAt(dataset, asOfMs) {
  return dataset.listedAtMs <= asOfMs && (dataset.delistedAtMs == null || asOfMs <= dataset.delistedAtMs);
}

function entryAt(dataset, asOfMs) {
  let entry = null;
  for (const candle of dataset.candles) {
    if (candle.timestamp > asOfMs) break;
    entry = candle;
  }
  return entry;
}

function historyThrough(dataset, asOfMs, maximumBars) {
  const rows = dataset.candles.filter((candle) => candle.timestamp <= asOfMs);
  return freeze(rows.slice(Math.max(0, rows.length - maximumBars)));
}

function futurePath(dataset, asOfMs, settleAtMs) {
  return freeze(dataset.candles
    .filter((candle) => candle.timestamp > asOfMs && candle.timestamp <= settleAtMs)
    .map((candle) => freeze({ timestampMs: candle.timestamp, price: candle.close })));
}

function buildDatasetEvidence(datasets) {
  return freeze({
    schemaVersion: "crypto-historical-dataset-evidence-v1",
    datasetCount: datasets.length,
    symbols: freeze(datasets.map((row) => row.symbol)),
    providers: freeze([...new Set(datasets.map((row) => row.provider))]),
    sourceVenues: freeze([...new Set(datasets.map((row) => row.sourceVenue))]),
    targetVenues: freeze([...new Set(datasets.map((row) => row.targetVenue))]),
    timeframe: datasets[0].timeframe,
    intervalMs: datasets[0].intervalMs,
    firstTimestamp: Math.min(...datasets.map((row) => row.candles[0].timestamp)),
    lastTimestamp: Math.max(...datasets.map((row) => row.candles.at(-1).timestamp)),
    checksumRequired: datasets.some((row) => row.checksumRequired),
    checksumVerified: datasets.every((row) => !row.checksumRequired || row.checksumVerified),
    crossVenueProxyForExecution: datasets.some((row) => row.crossVenueProxyForExecution),
    sameVenuePublicMarketHistory: datasets.every((row) => row.sameVenuePublicMarketHistory),
    publicMarketHistoryOnly: true,
    executionEvidenceAvailable: false,
    exactTargetVenueExecutionHistory: false,
    selectionUsesFutureData: false,
    syntheticHistoricalData: false,
    profitabilityClaimAllowed: false,
  });
}

export function adaptUpbitSpotHistoryForReplay(history) {
  if (!history || history.market !== "CRYPTO_SPOT" || upper(history.exchange) !== "UPBIT") throw new TypeError("Upbit spot history is required");
  return freeze({
    market: "CRYPTO_SPOT",
    symbol: history.providerMarket ?? history.symbol,
    provider: history.source ?? "upbit-public-candles",
    sourceVenue: "UPBIT",
    targetVenue: "UPBIT",
    timeframe: history.timeframe,
    intervalMs: history.intervalMs,
    candles: history.candles,
    crossVenueProxyForExecution: false,
    checksumRequired: false,
  });
}

export function adaptBinanceVisionFuturesForReplay(history, { targetVenue = "BITGET" } = {}) {
  if (!history || !Array.isArray(history.candles)) throw new TypeError("Binance Vision futures history is required");
  return freeze({
    market: "CRYPTO_FUTURES",
    symbol: history.symbol,
    provider: history.provider ?? "binance-vision-usdm-monthly",
    sourceVenue: "BINANCE",
    targetVenue,
    timeframe: history.timeframe ?? "1d",
    intervalMs: history.intervalMs ?? DAY_MS,
    candles: history.candles,
    checksumRequired: true,
    checksumVerified: history.checksumVerified === true,
    crossVenueProxyForExecution: true,
  });
}

export function createCryptoHistoricalReplayAdapter({ market, datasets, maximumHistoryBars = 500 } = {}) {
  const normalizedMarket = upper(market);
  if (!CRYPTO_MARKETS.has(normalizedMarket)) throw new TypeError("market must be CRYPTO_SPOT or CRYPTO_FUTURES");
  if (!Array.isArray(datasets) || datasets.length === 0) throw new TypeError("datasets are required");
  if (!Number.isInteger(maximumHistoryBars) || maximumHistoryBars < 2) throw new TypeError("maximumHistoryBars must be >= 2");
  const normalized = datasets.map((dataset) => normalizeDataset(dataset, normalizedMarket));
  const symbols = new Set();
  for (const dataset of normalized) {
    if (symbols.has(dataset.symbol)) throw new TypeError(`duplicate historical dataset symbol: ${dataset.symbol}`);
    symbols.add(dataset.symbol);
  }
  const intervalMs = normalized[0].intervalMs;
  if (normalized.some((dataset) => dataset.intervalMs !== intervalMs)) throw new TypeError("mixed historical intervals are not supported in one replay adapter");
  const datasetEvidence = buildDatasetEvidence(normalized);

  const loadSnapshot = async ({ asOfMs }) => {
    const active = normalized.filter((dataset) => activeAt(dataset, asOfMs));
    const series = active.map((dataset) => {
      const candles = historyThrough(dataset, asOfMs, maximumHistoryBars);
      return freeze({ symbol: dataset.symbol, candles });
    }).filter((row) => row.candles.length > 0);
    const observations = series.flatMap((row) => {
      const candle = row.candles.at(-1);
      return candle ? [freeze({ symbol: row.symbol, timestampMs: candle.timestamp, price: candle.close })] : [];
    });
    const dataCutoffMs = observations.length ? Math.max(...observations.map((row) => row.timestampMs)) : asOfMs;
    return freeze({
      schemaVersion: "crypto-historical-replay-snapshot-v1",
      market: normalizedMarket,
      asOfMs,
      universeAsOfMs: asOfMs,
      dataCutoffMs,
      universe: freeze({ source: "historical-crypto-dataset-adapter-v1", totalCount: series.length, symbols: freeze(series.map((row) => row.symbol)) }),
      series: freeze(series),
      observations: freeze(observations),
      datasetEvidence,
      syntheticHistoricalData: false,
      fakeHistoricalData: false,
      executionAuthority: "NONE",
      liveTrading: false,
      realOrder: false,
      privateApi: false,
    });
  };

  const loadGroundTruthUniverse = async ({ asOfMs, settleAtMs }) => {
    const entries = normalized
      .filter((dataset) => activeAt(dataset, asOfMs))
      .map((dataset) => {
        const entry = entryAt(dataset, asOfMs);
        if (!entry) return null;
        return freeze({
          symbol: dataset.symbol,
          entryPrice: entry.close,
          observations: futurePath(dataset, asOfMs, settleAtMs),
        });
      })
      .filter(Boolean);
    return freeze({
      schemaVersion: "crypto-historical-ground-truth-universe-v1",
      market: normalizedMarket,
      universeAsOfMs: asOfMs,
      settleAtMs,
      entries: freeze(entries),
      datasetEvidence,
      syntheticHistoricalData: false,
      fakeHistoricalData: false,
    });
  };

  return freeze({
    schemaVersion: "crypto-historical-replay-adapter-v1",
    market: normalizedMarket,
    intervalMs,
    datasets: freeze(normalized),
    datasetEvidence,
    loadSnapshot,
    loadGroundTruthUniverse,
    executionAuthority: "NONE",
    profitabilityClaimAllowed: false,
  });
}

export async function runCryptoHistoricalDiscoveryReplay({
  market,
  strategyMode,
  replayTimes,
  datasets,
  searchSnapshot,
  successThresholdPctByHorizon,
  maximumHistoryBars = 500,
} = {}) {
  const normalizedMarket = upper(market);
  const horizon = resolveStrategyHorizon(strategyMode);
  let adapter;
  try {
    adapter = createCryptoHistoricalReplayAdapter({ market: normalizedMarket, datasets, maximumHistoryBars });
  } catch (error) {
    return blocked({ market: normalizedMarket, strategyMode: horizon.strategyMode, reason: "HISTORICAL_DATASET_INVALID", details: { message: String(error?.message ?? error) } });
  }
  const shortestHorizonMs = Math.min(...horizon.checkpoints.map((row) => row.offsetMs));
  if (adapter.intervalMs > shortestHorizonMs) {
    return blocked({
      market: normalizedMarket,
      strategyMode: horizon.strategyMode,
      reason: "HISTORICAL_RESOLUTION_INSUFFICIENT",
      details: { intervalMs: adapter.intervalMs, requiredAtMostMs: shortestHorizonMs, firstHorizonKey: horizon.checkpoints[0].key },
      datasetEvidence: adapter.datasetEvidence,
    });
  }
  if (typeof searchSnapshot !== "function") throw new TypeError("searchSnapshot is required");
  const replayResult = await runHistoricalMarketReplay({
    market: normalizedMarket,
    strategyMode: horizon.strategyMode,
    replayTimes,
    loadSnapshot: adapter.loadSnapshot,
    searchSnapshot,
  });
  if (replayResult.status !== "READY") {
    return freeze({ ...blocked({ market: normalizedMarket, strategyMode: horizon.strategyMode, reason: replayResult.reason ?? "REPLAY_NOT_READY", datasetEvidence: adapter.datasetEvidence }), replayResult });
  }
  const settlementResult = await settleHistoricalDiscoveryReplay({
    replayResult,
    loadGroundTruthUniverse: adapter.loadGroundTruthUniverse,
    successThresholdPctByHorizon,
  });
  if (settlementResult.status !== "READY") {
    return freeze({
      ...blocked({ market: normalizedMarket, strategyMode: horizon.strategyMode, reason: settlementResult.reason ?? "SETTLEMENT_NOT_READY", details: settlementResult.details ?? {}, datasetEvidence: adapter.datasetEvidence }),
      replayResult,
      settlementResult,
    });
  }
  return freeze({
    schemaVersion: "crypto-historical-discovery-replay-v1",
    status: "READY",
    market: normalizedMarket,
    strategyMode: horizon.strategyMode,
    horizon,
    datasetEvidence: adapter.datasetEvidence,
    replayResult,
    settlementResult,
    searchQualityMetrics: settlementResult.metrics,
    pointInTimeOnly: true,
    searchInputContainsFutureData: false,
    futureDataUsedForScoringOnly: true,
    syntheticHistoricalDataAllowed: false,
    crossVenueProxyForExecution: adapter.datasetEvidence.crossVenueProxyForExecution,
    sameVenuePublicMarketHistory: adapter.datasetEvidence.sameVenuePublicMarketHistory,
    publicMarketHistoryOnly: true,
    executionEvidenceAvailable: false,
    exactTargetVenueExecutionHistory: false,
    searchQualityIsNotProfitabilityProof: true,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  });
}

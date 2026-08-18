import test from "node:test";
import assert from "node:assert/strict";

import {
  adaptBinanceVisionFuturesForReplay,
  adaptUpbitSpotHistoryForReplay,
  createCryptoHistoricalReplayAdapter,
  runCryptoHistoricalDiscoveryReplay,
} from "../src/crypto-historical-replay-adapter-v1.js";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2024, 0, 1);

function candles(prices, intervalMs = DAY) {
  return prices.map((close, index) => Object.freeze({
    timestamp: START + index * intervalMs,
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume: 100 + index,
    isClosed: true,
  }));
}

function thresholds(mode) {
  if (mode === "SWING") return { "1D": 1, "3D": 1, "5D": 1 };
  if (mode === "MID_LONG") return { "30D": 1, "90D": 1, "180D": 1 };
  return { "5M": 0.2, "15M": 0.3, "30M": 0.5, "60M": 0.7, "1D": 1 };
}

function safeSearchCandidate({ symbol, direction = "LONG" }) {
  return async ({ market, asOfMs }) => ({
    outcome: "VALID_NO_TRADE",
    discoveryOutcome: "DISCOVERY_CANDIDATES",
    discoveryCandidates: [{ market, symbol, direction, signalId: `${symbol}:${direction}:${asOfMs}` }],
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  });
}

test("spot SWING connects point-in-time snapshot to #479 settlement with precision/recall", async () => {
  const dataset = {
    market: "CRYPTO_SPOT",
    symbol: "KRW-BTC",
    provider: "upbit-public-candles",
    sourceVenue: "UPBIT",
    targetVenue: "UPBIT",
    timeframe: "1d",
    intervalMs: DAY,
    candles: candles([100, 100, 100, 102, 104, 106, 107, 108, 109, 110]),
  };
  const result = await runCryptoHistoricalDiscoveryReplay({
    market: "CRYPTO_SPOT",
    strategyMode: "SWING",
    replayTimes: [START + 2 * DAY],
    datasets: [dataset],
    searchSnapshot: safeSearchCandidate({ symbol: "KRW-BTC" }),
    successThresholdPctByHorizon: thresholds("SWING"),
  });
  assert.equal(result.status, "READY");
  assert.equal(result.replayResult.replayCount, 1);
  assert.equal(result.settlementResult.settledSignalCount, 3);
  assert.equal(result.searchQualityMetrics.overall.precision, 1);
  assert.equal(result.searchQualityMetrics.overall.recall, 1);
  assert.equal(result.sameVenuePublicMarketHistory, true);
  assert.equal(result.publicMarketHistoryOnly, true);
  assert.equal(result.executionEvidenceAvailable, false);
  assert.equal(result.exactTargetVenueExecutionHistory, false);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.profitabilityClaimAllowed, false);
});

test("futures cross-venue Binance Vision proxy can settle SHORT but is never exact Bitget history", async () => {
  const history = {
    provider: "binance-vision-usdm-monthly",
    symbol: "BTCUSDT",
    timeframe: "1d",
    intervalMs: DAY,
    checksumVerified: true,
    candles: candles([100, 100, 100, 98, 96, 94, 93, 92, 91, 90]),
  };
  const dataset = adaptBinanceVisionFuturesForReplay(history);
  const result = await runCryptoHistoricalDiscoveryReplay({
    market: "CRYPTO_FUTURES",
    strategyMode: "SWING",
    replayTimes: [START + 2 * DAY],
    datasets: [dataset],
    searchSnapshot: safeSearchCandidate({ symbol: "BTCUSDT", direction: "SHORT" }),
    successThresholdPctByHorizon: thresholds("SWING"),
  });
  assert.equal(result.status, "READY");
  assert.equal(result.crossVenueProxyForExecution, true);
  assert.equal(result.sameVenuePublicMarketHistory, false);
  assert.equal(result.exactTargetVenueExecutionHistory, false);
  assert.equal(result.executionEvidenceAvailable, false);
  assert.equal(result.datasetEvidence.checksumVerified, true);
  assert.equal(result.searchQualityMetrics.overall.precision, 1);
  assert.equal(result.searchQualityMetrics.overall.recall, 1);
  assert.ok(result.settlementResult.settledSignals.every((row) => row.direction === "SHORT"));
});

test("daily/4h history cannot masquerade as SCALPING 5M evidence", async () => {
  const result = await runCryptoHistoricalDiscoveryReplay({
    market: "CRYPTO_SPOT",
    strategyMode: "SCALPING",
    replayTimes: [START + 2 * DAY],
    datasets: [{
      market: "CRYPTO_SPOT",
      symbol: "KRW-BTC",
      provider: "upbit-public-candles",
      sourceVenue: "UPBIT",
      targetVenue: "UPBIT",
      timeframe: "1d",
      intervalMs: DAY,
      candles: candles([100, 101, 102, 103]),
    }],
    searchSnapshot: safeSearchCandidate({ symbol: "KRW-BTC" }),
    successThresholdPctByHorizon: thresholds("SCALPING"),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "HISTORICAL_RESOLUTION_INSUFFICIENT");
  assert.equal(result.details.firstHorizonKey, "5M");
  assert.equal(result.settlementResult, null);
});

test("cross-venue futures data without explicit proxy label fails closed", async () => {
  const result = await runCryptoHistoricalDiscoveryReplay({
    market: "CRYPTO_FUTURES",
    strategyMode: "SWING",
    replayTimes: [START + 2 * DAY],
    datasets: [{
      market: "CRYPTO_FUTURES",
      symbol: "BTCUSDT",
      provider: "some-binance-history",
      sourceVenue: "BINANCE",
      targetVenue: "BITGET",
      timeframe: "1d",
      intervalMs: DAY,
      checksumVerified: true,
      candles: candles([100, 99, 98, 97, 96, 95, 94, 93]),
    }],
    searchSnapshot: safeSearchCandidate({ symbol: "BTCUSDT", direction: "SHORT" }),
    successThresholdPctByHorizon: thresholds("SWING"),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "HISTORICAL_DATASET_INVALID");
  assert.match(result.details.message, /cross-venue futures history must be explicitly marked as proxy/);
});

test("synthetic historical crypto data fails closed instead of generating metrics", async () => {
  const result = await runCryptoHistoricalDiscoveryReplay({
    market: "CRYPTO_SPOT",
    strategyMode: "SWING",
    replayTimes: [START + 2 * DAY],
    datasets: [{
      market: "CRYPTO_SPOT",
      symbol: "KRW-BTC",
      provider: "synthetic",
      sourceVenue: "UPBIT",
      targetVenue: "UPBIT",
      timeframe: "1d",
      intervalMs: DAY,
      syntheticHistoricalData: true,
      candles: candles([100, 101, 102, 103, 104, 105, 106, 107]),
    }],
    searchSnapshot: safeSearchCandidate({ symbol: "KRW-BTC" }),
    successThresholdPctByHorizon: thresholds("SWING"),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "HISTORICAL_DATASET_INVALID");
  assert.equal(result.settlementResult, null);
});

test("snapshot loader never exposes candles after historical asOf", async () => {
  const adapter = createCryptoHistoricalReplayAdapter({
    market: "CRYPTO_SPOT",
    datasets: [{
      market: "CRYPTO_SPOT",
      symbol: "KRW-BTC",
      provider: "upbit-public-candles",
      sourceVenue: "UPBIT",
      targetVenue: "UPBIT",
      timeframe: "1d",
      intervalMs: DAY,
      candles: candles([100, 101, 102, 103, 104]),
    }],
  });
  const asOfMs = START + 2 * DAY;
  const snapshot = await adapter.loadSnapshot({ asOfMs });
  assert.ok(snapshot.series[0].candles.every((row) => row.timestamp <= asOfMs));
  assert.ok(snapshot.observations.every((row) => row.timestampMs <= asOfMs));
  assert.ok(snapshot.dataCutoffMs <= asOfMs);
  assert.equal(snapshot.syntheticHistoricalData, false);
  assert.equal(adapter.datasetEvidence.sameVenuePublicMarketHistory, true);
  assert.equal(adapter.datasetEvidence.executionEvidenceAvailable, false);
  assert.equal(adapter.datasetEvidence.exactTargetVenueExecutionHistory, false);
});

test("existing Upbit public history result maps to canonical replay dataset without private authority", () => {
  const history = {
    market: "CRYPTO_SPOT",
    exchange: "UPBIT",
    providerMarket: "KRW-BTC",
    symbol: "BTC",
    timeframe: "4h",
    intervalMs: 4 * 60 * 60 * 1000,
    source: "upbit-public-candles",
    candles: candles([100, 101, 102], 4 * 60 * 60 * 1000),
  };
  const mapped = adaptUpbitSpotHistoryForReplay(history);
  assert.equal(mapped.market, "CRYPTO_SPOT");
  assert.equal(mapped.symbol, "KRW-BTC");
  assert.equal(mapped.sourceVenue, "UPBIT");
  assert.equal(mapped.targetVenue, "UPBIT");
  assert.equal(mapped.crossVenueProxyForExecution, false);

  const adapter = createCryptoHistoricalReplayAdapter({ market: "CRYPTO_SPOT", datasets: [mapped] });
  assert.equal(adapter.datasetEvidence.sameVenuePublicMarketHistory, true);
  assert.equal(adapter.datasetEvidence.publicMarketHistoryOnly, true);
  assert.equal(adapter.datasetEvidence.executionEvidenceAvailable, false);
  assert.equal(adapter.datasetEvidence.exactTargetVenueExecutionHistory, false);
});

test("Binance Vision checksum must be proven before futures replay", async () => {
  const result = await runCryptoHistoricalDiscoveryReplay({
    market: "CRYPTO_FUTURES",
    strategyMode: "SWING",
    replayTimes: [START + 2 * DAY],
    datasets: [adaptBinanceVisionFuturesForReplay({
      provider: "binance-vision-usdm-monthly",
      symbol: "BTCUSDT",
      timeframe: "1d",
      checksumVerified: false,
      candles: candles([100, 99, 98, 97, 96, 95, 94, 93]),
    })],
    searchSnapshot: safeSearchCandidate({ symbol: "BTCUSDT", direction: "SHORT" }),
    successThresholdPctByHorizon: thresholds("SWING"),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "HISTORICAL_DATASET_INVALID");
  assert.match(result.details.message, /checksum is not verified/);
});

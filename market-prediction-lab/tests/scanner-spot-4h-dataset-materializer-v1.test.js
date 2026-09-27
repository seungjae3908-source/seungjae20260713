import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScannerSpot4hDatasetMaterializationV1,
  SPOT_SCANNER_HISTORICAL_SPREAD_FIRST_ZERO,
} from "../src/scanner-spot-4h-dataset-materializer-v1.js";

const SHA = "a".repeat(40);
const START = Date.UTC(2026, 0, 1);
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;

function candle(timestamp, index, quote = true) {
  const price = 100 + index * 0.1;
  return {
    timestamp,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price + 0.2,
    volume: 10 + index,
    quoteVolume: quote ? 1000 + index : null,
  };
}
function history(timeframe, interval, count, {
  extraIncomplete = false,
  missingIndex = null,
  quote = true,
} = {}) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    if (index === missingIndex) continue;
    rows.push(candle(START + index * interval, index, quote));
  }
  if (extraIncomplete) rows.push(candle(START + count * interval, count, quote));
  return {
    schemaVersion: 1,
    market: "CRYPTO_SPOT",
    exchange: "UPBIT",
    providerMarket: "KRW-BTC",
    symbol: "BTC",
    timeframe,
    intervalMs: interval,
    source: "upbit-public-candles",
    candles: rows,
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
  };
}
function input(overrides = {}) {
  const primaryCount = 320;
  const observedAtMs = START + primaryCount * FOUR_HOURS + 1;
  return {
    researchSha: SHA,
    symbol: "BTC",
    observedAtMs,
    nowMs: observedAtMs,
    primaryHistory: history("4h", FOUR_HOURS, primaryCount, { extraIncomplete: true }),
    contextHistory: history("60m", HOUR, primaryCount * 4, { extraIncomplete: true }),
    ...overrides,
  };
}

test("materializes exact Scanner Spot 4H Dataset Snapshot and stops at missing historical spread", () => {
  const result = buildScannerSpot4hDatasetMaterializationV1(input());
  assert.equal(result.status, "DATASET_READY_REPLAY_BLOCKED");
  assert.equal(result.datasetSnapshotManifest.profileId, "CRYPTO_SPOT:SCANNER_SWING_4H");
  assert.equal(result.datasetSnapshotManifest.scope.timeframe, "4H");
  assert.equal(result.dataset.rowCount, 320);
  assert.equal(result.contextEvidence.rowCount, 1280);
  assert.equal(
    result.dataset.splitCounts.TRAIN + result.dataset.splitCounts.VALIDATION + result.dataset.splitCounts.OOS,
    320,
  );
  assert.match(result.dataset.datasetSnapshotHash, /^[0-9a-f]{64}$/u);
  assert.match(result.dataset.datasetDigest, /^[0-9a-f]{64}$/u);
  assert.equal(result.historicalReplay.firstZero, SPOT_SCANNER_HISTORICAL_SPREAD_FIRST_ZERO);
  assert.deepEqual(result.historicalReplay.blockers, [SPOT_SCANNER_HISTORICAL_SPREAD_FIRST_ZERO]);
  assert.equal(result.historicalReplay.exactScannerReplayAllowed, false);
  assert.equal(result.historicalReplay.crossStrategyTransferAllowed, false);
  assert.equal(result.historicalReplay.oosWalkForwardMaterialized, false);
  assert.equal(result.qualityArtifactWritten, false);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.safety.executionAuthority, "NONE");
});

test("incomplete current candles are excluded from immutable evidence", () => {
  const result = buildScannerSpot4hDatasetMaterializationV1(input());
  assert.equal(result.dataset.endTime, START + 320 * FOUR_HOURS);
  assert.equal(result.contextEvidence.endTime, result.dataset.endTime);
});

test("primary 4H interval gap fails closed", () => {
  assert.throws(
    () => buildScannerSpot4hDatasetMaterializationV1(input({
      primaryHistory: history("4h", FOUR_HOURS, 320, { missingIndex: 100 }),
    })),
    /4H_INTERVAL_GAP/u,
  );
});

test("60m context coverage or quote-volume evidence cannot be invented", () => {
  assert.throws(
    () => buildScannerSpot4hDatasetMaterializationV1(input({
      contextHistory: history("60m", HOUR, 1279),
    })),
    /60M_CONTEXT_COVERAGE_INCOMPLETE/u,
  );
  assert.throws(
    () => buildScannerSpot4hDatasetMaterializationV1(input({
      contextHistory: history("60m", HOUR, 1280, { quote: false }),
    })),
    /60M_CONTEXT_QUOTE_VOLUME_MISSING/u,
  );
});

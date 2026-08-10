import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDatasetDigest,
  buildHistoricalDataset,
  buildScannerBacktestQualityArtifact,
  buildScannerBacktestQualityRow,
  classifyBacktestQuality,
} from "../src/long-history-data-layer.js";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2020, 0, 1);
const GENERATED = Date.UTC(2026, 7, 10);
const SHA = "1234567890abcdef1234567890abcdef12345678";

function candles(count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: START + index * DAY,
    observedAt: START + index * DAY,
    isClosed: true,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1000 + index,
  }));
}

function dataset(overrides = {}) {
  return buildHistoricalDataset({
    market: "CRYPTO_SPOT",
    symbol: "USDT-BTC",
    timeframe: "1d",
    source: "bitget-public-v2",
    provider: "bitget-public-v2",
    providerVersion: "v2",
    adjustmentMode: "none",
    requestedStart: START,
    requestedEnd: START + 3 * DAY,
    generatedAt: GENERATED,
    expectedIntervalMs: DAY,
    candles: candles(),
    ...overrides,
  });
}

const oos = Object.freeze({ tradeCount: 20, winRate: 0.55, expectancy: 1.2, profitFactor: 1.4, maximumDrawdown: 0.08, totalReturn: 0.12, sharpe: 1.1, costImpact: 50 });
const walkForward = Object.freeze({ windows: Object.freeze([{ leakFree: true }]), windowCount: 1, profitableWindowRatio: 1, winRate: 0.55, expectancy: 1.1, profitFactor: 1.3, maximumDrawdown: 0.09, stabilityScore: 80 });
const holdout = Object.freeze({ status: "evaluated", metrics: oos });
const costModel = Object.freeze({ fee: true, tax: false, spread: true, slippage: true, latency: true, funding: false });

test("common historical dataset is deterministic and records provenance/digest", () => {
  const first = dataset();
  const second = dataset();
  assert.deepEqual(first, second);
  assert.equal(first.dataQuality, "verified");
  assert.equal(first.coverageRatio, 1);
  assert.equal(first.duplicateCount, 0);
  assert.deepEqual(first.missingIntervals, []);
  assert.match(first.datasetDigest, /^[a-f0-9]{64}$/);
  assert.equal(assertDatasetDigest(first), true);
  assert.deepEqual(Object.keys(first.candles[0]), ["market", "symbol", "timeframe", "timestamp", "open", "high", "low", "close", "volume", "isClosed", "source", "observedAt"]);
});

test("invalid OHLC, future/open, duplicate and reverse-order candles fail closed", () => {
  assert.throws(() => dataset({ candles: [{ ...candles(1)[0], high: 90 }] }), /INVALID_OHLC/);
  assert.throws(() => dataset({ candles: [{ ...candles(1)[0], timestamp: GENERATED + DAY, observedAt: GENERATED + DAY }] }), /FUTURE_CANDLE/);
  assert.throws(() => dataset({ candles: [{ ...candles(1)[0], isClosed: false }] }), /OPEN_CANDLE/);
  assert.throws(() => dataset({ candles: [candles(1)[0], candles(1)[0]] }), /DUPLICATE_CANDLE/);
  const reversed = candles(2).reverse();
  assert.throws(() => dataset({ candles: reversed }), /REVERSED_CANDLE_ORDER/);
});

test("missing intervals and partial range are recorded instead of synthesized", () => {
  const rows = candles(4).filter((_row, index) => index !== 2);
  const result = dataset({ candles: rows });
  assert.equal(result.dataQuality, "partial");
  assert.equal(result.missingIntervals.length, 1);
  assert.equal(result.missingIntervals[0].missingCount, 1);
  assert.ok(result.coverageRatio < 1);
});

test("corrupted cached data is rejected by digest", () => {
  const good = dataset();
  const corrupted = { ...good, candles: [...good.candles.slice(0, -1), { ...good.candles.at(-1), close: 999 }] };
  assert.throws(() => assertDatasetDigest(corrupted), /CORRUPTED_DATASET_DIGEST/);
});

test("verified research quality requires OOS, WF, holdout, costs and lookahead protection", () => {
  const result = classifyBacktestQuality({ dataset: dataset(), oosMetrics: oos, walkForward, holdout, costModel, lookaheadSafe: true });
  assert.deepEqual(result, { status: "verified", reasons: [] });
  assert.equal(classifyBacktestQuality({ dataset: dataset(), oosMetrics: oos, walkForward, holdout: null, costModel, lookaheadSafe: true }).status, "partial");
  assert.equal(classifyBacktestQuality({ dataset: dataset(), oosMetrics: oos, walkForward: { windows: [{ leakFree: false }] }, holdout, costModel, lookaheadSafe: true }).status, "failed_validation");
});

test("stock survivorship metadata is fail-closed when unverified", () => {
  const stock = buildHistoricalDataset({
    market: "US_STOCK", symbol: "AAPL", timeframe: "1d", source: "test", provider: "test",
    requestedStart: START, requestedEnd: START + 3 * DAY, generatedAt: GENERATED, candles: candles(),
    survivorshipSafeguard: "unverified", corporateActions: "split_adjusted_unverified",
  });
  const result = classifyBacktestQuality({ dataset: stock, oosMetrics: oos, walkForward, holdout, costModel, lookaheadSafe: true });
  assert.equal(result.status, "partial");
  assert.ok(result.reasons.includes("survivorship_not_verified"));
});

test("scanner artifact schema keeps unavailable values null and safety flags false", () => {
  const ds = dataset();
  const row = buildScannerBacktestQualityRow({
    market: "CRYPTO_SPOT", symbol: "USDT-BTC", strategyType: "SWING", direction: "LONG", strategyVersion: "v1_ema_atr",
    timeframe: "1d", backtestQuality: "verified", reasons: [], development: oos, oos, walkForward, holdout,
    researchStatus: "research_hold", dataset: ds, lookaheadSafe: true, researchCodeSha: SHA, generatedAt: new Date(GENERATED).toISOString(),
  });
  const artifact = buildScannerBacktestQualityArtifact({ researchCodeSha: SHA, generatedAt: new Date(GENERATED).toISOString(), rows: [row], blocked: [] });
  assert.equal(artifact.schema, "scanner-backtest-quality-v1");
  assert.equal(artifact.rows[0].datasetDigest, ds.datasetDigest);
  assert.equal(artifact.realHistoricalDataOnly, true);
  assert.equal(artifact.syntheticMetricsAllowed, false);
  assert.equal(artifact.liveOrderAllowed, false);
  assert.equal(artifact.privateApiAllowed, false);
  assert.equal(artifact.orderSubmitted, false);
  assert.match(artifact.artifactDigest, /^[a-f0-9]{64}$/);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  BITGET_STANDARD_TAKER_RESEARCH_COSTS,
  HISTORICAL_V1_CRYPTO_SPECS,
  buildBlockedStockProviderReport,
  buildCryptoV1Cases,
  summarizeHistoricalCoverage,
  toResearchCandles,
} from "../src/historical-backtest-data.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function rawCandles(start, count) {
  return Array.from({ length: count }, (_, index) => Object.freeze({
    timestamp: start + index * DAY_MS,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1_000 + index,
  }));
}

test("Bitget spot symbols are adapted to research quote-base symbols without changing prices", () => {
  const spec = HISTORICAL_V1_CRYPTO_SPECS.find((row) => row.market === "CRYPTO_SPOT" && row.exchangeSymbol === "BTCUSDT");
  const rows = rawCandles(Date.UTC(2020, 0, 1), 3);
  const normalized = toResearchCandles(spec, { candles: rows });
  assert.equal(normalized[0].symbol, "USDT-BTC");
  assert.equal(normalized[0].close, rows[0].close);
  assert.equal(normalized[0].isClosed, true);
  assert.equal(normalized[0].observedAt, normalized[0].timestamp);
});

test("coverage report does not pretend late-starting exchange history covers 2020", () => {
  const requestedStartTime = Date.UTC(2020, 0, 1);
  const requestedEndTime = Date.UTC(2026, 7, 9);
  const spec = HISTORICAL_V1_CRYPTO_SPECS[2];
  const partial = summarizeHistoricalCoverage({
    spec,
    candles: rawCandles(Date.UTC(2021, 0, 1), 100),
    requestedStartTime,
    requestedEndTime,
    asOfTime: requestedEndTime,
  });
  assert.equal(partial.status, "partial_coverage");
  assert.equal(partial.fullRequestedRange, false);
  assert.equal(partial.missingRequestedStart, true);
});

test("coverage through the latest closed daily bar is not mislabeled partial when requested end is still in the future", () => {
  const requestedStartTime = Date.UTC(2026, 7, 1);
  const requestedEndTime = Date.UTC(2026, 7, 9, 23, 59, 59, 999);
  const asOfTime = Date.UTC(2026, 7, 8, 22);
  const spec = HISTORICAL_V1_CRYPTO_SPECS[0];
  const coverage = summarizeHistoricalCoverage({
    spec,
    candles: rawCandles(requestedStartTime, 8),
    requestedStartTime,
    requestedEndTime,
    asOfTime,
  });
  assert.equal(coverage.status, "coverage_through_asof");
  assert.equal(coverage.coverageThroughAsOf, true);
  assert.equal(coverage.fullRequestedRange, false);
  assert.equal(coverage.missingRequestedEnd, false);
});

test("spot gets long-only case while futures gets independent long and short cases", () => {
  const period = { startTime: Date.UTC(2020, 0, 1), endTime: Date.UTC(2026, 7, 9), includeFinalHoldout: false };
  const spotSpec = HISTORICAL_V1_CRYPTO_SPECS[0];
  const futureSpec = HISTORICAL_V1_CRYPTO_SPECS[2];
  const spot = buildCryptoV1Cases({ spec: spotSpec, candles: [], period });
  const futures = buildCryptoV1Cases({ spec: futureSpec, candles: [], fundingRates: [{ timestamp: 1, rate: 0.0001 }], period });
  assert.deepEqual(spot.map((row) => row.side), ["long"]);
  assert.deepEqual(futures.map((row) => row.side), ["long", "short"]);
  assert.equal(spot[0].costModel.entryFeeRate, 0.001);
  assert.equal(futures[0].costModel.entryFeeRate, 0.0006);
  assert.equal(futureSpec.provider, "binance-usdm-public-rest");
  assert.deepEqual(BITGET_STANDARD_TAKER_RESEARCH_COSTS.CRYPTO_FUTURES, futures[0].costModel);
});

test("stock markets stay explicitly blocked until reproducible historical providers are integrated", () => {
  const report = buildBlockedStockProviderReport();
  assert.deepEqual(report.map((row) => row.market), ["KR_STOCK", "US_STOCK"]);
  assert.ok(report.every((row) => row.status === "blocked_provider_not_integrated"));
  assert.ok(report.every((row) => row.reason.includes("no synthetic returns")));
});

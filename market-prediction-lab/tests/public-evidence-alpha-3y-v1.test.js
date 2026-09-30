import assert from "node:assert/strict";
import test from "node:test";

import { BENCHMARK_PERIOD } from "../src/evidence-backed-3y-benchmark-v1.js";
import {
  EVIDENCE_ALPHA_PARAMETERS,
  evidenceAlphaSafety,
  runCryptoOrderFlowProxy,
  runKrOvernightDaytimeReversalProxy,
  runUsPriorRvolGapContinuationProxy,
} from "../src/public-evidence-alpha-3y-v1.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

function stockCandles({ start, count, base = 100, volume = 1_000_000, overrides = {} }) {
  const rows = [];
  let previousClose = base;
  for (let index = 0; index < count; index += 1) {
    const custom = overrides[index] ?? {};
    const open = custom.open ?? previousClose;
    const close = custom.close ?? open * 1.001;
    const high = custom.high ?? Math.max(open, close) * 1.002;
    const low = custom.low ?? Math.min(open, close) * 0.998;
    rows.push(Object.freeze({
      timestamp: start + index * DAY,
      open,
      high,
      low,
      close,
      volume: custom.volume ?? volume,
      isClosed: true,
      observedAt: start + index * DAY,
    }));
    previousClose = close;
  }
  return Object.freeze(rows);
}

function cryptoCandles({ start, count, drift, flow }) {
  const rows = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    close = open * (1 + drift);
    const volume = 1000;
    const takerBuyVolume = volume * (0.5 + flow / 2);
    rows.push(Object.freeze({
      timestamp: start + index * HOUR,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume,
      takerBuyVolume,
      isClosed: true,
      observedAt: start + index * HOUR,
    }));
  }
  return Object.freeze(rows);
}

test("US proxy uses only prior-day RVOL and opening gap information", () => {
  const start = BENCHMARK_PERIOD.startTime - 30 * DAY;
  const common = stockCandles({ start, count: 40 });
  const rowsA = common.map((row) => ({ ...row }));
  const signalIndex = 31;
  rowsA[signalIndex - 1] = {
    ...rowsA[signalIndex - 1],
    open: 100,
    close: 102,
    high: 103,
    low: 99,
    volume: 2_000_000,
  };
  rowsA[signalIndex] = {
    ...rowsA[signalIndex],
    open: 103,
    close: 106,
    high: 107,
    low: 102,
    volume: 1_000_000,
  };
  const result = runUsPriorRvolGapContinuationProxy({
    datasets: [
      { symbol: "A", candles: rowsA },
      { symbol: "B", candles: common },
    ],
    startTime: start + 25 * DAY,
    endTime: start + 39 * DAY,
  });
  assert.equal(result.family, "US_PRIOR_RVOL_GAP_CONTINUATION_PROXY");
  assert.ok(result.details.trades >= 1);
  assert.ok(result.performance.totalReturn > 0);
  assert.equal(result.sourceFaithfulReplication, false);
});

test("KR overnight-daytime reversal fades a large opening gap without future information", () => {
  const start = BENCHMARK_PERIOD.startTime - 5 * DAY;
  const common = stockCandles({ start, count: 20 });
  const rowsA = common.map((row) => ({ ...row }));
  rowsA[6] = {
    ...rowsA[6],
    open: rowsA[5].close * 1.03,
    close: rowsA[5].close * 1.01,
    high: rowsA[5].close * 1.035,
    low: rowsA[5].close * 1.005,
  };
  const result = runKrOvernightDaytimeReversalProxy({
    datasets: [
      { symbol: "005930", candles: rowsA },
      { symbol: "000660", candles: common },
    ],
    startTime: start + 5 * DAY,
    endTime: start + 19 * DAY,
  });
  assert.equal(result.family, "KR_OVERNIGHT_DAYTIME_REVERSAL_PROXY");
  assert.ok(result.details.trades >= 1);
  assert.ok(result.performance.totalReturn > 0);
});

test("crypto spot taker-flow proxy selects positive-flow asset and stays long-only", () => {
  const start = BENCHMARK_PERIOD.startTime - 30 * HOUR;
  const positive = cryptoCandles({ start, count: 120, drift: 0.002, flow: 0.20 });
  const neutral = cryptoCandles({ start, count: 120, drift: -0.001, flow: 0 });
  const result = runCryptoOrderFlowProxy({
    market: "CRYPTO_SPOT",
    datasets: [
      { symbol: "BTCUSDT", candles: positive },
      { symbol: "ETHUSDT", candles: neutral },
    ],
    startTime: BENCHMARK_PERIOD.startTime,
    endTime: start + 119 * HOUR,
  });
  assert.equal(result.family, "CRYPTO_SPOT_TAKER_FLOW_SELECTIVE_LONG_PROXY");
  assert.ok(result.details.activeIntervals > 0);
  assert.ok(result.performance.totalReturn > 0);
  assert.equal(result.details.fundingIncluded, false);
});

test("crypto futures taker-flow proxy can hold long and short and includes funding", () => {
  const start = BENCHMARK_PERIOD.startTime - 30 * HOUR;
  const longRows = cryptoCandles({ start, count: 120, drift: 0.002, flow: 0.20 });
  const shortRows = cryptoCandles({ start, count: 120, drift: -0.002, flow: -0.20 });
  const funding = [];
  for (let index = 0; index < 120; index += 8) {
    funding.push({ timestamp: start + index * HOUR, rate: 0.0001 });
  }
  const result = runCryptoOrderFlowProxy({
    market: "CRYPTO_FUTURES",
    datasets: [
      { symbol: "BTCUSDT", candles: longRows },
      { symbol: "ETHUSDT", candles: shortRows },
    ],
    fundingBySymbol: {
      BTCUSDT: funding,
      ETHUSDT: funding,
    },
    startTime: BENCHMARK_PERIOD.startTime,
    endTime: start + 119 * HOUR,
  });
  assert.equal(result.family, "CRYPTO_FUTURES_TAKER_FLOW_FUNDING_LONG_SHORT_PROXY");
  assert.equal(result.details.fundingIncluded, true);
  assert.ok(result.details.activeIntervals > 0);
  assert.ok(result.performance.totalReturn > 0);
});

test("all evidence-alpha proxies are research-only and expose requested period windows", () => {
  const start = BENCHMARK_PERIOD.startTime - 30 * HOUR;
  const rowsA = cryptoCandles({ start, count: 120, drift: 0.001, flow: 0.20 });
  const rowsB = cryptoCandles({ start, count: 120, drift: 0, flow: -0.10 });
  const result = runCryptoOrderFlowProxy({
    market: "CRYPTO_SPOT",
    datasets: [
      { symbol: "BTCUSDT", candles: rowsA },
      { symbol: "ETHUSDT", candles: rowsB },
    ],
    startTime: BENCHMARK_PERIOD.startTime,
    endTime: start + 119 * HOUR,
  });
  assert.deepEqual(Object.keys(result.periodAnalysis.windows), [
    "DAILY",
    "WEEKLY",
    "MONTHLY",
    "SIX_MONTH",
    "YEARLY",
    "THREE_YEAR",
  ]);
  const safety = evidenceAlphaSafety();
  assert.equal(safety.profitabilityProven, false);
  assert.equal(safety.executionAuthority, "NONE");
  assert.equal(safety.realOrderEnabled, false);
  assert.equal(EVIDENCE_ALPHA_PARAMETERS.crypto.holdingBars, 4);
});

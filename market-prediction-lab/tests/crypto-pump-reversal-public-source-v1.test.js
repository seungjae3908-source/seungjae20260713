import assert from "node:assert/strict";
import test from "node:test";

import { collectPumpReversalCleanPublicSignals } from "../src/crypto-pump-reversal-public-source-v1.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-01T08:00:00.000Z");

function candleSeries(timeframe, symbol) {
  if (timeframe === "1h") {
    const count = 180;
    const first = NOW - count * HOUR;
    const rows = Array.from({ length: count }, (_, index) => ({
      timestamp: first + index * HOUR,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
      quoteVolume: 10_000_000,
    }));
    if (symbol !== "BTCUSDT") {
      const latest = rows.at(-1);
      latest.close = 130;
      latest.high = 131;
      latest.quoteVolume = 20_000_000;
    }
    return rows;
  }

  const count = symbol === "BTCUSDT" ? 70 : 200;
  const first = NOW - count * DAY;
  return Array.from({ length: count }, (_, index) => {
    const ratio = count === 1 ? 1 : index / (count - 1);
    const close = symbol === "BTCUSDT" ? 100 + 10 * ratio : 100;
    return {
      timestamp: first + index * DAY,
      open: close,
      high: close * 1.02,
      low: close * 0.98,
      close,
      volume: 100,
      quoteVolume: symbol === "BTCUSDT" ? 1_000_000_000 : 10_000_000,
    };
  });
}

function snapshot(symbol, timeframe) {
  return Object.freeze({
    provider: "bitget-public-v2",
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe,
    candles: Object.freeze(candleSeries(timeframe, symbol)),
  });
}

function client(change24h = "0.30") {
  return {
    async get(path) {
      if (path.endsWith("/tickers")) {
        return {
          code: "00000",
          data: [{
            symbol: "ALTUSDT",
            markPrice: "130",
            change24h,
            usdtVolume: "10000000",
            bidPr: "129.9",
            askPr: "130.1",
            ts: String(NOW),
          }],
        };
      }
      if (path.endsWith("/contracts")) {
        return { code: "00000", data: [{ symbol: "ALTUSDT", symbolStatus: "normal" }] };
      }
      throw new Error("UNEXPECTED_PUBLIC_REQUEST");
    },
  };
}

test("ticker is only a cheap prefilter and eligible event is rechecked from closed candles", async () => {
  const calls = [];
  const result = await collectPumpReversalCleanPublicSignals({
    client: client(),
    nowMs: NOW,
    collectCandles: async ({ symbol, timeframe }) => {
      calls.push(`${symbol}:${timeframe}`);
      return snapshot(symbol, timeframe);
    },
  });

  assert.equal(result.status, "READY");
  assert.equal(result.publicOnly, true);
  assert.equal(result.privateRequestCount, 0);
  assert.equal(result.prefilteredPumpCount, 1);
  assert.equal(result.evaluatedCount, 1);
  assert.equal(result.signalCount, 1);
  assert.equal(result.signals[0].signal.decision, "PAPER_RESEARCH_SIGNAL");
  assert.equal(result.signals[0].profile.performanceBasedExclusionUsed, false);
  assert.deepEqual(calls.sort(), ["ALTUSDT:1d", "ALTUSDT:1h", "BTCUSDT:1d"].sort());
});

test("below-25% ticker event makes no symbol history request and returns valid NO_TRADE", async () => {
  const calls = [];
  const result = await collectPumpReversalCleanPublicSignals({
    client: client("0.20"),
    nowMs: NOW,
    collectCandles: async ({ symbol, timeframe }) => {
      calls.push(`${symbol}:${timeframe}`);
      return snapshot(symbol, timeframe);
    },
  });

  assert.equal(result.status, "READY");
  assert.equal(result.decision, "VALID_NO_TRADE");
  assert.equal(result.prefilteredPumpCount, 0);
  assert.equal(result.evaluatedCount, 0);
  assert.equal(result.signalCount, 0);
  assert.deepEqual(calls, ["BTCUSDT:1d"]);
});

test("non-tradable contract is evaluated but never emitted as a research signal", async () => {
  const blockedClient = {
    async get(path) {
      if (path.endsWith("/tickers")) {
        return {
          code: "00000",
          data: [{
            symbol: "ALTUSDT",
            markPrice: "130",
            change24h: "0.30",
            usdtVolume: "10000000",
            bidPr: "129.9",
            askPr: "130.1",
            ts: String(NOW),
          }],
        };
      }
      if (path.endsWith("/contracts")) {
        return { code: "00000", data: [{ symbol: "ALTUSDT", symbolStatus: "off" }] };
      }
      throw new Error("UNEXPECTED_PUBLIC_REQUEST");
    },
  };
  const result = await collectPumpReversalCleanPublicSignals({
    client: blockedClient,
    nowMs: NOW,
    collectCandles: async ({ symbol, timeframe }) => snapshot(symbol, timeframe),
  });
  assert.equal(result.signalCount, 0);
  assert.equal(result.evaluatedCount, 1);
  assert.ok(result.evaluated[0].profile.blockers.includes("PIT_CONTRACT_NOT_TRADABLE"));
  assert.equal(result.executionAuthority, "NONE");
});

test("24h cooldown from the prospective state blocks duplicate entry on the same symbol", async () => {
  const result = await collectPumpReversalCleanPublicSignals({
    client: client(),
    nowMs: NOW,
    lastEntryAtBySymbol: { ALTUSDT: NOW - 6 * HOUR },
    collectCandles: async ({ symbol, timeframe }) => snapshot(symbol, timeframe),
  });
  assert.equal(result.signalCount, 0);
  assert.ok(result.evaluated[0].signal.blockers.includes("SYMBOL_24H_REENTRY_COOLDOWN"));
});

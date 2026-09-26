import test from "node:test";
import assert from "node:assert/strict";
import {
  collectYahooStockHistory,
  yahooStockProviderSymbol,
} from "../src/yahoo-stock-history.js";

function payload(count = 80) {
  const start = Math.floor(Date.UTC(2026, 0, 1) / 1000);
  const timestamp = Array.from({ length: count }, (_, index) => start + index * 86_400);
  const close = timestamp.map((_, index) => 100 + index * 0.5);
  return {
    chart: {
      result: [{
        timestamp,
        indicators: {
          quote: [{
            open: close.map((value) => value - 0.2),
            high: close.map((value) => value + 1),
            low: close.map((value) => value - 1),
            close,
            volume: close.map(() => 1_000_000),
          }],
        },
      }],
    },
  };
}

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() { return body; },
  };
}

test("KR stock symbols use the public .KS provider form while US symbols remain canonical", () => {
  assert.equal(yahooStockProviderSymbol("KR_STOCK", "005930"), "005930.KS");
  assert.equal(yahooStockProviderSymbol("KR_STOCK", "035720.KQ"), "035720.KQ");
  assert.equal(yahooStockProviderSymbol("US_STOCK", "AAPL"), "AAPL");
});

test("collector returns normalized public daily candles and never exposes private execution capability", async () => {
  const calls = [];
  const result = await collectYahooStockHistory({
    market: "KR_STOCK",
    symbol: "005930",
    startTime: Date.UTC(2025, 0, 1),
    endTime: Date.UTC(2026, 0, 1),
    fetchImpl: async (url) => {
      calls.push(url);
      return response(payload());
    },
  });
  assert.equal(result.providerSymbol, "005930.KS");
  assert.equal(result.timeframe, "1d");
  assert.equal(result.candleCount, 80);
  assert.equal(result.liveOrderAllowed, false);
  assert.equal(result.privateAccountRequestAllowed, false);
  assert.match(calls[0], /query1\.finance\.yahoo\.com/);
  assert.match(calls[0], /005930\.KS/);
});

test("collector skips malformed rows but requires at least sixty valid candles", async () => {
  const body = payload(80);
  body.chart.result[0].indicators.quote[0].close[5] = null;
  body.chart.result[0].indicators.quote[0].high[6] = 1;
  const result = await collectYahooStockHistory({
    market: "US_STOCK",
    symbol: "AAPL",
    startTime: Date.UTC(2025, 0, 1),
    endTime: Date.UTC(2026, 0, 1),
    fetchImpl: async () => response(body),
  });
  assert.equal(result.candleCount, 78);
});

test("collector falls back from query1 to query2 without changing the requested public contract", async () => {
  let attempts = 0;
  const result = await collectYahooStockHistory({
    market: "US_STOCK",
    symbol: "MSFT",
    startTime: Date.UTC(2025, 0, 1),
    endTime: Date.UTC(2026, 0, 1),
    fetchImpl: async (url) => {
      attempts += 1;
      if (url.includes("query1")) return response({}, false, 503);
      return response(payload());
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.providerSymbol, "MSFT");
});

test("collector rejects unsupported markets and invalid KR symbols before network access", async () => {
  let calls = 0;
  await assert.rejects(
    collectYahooStockHistory({
      market: "CRYPTO_SPOT",
      symbol: "BTC",
      fetchImpl: async () => { calls += 1; return response(payload()); },
    }),
    /supports KR_STOCK or US_STOCK/,
  );
  await assert.rejects(
    collectYahooStockHistory({
      market: "KR_STOCK",
      symbol: "AAPL",
      fetchImpl: async () => { calls += 1; return response(payload()); },
    }),
    /six-digit code/,
  );
  assert.equal(calls, 0);
});

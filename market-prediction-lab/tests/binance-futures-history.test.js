import test from "node:test";
import assert from "node:assert/strict";
import {
  collectBinanceFuturesDailyKlines,
  collectBinanceFuturesFundingRates,
} from "../src/binance-futures-history.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function kline(timestamp, close = 100) {
  return [timestamp, String(close - 1), String(close + 2), String(close - 2), String(close), "10", timestamp + DAY_MS - 1, "1000", 5, "5", "500", "0"];
}

test("daily kline collector paginates forward without duplicate timestamps", async () => {
  const start = Date.UTC(2020, 0, 1);
  const all = Array.from({ length: 1005 }, (_, index) => kline(start + index * DAY_MS, 100 + index));
  const calls = [];
  const client = {
    async get(path, params) {
      calls.push({ path, params });
      const matching = all.filter((row) => row[0] >= params.startTime && row[0] <= params.endTime);
      return matching.slice(0, params.limit);
    },
  };
  const result = await collectBinanceFuturesDailyKlines({
    client,
    symbol: "BTCUSDT",
    startTime: start,
    endTime: start + 1004 * DAY_MS,
  });
  assert.equal(result.candles.length, 1005);
  assert.equal(calls.length, 2);
  assert.equal(new Set(result.candles.map((row) => row.timestamp)).size, 1005);
  assert.ok(result.candles.every((row) => row.isClosed === true));
});

test("funding collector advances by one millisecond and preserves positive and negative rates", async () => {
  const start = Date.UTC(2020, 0, 1);
  const interval = 8 * 60 * 60 * 1000;
  const all = Array.from({ length: 1003 }, (_, index) => ({
    symbol: "BTCUSDT",
    fundingTime: start + index * interval,
    fundingRate: String(index % 2 === 0 ? 0.0001 : -0.00005),
  }));
  const calls = [];
  const client = {
    async get(path, params) {
      calls.push({ path, params });
      return all.filter((row) => row.fundingTime >= params.startTime && row.fundingTime <= params.endTime).slice(0, params.limit);
    },
  };
  const result = await collectBinanceFuturesFundingRates({
    client,
    symbol: "BTCUSDT",
    startTime: start,
    endTime: start + 1002 * interval,
  });
  assert.equal(result.records.length, 1003);
  assert.equal(calls.length, 2);
  assert.equal(result.records[0].rate, 0.0001);
  assert.equal(result.records[1].rate, -0.00005);
  assert.ok(calls[1].params.startTime > calls[0].params.startTime);
});

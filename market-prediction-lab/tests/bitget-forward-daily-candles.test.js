import test from "node:test";
import assert from "node:assert/strict";
import { collectBitgetUtcDailyForwardCandles } from "../src/bitget-forward-daily-candles.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENT_OPEN = Date.UTC(2026, 7, 9);
const AS_OF = CURRENT_OPEN + 20 * 60 * 1000;

function row(timestamp, price = 100) {
  return [String(timestamp), String(price), String(price + 2), String(price - 2), String(price + 1), "1000", "100000"];
}

function fakeClient({ currentTimestamp = CURRENT_OPEN } = {}) {
  const calls = [];
  return {
    calls,
    async get(path, params) {
      calls.push({ path, params });
      if (path.endsWith("history-candles")) {
        return {
          data: Array.from({ length: params.limit }, (_, index) => row(params.endTime - (index + 1) * DAY_MS, 100 + index)),
        };
      }
      if (path.endsWith("/candles")) {
        return { data: [row(currentTimestamp, 200), row(currentTimestamp - DAY_MS, 190)] };
      }
      throw new Error(`unexpected path: ${path}`);
    },
  };
}

test("forward collector uses UTC daily history plus the current public candle", async () => {
  const client = fakeClient();
  const result = await collectBitgetUtcDailyForwardCandles({
    client,
    symbol: "ETHUSDT",
    asOf: AS_OF,
    lookbackDays: 60,
    minimumClosedCandles: 60,
  });

  assert.equal(result.timezone, "UTC");
  assert.equal(result.granularity, "1Dutc");
  assert.equal(result.closedCandleCount, 60);
  assert.equal(result.candles.length, 61);
  assert.equal(result.candles.at(-1).timestamp, CURRENT_OPEN);
  assert.equal(result.candles.at(-1).open, 200);
  assert.equal(result.candles.at(-1).observedAt, AS_OF);
  assert.ok(client.calls.every((call) => call.params.granularity === "1Dutc"));
});

test("forward collector rejects a current candle that is not the UTC day open", async () => {
  const client = fakeClient({ currentTimestamp: CURRENT_OPEN - DAY_MS });
  await assert.rejects(() => collectBitgetUtcDailyForwardCandles({
    client,
    symbol: "ETHUSDT",
    asOf: AS_OF,
    lookbackDays: 60,
    minimumClosedCandles: 60,
  }), /current UTC daily candle is not available/u);
});

test("forward collector rejects non-UTC daily timestamps", async () => {
  const client = fakeClient({ currentTimestamp: CURRENT_OPEN + 8 * 60 * 60 * 1000 });
  await assert.rejects(() => collectBitgetUtcDailyForwardCandles({
    client,
    symbol: "ETHUSDT",
    asOf: AS_OF,
    lookbackDays: 60,
    minimumClosedCandles: 60,
  }), /not aligned to a UTC daily boundary/u);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectPumpClosedOneMinutePathV1,
  collectPumpNextBarOpenReferenceV1,
} from "../src/crypto-pump-reversal-execution-public-source-v1.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const OPEN = Date.parse("2026-10-02T01:00:00.000Z");

function row(timestamp, open = 100) {
  return [
    String(timestamp),
    String(open),
    String(open + 1),
    String(open - 1),
    String(open),
    "10",
    "1000",
  ];
}

test("next-bar source returns the exact in-progress 1H bar open without claiming a fill", async () => {
  const client = {
    async get(path) {
      assert.equal(path, "/api/v2/mix/market/candles");
      return { code: "00000", data: [row(OPEN - HOUR, 90), row(OPEN, 100)] };
    },
  };
  const result = await collectPumpNextBarOpenReferenceV1({
    client,
    symbol: "ALTUSDT",
    expectedOpenAtMs: OPEN,
    observedAtMs: OPEN + 15_000,
  });
  assert.equal(result.status, "READY");
  assert.equal(result.entryReferencePrice, 100);
  assert.equal(result.sourceCandleTimestampMs, OPEN);
  assert.equal(result.actualExchangeFillClaim, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("historical backfill of a missed next bar is forbidden", async () => {
  const result = await collectPumpNextBarOpenReferenceV1({
    client: { async get() { throw new Error("SHOULD_NOT_CALL"); } },
    symbol: "ALTUSDT",
    expectedOpenAtMs: OPEN,
    observedAtMs: OPEN + HOUR,
  });
  assert.equal(result.status, "MISSED");
  assert.equal(result.blocker, "PUMP_NEXT_BAR_CAPTURE_WINDOW_EXPIRED");
});

test("1m source returns only closed contiguous candles", async () => {
  const start = OPEN;
  const end = OPEN + 4 * MINUTE + 30_000;
  const client = {
    async get(path) {
      assert.match(path, /history-candles$/);
      return {
        code: "00000",
        data: [
          row(OPEN + 3 * MINUTE, 103),
          row(OPEN + 2 * MINUTE, 102),
          row(OPEN + MINUTE, 101),
          row(OPEN, 100),
        ],
      };
    },
  };
  const result = await collectPumpClosedOneMinutePathV1({
    client,
    symbol: "ALTUSDT",
    startTime: start,
    endTime: end,
  });
  assert.equal(result.status, "READY");
  assert.equal(result.closedThroughMs, OPEN + 4 * MINUTE);
  assert.deepEqual(result.candles.map((candle) => candle.timestampMs), [
    OPEN,
    OPEN + MINUTE,
    OPEN + 2 * MINUTE,
    OPEN + 3 * MINUTE,
  ]);
  assert.equal(result.publicOnly, true);
});

test("missing one-minute bar blocks the path instead of silently bridging it", async () => {
  const client = {
    async get() {
      return {
        code: "00000",
        data: [
          row(OPEN + 2 * MINUTE, 102),
          row(OPEN, 100),
        ],
      };
    },
  };
  await assert.rejects(
    () => collectPumpClosedOneMinutePathV1({
      client,
      symbol: "ALTUSDT",
      startTime: OPEN,
      endTime: OPEN + 3 * MINUTE,
    }),
    /PUMP_1M_PATH_GAP/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { verifyLiveCollection } from "../src/live-collection-verifier.js";

function snapshot({ count = 96, gapAt = null, stale = false } = {}) {
  const interval = 15 * 60 * 1000;
  const now = Date.UTC(2026, 6, 30, 0, 0, 0);
  const candles = [];
  for (let index = 0; index < count; index += 1) {
    const extraGap = gapAt !== null && index >= gapAt ? interval : 0;
    const timestamp = now - ((count - 1 - index) * interval) - (stale ? interval * 10 : 0) + extraGap;
    candles.push({ timestamp, open: 100, high: 102, low: 99, close: 101, volume: 10 });
  }
  return {
    now,
    value: {
      schemaVersion: 1,
      provider: "bitget-public-v2",
      market: "CRYPTO_FUTURES",
      symbol: "BTCUSDT",
      timeframe: "15m",
      candles,
    },
  };
}

test("live verifier accepts a complete recent 15m collection", () => {
  const fixture = snapshot();
  const report = verifyLiveCollection(fixture.value, { minCandles: 90, now: fixture.now });
  assert.equal(report.status, "pass");
  assert.equal(report.candleCount, 96);
  assert.equal(report.gaps, 0);
});

test("live verifier rejects timeframe gaps", () => {
  const fixture = snapshot({ gapAt: 50 });
  assert.throws(
    () => verifyLiveCollection(fixture.value, { minCandles: 90, now: fixture.now }),
    /timeframe gaps detected/,
  );
});

test("live verifier rejects stale data and insufficient candles", () => {
  const staleFixture = snapshot({ stale: true });
  assert.throws(
    () => verifyLiveCollection(staleFixture.value, { minCandles: 90, now: staleFixture.now }),
    /stale/,
  );
  const shortFixture = snapshot({ count: 70 });
  assert.throws(
    () => verifyLiveCollection(shortFixture.value, { minCandles: 90, now: shortFixture.now }),
    /not enough candles/,
  );
});

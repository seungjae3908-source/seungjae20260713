import test from "node:test";
import assert from "node:assert/strict";
import {
  BINANCE_LIVE_TAIL_BLOCKER,
  inspectSelectionCandles,
  inspectSelectionFunding,
} from "../src/binance-scalping-selection-provider.js";

const M15 = 15 * 60 * 1000;
const H8 = 8 * 60 * 60 * 1000;

test("selection candle gate is independent from live tail and fails closed on missing bars", () => {
  const start = Date.UTC(2020, 0, 1);
  const end = start + 4 * M15;
  const mk = (timestamp) => ({ timestamp, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
  const ready = inspectSelectionCandles({ requestedSelectionStart: start, requestedSelectionEnd: end, candles: [0, 1, 2, 3].map((i) => mk(start + i * M15)) });
  assert.equal(ready.status, "DATA_READY");
  assert.equal(ready.expectedCandleCount, 4);
  assert.equal(ready.actualCandleCount, 4);
  const blocked = inspectSelectionCandles({ requestedSelectionStart: start, requestedSelectionEnd: end, candles: [0, 1, 3].map((i) => mk(start + i * M15)) });
  assert.equal(blocked.status, "BLOCKED_PROVIDER_COVERAGE");
  assert.equal(blocked.missingCandleCount, 1);
});

test("selection funding requires real archive edge coverage without synthetic fill", () => {
  const start = Date.UTC(2020, 0, 1);
  const end = start + 3 * H8;
  const ready = inspectSelectionFunding({ requestedSelectionStart: start, requestedSelectionEnd: end, records: [0, 1, 2, 3].map((i) => ({ timestamp: start + i * H8, rate: i % 2 ? -0.00005 : 0.0001 })) });
  assert.equal(ready.status, "DATA_READY");
  assert.equal(ready.fundingMissingIntervals, 0);
  const blocked = inspectSelectionFunding({ requestedSelectionStart: start, requestedSelectionEnd: end, records: [1, 2, 3].map((i) => ({ timestamp: start + i * H8, rate: 0.0001 })) });
  assert.equal(blocked.status, "DATA_READY");
  assert.ok(blocked.actualFirstFunding <= start + H8);
  assert.equal(BINANCE_LIVE_TAIL_BLOCKER, "BLOCKED_EXTERNAL_BINANCE_REST_GITHUB_RUNNER_LOCATION");
});

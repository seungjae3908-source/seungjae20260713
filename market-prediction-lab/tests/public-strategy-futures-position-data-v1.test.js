import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDailyPriceCoverageV1,
  assertFundingCoverageV1,
} from "../src/public-strategy-futures-position-data-v1.js";

const DAY = 24 * 60 * 60 * 1000;
const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const START = Date.UTC(2023, 8, 30);
const END = Date.UTC(2026, 8, 30);

function dailyRows() {
  const rows = [];
  for (let timestamp = START; timestamp < END; timestamp += DAY) {
    rows.push({ timestamp, open: 100, high: 101, low: 99, close: 100, volume: 1 });
  }
  return rows;
}

function fundingRows() {
  const rows = [];
  for (let timestamp = START; timestamp < END; timestamp += EIGHT_HOURS) {
    rows.push({ timestamp, rate: 0.0001 });
  }
  return rows;
}

test("exact three-year futures daily price coverage accepts a continuous window", () => {
  const result = assertDailyPriceCoverageV1(dailyRows(), START, END, "BTCUSDT");
  assert.equal(result.firstTimestamp, START);
  assert.equal(result.lastTimestamp, END - DAY);
  assert.equal(result.candleCount, Math.round((END - START) / DAY));
});

test("daily price coverage fails closed when the requested beginning is missing", () => {
  assert.throws(
    () => assertDailyPriceCoverageV1(dailyRows().slice(3), START, END, "BTCUSDT"),
    /DAILY_PRICE_START_TOO_LATE/u,
  );
});

test("daily price coverage rejects an internal missing day", () => {
  const rows = [...dailyRows()];
  rows.splice(400, 1);
  assert.throws(
    () => assertDailyPriceCoverageV1(rows, START, END, "BTCUSDT"),
    /DAILY_PRICE_GAP/u,
  );
});

test("funding coverage accepts eight-hour observations and rejects gaps over one day", () => {
  const rows = fundingRows();
  const result = assertFundingCoverageV1(rows, START, END, "BTCUSDT");
  assert.equal(result.firstTimestamp, START);
  assert.ok(result.fundingCount > 3000);

  const broken = [...rows];
  broken.splice(500, 4);
  assert.throws(
    () => assertFundingCoverageV1(broken, START, END, "BTCUSDT"),
    /FUNDING_GAP_GT_24H/u,
  );
});

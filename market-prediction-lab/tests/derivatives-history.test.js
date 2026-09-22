import test from "node:test";
import assert from "node:assert/strict";
import {
  collectFundingRateHistory,
  collectLongShortRatioHistory,
  createTemporalDerivativesProvider,
  normalizeLongShortRatioRecord,
  normalizeOpenInterestSnapshot,
  summarizeTemporalCoverage,
} from "../src/derivatives-history.js";

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1);

function fundingRows(count = 230) {
  return Array.from({ length: count }, (_, index) => ({
    symbol: "BTCUSDT",
    fundingRate: String(((index % 9) - 4) / 100000),
    fundingTime: String(START + index * 8 * HOUR),
  }));
}

test("funding collector paginates backward, deduplicates and respects the requested interval", async () => {
  const source = fundingRows();
  const client = {
    get: async (_path, params) => {
      const pageNo = Number(params.pageNo);
      const newestFirst = [...source].reverse();
      const start = (pageNo - 1) * 100;
      const page = newestFirst.slice(start, start + 100);
      return { code: "00000", data: pageNo === 1 ? [...page, page[0]] : page };
    },
  };
  const result = await collectFundingRateHistory({
    client,
    symbol: "BTCUSDT",
    startTime: START + 20 * 8 * HOUR,
    endTime: START + 220 * 8 * HOUR,
    now: () => START + 300 * 8 * HOUR,
  });
  assert.equal(result.records.length, 201);
  assert.equal(new Set(result.records.map((row) => row.timestamp)).size, result.records.length);
  assert.ok(result.records.every((row) => row.timestamp >= START + 20 * 8 * HOUR));
  assert.ok(result.records.every((row) => row.timestamp <= START + 220 * 8 * HOUR));
  assert.equal(result.collectedAt, START + 300 * 8 * HOUR);
});

test("funding collector rejects stalled pagination", async () => {
  const page = fundingRows(100);
  const client = { get: async () => ({ code: "00000", data: page }) };
  await assert.rejects(() => collectFundingRateHistory({
    client,
    symbol: "BTCUSDT",
    startTime: START - 10 * HOUR,
    endTime: START + 1000 * HOUR,
    maxPages: 3,
  }), /did not move backward/);
});

test("long-short public collector normalizes and sorts public ratio observations", async () => {
  const client = {
    get: async (path, params) => {
      assert.equal(path, "/api/v2/mix/market/long-short");
      assert.deepEqual(params, { symbol: "BTCUSDT", period: "1h" });
      return {
        code: "00000",
        data: [
          { longShortRatio: "1.20", ts: String(START + HOUR) },
          { longShortRatio: "1.10", ts: String(START) },
          { longShortRatio: "1.20", ts: String(START + HOUR) },
        ],
      };
    },
  };
  const result = await collectLongShortRatioHistory({ client, symbol: "BTCUSDT", period: "1h" });
  assert.equal(result.provider, "bitget-public-v2");
  assert.deepEqual(result.records.map((row) => row.ratio), [1.1, 1.2]);
  assert.deepEqual(result.records.map((row) => row.timestamp), [START, START + HOUR]);
});

test("long-short ratio stays fail-closed until temporal training parity is explicitly confirmed", () => {
  const history = [
    { longShortRatio: "1.1", ts: START },
    { longShortRatio: "1.2", ts: START + HOUR },
  ];
  const blocked = createTemporalDerivativesProvider({ longShortHistory: history });
  assert.equal(blocked({ anchorTimestamp: START + HOUR }).derivativesFeatures.longShortRatio, undefined);

  const enabled = createTemporalDerivativesProvider({
    longShortHistory: history,
    longShortTrainingParityConfirmed: true,
  });
  const row = enabled({ anchorTimestamp: START + 90 * 60 * 1000 });
  assert.equal(row.derivativesFeatures.longShortRatio, 1.2);
  assert.equal(row.featureAvailability.longShortKnown, true);
  assert.equal(row.featureAvailability.longShortTimestamp, START + HOUR);
});

test("long-short normalizer preserves exact decimal source text", () => {
  const row = normalizeLongShortRatioRecord({ ts: START, longShortRatio: "1.234500" });
  assert.equal(row.ratioRaw, "1.234500");
  assert.equal(row.ratio, 1.2345);
});

test("open-interest snapshots fail closed by default when training parity is not confirmed", () => {
  const provider = createTemporalDerivativesProvider({
    fundingHistory: [{ fundingRate: "0.0001", fundingTime: START }],
    openInterestSnapshots: [
      { timestamp: START, valueRaw: "100" },
      { timestamp: START + HOUR, valueRaw: "110" },
    ],
  });
  const result = provider({ anchorTimestamp: START + 90 * 60 * 1000 });
  assert.equal(result.derivativesFeatures.fundingRate, 0.0001);
  assert.equal(result.derivativesFeatures.openInterestChange, undefined);
  assert.equal(result.featureAvailability.openInterestKnown, false);
  assert.equal(result.featureAvailability.openInterestTimestamp, null);
});

test("temporal provider uses OI only after explicit training parity confirmation and never from the future", () => {
  const provider = createTemporalDerivativesProvider({
    fundingHistory: [
      { fundingRate: "0.0001", fundingTime: START },
      { fundingRate: "0.0002", fundingTime: START + 8 * HOUR },
    ],
    openInterestSnapshots: [
      { timestamp: START, valueRaw: "100" },
      { timestamp: START + HOUR, valueRaw: "110" },
      { timestamp: START + 2 * HOUR, valueRaw: "150" },
    ],
    openInterestTrainingParityConfirmed: true,
  });
  const atNinetyMinutes = provider({ anchorTimestamp: START + 90 * 60 * 1000 });
  assert.equal(atNinetyMinutes.derivativesFeatures.fundingRate, 0.0001);
  assert.equal(atNinetyMinutes.derivativesFeatures.openInterestChange, 0.1);
  assert.equal(atNinetyMinutes.featureAvailability.openInterestTimestamp, START + HOUR);

  const beforeAll = provider({ anchorTimestamp: START - HOUR });
  assert.deepEqual(beforeAll.derivativesFeatures, {});
  assert.equal(beforeAll.featureAvailability.fundingKnown, false);
  assert.equal(beforeAll.featureAvailability.openInterestKnown, false);
});

test("stale derivatives values remain missing instead of being carried forever", () => {
  const provider = createTemporalDerivativesProvider({
    fundingHistory: [{ fundingRate: "0.0001", fundingTime: START }],
    openInterestSnapshots: [
      { timestamp: START, valueRaw: "100" },
      { timestamp: START + HOUR, valueRaw: "110" },
    ],
    openInterestTrainingParityConfirmed: true,
    fundingMaxAgeMs: 2 * HOUR,
    openInterestMaxAgeMs: HOUR,
  });
  const result = provider({ anchorTimestamp: START + 5 * HOUR });
  assert.deepEqual(result.derivativesFeatures, {});
});

test("temporal provider rejects non-boolean OI training parity flags", () => {
  assert.throws(() => createTemporalDerivativesProvider({
    openInterestTrainingParityConfirmed: "yes",
  }), /must be boolean/);
});

test("coverage summary counts only truly available temporal features", () => {
  const summary = summarizeTemporalCoverage([
    { featureAvailability: { fundingKnown: true, openInterestKnown: false, longShortKnown: true } },
    { featureAvailability: { fundingKnown: true, openInterestKnown: true, longShortKnown: false } },
    { featureAvailability: { fundingKnown: false, openInterestKnown: false, longShortKnown: false } },
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.fundingKnown, 2);
  assert.equal(summary.openInterestKnown, 1);
  assert.equal(summary.longShortKnown, 1);
  assert.equal(summary.longShortCoverage, 1 / 3);
});

test("open-interest normalizer preserves decimal source text", () => {
  const row = normalizeOpenInterestSnapshot({ timestamp: START, valueRaw: "33145.5537000000088" });
  assert.equal(row.valueRaw, "33145.5537000000088");
  assert.equal(row.value, 33145.55370000001);
});

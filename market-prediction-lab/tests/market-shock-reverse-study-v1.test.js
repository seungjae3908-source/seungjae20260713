import assert from "node:assert/strict";
import test from "node:test";

import { analyzeMarketShockReverseStudyV1 } from "../src/market-shock-reverse-study-v1.js";

const HOUR = 60 * 60 * 1000;

function candles(count = 900) {
  const rows = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    const cycle = index % 90;
    const move = cycle === 30 ? 0.08 : cycle === 70 ? -0.08 : 0.0001 * Math.sin(index / 7);
    close = open * (1 + move);
    rows.push({
      timestamp: Date.UTC(2024, 0, 1) + index * HOUR,
      open,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      close,
      volume: cycle >= 26 && cycle <= 30 ? 400 : 100 + (index % 11),
      quoteVolume: (cycle >= 26 && cycle <= 30 ? 400 : 100 + (index % 11)) * close,
    });
  }
  return rows;
}

function run(rows = candles()) {
  return analyzeMarketShockReverseStudyV1({
    market: "CRYPTO_SPOT",
    symbol: "KRW-BTC",
    timeframe: "1h",
    datasetIdentity: "test:upbit:krw-btc:1h",
    candles: rows,
    policy: { eventMoveFraction: 0.04, neutralMoveFraction: 0.01, minimumEventsPerDirectionPerSplit: 2 },
  });
}

test("reverse study separates actual future labels from point-in-time features and disjoint TRAIN/OOS events", () => {
  const result = run();
  assert.equal(result.contract, "market-shock-reverse-study/v1");
  assert.ok(result.eventCounts.trainSurge >= 2);
  assert.ok(result.eventCounts.trainDrop >= 2);
  assert.ok(result.eventCounts.oosSurge >= 2);
  assert.ok(result.eventCounts.oosDrop >= 2);
  assert.equal(result.split.trainOosEventOverlapCount, 0);
  assert.equal(result.futureLeakageAllowed, false);
  assert.equal(result.formulaCandidateGenerated, false);
  assert.equal(result.executionAuthority, "NONE");
  assert.ok(result.studies.every((study) => study.status === "RESEARCH_HYPOTHESIS_ONLY"));
  assert.ok(result.studies.every((study) => study.hypothesis.selectedFrom === "TRAIN_ONLY"));
});

test("changing later candles cannot mutate earlier event features", () => {
  const original = candles();
  const changed = structuredClone(original);
  const cutoff = 500;
  for (let index = cutoff; index < changed.length; index += 1) {
    changed[index].volume *= 30;
    changed[index].quoteVolume *= 30;
  }
  const left = run(original).events.filter((row) => row.anchorIndex < cutoff - 6)
    .map((row) => ({ eventId: row.eventId, features: row.features }));
  const right = run(changed).events.filter((row) => row.anchorIndex < cutoff - 6)
    .map((row) => ({ eventId: row.eventId, features: row.features }));
  assert.deepEqual(right, left);
});

test("OHLCV-only study reports unavailable microstructure fields instead of fabricating them", () => {
  const rows = candles().map((row) => ({ ...row, quoteVolume: null }));
  const result = run(rows);
  assert.ok(result.unavailableFeatures.includes("ORDER_BOOK_IMBALANCE"));
  assert.ok(result.unavailableFeatures.includes("OPEN_INTEREST"));
  assert.ok(result.events.every((row) => row.features.quoteVolumeAcceleration5 === null));
  assert.equal(result.tradingPerformanceClaimed, false);
  assert.equal(result.paperRegistrationAllowed, false);
});

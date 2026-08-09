import test from "node:test";
import assert from "node:assert/strict";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { normalizeCandleRows } from "../src/normalizers.js";
import { generateCandles } from "../src/synthetic-data.js";

const snapshot = normalizeCandleRows(generateCandles({ count: 260 }), {
  market: "CRYPTO_FUTURES",
  symbol: "BTCUSDT",
  timeframe: "15m",
  format: "canonical-object",
  source: "temporal-provider-test",
  strict: true,
});

test("training records request derivatives independently at every anchor", () => {
  const seenAnchors = [];
  const records = buildTrainingRecords(snapshot, {
    lookback: 100,
    horizon: 5,
    stride: 10,
    derivativesFeatureProvider: ({ anchorTimestamp, history }) => {
      seenAnchors.push(anchorTimestamp);
      assert.equal(history.at(-1).timestamp, anchorTimestamp);
      assert.ok(history.every((candle) => candle.timestamp <= anchorTimestamp));
      return {
        derivativesFeatures: { fundingRate: anchorTimestamp % 2 === 0 ? 0.0001 : -0.0001 },
        featureAvailability: { fundingKnown: true, fundingTimestamp: anchorTimestamp },
      };
    },
  });
  assert.equal(records.length, seenAnchors.length);
  assert.ok(records.length > 10);
  assert.ok(records.every((record) => record.featureAvailability.fundingTimestamp === record.anchorTimestamp));
  assert.ok(records.every((record) => record.schemaVersion === 2));
});

test("invalid provider output fails closed", () => {
  assert.throws(() => buildTrainingRecords(snapshot, {
    lookback: 100,
    horizon: 5,
    stride: 20,
    derivativesFeatureProvider: () => null,
  }), /returned an invalid value/);
});

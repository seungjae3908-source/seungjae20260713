import test from "node:test";
import assert from "node:assert/strict";
import { collectBitgetDerivedCandles, createTemporalMarketStructureProvider, summarizeStructureCoverage } from "../src/market-structure-history.js";

const START = Date.UTC(2026, 0, 1);
const INTERVAL = 15 * 60 * 1000;

function rows(count, multiplier = 1) {
  return Array.from({ length: count }, (_, index) => {
    const timestamp = START + index * INTERVAL;
    const close = (100 + index * 0.01) * multiplier;
    return [String(timestamp), String(close), String(close + 0.1), String(close - 0.1), String(close), "0", "0"];
  });
}

test("derived candle collector preserves every page boundary", async () => {
  const source = rows(520);
  const client = {
    get: async (_path, params) => {
      const eligible = source.filter((row) => Number(row[0]) < Number(params.endTime));
      return { code: "00000", data: eligible.slice(-200) };
    },
  };
  const result = await collectBitgetDerivedCandles({
    client,
    kind: "mark",
    symbol: "BTCUSDT",
    timeframe: "15m",
    startTime: START,
    endTime: START + 520 * INTERVAL,
  });
  assert.equal(result.candles.length, 520);
  for (let index = 1; index < result.candles.length; index += 1) {
    assert.equal(result.candles[index].timestamp - result.candles[index - 1].timestamp, INTERVAL);
  }
});

test("structure provider uses only exact mark and index candles at the anchor", () => {
  const market = rows(120).map((row) => ({
    timestamp: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: 1,
  }));
  const mark = rows(120, 0.999).map((row) => ({
    timestamp: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: 0,
  }));
  const index = rows(120, 0.998).map((row) => ({
    timestamp: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: 0,
  }));
  const funding = Array.from({ length: 8 }, (_, indexValue) => ({
    fundingRate: String(indexValue * 0.00001),
    fundingTime: String(START + indexValue * 8 * 60 * 60 * 1000),
  }));
  const provider = createTemporalMarketStructureProvider({ fundingHistory: funding, markCandles: mark, indexCandles: index });
  const anchorTimestamp = market[100].timestamp;
  const result = provider({ anchorTimestamp, history: market.slice(1, 101) });
  assert.equal(result.featureAvailability.markKnown, true);
  assert.equal(result.featureAvailability.indexKnown, true);
  assert.equal(result.featureAvailability.structureTimestamp, anchorTimestamp);
  assert.ok(Number.isFinite(result.derivativesFeatures.basisRate));
  assert.ok(Number.isFinite(result.derivativesFeatures.markPremium));
  assert.ok(Number.isFinite(result.derivativesFeatures.marketMarkSpread));
  assert.ok(Number.isFinite(result.derivativesFeatures.fundingRateChange));
  assert.ok(Number.isFinite(result.derivativesFeatures.fundingRateZScore));
});

test("missing exact index candle leaves structure unavailable instead of carrying future data", () => {
  const market = rows(80).map((row) => ({ timestamp: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: 1 }));
  const mark = rows(80).map((row) => ({ timestamp: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: 0 }));
  const index = rows(80).filter((_, rowIndex) => rowIndex !== 70).map((row) => ({ timestamp: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: 0 }));
  const provider = createTemporalMarketStructureProvider({ markCandles: mark, indexCandles: index });
  const result = provider({ anchorTimestamp: market[70].timestamp, history: market.slice(11, 71) });
  assert.equal(result.featureAvailability.markKnown, true);
  assert.equal(result.featureAvailability.indexKnown, false);
  assert.equal(result.featureAvailability.structureTimestamp, null);
  assert.equal(result.derivativesFeatures.basisRate, undefined);
});

test("coverage summary reports funding and full structure separately", () => {
  const summary = summarizeStructureCoverage([
    { featureAvailability: { fundingKnown: true, structureTimestamp: 1 } },
    { featureAvailability: { fundingKnown: true, structureTimestamp: null } },
    { featureAvailability: { fundingKnown: false, structureTimestamp: null } },
  ]);
  assert.equal(summary.fundingCoverage, 2 / 3);
  assert.equal(summary.structureCoverage, 1 / 3);
});

import test from "node:test";
import assert from "node:assert/strict";
import { settleHistoricalDiscoveryReplay } from "../src/historical-discovery-settlement-v1.js";

const DAY = 24 * 60 * 60 * 1000;

function replay({ market = "KR_STOCK", strategyMode = "SWING", candidates = [] } = {}) {
  return {
    schemaVersion: "historical-market-replay-v1",
    status: "READY",
    market,
    strategyMode,
    replayRows: [{
      asOfMs: 1_700_000_000_000,
      discoveryCandidates: candidates,
      discoveryCandidateCount: candidates.length,
      searchOutcome: candidates.length ? "DISCOVERY_CANDIDATES" : "VALID_ZERO_DISCOVERY",
    }],
    pointInTimeOnly: true,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  };
}

function stockUniverse({ asOfMs, settleAtMs, syntheticHistoricalData = false, universeAsOfMs = asOfMs } = {}) {
  const midpoint = asOfMs + Math.max(1, Math.floor((settleAtMs - asOfMs) / 2));
  return {
    universeAsOfMs,
    syntheticHistoricalData,
    entries: [
      { symbol: "ALPHA", entryPrice: 100, observations: [{ timestampMs: midpoint, price: 103 }, { timestampMs: settleAtMs, price: 105 }] },
      { symbol: "BETA", entryPrice: 100, observations: [{ timestampMs: midpoint, price: 104 }, { timestampMs: settleAtMs, price: 106 }] },
      { symbol: "GAMMA", entryPrice: 100, observations: [{ timestampMs: midpoint, price: 99 }, { timestampMs: settleAtMs, price: 98 }] },
    ],
  };
}

test("stock discovery scoring measures both precision and missed rising opportunities", async () => {
  const result = await settleHistoricalDiscoveryReplay({
    replayResult: replay({ candidates: [
      { signalId: "alpha-long", symbol: "ALPHA", direction: "LONG" },
      { signalId: "gamma-long", symbol: "GAMMA", direction: "LONG" },
    ] }),
    successThresholdPctByHorizon: { "1D": 2, "3D": 2, "5D": 2 },
    loadGroundTruthUniverse: async ({ asOfMs, settleAtMs }) => stockUniverse({ asOfMs, settleAtMs }),
  });

  assert.equal(result.status, "READY");
  assert.equal(result.settledSignalCount, 6);
  assert.equal(result.groundTruthOpportunityCount, 6);
  assert.equal(result.metrics.byHorizon["1D"].signalCount, 2);
  assert.equal(result.metrics.byHorizon["1D"].hitCount, 1);
  assert.equal(result.metrics.byHorizon["1D"].precision, 0.5);
  assert.equal(result.metrics.byHorizon["1D"].groundTruthOpportunityCount, 2);
  assert.equal(result.metrics.byHorizon["1D"].matchedOpportunityCount, 1);
  assert.equal(result.metrics.byHorizon["1D"].recall, 0.5);
  assert.equal(result.futureDataUsedForScoringOnly, true);
  assert.equal(result.searchInputContainsFutureData, false);
  assert.equal(result.profitabilityClaimAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("futures ground truth supports short opportunities and directional scoring", async () => {
  const asOfMs = 1_700_000_000_000;
  const result = await settleHistoricalDiscoveryReplay({
    replayResult: replay({
      market: "CRYPTO_FUTURES",
      strategyMode: "SCALPING",
      candidates: [{ signalId: "btc-short", symbol: "BTCUSDT", direction: "SHORT" }],
    }),
    successThresholdPctByHorizon: { "5M": 1, "15M": 1, "30M": 1, "60M": 1, "1D": 1 },
    loadGroundTruthUniverse: async ({ settleAtMs }) => ({
      universeAsOfMs: asOfMs,
      entries: [{
        symbol: "BTCUSDT",
        entryPrice: 100,
        observations: [
          { timestampMs: asOfMs + Math.min(60_000, settleAtMs - asOfMs), price: 98 },
          { timestampMs: settleAtMs, price: 95 },
        ],
      }],
    }),
  });

  assert.equal(result.status, "READY");
  assert.equal(result.metrics.byHorizon["5M"].hitCount, 1);
  assert.equal(result.metrics.byHorizon["5M"].recall, 1);
  assert.equal(result.settledSignals[0].direction, "SHORT");
  assert.ok(result.settledSignals[0].returnPct < 0);
  assert.ok(result.metrics.byHorizon["5M"].averageDirectionalReturnPct > 0);
});

test("synthetic ground truth fails closed instead of creating historical performance", async () => {
  const result = await settleHistoricalDiscoveryReplay({
    replayResult: replay({ candidates: [{ signalId: "a", symbol: "ALPHA", direction: "LONG" }] }),
    successThresholdPctByHorizon: { "1D": 2, "3D": 2, "5D": 2 },
    loadGroundTruthUniverse: async ({ asOfMs, settleAtMs }) => stockUniverse({ asOfMs, settleAtMs, syntheticHistoricalData: true }),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "SYNTHETIC_GROUND_TRUTH_FORBIDDEN");
  assert.equal(result.metrics, null);
});

test("future universe membership fails closed", async () => {
  const asOfMs = 1_700_000_000_000;
  const result = await settleHistoricalDiscoveryReplay({
    replayResult: replay({ candidates: [{ signalId: "a", symbol: "ALPHA", direction: "LONG" }] }),
    successThresholdPctByHorizon: { "1D": 2, "3D": 2, "5D": 2 },
    loadGroundTruthUniverse: async ({ settleAtMs }) => stockUniverse({
      asOfMs,
      settleAtMs,
      universeAsOfMs: asOfMs + DAY,
    }),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "FUTURE_UNIVERSE_MEMBERSHIP_DETECTED");
});

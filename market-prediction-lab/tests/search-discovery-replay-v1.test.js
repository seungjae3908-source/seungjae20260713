import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchDiscoveryCandidate, buildSearchDiscoverySnapshot } from "../src/search-discovery-contract-v1.js";
import { resolveStrategyHorizon, buildStrategySettlementSchedule } from "../src/strategy-horizon-contract-v1.js";
import { runHistoricalMarketReplay } from "../src/historical-market-replay-v1.js";
import { computeSearchQualityMetrics } from "../src/search-quality-metrics-v1.js";

const DAY = 24 * 60 * 60 * 1000;

test("discovery stays visible when profitability evidence is missing while Paper and auto-trading stay blocked", () => {
  const row = buildSearchDiscoveryCandidate({
    market: "CRYPTO_SPOT",
    card: { signalId: "s1", symbol: "KRW-BTC", signalGrade: "A", action: "BUY", dataState: "complete" },
    profitGate: { eligible: false, reasons: ["COST_NOT_EVIDENCED", "INSUFFICIENT_SAMPLE"] },
  });
  assert.equal(row.status, "DISCOVERED");
  assert.equal(row.visibleInSearch, true);
  assert.equal(row.paperEligible, false);
  assert.equal(row.autoTradeEligible, false);
  assert.deepEqual(row.tradingBlockers, ["COST_NOT_EVIDENCED", "INSUFFICIENT_SAMPLE"]);
  assert.equal(row.searchVisibilityDependsOnProfitGate, false);
  assert.equal(row.orderSubmitted, false);
});

test("untrusted data blocks discovery instead of being relabeled as a profit rejection", () => {
  const row = buildSearchDiscoveryCandidate({ market: "US_STOCK", card: { signalId: "s2", symbol: "ABC", action: "BUY", dataState: "untrusted" } });
  assert.equal(row.visibleInSearch, false);
  assert.deepEqual(row.discoveryBlockers, ["DATA_NOT_TRUSTED"]);
});

test("discovery snapshot counts search visibility separately from Paper eligibility", () => {
  const candidates = [
    buildSearchDiscoveryCandidate({ market: "KR_STOCK", card: { signalId: "a", symbol: "005930", action: "BUY" }, profitGate: { eligible: false, reasons: ["COST_NOT_EVIDENCED"] } }),
    buildSearchDiscoveryCandidate({ market: "KR_STOCK", card: { signalId: "b", symbol: "000660", action: "BUY" }, profitGate: { eligible: true, reasons: [] } }),
  ];
  const snapshot = buildSearchDiscoverySnapshot(candidates);
  assert.equal(snapshot.discoveryCandidateCount, 2);
  assert.equal(snapshot.paperEligibleCount, 1);
  assert.equal(snapshot.autoTradeEligibleCount, 0);
});

test("strategy horizons match short, swing and mid-long intent without pretending calendar days are exchange sessions", () => {
  assert.deepEqual(resolveStrategyHorizon("scalping").checkpoints.map((row) => row.key), ["5M", "15M", "30M", "60M", "1D"]);
  assert.deepEqual(resolveStrategyHorizon("swing").checkpoints.map((row) => row.key), ["1D", "3D", "5D"]);
  assert.deepEqual(resolveStrategyHorizon("position").checkpoints.map((row) => row.key), ["30D", "90D", "180D"]);
  const schedule = buildStrategySettlementSchedule({ mode: "SWING", signalAtMs: 1_000_000 });
  assert.equal(schedule.targets.at(-1).settleAtMs, 1_000_000 + 5 * DAY);
  assert.equal(schedule.exchangeSessionCalendarRequiredForTradingDayClaims, true);
});

test("historical replay fails closed on future observations", async () => {
  const result = await runHistoricalMarketReplay({
    market: "CRYPTO_FUTURES", strategyMode: "SCALPING", replayTimes: [1_000_000],
    loadSnapshot: async ({ asOfMs }) => ({ dataCutoffMs: asOfMs + 1, observations: [] }),
    searchSnapshot: async () => ({ discoveryCandidates: [] }),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "LOOKAHEAD_DATA_DETECTED");
});

test("historical stock replay requires a proven point-in-time universe with removed-name coverage", async () => {
  const result = await runHistoricalMarketReplay({
    market: "KR_STOCK", strategyMode: "SWING", replayTimes: [2_000_000, 3_000_000],
    loadSnapshot: async ({ asOfMs }) => ({ dataCutoffMs: asOfMs }),
    searchSnapshot: async () => ({ discoveryCandidates: [] }),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "POINT_IN_TIME_STOCK_UNIVERSE_NOT_PROVEN");
});

test("historical replay forbids synthetic history and keeps search execution powerless", async () => {
  const blocked = await runHistoricalMarketReplay({
    market: "CRYPTO_SPOT", strategyMode: "SWING", replayTimes: [2_000_000],
    loadSnapshot: async ({ asOfMs }) => ({ dataCutoffMs: asOfMs, syntheticHistoricalData: true }),
    searchSnapshot: async () => ({ discoveryCandidates: [] }),
  });
  assert.equal(blocked.reason, "SYNTHETIC_HISTORICAL_DATA_FORBIDDEN");

  const ready = await runHistoricalMarketReplay({
    market: "CRYPTO_SPOT", strategyMode: "SWING", replayTimes: [2_000_000],
    loadSnapshot: async ({ asOfMs }) => ({ dataCutoffMs: asOfMs, observations: [{ timestampMs: asOfMs }] }),
    searchSnapshot: async () => ({ discoveryOutcome: "DISCOVERY_CANDIDATES", discoveryCandidates: [{ symbol: "KRW-BTC" }], executionAuthority: "NONE", orderSubmitted: false }),
  });
  assert.equal(ready.status, "READY");
  assert.equal(ready.replayRows[0].discoveryCandidateCount, 1);
  assert.equal(ready.realOrder, false);
});

test("search quality reports recall and precision from settled discovery outcomes and preserves missing denominators", () => {
  const metrics = computeSearchQualityMetrics({
    settledSignals: [
      { horizonKey: "1D", direction: "LONG", hit: true, opportunityId: "A", returnPct: 4, mfePct: 6, maePct: 1, leadTimeMs: 60_000 },
      { horizonKey: "1D", direction: "LONG", hit: false, returnPct: -2, mfePct: 1, maePct: 3 },
      { horizonKey: "1D", direction: "SHORT", hit: true, opportunityId: "B", returnPct: -5, mfePct: 7, maePct: 2, leadTimeMs: 120_000 },
    ],
    groundTruthOpportunities: [
      { horizonKey: "1D", opportunityId: "A" }, { horizonKey: "1D", opportunityId: "B" }, { horizonKey: "1D", opportunityId: "C" },
    ],
  });
  assert.equal(metrics.overall.signalCount, 3);
  assert.equal(metrics.overall.precision, 2 / 3);
  assert.equal(metrics.overall.recall, 2 / 3);
  assert.equal(metrics.overall.averageDirectionalReturnPct, (4 - 2 + 5) / 3);
  assert.equal(metrics.overall.averageLeadTimeMs, 90_000);
  const empty = computeSearchQualityMetrics();
  assert.equal(empty.overall.precision, null);
  assert.equal(empty.overall.recall, null);
  assert.equal(empty.overall.averageMfePct, null);
});

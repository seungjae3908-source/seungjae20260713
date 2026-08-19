import test from "node:test";
import assert from "node:assert/strict";
import { runCanonicalDiscoverySearchMarket } from "../src/canonical-scanner-discovery-runtime-v1.js";

function response({ total = 2, nextCursor = null, cards = [] } = {}) {
  return {
    universe: { totalCount: total, nextCursor, source: "public-live", partial: false, stale: false },
    execution: {
      requestedCount: 2, completedCount: 2, providerAcceptedCount: 2, providerErrorCount: 0,
      timeoutCount: 0, insufficientDataCount: 0, hardFilterPassCount: 2,
      hardFilterRejectedCount: 0, softCandidateCount: cards.length, filteredByStrategyCount: 0,
    },
    cards,
    failures: [],
  };
}

function card(signalId, symbol, signalGrade = "B") {
  return { signalId, symbol, signalGrade, action: "BUY", dataState: "complete" };
}

test("canonical discovery exposes soft candidates even when strict trade result is VALID_NO_TRADE", async () => {
  const batches = [
    response({ total: 4, nextCursor: 2, cards: [card("a", "AAA")] }),
    response({ total: 4, cards: [card("b", "BBB")] }),
  ];
  const result = await runCanonicalDiscoverySearchMarket({
    market: "KR_STOCK",
    scanBatch: async () => batches.shift(),
  });

  assert.equal(result.outcome, "VALID_NO_TRADE");
  assert.equal(result.finalCandidates, 0);
  assert.equal(result.discoveryOutcome, "DISCOVERY_CANDIDATES");
  assert.equal(result.discoveryCandidateCount, 2);
  assert.equal(result.discoveryPaperEligibleCount, 0);
  assert.equal(result.discoveryAutoTradeEligibleCount, 0);
  assert.equal(result.discoveryCandidates.every((row) => row.visibleInSearch), true);
  assert.equal(result.discoveryCandidates.every((row) => row.paperEligible === false), true);
  assert.equal(result.discoveryCandidates.every((row) => row.tradingBlockers.includes("COST_NOT_EVIDENCED")), true);
  assert.equal(result.searchVisibilityDependsOnProfitGate, false);
  assert.equal(result.liveTrading, false);
});

test("canonical discovery preserves strict Paper eligibility when profit evidence passes", async () => {
  const result = await runCanonicalDiscoverySearchMarket({
    market: "CRYPTO_SPOT",
    scanBatch: async () => response({ cards: [card("spot-a", "KRW-BTC", "A")] }),
    profitInputForCard: async () => ({
      probabilities: { tp: .7, sl: .2, expire: .1 },
      returns: { target: .05, stop: .02, expire: 0 },
      costs: { status: "READY", components: { commission: .001, spread: .001, slippage: .001 } },
      calibration: { status: "READY", sampleSize: 200, tpFirstCount: 140 },
    }),
  });

  assert.equal(result.outcome, "TRADE_CANDIDATES");
  assert.equal(result.finalCandidates, 1);
  assert.equal(result.discoveryCandidateCount, 1);
  assert.equal(result.discoveryPaperEligibleCount, 1);
  assert.equal(result.discoveryCandidates[0].paperEligible, true);
  assert.equal(result.discoveryCandidates[0].autoTradeEligible, false);
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
});

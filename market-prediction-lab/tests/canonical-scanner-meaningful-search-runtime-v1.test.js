import test from "node:test";
import assert from "node:assert/strict";
import { runCanonicalMeaningfulSearchMarket } from "../src/canonical-scanner-meaningful-search-runtime-v1.js";

function response({ total = 2, nextCursor = null, providerErrorCount = 0, cards = [], source = "public-live", partial = false } = {}) {
  return {
    universe: { totalCount: total, nextCursor, source, partial, stale: false },
    execution: {
      requestedCount: 2, completedCount: 2, providerAcceptedCount: 2, providerErrorCount,
      timeoutCount: 0, insufficientDataCount: 0, hardFilterPassCount: 2,
      hardFilterRejectedCount: 0, softCandidateCount: cards.length, filteredByStrategyCount: 0,
    },
    cards,
    failures: [],
  };
}

function card(signalId, signalGrade = "B") { return { signalId, signalGrade }; }

test("canonical batches aggregate a full live universe and preserve valid NO_TRADE", async () => {
  const batches = [response({ total: 4, nextCursor: 2, cards: [card("a")] }), response({ total: 4, cards: [card("b")] })];
  const result = await runCanonicalMeaningfulSearchMarket({ market: "KR_STOCK", scanBatch: async () => batches.shift() });
  assert.equal(result.universe.total, 4);
  assert.equal(result.universe.attempted, 4);
  assert.equal(result.universe.coverageComplete, true);
  assert.equal(result.providerRequested, 4);
  assert.equal(result.providerStarted, 4);
  assert.equal(result.providerCompleted, 4);
  assert.equal(result.softCandidates, 2);
  assert.equal(result.profitGateReject, 2);
  assert.equal(result.outcome, "VALID_NO_TRADE");
  assert.equal(result.topRejectReasons.some((item) => item.reason === "COST_NOT_EVIDENCED"), true);
  assert.equal(result.liveTrading, false);
});

test("one provider failure prevents a partial sweep from being reported as VALID_NO_TRADE", async () => {
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "CRYPTO_FUTURES",
    scanBatch: async () => response({ providerErrorCount: 1 }),
  });
  assert.equal(result.universe.coverageComplete, true);
  assert.equal(result.providerIntegrityComplete, false);
  assert.equal(result.outcome, "SEARCH_FAILURE");
});

test("an early canonical cursor stop is SEARCH_FAILURE even with a live universe source", async () => {
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "KR_STOCK",
    scanBatch: async () => response({ total: 100, nextCursor: null }),
  });
  assert.equal(result.universe.attempted, 2);
  assert.equal(result.universe.coverageComplete, false);
  assert.equal(result.outcome, "SEARCH_FAILURE");
  assert.equal(result.validNoTrade, false);
});

test("universe fallback is SEARCH_FAILURE even when fallback symbols return data", async () => {
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "US_STOCK",
    scanBatch: async () => response({ source: "curated-fallback", partial: true }),
  });
  assert.equal(result.searchFailure, true);
  assert.equal(result.validNoTrade, false);
  assert.equal(result.outcome, "SEARCH_FAILURE");
});

test("validated costs, calibration and conservative EV can pass without creating an order", async () => {
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "CRYPTO_SPOT",
    scanBatch: async () => response({ cards: [card("spot-a", "A")] }),
    profitInputForCard: async () => ({
      probabilities: { tp: .7, sl: .2, expire: .1 }, returns: { target: .05, stop: .02, expire: 0 },
      costs: { status: "READY", components: { commission: .001, spread: .001, slippage: .001 } },
      calibration: { status: "READY", sampleSize: 200, tpFirstCount: 140 },
    }),
  });
  assert.equal(result.profitGatePass, 1);
  assert.equal(result.finalCandidates, 1);
  assert.equal(result.outcome, "TRADE_CANDIDATES");
  assert.equal(result.orderSubmitted, false);
});

test("futures runtime-only OI feature is counted as a fail-closed parity rejection", async () => {
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "CRYPTO_FUTURES",
    scanBatch: async () => response({ cards: [card("future-a")] }),
    profitInputForCard: async () => ({ featureParity: { pass: false, blockedFeatures: ["openInterestChange"] } }),
  });
  assert.equal(result.oiParityBlocked, 1);
  assert.equal(result.finalCandidates, 0);
  assert.equal(result.privateApiUsed, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { runCanonicalMeaningfulSearchPaperMarket } from "../src/canonical-meaningful-search-paper-runtime-v1.js";

const NOW = Date.UTC(2026, 7, 16, 4, 0, 0);
const RESEARCH_SHA = "0123456789abcdef0123456789abcdef01234567";

function response({ total = 2, providerErrorCount = 0, cards = [], source = "public-live", partial = false } = {}) {
  return {
    universe: { totalCount: total, nextCursor: null, source, partial, stale: false },
    execution: {
      requestedCount: total,
      completedCount: total,
      providerAcceptedCount: total,
      providerErrorCount,
      timeoutCount: 0,
      insufficientDataCount: 0,
      hardFilterPassCount: total,
      hardFilterRejectedCount: 0,
      softCandidateCount: cards.length,
      filteredByStrategyCount: 0,
    },
    cards,
    failures: [],
  };
}

function paperCandidate(signalId = "spot-a") {
  return {
    signal: {
      signalId,
      market: "CRYPTO_SPOT",
      symbol: "BTC",
      timestampMs: NOW,
      direction: "BUY",
      lifecycle: "ACTIVE",
      positionSide: "FLAT",
      style: "SWING",
      timeframe: "4h",
      horizon: 6,
      strategyIdentity: {
        strategyId: "profit-first-swing",
        strategyVersion: "v1",
        parameterHash: "params-v1",
        researchCodeSha: RESEARCH_SHA,
      },
      learningSnapshot: { signalId },
    },
    riskEvidence: {
      status: "APPROVED",
      simulatedOnly: true,
      evaluatedAtMs: NOW,
    },
    execution: {
      dataEvidence: {
        dataQuality: "READY",
        asOfMs: NOW,
        maxAgeMs: 8 * 60 * 60 * 1000,
      },
    },
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function card(signalId = "spot-a", candidate = paperCandidate(signalId)) {
  return {
    market: "CRYPTO_SPOT",
    symbol: "BTC",
    signalId,
    signalGrade: "A",
    paperCandidate: candidate,
  };
}

function profitableInput(overrides = {}) {
  return {
    probabilities: { tp: 0.7, sl: 0.2, expire: 0.1 },
    returns: { target: 0.05, stop: 0.02, expire: 0 },
    costs: {
      status: "READY",
      policyId: "paper-cost-policy-v1",
      components: { commission: 0.001, spread: 0.001, slippage: 0.001 },
    },
    calibration: { status: "READY", sampleSize: 200, tpFirstCount: 140 },
    ...overrides,
  };
}

test("Profit-First eligible candidate is retained and prepared for Paper without order authority", async () => {
  const result = await runCanonicalMeaningfulSearchPaperMarket({
    market: "CRYPTO_SPOT",
    scanBatch: async () => response({ cards: [card()] }),
    profitInputForCard: async () => profitableInput(),
  });

  assert.equal(result.search.outcome, "TRADE_CANDIDATES");
  assert.equal(result.search.finalCandidates, 1);
  assert.equal(result.capturedProfitGateCandidates, 1);
  assert.equal(result.bridgeEligibleCandidates, 1);
  assert.equal(result.paperBridge.candidates.length, 1);
  assert.equal(result.paperBridge.candidates[0].signal.signalId, "spot-a");
  assert.equal(result.paperBridge.candidates[0].profitEvidence.costPolicyId, "paper-cost-policy-v1");
  assert.ok(result.paperBridge.candidates[0].profitEvidence.expectedNetEdge > 0);
  assert.equal(result.status, "PAPER_CANDIDATES_READY");
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.liveOrderAllowed, false);
});

test("SEARCH_FAILURE blocks a Profit-First candidate before Paper submission", async () => {
  const result = await runCanonicalMeaningfulSearchPaperMarket({
    market: "CRYPTO_SPOT",
    scanBatch: async () => response({ providerErrorCount: 1, cards: [card()] }),
    profitInputForCard: async () => profitableInput(),
  });

  assert.equal(result.search.outcome, "SEARCH_FAILURE");
  assert.equal(result.capturedProfitGateCandidates, 1);
  assert.equal(result.bridgeEligibleCandidates, 0);
  assert.equal(result.paperBridge.blocked, 1);
  assert.equal(result.paperBridge.results[0].blockers.includes("SEARCH_FAILURE"), true);
  assert.equal(result.status, "SEARCH_FAILURE_BLOCKED");
});

test("missing explicit cost policy cannot cross the Paper bridge even when the Profit Gate passes", async () => {
  const result = await runCanonicalMeaningfulSearchPaperMarket({
    market: "CRYPTO_SPOT",
    scanBatch: async () => response({ cards: [card()] }),
    profitInputForCard: async () => profitableInput({
      costs: { status: "READY", components: { commission: 0.001, spread: 0.001, slippage: 0.001 } },
    }),
  });

  assert.equal(result.search.finalCandidates, 1);
  assert.equal(result.bridgeEligibleCandidates, 0);
  assert.equal(result.paperBridge.blocked, 1);
  assert.equal(result.paperBridge.results[0].blockers.includes("COST_POLICY_EVIDENCE_REQUIRED"), true);
  assert.equal(result.status, "PAPER_CANDIDATE_CONTRACT_BLOCKED");
});

test("VALID_NO_TRADE remains zero-candidate and does not fabricate Paper samples", async () => {
  const result = await runCanonicalMeaningfulSearchPaperMarket({
    market: "CRYPTO_SPOT",
    scanBatch: async () => response({ cards: [card()] }),
  });

  assert.equal(result.search.outcome, "VALID_NO_TRADE");
  assert.equal(result.search.finalCandidates, 0);
  assert.equal(result.capturedProfitGateCandidates, 0);
  assert.equal(result.paperBridge.candidates.length, 0);
  assert.equal(result.status, "VALID_NO_TRADE");
});

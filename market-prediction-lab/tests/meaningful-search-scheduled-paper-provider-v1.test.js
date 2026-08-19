import test from "node:test";
import assert from "node:assert/strict";
import { prepareMeaningfulSearchPaperCandidate } from "../src/meaningful-search-paper-bridge-v1.js";
import { wrapPaperForwardProviderWithMeaningfulSearch } from "../src/meaningful-search-scheduled-paper-provider-v1.js";

const NOW = Date.UTC(2026, 7, 20, 0, 20, 0);
const SHA = "0123456789abcdef0123456789abcdef01234567";

function baseEvidence(market = "CRYPTO_SPOT") {
  return Object.freeze({
    status: "READY",
    publicOnly: true,
    market,
    provider: "upbit-public-candles",
    provenance: Object.freeze({ provider: "upbit-public-candles", market, symbol: "BTC", timeframe: "4h" }),
    dataAsOfMs: NOW,
    observedAtMs: NOW,
    maxAgeMs: 8 * 60 * 60 * 1000,
    candidates: Object.freeze([]),
    exits: Object.freeze([]),
    blocker: null,
  });
}

function strategyIdentity() {
  return {
    strategyId: "profit-first-swing",
    strategyVersion: "v1",
    parameterHash: "params-v1",
    researchCodeSha: SHA,
  };
}

function candidate(overrides = {}) {
  const signal = {
    signalId: "spot-btc-swing-1",
    market: "CRYPTO_SPOT",
    symbol: "BTC",
    timestampMs: NOW,
    timeframe: "4h",
    horizon: 6,
    direction: "BUY",
    signalDirection: "BUY",
    regime: "TREND",
    strategyIdentity: strategyIdentity(),
  };
  const value = {
    signal,
    paperIdentity: {
      signalId: signal.signalId,
      strategyId: signal.strategyIdentity.strategyId,
      strategyVersion: signal.strategyIdentity.strategyVersion,
      parameterHash: signal.strategyIdentity.parameterHash,
      market: signal.market,
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      horizon: signal.horizon,
      direction: signal.signalDirection,
      regime: signal.regime,
      costPolicyVersion: "paper-cost-policy-v1",
      researchCodeSha: SHA,
      executionAuthority: "NONE",
    },
    profitEvidence: {
      status: "READY",
      costPolicyId: "paper-cost-policy-v1",
      executionAuthority: "NONE",
    },
    execution: {
      costPolicy: { version: "paper-cost-policy-v1" },
    },
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...overrides,
  };
  return Object.freeze(value);
}

function canonicalExitCandidate() {
  const signalId = "spot-btc-exit-1";
  const identity = strategyIdentity();
  const decision = prepareMeaningfulSearchPaperCandidate({
    searchOutcome: "TRADE_CANDIDATES",
    candidate: {
      signal: {
        signalId,
        market: "CRYPTO_SPOT",
        symbol: "BTC",
        timestampMs: NOW - 2,
        lifecycle: "ACTIVE",
        style: "SWING",
        timeframe: "4h",
        horizon: 6,
        direction: "SELL",
        positionSide: "LONG",
        regime: "TREND",
        strategyIdentity: identity,
        learningSnapshot: {
          signalId,
          market: "CRYPTO_SPOT",
          symbol: "BTC",
          strategyHorizon: "SWING",
          direction: "SELL",
          strategyProfileVersion: "v1",
          timeframes: ["4h"],
          marketRegime: "TREND",
        },
      },
      riskEvidence: {
        status: "APPROVED",
        simulatedOnly: true,
        evaluatedAtMs: NOW - 1,
      },
      execution: {
        strategyIdentity: identity,
        costPolicy: { version: "paper-cost-policy-v1" },
        dataEvidence: {
          dataQuality: "READY",
          asOfMs: NOW - 1,
          maxAgeMs: 60_000,
        },
      },
      executionAuthority: "NONE",
      simulatedOnly: true,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
    },
  });

  assert.equal(decision.status, "PAPER_EXIT_SIGNAL");
  assert.equal(decision.candidate.executionIntent, "EXIT");
  assert.equal(decision.candidate.profitEvidence, undefined);
  return decision.candidate;
}

function runtime({ status = "PAPER_CANDIDATES_READY", candidates = [candidate()], exits = [], outcome = "TRADE_CANDIDATES" } = {}) {
  return Object.freeze({
    market: "CRYPTO_SPOT",
    status,
    search: Object.freeze({ outcome }),
    bridgeEligibleCandidates: candidates.length,
    paperBridge: Object.freeze({ candidates: Object.freeze(candidates), exitSignals: Object.freeze(exits), exits: exits.length }),
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

test("scheduled provider attaches canonical eligible Paper candidates without execution authority", async () => {
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime(),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT", cycle: { cycleId: "cycle-1" } });
  assert.equal(result.status, "READY");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].signal.signalId, "spot-btc-swing-1");
  assert.equal(result.candidates[0].paperIdentity.researchCodeSha, SHA);
  assert.equal(result.paperCandidateSource.status, "PAPER_CANDIDATES_READY");
  assert.equal(result.paperCandidateSource.eligibleCandidates, 1);
  assert.equal(result.blocker, null);
});

test("ENTRY still requires Profit-First cost evidence", async () => {
  const missingProfitEvidence = candidate({ profitEvidence: undefined });
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({ candidates: [missingProfitEvidence] }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.match(result.blocker, /PAPER_CANDIDATE_COST_POLICY_MISMATCH/);
  assert.equal(result.candidates.length, 0);
});

test("canonical EXIT keeps exact identity without requiring entry-only ProfitEvidence", async () => {
  const exit = canonicalExitCandidate();
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({ candidates: [], exits: [exit] }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "READY");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.exits.length, 1);
  assert.equal(result.exits[0].signal.signalId, "spot-btc-exit-1");
  assert.equal(result.exits[0].executionIntent, "EXIT");
  assert.equal(result.exits[0].paperIdentity.costPolicyVersion, "paper-cost-policy-v1");
  assert.equal(result.exits[0].paperIdentity.researchCodeSha, SHA);
  assert.equal(result.exits[0].profitEvidence, undefined);
  assert.equal(result.blocker, null);
});

test("EXIT still blocks cost-policy identity mismatch", async () => {
  const exit = structuredClone(canonicalExitCandidate());
  exit.paperIdentity.costPolicyVersion = "wrong-cost-policy";
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({ candidates: [], exits: [exit] }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.match(result.blocker, /PAPER_CANDIDATE_COST_POLICY_MISMATCH/);
  assert.equal(result.exits.length, 0);
});

test("VALID_NO_TRADE remains a successful zero-candidate scheduled cycle", async () => {
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({ status: "VALID_NO_TRADE", candidates: [], outcome: "VALID_NO_TRADE" }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "READY");
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.exits, []);
  assert.equal(result.paperCandidateSource.status, "VALID_NO_TRADE");
});

test("SEARCH_FAILURE fails closed before scheduled Paper mutation", async () => {
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({ status: "SEARCH_FAILURE_BLOCKED", candidates: [], outcome: "SEARCH_FAILURE" }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.blocker, "SEARCH_FAILURE");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.paperCandidateSource.searchOutcome, "SEARCH_FAILURE");
});

test("identity mismatch is blocked instead of being silently admitted", async () => {
  const bad = candidate({ paperIdentity: { ...candidate().paperIdentity, parameterHash: "wrong" } });
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({ candidates: [bad] }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.match(result.blocker, /PAPER_CANDIDATE_PARAMETER_HASH_MISMATCH/);
  assert.equal(result.candidates.length, 0);
});

test("base provider failure short-circuits scanner candidate collection", async () => {
  let calls = 0;
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: {
      collectPublicEvidence: async () => Object.freeze({
        ...baseEvidence(),
        status: "BLOCKED_DATA",
        blocker: "STALE_EVIDENCE",
      }),
    },
    paperRuntimeForMarket: async () => {
      calls += 1;
      return runtime();
    },
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.blocker, "STALE_EVIDENCE");
  assert.equal(calls, 0);
});

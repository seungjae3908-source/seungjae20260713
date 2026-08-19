import test from "node:test";
import assert from "node:assert/strict";
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
    strategyIdentity: {
      strategyId: "profit-first-swing",
      strategyVersion: "v1",
      parameterHash: "params-v1",
      researchCodeSha: SHA,
    },
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

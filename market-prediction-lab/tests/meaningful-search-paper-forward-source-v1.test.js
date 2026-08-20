import test from "node:test";
import assert from "node:assert/strict";
import { createMeaningfulSearchPaperForwardSource } from "../src/meaningful-search-paper-forward-source-v1.js";

function runtime({
  status = "PAPER_CANDIDATES_READY",
  candidates = [],
  exits = [],
  blockers = [],
  market = "CRYPTO_FUTURES",
  overrides = {},
} = {}) {
  return {
    schemaVersion: "canonical-meaningful-search-paper-runtime-v1",
    market,
    status,
    bridgeEligibleCandidates: candidates.length,
    admissionBlockers: blockers,
    simulationBlockers: [],
    paperBridge: { candidates, exitSignals: exits, results: blockers.length ? [{ blockers }] : [] },
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
    ...overrides,
  };
}
function candidate(signalId = "futures-1", market = "CRYPTO_FUTURES") {
  return { signal: { signalId, market, symbol: "BTCUSDT" } };
}

test("P0-C8 maps explicit runtime VALID_NO_TRADE to explicit source zero", async () => {
  const source = createMeaningfulSearchPaperForwardSource({
    runMarket: async () => runtime({ status: "VALID_NO_TRADE" }),
  });
  const result = await source.collect({ market: "CRYPTO_FUTURES" });
  assert.equal(result.status, "VALID_NO_TRADE");
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.exits, []);
});

test("P0-C8 forwards only actual PAPER_CANDIDATES_READY entry candidates", async () => {
  const value = candidate();
  const source = createMeaningfulSearchPaperForwardSource({ runMarket: async () => runtime({ candidates: [value] }) });
  const result = await source.collect({ market: "CRYPTO_FUTURES" });
  assert.equal(result.status, "READY");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0], value);
});

test("P0-C8 keeps SEARCH/Admission/Simulation failures blocked instead of zero", async () => {
  const source = createMeaningfulSearchPaperForwardSource({
    runMarket: async () => runtime({ status: "PAPER_CANDIDATE_CONTRACT_BLOCKED", blockers: ["RISK_EVIDENCE_NOT_APPROVED"] }),
  });
  const result = await source.collect({ market: "CRYPTO_FUTURES" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blocker, "MEANINGFUL_SEARCH_NOT_READY:RISK_EVIDENCE_NOT_APPROVED");
});

test("P0-C8 blocks PAPER_CANDIDATES_READY when no entry candidate exists", async () => {
  const source = createMeaningfulSearchPaperForwardSource({ runMarket: async () => runtime() });
  const result = await source.collect({ market: "CRYPTO_FUTURES" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blocker, "MEANINGFUL_SEARCH_READY_WITHOUT_ENTRY_CANDIDATE");
});

test("P0-C8 refuses to take ownership of settlement exit signals", async () => {
  const source = createMeaningfulSearchPaperForwardSource({
    runMarket: async () => runtime({ candidates: [candidate()], exits: [{ positionId: "existing" }] }),
  });
  const result = await source.collect({ market: "CRYPTO_FUTURES" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blocker, "MEANINGFUL_SEARCH_SETTLEMENT_EXIT_OWNED_ELSEWHERE");
  assert.deepEqual(result.exits, []);
});

test("P0-C8 blocks runtime exceptions rather than fabricating no-trade", async () => {
  const source = createMeaningfulSearchPaperForwardSource({
    runMarket: async () => { throw Object.assign(new Error("provider failed"), { code: "SCANNER_PROVIDER_FAILED" }); },
  });
  const result = await source.collect({ market: "CRYPTO_FUTURES" });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.blocker, /MEANINGFUL_SEARCH_RUNTIME_FAILED:SCANNER_PROVIDER_FAILED/);
});

test("P0-C8 enforces its exact owned market", async () => {
  let calls = 0;
  const source = createMeaningfulSearchPaperForwardSource({ runMarket: async () => { calls += 1; return runtime(); } });
  const result = await source.collect({ market: "CRYPTO_SPOT" });
  assert.equal(calls, 0);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blocker, "MEANINGFUL_SEARCH_SOURCE_MARKET_NOT_OWNED");
});

test("P0-C8 rejects non-canonical or unsafe runtime envelopes instead of translating them", async () => {
  for (const value of [
    runtime({ overrides: { schemaVersion: "not-canonical" } }),
    runtime({ market: "CRYPTO_SPOT" }),
    runtime({ overrides: { executionAuthority: "LIVE" } }),
    runtime({ overrides: { simulatedOnly: false } }),
    runtime({ overrides: { privateTradingApiAllowed: true } }),
    runtime({ overrides: { orderSubmitted: true } }),
  ]) {
    const source = createMeaningfulSearchPaperForwardSource({ runMarket: async () => value });
    const result = await source.collect({ market: "CRYPTO_FUTURES" });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.blocker, "MEANINGFUL_SEARCH_RUNTIME_CONTRACT_INVALID");
    assert.deepEqual(result.candidates, []);
  }
});

test("P0-C8 keeps malformed blocker collections fail-closed without throwing", async () => {
  const source = createMeaningfulSearchPaperForwardSource({
    runMarket: async () => runtime({
      status: "PAPER_CANDIDATE_CONTRACT_BLOCKED",
      overrides: {
        admissionBlockers: { unexpected: true },
        simulationBlockers: "unexpected",
        paperBridge: { candidates: [], exitSignals: [], results: { unexpected: true } },
      },
    }),
  });
  const result = await source.collect({ market: "CRYPTO_FUTURES" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blocker, "MEANINGFUL_SEARCH_NOT_READY:PAPER_CANDIDATE_CONTRACT_BLOCKED");
});

import test from "node:test";
import assert from "node:assert/strict";
import { wrapPaperForwardProviderWithCanonicalScannerSource } from "../src/canonical-scanner-paper-forward-provider-v1.js";

function baseEvidence(market = "CRYPTO_FUTURES") {
  return Object.freeze({
    status: "READY",
    publicOnly: true,
    market,
    provider: "bitget-public-v2",
    provenance: Object.freeze({ provider: "bitget-public-v2", market, symbol: "BTCUSDT", timeframe: "4h" }),
    dataAsOfMs: 100_000,
    observedAtMs: 100_000,
    maxAgeMs: 60_000,
    candidates: Object.freeze([]),
    exits: Object.freeze([]),
    blocker: null,
  });
}

function candidate(signalId = "scanner-futures-1", market = "CRYPTO_FUTURES") {
  return Object.freeze({
    signal: Object.freeze({ signalId, market, symbol: "BTCUSDT" }),
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
  });
}

function provider(market = "CRYPTO_FUTURES") {
  return Object.freeze({ collectPublicEvidence: async () => baseEvidence(market) });
}

test("P0-C7 preserves explicit VALID_NO_TRADE as a measured zero", async () => {
  const wrapped = wrapPaperForwardProviderWithCanonicalScannerSource({
    provider: provider(),
    source: { collect: async () => ({ status: "VALID_NO_TRADE", candidates: [], exits: [] }) },
  });
  const result = await wrapped.collectPublicEvidence({ market: "CRYPTO_FUTURES", openPositions: [] });
  assert.equal(result.status, "READY");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.canonicalScannerSource.status, "VALID_NO_TRADE");
  assert.equal(result.canonicalScannerSource.explicitZero, true);
});

test("P0-C7 never converts a source failure into a zero-candidate READY lane", async () => {
  const wrapped = wrapPaperForwardProviderWithCanonicalScannerSource({
    provider: provider(),
    source: { collect: async () => { throw Object.assign(new Error("scanner down"), { code: "SCANNER_UNAVAILABLE" }); } },
  });
  const result = await wrapped.collectPublicEvidence({ market: "CRYPTO_FUTURES", openPositions: [] });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.deepEqual(result.candidates, []);
  assert.match(result.blocker, /CANONICAL_SCANNER_SOURCE_FAILED:SCANNER_UNAVAILABLE/);
  assert.equal(result.canonicalScannerSource.explicitZero, false);
});

test("P0-C7 injects only safety-closed same-market canonical candidates", async () => {
  const value = candidate();
  const wrapped = wrapPaperForwardProviderWithCanonicalScannerSource({
    provider: provider(),
    source: { collect: async () => ({ status: "READY", candidates: [value], exits: [] }) },
  });
  const result = await wrapped.collectPublicEvidence({ market: "CRYPTO_FUTURES", openPositions: [] });
  assert.equal(result.status, "READY");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0], value);
  assert.equal(result.canonicalScannerSource.candidateCount, 1);
  assert.equal(result.canonicalScannerSource.explicitZero, false);
});

test("P0-C7 blocks a market mismatch instead of forwarding the candidate", async () => {
  const wrapped = wrapPaperForwardProviderWithCanonicalScannerSource({
    provider: provider(),
    source: { collect: async () => ({ status: "READY", candidates: [candidate("bad", "CRYPTO_SPOT")], exits: [] }) },
  });
  const result = await wrapped.collectPublicEvidence({ market: "CRYPTO_FUTURES", openPositions: [] });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.blocker, "CANONICAL_SCANNER_MARKET_MISMATCH");
  assert.deepEqual(result.candidates, []);
});

test("P0-C7 blocks READY-with-zero because UNKNOWN is not ZERO", async () => {
  const wrapped = wrapPaperForwardProviderWithCanonicalScannerSource({
    provider: provider(),
    source: { collect: async () => ({ status: "READY", candidates: [], exits: [] }) },
  });
  const result = await wrapped.collectPublicEvidence({ market: "CRYPTO_FUTURES", openPositions: [] });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.blocker, "CANONICAL_SCANNER_READY_WITHOUT_EVIDENCE");
});

test("P0-C7 rejects candidate duplicates rather than double-crediting evidence", async () => {
  const duplicate = candidate("same");
  const base = Object.freeze({ ...baseEvidence(), candidates: Object.freeze([duplicate]) });
  const wrapped = wrapPaperForwardProviderWithCanonicalScannerSource({
    provider: { collectPublicEvidence: async () => base },
    source: { collect: async () => ({ status: "READY", candidates: [candidate("same")], exits: [] }) },
  });
  const result = await wrapped.collectPublicEvidence({ market: "CRYPTO_FUTURES", openPositions: [] });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.blocker, "CANONICAL_SCANNER_DUPLICATE_SIGNAL_ID");
});

test("P0-C7 does not invoke the canonical Scanner source for unowned markets", async () => {
  let calls = 0;
  const base = baseEvidence("KR_STOCK");
  const wrapped = wrapPaperForwardProviderWithCanonicalScannerSource({
    provider: { collectPublicEvidence: async () => base },
    source: { collect: async () => { calls += 1; return { status: "VALID_NO_TRADE", candidates: [], exits: [] }; } },
  });
  const result = await wrapped.collectPublicEvidence({ market: "KR_STOCK", openPositions: [] });
  assert.equal(calls, 0);
  assert.equal(result, base);
});

test("P0-C7 keeps settlement exits under the existing settlement owner", async () => {
  const wrapped = wrapPaperForwardProviderWithCanonicalScannerSource({
    provider: provider(),
    source: { collect: async () => ({ status: "READY", candidates: [candidate()], exits: [{ positionId: "x" }] }) },
  });
  const result = await wrapped.collectPublicEvidence({ market: "CRYPTO_FUTURES", openPositions: [] });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.blocker, "CANONICAL_SCANNER_EXIT_SOURCE_NOT_AUTHORIZED");
  assert.deepEqual(result.exits, []);
});

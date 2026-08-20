import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalPaperForwardEvidenceProvider } from "../src/paper-forward-evidence-runtime-v1.js";

const NOW = Date.UTC(2026, 7, 21, 0, 0, 0);
const SHA = "a".repeat(40);

function candles(intervalMs, count = 120) {
  const lastOpen = Math.floor(NOW / intervalMs) * intervalMs - intervalMs;
  return Array.from({ length: count }, (_, index) => ({
    timestamp: lastOpen - (count - 1 - index) * intervalMs,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  }));
}

function legacySourceFactory() {
  return {
    async collect() {
      return Object.freeze({
        status: "READY",
        candidates: Object.freeze([{ legacyDirectEntry: true, signal: { signalId: "legacy-entry" } }]),
        exits: Object.freeze([{
          positionId: "legacy-open-position",
          settlementInput: Object.freeze({ signalId: "legacy-entry", exitPrice: 101 }),
          naturalSettlementEvidence: Object.freeze({ source: "public-closed-exit-bar" }),
        }]),
        blocker: null,
      });
    },
  };
}

function canonicalCandidate() {
  const strategyIdentity = {
    strategyId: "canonical-futures-swing",
    strategyVersion: "v1",
    parameterHash: "params-v1",
    researchCodeSha: SHA,
  };
  const signal = {
    signalId: "canonical-futures-entry",
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timestampMs: NOW - 1_000,
    timeframe: "4h",
    horizon: 6,
    direction: "LONG",
    signalDirection: "LONG",
    regime: "TREND",
    strategyIdentity,
  };
  return Object.freeze({
    signal,
    paperIdentity: Object.freeze({
      signalId: signal.signalId,
      strategyId: strategyIdentity.strategyId,
      strategyVersion: strategyIdentity.strategyVersion,
      parameterHash: strategyIdentity.parameterHash,
      market: signal.market,
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      horizon: signal.horizon,
      direction: signal.signalDirection,
      regime: signal.regime,
      costPolicyVersion: "cost-v1",
      researchCodeSha: SHA,
      executionAuthority: "NONE",
    }),
    profitEvidence: Object.freeze({ status: "READY", costPolicyId: "cost-v1", executionAuthority: "NONE" }),
    execution: Object.freeze({ costPolicy: Object.freeze({ version: "cost-v1" }) }),
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

function runtime(candidates = [canonicalCandidate()]) {
  return Object.freeze({
    market: "CRYPTO_FUTURES",
    status: candidates.length ? "PAPER_CANDIDATES_READY" : "VALID_NO_TRADE",
    search: Object.freeze({ outcome: candidates.length ? "TRADE_CANDIDATES" : "VALID_NO_TRADE" }),
    bridgeEligibleCandidates: candidates.length,
    paperBridge: Object.freeze({
      candidates: Object.freeze(candidates),
      exitSignals: Object.freeze([]),
      exits: 0,
    }),
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

function provider(overrides = {}) {
  return createCanonicalPaperForwardEvidenceProvider({
    clock: () => NOW,
    bitgetClient: {},
    env: {
      RESEARCH_PRODUCTION: "true",
      PAPER_FORWARD_RESEARCH_SHA: SHA,
      PAPER_FORWARD_ROOT: "/tmp/p0-c5-paper-forward",
    },
    naturalSourceFactory: legacySourceFactory,
    collectYahoo: async ({ market, symbol }) => ({ market, symbol, source: "yahoo-public-chart", timeframe: "1d", candles: candles(86_400_000) }),
    collectUpbit: async () => ({ market: "CRYPTO_SPOT", source: "upbit-public-candles", timeframe: "4h", candles: candles(14_400_000) }),
    collectBitget: async () => ({ market: "CRYPTO_FUTURES", provider: "bitget-public-v2", timeframe: "4h", candles: candles(14_400_000) }),
    ...overrides,
  });
}

test("Research Production blocks the lane when canonical admission runtime is unavailable", async () => {
  const evidence = await provider().collectPublicEvidence({
    market: "CRYPTO_FUTURES",
    cycle: { cycleId: "natural-cutover:1" },
  });

  assert.equal(evidence.status, "BLOCKED_DATA");
  assert.deepEqual(evidence.candidates, []);
  assert.deepEqual(evidence.exits, []);
  assert.equal(evidence.blocker, "AUTHORITATIVE_ADMISSION_RUNTIME_UNAVAILABLE");
  assert.equal(evidence.canonicalAdmissionCutover.status, "LEGACY_ENTRY_BLOCKED");
  assert.equal(evidence.canonicalAdmissionCutover.blockedLegacyEntryCount, 1);
  assert.equal(evidence.canonicalAdmissionCutover.preservedExitCount, 1);
  assert.equal(evidence.canonicalAdmissionCutover.blocker, "AUTHORITATIVE_ADMISSION_BUNDLE_REQUIRED");
  assert.equal(evidence.legacyNaturalSettlementExits.length, 1);
  assert.equal(evidence.legacyNaturalSettlementExits[0].positionId, "legacy-open-position");
  assert.equal(evidence.paperCandidateSource.status, "AUTHORITATIVE_ADMISSION_RUNTIME_UNAVAILABLE");
  assert.equal(evidence.paperCandidateSource.blocker, "AUTHORITATIVE_ADMISSION_RUNTIME_UNAVAILABLE");
  assert.equal(evidence.paperCandidateSource.eligibleCandidates, 0);
});

test("injected canonical runtime becomes the only recurring ENTRY source while legacy settlement EXIT remains", async () => {
  const evidence = await provider({ paperRuntimeForMarket: async () => runtime() }).collectPublicEvidence({
    market: "CRYPTO_FUTURES",
    cycle: { cycleId: "natural-cutover:2" },
  });

  assert.equal(evidence.status, "READY");
  assert.equal(evidence.candidates.length, 1);
  assert.equal(evidence.candidates[0].signal.signalId, "canonical-futures-entry");
  assert.equal(evidence.exits.length, 1);
  assert.equal(evidence.exits[0].positionId, "legacy-open-position");
  assert.equal(evidence.paperCandidateSource.status, "PAPER_CANDIDATES_READY");
  assert.equal(evidence.paperCandidateSource.eligibleCandidates, 1);
  assert.equal(evidence.canonicalAdmissionCutover.blockedLegacyEntryCount, 1);
  assert.equal(evidence.candidates[0].executionAuthority, "NONE");
  assert.equal(evidence.candidates[0].liveOrderAllowed, false);
  assert.equal(evidence.candidates[0].privateTradingApiAllowed, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createCanonicalPaperForwardEvidenceProvider } from "../src/paper-forward-evidence-runtime-v1.js";

const NOW = Date.UTC(2026, 7, 19, 8, 0, 0);
const SHA = "a".repeat(40);

function candles(intervalMs, count = 4) {
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

function collectors() {
  return {
    collectYahoo: async ({ market, symbol }) => ({ market, symbol, source: "yahoo-public-chart", timeframe: "1d", candles: candles(86_400_000) }),
    collectUpbit: async () => ({ market: "CRYPTO_SPOT", source: "upbit-public-candles", timeframe: "4h", candles: candles(14_400_000) }),
    collectBitget: async () => ({ market: "CRYPTO_FUTURES", provider: "bitget-public-v2", timeframe: "4h", candles: candles(14_400_000) }),
  };
}

test("Research Production observes the sibling Shadow source but routes ENTRY only through canonical admission", async () => {
  let factoryArgs = null;
  let sourceCalls = 0;
  let sourceInput = null;
  const provider = createCanonicalPaperForwardEvidenceProvider({
    ...collectors(),
    bitgetClient: {},
    clock: () => NOW,
    env: {
      RESEARCH_PRODUCTION: "true",
      PAPER_FORWARD_ROOT: "/var/lib/investment-research-production/forward/paper",
      PAPER_FORWARD_RESEARCH_SHA: SHA,
    },
    naturalSourceFactory: (args) => {
      factoryArgs = args;
      return {
        async collect(input) {
          sourceCalls += 1;
          sourceInput = input;
          return {
            status: "READY",
            candidates: [{ signal: { signalId: "ETH-V6-natural" } }],
            exits: [],
            blocker: null,
          };
        },
      };
    },
  });

  const spot = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  const futuresPosition = { positionId: "paper-open-1" };
  const futures = await provider.collectPublicEvidence({ market: "CRYPTO_FUTURES", openPositions: [futuresPosition] });
  assert.equal(factoryArgs.shadowStatePath, "/var/lib/investment-research-production/forward/shadow-state.json");
  assert.equal(factoryArgs.researchCodeSha, SHA);
  assert.equal(factoryArgs.client != null, true);
  assert.equal(factoryArgs.clock(), NOW);
  assert.equal(spot.candidates.length, 0);
  assert.equal(futures.candidates.length, 0);
  assert.deepEqual(sourceInput.openPositions, [futuresPosition]);
  assert.equal(futures.naturalCandidateSource.candidateCount, 1);
  assert.equal(futures.naturalCandidateSource.settlementBridgeReady, true);
  assert.equal(futures.canonicalAdmissionCutover.status, "LEGACY_ENTRY_BLOCKED");
  assert.equal(futures.canonicalAdmissionCutover.blockedLegacyEntryCount, 1);
  assert.equal(futures.canonicalAdmissionCutover.blocker, "AUTHORITATIVE_ADMISSION_BUNDLE_REQUIRED");
  assert.equal(futures.paperCandidateSource.status, "VALID_NO_TRADE");
  assert.equal(futures.paperCandidateSource.eligibleCandidates, 0);
  assert.equal(sourceCalls, 1);
});

test("non-Research canonical provider never instantiates or injects the natural Shadow source", async () => {
  let factoryCalls = 0;
  const provider = createCanonicalPaperForwardEvidenceProvider({
    ...collectors(),
    bitgetClient: {},
    clock: () => NOW,
    env: {},
    naturalSourceFactory: () => {
      factoryCalls += 1;
      throw new Error("must not be instantiated outside Research Production");
    },
  });
  const futures = await provider.collectPublicEvidence({ market: "CRYPTO_FUTURES" });
  assert.equal(factoryCalls, 0);
  assert.equal(futures.status, "READY");
  assert.equal(futures.candidates.length, 0);
  assert.equal(futures.exits.length, 0);
  assert.equal(futures.naturalCandidateSource, undefined);
});
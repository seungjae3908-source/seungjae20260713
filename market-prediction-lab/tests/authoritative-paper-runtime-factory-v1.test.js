import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORITATIVE_PAPER_RUNTIME_FACTORY_CONTRACT,
  createAuthoritativePaperForwardDependencies,
  createAuthoritativePaperForwardEvidenceProvider,
  createAuthoritativePaperRuntimeForMarket,
} from "../src/authoritative-paper-runtime-factory-v1.js";

function safety() {
  return {
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
  };
}

const BUNDLE = Object.freeze({
  schemaVersion: "scanner-paper-admission-evidence-bundle-v1",
  evidenceDigest: "a".repeat(64),
  ...safety(),
});

function producerReady(bundle = BUNDLE) {
  return Object.freeze({
    status: "READY",
    bundle,
    blockers: Object.freeze([]),
    ...safety(),
  });
}

function producerBlocked(blockers) {
  return Object.freeze({
    status: "BLOCKED",
    bundle: null,
    blockers: Object.freeze(blockers),
    ...safety(),
  });
}

function runtime(status, {
  candidates = [],
  exits = [],
  market = "CRYPTO_FUTURES",
  searchOutcome = status === "VALID_NO_TRADE" ? "VALID_NO_TRADE" : "TRADE_CANDIDATES",
} = {}) {
  return Object.freeze({
    schemaVersion: "canonical-meaningful-search-paper-runtime-v1",
    market,
    status,
    search: Object.freeze({ outcome: searchOutcome }),
    paperBridge: Object.freeze({
      candidates: Object.freeze(candidates),
      exitSignals: Object.freeze(exits),
      blocked: 0,
      noTrade: status === "VALID_NO_TRADE" ? 1 : 0,
      eligible: candidates.length,
      exits: exits.length,
    }),
    ...safety(),
    profitabilityClaimAllowed: false,
  });
}

test("P0-C9 injects only the authoritative READY canonical bundle into the existing P0-C6 runtime", async () => {
  const scanBatch = async () => Object.freeze({ cards: Object.freeze([]) });
  const calls = [];
  const paperRuntimeForMarket = createAuthoritativePaperRuntimeForMarket({
    scanBatchForMarket: async ({ market }) => {
      assert.equal(market, "CRYPTO_FUTURES");
      return scanBatch;
    },
    paperAdmissionEvidenceForCard: async (context) => {
      calls.push(context);
      return producerReady();
    },
    runRuntimeWithAdmissionBundles: async ({ market, scanBatch: injectedScanBatch, paperAdmissionBundleForCard }) => {
      assert.equal(market, "CRYPTO_FUTURES");
      assert.equal(injectedScanBatch, scanBatch);
      const bundle = await paperAdmissionBundleForCard(Object.freeze({ id: "card-1" }), market);
      assert.equal(bundle, BUNDLE);
      return runtime("PAPER_CANDIDATES_READY", { candidates: [Object.freeze({ id: "paper-1" })] });
    },
  });

  const cycle = Object.freeze({ cycleId: "cycle-1" });
  const result = await paperRuntimeForMarket({ market: "CRYPTO_FUTURES", cycle });
  assert.equal(result.status, "PAPER_CANDIDATES_READY");
  assert.equal(result.paperBridge.candidates.length, 1);
  assert.equal(result.authoritativePaperRuntimeFactory, AUTHORITATIVE_PAPER_RUNTIME_FACTORY_CONTRACT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].market, "CRYPTO_FUTURES");
  assert.equal(calls[0].cycle, cycle);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveOrderAllowed, false);
  assert.equal(result.privateTradingApiAllowed, false);
});

test("P0-C9 turns producer BLOCKED into BLOCKED_DATA semantics, never VALID_NO_TRADE or a measured zero", async () => {
  const paperRuntimeForMarket = createAuthoritativePaperRuntimeForMarket({
    scanBatchForMarket: async () => async () => Object.freeze({ cards: Object.freeze([]) }),
    paperAdmissionEvidenceForCard: async () => producerBlocked([
      "P0_C5_BITGET_PUBLIC_EVIDENCE_REQUIRED",
      "P0_C5_SLIPPAGE_EVIDENCE_INVALID",
    ]),
    runRuntimeWithAdmissionBundles: async ({ paperAdmissionBundleForCard, market }) => {
      await paperAdmissionBundleForCard(Object.freeze({ id: "blocked" }), market);
      throw new Error("unreachable");
    },
  });

  const result = await paperRuntimeForMarket({ market: "CRYPTO_FUTURES" });
  assert.equal(result.status, "AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED");
  assert.equal(result.search.outcome, "SEARCH_FAILURE");
  assert.equal(result.search.validNoTrade, false);
  assert.equal(result.paperBridge.noTrade, 0);
  assert.equal(result.paperBridge.eligible, 0);
  assert.deepEqual(result.admissionBlockers, [
    "P0_C5_BITGET_PUBLIC_EVIDENCE_REQUIRED",
    "P0_C5_SLIPPAGE_EVIDENCE_INVALID",
  ]);
});

test("P0-C9 preserves a genuine canonical VALID_NO_TRADE result from the actual search/profit runtime", async () => {
  let producerCalls = 0;
  const paperRuntimeForMarket = createAuthoritativePaperRuntimeForMarket({
    scanBatchForMarket: async () => async () => Object.freeze({ cards: Object.freeze([]) }),
    paperAdmissionEvidenceForCard: async () => {
      producerCalls += 1;
      return producerReady();
    },
    runRuntimeWithAdmissionBundles: async () => runtime("VALID_NO_TRADE", {
      candidates: [],
      exits: [],
      searchOutcome: "VALID_NO_TRADE",
    }),
  });

  const result = await paperRuntimeForMarket({ market: "CRYPTO_FUTURES" });
  assert.equal(result.status, "VALID_NO_TRADE");
  assert.equal(result.search.outcome, "VALID_NO_TRADE");
  assert.equal(result.paperBridge.candidates.length, 0);
  assert.equal(producerCalls, 0);
});

test("P0-C9 owns CRYPTO_FUTURES only and fails closed before Scanner or evidence access for another market", async () => {
  let scannerCalls = 0;
  let producerCalls = 0;
  const paperRuntimeForMarket = createAuthoritativePaperRuntimeForMarket({
    scanBatchForMarket: async () => {
      scannerCalls += 1;
      return async () => Object.freeze({ cards: Object.freeze([]) });
    },
    paperAdmissionEvidenceForCard: async () => {
      producerCalls += 1;
      return producerReady();
    },
  });

  const result = await paperRuntimeForMarket({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "AUTHORITATIVE_ADMISSION_MARKET_NOT_OWNED");
  assert.equal(result.search.validNoTrade, false);
  assert.equal(scannerCalls, 0);
  assert.equal(producerCalls, 0);
});

test("P0-C9 rejects producer exceptions and invalid runtime safety instead of fabricating Paper admission", async () => {
  const producerFailure = createAuthoritativePaperRuntimeForMarket({
    scanBatchForMarket: async () => async () => Object.freeze({ cards: Object.freeze([]) }),
    paperAdmissionEvidenceForCard: async () => {
      throw new Error("evidence unavailable");
    },
    runRuntimeWithAdmissionBundles: async ({ paperAdmissionBundleForCard, market }) => {
      await paperAdmissionBundleForCard({}, market);
      throw new Error("unreachable");
    },
  });
  const blocked = await producerFailure({ market: "CRYPTO_FUTURES" });
  assert.equal(blocked.status, "AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED");
  assert.deepEqual(blocked.admissionBlockers, ["P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED"]);

  const unsafeRuntime = createAuthoritativePaperRuntimeForMarket({
    scanBatchForMarket: async () => async () => Object.freeze({ cards: Object.freeze([]) }),
    paperAdmissionEvidenceForCard: async () => producerReady(),
    runRuntimeWithAdmissionBundles: async () => Object.freeze({
      ...runtime("PAPER_CANDIDATES_READY"),
      liveOrderAllowed: true,
    }),
  });
  const invalid = await unsafeRuntime({ market: "CRYPTO_FUTURES" });
  assert.equal(invalid.status, "AUTHORITATIVE_PAPER_RUNTIME_CONTRACT_INVALID");
  assert.equal(invalid.liveOrderAllowed, false);
});

test("P0-C9 provider factory requires Research Production and forwards the exact runtime into the existing canonical provider seam", () => {
  const paperRuntimeForMarket = async () => runtime("VALID_NO_TRADE");
  let captured = null;
  const provider = Object.freeze({ collectPublicEvidence: async () => Object.freeze({ status: "READY" }) });
  const result = createAuthoritativePaperForwardEvidenceProvider({
    paperRuntimeForMarket,
    env: Object.freeze({ RESEARCH_PRODUCTION: "true" }),
    clock: () => 123,
    providerFactory: (options) => {
      captured = options;
      return provider;
    },
  });
  assert.equal(result, provider);
  assert.equal(captured.paperRuntimeForMarket, paperRuntimeForMarket);
  assert.equal(captured.env.RESEARCH_PRODUCTION, "true");
  assert.equal(captured.clock(), 123);

  assert.throws(() => createAuthoritativePaperForwardEvidenceProvider({
    paperRuntimeForMarket,
    env: Object.freeze({ RESEARCH_PRODUCTION: "false" }),
    providerFactory: () => provider,
  }), /AUTHORITATIVE_PAPER_RUNTIME_RESEARCH_PRODUCTION_REQUIRED/u);
});

test("P0-C9 dependency composer returns the exact runtime/provider pair for the existing Scheduled Paper injection seam without activating a schedule", () => {
  const paperRuntimeForMarket = async () => runtime("VALID_NO_TRADE");
  const publicEvidenceProvider = Object.freeze({ collectPublicEvidence: async () => ({ status: "READY" }) });
  let runtimeOptionsSeen = null;
  let providerOptionsSeen = null;
  const dependencies = createAuthoritativePaperForwardDependencies({
    runtimeOptions: Object.freeze({ marker: "runtime-options" }),
    providerOptions: Object.freeze({ marker: "provider-options" }),
    runtimeFactory: (options) => {
      runtimeOptionsSeen = options;
      return paperRuntimeForMarket;
    },
    evidenceProviderFactory: (options) => {
      providerOptionsSeen = options;
      return publicEvidenceProvider;
    },
  });

  assert.deepEqual(runtimeOptionsSeen, { marker: "runtime-options" });
  assert.equal(providerOptionsSeen.marker, "provider-options");
  assert.equal(providerOptionsSeen.paperRuntimeForMarket, paperRuntimeForMarket);
  assert.equal(dependencies.paperRuntimeForMarket, paperRuntimeForMarket);
  assert.equal(dependencies.publicEvidenceProvider, publicEvidenceProvider);
  assert.equal(dependencies.contract.scheduleActivationAuthority, false);
});

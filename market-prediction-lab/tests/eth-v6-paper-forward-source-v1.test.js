import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  ETH_V6_PAPER_FORWARD_SOURCE_CONTRACT,
  createEthV6PaperForwardSource,
  loadBitgetEthV6PaperContext,
  wrapPaperForwardProviderWithEthV6Source,
} from "../src/eth-v6-paper-forward-source-v1.js";
import { FROZEN_CANDIDATE_MANIFEST_SHA256 } from "../src/final-holdout-evaluator.js";

const SHA = "a".repeat(40);
const ENTRY = Date.UTC(2026, 7, 19, 0, 0, 0);
const NOW = ENTRY + 5 * 60 * 60 * 1000;
const SHADOW_OBSERVED_AT = NOW - 10 * 60 * 1000;

function trackingRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "shadow-record-1",
    status: "tracking",
    signalId: "ETH-V6-1787097600000",
    strategy: "v6_independent_breakout_retest",
    asset: "ETHUSDT",
    market: "CRYPTO_FUTURES",
    timeframe: "1d",
    timestamp: ENTRY - 24 * 60 * 60 * 1000,
    dataTimestamp: ENTRY - 24 * 60 * 60 * 1000,
    entryPlan: {
      action: "LONG",
      entryTime: ENTRY,
      entryPrice: 4000,
      quantity: 1.2345,
      leverage: 1,
      source: "bitget-public-forward-paper",
    },
    stop: 3900,
    targets: [4200],
    feesSlippageModel: {},
    subsequentMarketResult: null,
    orderSubmitted: false,
    privateAccountRequested: false,
    ...overrides,
  };
}

function shadowRoot(record = trackingRecord(), overrides = {}) {
  return {
    schemaVersion: 3,
    forwardStrategies: {
      "eth-futures-long-v6": {
        schemaVersion: 1,
        candidateId: "eth-futures-long-v6",
        candidateManifestSha256: FROZEN_CANDIDATE_MANIFEST_SHA256,
        startedAt: ENTRY - 24 * 60 * 60 * 1000,
        updatedAt: SHADOW_OBSERVED_AT,
        ledger: { version: 1, records: [record] },
        safeguards: {
          frozenCandidateOnly: true,
          parametersRetunedAfterHoldout: false,
          forwardSignalsOnly: true,
          publicMarketDataOnly: true,
          orderSubmitted: false,
          liveOrderAllowed: false,
        },
        ...overrides,
      },
    },
  };
}

function readyContext() {
  return {
    quantity: 1.23,
    dataEvidence: {
      provider: "bitget",
      publicOnly: true,
      dataQuality: "READY",
      provenance: "bitget-public-v2:test",
      asOfMs: NOW - 1000,
      maxAgeMs: 300000,
      contractStatus: "TRADABLE",
      tickSize: 0.01,
      minQty: 0.01,
      qtyStep: 0.01,
      markPrice: 4001,
      indexPrice: 4000,
      fundingRate: 0.0001,
      openInterest: 1000,
      leverage: 1,
      maxLeverage: 125,
      marginMode: "ISOLATED",
      liquidationDistancePct: 99,
      barProxyRealtimeAllowed: true,
    },
  };
}

async function withShadowFile(value, run) {
  const dir = await mkdtemp(join(tmpdir(), "eth-v6-paper-source-"));
  const path = join(dir, "shadow-state.json");
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("fresh natural frozen ETH V6 tracking signal becomes one low-sample Paper candidate without promotion claims", async () => {
  await withShadowFile(shadowRoot(), async (shadowStatePath) => {
    const source = createEthV6PaperForwardSource({
      shadowStatePath,
      researchCodeSha: SHA,
      clock: () => NOW,
      loadContext: async () => readyContext(),
    });
    const result = await source.collect();
    assert.equal(result.status, "READY");
    assert.equal(result.candidates.length, 1);
    assert.equal(result.exits.length, 0);
    const candidate = result.candidates[0];
    assert.equal(candidate.signal.signalId, "ETH-V6-1787097600000");
    assert.equal(candidate.signal.strategyIdentity.researchCodeSha, SHA);
    assert.equal(candidate.profitGate.decision, "ELIGIBLE");
    assert.equal(candidate.profitEvidence.sampleSize, 3);
    assert.equal(candidate.profitEvidence.sampleClass, "low");
    assert.equal(candidate.profitEvidence.promotionEvidence, false);
    assert.equal(candidate.profitEvidence.profitabilityClaimAllowed, false);
    assert.ok(candidate.profitEvidence.expectedNetEdge > 0);
    assert.ok(candidate.profitEvidence.expectedNetReturn > 0);
    assert.equal(candidate.order.quantity, 1.23);
    assert.equal(candidate.order.direction, "LONG");
    assert.equal(candidate.execution.executionPolicy.fillModel, "BAR_PROXY");
    assert.equal(candidate.bar.nextOpen, 4000);
    assert.equal(candidate.retainedForwardEvidence.observedAtMs, SHADOW_OBSERVED_AT);
    assert.equal(candidate.retainedForwardEvidence.orderSubmitted, false);
    assert.equal(candidate.retainedForwardEvidence.privateAccountRequested, false);
    assert.equal(result.safety.maximumEntryLagMs, 6 * 60 * 60 * 1000);
    assert.equal(result.safety.maximumSourceAgeMs, 45 * 60 * 1000);
    assert.equal(result.safety.settlementBridgeReady, false);
    assert.equal(result.safety.liveTrading, false);
  });
});

test("Shadow evidence not consumed promptly is never backfilled into Paper", async () => {
  await withShadowFile(shadowRoot(), async (shadowStatePath) => {
    const lateNow = SHADOW_OBSERVED_AT + ETH_V6_PAPER_FORWARD_SOURCE_CONTRACT.maximumSourceAgeMs + 1;
    const source = createEthV6PaperForwardSource({
      shadowStatePath,
      researchCodeSha: SHA,
      clock: () => lateNow,
      loadContext: async () => { throw new Error("context must not be loaded for stale source"); },
    });
    const result = await source.collect();
    assert.equal(result.status, "NO_FRESH_TRACKING_SIGNAL");
    assert.equal(result.candidates.length, 0);
  });
});

test("Shadow record that violated the original six-hour natural entry window fails closed", async () => {
  const tooLateObservation = ENTRY + ETH_V6_PAPER_FORWARD_SOURCE_CONTRACT.maximumEntryLagMs + 1;
  await withShadowFile(shadowRoot(trackingRecord(), { updatedAt: tooLateObservation }), async (shadowStatePath) => {
    const source = createEthV6PaperForwardSource({
      shadowStatePath,
      researchCodeSha: SHA,
      clock: () => tooLateObservation,
      loadContext: async () => readyContext(),
    });
    await assert.rejects(source.collect(), /ORIGINAL_ENTRY_LAG_EXCEEDED/);
  });
});

test("settled shadow records are not retrospectively opened as Paper positions", async () => {
  await withShadowFile(shadowRoot(trackingRecord({ status: "settled" })), async (shadowStatePath) => {
    const source = createEthV6PaperForwardSource({
      shadowStatePath,
      researchCodeSha: SHA,
      clock: () => NOW,
      loadContext: async () => { throw new Error("context must not be loaded for settled record"); },
    });
    const result = await source.collect();
    assert.equal(result.status, "NO_FRESH_TRACKING_SIGNAL");
    assert.equal(result.candidates.length, 0);
  });
});

test("frozen candidate manifest mismatch fails closed", async () => {
  await withShadowFile(shadowRoot(trackingRecord(), { candidateManifestSha256: "b".repeat(64) }), async (shadowStatePath) => {
    const source = createEthV6PaperForwardSource({
      shadowStatePath,
      researchCodeSha: SHA,
      clock: () => NOW,
      loadContext: async () => readyContext(),
    });
    await assert.rejects(source.collect(), /FROZEN_IDENTITY_MISMATCH/);
  });
});

test("Bitget public contract metadata normalizes executable quantity and supplies futures risk evidence", async () => {
  const calls = [];
  const fakeClient = {
    async get(path) {
      calls.push(path);
      if (path.endsWith("/contracts")) return { data: [{
        symbol: "ETHUSDT", symbolStatus: "normal", minTradeNum: "0.01", sizeMultiplier: "0.01",
        pricePlace: "2", priceEndStep: "1", minTradeUSDT: "5", maxMarketOrderQty: "10",
        maxLever: "125", takerFeeRate: "0.0006",
      }] };
      if (path.endsWith("/query-position-lever")) return { data: [{ startUnit: "0", endUnit: "1000000", leverage: "125", keepMarginRate: "0.004" }] };
      if (path.endsWith("/open-interest")) return { data: { openInterestList: [{ size: "1234.5" }], ts: String(NOW - 1000) } };
      if (path.endsWith("/current-fund-rate")) return { data: [{ fundingRate: "0.0001" }] };
      if (path.endsWith("/symbol-price")) return { data: [{ ts: String(NOW - 1000), markPrice: "4001", indexPrice: "4000", price: "4000.5" }] };
      throw new Error(`unexpected path ${path}`);
    },
  };
  const context = await loadBitgetEthV6PaperContext({
    client: fakeClient,
    record: trackingRecord(),
    nowMs: NOW,
    sourceObservedAtMs: SHADOW_OBSERVED_AT,
  });
  assert.equal(context.quantity, 1.23);
  assert.equal(context.dataEvidence.tickSize, 0.01);
  assert.equal(context.dataEvidence.qtyStep, 0.01);
  assert.equal(context.dataEvidence.minQty, 0.01);
  assert.equal(context.dataEvidence.contractStatus, "TRADABLE");
  assert.equal(context.dataEvidence.maxLeverage, 125);
  assert.equal(context.dataEvidence.marginMode, "ISOLATED");
  assert.ok(context.dataEvidence.liquidationDistancePct > 99);
  assert.equal(context.dataEvidence.provider, "bitget");
  assert.equal(context.dataEvidence.retainedForwardObservedAtMs, SHADOW_OBSERVED_AT);
  assert.equal(new Set(calls).size, 5);
});

test("provider wrapper injects the natural candidate only into a READY futures lane and never changes order authority", async () => {
  const baseProvider = {
    async collectPublicEvidence({ market }) {
      return {
        status: "READY",
        publicOnly: true,
        market,
        provider: "fixture-public",
        observedAtMs: NOW - 1000,
        dataAsOfMs: NOW - 1000,
        maxAgeMs: 60000,
        candidates: [],
        exits: [],
      };
    },
  };
  const source = { async collect() { return { status: "READY", candidates: [{ signal: { signalId: "eth-v6" } }], exits: [], blocker: null }; } };
  const wrapped = wrapPaperForwardProviderWithEthV6Source({ provider: baseProvider, source });
  const spot = await wrapped.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  const futures = await wrapped.collectPublicEvidence({ market: "CRYPTO_FUTURES" });
  assert.equal(spot.candidates.length, 0);
  assert.equal(futures.candidates.length, 1);
  assert.equal(futures.naturalCandidateSource.candidateCount, 1);
  assert.equal(futures.naturalCandidateSource.settlementBridgeReady, false);
});

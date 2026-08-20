import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createAuthoritativeNaturalPaperAdmissionProducer,
  createCanonicalNaturalPaperRuntimeForMarket,
  createFailClosedCanonicalPaperRuntimeForMarket,
} from "../src/authoritative-natural-paper-admission-producer-v1.js";

const NOW = 1_800_000_000_000;
const SHA = "b".repeat(40);
const COST_POLICY = "cost-v1";

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function withDigest(payload) {
  return Object.freeze({
    ...payload,
    evidenceDigest: createHash("sha256").update(stableSerialize(payload)).digest("hex"),
  });
}

function component(valuePercent, source, quality = "OBSERVED") {
  return Object.freeze({ valuePercent, quality, source, observedAtMs: NOW - 1_000 });
}

function bundle() {
  const signal = Object.freeze({
    signalId: "CRYPTO_SPOT-natural-001",
    market: "CRYPTO_SPOT",
    symbol: "KRW-BTC",
    timestampMs: NOW - 2_000,
    ttlMs: 62_000,
    expiresAtMs: NOW + 60_000,
    style: "SWING",
    timeframe: "1h",
    horizon: 12,
    direction: "BUY",
    signalDirection: "BUY",
    strategyIdentity: Object.freeze({
      strategyId: "canonical-natural-paper-test",
      strategyVersion: "v1",
      parameterHash: "params-v1",
      researchCodeSha: SHA,
      costPolicyVersion: COST_POLICY,
    }),
  });
  const components = Object.freeze({
    commission: component(0.05, "upbit:commission"),
    tax: component(0, "spot:tax-na", "NOT_APPLICABLE"),
    spread: component(0.04, "upbit:top-of-book"),
    slippage: component(0.05, "paper:slippage", "ESTIMATED"),
    funding: component(0, "spot:funding-na", "NOT_APPLICABLE"),
    latency: component(0.01, "runtime:latency", "ESTIMATED"),
    liquidityImpact: component(0.02, "runtime:liquidity", "ESTIMATED"),
    partialFillImpact: component(0.01, "runtime:partial-fill", "ESTIMATED"),
  });
  return withDigest({
    schemaVersion: "scanner-paper-admission-evidence-bundle-v1",
    paperCandidate: Object.freeze({
      signal,
      executionAuthority: "NONE",
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
    }),
    learningSnapshot: Object.freeze({
      immutable: true,
      executionAuthority: "NONE",
      signalId: signal.signalId,
      market: signal.market,
      symbol: signal.symbol,
      strategyProfileVersion: signal.strategyIdentity.strategyVersion,
      direction: signal.direction,
      strategyHorizon: "SWING",
      timeframes: Object.freeze([signal.timeframe]),
      timestamp: new Date(signal.timestampMs).toISOString(),
      dataTimestamp: new Date(signal.timestampMs - 1_000).toISOString(),
      dataProvenance: Object.freeze(["upbit:public-scanner"]),
      marketRegime: "TREND",
    }),
    riskEvidence: Object.freeze({
      status: "APPROVED",
      source: "TRADING_RISK_ENGINE",
      evaluatedAtMs: NOW - 1_000,
      simulatedOnly: true,
      allowed: true,
      blockCodes: Object.freeze([]),
      recommendedQuantity: 0.25,
      actualRiskPercent: 0.5,
      riskReward1: 2,
      riskReward2: 3,
      executionAuthority: "NONE",
    }),
    executionEvidence: Object.freeze({
      dataEvidence: Object.freeze({
        provider: "upbit",
        provenance: "upbit:public-paper-readiness",
        publicOnly: true,
        dataQuality: "READY",
        asOfMs: NOW - 1_000,
        maxAgeMs: 5_000,
        tickSize: 1,
        barProxyRealtimeAllowed: false,
        quoteEvidence: Object.freeze({
          available: true,
          bid: 99,
          ask: 101,
          asOfMs: NOW - 500,
          maxAgeMs: 5_000,
        }),
        marketStatus: "TRADABLE",
        minOrderNotional: 5,
      }),
      costPolicy: Object.freeze({
        version: COST_POLICY,
        commissionRate: 0.0005,
        taxRate: 0,
        spreadRate: 0.0004,
        slippageRate: 0.0005,
        fundingRate: 0,
        latencyRate: 0.0001,
        liquidityImpactRate: 0.0002,
        partialFillImpactRate: 0.0001,
        source: "SCANNER_COST_EVIDENCE_PERCENT_DIV_100",
        unitConversion: "PERCENT_DIV_100",
      }),
      costProvenance: Object.freeze({
        market: "CRYPTO_SPOT",
        policyId: COST_POLICY,
        paperCostPolicyVersion: COST_POLICY,
        providerProvenance: "upbit:public-paper-readiness",
        taxPolicyVersion: null,
        components,
      }),
    }),
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
  });
}

function scannerResponse() {
  return {
    universe: { totalCount: 1, nextCursor: null, source: "public-live", partial: false, stale: false },
    execution: {
      requestedCount: 1,
      startedCount: 1,
      completedCount: 1,
      providerAcceptedCount: 1,
      providerErrorCount: 0,
      timeoutCount: 0,
      insufficientDataCount: 0,
      hardFilterPassCount: 1,
      hardFilterRejectedCount: 0,
      softCandidateCount: 1,
      filteredByStrategyCount: 0,
    },
    cards: [{ market: "CRYPTO_SPOT", symbol: "KRW-BTC", signalId: "CRYPTO_SPOT-natural-001", signalGrade: "A" }],
    failures: [],
  };
}

function profitableInput() {
  return {
    probabilities: { tp: 0.7, sl: 0.2, expire: 0.1 },
    returns: { target: 0.05, stop: 0.02, expire: 0 },
    costs: {
      status: "READY",
      policyId: COST_POLICY,
      components: { commission: 0.0005, spread: 0.0004, slippage: 0.0005 },
    },
    calibration: { status: "READY", sampleSize: 120, tpFirstCount: 84 },
  };
}

test("authoritative producer passes only a cross-runtime verified #529 bundle", async () => {
  const valid = bundle();
  const producer = createAuthoritativeNaturalPaperAdmissionProducer({
    bundleForCard: async () => valid,
    now: () => NOW,
  });
  const result = await producer.produce({ signalId: valid.paperCandidate.signal.signalId }, "CRYPTO_SPOT");
  assert.equal(result.status, "READY");
  assert.equal(result.evidenceDigest, valid.evidenceDigest);
  assert.equal(result.bundle.riskEvidence.source, "TRADING_RISK_ENGINE");
  assert.equal(result.liveOrderAllowed, false);
  assert.equal(result.privateTradingApiAllowed, false);

  const tampered = structuredClone(valid);
  tampered.riskEvidence.recommendedQuantity = 99;
  const blockedProducer = createAuthoritativeNaturalPaperAdmissionProducer({
    bundleForCard: async () => tampered,
    now: () => NOW,
  });
  const blocked = await blockedProducer.produce({ signalId: valid.paperCandidate.signal.signalId }, "CRYPTO_SPOT");
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(blocked.blockers.includes("ADMISSION_EVIDENCE_DIGEST_MISMATCH"));
  assert.equal(blocked.bundle, null);
});

test("authoritative runtime injects the verified bundle before #532 and #533 Paper admission", async () => {
  const valid = bundle();
  const producer = createAuthoritativeNaturalPaperAdmissionProducer({
    bundleForCard: async () => valid,
    now: () => NOW,
  });
  const runtime = createCanonicalNaturalPaperRuntimeForMarket({
    scanBatchForMarket: async () => scannerResponse(),
    profitInputForCard: async () => profitableInput(),
    admissionProducer: producer,
    now: () => NOW,
  });

  const result = await runtime({ market: "CRYPTO_SPOT", cycle: { cycleId: "natural:1" } });
  assert.equal(result.status, "PAPER_CANDIDATES_READY");
  assert.equal(result.admissionBridgeReadyCandidates, 1);
  assert.equal(result.simulationReadyCandidates, 1);
  assert.equal(result.bridgeEligibleCandidates, 1);
  assert.equal(result.paperBridge.candidates.length, 1);
  assert.equal(result.paperBridge.candidates[0].sampleExecutionReady, true);
  assert.equal(result.paperBridge.candidates[0].order.type, "MARKET");
  assert.equal(result.paperBridge.candidates[0].order.quantity, 0.25);
  assert.equal(result.paperBridge.candidates[0].execution.executionPolicy.fillModel, "TOP_OF_BOOK");
  assert.equal(result.paperBridge.candidates[0].executionAuthority, "NONE");
  assert.equal(result.paperBridge.candidates[0].liveOrderAllowed, false);
  assert.equal(result.paperBridge.candidates[0].privateTradingApiAllowed, false);
});

test("missing authoritative producer is explicit VALID_NO_TRADE instead of legacy entry fallback", async () => {
  const runtime = createFailClosedCanonicalPaperRuntimeForMarket();
  const result = await runtime({ market: "CRYPTO_FUTURES" });
  assert.equal(result.status, "VALID_NO_TRADE");
  assert.deepEqual(result.paperBridge.candidates, []);
  assert.deepEqual(result.paperBridge.exitSignals, []);
  assert.ok(result.admissionBlockers.includes("AUTHORITATIVE_ADMISSION_PRODUCER_UNAVAILABLE"));
  assert.equal(result.liveOrderAllowed, false);
  assert.equal(result.privateTradingApiAllowed, false);
});

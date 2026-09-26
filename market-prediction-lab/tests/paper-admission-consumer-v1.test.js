import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { runCanonicalMeaningfulSearchPaperMarket } from "../src/canonical-meaningful-search-paper-runtime-v1.js";
import { resolveLearningStrategyHorizon } from "../src/strategy-horizon-contract-v1.js";

const NOW = 1_800_000_000_000;
const RESEARCH_SHA = "b".repeat(40);
const COST_POLICY = "cost-v1";

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function withDigest(payload) {
  const clone = structuredClone(payload);
  delete clone.evidenceDigest;
  return Object.freeze({ ...clone, evidenceDigest: digest(clone) });
}

function costComponent(valuePercent, source, quality = "OBSERVED") {
  return Object.freeze({ valuePercent, quality, source, observedAtMs: NOW - 1_000 });
}

function admissionBundle({
  signalId = "spot-runtime-1",
  style = "SWING",
  learningHorizon = resolveLearningStrategyHorizon(style),
  quoteOverrides = {},
} = {}) {
  const signal = Object.freeze({
    signalId,
    market: "CRYPTO_SPOT",
    symbol: "BTC",
    timestampMs: NOW - 10_000,
    ttlMs: 4 * 60 * 60_000,
    expiresAtMs: NOW - 10_000 + 4 * 60 * 60_000,
    style,
    timeframe: "1h",
    horizon: 4,
    direction: "BUY",
    signalDirection: "BUY",
    strategyIdentity: Object.freeze({
      strategyId: "CRYPTO_SPOT_SWING_BUY",
      strategyVersion: "signal-profile-v1",
      parameterHash: "params-v1",
      researchCodeSha: RESEARCH_SHA,
      costPolicyVersion: COST_POLICY,
    }),
  });
  const components = Object.freeze({
    commission: costComponent(0.10, "upbit:commission"),
    tax: costComponent(0, "cash:tax-na", "NOT_APPLICABLE"),
    spread: costComponent(0.10, "upbit:spread"),
    slippage: costComponent(0.15, "paper:slippage", "ESTIMATED"),
    funding: costComponent(0, "cash:funding-na", "NOT_APPLICABLE"),
    latency: costComponent(0.01, "runtime:latency", "ESTIMATED"),
    liquidityImpact: costComponent(0.02, "runtime:liquidity", "ESTIMATED"),
    partialFillImpact: costComponent(0.03, "runtime:partial-fill", "ESTIMATED"),
  });

  return withDigest({
    schemaVersion: "scanner-paper-admission-evidence-bundle-v1",
    paperCandidate: {
      signal,
      executionAuthority: "NONE",
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
    },
    learningSnapshot: {
      immutable: true,
      executionAuthority: "NONE",
      signalId,
      market: "CRYPTO_SPOT",
      symbol: "BTC",
      strategyProfileVersion: "signal-profile-v1",
      direction: "BUY",
      strategyHorizon: learningHorizon,
      timeframes: ["1h"],
      timestamp: new Date(signal.timestampMs).toISOString(),
      dataTimestamp: new Date(signal.timestampMs - 1_000).toISOString(),
      dataProvenance: ["upbit:public-scanner"],
      marketRegime: "TREND",
    },
    riskEvidence: {
      status: "APPROVED",
      source: "TRADING_RISK_ENGINE",
      evaluatedAtMs: NOW - 1_000,
      simulatedOnly: true,
      allowed: true,
      blockCodes: [],
      recommendedQuantity: 0.25,
      actualRiskPercent: 0.5,
      riskReward1: 2,
      riskReward2: 3,
      executionAuthority: "NONE",
    },
    executionEvidence: {
      dataEvidence: {
        provider: "upbit",
        provenance: "upbit:public-paper-readiness",
        publicOnly: true,
        dataQuality: "READY",
        asOfMs: NOW - 1_000,
        maxAgeMs: 30_000,
        tickSize: 1,
        barProxyRealtimeAllowed: true,
        marketStatus: "TRADABLE",
        minOrderNotional: 5,
        quoteEvidence: {
          available: true,
          bid: 99,
          ask: 100,
          asOfMs: NOW - 500,
          maxAgeMs: 5_000,
          ...quoteOverrides,
        },
      },
      costPolicy: {
        version: COST_POLICY,
        commissionRate: 0.001,
        taxRate: 0,
        spreadRate: 0.001,
        slippageRate: 0.0015,
        fundingRate: 0,
        latencyRate: 0.0001,
        liquidityImpactRate: 0.0002,
        partialFillImpactRate: 0.0003,
        source: "SCANNER_COST_EVIDENCE_PERCENT_DIV_100",
        unitConversion: "PERCENT_DIV_100",
      },
      costProvenance: {
        market: "CRYPTO_SPOT",
        policyId: COST_POLICY,
        paperCostPolicyVersion: COST_POLICY,
        providerProvenance: "upbit:public-paper-readiness",
        components,
      },
    },
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
  });
}

function profitableInput() {
  return {
    probabilities: { tp: 0.7, sl: 0.2, expire: 0.1 },
    returns: { target: 0.05, stop: 0.02, expire: 0 },
    costs: {
      status: "READY",
      policyId: COST_POLICY,
      components: { commission: 0.001, spread: 0.001, slippage: 0.0015 },
    },
    calibration: { status: "READY", sampleSize: 30, tpFirstCount: 21 },
  };
}

function scannerResponse(bundle) {
  return {
    universe: { totalCount: 1, nextCursor: null, source: "public-live", partial: false, stale: false },
    execution: {
      requestedCount: 1,
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
    cards: [{
      market: "CRYPTO_SPOT",
      symbol: "BTC",
      signalId: bundle.paperCandidate.signal.signalId,
      signalGrade: "A",
      paperCandidate: bundle.paperCandidate,
      paperAdmissionEvidenceBundle: bundle,
    }],
    failures: [],
  };
}

async function run(bundle) {
  return runCanonicalMeaningfulSearchPaperMarket({
    market: "CRYPTO_SPOT",
    scanBatch: async () => scannerResponse(bundle),
    profitInputForCard: async () => profitableInput(),
    now: () => NOW,
  });
}

test("canonical learning horizon labels preserve SCALPING/SWING/MID_LONG semantics", () => {
  assert.equal(resolveLearningStrategyHorizon("SCALPING"), "SCALP");
  assert.equal(resolveLearningStrategyHorizon("SWING"), "SWING");
  assert.equal(resolveLearningStrategyHorizon("MID_LONG"), "POSITION");
  assert.equal(resolveLearningStrategyHorizon("POSITION"), "POSITION");
});

test("merged admission bridge plus simulation authority produces a bridge-ready simulation-only Paper candidate", async () => {
  const result = await run(admissionBundle());

  assert.equal(result.search.outcome, "TRADE_CANDIDATES");
  assert.equal(result.admissionBridgeReadyCandidates, 1);
  assert.equal(result.admissionBlockedCandidates, 0);
  assert.equal(result.simulationReadyCandidates, 1);
  assert.equal(result.simulationBlockedCandidates, 0);
  assert.deepEqual(result.admissionBlockers, []);
  assert.deepEqual(result.simulationBlockers, []);
  assert.equal(result.bridgeEligibleCandidates, 1);
  assert.equal(result.bridgeBlockedCandidates, 0);
  assert.equal(result.status, "PAPER_CANDIDATES_READY");

  const candidate = result.paperBridge.candidates[0];
  assert.equal(candidate.sampleExecutionReady, true);
  assert.equal(candidate.execution.marketAdapterIdentity.id, "crypto-spot-upbit-execution");
  assert.equal(candidate.execution.executionPolicy.version, "public-evidence-simulated-paper-v1");
  assert.equal(candidate.order.type, "MARKET");
  assert.equal(candidate.order.direction, "BUY");
  assert.equal(candidate.order.quantity, 0.25);
  assert.equal(candidate.quote.ask, 100);
  assert.equal(candidate.executionAuthority, "NONE");
  assert.equal(candidate.orderSubmitted, false);
  assert.equal(candidate.exchangeRequestSent, false);
  assert.equal(candidate.privateTradingApiAllowed, false);
  assert.equal(candidate.liveOrderAllowed, false);
});

test("tampered admission digest is reported and cannot reach simulation authority or Paper eligibility", async () => {
  const bundle = structuredClone(admissionBundle({ signalId: "tampered-digest" }));
  bundle.riskEvidence.recommendedQuantity = 0.5;

  const result = await run(bundle);
  assert.equal(result.admissionBlockedCandidates, 1);
  assert.ok(result.admissionBlockers.includes("ADMISSION_EVIDENCE_DIGEST_MISMATCH"));
  assert.equal(result.simulationReadyCandidates, 0);
  assert.equal(result.bridgeEligibleCandidates, 0);
  assert.equal(result.status, "PAPER_CANDIDATE_CONTRACT_BLOCKED");
});

test("crossed top-of-book survives admission integrity checks but is blocked by preregistered simulation authority", async () => {
  const result = await run(admissionBundle({
    signalId: "crossed-quote",
    quoteOverrides: { bid: 102, ask: 101 },
  }));

  assert.equal(result.admissionBridgeReadyCandidates, 1);
  assert.equal(result.simulationBlockedCandidates, 1);
  assert.ok(result.simulationBlockers.includes("CANONICAL_TOP_OF_BOOK_CROSSED"));
  assert.equal(result.bridgeEligibleCandidates, 0);
  assert.equal(result.status, "PAPER_CANDIDATE_CONTRACT_BLOCKED");
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
});

test("real learning-horizon mismatch remains fail-closed at the canonical Paper bridge", async () => {
  const result = await run(admissionBundle({
    signalId: "bad-learning-horizon",
    style: "MID_LONG",
    learningHorizon: "SCALP",
  }));

  assert.equal(result.admissionBridgeReadyCandidates, 1);
  assert.equal(result.simulationReadyCandidates, 1);
  assert.equal(result.bridgeEligibleCandidates, 0);
  assert.equal(result.bridgeBlockedCandidates, 1);
  assert.ok(result.paperBridge.results[0].blockers.includes("LEARNING_HORIZON_STYLE_MISMATCH"));
  assert.equal(result.status, "PAPER_CANDIDATE_CONTRACT_BLOCKED");
});

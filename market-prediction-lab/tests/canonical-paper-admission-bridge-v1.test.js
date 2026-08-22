import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createCanonicalPaperAdmissionBridgeForCard,
  resolveCanonicalPaperAdmissionBridgeCandidate,
} from "../src/canonical-paper-admission-bridge-v1.js";
import { resolveCanonicalPaperSimulationAuthority } from "../src/canonical-paper-simulation-authority-v1.js";
import { prepareMeaningfulSearchPaperCandidate } from "../src/meaningful-search-paper-bridge-v1.js";

const NOW = 1_800_000_000_000;
const SHA = "b".repeat(40);
const COST_POLICY = "BACKTEST_FEES_SLIPPAGE_FUNDING_V1";

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

function validBundle(overrides = {}) {
  const signal = Object.freeze({
    signalId: "KR_STOCK-bridge-ready-1",
    market: "KR_STOCK",
    symbol: "005930",
    timestampMs: NOW - 10_000,
    ttlMs: 4 * 60 * 60_000,
    expiresAtMs: NOW - 10_000 + 4 * 60 * 60_000,
    style: "SWING",
    timeframe: "60m",
    horizon: 4,
    direction: "BUY",
    signalDirection: "BUY",
    strategyIdentity: Object.freeze({
      strategyId: "KR_STOCK_SWING_BUY",
      strategyVersion: "signal-profile-v1",
      parameterHash: "params-v1",
      researchCodeSha: SHA,
      costPolicyVersion: COST_POLICY,
    }),
  });
  const components = Object.freeze({
    commission: costComponent(0.10, "toss:commission"),
    tax: costComponent(0.05, "documented:tax", "DOCUMENTED"),
    spread: costComponent(0.10, "toss:spread"),
    slippage: costComponent(0.15, "paper:slippage", "ESTIMATED"),
    funding: costComponent(0, "cash:funding-na", "NOT_APPLICABLE"),
    latency: costComponent(0.01, "runtime:latency", "ESTIMATED"),
    liquidityImpact: costComponent(0.02, "runtime:liquidity", "ESTIMATED"),
    partialFillImpact: costComponent(0.03, "runtime:partial-fill", "ESTIMATED"),
  });
  const payload = {
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
      signalId: signal.signalId,
      market: signal.market,
      symbol: signal.symbol,
      strategyProfileVersion: signal.strategyIdentity.strategyVersion,
      direction: signal.direction,
      strategyHorizon: "SWING",
      timeframes: [signal.timeframe],
      timestamp: new Date(signal.timestampMs).toISOString(),
      dataTimestamp: new Date(signal.timestampMs - 1_000).toISOString(),
      dataProvenance: ["toss:public-scanner"],
      marketRegime: "TREND",
    },
    riskEvidence: {
      status: "APPROVED",
      source: "TRADING_RISK_ENGINE",
      evaluatedAtMs: NOW - 1_000,
      simulatedOnly: true,
      allowed: true,
      blockCodes: [],
      recommendedQuantity: 1,
      actualRiskPercent: 0.5,
      riskReward1: 2,
      riskReward2: 3,
      executionAuthority: "NONE",
    },
    executionEvidence: {
      dataEvidence: {
        provider: "toss",
        provenance: "toss:public-paper-readiness",
        publicOnly: true,
        dataQuality: "READY",
        asOfMs: NOW - 1_000,
        maxAgeMs: 30_000,
        tickSize: 1,
        barProxyRealtimeAllowed: true,
        quoteEvidence: {
          available: true,
          bid: 107,
          ask: 108,
          asOfMs: NOW - 1_000,
          maxAgeMs: 30_000,
        },
        taxPolicyKnown: true,
        taxPolicyVersion: "tax-v1",
        session: { version: "session-v1", status: "OPEN", kind: "REGULAR" },
        volatilityInterruptionKnown: true,
        volatilityInterruptionActive: false,
      },
      costPolicy: {
        version: COST_POLICY,
        commissionRate: 0.001,
        taxRate: 0.0005,
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
        market: "KR_STOCK",
        policyId: COST_POLICY,
        paperCostPolicyVersion: COST_POLICY,
        providerProvenance: "toss:public-paper-readiness",
        taxPolicyVersion: "tax-v1",
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
  };
  const merged = {
    ...payload,
    ...overrides,
    paperCandidate: overrides.paperCandidate ?? payload.paperCandidate,
    learningSnapshot: overrides.learningSnapshot ?? payload.learningSnapshot,
    riskEvidence: overrides.riskEvidence ?? payload.riskEvidence,
    executionEvidence: overrides.executionEvidence ?? payload.executionEvidence,
  };
  return withDigest(merged);
}

function eligibleProfitEvidence() {
  return Object.freeze({
    status: "READY",
    market: "KR_STOCK",
    expectedNetEdge: 0.01,
    expectedNetReturn: 0.015,
    riskRewardRatio: 2,
    sampleSize: 30,
    costPolicyId: COST_POLICY,
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

function withCanonicalSimulationAuthority(candidate) {
  const simulation = resolveCanonicalPaperSimulationAuthority({ candidate, nowMs: NOW });
  assert.equal(simulation.status, "READY", simulation.blockers?.join(",") ?? "simulation authority blocked");
  assert.ok(simulation.execution);
  assert.ok(simulation.order);
  assert.ok(simulation.quote);
  return Object.freeze({
    ...candidate,
    execution: simulation.execution,
    order: simulation.order,
    quote: simulation.quote,
    sampleExecutionReady: true,
    sampleExecutionBlockers: Object.freeze([]),
  });
}

test("valid #529 bundle becomes a bridge-ready Paper candidate with exact evidence", () => {
  const bundle = validBundle();
  const resolved = resolveCanonicalPaperAdmissionBridgeCandidate({ bundle, nowMs: NOW });
  assert.equal(resolved.status, "BRIDGE_READY");
  assert.equal(resolved.bridgeReady, true);
  assert.deepEqual(resolved.blockers, []);
  assert.equal(resolved.evidenceDigest, bundle.evidenceDigest);
  assert.equal(resolved.candidate.signal.learningSnapshot.signalId, bundle.paperCandidate.signal.signalId);
  assert.equal(resolved.candidate.riskEvidence.source, "TRADING_RISK_ENGINE");
  assert.equal(resolved.candidate.execution.dataEvidence.dataQuality, "READY");
  assert.equal(resolved.candidate.execution.costPolicy.version, COST_POLICY);
  assert.equal(resolved.candidate.execution.costPolicy.commissionRate, 0.001);
  assert.equal(resolved.candidate.admissionEvidence.crossRuntimeVerified, true);
});

test("bridge-ready candidate satisfies existing #512 Paper admission contract once canonical simulation authority is READY", () => {
  const resolved = resolveCanonicalPaperAdmissionBridgeCandidate({ bundle: validBundle(), nowMs: NOW });
  assert.equal(resolved.status, "BRIDGE_READY");
  const candidate = withCanonicalSimulationAuthority(resolved.candidate);
  const bridge = prepareMeaningfulSearchPaperCandidate({
    searchOutcome: "TRADE_CANDIDATES",
    candidate,
    profitGate: Object.freeze({ decision: "ELIGIBLE", eligible: true, reasons: Object.freeze([]), executionAuthority: "NONE" }),
    profitEvidence: eligibleProfitEvidence(),
  });
  assert.equal(bridge.status, "PAPER_ELIGIBLE");
  assert.equal(bridge.submitToPaper, true);
  assert.deepEqual(bridge.blockers, []);
  assert.equal(bridge.candidate.paperIdentity.costPolicyVersion, COST_POLICY);
  assert.equal(bridge.candidate.executionAuthority, "NONE");
});

test("digest tampering is rejected before any evidence becomes a candidate", () => {
  const bundle = validBundle();
  const tampered = structuredClone(bundle);
  tampered.riskEvidence.recommendedQuantity = 999;
  const resolved = resolveCanonicalPaperAdmissionBridgeCandidate({ bundle: tampered, nowMs: NOW });
  assert.equal(resolved.status, "BLOCKED");
  assert.equal(resolved.candidate, null);
  assert.ok(resolved.blockers.includes("ADMISSION_EVIDENCE_DIGEST_MISMATCH"));
});

test("re-digested identity mismatch still fails closed across runtimes", () => {
  const bundle = validBundle();
  const badLearning = { ...bundle.learningSnapshot, signalId: "different-signal" };
  const tampered = withDigest({ ...bundle, learningSnapshot: badLearning });
  const resolved = resolveCanonicalPaperAdmissionBridgeCandidate({ bundle: tampered, nowMs: NOW });
  assert.equal(resolved.status, "BLOCKED");
  assert.ok(resolved.blockers.includes("LEARNING_SIGNAL_ID_MISMATCH"));
});

test("stale risk or execution evidence cannot be revived by a valid digest", () => {
  const bundle = validBundle();
  const staleRisk = withDigest({
    ...bundle,
    riskEvidence: { ...bundle.riskEvidence, evaluatedAtMs: NOW - 30_001 },
  });
  const riskResult = resolveCanonicalPaperAdmissionBridgeCandidate({ bundle: staleRisk, nowMs: NOW });
  assert.equal(riskResult.status, "BLOCKED");
  assert.ok(riskResult.blockers.includes("RISK_EVIDENCE_STALE"));

  const staleData = withDigest({
    ...bundle,
    executionEvidence: {
      ...bundle.executionEvidence,
      dataEvidence: { ...bundle.executionEvidence.dataEvidence, asOfMs: NOW - 30_001 },
    },
  });
  const dataResult = resolveCanonicalPaperAdmissionBridgeCandidate({ bundle: staleData, nowMs: NOW });
  assert.equal(dataResult.status, "BLOCKED");
  assert.ok(dataResult.blockers.includes("EXECUTION_EVIDENCE_STALE"));
});

test("cost percent-to-ratio provenance must still match exactly in Prediction Lab", () => {
  const bundle = validBundle();
  const tampered = withDigest({
    ...bundle,
    executionEvidence: {
      ...bundle.executionEvidence,
      costPolicy: { ...bundle.executionEvidence.costPolicy, spreadRate: 0.01 },
    },
  });
  const resolved = resolveCanonicalPaperAdmissionBridgeCandidate({ bundle: tampered, nowMs: NOW });
  assert.equal(resolved.status, "BLOCKED");
  assert.ok(resolved.blockers.includes("EXECUTION_COST_SPREAD_CONVERSION_MISMATCH"));
});

test("P0-C2 never fabricates execution policy, market adapter, order, or fill authority", () => {
  const resolved = resolveCanonicalPaperAdmissionBridgeCandidate({ bundle: validBundle(), nowMs: NOW });
  assert.equal(resolved.status, "BRIDGE_READY");
  assert.equal(resolved.sampleExecutionReady, false);
  assert.ok(resolved.sampleExecutionBlockers.includes("CANONICAL_EXECUTION_POLICY_REQUIRED"));
  assert.ok(resolved.sampleExecutionBlockers.includes("CANONICAL_MARKET_ADAPTER_IDENTITY_REQUIRED"));
  assert.ok(resolved.sampleExecutionBlockers.includes("SIMULATED_ORDER_REQUIRED"));
  assert.equal(resolved.candidate.execution.executionPolicy, undefined);
  assert.equal(resolved.candidate.execution.marketAdapterIdentity, undefined);
  assert.equal(resolved.candidate.order, undefined);
  assert.equal(resolved.candidate.fill, undefined);
  assert.equal(resolved.candidate.liveOrderAllowed, false);
  assert.equal(resolved.candidate.privateTradingApiAllowed, false);
  assert.equal(resolved.candidate.orderSubmitted, false);
  assert.equal(resolved.candidate.exchangeRequestSent, false);
});

test("card callback consumes only caller-supplied admission bundle and fails closed on market mismatch", async () => {
  let reads = 0;
  const bridgeForCard = createCanonicalPaperAdmissionBridgeForCard({
    bundleForCard: async () => { reads += 1; return validBundle(); },
    now: () => NOW,
  });
  const ready = await bridgeForCard({ signalId: "card-1" }, "KR_STOCK");
  assert.equal(reads, 1);
  assert.equal(ready.status, "BRIDGE_READY");

  const blocked = await bridgeForCard({ signalId: "card-2" }, "US_STOCK");
  assert.equal(reads, 2);
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(blocked.blockers.includes("ADMISSION_BRIDGE_MARKET_MISMATCH"));
});

test("unsafe bundle envelope is rejected even when its digest is internally consistent", () => {
  const bundle = validBundle();
  const unsafe = withDigest({ ...bundle, liveOrderAllowed: true });
  const resolved = resolveCanonicalPaperAdmissionBridgeCandidate({ bundle: unsafe, nowMs: NOW });
  assert.equal(resolved.status, "BLOCKED");
  assert.ok(resolved.blockers.includes("ADMISSION_EVIDENCE_SAFETY_ENVELOPE_INVALID"));
});

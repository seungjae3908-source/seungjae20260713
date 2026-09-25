import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTransactionCostEvidence } from "../../market-intelligence-sidecar/src/transaction-cost-evidence.mjs";
import { buildAdaptiveMultiEvidenceCostLiquidityV2 } from "../src/adaptive-multi-evidence-cost-liquidity-v2.js";

const NOW = Date.parse("2026-09-14T07:00:00.000Z");

function staticCost(valueBps) {
  return { sourceType: "STATIC_POLICY", source: "VERSIONED_POLICY", valueBps, asOf: NOW - 1000,
    policyVersion: "policy-v2" };
}

function observed(valueBps, source = "PUBLIC_MARKET") {
  return { sourceType: "OBSERVED_MARKET", source, valueBps, asOf: NOW - 1000, sampleSize: 1 };
}

function calibrated(valueBps, conservativeUpperBps, modelId) {
  return { sourceType: "CALIBRATED_MODEL", source: "OOS_CALIBRATION", valueBps,
    conservativeUpperBps, asOf: NOW - 1000, sampleSize: 1000, modelId };
}

function costs() {
  return evaluateTransactionCostEvidence({
    now: NOW,
    market: "US_STOCK",
    evidenceSetVersion: "us-cost-v2",
    components: {
      commissionBps: staticCost(1),
      taxBps: staticCost(0),
      spreadBps: observed(2),
      slippageBps: calibrated(1, 2, "slippage-v2"),
      fundingBps: { sourceType: "NOT_APPLICABLE", notApplicableReason: "NON_FUTURES_MARKET" },
      latencyBps: observed(0.5),
      liquidityImpactBps: calibrated(1.5, 2.5, "liquidity-artifact-1"),
      partialFillImpactBps: calibrated(0.5, 1, "partial-fill-v2"),
    },
  });
}

function liquidityAdmission(overrides = {}) {
  return {
    contract: "liquidity-impact-runtime-admission/v1",
    validationStatus: "PASS",
    liquidityImpactStatus: "PRESENT",
    runtimeEligible: true,
    estimatedImpactBps: 1.5,
    artifact: { artifactId: "liquidity-artifact-1" },
    safety: { executionAuthority: "NONE", privateApiAllowed: false, realOrderCount: 0 },
    ...overrides,
  };
}

function metaDecision(overrides = {}) {
  return {
    schemaVersion: "adaptive-multi-evidence-meta-decision-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "RESEARCH_DECISION_READY",
    decision: "BUY",
    executionAuthority: "NONE",
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    metaDecision: metaDecision(),
    market: "US_STOCK",
    symbol: "AAPL",
    timeframe: "1h",
    strategyIdentity: "strategy-1",
    decisionTime: new Date(NOW).toISOString(),
    transactionCostEvidence: costs(),
    liquidityImpactAdmission: liquidityAdmission(),
    liquiditySnapshot: {
      market: "US_STOCK",
      symbol: "AAPL",
      bid: 100,
      ask: 100.02,
      visibleDepthNotional: 1_000_000,
      orderNotional: 20_000,
      asOf: NOW - 500,
      sourceId: "public-book-1",
      sourceDigest: "a".repeat(64),
      publicMarketData: true,
    },
    expectedValueEvidence: {
      market: "US_STOCK",
      symbol: "AAPL",
      timeframe: "1h",
      side: "BUY",
      strategyIdentity: "strategy-1",
      prospectiveOrOos: true,
      sampleSize: 500,
      minimumSampleSize: 200,
      grossEvBps: 20,
      grossLowerBps: 15,
      evidenceId: "ev-1",
    },
    policy: { maximumSpreadBps: 5, maximumVisibleDepthParticipation: 0.1, maximumAgeMs: 60_000 },
    executionAuthority: "NONE",
    ...overrides,
  };
}

test("canonical cost and independent liquidity owners produce conservative net EV", () => {
  const result = buildAdaptiveMultiEvidenceCostLiquidityV2(input());
  assert.equal(result.status, "COST_LIQUIDITY_GATE_PASS");
  assert.equal(result.decision, "BUY");
  assert.equal(result.cost.pointBps, 6.5);
  assert.equal(result.cost.conservativeBps, 9);
  assert.equal(result.expectedValue.netBps, 13.5);
  assert.equal(result.expectedValue.conservativeNetBps, 6);
  assert.equal(result.gateUpdates.COST.state, "PASS");
  assert.equal(result.gateUpdates.LIQUIDITY.state, "PASS");
});

test("missing expected value stays unavailable and causes NO_TRADE", () => {
  const result = buildAdaptiveMultiEvidenceCostLiquidityV2(input({ expectedValueEvidence: null }));
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.decision, "NO_TRADE");
  assert.equal(result.expectedValue.status, "UNAVAILABLE");
  assert.equal(result.expectedValue.netBps, null);
  assert.equal(result.missingCostIsZero, false);
});

test("gross EV cannot override a non-positive conservative full-cost result", () => {
  const result = buildAdaptiveMultiEvidenceCostLiquidityV2(input({
    expectedValueEvidence: { ...input().expectedValueEvidence, grossEvBps: 50, grossLowerBps: 8 },
  }));
  assert.equal(result.decision, "NO_TRADE");
  assert.equal(result.expectedValue.status, "NOT_POSITIVE_AFTER_CONSERVATIVE_FULL_COST");
  assert.ok(result.reasons.includes("EV_UNCERTAIN_OR_NON_POSITIVE_AFTER_FULL_COST"));
});

test("stale or oversized public liquidity evidence fails closed", () => {
  const stale = buildAdaptiveMultiEvidenceCostLiquidityV2(input({
    liquiditySnapshot: { ...input().liquiditySnapshot, asOf: NOW - 120_000 },
  }));
  assert.equal(stale.decision, "NO_TRADE");
  assert.equal(stale.gateUpdates.LIQUIDITY.state, "UNKNOWN");

  const oversized = buildAdaptiveMultiEvidenceCostLiquidityV2(input({
    liquiditySnapshot: { ...input().liquiditySnapshot, orderNotional: 200_000 },
  }));
  assert.equal(oversized.decision, "NO_TRADE");
  assert.equal(oversized.gateUpdates.LIQUIDITY.state, "FAIL");
});

test("liquidity impact component must bind the admitted independent artifact", () => {
  const result = buildAdaptiveMultiEvidenceCostLiquidityV2(input({
    liquidityImpactAdmission: liquidityAdmission({ estimatedImpactBps: 2 }),
  }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.reasons.includes("LIQUIDITY_IMPACT_COST_OWNER_BINDING_MISMATCH"));
});

test("execution authority and private actions remain disabled", () => {
  const result = buildAdaptiveMultiEvidenceCostLiquidityV2(input({ executionAuthority: "PAPER" }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.liveTrading, false);
  assert.equal(result.autoTrading, false);
  assert.equal(result.realOrderEnabled, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
});

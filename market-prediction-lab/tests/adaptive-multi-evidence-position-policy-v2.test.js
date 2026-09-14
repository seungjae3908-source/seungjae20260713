import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../src/research-cache-provenance.js";
import {
  ADAPTIVE_V2_SCALE_IN_TRIGGERS,
  buildAdaptiveMultiEvidencePositionPolicyV2,
} from "../src/adaptive-multi-evidence-position-policy-v2.js";

const NOW = "2026-09-14T08:00:00.000Z";

function portfolio(side = "BUY") {
  const members = [{ candidateId: "strategy-1", side }];
  const core = {
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    frozenAt: "2026-09-14T06:00:00.000Z",
    prospectiveBoundary: "2026-09-14T06:00:00.000Z",
    members,
    memberCount: 1,
    pairwise: [],
    diversificationPolicy: {},
  };
  const digest = sha256Canonical(core);
  return {
    schemaVersion: "adaptive-multi-evidence-strategy-portfolio-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "FROZEN_V2_STRATEGY_PORTFOLIO",
    portfolio: { ...core, portfolioId: `adaptive-v2-portfolio:${digest}`, portfolioDigest: digest,
      immutable: true, executionAuthority: "NONE" },
    frozenV1Contamination: 0,
    executionAuthority: "NONE",
  };
}

function costLiquidity(decision = "BUY", market = "US_STOCK", symbol = "AAPL") {
  return {
    schemaVersion: "adaptive-multi-evidence-cost-liquidity-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "COST_LIQUIDITY_GATE_PASS",
    decision,
    cost: { market, symbol, strategyIdentity: "strategy-1", decisionTime: NOW, conservativeBps: 10 },
    liquidity: { visibleDepthNotional: 1_000_000, orderNotional: 100_000 },
    evidenceDigest: "cost-digest",
    executionAuthority: "NONE",
  };
}

function globalRisk(decision = "BUY") {
  return {
    schemaVersion: "adaptive-multi-evidence-global-risk-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "GLOBAL_RISK_PASS",
    decision,
    riskEvidenceId: "risk-1",
    riskBudget: { approved: 1_000 },
    capacity: {
      remainingPositionSlots: 3,
      remainingMarketExposure: 100_000,
      remainingAssetClassExposure: 100_000,
      remainingSectorExposure: 100_000,
      remainingDirectionalExposure: 100_000,
    },
    executionAuthority: "NONE",
  };
}

function validatedPolicy(overrides = {}) {
  return {
    policyId: "exit-policy-1",
    validatedPolicyEvidenceId: "validated-oos-policy-1",
    logicalInvalidationPrice: 95,
    hardStopPrice: 95,
    takeProfit1Price: 110,
    takeProfit2Price: 120,
    takeProfit1Fraction: 0.4,
    takeProfit2Fraction: 0.3,
    trailingActivationPrice: 108,
    trailingDistance: 4,
    timeStopBars: 24,
    strategyInvalidationExitEnabled: true,
    eventRiskExitEnabled: true,
    universalFixedPercentExit: false,
    lotSize: 1,
    maximumPositionNotional: 100_000,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    portfolio: portfolio(),
    globalRisk: globalRisk(),
    costLiquidity: costLiquidity(),
    market: "US_STOCK",
    symbol: "AAPL",
    strategyIdentity: "strategy-1",
    entryPrice: 100,
    validatedPolicy: validatedPolicy(),
    executionSimulationPolicy: {
      marketSimMaximumParticipation: 0.01,
      limitSimMaximumParticipation: 0.03,
      splitSimMaximumParticipation: 0.1,
    },
    executionAuthority: "NONE",
    ...overrides,
  };
}

test("stop and validated invalidation are fixed before risk-derived quantity", () => {
  const result = buildAdaptiveMultiEvidencePositionPolicyV2(input());
  assert.equal(result.status, "POSITION_POLICY_READY");
  assert.equal(result.sizing.hardStopPrice, 95);
  assert.equal(result.sizing.stopMovedForSize, false);
  assert.equal(result.sizing.stopOnlyQuantity, 200);
  assert.equal(result.sizing.costAdjustedQuantity, 196);
  assert.ok(result.sizing.totalRiskAtStopWithCost <= 1_000);
  assert.deepEqual(result.sizing.order, [
    "LOGICAL_INVALIDATION_AND_STOP", "STOP_DISTANCE", "PERMITTED_ACCOUNT_RISK",
    "DERIVE_QUANTITY", "TOTAL_EXPOSURE", "LIQUIDITY_AND_FULL_COST", "APPROVE_OR_REJECT",
  ]);
  assert.equal(result.executionSimulation, "LIMIT_SIM");
});

test("validated strategy owns exits and no universal fixed-percent exit is introduced", () => {
  const result = buildAdaptiveMultiEvidencePositionPolicyV2(input());
  assert.deepEqual(result.exits.takeProfit1, { price: 110, fraction: 0.4 });
  assert.deepEqual(result.exits.takeProfit2, { price: 120, fraction: 0.3 });
  assert.deepEqual(result.exits.trailingStop, { activationPrice: 108, distance: 4 });
  assert.equal(result.exits.timeStopBars, 24);
  assert.equal(result.exits.strategyInvalidationExit, true);
  assert.equal(result.exits.eventRiskExit, true);
  assert.equal(result.exits.universalFixedPercentExit, false);
});

test("all allowed scale-ins preserve original stop and original maximum risk", () => {
  for (const trigger of ADAPTIVE_V2_SCALE_IN_TRIGGERS) {
    const result = buildAdaptiveMultiEvidencePositionPolicyV2(input({
      scaleIn: {
        trigger,
        confirmationEvidenceId: `confirmation-${trigger}`,
        remainingRiskBudget: 400,
        currentPaperPosition: {
          paperPosition: true,
          market: "US_STOCK",
          symbol: "AAPL",
          strategyIdentity: "strategy-1",
          direction: "LONG",
          quantity: 100,
          unrealizedPnl: 200,
          originalRiskBudget: 1_000,
          originalHardStopPrice: 95,
        },
      },
    }));
    assert.equal(result.status, "POSITION_POLICY_READY");
    assert.equal(result.scaleIn.trigger, trigger);
    assert.equal(result.scaleIn.originalRiskBudgetPreserved, true);
    assert.ok(result.sizing.totalRiskAtStopWithCost <= 1_000);
  }
});

test("loss recovery averaging and crypto futures loss averaging fail closed", () => {
  const scaleIn = {
    trigger: "PULLBACK_CONTINUATION",
    confirmationEvidenceId: "confirmation-1",
    remainingRiskBudget: 400,
    currentPaperPosition: {
      paperPosition: true,
      market: "CRYPTO_FUTURES",
      symbol: "BTCUSDT",
      strategyIdentity: "strategy-1",
      direction: "LONG",
      quantity: 1,
      unrealizedPnl: -10,
      originalRiskBudget: 1_000,
      originalHardStopPrice: 95,
    },
  };
  const result = buildAdaptiveMultiEvidencePositionPolicyV2(input({
    portfolio: portfolio("LONG"),
    globalRisk: globalRisk("LONG"),
    costLiquidity: costLiquidity("LONG", "CRYPTO_FUTURES", "BTCUSDT"),
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    scaleIn,
  }));
  assert.equal(result.status, "NO_TRADE");
  assert.ok(result.reasons.includes("CRYPTO_FUTURES_LOSS_AVERAGING_FORBIDDEN"));
});

test("quantity above admitted liquidity or exposure is rejected without moving stop", () => {
  const cost = costLiquidity();
  cost.liquidity.orderNotional = 1_000;
  const result = buildAdaptiveMultiEvidencePositionPolicyV2(input({ costLiquidity: cost }));
  assert.equal(result.status, "NO_TRADE");
  assert.ok(result.reasons.includes("COST_LIQUIDITY_ADMITTED_NOTIONAL_EXCEEDED"));
  assert.equal(result.sizing.stopMovedForSize, false);
  assert.equal(result.executionSimulation, "NO_TRADE");
});

test("short policy uses direction-correct stop, targets, and trailing activation", () => {
  const result = buildAdaptiveMultiEvidencePositionPolicyV2(input({
    portfolio: portfolio("SELL"),
    globalRisk: globalRisk("SELL"),
    costLiquidity: costLiquidity("SELL"),
    validatedPolicy: validatedPolicy({
      logicalInvalidationPrice: 105,
      hardStopPrice: 105,
      takeProfit1Price: 90,
      takeProfit2Price: 80,
      trailingActivationPrice: 92,
    }),
  }));
  assert.equal(result.status, "POSITION_POLICY_READY");
  assert.equal(result.identity.direction, "SHORT");
});

test("missing evidence is not zero and the module has no execution authority", () => {
  const blocked = buildAdaptiveMultiEvidencePositionPolicyV2(input({
    costLiquidity: { ...costLiquidity(), liquidity: { visibleDepthNotional: null, orderNotional: null } },
  }));
  assert.equal(blocked.status, "BLOCKED_DATA");
  const forbidden = buildAdaptiveMultiEvidencePositionPolicyV2(input({ executionAuthority: "PAPER" }));
  assert.equal(forbidden.status, "BLOCKED_DATA");
  assert.equal(forbidden.frozenV1Contamination, 0);
  assert.equal(forbidden.liveTrading, false);
  assert.equal(forbidden.autoTrading, false);
  assert.equal(forbidden.realOrderEnabled, false);
  assert.equal(forbidden.privateTradingApiAllowed, false);
  assert.equal(forbidden.executionAuthority, "NONE");
});

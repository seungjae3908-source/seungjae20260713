import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../src/research-cache-provenance.js";
import { buildAdaptiveMultiEvidenceGlobalRiskV2 } from "../src/adaptive-multi-evidence-global-risk-v2.js";

const NOW = "2026-09-14T08:00:00.000Z";

function portfolio() {
  const members = [{ candidateId: "strategy-1", side: "BUY" }];
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

function costLiquidity(overrides = {}) {
  return {
    schemaVersion: "adaptive-multi-evidence-cost-liquidity-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "COST_LIQUIDITY_GATE_PASS",
    decision: "BUY",
    liquidity: { spreadBps: 2 },
    cost: {
      market: "US_STOCK",
      symbol: "AAPL",
      timeframe: "1h",
      strategyIdentity: "strategy-1",
      decisionTime: NOW,
      components: { slippageBps: { conservativeBps: 3 } },
    },
    executionAuthority: "NONE",
    ...overrides,
  };
}

function account(overrides = {}) {
  return {
    paperAccount: true,
    privateApiUsed: false,
    sourceId: "paper-account-1",
    sourceDigest: "a".repeat(64),
    observedAt: Date.parse(NOW) - 1000,
    equity: 100_000,
    dailyNetPnl: -500,
    consecutiveLosses: 1,
    openPositions: 2,
    marketExposure: 20_000,
    assetClassExposure: 30_000,
    sectorApplicable: true,
    sectorExposure: 10_000,
    directionalExposure: 25_000,
    accountLeverage: 1,
    marginHeadroomPct: 1,
    ...overrides,
  };
}

const policy = {
  maximumPerTradeRiskPct: 0.01,
  maximumDailyLossPct: 0.03,
  maximumConsecutiveLosses: 3,
  maximumOpenPositions: 5,
  maximumMarketExposurePct: 0.5,
  maximumAssetClassExposurePct: 0.6,
  maximumSectorExposurePct: 0.25,
  maximumDirectionalExposurePct: 0.5,
  maximumCorrelation: 0.7,
  maximumAccountLeverage: 1,
  minimumMarginHeadroomPct: 0.2,
  minimumLiquidationDistancePct: 0.15,
  maximumSpreadBps: 5,
  maximumSlippageBps: 8,
  maximumSnapshotAgeMs: 60_000,
};

function input(overrides = {}) {
  return {
    portfolio: portfolio(),
    costLiquidity: costLiquidity(),
    market: "US_STOCK",
    symbol: "AAPL",
    decisionTime: NOW,
    requestedRiskBudget: 800,
    accountSnapshot: account(),
    providerHealth: { status: "HEALTHY", publicOnly: true, privateApiUsed: false },
    strategyHealth: { status: "HEALTHY", evidenceId: "health-1" },
    positionAccountReconciliation: { matches: true, evidenceId: "reconcile-1" },
    policy,
    executionAuthority: "NONE",
    ...overrides,
  };
}

test("complete paper-account evidence passes every global risk veto before sizing", () => {
  const result = buildAdaptiveMultiEvidenceGlobalRiskV2(input());
  assert.equal(result.status, "GLOBAL_RISK_PASS");
  assert.equal(result.decision, "BUY");
  assert.equal(result.checks.every((item) => item.state === "PASS"), true);
  assert.equal(result.riskBudget.approved, 800);
  assert.equal(result.riskBudget.quantityDerived, false);
  assert.equal(result.globalRiskGate.state, "PASS");
});

test("daily and consecutive loss policies veto strategy output", () => {
  const result = buildAdaptiveMultiEvidenceGlobalRiskV2(input({
    accountSnapshot: account({ dailyNetPnl: -4_000, consecutiveLosses: 3 }),
  }));
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.decision, "NO_TRADE");
  assert.ok(result.reasons.includes("DAILY_LOSS_LIMIT_EXCEEDED"));
  assert.ok(result.reasons.includes("CONSECUTIVE_LOSS_LIMIT_REACHED"));
  assert.equal(result.riskBudget.approved, 0);
});

test("missing sector evidence is blocked rather than converted to zero exposure", () => {
  const missing = account();
  delete missing.sectorExposure;
  const result = buildAdaptiveMultiEvidenceGlobalRiskV2(input({ accountSnapshot: missing }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.decision, "BLOCKED");
});

test("crypto futures requires funding, basis, OI, position tier, and liquidation evidence", () => {
  const missing = buildAdaptiveMultiEvidenceGlobalRiskV2(input({
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    costLiquidity: costLiquidity({ decision: "LONG", cost: { ...costLiquidity().cost,
      market: "CRYPTO_FUTURES", symbol: "BTCUSDT" } }),
    derivativesEvidence: null,
  }));
  assert.equal(missing.decision, "NO_TRADE");
  assert.ok(missing.reasons.includes("DERIVATIVES_EVIDENCE_UNKNOWN"));

  const available = buildAdaptiveMultiEvidenceGlobalRiskV2(input({
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    costLiquidity: costLiquidity({ decision: "LONG", cost: { ...costLiquidity().cost,
      market: "CRYPTO_FUTURES", symbol: "BTCUSDT" } }),
    accountSnapshot: account({ accountLeverage: 1.5 }),
    policy: { ...policy, maximumAccountLeverage: 2 },
    derivativesEvidence: {
      market: "CRYPTO_FUTURES",
      symbol: "BTCUSDT",
      fundingBps: 1,
      basisBps: 3,
      openInterest: 1_000_000,
      positionTier: "TIER_1",
      liquidationDistancePct: 0.3,
      observedAt: Date.parse(NOW) - 1000,
      sourceId: "public-derivatives",
      sourceDigest: "b".repeat(64),
      publicMarketData: true,
      privateApiUsed: false,
    },
  }));
  assert.equal(available.status, "GLOBAL_RISK_PASS");
  assert.equal(available.derivatives.directionalAuthority, false);
});

test("provider outage, stale state, or account mismatch vetoes", () => {
  const outage = buildAdaptiveMultiEvidenceGlobalRiskV2(input({
    providerHealth: { status: "OUTAGE", publicOnly: true, privateApiUsed: false },
    positionAccountReconciliation: { matches: false, evidenceId: "mismatch" },
  }));
  assert.equal(outage.decision, "NO_TRADE");
  assert.ok(outage.reasons.includes("PROVIDER_OUTAGE_OR_PRIVATE_ACCESS"));
  assert.ok(outage.reasons.includes("POSITION_ACCOUNT_MISMATCH"));

  const stale = buildAdaptiveMultiEvidenceGlobalRiskV2(input({
    accountSnapshot: account({ observedAt: Date.parse(NOW) - 120_000 }),
  }));
  assert.equal(stale.status, "BLOCKED_DATA");
});

test("global risk has veto authority but no execution authority", () => {
  const result = buildAdaptiveMultiEvidenceGlobalRiskV2(input({ executionAuthority: "PAPER" }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.vetoAuthority, true);
  assert.equal(result.strategyCanOverrideVeto, false);
  assert.equal(result.aiCanOverrideVeto, false);
  assert.equal(result.liveTrading, false);
  assert.equal(result.autoTrading, false);
  assert.equal(result.realOrderEnabled, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
});

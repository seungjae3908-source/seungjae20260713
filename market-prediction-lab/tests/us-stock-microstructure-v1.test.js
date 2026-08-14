import test from "node:test";
import assert from "node:assert/strict";
import { buildFourMarketExecutionContext } from "../src/four-market-execution-v2.js";
import {
  US_STOCK_MICROSTRUCTURE_ADAPTER,
  buildUsStockMicrostructureContext,
  compareUsStockMicrostructureParity,
  simulateUsStockMicrostructureFill,
} from "../src/us-stock-microstructure-v1.js";

const NOW = Date.parse("2026-08-15T00:00:00.000Z");
const SHA = "a".repeat(40);

function coreQuote() {
  return {
    available: true,
    bid: 100,
    ask: 100.02,
    last: 100.01,
    asOfMs: NOW - 500,
    maxAgeMs: 5_000,
  };
}

function baseExecutionContext({
  stage = "PAPER",
  timeframe = "5m",
  fillModel = "TOP_OF_BOOK",
  allowPartialFill = true,
  sessionKind = "REGULAR",
} = {}) {
  return buildFourMarketExecutionContext({
    market: "US_STOCK",
    stage,
    style: "SCALPING",
    timeframe,
    horizon: 3,
    direction: "BUY",
    marketAdapterIdentity: { id: "us-stock-toss-execution", version: "v2" },
    strategyIdentity: {
      strategyId: "us-scalp-fixture",
      strategyVersion: "v1",
      parameterHash: "fixture-params",
      researchCodeSha: SHA,
    },
    costPolicy: {
      version: "cost-v1",
      commissionRate: 0.001,
      taxRate: 0,
      spreadRate: 0,
      slippageRate: 0,
      latencyRate: 0,
      liquidityImpactRate: 0,
      partialFillImpactRate: 0,
      fundingRate: 0,
    },
    executionPolicy: {
      version: "exec-v1",
      fillModel,
      sameBarPolicy: "STOP_FIRST",
      allowPartialFill,
      maxParticipationRate: 0.5,
      nextBarOnly: true,
    },
    dataEvidence: {
      provider: "toss",
      publicOnly: true,
      dataQuality: "READY",
      provenance: "fixture-public-us-stock",
      asOfMs: NOW - 1_000,
      closedDataOnly: true,
      tickSize: 0.01,
      taxPolicyKnown: true,
      session: { version: "us-session-v1", status: "OPEN", kind: sessionKind },
      corporateActionAdjusted: true,
      quoteEvidence: coreQuote(),
      extendedHoursEvidenceReady: true,
    },
    evaluatedAtMs: NOW,
  });
}

function policy(overrides = {}) {
  return {
    version: "us-micro-v1",
    quoteSourcePolicyVersion: "verified-source-v1",
    premarketMaxParticipationRate: 0.01,
    regularMaxParticipationRate: 0.05,
    afterHoursMaxParticipationRate: 0.005,
    auctionMaxParticipationRate: 0.02,
    premarketMaxSpreadRate: 0.01,
    regularMaxSpreadRate: 0.005,
    afterHoursMaxSpreadRate: 0.015,
    ...overrides,
  };
}

function microEvidence(phase = "REGULAR", overrides = {}) {
  const continuous = ["PREMARKET", "REGULAR", "AFTER_HOURS"].includes(phase);
  const base = {
    provider: "toss",
    publicOnly: true,
    dataQuality: "READY",
    tradingStatus: "TRADABLE",
    session: { phase, version: "us-micro-session-v1" },
    asOfMs: NOW - 500,
    maxAgeMs: 5_000,
    haltEvidence: { known: true, active: false },
    extendedHoursEligible: true,
  };
  if (continuous) {
    base.quoteEvidence = {
      available: true,
      sourceVerified: true,
      source: "validated-us-top-of-book",
      bid: 100,
      ask: 100.02,
      last: 100.01,
      asOfMs: NOW - 500,
      maxAgeMs: 5_000,
      extendedHoursVerified: true,
    };
    base.observedVolume = 1_000;
    base.observedVolumeEvidenceReady = true;
  } else {
    base.auctionEvidence = {
      available: true,
      sourceVerified: true,
      source: "validated-us-auction",
      phase,
      indicativePrice: 100.05,
      executableQuantity: 200,
      asOfMs: NOW - 200,
      maxAgeMs: 5_000,
    };
  }
  return { ...base, ...overrides };
}

function microContext({
  stage = "PAPER",
  phase = "REGULAR",
  timeframe = "5m",
  allowPartialFill = true,
  microPolicy = policy(),
  evidence = microEvidence(phase),
} = {}) {
  const sessionKind = phase === "PREMARKET" ? "PREMARKET" : phase === "AFTER_HOURS" ? "AFTER_HOURS" : "REGULAR";
  return buildUsStockMicrostructureContext({
    executionContext: baseExecutionContext({ stage, timeframe, allowPartialFill, sessionKind }),
    phase,
    policy: microPolicy,
    evidence,
    evaluatedAtMs: NOW,
  });
}

test("US regular session context is ready and safety remains simulation-only", () => {
  const context = microContext();
  assert.equal(context.status, "READY");
  assert.equal(context.provider, "toss");
  assert.deepEqual(context.safety, {
    simulationOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    privateTradingRequestAllowed: false,
    orderSubmissionAllowed: false,
    branchWriteAllowed: false,
    productionMutationAllowed: false,
  });
  assert.equal(US_STOCK_MICROSTRUCTURE_ADAPTER.market, "US_STOCK");
});

test("premarket and after-hours require explicit extended-hours eligibility and quote verification", () => {
  for (const phase of ["PREMARKET", "AFTER_HOURS"]) {
    const evidence = microEvidence(phase);
    evidence.extendedHoursEligible = false;
    evidence.quoteEvidence = { ...evidence.quoteEvidence, extendedHoursVerified: false };
    const context = microContext({ phase, evidence });
    assert.equal(context.status, "BLOCKED");
    assert.ok(context.blockers.includes("US_EXTENDED_HOURS_NOT_ELIGIBLE"));
    assert.ok(context.blockers.includes("US_EXTENDED_HOURS_QUOTE_NOT_VERIFIED"));
  }
});

test("stale, future, crossed, and unverified continuous quotes fail closed", () => {
  const stale = microEvidence("REGULAR");
  stale.quoteEvidence = { ...stale.quoteEvidence, asOfMs: NOW - 10_000, maxAgeMs: 1_000 };
  assert.ok(microContext({ evidence: stale }).blockers.includes("US_QUOTE_STALE_FORBIDDEN"));

  const future = microEvidence("REGULAR");
  future.quoteEvidence = { ...future.quoteEvidence, asOfMs: NOW + 1 };
  assert.ok(microContext({ evidence: future }).blockers.includes("US_QUOTE_FUTURE_FORBIDDEN"));

  const crossed = microEvidence("REGULAR");
  crossed.quoteEvidence = { ...crossed.quoteEvidence, bid: 101, ask: 100 };
  assert.ok(microContext({ evidence: crossed }).blockers.includes("US_CROSSED_QUOTE_FORBIDDEN"));

  const unverified = microEvidence("REGULAR");
  unverified.quoteEvidence = { ...unverified.quoteEvidence, sourceVerified: false };
  assert.ok(microContext({ evidence: unverified }).blockers.includes("US_QUOTE_SOURCE_NOT_VERIFIED"));
});

test("session-specific caller-supplied spread cap blocks overly wide quote", () => {
  const evidence = microEvidence("REGULAR");
  evidence.quoteEvidence = { ...evidence.quoteEvidence, bid: 100, ask: 101 };
  const context = microContext({ evidence, microPolicy: policy({ regularMaxSpreadRate: 0.005 }) });
  assert.equal(context.status, "BLOCKED");
  assert.ok(context.blockers.includes("US_SESSION_SPREAD_TOO_WIDE"));
});

test("known active trading halt blocks simulation without inventing halt thresholds", () => {
  const evidence = microEvidence("REGULAR");
  evidence.haltEvidence = { known: true, active: true, reason: "caller-evidenced-halt" };
  const context = microContext({ evidence });
  assert.equal(context.status, "BLOCKED");
  assert.ok(context.blockers.includes("US_TRADING_HALT_ACTIVE"));
});

test("regular-session volume participation cap creates bounded partial fill", () => {
  const evidence = microEvidence("REGULAR", { observedVolume: 100 });
  const context = microContext({ evidence });
  const fill = simulateUsStockMicrostructureFill({
    context,
    order: { type: "MARKET", quantity: 10, direction: "BUY" },
  });
  assert.equal(fill.status, "PARTIALLY_FILLED");
  assert.equal(fill.filledQuantity, 5);
  assert.equal(fill.unfilledQuantity, 5);
  assert.equal(fill.microstructurePartial, true);
  assert.equal(fill.orderSubmitted, false);
  assert.equal(fill.exchangeRequestSent, false);
});

test("capacity shortfall remains pending when partial fills are disabled", () => {
  const evidence = microEvidence("REGULAR", { observedVolume: 100 });
  const context = microContext({ evidence, allowPartialFill: false });
  const fill = simulateUsStockMicrostructureFill({
    context,
    order: { type: "MARKET", quantity: 10, direction: "BUY" },
  });
  assert.equal(fill.status, "PENDING");
  assert.equal(fill.reason, "US_PARTIAL_FILL_FORBIDDEN");
  assert.equal(fill.orderSubmitted, false);
});

test("premarket and after-hours use their own participation caps", () => {
  const pre = microContext({ phase: "PREMARKET", evidence: microEvidence("PREMARKET", { observedVolume: 1_000 }) });
  const after = microContext({ phase: "AFTER_HOURS", evidence: microEvidence("AFTER_HOURS", { observedVolume: 1_000 }) });
  const preFill = simulateUsStockMicrostructureFill({ context: pre, order: { type: "MARKET", quantity: 20, direction: "BUY" } });
  const afterFill = simulateUsStockMicrostructureFill({ context: after, order: { type: "MARKET", quantity: 20, direction: "BUY" } });
  assert.equal(preFill.filledQuantity, 10);
  assert.equal(afterFill.filledQuantity, 5);
});

test("opening auction uses verified single-price evidence and executable quantity cap", () => {
  const context = microContext({ phase: "OPENING_AUCTION", evidence: microEvidence("OPENING_AUCTION") });
  assert.equal(context.status, "READY");
  const fill = simulateUsStockMicrostructureFill({
    context,
    order: { type: "MARKET", quantity: 10, direction: "BUY" },
  });
  assert.equal(fill.status, "PARTIALLY_FILLED");
  assert.equal(fill.filledQuantity, 4);
  assert.equal(fill.unfilledQuantity, 6);
  assert.equal(fill.fillPrice, 100.05);
});

test("STOP_MARKET is fail-closed during opening or closing auction", () => {
  for (const phase of ["OPENING_AUCTION", "CLOSING_AUCTION"]) {
    const context = microContext({ phase, evidence: microEvidence(phase) });
    const fill = simulateUsStockMicrostructureFill({
      context,
      order: { type: "STOP_MARKET", quantity: 1, stopPrice: 101, direction: "BUY" },
    });
    assert.equal(fill.status, "BLOCKED");
    assert.equal(fill.reason, "US_STOP_MARKET_FORBIDDEN_DURING_AUCTION");
  }
});

test("missing or future auction evidence blocks instead of fabricating an auction price", () => {
  const missing = microEvidence("OPENING_AUCTION");
  delete missing.auctionEvidence;
  assert.ok(microContext({ phase: "OPENING_AUCTION", evidence: missing }).blockers.includes("US_AUCTION_EVIDENCE_REQUIRED"));

  const future = microEvidence("OPENING_AUCTION");
  future.auctionEvidence = { ...future.auctionEvidence, asOfMs: NOW + 1 };
  assert.ok(microContext({ phase: "OPENING_AUCTION", evidence: future }).blockers.includes("US_AUCTION_FUTURE_FORBIDDEN"));
});

test("identical Backtest Shadow Paper policies remain directly comparable", () => {
  const contexts = ["BACKTEST", "SHADOW", "PAPER"].map((stage) => microContext({ stage }));
  const parity = compareUsStockMicrostructureParity(contexts);
  assert.equal(parity.status, "READY");
  assert.equal(parity.backtestPaperShadowComparable, true);
  assert.equal(parity.livePromotionAllowed, false);
});

test("microstructure policy drift blocks Backtest Shadow Paper comparison", () => {
  const backtest = microContext({ stage: "BACKTEST" });
  const paper = microContext({ stage: "PAPER", microPolicy: policy({ regularMaxSpreadRate: 0.006 }) });
  const parity = compareUsStockMicrostructureParity([backtest, paper]);
  assert.equal(parity.status, "PERFORMANCE_COMPARISON_BLOCKED");
  assert.equal(parity.reason, "US_MICROSTRUCTURE_POLICY_MISMATCH");
  assert.equal(parity.backtestPaperShadowComparable, false);
});

test("core timeframe drift is still blocked by shared execution parity", () => {
  const backtest = microContext({ stage: "BACKTEST", timeframe: "5m" });
  const paper = microContext({ stage: "PAPER", timeframe: "1h" });
  const parity = compareUsStockMicrostructureParity([backtest, paper]);
  assert.equal(parity.status, "PERFORMANCE_COMPARISON_BLOCKED");
  assert.equal(parity.coreParity.backtestPaperShadowComparable, false);
  assert.ok(parity.coreParity.mismatchFields.includes("timeframe"));
});

test("adapter rejects non-US execution context", () => {
  const us = baseExecutionContext();
  const notUs = { ...us, market: "KR_STOCK" };
  assert.throws(
    () => buildUsStockMicrostructureContext({ executionContext: notUs, phase: "REGULAR", policy: policy(), evidence: microEvidence(), evaluatedAtMs: NOW }),
    /US_STOCK_EXECUTION_CONTEXT_REQUIRED/,
  );
});

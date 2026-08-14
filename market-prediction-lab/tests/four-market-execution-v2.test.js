import test from "node:test";
import assert from "node:assert/strict";
import {
  FOUR_MARKET_EXECUTION_PROFILES,
  buildFourMarketExecutionContext,
  compareExecutionStageParity,
  simulateFourMarketFill,
} from "../src/four-market-execution-v2.js";

const SHA = "a".repeat(40);
const NOW = Date.parse("2026-08-14T06:00:00.000Z");

function strategyIdentity(overrides = {}) {
  return {
    strategyId: "test-strategy",
    strategyVersion: "v2",
    parameterHash: "params-001",
    researchCodeSha: SHA,
    ...overrides,
  };
}

function costPolicy(overrides = {}) {
  return {
    version: "cost-v2",
    commissionRate: 0.001,
    taxRate: 0,
    spreadRate: 0.002,
    slippageRate: 0.001,
    latencyRate: 0.0005,
    liquidityImpactRate: 0.0005,
    partialFillImpactRate: 0.0002,
    fundingRate: 0,
    ...overrides,
  };
}

function executionPolicy(overrides = {}) {
  return {
    version: "execution-v2",
    fillModel: "TOP_OF_BOOK",
    sameBarPolicy: "STOP_FIRST",
    allowPartialFill: true,
    maxParticipationRate: 0.2,
    nextBarOnly: true,
    ...overrides,
  };
}

function commonEvidence(provider, overrides = {}) {
  return {
    provider,
    publicOnly: true,
    dataQuality: "READY",
    provenance: "immutable-public-fixture",
    asOfMs: NOW - 1_000,
    closedDataOnly: true,
    quoteEvidence: {
      available: true,
      bid: 99,
      ask: 101,
    },
    ...overrides,
  };
}

function spotEvidence(overrides = {}) {
  return commonEvidence("upbit", {
    marketStatus: "TRADABLE",
    tickSize: 1,
    minOrderNotional: 5_000,
    ...overrides,
  });
}

function futuresEvidence(overrides = {}) {
  return commonEvidence("bitget", {
    contractStatus: "TRADABLE",
    tickSize: 0.1,
    minQty: 0.001,
    qtyStep: 0.001,
    markPrice: 100,
    indexPrice: 100.2,
    fundingRate: 0.0001,
    openInterest: 1_000_000,
    leverage: 3,
    maxLeverage: 20,
    marginMode: "ISOLATED",
    liquidationDistancePct: 12,
    ...overrides,
  });
}

function stockEvidence(provider, overrides = {}) {
  return commonEvidence(provider, {
    tickSize: 1,
    taxPolicyKnown: true,
    corporateActionAdjusted: true,
    session: { version: "session-v1", status: "OPEN", kind: "REGULAR" },
    ...overrides,
  });
}

function build(overrides = {}) {
  return buildFourMarketExecutionContext({
    market: "CRYPTO_SPOT",
    stage: "BACKTEST",
    style: "SWING",
    direction: "BUY",
    strategyIdentity: strategyIdentity(),
    costPolicy: costPolicy(),
    executionPolicy: executionPolicy(),
    dataEvidence: spotEvidence(),
    evaluatedAtMs: NOW,
    ...overrides,
  });
}

test("fixed four-market profiles preserve provider and direction authority", () => {
  assert.equal(FOUR_MARKET_EXECUTION_PROFILES.KR_STOCK.provider, "toss");
  assert.deepEqual(FOUR_MARKET_EXECUTION_PROFILES.KR_STOCK.directions, ["BUY", "SELL_EXIT"]);
  assert.equal(FOUR_MARKET_EXECUTION_PROFILES.US_STOCK.provider, "toss");
  assert.equal(FOUR_MARKET_EXECUTION_PROFILES.CRYPTO_SPOT.provider, "upbit");
  assert.deepEqual(FOUR_MARKET_EXECUTION_PROFILES.CRYPTO_FUTURES.directions, ["LONG", "SHORT"]);
  assert.equal(FOUR_MARKET_EXECUTION_PROFILES.CRYPTO_FUTURES.provider, "bitget");
});

test("KR stock backtest requires explicit session, tax, corporate action and VI evidence", () => {
  const ready = build({
    market: "KR_STOCK",
    style: "SCALPING",
    direction: "BUY",
    executionPolicy: executionPolicy({ fillModel: "BAR_PROXY" }),
    dataEvidence: stockEvidence("toss", {
      session: { version: "kr-session-v1", status: "CLOSED", kind: "REGULAR" },
      volatilityInterruptionKnown: true,
      volatilityInterruptionActive: false,
    }),
  });
  assert.equal(ready.status, "READY");

  const blocked = build({
    market: "KR_STOCK",
    stage: "SHADOW",
    style: "SCALPING",
    direction: "BUY",
    dataEvidence: stockEvidence("toss", {
      volatilityInterruptionKnown: true,
      volatilityInterruptionActive: true,
    }),
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(blocked.blockers.includes("KR_VOLATILITY_INTERRUPTION_ACTIVE"));
});

test("US extended-hours research fails closed without explicit extended-hours evidence", () => {
  const blocked = build({
    market: "US_STOCK",
    stage: "SHADOW",
    direction: "BUY",
    dataEvidence: stockEvidence("toss", {
      session: { version: "us-session-v1", status: "OPEN", kind: "PREMARKET" },
      extendedHoursEvidenceReady: false,
    }),
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(blocked.blockers.includes("US_EXTENDED_HOURS_EVIDENCE_REQUIRED"));
});

test("cash markets reject opening short directions", () => {
  const spot = build({ market: "CRYPTO_SPOT", direction: "SHORT" });
  assert.equal(spot.status, "BLOCKED");
  assert.ok(spot.blockers.includes("DIRECTION_NOT_SUPPORTED"));

  const kr = build({
    market: "KR_STOCK",
    direction: "SHORT",
    executionPolicy: executionPolicy({ fillModel: "BAR_PROXY" }),
    dataEvidence: stockEvidence("toss", {
      volatilityInterruptionKnown: true,
      volatilityInterruptionActive: false,
    }),
  });
  assert.equal(kr.status, "BLOCKED");
  assert.ok(kr.blockers.includes("DIRECTION_NOT_SUPPORTED"));
});

test("Bitget futures requires mark, funding, OI, leverage, margin and liquidation evidence", () => {
  const blocked = build({
    market: "CRYPTO_FUTURES",
    direction: "LONG",
    dataEvidence: futuresEvidence({ fundingRate: undefined, liquidationDistancePct: 0 }),
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(blocked.blockers.includes("BITGET_FUNDING_RATE_REQUIRED"));
  assert.ok(blocked.blockers.includes("BITGET_LIQUIDATION_DISTANCE_REQUIRED"));

  const ready = build({
    market: "CRYPTO_FUTURES",
    direction: "SHORT",
    costPolicy: costPolicy({ fundingRate: 0.0001 }),
    dataEvidence: futuresEvidence(),
  });
  assert.equal(ready.status, "READY");
  assert.equal(ready.safety.orderSubmissionAllowed, false);
  assert.equal(ready.safety.privateTradingRequestAllowed, false);
});

test("Backtest Shadow and Paper are comparable only under one identical execution contract", () => {
  const shared = {
    market: "CRYPTO_SPOT",
    style: "SWING",
    direction: "BUY",
    strategyIdentity: strategyIdentity(),
    costPolicy: costPolicy(),
    executionPolicy: executionPolicy(),
    evaluatedAtMs: NOW,
  };
  const backtest = buildFourMarketExecutionContext({ ...shared, stage: "BACKTEST", dataEvidence: spotEvidence() });
  const shadow = buildFourMarketExecutionContext({ ...shared, stage: "SHADOW", dataEvidence: spotEvidence() });
  const paper = buildFourMarketExecutionContext({ ...shared, stage: "PAPER", dataEvidence: spotEvidence() });
  const parity = compareExecutionStageParity([backtest, shadow, paper]);
  assert.equal(parity.status, "READY");
  assert.equal(parity.backtestPaperShadowComparable, true);
  assert.equal(backtest.parityFingerprint, shadow.parityFingerprint);
  assert.equal(shadow.parityFingerprint, paper.parityFingerprint);
});

test("policy drift between research stages is detected instead of silently comparing results", () => {
  const backtest = build({ stage: "BACKTEST" });
  const paper = build({ stage: "PAPER", costPolicy: costPolicy({ version: "cost-v3", slippageRate: 0.002 }) });
  const parity = compareExecutionStageParity([backtest, paper]);
  assert.equal(parity.status, "BLOCKED");
  assert.deepEqual(parity.mismatchedStages, ["PAPER"]);
  assert.equal(parity.backtestPaperShadowComparable, false);
});

test("bar-proxy market fills use next-bar price and explicit adverse costs", () => {
  const context = build({ executionPolicy: executionPolicy({ fillModel: "BAR_PROXY" }) });
  assert.equal(context.status, "READY");
  const fill = simulateFourMarketFill({
    context,
    order: { type: "MARKET", direction: "BUY", quantity: 2 },
    bar: { nextOpen: 100, high: 103, low: 98 },
  });
  assert.equal(fill.status, "FILLED");
  assert.ok(fill.fillPrice > 100);
  assert.equal(fill.requestedQuantity, 2);
  assert.equal(fill.filledQuantity, 2);
  assert.ok(fill.costs.immediateCost > 0);
  assert.equal(fill.orderSubmitted, false);
  assert.equal(fill.exchangeRequestSent, false);
});

test("bar-proxy limit orders stay pending when the price is never touched", () => {
  const context = build({ executionPolicy: executionPolicy({ fillModel: "BAR_PROXY" }) });
  const fill = simulateFourMarketFill({
    context,
    order: { type: "LIMIT", direction: "BUY", quantity: 1, limitPrice: 95 },
    bar: { nextOpen: 100, high: 102, low: 98 },
  });
  assert.equal(fill.status, "PENDING");
  assert.equal(fill.reason, "LIMIT_NOT_TOUCHED");
  assert.equal(fill.orderSubmitted, false);
});

test("depth-participation simulation models bounded partial fills without exchange requests", () => {
  const context = build({
    stage: "PAPER",
    executionPolicy: executionPolicy({ fillModel: "DEPTH_PARTICIPATION", maxParticipationRate: 0.25, allowPartialFill: true }),
    dataEvidence: spotEvidence({
      depthEvidence: { available: true, bidSize: 20, askSize: 8 },
    }),
  });
  assert.equal(context.status, "READY");
  const fill = simulateFourMarketFill({
    context,
    order: { type: "MARKET", direction: "BUY", quantity: 5 },
    quote: { bid: 99, ask: 101 },
    depth: { bidSize: 20, askSize: 8 },
  });
  assert.equal(fill.status, "PARTIALLY_FILLED");
  assert.equal(fill.filledQuantity, 2);
  assert.equal(fill.unfilledQuantity, 3);
  assert.ok(fill.costs.partialFillImpact > 0);
  assert.equal(fill.privateTradingRequestSent, false);
  assert.equal(fill.liveExecution, false);
});

test("a blocked research context cannot be used to fabricate a simulated fill", () => {
  const blocked = build({ dataEvidence: spotEvidence({ dataQuality: "UNAVAILABLE" }) });
  const fill = simulateFourMarketFill({
    context: blocked,
    order: { type: "MARKET", direction: "BUY", quantity: 1 },
    quote: { bid: 99, ask: 101 },
  });
  assert.equal(fill.status, "BLOCKED");
  assert.equal(fill.reason, "EXECUTION_CONTEXT_NOT_READY");
  assert.ok(fill.blockers.includes("DATA_QUALITY_NOT_READY"));
  assert.equal(fill.orderSubmitted, false);
});

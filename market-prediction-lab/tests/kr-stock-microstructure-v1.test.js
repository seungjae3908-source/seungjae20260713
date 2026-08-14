import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFourMarketExecutionContext,
} from "../src/four-market-execution-v2.js";
import {
  buildKrStockMicrostructureContext,
  compareKrStockMicrostructureParity,
  simulateKrStockMicrostructureFill,
} from "../src/kr-stock-microstructure-v1.js";

const NOW = Date.UTC(2026, 7, 14, 10, 0, 0);
const RESEARCH_SHA = "a".repeat(40);

function costPolicy(overrides = {}) {
  return {
    version: "kr-cost-v1",
    commissionRate: 0.00015,
    taxRate: 0.0018,
    spreadRate: 0.0002,
    slippageRate: 0.0003,
    latencyRate: 0.0001,
    liquidityImpactRate: 0.0002,
    partialFillImpactRate: 0.0001,
    fundingRate: 0,
    ...overrides,
  };
}

function executionPolicy(overrides = {}) {
  return {
    version: "exec-v2",
    fillModel: "BAR_PROXY",
    sameBarPolicy: "STOP_FIRST",
    allowPartialFill: true,
    maxParticipationRate: 0.25,
    nextBarOnly: true,
    ...overrides,
  };
}

function baseDataEvidence(overrides = {}) {
  return {
    provider: "toss",
    publicOnly: true,
    dataQuality: "READY",
    provenance: "kr-public-evidence-v1",
    asOfMs: NOW - 1_000,
    closedDataOnly: true,
    barProxyRealtimeAllowed: true,
    tickSize: 10,
    taxPolicyKnown: true,
    session: { version: "kr-session-v1", status: "OPEN" },
    corporateActionAdjusted: true,
    volatilityInterruptionKnown: true,
    volatilityInterruptionActive: false,
    ...overrides,
  };
}

function buildBase({ stage = "BACKTEST", style = "SCALPING", direction = "BUY", exec = {}, data = {} } = {}) {
  return buildFourMarketExecutionContext({
    market: "KR_STOCK",
    stage,
    style,
    timeframe: "15m",
    horizon: 4,
    direction,
    marketAdapterIdentity: { id: "kr-stock-toss-execution", version: "v2" },
    strategyIdentity: {
      strategyId: "kr-microstructure-test",
      strategyVersion: "v1",
      parameterHash: "params-v1",
      researchCodeSha: RESEARCH_SHA,
    },
    costPolicy: costPolicy(),
    executionPolicy: executionPolicy(exec),
    dataEvidence: baseDataEvidence(data),
    evaluatedAtMs: NOW,
  });
}

function policy(overrides = {}) {
  return {
    version: "kr-micro-v1",
    tickPolicyVersion: "tick-evidence-v1",
    priceLimitPolicyVersion: "price-limit-evidence-v1",
    auctionPolicyVersion: "auction-evidence-v1",
    viPolicyVersion: "vi-evidence-v1",
    volumeParticipationPolicyVersion: "volume-participation-v1",
    maxEvidenceAgeMs: 5_000,
    maxBarVolumeParticipationRate: 0.1,
    adverseTickRounding: true,
    auctionFillAllowed: true,
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    provider: "toss",
    tradingStatus: "TRADABLE",
    sessionPhase: "CONTINUOUS",
    asOfMs: NOW - 1_000,
    tickSize: 10,
    referencePrice: 10_000,
    lowerLimitPrice: 7_000,
    upperLimitPrice: 13_000,
    priceLimitEvidenceVersion: "price-limit-snapshot-v1",
    viState: "CLEAR",
    limitState: "NORMAL",
    volumeEvidence: {
      available: true,
      barVolume: 200,
      asOfMs: NOW - 1_000,
      maxAgeMs: 5_000,
    },
    ...overrides,
  };
}

function buildKr({ base = buildBase(), microPolicy = policy(), microEvidence = evidence() } = {}) {
  return buildKrStockMicrostructureContext({
    baseContext: base,
    microstructurePolicy: microPolicy,
    microstructureEvidence: microEvidence,
    evaluatedAtMs: NOW,
  });
}

test("valid continuous KR microstructure context is READY and keeps zero live authority", () => {
  const context = buildKr();
  assert.equal(context.status, "READY");
  assert.equal(context.market, "KR_STOCK");
  assert.match(context.microstructureFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(context.safety, {
    simulationOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    privateTradingRequestAllowed: false,
    orderSubmissionAllowed: false,
    branchWriteAllowed: false,
    productionMutationAllowed: false,
  });
});

test("stale KR microstructure and volume evidence fail closed", () => {
  const context = buildKr({
    microEvidence: evidence({
      asOfMs: NOW - 20_000,
      volumeEvidence: { available: true, barVolume: 200, asOfMs: NOW - 20_000, maxAgeMs: 5_000 },
    }),
  });
  assert.equal(context.status, "BLOCKED");
  assert.ok(context.blockers.includes("KR_MICROSTRUCTURE_EVIDENCE_STALE_OR_FUTURE"));
  assert.ok(context.blockers.includes("KR_VOLUME_EVIDENCE_STALE_OR_FUTURE"));
});

test("invalid caller-provided price-limit evidence fails closed without hardcoded exchange limits", () => {
  const context = buildKr({
    microEvidence: evidence({ lowerLimitPrice: 10_500, upperLimitPrice: 11_000 }),
  });
  assert.equal(context.status, "BLOCKED");
  assert.ok(context.blockers.includes("KR_PRICE_LIMIT_RANGE_INVALID"));
});

test("active VI cannot execute as continuous trading", () => {
  const context = buildKr({
    microEvidence: evidence({ viState: "ACTIVE", sessionPhase: "CONTINUOUS" }),
  });
  assert.equal(context.status, "BLOCKED");
  assert.ok(context.blockers.includes("KR_VI_REQUIRES_VI_AUCTION_PHASE"));
});

test("fresh VI auction evidence is accepted for a SWING base context", () => {
  const base = buildBase({
    stage: "PAPER",
    style: "SWING",
    data: { volatilityInterruptionActive: true, closedDataOnly: false },
  });
  const context = buildKr({
    base,
    microEvidence: evidence({
      viState: "ACTIVE",
      sessionPhase: "VI_AUCTION",
      auctionEvidence: {
        available: true,
        indicativePrice: 10_020,
        executableQuantity: 30,
        asOfMs: NOW - 500,
        maxAgeMs: 2_000,
      },
    }),
  });
  assert.equal(base.status, "READY");
  assert.equal(context.status, "READY");
});

test("continuous BAR_PROXY fill rounds adversely to tick and caps by observed bar volume", () => {
  const context = buildKr();
  const fill = simulateKrStockMicrostructureFill({
    context,
    order: { type: "MARKET", quantity: 100, direction: "BUY" },
    bar: { nextOpen: 10_005, high: 10_100, low: 9_900 },
  });
  assert.equal(fill.status, "PARTIALLY_FILLED");
  assert.equal(fill.filledQuantity, 20);
  assert.equal(fill.unfilledQuantity, 80);
  assert.equal(fill.fillPrice % 10, 0);
  assert.ok(fill.fillPrice >= 10_005);
  assert.equal(fill.krMicrostructureApplied, true);
  assert.equal(fill.orderSubmitted, false);
  assert.equal(fill.exchangeRequestSent, false);
});

test("volume-limited partial fill becomes PENDING when partial fills are forbidden", () => {
  const base = buildBase({ exec: { allowPartialFill: false } });
  const context = buildKr({ base });
  const fill = simulateKrStockMicrostructureFill({
    context,
    order: { type: "MARKET", quantity: 100, direction: "BUY" },
    bar: { nextOpen: 10_000, high: 10_100, low: 9_900 },
  });
  assert.equal(fill.status, "PENDING");
  assert.equal(fill.reason, "KR_PARTIAL_FILL_FORBIDDEN");
});

test("limit-lock evidence caps simulated executable quantity instead of fabricating liquidity", () => {
  const context = buildKr({
    microEvidence: evidence({ limitState: "UPPER_LOCKED", limitExecutableQuantity: 5 }),
  });
  const fill = simulateKrStockMicrostructureFill({
    context,
    order: { type: "MARKET", quantity: 50, direction: "BUY" },
    bar: { nextOpen: 12_900, high: 13_000, low: 12_850 },
  });
  assert.equal(fill.status, "PARTIALLY_FILLED");
  assert.equal(fill.filledQuantity, 5);
  assert.equal(fill.unfilledQuantity, 45);
});

test("auction uses explicit single-price evidence and executable quantity only", () => {
  const base = buildBase({
    stage: "PAPER",
    style: "SWING",
    data: { volatilityInterruptionActive: true, closedDataOnly: false },
  });
  const context = buildKr({
    base,
    microEvidence: evidence({
      viState: "ACTIVE",
      sessionPhase: "VI_AUCTION",
      volumeEvidence: { available: true, barVolume: 1_000, asOfMs: NOW - 500, maxAgeMs: 2_000 },
      auctionEvidence: {
        available: true,
        indicativePrice: 10_020,
        executableQuantity: 30,
        asOfMs: NOW - 500,
        maxAgeMs: 2_000,
      },
    }),
  });
  const fill = simulateKrStockMicrostructureFill({
    context,
    order: { type: "MARKET", quantity: 50, direction: "BUY" },
  });
  assert.equal(fill.status, "PARTIALLY_FILLED");
  assert.equal(fill.fillModel, "KR_AUCTION_SINGLE_PRICE");
  assert.equal(fill.filledQuantity, 30);
  assert.equal(fill.unfilledQuantity, 20);
  assert.equal(fill.fillPrice % 10, 0);
});

test("STOP_MARKET is fail-closed during auction phase", () => {
  const base = buildBase({
    stage: "PAPER",
    style: "SWING",
    data: { volatilityInterruptionActive: true, closedDataOnly: false },
  });
  const context = buildKr({
    base,
    microEvidence: evidence({
      viState: "ACTIVE",
      sessionPhase: "VI_AUCTION",
      auctionEvidence: {
        available: true,
        indicativePrice: 10_020,
        executableQuantity: 30,
        asOfMs: NOW - 500,
        maxAgeMs: 2_000,
      },
    }),
  });
  const fill = simulateKrStockMicrostructureFill({
    context,
    order: { type: "STOP_MARKET", quantity: 10, direction: "BUY", stopPrice: 10_030 },
  });
  assert.equal(fill.status, "BLOCKED");
  assert.equal(fill.reason, "KR_STOP_MARKET_AUCTION_UNSUPPORTED");
});

test("non-tick-aligned and out-of-limit order prices fail closed", () => {
  const context = buildKr();
  const misaligned = simulateKrStockMicrostructureFill({
    context,
    order: { type: "LIMIT", quantity: 10, direction: "BUY", limitPrice: 10_003 },
    bar: { nextOpen: 10_000, high: 10_100, low: 9_900 },
  });
  assert.equal(misaligned.status, "BLOCKED");
  assert.equal(misaligned.reason, "KR_ORDER_PRICE_NOT_TICK_ALIGNED");

  const outside = simulateKrStockMicrostructureFill({
    context,
    order: { type: "LIMIT", quantity: 10, direction: "BUY", limitPrice: 13_010 },
    bar: { nextOpen: 10_000, high: 13_100, low: 9_900 },
  });
  assert.equal(outside.status, "BLOCKED");
  assert.equal(outside.reason, "KR_ORDER_PRICE_OUTSIDE_LIMITS");
});

test("microstructure policy drift blocks Backtest/Paper direct comparison", () => {
  const backtest = buildKr({ base: buildBase({ stage: "BACKTEST" }) });
  const paper = buildKr({
    base: buildBase({ stage: "PAPER", data: { closedDataOnly: false } }),
    microPolicy: policy({ volumeParticipationPolicyVersion: "volume-participation-v2" }),
  });
  const comparison = compareKrStockMicrostructureParity([backtest, paper]);
  assert.equal(backtest.status, "READY");
  assert.equal(paper.status, "READY");
  assert.equal(comparison.status, "PERFORMANCE_COMPARISON_BLOCKED");
  assert.equal(comparison.reason, "KR_MICROSTRUCTURE_POLICY_MISMATCH");
  assert.ok(comparison.mismatchFields.includes("volumeParticipationPolicyVersion"));
  assert.equal(comparison.backtestPaperShadowComparable, false);
});

test("identical KR microstructure policy across Backtest/Shadow/Paper is comparable", () => {
  const contexts = ["BACKTEST", "SHADOW", "PAPER"].map((stage) => buildKr({
    base: buildBase({ stage, data: stage === "BACKTEST" ? {} : { closedDataOnly: false } }),
  }));
  const comparison = compareKrStockMicrostructureParity(contexts);
  assert.ok(contexts.every((context) => context.status === "READY"));
  assert.equal(comparison.status, "READY");
  assert.equal(comparison.backtestPaperShadowComparable, true);
  assert.equal(comparison.livePromotionAllowed, false);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFourMarketPaperSample,
  dedupeFourMarketPaperSamples,
  normalizePaperExecutionDirection,
} from "../src/four-market-paper-sampler-v1.js";

const NOW = 1_800_000_000_000;
const RESEARCH_SHA = "a".repeat(40);

const adapterByMarket = Object.freeze({
  KR_STOCK: { id: "kr-stock-toss-execution", version: "v2" },
  US_STOCK: { id: "us-stock-toss-execution", version: "v2" },
  CRYPTO_SPOT: { id: "crypto-spot-upbit-execution", version: "v2" },
  CRYPTO_FUTURES: { id: "crypto-futures-bitget-execution", version: "v2" },
});

const providerByMarket = Object.freeze({
  KR_STOCK: "toss",
  US_STOCK: "toss",
  CRYPTO_SPOT: "upbit",
  CRYPTO_FUTURES: "bitget",
});

function signal(market, direction, overrides = {}) {
  return {
    signalId: `${market}-${direction}-001`,
    market,
    style: "SWING",
    timeframe: "1h",
    horizon: 12,
    direction,
    strategyIdentity: {
      strategyId: "profit-first-v2",
      strategyVersion: "v2",
      parameterHash: "params-001",
      researchCodeSha: RESEARCH_SHA,
    },
    ...overrides,
  };
}

function gate(decision = "ELIGIBLE", overrides = {}) {
  return {
    decision,
    eligible: decision === "ELIGIBLE",
    reasons: decision === "ELIGIBLE" ? [] : ["INSUFFICIENT_SAMPLE"],
    executionAuthority: "NONE",
    ...overrides,
  };
}

function evidence(market, overrides = {}) {
  return {
    status: "READY",
    market,
    expectedNetEdge: 0.8,
    expectedNetReturn: 1.2,
    riskRewardRatio: 1.8,
    sampleSize: 120,
    costPolicyId: `${market}-cost-v1`,
    executionAuthority: "NONE",
    ...overrides,
  };
}

function marketEvidence(market, overrides = {}) {
  const common = {
    provider: providerByMarket[market],
    publicOnly: true,
    dataQuality: "READY",
    provenance: `${market}-public-evidence-v1`,
    asOfMs: NOW - 1_000,
    barProxyRealtimeAllowed: true,
  };
  if (market === "KR_STOCK") return {
    ...common,
    tickSize: 1,
    taxPolicyKnown: true,
    session: { version: "kr-session-v1", status: "OPEN" },
    volatilityInterruptionKnown: true,
    volatilityInterruptionActive: false,
    ...overrides,
  };
  if (market === "US_STOCK") return {
    ...common,
    tickSize: 0.01,
    taxPolicyKnown: true,
    session: { version: "us-session-v1", status: "OPEN", kind: "REGULAR" },
    ...overrides,
  };
  if (market === "CRYPTO_SPOT") return {
    ...common,
    marketStatus: "TRADABLE",
    tickSize: 1,
    minOrderNotional: 5_000,
    ...overrides,
  };
  return {
    ...common,
    contractStatus: "TRADABLE",
    tickSize: 0.1,
    minQty: 0.001,
    qtyStep: 0.001,
    markPrice: 100,
    indexPrice: 100,
    fundingRate: 0.0001,
    openInterest: 100_000,
    leverage: 2,
    maxLeverage: 20,
    marginMode: "ISOLATED",
    liquidationDistancePct: 30,
    ...overrides,
  };
}

function execution(market, overrides = {}) {
  return {
    marketAdapterIdentity: adapterByMarket[market],
    costPolicy: {
      version: `${market}-cost-v1`,
      commissionRate: 0.0005,
      taxRate: market.includes("STOCK") ? 0.001 : 0,
      spreadRate: 0.0004,
      slippageRate: 0.0005,
      latencyRate: 0.0001,
      liquidityImpactRate: 0.0002,
      partialFillImpactRate: 0.0001,
      fundingRate: market === "CRYPTO_FUTURES" ? 0.0001 : 0,
    },
    executionPolicy: {
      version: "paper-fill-v1",
      fillModel: "BAR_PROXY",
      sameBarPolicy: "STOP_FIRST",
      allowPartialFill: true,
      maxParticipationRate: 0.1,
      nextBarOnly: false,
    },
    dataEvidence: marketEvidence(market),
    ...overrides,
  };
}

const bar = { nextOpen: 100, high: 101, low: 99 };

for (const [market, direction] of [
  ["KR_STOCK", "BUY"],
  ["US_STOCK", "BUY"],
  ["CRYPTO_SPOT", "BUY"],
  ["CRYPTO_FUTURES", "LONG"],
  ["CRYPTO_FUTURES", "SHORT"],
]) {
  test(`eligible ${market} ${direction} creates simulation-only OPEN sample`, () => {
    const sample = buildFourMarketPaperSample({
      signal: signal(market, direction),
      profitGate: gate(),
      profitEvidence: evidence(market),
      execution: execution(market),
      order: { type: "MARKET", quantity: 1, direction },
      bar,
      evaluatedAtMs: NOW,
    });
    assert.equal(sample.status, "OPEN");
    assert.equal(sample.executionContextStatus, "READY");
    assert.equal(sample.fill.status, "FILLED");
    assert.equal(sample.fill.market, market);
    assert.equal(sample.fill.stage, "PAPER");
    assert.equal(sample.orderSubmitted, false);
    assert.equal(sample.exchangeRequestSent, false);
    assert.equal(sample.privateTradingApiAllowed, false);
    assert.equal(sample.liveOrderAllowed, false);
    assert.equal(sample.profitabilityClaimAllowed, false);
    assert.match(sample.paperSampleId, /^[0-9a-f]{64}$/);
  });
}

test("Profit-First SELL maps to SELL_EXIT but cannot create a fake standalone OPEN trade", () => {
  assert.equal(normalizePaperExecutionDirection("KR_STOCK", "SELL"), "SELL_EXIT");
  const sample = buildFourMarketPaperSample({
    signal: signal("KR_STOCK", "SELL"),
    profitGate: gate(),
    profitEvidence: evidence("KR_STOCK"),
    evaluatedAtMs: NOW,
  });
  assert.equal(sample.status, "BLOCKED");
  assert.equal(sample.identity.signalDirection, "SELL");
  assert.equal(sample.identity.executionDirection, "SELL_EXIT");
  assert.equal(sample.executionContextStatus, "NOT_REQUESTED");
  assert.equal(sample.fill, null);
  assert.deepEqual(sample.blockers, ["CASH_EXIT_REQUIRES_OPEN_POSITION"]);
  assert.equal(sample.orderSubmitted, false);
});

test("NO_TRADE is preserved without requesting an execution context", () => {
  const sample = buildFourMarketPaperSample({
    signal: signal("US_STOCK", "BUY"),
    profitGate: gate("NO_TRADE"),
    profitEvidence: evidence("US_STOCK", {
      status: "INSUFFICIENT_SAMPLE",
      expectedNetEdge: null,
      expectedNetReturn: null,
      riskRewardRatio: null,
      sampleSize: 4,
      costPolicyId: null,
    }),
    evaluatedAtMs: NOW,
  });
  assert.equal(sample.status, "NO_TRADE");
  assert.equal(sample.executionContextStatus, "NOT_REQUESTED");
  assert.equal(sample.fill, null);
  assert.deepEqual(sample.blockers, ["INSUFFICIENT_SAMPLE"]);
  assert.equal(sample.orderSubmitted, false);
});

test("ELIGIBLE cannot bypass not-ready or non-positive Profit-First evidence", () => {
  assert.throws(() => buildFourMarketPaperSample({
    signal: signal("CRYPTO_SPOT", "BUY"),
    profitGate: gate(),
    profitEvidence: evidence("CRYPTO_SPOT", { status: "INSUFFICIENT_SAMPLE" }),
    execution: execution("CRYPTO_SPOT"),
    order: { type: "MARKET", quantity: 1, direction: "BUY" },
    bar,
    evaluatedAtMs: NOW,
  }), /PAPER_ELIGIBLE_EVIDENCE_NOT_READY/);

  assert.throws(() => buildFourMarketPaperSample({
    signal: signal("CRYPTO_SPOT", "BUY"),
    profitGate: gate(),
    profitEvidence: evidence("CRYPTO_SPOT", { expectedNetEdge: 0 }),
    execution: execution("CRYPTO_SPOT"),
    order: { type: "MARKET", quantity: 1, direction: "BUY" },
    bar,
    evaluatedAtMs: NOW,
  }), /PAPER_ELIGIBLE_NET_EDGE_NON_POSITIVE/);
});

test("future execution evidence fails closed instead of creating a Paper fill", () => {
  const sample = buildFourMarketPaperSample({
    signal: signal("CRYPTO_FUTURES", "LONG"),
    profitGate: gate(),
    profitEvidence: evidence("CRYPTO_FUTURES"),
    execution: execution("CRYPTO_FUTURES", {
      dataEvidence: marketEvidence("CRYPTO_FUTURES", { asOfMs: NOW + 1 }),
    }),
    order: { type: "MARKET", quantity: 1, direction: "LONG" },
    bar,
    evaluatedAtMs: NOW,
  });
  assert.equal(sample.status, "BLOCKED");
  assert.ok(sample.blockers.includes("FUTURE_DATA_FORBIDDEN"));
  assert.equal(sample.fill, null);
  assert.equal(sample.orderSubmitted, false);
});

test("gate execution authority can never authorize Paper execution", () => {
  assert.throws(() => buildFourMarketPaperSample({
    signal: signal("KR_STOCK", "BUY"),
    profitGate: gate("ELIGIBLE", { executionAuthority: "LIVE" }),
    profitEvidence: evidence("KR_STOCK"),
    execution: execution("KR_STOCK"),
    order: { type: "MARKET", quantity: 1, direction: "BUY" },
    bar,
    evaluatedAtMs: NOW,
  }), /PAPER_GATE_EXECUTION_AUTHORITY_FORBIDDEN/);
});

test("paperSampleId is deterministic and conflicting duplicate ids fail closed", () => {
  const input = {
    signal: signal("US_STOCK", "BUY"),
    profitGate: gate(),
    profitEvidence: evidence("US_STOCK"),
    execution: execution("US_STOCK"),
    order: { type: "MARKET", quantity: 1, direction: "BUY" },
    bar,
    evaluatedAtMs: NOW,
  };
  const first = buildFourMarketPaperSample(input);
  const second = buildFourMarketPaperSample(input);
  assert.equal(first.paperSampleId, second.paperSampleId);
  assert.equal(dedupeFourMarketPaperSamples([first, second]).length, 1);

  const conflicting = structuredClone(first);
  conflicting.status = "BLOCKED";
  assert.throws(() => dedupeFourMarketPaperSamples([first, conflicting]), /PAPER_SAMPLE_ID_CONFLICT/);
});

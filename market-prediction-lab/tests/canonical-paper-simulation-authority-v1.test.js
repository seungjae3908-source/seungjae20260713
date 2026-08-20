import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_PAPER_EXECUTION_POLICY,
  CANONICAL_PAPER_SIMULATED_ORDER_POLICY,
  resolveCanonicalPaperSimulationAuthority,
} from "../src/canonical-paper-simulation-authority-v1.js";
import { buildFourMarketPaperSample } from "../src/four-market-paper-sampler-v1.js";

const NOW = 1_800_000_000_000;
const RESEARCH_SHA = "b".repeat(40);
const EVIDENCE_DIGEST = "a".repeat(64);

const PROVIDER_BY_MARKET = Object.freeze({
  KR_STOCK: "toss",
  US_STOCK: "toss",
  CRYPTO_SPOT: "upbit",
  CRYPTO_FUTURES: "bitget",
});

const SYMBOL_BY_MARKET = Object.freeze({
  KR_STOCK: "005930",
  US_STOCK: "AAPL",
  CRYPTO_SPOT: "KRW-BTC",
  CRYPTO_FUTURES: "BTCUSDT",
});

const ADAPTER_BY_MARKET = Object.freeze({
  KR_STOCK: "kr-stock-toss-execution",
  US_STOCK: "us-stock-toss-execution",
  CRYPTO_SPOT: "crypto-spot-upbit-execution",
  CRYPTO_FUTURES: "crypto-futures-bitget-execution",
});

function strategyIdentity() {
  return {
    strategyId: "canonical-paper-test",
    strategyVersion: "v1",
    parameterHash: "params-v1",
    researchCodeSha: RESEARCH_SHA,
    costPolicyVersion: "cost-v1",
  };
}

function costPolicy(market) {
  return {
    version: "cost-v1",
    commissionRate: 0.0005,
    taxRate: market.includes("STOCK") ? 0.001 : 0,
    spreadRate: 0.0004,
    slippageRate: 0.0005,
    latencyRate: 0.0001,
    liquidityImpactRate: 0.0002,
    partialFillImpactRate: 0.0001,
    fundingRate: market === "CRYPTO_FUTURES" ? 0.0001 : 0,
  };
}

function quote(overrides = {}) {
  return {
    available: true,
    bid: 99,
    ask: 101,
    asOfMs: NOW - 500,
    maxAgeMs: 5_000,
    ...overrides,
  };
}

function dataEvidence(market, overrides = {}) {
  const common = {
    provider: PROVIDER_BY_MARKET[market],
    provenance: `${market}-public-v1`,
    publicOnly: true,
    dataQuality: "READY",
    asOfMs: NOW - 1_000,
    maxAgeMs: 5_000,
    tickSize: market === "US_STOCK" ? 0.01 : market === "CRYPTO_FUTURES" ? 0.1 : 1,
    barProxyRealtimeAllowed: false,
    quoteEvidence: quote(),
  };
  if (market === "KR_STOCK") return {
    ...common,
    taxPolicyKnown: true,
    session: { version: "kr-session-v1", status: "OPEN", kind: "REGULAR" },
    volatilityInterruptionKnown: true,
    volatilityInterruptionActive: false,
    ...overrides,
  };
  if (market === "US_STOCK") return {
    ...common,
    taxPolicyKnown: true,
    session: { version: "us-session-v1", status: "OPEN", kind: "REGULAR" },
    ...overrides,
  };
  if (market === "CRYPTO_SPOT") return {
    ...common,
    marketStatus: "TRADABLE",
    minOrderNotional: 5,
    ...overrides,
  };
  return {
    ...common,
    contractStatus: "TRADABLE",
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
  };
}

function candidate(market, direction, quantity, overrides = {}) {
  const identity = strategyIdentity();
  return {
    signal: {
      signalId: `${market}-${direction}-001`,
      market,
      symbol: SYMBOL_BY_MARKET[market],
      timestampMs: NOW - 2_000,
      ttlMs: 62_000,
      expiresAtMs: NOW + 60_000,
      style: "SWING",
      timeframe: "1h",
      horizon: 12,
      direction,
      signalDirection: direction,
      strategyIdentity: identity,
    },
    riskEvidence: {
      status: "APPROVED",
      source: "TRADING_RISK_ENGINE",
      evaluatedAtMs: NOW - 1_000,
      simulatedOnly: true,
      allowed: true,
      blockCodes: [],
      recommendedQuantity: quantity,
      executionAuthority: "NONE",
    },
    execution: {
      dataEvidence: dataEvidence(market),
      costPolicy: costPolicy(market),
      strategyIdentity: identity,
    },
    admissionEvidence: {
      schemaVersion: "scanner-paper-admission-evidence-bundle-v1",
      evidenceDigest: EVIDENCE_DIGEST,
      crossRuntimeVerified: true,
    },
    sampleExecutionReady: false,
    sampleExecutionBlockers: [
      "CANONICAL_EXECUTION_POLICY_REQUIRED",
      "CANONICAL_MARKET_ADAPTER_IDENTITY_REQUIRED",
      "SIMULATED_ORDER_REQUIRED",
    ],
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    ...overrides,
  };
}

test("v1 policy is preregistered, quote-only, conservative and simulation-only", () => {
  assert.deepEqual(CANONICAL_PAPER_EXECUTION_POLICY, {
    version: "public-evidence-simulated-paper-v1",
    fillModel: "TOP_OF_BOOK",
    sameBarPolicy: "STOP_FIRST",
    allowPartialFill: false,
    maxParticipationRate: 0.1,
    nextBarOnly: false,
  });
  assert.deepEqual(CANONICAL_PAPER_SIMULATED_ORDER_POLICY, {
    version: "public-evidence-simulated-market-order-v1",
    type: "MARKET",
    priceAuthority: "PUBLIC_TOP_OF_BOOK",
    quantityAuthority: "TRADING_RISK_ENGINE",
  });
});

for (const [market, direction, quantity] of [
  ["KR_STOCK", "BUY", 2],
  ["US_STOCK", "BUY", 3],
  ["CRYPTO_SPOT", "BUY", 0.25],
  ["CRYPTO_FUTURES", "LONG", 0.01],
  ["CRYPTO_FUTURES", "SHORT", 0.02],
]) {
  test(`${market} ${direction} derives canonical adapter and risk-bound simulated MARKET order`, () => {
    const resolved = resolveCanonicalPaperSimulationAuthority({
      candidate: candidate(market, direction, quantity),
      nowMs: NOW,
    });
    assert.equal(resolved.status, "READY");
    assert.equal(resolved.sampleExecutionReady, true);
    assert.deepEqual(resolved.blockers, []);
    assert.equal(resolved.marketAdapterIdentity.id, ADAPTER_BY_MARKET[market]);
    assert.equal(resolved.marketAdapterIdentity.version, "v2");
    assert.equal(resolved.execution.executionPolicy.version, "public-evidence-simulated-paper-v1");
    assert.equal(resolved.order.type, "MARKET");
    assert.equal(resolved.order.direction, direction);
    assert.equal(resolved.order.quantity, quantity);
    assert.equal(resolved.executionContext.status, "READY");
    assert.equal(resolved.executionAuthority, "NONE");
    assert.equal(resolved.liveOrderAllowed, false);
    assert.equal(resolved.privateTradingApiAllowed, false);
    assert.equal(resolved.orderSubmitted, false);
    assert.equal(resolved.exchangeRequestSent, false);
    assert.equal(resolved.productionMutationAllowed, false);
    assert.equal(resolved.profitabilityClaimAllowed, false);
  });
}

test("bar-only evidence is blocked instead of silently downgrading TOP_OF_BOOK fidelity", () => {
  const input = candidate("CRYPTO_SPOT", "BUY", 0.25);
  input.execution.dataEvidence = dataEvidence("CRYPTO_SPOT", {
    barProxyRealtimeAllowed: true,
    quoteEvidence: undefined,
  });
  const resolved = resolveCanonicalPaperSimulationAuthority({ candidate: input, nowMs: NOW });
  assert.equal(resolved.status, "BLOCKED");
  assert.equal(resolved.sampleExecutionReady, false);
  assert.ok(resolved.blockers.includes("CANONICAL_TOP_OF_BOOK_QUOTE_REQUIRED"));
  assert.equal(resolved.order, null);
});

test("stale or crossed quote evidence is blocked before simulated order creation", () => {
  const stale = candidate("CRYPTO_SPOT", "BUY", 0.25);
  stale.execution.dataEvidence = dataEvidence("CRYPTO_SPOT", {
    quoteEvidence: quote({ asOfMs: NOW - 10_000, maxAgeMs: 1_000 }),
  });
  const staleResult = resolveCanonicalPaperSimulationAuthority({ candidate: stale, nowMs: NOW });
  assert.equal(staleResult.status, "BLOCKED");
  assert.ok(staleResult.blockers.includes("CANONICAL_TOP_OF_BOOK_STALE"));

  const crossed = candidate("CRYPTO_SPOT", "BUY", 0.25);
  crossed.execution.dataEvidence = dataEvidence("CRYPTO_SPOT", {
    quoteEvidence: quote({ bid: 102, ask: 101 }),
  });
  const crossedResult = resolveCanonicalPaperSimulationAuthority({ candidate: crossed, nowMs: NOW });
  assert.equal(crossedResult.status, "BLOCKED");
  assert.ok(crossedResult.blockers.includes("CANONICAL_TOP_OF_BOOK_CROSSED"));
});

test("Risk Engine approval and quantity are mandatory simulation authority", () => {
  const denied = candidate("CRYPTO_FUTURES", "LONG", 0.01);
  denied.riskEvidence = { ...denied.riskEvidence, status: "BLOCKED", allowed: false, blockCodes: ["RISK_LIMIT"] };
  const deniedResult = resolveCanonicalPaperSimulationAuthority({ candidate: denied, nowMs: NOW });
  assert.equal(deniedResult.status, "BLOCKED");
  assert.ok(deniedResult.blockers.includes("CANONICAL_RISK_EVIDENCE_NOT_APPROVED"));
  assert.equal(deniedResult.order, null);

  const missingQuantity = candidate("CRYPTO_FUTURES", "LONG", 0);
  const quantityResult = resolveCanonicalPaperSimulationAuthority({ candidate: missingQuantity, nowMs: NOW });
  assert.equal(quantityResult.status, "BLOCKED");
  assert.ok(quantityResult.blockers.includes("CANONICAL_RISK_QUANTITY_REQUIRED"));
});

test("market lot and minimum-notional rules fail closed before OPEN", () => {
  const fractionalStock = resolveCanonicalPaperSimulationAuthority({
    candidate: candidate("US_STOCK", "BUY", 1.5),
    nowMs: NOW,
  });
  assert.equal(fractionalStock.status, "BLOCKED");
  assert.ok(fractionalStock.blockers.includes("STOCK_SIMULATED_QUANTITY_INTEGER_REQUIRED"));

  const tinySpot = resolveCanonicalPaperSimulationAuthority({
    candidate: candidate("CRYPTO_SPOT", "BUY", 0.01),
    nowMs: NOW,
  });
  assert.equal(tinySpot.status, "BLOCKED");
  assert.ok(tinySpot.blockers.includes("SPOT_SIMULATED_MIN_NOTIONAL_NOT_MET"));

  const badStep = resolveCanonicalPaperSimulationAuthority({
    candidate: candidate("CRYPTO_FUTURES", "LONG", 0.0105),
    nowMs: NOW,
  });
  assert.equal(badStep.status, "BLOCKED");
  assert.ok(badStep.blockers.includes("FUTURES_SIMULATED_QTY_STEP_MISMATCH"));
});

test("cash SELL cannot become a standalone Paper entry", () => {
  const result = resolveCanonicalPaperSimulationAuthority({
    candidate: candidate("KR_STOCK", "SELL", 2),
    nowMs: NOW,
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockers.includes("CANONICAL_PAPER_ENTRY_DIRECTION_UNSUPPORTED"));
  assert.equal(result.order, null);
});

test("resolved authority is directly compatible with existing Paper sampler without real order authority", () => {
  const source = candidate("CRYPTO_SPOT", "BUY", 0.25);
  const resolved = resolveCanonicalPaperSimulationAuthority({ candidate: source, nowMs: NOW });
  assert.equal(resolved.status, "READY");

  const sample = buildFourMarketPaperSample({
    signal: source.signal,
    profitGate: {
      decision: "ELIGIBLE",
      eligible: true,
      reasons: [],
      executionAuthority: "NONE",
    },
    profitEvidence: {
      status: "READY",
      market: "CRYPTO_SPOT",
      expectedNetEdge: 0.01,
      expectedNetReturn: 0.02,
      riskRewardRatio: 1.5,
      sampleSize: 120,
      costPolicyId: "cost-v1",
      executionAuthority: "NONE",
    },
    execution: resolved.execution,
    order: resolved.order,
    quote: resolved.quote,
    evaluatedAtMs: NOW,
  });

  assert.equal(sample.status, "OPEN");
  assert.equal(sample.executionContextStatus, "READY");
  assert.equal(sample.fill.status, "FILLED");
  assert.equal(sample.orderSubmitted, false);
  assert.equal(sample.exchangeRequestSent, false);
  assert.equal(sample.privateTradingApiAllowed, false);
  assert.equal(sample.liveOrderAllowed, false);
  assert.equal(sample.profitabilityClaimAllowed, false);
});

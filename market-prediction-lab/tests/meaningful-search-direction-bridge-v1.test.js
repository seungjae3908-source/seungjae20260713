import assert from "node:assert/strict";
import test from "node:test";
import { resolveCanonicalPaperSimulationAuthority } from "../src/canonical-paper-simulation-authority-v1.js";
import {
  meaningfulSearchPaperCandidates,
  prepareMeaningfulSearchPaperCandidate,
} from "../src/meaningful-search-paper-bridge-v1.js";

const T0 = 1_800_000_000_000;
const SHA = "d".repeat(40);
const EVIDENCE_DIGEST = "a".repeat(64);
const identity = Object.freeze({
  strategyId: "direction-contract-v1",
  strategyVersion: "v1",
  parameterHash: "params-v1",
  researchCodeSha: SHA,
  costPolicyVersion: "cost-v1",
  executionPolicyVersion: "execution-v1",
});

const SYMBOL_BY_MARKET = Object.freeze({
  KR_STOCK: "005930",
  US_STOCK: "AAPL",
  CRYPTO_SPOT: "KRW-BTC",
  CRYPTO_FUTURES: "BTCUSDT",
});
const PROVIDER_BY_MARKET = Object.freeze({
  KR_STOCK: "toss",
  US_STOCK: "toss",
  CRYPTO_SPOT: "upbit",
  CRYPTO_FUTURES: "bitget",
});

function costPolicy(market) {
  return {
    version: "cost-v1",
    commissionRate: 0.0005,
    taxRate: market === "KR_STOCK" || market === "US_STOCK" ? 0.001 : 0,
    spreadRate: 0.0004,
    slippageRate: 0.0005,
    latencyRate: 0.0001,
    liquidityImpactRate: 0.0002,
    partialFillImpactRate: 0.0001,
    fundingRate: market === "CRYPTO_FUTURES" ? 0.0001 : 0,
  };
}

function dataEvidence(market) {
  const common = {
    provider: PROVIDER_BY_MARKET[market],
    provenance: `${market}:public-direction-fixture`,
    publicOnly: true,
    dataQuality: "READY",
    asOfMs: T0 - 1_000,
    maxAgeMs: 5_000,
    tickSize: market === "US_STOCK" ? 0.01 : market === "CRYPTO_FUTURES" ? 0.1 : 1,
    barProxyRealtimeAllowed: false,
    quoteEvidence: {
      available: true,
      bid: 99,
      ask: 101,
      asOfMs: T0 - 500,
      maxAgeMs: 5_000,
    },
  };
  if (market === "KR_STOCK") {
    return {
      ...common,
      taxPolicyKnown: true,
      session: { version: "kr-session-v1", status: "OPEN", kind: "REGULAR" },
      volatilityInterruptionKnown: true,
      volatilityInterruptionActive: false,
    };
  }
  if (market === "US_STOCK") {
    return {
      ...common,
      taxPolicyKnown: true,
      session: { version: "us-session-v1", status: "OPEN", kind: "REGULAR" },
    };
  }
  if (market === "CRYPTO_SPOT") {
    return {
      ...common,
      marketStatus: "TRADABLE",
      minOrderNotional: 5,
    };
  }
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
  };
}

function candidate(market, direction, { positionSide = "FLAT", lifecycle = "ACTIVE", expiresAtMs = T0 + 60_000, reduceOnly = false } = {}) {
  const signalId = `${market}:${direction}:${positionSide}`;
  const symbol = SYMBOL_BY_MARKET[market] ?? `${market}:TEST`;
  const signal = {
    signalId,
    market,
    symbol,
    timestampMs: T0 - 10,
    style: "SWING",
    timeframe: "1h",
    horizon: 4,
    direction,
    signalDirection: direction,
    positionSide,
    lifecycle,
    expiresAtMs,
    reduceOnly,
    strategyIdentity: identity,
    learningSnapshot: {
      signalId,
      timestamp: new Date(T0 - 10).toISOString(),
      market,
      symbol,
      strategyHorizon: "SWING",
      direction,
      immutable: true,
      executionAuthority: "NONE",
    },
  };
  return {
    signal,
    positionSide,
    riskEvidence: {
      status: "APPROVED",
      source: "TRADING_RISK_ENGINE",
      evaluatedAtMs: T0,
      simulatedOnly: true,
      allowed: true,
      blockCodes: [],
      recommendedQuantity: 1,
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
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
  };
}

function withCanonicalSimulationAuthority(rawCandidate) {
  const simulation = resolveCanonicalPaperSimulationAuthority({ candidate: rawCandidate, nowMs: T0 });
  assert.equal(simulation.status, "READY", simulation.blockers?.join(",") ?? "simulation authority blocked");
  assert.ok(simulation.execution);
  assert.ok(simulation.order);
  assert.ok(simulation.quote);
  return {
    ...rawCandidate,
    execution: simulation.execution,
    order: simulation.order,
    quote: simulation.quote,
    sampleExecutionReady: true,
    sampleExecutionBlockers: [],
  };
}

const profitGate = Object.freeze({ decision: "ELIGIBLE", eligible: true, reasons: [], executionAuthority: "NONE" });
const profitEvidence = Object.freeze({
  status: "READY",
  expectedNetEdge: 0.5,
  expectedNetReturn: 0.8,
  riskRewardRatio: 1.5,
  sampleSize: 30,
  costPolicyId: "cost-v1",
  executionAuthority: "NONE",
});

function eligible(market, direction, options) {
  return { searchOutcome: "TRADE_CANDIDATES", candidate: candidate(market, direction, options), profitGate, profitEvidence };
}

function simulationEligible(market, direction, options) {
  const row = eligible(market, direction, options);
  return { ...row, candidate: withCanonicalSimulationAuthority(row.candidate) };
}

test("cash SELL while FLAT is display-only bearish signal and creates zero Paper entry", () => {
  for (const market of ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]) {
    const row = prepareMeaningfulSearchPaperCandidate(eligible(market, "SELL", { positionSide: "FLAT" }));
    assert.equal(row.status, "NO_TRADE");
    assert.equal(row.submitToPaper, false);
    assert.equal(row.submitToPaperExit, false);
    assert.equal(row.candidate.executionIntent, "NONE");
    assert.equal(row.candidate.signalDirection, "SELL");
    assert.deepEqual(row.blockers, ["CASH_SELL_FLAT_NO_NAKED_SHORT"]);
  }
});

test("cash SELL with LONG position routes only to Paper exit signal", () => {
  const row = prepareMeaningfulSearchPaperCandidate(eligible("KR_STOCK", "SELL", { positionSide: "LONG" }));
  assert.equal(row.status, "PAPER_EXIT_SIGNAL");
  assert.equal(row.submitToPaper, false);
  assert.equal(row.submitToPaperExit, true);
  assert.equal(row.candidate.executionIntent, "EXIT");
  assert.equal(row.candidate.nextPositionSide, "FLAT");
});

test("cash reduce-only SELL with LONG position remains REDUCE and never opens short", () => {
  const row = prepareMeaningfulSearchPaperCandidate(eligible("US_STOCK", "SELL", { positionSide: "LONG", reduceOnly: true }));
  assert.equal(row.status, "PAPER_EXIT_SIGNAL");
  assert.equal(row.candidate.executionIntent, "REDUCE");
  assert.equal(row.candidate.nextPositionSide, "LONG");
  assert.equal(row.submitToPaper, false);
});

test("futures SHORT from FLAT remains a profit-gated Paper entry with canonical simulation authority", () => {
  const row = prepareMeaningfulSearchPaperCandidate(simulationEligible("CRYPTO_FUTURES", "SHORT", { positionSide: "FLAT" }));
  assert.equal(row.status, "PAPER_ELIGIBLE");
  assert.equal(row.submitToPaper, true);
  assert.equal(row.candidate.signalDirection, "SHORT");
  assert.equal(row.candidate.executionIntent, "ENTER");
  assert.equal(row.candidate.nextPositionSide, "SHORT");
});

test("NO_TRADE bypasses entry even if an upstream gate incorrectly says ELIGIBLE", () => {
  const row = prepareMeaningfulSearchPaperCandidate(eligible("KR_STOCK", "NO_TRADE"));
  assert.equal(row.status, "NO_TRADE");
  assert.equal(row.submitToPaper, false);
  assert.deepEqual(row.blockers, ["SIGNAL_NO_TRADE"]);
});

test("UNKNOWN and market-mismatched directions fail closed and never default BUY", () => {
  const unknown = prepareMeaningfulSearchPaperCandidate(eligible("KR_STOCK", "UNKNOWN"));
  assert.equal(unknown.status, "BLOCKED");
  assert.equal(unknown.candidate.signalDirection, "UNKNOWN");
  assert.ok(unknown.blockers.includes("SIGNAL_DIRECTION_UNKNOWN"));

  const mismatch = prepareMeaningfulSearchPaperCandidate(eligible("CRYPTO_SPOT", "SHORT"));
  assert.equal(mismatch.status, "BLOCKED");
  assert.ok(mismatch.blockers.includes("SIGNAL_DIRECTION_MARKET_MISMATCH"));
});

test("expired signal is never eligible for a new Paper entry", () => {
  const row = prepareMeaningfulSearchPaperCandidate(eligible("CRYPTO_FUTURES", "LONG", { expiresAtMs: T0 - 1 }));
  assert.equal(row.status, "BLOCKED");
  assert.equal(row.submitToPaper, false);
  assert.equal(row.candidate.signalLifecycle, "EXPIRED");
  assert.ok(row.blockers.includes("SIGNAL_EXPIRED"));
});

test("aggregation keeps entry candidates and exit signals in separate collections", () => {
  const rows = meaningfulSearchPaperCandidates([
    simulationEligible("KR_STOCK", "BUY", { positionSide: "FLAT" }),
    eligible("US_STOCK", "SELL", { positionSide: "LONG" }),
    eligible("CRYPTO_SPOT", "SELL", { positionSide: "FLAT" }),
    simulationEligible("CRYPTO_FUTURES", "SHORT", { positionSide: "FLAT" }),
  ]);
  assert.equal(rows.candidates.length, 2);
  assert.equal(rows.exitSignals.length, 1);
  assert.equal(rows.noTrade, 1);
  assert.equal(rows.eligible, 2);
  assert.equal(rows.exits, 1);
  assert.equal(rows.liveTrading, false);
  assert.equal(rows.realOrder, false);
  assert.equal(rows.privateApi, false);
});

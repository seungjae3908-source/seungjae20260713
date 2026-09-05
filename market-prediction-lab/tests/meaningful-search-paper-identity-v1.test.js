import assert from "node:assert/strict";
import test from "node:test";
import { resolveCanonicalPaperSimulationAuthority } from "../src/canonical-paper-simulation-authority-v1.js";
import { prepareMeaningfulSearchPaperCandidate } from "../src/meaningful-search-paper-bridge-v1.js";

const T0 = 1_800_000_000_000;
const SHA = "c".repeat(40);
const EVIDENCE_DIGEST = "b".repeat(64);
const STRATEGY = Object.freeze({
  strategyId: "scanner-paper-identity-v1",
  strategyVersion: "v1",
  parameterHash: "params-sha256-v1",
  researchCodeSha: SHA,
  costPolicyVersion: "cost-v1",
});

function decision() {
  const market = "CRYPTO_FUTURES";
  const symbol = "BTCUSDT";
  const direction = "LONG";
  const signalId = "signal-identity-1";
  const signal = {
    signalId,
    market,
    symbol,
    timestampMs: T0 - 2,
    expiresAtMs: T0 + 60_000,
    style: "SWING",
    timeframe: "1h",
    horizon: 4,
    direction,
    regime: "RISK_ON",
    strategyIdentity: { ...STRATEGY },
    learningSnapshot: {
      signalId,
      timestamp: new Date(T0 - 2).toISOString(),
      market,
      symbol,
      strategyHorizon: "SWING",
      direction,
      timeframes: ["1h"],
      strategyProfileVersion: "v1",
      marketRegime: "RISK_ON",
      immutable: true,
      executionAuthority: "NONE",
    },
  };
  return {
    searchOutcome: "TRADE_CANDIDATES",
    candidate: {
      signal,
      riskEvidence: {
        status: "APPROVED",
        source: "TRADING_RISK_ENGINE",
        evaluatedAtMs: T0 - 1,
        simulatedOnly: true,
        allowed: true,
        blockCodes: [],
        recommendedQuantity: 0.01,
        executionAuthority: "NONE",
      },
      execution: {
        strategyIdentity: { ...STRATEGY },
        costPolicy: {
          version: "cost-v1",
          commissionRate: 0.0005,
          taxRate: 0,
          spreadRate: 0.0004,
          slippageRate: 0.0005,
          latencyRate: 0.0001,
          liquidityImpactRate: 0.0002,
          partialFillImpactRate: 0.0001,
          fundingRate: 0.0001,
        },
        dataEvidence: {
          provider: "bitget",
          provenance: "bitget:public-identity-fixture",
          publicOnly: true,
          dataQuality: "READY",
          asOfMs: T0 - 1,
          maxAgeMs: 60_000,
          tickSize: 0.1,
          barProxyRealtimeAllowed: false,
          quoteEvidence: {
            available: true,
            bid: 99,
            ask: 101,
            asOfMs: T0 - 1,
            maxAgeMs: 60_000,
          },
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
        },
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
    },
    profitGate: { decision: "ELIGIBLE", eligible: true, reasons: [], executionAuthority: "NONE" },
    profitEvidence: {
      status: "READY",
      expectedNetEdge: 0.01,
      expectedNetReturn: 0.01,
      riskRewardRatio: 1.5,
      sampleSize: 30,
      costPolicyId: "cost-v1",
      executionAuthority: "NONE",
    },
  };
}

function withCanonicalSimulationAuthority(input) {
  const simulation = resolveCanonicalPaperSimulationAuthority({ candidate: input.candidate, nowMs: T0 });
  assert.equal(simulation.status, "READY", simulation.blockers?.join(",") ?? "simulation authority blocked");
  assert.ok(simulation.execution);
  assert.ok(simulation.order);
  assert.ok(simulation.quote);
  return {
    ...input,
    candidate: {
      ...input.candidate,
      execution: simulation.execution,
      order: simulation.order,
      quote: simulation.quote,
      sampleExecutionReady: true,
      sampleExecutionBlockers: [],
    },
  };
}

test("eligible Scanner candidate carries exact immutable Paper identity", () => {
  const row = prepareMeaningfulSearchPaperCandidate(withCanonicalSimulationAuthority(decision()));
  assert.equal(row.status, "PAPER_ELIGIBLE");
  assert.deepEqual(row.candidate.paperIdentity, {
    signalId: "signal-identity-1",
    strategyId: "scanner-paper-identity-v1",
    strategyVersion: "v1",
    parameterHash: "params-sha256-v1",
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "1h",
    horizon: 4,
    direction: "LONG",
    regime: "RISK_ON",
    costPolicyVersion: "cost-v1",
    researchCodeSha: SHA,
    executionAuthority: "NONE",
  });
});

test("execution strategy identity mismatch is blocked before Paper", () => {
  const input = decision();
  input.candidate.execution.strategyIdentity.parameterHash = "different-params";
  const row = prepareMeaningfulSearchPaperCandidate(input);
  assert.equal(row.status, "BLOCKED");
  assert.ok(row.blockers.includes("EXECUTION_PARAMETER_HASH_MISMATCH"));
});

test("learning snapshot identity mismatch is blocked before Paper", () => {
  const input = decision();
  input.candidate.signal.learningSnapshot.symbol = "ETHUSDT";
  const row = prepareMeaningfulSearchPaperCandidate(input);
  assert.equal(row.status, "BLOCKED");
  assert.ok(row.blockers.includes("LEARNING_SYMBOL_MISMATCH"));
});

test("cost policy mismatch is blocked before Paper", () => {
  const input = decision();
  input.candidate.execution.costPolicy.version = "cost-v2";
  const row = prepareMeaningfulSearchPaperCandidate(input);
  assert.equal(row.status, "BLOCKED");
  assert.ok(row.blockers.includes("PAPER_COST_POLICY_VERSION_MISMATCH"));
});

test("missing regime evidence is preserved explicitly as UNKNOWN", () => {
  const input = decision();
  delete input.candidate.signal.regime;
  delete input.candidate.signal.learningSnapshot.marketRegime;
  const row = prepareMeaningfulSearchPaperCandidate(withCanonicalSimulationAuthority(input));
  assert.equal(row.status, "PAPER_ELIGIBLE");
  assert.equal(row.candidate.paperIdentity.regime, "UNKNOWN");
});

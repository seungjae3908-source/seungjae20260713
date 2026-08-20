import assert from "node:assert/strict";
import test from "node:test";
import { prepareMeaningfulSearchPaperCandidate } from "../src/meaningful-search-paper-bridge-v1.js";

const T0 = 1_800_000_000_000;
const SHA = "c".repeat(40);
const STRATEGY = Object.freeze({
  strategyId: "scanner-paper-identity-v1",
  strategyVersion: "v1",
  parameterHash: "params-sha256-v1",
  researchCodeSha: SHA,
});
const PAPER_EXECUTION_POLICY = Object.freeze({
  version: "public-evidence-simulated-paper-v1",
  fillModel: "TOP_OF_BOOK",
  sameBarPolicy: "STOP_FIRST",
  allowPartialFill: false,
  maxParticipationRate: 0.1,
  nextBarOnly: false,
});
const FUTURES_ADAPTER = Object.freeze({ id: "crypto-futures-bitget-execution", version: "v2" });

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
      riskEvidence: { status: "APPROVED", evaluatedAtMs: T0 - 1, simulatedOnly: true },
      execution: {
        strategyIdentity: { ...STRATEGY },
        costPolicy: { version: "cost-v1" },
        marketAdapterIdentity: FUTURES_ADAPTER,
        executionPolicy: PAPER_EXECUTION_POLICY,
        dataEvidence: { dataQuality: "READY", asOfMs: T0 - 1, maxAgeMs: 60_000 },
      },
      order: { type: "MARKET", quantity: 1, direction },
      executionAuthority: "NONE",
      simulatedOnly: true,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
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

test("eligible Scanner candidate carries exact immutable Paper identity under simulation-only authority", () => {
  const row = prepareMeaningfulSearchPaperCandidate(decision());
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
  assert.equal(row.candidate.execution.marketAdapterIdentity.id, "crypto-futures-bitget-execution");
  assert.equal(row.candidate.execution.executionPolicy.version, "public-evidence-simulated-paper-v1");
  assert.equal(row.candidate.order.type, "MARKET");
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
  const row = prepareMeaningfulSearchPaperCandidate(input);
  assert.equal(row.status, "PAPER_ELIGIBLE");
  assert.equal(row.candidate.paperIdentity.regime, "UNKNOWN");
});

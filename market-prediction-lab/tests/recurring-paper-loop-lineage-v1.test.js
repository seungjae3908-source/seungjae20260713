import assert from "node:assert/strict";
import test from "node:test";
import { createRecurringPaperLoopState, runRecurringPaperCycle } from "../src/recurring-paper-loop-v1.js";
import { FOUR_MARKET_EXECUTION_PROFILES } from "../src/four-market-execution-v2.js";

const T0 = 1_800_000_000_000;
const SHA = "a".repeat(40);
const RUNTIME_IDENTITY = Object.freeze({
  strategyId: "paper-forward-simulated-outcome-v1",
  strategyVersion: "1.0.0",
  parameterHash: "runtime-params",
  researchCodeSha: SHA,
  costPolicyVersion: "runtime-ledger-v1",
  executionPolicyVersion: "runtime-execution-v1",
});

function ledger() {
  return {
    status: "READY",
    initialCapitalKrw: 1_000_000,
    baseCurrency: "KRW",
    knownEquityKrw: 1_000_000,
    totalEquityKrw: 1_000_000,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function candidate({ researchCodeSha = SHA, costPolicyId = "cost-v1", executionCostPolicy = "cost-v1" } = {}) {
  const profile = FOUR_MARKET_EXECUTION_PROFILES.CRYPTO_SPOT;
  const strategyIdentity = {
    strategyId: "scanner-swing-v7",
    strategyVersion: "7.0.0",
    parameterHash: "scanner-params-v7",
    researchCodeSha,
  };
  return {
    signal: {
      signalId: `spot-${researchCodeSha.slice(0, 4)}-${costPolicyId}`,
      market: "CRYPTO_SPOT",
      symbol: "BTC",
      timestampMs: T0 - 2,
      style: "SWING",
      timeframe: "1h",
      horizon: 4,
      direction: "BUY",
      strategyIdentity,
      learningSnapshot: {
        signalId: "spot-learning",
        timestamp: new Date(T0 - 2).toISOString(),
        market: "CRYPTO_SPOT",
        symbol: "BTC",
        symbolName: null,
        strategyHorizon: "SWING",
        direction: "BUY",
        signalScore: 75,
        displayConfidence: null,
        referencePrice: 100,
        entryPrice: 100,
        stopLoss: null,
        target1: null,
        target2: null,
        riskReward: null,
        timeframes: ["1h"],
        strategyProfileVersion: strategyIdentity.strategyVersion,
        indicatorSnapshot: {},
        indicatorScores: {},
        patternSnapshot: {},
        volumeContext: {},
        volatilityContext: {},
        trendContext: {},
        marketRegime: "UNKNOWN",
        liquidityContext: {},
        aiValidatorResult: null,
        riskEngineResult: null,
        dataProvenance: ["upbit-public"],
        dataTimestamp: new Date(T0 - 3).toISOString(),
        immutable: true,
        executionAuthority: "NONE",
      },
    },
    riskEvidence: { status: "APPROVED", evaluatedAtMs: T0 - 1, simulatedOnly: true },
    profitGate: { decision: "ELIGIBLE", eligible: true, reasons: [], executionAuthority: "NONE" },
    profitEvidence: {
      status: "READY",
      expectedNetEdge: 0.01,
      expectedNetReturn: 0.01,
      riskRewardRatio: 1.5,
      sampleSize: 30,
      costPolicyId,
      executionAuthority: "NONE",
    },
    execution: {
      marketAdapterIdentity: profile.marketAdapter,
      strategyIdentity,
      costPolicy: {
        version: executionCostPolicy,
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
        version: "execution-v1",
        fillModel: "TOP_OF_BOOK",
        sameBarPolicy: "STOP_FIRST",
        allowPartialFill: true,
        maxParticipationRate: 1,
      },
      dataEvidence: {
        provider: "upbit",
        publicOnly: true,
        dataQuality: "READY",
        provenance: "upbit-public",
        asOfMs: T0 - 1,
        maxAgeMs: 60_000,
        marketStatus: "TRADABLE",
        tickSize: 1,
        minOrderNotional: 5_000,
        quoteEvidence: {
          available: true,
          bid: 99,
          ask: 100,
          asOfMs: T0 - 1,
          maxAgeMs: 60_000,
        },
      },
    },
    order: { type: "MARKET", quantity: 100, direction: "BUY" },
    quote: { bid: 99, ask: 100, bidSize: 1_000, askSize: 1_000, asOfMs: T0 - 1, maxAgeMs: 60_000 },
  };
}

function harness() {
  let learnedSignals = 0;
  let stateSaves = 0;
  return {
    state: createRecurringPaperLoopState({ identity: RUNTIME_IDENTITY, ledger: ledger(), createdAtMs: T0 - 10 }),
    ledgerAdapter: {
      async applyEntry({ ledger: current }) { return current; },
      async applySettlement({ ledger: current }) { return current; },
    },
    learningAdapter: {
      async persistSignal() { learnedSignals += 1; },
      async persistOutcome() {},
    },
    stateStore: { async save() { stateSaves += 1; } },
    counts: () => ({ learnedSignals, stateSaves }),
  };
}

function run(h, rows) {
  return runRecurringPaperCycle({
    state: h.state,
    cycle: { cycleId: "cycle-1", evaluatedAtMs: T0, identity: RUNTIME_IDENTITY },
    candidates: rows,
    exits: [],
    ledgerAdapter: h.ledgerAdapter,
    learningAdapter: h.learningAdapter,
    stateStore: h.stateStore,
  });
}

test("runtime lineage and Scanner strategy lineage are independent when research SHA matches", async () => {
  const h = harness();
  const result = await run(h, [candidate()]);
  assert.equal(result.summary.entries, 1);
  assert.equal(result.state.positions.length, 1);
  assert.equal(result.state.positions[0].strategyId, "scanner-swing-v7");
  assert.equal(result.state.positions[0].researchCodeSha, SHA);
  assert.deepEqual(h.counts(), { learnedSignals: 1, stateSaves: 1 });
});

test("candidate from a different research code SHA is blocked before Paper entry", async () => {
  const h = harness();
  const result = await run(h, [candidate({ researchCodeSha: "b".repeat(40) })]);
  assert.equal(result.summary.entries, 0);
  assert.equal(result.summary.blocked, 1);
  assert.equal(result.state.samples[0].status, "BLOCKED");
  assert.ok(result.state.samples[0].blockers.includes("STRATEGY_RESEARCH_SHA_MISMATCH"));
  assert.equal(h.counts().learnedSignals, 0);
});

test("Profit-First cost policy mismatch is blocked before an un-settleable position can open", async () => {
  const h = harness();
  const result = await run(h, [candidate({ costPolicyId: "profit-cost-v2", executionCostPolicy: "execution-cost-v1" })]);
  assert.equal(result.summary.entries, 0);
  assert.equal(result.summary.blocked, 1);
  assert.ok(result.state.samples[0].blockers.includes("PAPER_COST_POLICY_VERSION_MISMATCH"));
  assert.equal(result.state.positions.length, 0);
  assert.equal(h.counts().learnedSignals, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  createRecurringPaperLoopState,
  restoreRecurringPaperLoopState,
  runRecurringPaperCycle,
  serializeRecurringPaperLoopState,
} from "../src/recurring-paper-loop-v1.js";
import { FOUR_MARKET_EXECUTION_PROFILES } from "../src/four-market-execution-v2.js";

const T0 = 1_800_000_000_000;
const SHA = "b".repeat(40);
const identity = Object.freeze({
  strategyId: "natural-lifecycle-v1",
  strategyVersion: "v1",
  parameterHash: "parameter-hash-v1",
  researchCodeSha: SHA,
  costPolicyVersion: "cost-v1",
  executionPolicyVersion: "execution-v1",
});
const RISK_POLICY_IDENTITY = Object.freeze({
  policyId: "paper-risk-v1",
  policyVersion: "2026-08-29",
  source: "canonical-risk-policy-record",
  researchCodeSha: SHA,
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

function execution(now = T0) {
  const profile = FOUR_MARKET_EXECUTION_PROFILES.CRYPTO_SPOT;
  return {
    marketAdapterIdentity: profile.marketAdapter,
    strategyIdentity: identity,
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
      version: "execution-v1",
      fillModel: "TOP_OF_BOOK",
      sameBarPolicy: "STOP_FIRST",
      allowPartialFill: true,
      maxParticipationRate: 1,
    },
    dataEvidence: {
      provider: profile.provider,
      publicOnly: true,
      dataQuality: "READY",
      provenance: "public-lifecycle-fixture",
      asOfMs: now - 1,
      maxAgeMs: 60_000,
      quoteEvidence: { available: true, bid: 99, ask: 100, asOfMs: now - 1, maxAgeMs: 60_000 },
      marketStatus: "TRADABLE",
      tickSize: 1,
      minOrderNotional: 1,
    },
  };
}

function candidate(id = "entry-1", overrides = {}) {
  const signalTimestampMs = T0 - 2;
  const base = {
    testOnly: true,
    naturalEvidence: { provenanceClass: "TEST_ONLY", testOnly: true },
    signal: {
      signalId: id,
      market: "CRYPTO_SPOT",
      symbol: `CRYPTO_SPOT:${id}`,
      timestampMs: signalTimestampMs,
      style: "SWING",
      timeframe: "1h",
      horizon: 4,
      expiresAtMs: T0 + 4 * 3_600_000,
      direction: "BUY",
      strategyIdentity: identity,
      learningSnapshot: {
        signalId: id,
        timestamp: new Date(signalTimestampMs).toISOString(),
        market: "CRYPTO_SPOT",
        symbol: `CRYPTO_SPOT:${id}`,
        strategyHorizon: "SWING",
        direction: "BUY",
        entryPrice: 100,
        stopLoss: 95,
        target1: 105,
        target2: 110,
        timeframes: ["1h"],
        strategyProfileVersion: identity.strategyVersion,
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
      costPolicyId: "cost-v1",
      executionAuthority: "NONE",
    },
    execution: execution(),
    order: { type: "MARKET", quantity: 1, direction: "BUY" },
    quote: { bid: 99, ask: 100, bidSize: 10, askSize: 10, asOfMs: T0 - 1, maxAgeMs: 60_000 },
  };
  return {
    ...base,
    ...overrides,
    signal: { ...base.signal, ...(overrides.signal ?? {}) },
  };
}

function naturalEvidence(observationId, observedAtMs) {
  return {
    provenanceClass: "NATURAL_FORWARD",
    synthetic: false,
    replay: false,
    testOnly: false,
    backfill: false,
    historical: false,
    duplicate: false,
    observationId,
    source: "public-natural-fixture",
    provenance: "future-natural-cycle-fixture",
    observedAtMs,
  };
}

function harness() {
  let settlementMutations = 0;
  let savedState = null;
  return {
    state: createRecurringPaperLoopState({ identity, ledger: ledger(), createdAtMs: T0 - 10 }),
    ledgerAdapter: {
      async applyEntry({ ledger: current }) { return current; },
      async applySettlement({ ledger: current, settlement }) {
        settlementMutations += 1;
        return {
          ...current,
          knownEquityKrw: current.knownEquityKrw + settlement.netPnl,
          totalEquityKrw: current.totalEquityKrw + settlement.netPnl,
        };
      },
    },
    learningAdapter: {
      async persistSignal() {},
      async persistOutcome() {},
    },
    stateStore: {
      async save({ state }) { savedState = state; },
    },
    getSettlementMutations: () => settlementMutations,
    getSavedState: () => savedState,
  };
}

function cycle(id, time) {
  return { cycleId: id, evaluatedAtMs: time, identity };
}

function run(h, input) {
  return runRecurringPaperCycle({
    ...input,
    ledgerAdapter: h.ledgerAdapter,
    learningAdapter: h.learningAdapter,
    stateStore: h.stateStore,
  });
}

function costEvidence(now) {
  const component = (name, value = 0) => ({
    state: "PRESENT",
    value,
    unit: "PERCENT",
    quality: value === 0 ? "MEASURED_ZERO" : "OBSERVED",
    source: `test-only-${name}-producer`,
    observedAtMs: now - 1,
    countsAsExecutionCost: true,
    unavailableIsZero: false,
  });
  return {
    schemaVersion: "authoritative-paper-execution-cost-sources-v1",
    status: "PRESENT",
    fullCostReady: true,
    components: {
      fees: component("fees", 0.1),
      spread: component("spread"),
      slippage: component("slippage"),
      funding: component("funding"),
      latency: component("latency"),
      liquidityImpact: component("liquidity-impact"),
      partialFillImpact: component("partial-fill-impact"),
    },
    supplementalCostInput: { costPolicyId: "cost-v1" },
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
  };
}

function observation(position, id, now, bar, overrides = {}) {
  const base = {
    observationId: id,
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    market: position.market,
    symbol: position.symbol,
    direction: position.direction,
    strategyId: position.strategyId,
    strategyVersion: position.strategyVersion,
    parameterHash: position.parameterHash,
    researchCodeSha: position.researchCodeSha,
    costPolicyVersion: position.costPolicyVersion,
    publicOnly: true,
    source: "public-market-fixture",
    provenance: "test-only natural lifecycle observation",
    observedAtMs: now,
    maxAgeMs: 60_000,
    bar,
    naturalEvidence: { provenanceClass: "TEST_ONLY", testOnly: true },
    settlementCostEvidence: costEvidence(now),
    settlementInput: {
      exitExecution: execution(now + 1),
      exitBar: { ...bar, timestampMs: now },
      exitQuote: { bid: bar.close, ask: bar.close + 1, last: bar.close, bidSize: 10, askSize: 10, asOfMs: now, maxAgeMs: 60_000 },
      pathBars: [],
      fundingEvidence: { complete: true, payments: [] },
    },
  };
  return { ...base, ...overrides };
}

async function open(h, id = "entry-1", candidateOverrides = {}) {
  return run(h, {
    state: h.state,
    cycle: cycle(`open-${id}`, T0),
    candidates: [candidate(id, candidateOverrides)],
  });
}

test("Entry becomes a durable Position without losing immutable lineage", async () => {
  const h = harness();
  const opened = await open(h);
  const position = opened.state.positions[0];
  assert.equal(position.symbol, "CRYPTO_SPOT:entry-1");
  assert.equal(position.researchCodeSha, SHA);
  assert.equal(position.lifecycle.identity.positionId, position.positionId);
  assert.equal(position.lifecycle.strategyIdentity.parameterHash, identity.parameterHash);
  assert.equal(position.lifecycle.entry.fillPrice, position.entryFillPrice);
  assert.equal(position.lifecycle.entry.timestampMs, position.entryTimestampMs);
  assert.equal(position.lifecycle.entry.evidenceDigest, position.sample.entryEvidenceProvenance.evidenceSnapshotDigest);
  assert.equal(position.lifecycle.riskPolicyIdentity, null);
  assert.equal(position.lifecycle.riskPolicyIdentityStatus, "MISSING_EVIDENCE");
  assert.equal(position.lifecycle.modelIdentity, null);
  assert.equal(position.lifecycle.modelIdentityStatus, "MISSING_EVIDENCE");
  assert.equal(position.lifecycle.sampleEligibility.provenanceClass, "TEST_ONLY");
  assert.equal(position.lifecycle.sampleEligibility.naturalSampleCredit, 0);
  assert.equal(position.lifecycle.executionAuthority, "NONE");
  assert.equal(position.lifecycle.orderSubmitted, false);
});

test("genuine Natural Position requires and immutably preserves canonical risk-policy identity", async () => {
  const missingHarness = harness();
  await assert.rejects(open(missingHarness, "natural-missing-risk", {
    testOnly: false,
    naturalEvidence: naturalEvidence("natural-entry-missing-risk", T0 - 1),
  }), /PAPER_POSITION_RISK_POLICY_IDENTITY_REQUIRED/);

  const h = harness();
  const opened = await open(h, "natural-risk", {
    testOnly: false,
    naturalEvidence: naturalEvidence("natural-entry-risk", T0 - 1),
    riskEvidence: {
      status: "APPROVED",
      evaluatedAtMs: T0 - 1,
      simulatedOnly: true,
      policyIdentity: RISK_POLICY_IDENTITY,
    },
  });
  const position = opened.state.positions[0];
  assert.deepEqual(position.lifecycle.riskPolicyIdentity, RISK_POLICY_IDENTITY);
  assert.equal(position.lifecycle.riskPolicyIdentityStatus, "PRESENT");
  assert.equal(position.lifecycle.sampleEligibility.provenanceClass, "NATURAL_FORWARD");

  const restored = restoreRecurringPaperLoopState(serializeRecurringPaperLoopState(opened.state), identity);
  assert.deepEqual(restored.positions[0].lifecycle.riskPolicyIdentity, RISK_POLICY_IDENTITY);
});

test("genuine Natural observation rejects mismatched scheduler risk-policy identity before mark mutation", async () => {
  const h = harness();
  const opened = await open(h, "natural-observation-risk", {
    testOnly: false,
    naturalEvidence: naturalEvidence("natural-entry-observation-risk", T0 - 1),
    riskEvidence: {
      status: "APPROVED",
      evaluatedAtMs: T0 - 1,
      simulatedOnly: true,
      policyIdentity: RISK_POLICY_IDENTITY,
    },
  });
  const position = opened.state.positions[0];
  const mark = observation(position, "natural-mark-risk-mismatch", T0 + 1_000, {
    open: 100, high: 103, low: 98, close: 102,
  }, {
    naturalEvidence: naturalEvidence("natural-mark-risk-mismatch", T0 + 1_000),
    schedulerHandoff: {
      riskPolicyIdentity: { ...RISK_POLICY_IDENTITY, policyVersion: "wrong-version" },
    },
  });
  const result = await run(h, {
    state: opened.state,
    cycle: cycle("natural-mark-risk-mismatch-cycle", T0 + 1_000),
    positionObservations: [mark],
  });
  assert.equal(result.state.positions[0].lifecycle.mark.observationCount, 0);
  assert.equal(result.state.settlements.length, 0);
  assert.equal(result.summary.canonicalNaturalStageEvidence.reasonObservations[0].canonicalReason, "IDENTITY_MISMATCH");
});

test("mark update survives restart and TP settles once with gross/cost/net separation", async () => {
  const h = harness();
  const opened = await open(h, "restart");
  const firstPosition = opened.state.positions[0];
  const hold = observation(firstPosition, "mark-hold", T0 + 1_000, { open: 100, high: 103, low: 98, close: 102 });
  const marked = await run(h, {
    state: opened.state,
    cycle: cycle("mark", T0 + 1_000),
    positionObservations: [hold],
  });
  assert.equal(marked.state.positions[0].lifecycle.mark.observationCount, 1);
  assert.equal(marked.state.positions[0].lifecycle.mark.mfePercent, 3);
  assert.equal(marked.state.positions[0].lifecycle.mark.maePercent, -2);

  const restored = restoreRecurringPaperLoopState(serializeRecurringPaperLoopState(marked.state), identity);
  assert.equal(restored.positions[0].lifecycle.mark.observationCount, 1);
  const close = observation(restored.positions[0], "mark-tp", T0 + 2_000, { open: 103, high: 106, low: 101, close: 105 }, {
    settlementInput: {
      ...observation(restored.positions[0], "unused", T0 + 2_000, { open: 103, high: 106, low: 101, close: 105 }).settlementInput,
      pathBars: [{ timestampMs: T0 + 100_000, high: 999, low: 1 }],
    },
  });
  const settled = await run(h, {
    state: restored,
    cycle: cycle("settle", T0 + 2_000),
    positionObservations: [close],
  });
  assert.equal(settled.state.positions.length, 0);
  assert.equal(settled.state.settlements.length, 1);
  assert.equal(settled.state.settlements[0].exitReason, "TAKE_PROFIT");
  assert.equal(settled.state.settlements[0].rejectedFuturePathBars, 1);
  assert.equal(settled.state.settlements[0].mfePercent, 6);
  assert.equal(settled.state.settlements[0].maePercent, -2);
  assert.equal(typeof settled.state.settlements[0].grossPnl, "number");
  assert.equal(typeof settled.state.settlements[0].totalExplicitCost, "number");
  assert.equal(settled.state.settlements[0].netPnl,
    settled.state.settlements[0].grossPnl - settled.state.settlements[0].totalExplicitCost);
  assert.equal(settled.state.settlements[0].naturalSampleCredit, 0);
  assert.equal(settled.state.settlements[0].testOnlySampleCredit, 0);
  assert.equal(settled.state.settlements[0].executionAuthority, "NONE");
  assert.equal(settled.state.settlements[0].orderSubmitted, false);
  assert.equal(h.getSettlementMutations(), 1);
  const persisted = restoreRecurringPaperLoopState(h.getSavedState(), identity);
  assert.equal(persisted.positions.length, 0);
  assert.equal(persisted.settlements.length, 1);

  const duplicate = await run(h, {
    state: settled.state,
    cycle: cycle("duplicate", T0 + 3_000),
    positionObservations: [close],
  });
  assert.equal(duplicate.summary.tradesSettled, 0);
  assert.equal(duplicate.state.settlements.length, 1);
  assert.equal(duplicate.summary.canonicalNaturalStageEvidence.reasonObservations[0].canonicalReason, "DUPLICATE");
  assert.equal(h.getSettlementMutations(), 1);
});

test("missing authoritative cost evidence keeps an eligible exit OPEN", async () => {
  const h = harness();
  const opened = await open(h, "missing-cost");
  const position = opened.state.positions[0];
  const close = observation(position, "missing-cost-observation", T0 + 1_000, { open: 100, high: 106, low: 99, close: 105 });
  delete close.settlementCostEvidence;
  const blocked = await run(h, {
    state: opened.state,
    cycle: cycle("blocked-cost", T0 + 1_000),
    positionObservations: [close],
  });
  assert.equal(blocked.state.positions.length, 1);
  assert.equal(blocked.state.settlements.length, 0);
  assert.equal(blocked.state.positions[0].lifecycle.mark.observationCount, 1);
  assert.equal(blocked.summary.canonicalNaturalStageEvidence.reasonObservations[0].canonicalReason, "COST_GATE");
  assert.equal(h.getSettlementMutations(), 0);
});

test("missing funding evidence is never converted into a zero cost", async () => {
  const h = harness();
  const opened = await open(h, "missing-funding");
  const position = opened.state.positions[0];
  const close = observation(position, "missing-funding-observation", T0 + 1_000, { open: 100, high: 106, low: 99, close: 105 });
  delete close.settlementInput.fundingEvidence;
  const blocked = await run(h, {
    state: opened.state,
    cycle: cycle("blocked-funding", T0 + 1_000),
    positionObservations: [close],
  });
  assert.equal(blocked.state.positions.length, 1);
  assert.equal(blocked.state.positions[0].lifecycle.pendingExit.reason, "TAKE_PROFIT");
  assert.equal(blocked.state.settlements.length, 0);
  assert.equal(blocked.summary.canonicalNaturalStageEvidence.reasonObservations[0].canonicalReason, "COST_GATE");
  assert.equal(h.getSettlementMutations(), 0);
});

test("research lineage mismatch is rejected without mutating the Position", async () => {
  const h = harness();
  const opened = await open(h, "lineage");
  const position = opened.state.positions[0];
  const wrong = observation(position, "wrong-sha", T0 + 1_000, { open: 100, high: 101, low: 99, close: 100 }, {
    researchCodeSha: "c".repeat(40),
  });
  const result = await run(h, {
    state: opened.state,
    cycle: cycle("lineage-reject", T0 + 1_000),
    positionObservations: [wrong],
  });
  assert.equal(result.state.positions[0].lifecycle.mark.observationCount, 0);
  assert.equal(result.state.settlements.length, 0);
  assert.equal(result.summary.canonicalNaturalStageEvidence.reasonObservations[0].canonicalReason, "IDENTITY_MISMATCH");
});

test("STOP_FIRST, timeout, and explicit invalidation are canonical and fail closed", async () => {
  const stopHarness = harness();
  const stopOpened = await open(stopHarness, "same-bar");
  const stopPosition = stopOpened.state.positions[0];
  const sameBar = observation(stopPosition, "same-bar-observation", T0 + 1_000, { open: 100, high: 106, low: 94, close: 94 });
  const stopped = await run(stopHarness, {
    state: stopOpened.state,
    cycle: cycle("same-bar-close", T0 + 1_000),
    positionObservations: [sameBar],
  });
  assert.equal(stopped.state.settlements[0].exitReason, "STOP_LOSS");

  const timeoutHarness = harness();
  const expiresAtMs = T0 + 2_000;
  const timeoutOpened = await open(timeoutHarness, "timeout", { signal: { expiresAtMs } });
  const timeoutPosition = timeoutOpened.state.positions[0];
  const timeoutMark = observation(timeoutPosition, "timeout-observation", expiresAtMs, { open: 100, high: 101, low: 99, close: 100 });
  const timedOut = await run(timeoutHarness, {
    state: timeoutOpened.state,
    cycle: cycle("timeout-close", expiresAtMs),
    positionObservations: [timeoutMark],
  });
  assert.equal(timedOut.state.settlements[0].exitReason, "TIMEOUT");

  const invalidationHarness = harness();
  const invalidationOpened = await open(invalidationHarness, "invalidation", { signal: { invalidationPolicyId: "regime-v1" } });
  const invalidationPosition = invalidationOpened.state.positions[0];
  const invalidationMark = observation(invalidationPosition, "invalidation-observation", T0 + 1_000, { open: 100, high: 101, low: 99, close: 100 }, {
    invalidationEvidence: {
      status: "PRESENT",
      invalidated: true,
      policyId: "regime-v1",
      source: "public-regime-evidence",
      provenance: "test-only invalidation evidence",
      observedAtMs: T0 + 1_000,
    },
  });
  const invalidated = await run(invalidationHarness, {
    state: invalidationOpened.state,
    cycle: cycle("invalidation-close", T0 + 1_000),
    positionObservations: [invalidationMark],
  });
  assert.equal(invalidated.state.settlements[0].exitReason, "INVALIDATION");
});

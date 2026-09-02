import assert from "node:assert/strict";
import test from "node:test";
import {
  createRecurringPaperLoopState,
  restoreRecurringPaperLoopState,
  runRecurringPaperCycle,
  serializeRecurringPaperLoopState,
} from "../src/recurring-paper-loop-v1.js";
import { FOUR_MARKET_EXECUTION_PROFILES } from "../src/four-market-execution-v2.js";
import { createHash } from "node:crypto";
import { adaptNaturalPaperSettlementFullCost } from "../src/natural-paper-position-settlement-lifecycle-v1.js";
import { runScheduledPaperCycle } from "../src/paper-scheduler-driver-v1.js";
import { createNaturalPaperPublicPositionObservationProducer } from "../src/natural-paper-public-position-observation-v1.js";
import { PAPER_FORWARD_PROVIDER_AUTHORITY } from "../src/paper-public-provider-authority-v1.js";
import {
  AUTHORITATIVE_NATURAL_PAPER_TRIGGER_SETTLEMENT_EVIDENCE_VERSION,
  createNaturalPaperTriggerBoundSettlementCostProducer,
} from "../src/natural-paper-trigger-bound-settlement-cost-producer-v1.js";

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

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const FOUR_HOURS = 4 * 60 * 60 * 1000;
test("real producer to scheduler to lifecycle contract preserves closed-frame evidence", async () => {
  const { h, state } = await naturalFixture();
  const now = T0 + FOUR_HOURS;
  const source = createNaturalPaperPublicPositionObservationProducer({
    authority: PAPER_FORWARD_PROVIDER_AUTHORITY, clock: () => now,
    collectYahoo: async () => { throw new Error("unexpected Yahoo call"); },
    collectBitget: async () => { throw new Error("unexpected Bitget call"); },
    collectUpbit: async ({ symbol }) => ({
      market: "CRYPTO_SPOT", symbol, provider: "upbit-public-candles", timeframe: "4h",
      candles: [
        { timestamp: T0 - FOUR_HOURS, open: 100, high: 101, low: 99, close: 100 },
        { timestamp: T0, open: 100, high: 102, low: 99, close: 101 },
      ],
    }),
  });
  const result = await runScheduledPaperCycle({
    state, cadence: { version: "test-contract-4h", intervalMs: FOUR_HOURS }, nowMs: now,
    ownerId: "contract-fixture", leaseDurationMs: 20_000, clock: () => now,
    retry: { maxAttempts: 1, baseBackoffMs: 1, timeoutMs: 1_000 },
    leaseStore: {
      async acquire() { return { acquired: true, token: "test-token" }; },
      async assertOwned() {}, async complete() {}, async release() {},
    },
    publicEvidenceProvider: {
      async collectPublicEvidence(input) {
        const observed = await source.collect(input);
        assert.equal(observed.status, "PRESENT");
        return { status: "READY", publicOnly: true, observedAtMs: now, maxAgeMs: FOUR_HOURS,
          candidates: [], exits: [], positionObservations: observed.observations };
      },
    },
    ledgerAdapter: h.ledgerAdapter, learningAdapter: h.learningAdapter, stateStore: h.stateStore,
  });
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.state.positions[0].lifecycle.mark.observationCount, 1);
  assert.equal(result.state.positions[0].lifecycle.mark.maePercent, -1);
  assert.equal(result.state.positions[0].lifecycle.mark.mfePercent, 2);
  assert.equal(result.state.settlements.length, 0);
  assert.equal(h.getSettlementMutations(), 0);
  assert.equal(result.safety.executionAuthority, "NONE");
});
test("Natural lifecycle blocks malformed or discontinuous closed frames before mark mutation", async () => {
  const { h, state } = await naturalFixture();
  const row = boundNaturalObservation(state, "frames", "closed", T0 + FOUR_HOURS, { open: 100, high: 102, low: 99, close: 101 });
  for (const mutate of [
    (o) => { delete o.closedFrame; },
    (o) => { o.closedFrame.openAtMs = T0 - 1; },
    (o) => { o.closedFrame.openAtMs += 1; },
    (o) => { o.closedFrame.sourceDigest = "f".repeat(64); },
    (o) => { o.source = "wrong-provider"; },
    (o) => { o.symbol = "wrong-symbol"; },
    (o) => { o.market = "US_STOCK"; },
    (o) => { o.timeframe = "1m"; },
    (o) => { o.signalTimeframe = "1d"; },
    (o) => { o.horizon += 1; },
    (o) => { o.observedAtMs += FOUR_HOURS; },
    (o) => { o.bar.high = 90; },
    (o) => { o.maxAgeMs *= 100; },
  ]) {
    const bad = structuredClone(row);
    mutate(bad);
    const result = await run(h, { state, cycle: cycle("frames", T0 + FOUR_HOURS), positionObservations: [bad] });
    assert.deepEqual(result.state.positions, state.positions);
    assert.equal(result.state.settlements.length, 0);
  }
});

test("external exit payload cannot bypass a Natural Position lifecycle", async () => {
  const { h, state } = await naturalFixture();
  const row = observation(state.positions[0], "external", T0 + FOUR_HOURS, { open: 100, high: 106, low: 99, close: 105 });
  const result = await run(h, { state, cycle: cycle("external", T0 + FOUR_HOURS), exits: [{
    positionId: state.positions[0].positionId, settlementInput: row.settlementInput,
    lifecycleEvidence: { naturalSampleCredit: 1 },
  }] });
  assert.deepEqual(result.state.positions, state.positions);
  assert.equal(result.state.settlements.length, 0);
  assert.equal(h.getSettlementMutations(), 0);
});

test("legacy external exit cannot claim Natural credit through supplied lifecycle evidence", async () => {
  const h = harness();
  const { state } = await open(h);
  const now = T0 + 1_000;
  const row = observation(state.positions[0], "legacy", now, { open: 100, high: 106, low: 99, close: 105 });
  const result = await run(h, { state, cycle: cycle("legacy", now), exits: [{
    positionId: state.positions[0].positionId, settlementInput: row.settlementInput,
    lifecycleEvidence: { naturalSampleCredit: 1, exitTriggerTimestampMs: T0 + 1 },
  }] });
  assert.equal(result.state.settlements.length, 1);
  assert.equal(result.state.settlements[0].naturalSampleCredit, 0);
  assert.equal(result.state.settlements[0].lifecycleEvidence, null);
});

test("futures Full Cost requires exact observed holding-period funding lineage", async () => {
  const h = harness();
  const opened = await open(h);
  const position = { ...opened.state.positions[0], market: "CRYPTO_FUTURES" };
  const now = T0 + 1_000;
  const row = observation(position, "funding", now, { open: 100, high: 106, low: 99, close: 105 });
  const trigger = { exitTriggerId: "trigger", triggeredAtMs: now };
  const payment = { asOfMs: T0 + 500, amount: position.sample.fill.notional * 0.0001, source: "public-funding-history-fixture", provenance: "contract-fixture", version: "v1" };
  row.settlementInput.fundingEvidence = { complete: true, payments: [payment], entryTimestampMs: T0, exitTimestampMs: now };
  row.settlementCostEvidence.components.funding = {
    ...row.settlementCostEvidence.components.funding, quality: "OBSERVED", valuePercent: 0.01,
    holdingPeriod: { entryTimestampMs: T0, exitTriggerTimestampMs: now, paperSampleId: position.paperSampleId,
      positionId: position.positionId, paymentsDigest: sha256(stableJson([payment])) },
  };
  row.settlementInput.exitExecution.costPolicy.fundingRate = 0.0001;
  assert.equal(adaptNaturalPaperSettlementFullCost({ position, observation: row, trigger, evaluatedAtMs: now }).status, "PRESENT");
  for (const mutate of [
    (o) => { o.settlementCostEvidence.components.funding.holdingPeriod.entryTimestampMs += 1; },
    (o) => { o.settlementCostEvidence.components.funding.holdingPeriod.exitTriggerTimestampMs += 1; },
    (o) => { o.settlementCostEvidence.components.funding.holdingPeriod.paymentsDigest = "f".repeat(64); },
    (o) => { o.settlementCostEvidence.components.funding.quality = "ESTIMATED"; },
    (o) => { o.settlementInput.fundingEvidence.payments[0].amount *= 2; },
    (o) => { o.settlementInput.fundingEvidence.payments[0].asOfMs = now + 1; },
  ]) {
    const invalid = structuredClone(row);
    mutate(invalid);
    assert.equal(adaptNaturalPaperSettlementFullCost({ position, observation: invalid, trigger, evaluatedAtMs: now }).status, "BLOCKED_DATA");
  }
});
function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
async function naturalFixture() {
  const h = harness();
  const opened = await open(h, "bound-natural", {
    testOnly: false, naturalEvidence: naturalEvidence("entry-natural", T0 - 1),
    signal: { expiresAtMs: T0 + 2 * FOUR_HOURS },
    riskEvidence: { status: "APPROVED", evaluatedAtMs: T0 - 1, simulatedOnly: true, policyIdentity: RISK_POLICY_IDENTITY },
  });
  const state = structuredClone(opened.state);
  state.ledger.accountBinding = { accountId: "paper-account", publisherAccountIdSha256: "d".repeat(64), sourceSha: SHA };
  state.ledger.reservations = [{ status: "OPEN", positionId: state.positions[0].positionId, paperSampleId: state.positions[0].paperSampleId }];
  return { h, state };
}

function boundNaturalObservation(state, cycleId, id, now, bar) {
  const p = state.positions[0];
  const row = observation(p, id, now, bar);
  const cycleIdentity = { cycleId, identityFingerprint: state.identityFingerprint, scheduledAtMs: now, startedAtMs: now };
  cycleIdentity.identityDigest = sha256(JSON.stringify(cycleIdentity));
  const binding = state.ledger.accountBinding;
  const accountIdentity = { publisherAccountIdSha256: binding.publisherAccountIdSha256, sourceSha: binding.sourceSha, accountIdSha256: sha256(binding.accountId) };
  accountIdentity.identityDigest = sha256(JSON.stringify(accountIdentity));
  const riskPolicyIdentity = { ...RISK_POLICY_IDENTITY, identityDigest: sha256(JSON.stringify(RISK_POLICY_IDENTITY)) };
  const source = "upbit-public-candles";
  const sourceDigest = sha256(stableJson({
    provider: source, market: p.market, symbol: p.symbol, timeframe: "4h",
    sourceObservedAtMs: now, ...bar,
  }));
  return {
    ...row, signalId: p.signalId, signalTimeframe: p.sample.identity.timeframe, horizon: p.sample.identity.horizon,
    cycleIdentityDigest: cycleIdentity.identityDigest,
    source, sourceDigest, timeframe: "4h", maxAgeMs: 2 * FOUR_HOURS,
    closedFrame: { openAtMs: now - FOUR_HOURS, closeAtMs: now, intervalMs: FOUR_HOURS,
      closeOffsetMs: FOUR_HOURS, provider: source, timeframe: "4h", sourceDigest },
    accountIdentityDigest: accountIdentity.identityDigest,
    entryEvidenceDigest: p.sample.entryEvidenceProvenance.evidenceSnapshotDigest,
    riskPolicyIdentityDigest: riskPolicyIdentity.identityDigest,
    costPolicyIdentity: { version: p.costPolicyVersion },
    naturalEvidence: naturalEvidence(id, now),
    schedulerHandoff: {
      schemaVersion: "paper-scheduler-position-observation-handoff-v1", cycleIdentity, accountIdentity,
      positionIdentity: { ...p.lifecycle.identity }, entryProvenance: structuredClone(p.sample.entryEvidenceProvenance),
      riskPolicyIdentity, costPolicyIdentity: { version: p.costPolicyVersion },
      naturalSampleCreditAuthority: "IDENTITY_GATES_PASSED", executionAuthority: "NONE",
    },
  };
}

test("complete scheduler handoff reaches lifecycle; each independent identity corruption blocks", async () => {
  const { h, state } = await naturalFixture();
  const row = boundNaturalObservation(state, "valid-cycle", "valid-row", T0 + FOUR_HOURS, { open: 100, high: 102, low: 99, close: 101 });
  const valid = await run(h, { state, cycle: cycle("valid-cycle", T0 + FOUR_HOURS), positionObservations: [row] });
  assert.equal(valid.state.positions[0].lifecycle.mark.observationCount, 1);
  assert.equal(valid.state.settlements.length, 0);
  for (const change of [
    (o) => { delete o.schedulerHandoff; },
    (o) => { o.schedulerHandoff.cycleIdentity.cycleId = "other"; },
    (o) => { o.schedulerHandoff.accountIdentity.accountIdSha256 = "f".repeat(64); },
    (o) => { o.schedulerHandoff.entryProvenance.evidenceSnapshotDigest = "f".repeat(64); },
    (o) => { o.schedulerHandoff.riskPolicyIdentity.policyId = "other"; },
    (o) => { o.schedulerHandoff.costPolicyIdentity.version = "other"; },
    (o) => { o.schedulerHandoff.positionIdentity.researchCodeSha = "f".repeat(40); },
    (o) => { o.schedulerHandoff.positionIdentity.positionId = "other"; },
    (o) => { o.schedulerHandoff.positionIdentity.paperSampleId = "other"; },
    (o) => { o.naturalEvidence.synthetic = true; },
    (o) => { o.naturalEvidence.replay = true; },
    (o) => { o.naturalEvidence.backfill = true; },
    (o) => { o.naturalEvidence.duplicate = true; },
  ]) {
    const invalid = structuredClone(row);
    change(invalid);
    const blocked = await run(h, { state, cycle: cycle("valid-cycle", T0 + FOUR_HOURS), positionObservations: [invalid] });
    assert.deepEqual(blocked.state.positions, state.positions);
    assert.equal(blocked.state.settlements.length, 0);
  }
});

test("delayed evidence for the exact original trigger settles at trigger time and only once", async () => {
  const h = harness();
  const opened = await open(h);
  const first = observation(opened.state.positions[0], "trigger", T0 + 1_000, { open: 100, high: 106, low: 99, close: 105 });
  const complete = structuredClone(first);
  first.settlementCostEvidence = null;
  const pending = await run(h, { state: opened.state, cycle: cycle("trigger", T0 + 1_000), positionObservations: [first] });
  const restored = restoreRecurringPaperLoopState(serializeRecurringPaperLoopState(pending.state), identity);
  const trigger = restored.positions[0].lifecycle.pendingExit;
  complete.settlementInput.exitTriggerId = trigger.exitTriggerId;
  complete.settlementCostEvidence.exitTriggerId = trigger.exitTriggerId;
  const result = await run(h, { state: restored, cycle: cycle("late-cost", T0 + 5_000), positionObservations: [complete] });
  assert.equal(result.state.settlements.length, 1);
  assert.equal(result.state.settlements[0].settledAtMs, T0 + 1_000);
  assert.equal(result.state.settlements[0].settlementRecordedAtMs, T0 + 5_000);
  assert.equal(result.state.settlements[0].positionLifecycle.mark.observationCount, 1);
  assert.equal(result.state.settlements[0].naturalSampleCredit, 0);
  const duplicate = await run(h, { state: result.state, cycle: cycle("duplicate-cost", T0 + 6_000), positionObservations: [complete] });
  assert.equal(duplicate.state.settlements.length, 1);
  assert.equal(h.getSettlementMutations(), 1);
});

for (const component of ["commission", "tax", "spread", "slippage", "funding", "latency", "liquidityImpact", "partialFillImpact"]) {
  test(`Full Cost ${component} missing or numeric mismatch cannot settle`, async () => {
    const h = harness();
    const opened = await open(h);
    for (const mode of ["missing", "mismatch", "unknown", "wrong-policy"]) {
      const row = observation(opened.state.positions[0], "exit", T0 + 1_000, { open: 100, high: 106, low: 99, close: 105 });
      if (mode === "missing") delete row.settlementCostEvidence.components[component];
      if (mode === "mismatch") row.settlementInput.exitExecution.costPolicy[component + "Rate"] += 0.001;
      if (mode === "unknown") row.settlementCostEvidence.components[component].status = "UNKNOWN";
      if (mode === "wrong-policy") row.settlementCostEvidence.components[component].policyIdentity.version = "wrong";
      const result = await run(h, { state: opened.state, cycle: cycle("exit", T0 + 1_000), positionObservations: [row] });
      assert.equal(result.state.settlements.length, 0, component + ":" + mode);
      assert.equal(h.getSettlementMutations(), 0);
    }
  });
}

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
    status: "PRESENT",
    valuePercent: value,
    quality: ["tax", "funding"].includes(name) ? "NOT_APPLICABLE" : name === "commission" ? "DOCUMENTED" : "OBSERVED",
    source: `test-only-${name}-producer`,
    provenance: "contract-fixture-runtime-credit-zero",
    policyIdentity: { version: "cost-v1" },
    observedAtMs: now - 1,
    countsAsExecutionCost: true,
    unavailableIsZero: false,
  });
  return {
    schemaVersion: "authoritative-paper-execution-cost-sources-v1",
    status: "PRESENT",
    fullCostReady: true,
    maximumAgeMs: 60_000,
    components: {
      commission: component("commission", 0.1),
      tax: component("tax"),
      spread: component("spread"),
      slippage: component("slippage"),
      funding: component("funding"),
      latency: component("latency"),
      liquidityImpact: component("liquidity-impact"),
      partialFillImpact: component("partial-fill-impact"),
    },
    supplementalCostInput: { costPolicyId: "cost-v1" },
    costPolicyIdentity: { version: "cost-v1" },
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
  };
}

function authoritativeTriggerSettlementEvidence(position, trigger, triggerObservation, evaluatedAtMs) {
  const sourceIdentity = "CANONICAL_PUBLIC_SETTLEMENT_AGGREGATOR_V1";
  const provenanceId = sha256(`settlement:${position.positionId}:${trigger.exitTriggerId}`);
  const positionIdentity = {
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    signalId: position.signalId,
    market: position.market,
    symbol: position.symbol,
    direction: position.direction,
    strategyId: position.strategyId,
    strategyVersion: position.strategyVersion,
    parameterHash: position.parameterHash,
    researchCodeSha: position.researchCodeSha,
    costPolicyVersion: position.costPolicyVersion,
  };
  const exitExecutionIdentity = {
    exitTriggerId: trigger.exitTriggerId,
    triggerObservationId: trigger.triggerObservationId,
    triggeredAtMs: trigger.triggeredAtMs,
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    market: position.market,
    symbol: position.symbol,
    direction: position.direction,
    costPolicyVersion: position.costPolicyVersion,
    sourceIdentity,
    provenanceId,
    exitExecutionDigest: sha256(stableJson(triggerObservation.settlementInput.exitExecution)),
  };
  const maximumAgeMs = 60_000;
  const observedAtMs = evaluatedAtMs - 1;
  const settlementCostEvidence = structuredClone(triggerObservation.settlementCostEvidence);
  settlementCostEvidence.exitTriggerId = trigger.exitTriggerId;
  settlementCostEvidence.sourceIdentity = sourceIdentity;
  settlementCostEvidence.provenanceId = provenanceId;
  settlementCostEvidence.positionIdentity = positionIdentity;
  settlementCostEvidence.exitExecutionIdentity = exitExecutionIdentity;
  settlementCostEvidence.projectedFundingRealized = false;
  for (const [name, component] of Object.entries(settlementCostEvidence.components)) {
    component.sourceIdentity = `CANONICAL_${name.toUpperCase()}_SOURCE_V1`;
    component.provenanceId = sha256(`settlement:${name}:${trigger.exitTriggerId}`);
    component.positionIdentity = positionIdentity;
    component.exitExecutionIdentity = exitExecutionIdentity;
    component.observedAtMs = observedAtMs;
    component.freshness = { observedAtMs, maximumAgeMs };
    if (name === "funding") {
      component.realized = false;
      component.projectedIsRealized = false;
    }
  }
  return {
    schemaVersion: AUTHORITATIVE_NATURAL_PAPER_TRIGGER_SETTLEMENT_EVIDENCE_VERSION,
    status: "PRESENT",
    fullCostReady: true,
    sourceIdentity,
    provenanceId,
    positionIdentity,
    exitExecutionIdentity,
    freshness: { observedAtMs, maximumAgeMs },
    settlementInput: {
      ...structuredClone(triggerObservation.settlementInput),
      exitTriggerId: trigger.exitTriggerId,
    },
    settlementCostEvidence,
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
    synthetic: false,
    replay: false,
    backfill: false,
    duplicate: false,
    historical: false,
    testOnly: false,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
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

test("pending exit with no settlementInput remains blocked instead of throwing", async () => {
  const h = harness();
  const opened = await open(h, "missing-settlement-input");
  const first = observation(opened.state.positions[0], "missing-input-trigger", T0 + 1_000,
    { open: 100, high: 106, low: 99, close: 105 });
  delete first.settlementInput;
  delete first.settlementCostEvidence;
  const pending = await run(h, {
    state: opened.state,
    cycle: cycle("missing-input-trigger", T0 + 1_000),
    positionObservations: [first],
  });
  assert.equal(pending.state.positions[0].lifecycle.pendingExit.reason, "TAKE_PROFIT");
  const later = observation(pending.state.positions[0], "missing-input-later", T0 + 2_000,
    { open: 100, high: 101, low: 99, close: 100 });
  delete later.settlementInput;
  delete later.settlementCostEvidence;
  const blocked = await run(h, {
    state: pending.state,
    cycle: cycle("missing-input-later", T0 + 2_000),
    positionObservations: [later],
  });
  assert.equal(blocked.state.settlements.length, 0);
  assert.deepEqual(blocked.state.positions[0].lifecycle, pending.state.positions[0].lifecycle);
  assert.equal(h.getSettlementMutations(), 0);
});

test("recurring caller freezes a new trigger before invoking the canonical cost producer", async () => {
  const h = harness();
  const opened = await open(h, "same-cycle-producer");
  const position = opened.state.positions[0];
  const complete = observation(position, "same-cycle-trigger", T0 + 1_000,
    { open: 100, high: 106, low: 99, close: 105 });
  const raw = structuredClone(complete);
  raw.settlementCostEvidence = null;
  let collectedTrigger = null;
  const settlementCostProducer = createNaturalPaperTriggerBoundSettlementCostProducer({
    async collectAuthoritativeEvidence({ position: pendingPosition, exitTrigger, evaluatedAtMs }) {
      collectedTrigger = exitTrigger;
      return authoritativeTriggerSettlementEvidence(pendingPosition, exitTrigger, complete, evaluatedAtMs);
    },
  });
  const result = await run(h, {
    state: opened.state,
    cycle: cycle("same-cycle-trigger", T0 + 1_000),
    positionObservations: [raw],
    settlementCostProducer,
  });
  assert.equal(result.state.positions.length, 0);
  assert.equal(result.state.settlements.length, 1);
  assert.equal(result.state.settlements[0].exitReason, "TAKE_PROFIT");
  assert.equal(result.state.settlements[0].settledAtMs, T0 + 1_000);
  assert.equal(collectedTrigger.exitTriggerId, result.state.settlements[0].lifecycleEvidence.exitTriggerId);
  assert.equal(h.getSettlementMutations(), 1);
});

test("malformed producer output cannot erase a newly frozen exit trigger", async () => {
  const h = harness();
  const opened = await open(h, "malformed-producer");
  const raw = observation(opened.state.positions[0], "malformed-trigger", T0 + 1_000,
    { open: 100, high: 106, low: 99, close: 105 });
  raw.settlementCostEvidence = null;
  const result = await run(h, {
    state: opened.state,
    cycle: cycle("malformed-trigger", T0 + 1_000),
    positionObservations: [raw],
    settlementCostProducer: async () => ({
      status: "PRESENT",
      observation: { ...raw, positionId: "wrong-position" },
    }),
  });
  assert.equal(result.state.settlements.length, 0);
  assert.equal(result.state.positions[0].lifecycle.pendingExit.reason, "TAKE_PROFIT");
  assert.equal(result.state.positions[0].lifecycle.mark.observationCount, 1);
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
for (const [name, mutate] of [
  ["missing handoff", (row) => { delete row.schedulerHandoff; }],
  ["wrong cycle", (row) => { row.schedulerHandoff.cycleIdentity.cycleId = "wrong-cycle"; }],
  ["wrong account", (row) => { row.schedulerHandoff.accountIdentity.accountIdSha256 = "f".repeat(64); }],
  ["wrong entry", (row) => { row.schedulerHandoff.entryProvenance.evidenceSnapshotDigest = "f".repeat(64); }],
  ["wrong risk", (row) => { row.schedulerHandoff.riskPolicyIdentity.policyId = "wrong"; }],
  ["wrong cost", (row) => { row.schedulerHandoff.costPolicyIdentity.version = "wrong"; }],
  ["wrong research SHA", (row) => { row.schedulerHandoff.positionIdentity.researchCodeSha = "f".repeat(40); }],
  ["wrong position", (row) => { row.schedulerHandoff.positionIdentity.positionId = "wrong"; }],
  ["wrong sample", (row) => { row.schedulerHandoff.positionIdentity.paperSampleId = "wrong"; }],
]) {
  test(`direct recurring caller rejects ${name} without mutating Natural Position`, async () => {
    const h = harness();
    const opened = await open(h, name, {
      testOnly: false,
      naturalEvidence: naturalEvidence("entry", T0 - 1),
      riskEvidence: { status: "APPROVED", evaluatedAtMs: T0 - 1, simulatedOnly: true, policyIdentity: RISK_POLICY_IDENTITY },
    });
    const p = opened.state.positions[0];
    const now = T0 + 1_000;
    const row = observation(p, "direct-observation", now, { open: 100, high: 103, low: 98, close: 102 }, {
      signalId: p.signalId,
      naturalEvidence: naturalEvidence("direct-observation", now),
      schedulerHandoff: {
        schemaVersion: "paper-scheduler-position-observation-handoff-v1",
        cycleIdentity: { cycleId: "observe", identityFingerprint: opened.state.identityFingerprint, scheduledAtMs: now, startedAtMs: now },
        accountIdentity: { publisherAccountIdSha256: "d".repeat(64), sourceSha: SHA, accountIdSha256: sha256("paper-account") },
        positionIdentity: { ...p.lifecycle.identity },
        entryProvenance: structuredClone(p.sample.entryEvidenceProvenance),
        riskPolicyIdentity: { ...RISK_POLICY_IDENTITY },
        costPolicyIdentity: { version: p.costPolicyVersion },
        naturalSampleCreditAuthority: "IDENTITY_GATES_PASSED",
        executionAuthority: "NONE",
      },
    });
    mutate(row);
    const result = await run(h, { state: opened.state, cycle: cycle("observe", now), positionObservations: [row] });
    assert.deepEqual(result.state.positions, opened.state.positions);
    assert.equal(result.state.settlements.length, 0);
    assert.equal(h.getSettlementMutations(), 0);
  });
}

for (const [reason, bar, options] of [
  ["TAKE_PROFIT", { open: 100, high: 106, low: 99, close: 105 }, {}],
  ["STOP_LOSS", { open: 100, high: 101, low: 94, close: 95 }, {}],
  ["TIMEOUT", { open: 100, high: 101, low: 99, close: 100 }, { signal: { expiresAtMs: T0 + 1_000 } }],
  ["INVALIDATION", { open: 100, high: 101, low: 99, close: 100 }, { signal: { invalidationPolicyId: "regime-v1" } }],
]) {
  test(`${reason} pending trigger rejects later quote and freezes its path`, async () => {
    const h = harness();
    const opened = await open(h, reason, options);
    const p = opened.state.positions[0];
    const completeTriggerObservation = observation(p, "trigger", T0 + 1_000, bar);
    const first = {
      ...structuredClone(completeTriggerObservation),
      settlementCostEvidence: null,
      ...(reason === "INVALIDATION" ? { invalidationEvidence: {
        status: "PRESENT", invalidated: true, policyId: "regime-v1", source: "fixture",
        provenance: "test-only", observedAtMs: T0 + 1_000,
      } } : {}),
    };
    const pending = await run(h, { state: opened.state, cycle: cycle("trigger", T0 + 1_000), positionObservations: [first] });
    assert.equal(pending.state.positions[0].lifecycle.pendingExit.reason, reason);
    const later = observation(pending.state.positions[0], "later", T0 + 2_000, { open: 100, high: 200, low: 1, close: 150 });
    const result = await run(h, { state: pending.state, cycle: cycle("later", T0 + 2_000), positionObservations: [later] });
    assert.equal(result.state.settlements.length, 0);
    assert.deepEqual(result.state.positions[0].lifecycle, pending.state.positions[0].lifecycle);
    assert.equal(h.getSettlementMutations(), 0);

    const trigger = result.state.positions[0].lifecycle.pendingExit;
    const authoritativeEvidence = authoritativeTriggerSettlementEvidence(
      result.state.positions[0],
      trigger,
      completeTriggerObservation,
      T0 + 3_000,
    );
    const settlementCostProducer = createNaturalPaperTriggerBoundSettlementCostProducer({
      async collectAuthoritativeEvidence() { return authoritativeEvidence; },
    });
    const evidenceObservation = observation(
      result.state.positions[0],
      "trigger-bound-cost",
      T0 + 3_000,
      { open: 100, high: 101, low: 99, close: 100 },
    );
    const settled = await run(h, {
      state: result.state,
      cycle: cycle("trigger-bound-cost", T0 + 3_000),
      positionObservations: [evidenceObservation],
      settlementCostProducer,
    });
    assert.equal(settled.state.settlements.length, 1);
    assert.equal(settled.state.settlements[0].exitReason, reason);
    assert.equal(settled.state.settlements[0].settledAtMs, T0 + 1_000);
    assert.equal(h.getSettlementMutations(), 1);
  });
}

for (const missing of ["commission", "tax"]) {
  test(`Full Cost cannot settle with ${missing} absent`, async () => {
    const h = harness();
    const opened = await open(h);
    const row = observation(opened.state.positions[0], "exit", T0 + 1_000, { open: 100, high: 106, low: 99, close: 105 });
    delete row.settlementCostEvidence.components[missing];
    const result = await run(h, { state: opened.state, cycle: cycle("exit", T0 + 1_000), positionObservations: [row] });
    assert.equal(result.state.settlements.length, 0);
    assert.equal(h.getSettlementMutations(), 0);
  });
}

test("Natural frozen exit trigger hashes scheduler identity lineage without Settlement credit", async () => {
  const { h, state } = await naturalFixture();
  const now = T0 + FOUR_HOURS;
  const cycleId = "trigger-binding-cycle";
  const row = boundNaturalObservation(state, cycleId, "trigger-binding-observation", now,
    { open: 100, high: 106, low: 99, close: 105 });
  row.settlementCostEvidence = null;
  const result = await run(h, { state, cycle: cycle(cycleId, now), positionObservations: [row] });
  assert.equal(result.state.settlements.length, 0);
  assert.equal(h.getSettlementMutations(), 0);
  assert.equal(result.state.positions.length, 1);
  const trigger = result.state.positions[0].lifecycle.pendingExit;
  assert.ok(trigger);
  assert.equal(trigger.reason, "TAKE_PROFIT");
  assert.equal(trigger.triggerObservationId, row.observationId);
  assert.equal(trigger.triggeredAtMs, now);
  assert.equal(trigger.positionId, state.positions[0].positionId);
  assert.equal(trigger.entryId, state.positions[0].paperSampleId);
  assert.equal(trigger.cycleId, cycleId);
  assert.equal(trigger.accountIdSha256, sha256(state.ledger.accountBinding.accountId));
  assert.equal(trigger.strategyId, state.positions[0].strategyId);
  assert.equal(trigger.costPolicyId, state.positions[0].costPolicyVersion);
  assert.equal(trigger.riskPolicyId, RISK_POLICY_IDENTITY.policyId);
  assert.equal(trigger.cycleIdentityDigest, row.cycleIdentityDigest);
  assert.equal(trigger.accountIdentityDigest, row.accountIdentityDigest);
  assert.equal(trigger.entryEvidenceDigest, row.entryEvidenceDigest);
  assert.equal(trigger.riskPolicyIdentityDigest, row.riskPolicyIdentityDigest);
  assert.equal(trigger.schedulerHandoffDigest, sha256(stableJson(row.schedulerHandoff)));
  const { exitTriggerId, ...payload } = trigger;
  assert.equal(exitTriggerId, sha256(stableJson(payload)));
});

test("Natural settlement fields supplied directly cannot bypass the canonical trigger-bound producer", async () => {
  const { h, state } = await naturalFixture();
  const now = T0 + FOUR_HOURS;
  const row = boundNaturalObservation(state, "direct-settlement-fields", "direct-settlement-fields", now,
    { open: 100, high: 106, low: 99, close: 105 });
  const result = await run(h, {
    state,
    cycle: cycle("direct-settlement-fields", now),
    positionObservations: [row],
  });
  assert.equal(result.state.settlements.length, 0);
  assert.equal(result.state.positions.length, 1);
  assert.equal(result.state.positions[0].lifecycle.pendingExit.reason, "TAKE_PROFIT");
  assert.equal(h.getSettlementMutations(), 0);
  assert.equal(result.summary.canonicalNaturalStageEvidence.reasonObservations.some(
    (reason) => reason.sourceCode === "PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_BINDING_MISSING",
  ), true);
});

test("genuine Natural pending exit consumes only an exact later trigger-bound producer payload", async () => {
  const { h, state } = await naturalFixture();
  const triggerAtMs = T0 + FOUR_HOURS;
  const completeTriggerObservation = boundNaturalObservation(
    state,
    "natural-trigger",
    "natural-trigger-observation",
    triggerAtMs,
    { open: 100, high: 106, low: 99, close: 105 },
  );
  const triggerObservation = structuredClone(completeTriggerObservation);
  triggerObservation.settlementCostEvidence = null;
  const pending = await run(h, {
    state,
    cycle: cycle("natural-trigger", triggerAtMs),
    positionObservations: [triggerObservation],
  });
  const position = pending.state.positions[0];
  const trigger = position.lifecycle.pendingExit;
  assert.equal(trigger.reason, "TAKE_PROFIT");

  const evidenceAtMs = triggerAtMs + FOUR_HOURS;
  const authoritativeEvidence = authoritativeTriggerSettlementEvidence(
    position,
    trigger,
    completeTriggerObservation,
    evidenceAtMs,
  );
  const settlementCostProducer = createNaturalPaperTriggerBoundSettlementCostProducer({
    async collectAuthoritativeEvidence() { return authoritativeEvidence; },
  });
  const later = boundNaturalObservation(
    pending.state,
    "natural-trigger-cost",
    "natural-trigger-cost-observation",
    evidenceAtMs,
    { open: 105, high: 106, low: 104, close: 105 },
  );
  const settled = await run(h, {
    state: pending.state,
    cycle: cycle("natural-trigger-cost", evidenceAtMs),
    positionObservations: [later],
    settlementCostProducer,
  });
  assert.equal(settled.state.positions.length, 0);
  assert.equal(settled.state.settlements.length, 1);
  assert.equal(settled.state.settlements[0].settledAtMs, triggerAtMs);
  assert.equal(settled.state.settlements[0].lifecycleEvidence.exitTriggerId, trigger.exitTriggerId);
  assert.equal(settled.state.settlements[0].lifecycleEvidence.naturalSampleCredit, 1);
  assert.equal(settled.state.settlements[0].executionAuthority, "NONE");
  assert.equal(h.getSettlementMutations(), 1);
});

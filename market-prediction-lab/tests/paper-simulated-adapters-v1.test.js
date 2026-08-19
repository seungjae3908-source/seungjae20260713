import assert from "node:assert/strict";
import test from "node:test";
import {
  createMemoryPaperLearningStore,
  createSimulatedPaperLearningAdapter,
  createSimulatedPaperLedgerAdapter,
} from "../src/paper-simulated-adapters-v1.js";

const T0 = 1_800_000_000_000;

function safety() {
  return {
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function ledger(status = "READY") {
  return {
    status,
    initialCapitalKrw: 1_000_000,
    baseCurrency: "KRW",
    knownEquityKrw: 1_000_000,
    totalEquityKrw: status === "READY" ? 1_000_000 : null,
    ...safety(),
  };
}

function position() {
  return {
    positionId: "position-1",
    signalId: "signal-1",
    lifecycleState: "OPEN",
    sample: {
      identity: { signalId: "signal-1", market: "US_STOCK" },
      ...safety(),
    },
  };
}

function settlement(overrides = {}) {
  return {
    settlementId: "settlement-1",
    paperSampleId: "sample-1",
    status: "SETTLED",
    market: "US_STOCK",
    strategyId: "profit-first-v1",
    strategyVersion: "v1",
    netPnl: 10,
    settledAtMs: T0,
    ...safety(),
    ...overrides,
  };
}

function readyAccounting(overrides = {}) {
  return {
    status: "READY",
    netPnlKrw: 13_500,
    sourceCurrency: "USD",
    fxRateToKrw: 1_350,
    source: "public-fx-fixture",
    version: "fx-v1",
    asOfMs: T0,
    maxAgeMs: 60_000,
    ...overrides,
  };
}

const cycle = { cycleId: "cycle-1", evaluatedAtMs: T0 };

test("entry adapter never creates real-order side effects or fabricates equity movement", async () => {
  const adapter = createSimulatedPaperLedgerAdapter();
  const current = ledger();
  const next = await adapter.applyEntry({ ledger: current, position: position(), cycle });
  assert.equal(next.knownEquityKrw, 1_000_000);
  assert.equal(next.totalEquityKrw, 1_000_000);
  assert.equal(next.liveOrderAllowed, false);
  assert.equal(next.privateTradingApiAllowed, false);
  assert.equal(next.orderSubmitted, false);
  assert.equal(next.exchangeRequestSent, false);
});

test("missing KRW accounting evidence keeps equity partial instead of adding foreign PnL", async () => {
  const adapter = createSimulatedPaperLedgerAdapter();
  const next = await adapter.applySettlement({ ledger: ledger(), settlement: settlement(), settlementId: "settlement-1", cycle });
  assert.equal(next.status, "PARTIAL");
  assert.equal(next.knownEquityKrw, 1_000_000);
  assert.equal(next.totalEquityKrw, null);
  assert.equal(next.pendingAccounting.length, 1);
  assert.equal(next.pendingAccounting[0].reason, "KRW_ACCOUNTING_EVIDENCE_MISSING");
  assert.deepEqual(next.appliedSettlementIds, []);
});

test("verified KRW accounting evidence applies once and replay does not requery FX", async () => {
  let calls = 0;
  const adapter = createSimulatedPaperLedgerAdapter({
    accountingEvidenceForSettlement: async () => {
      calls += 1;
      return readyAccounting();
    },
  });
  const first = await adapter.applySettlement({ ledger: ledger(), settlement: settlement(), settlementId: "settlement-1", cycle });
  assert.equal(first.status, "READY");
  assert.equal(first.knownEquityKrw, 1_013_500);
  assert.equal(first.totalEquityKrw, 1_013_500);
  assert.deepEqual(first.appliedSettlementIds, ["settlement-1"]);
  const replay = await adapter.applySettlement({ ledger: first, settlement: settlement(), settlementId: "settlement-1", cycle });
  assert.equal(replay.knownEquityKrw, 1_013_500);
  assert.deepEqual(replay.appliedSettlementIds, ["settlement-1"]);
  assert.equal(calls, 1);
});

test("pending accounting can be reconciled later when fresh FX evidence becomes available", async () => {
  let available = false;
  const adapter = createSimulatedPaperLedgerAdapter({
    accountingEvidenceForSettlement: async () => available ? readyAccounting() : { status: "MISSING" },
  });
  const partial = await adapter.applySettlement({ ledger: ledger(), settlement: settlement(), settlementId: "settlement-1", cycle });
  assert.equal(partial.status, "PARTIAL");
  assert.equal(partial.pendingAccounting.length, 1);
  available = true;
  const reconciled = await adapter.applySettlement({ ledger: partial, settlement: settlement(), settlementId: "settlement-1", cycle });
  assert.equal(reconciled.status, "READY");
  assert.equal(reconciled.pendingAccounting.length, 0);
  assert.equal(reconciled.knownEquityKrw, 1_013_500);
  assert.deepEqual(reconciled.appliedSettlementIds, ["settlement-1"]);
});

test("future and stale accounting evidence fail closed", async () => {
  for (const [evidence, expected] of [
    [readyAccounting({ asOfMs: T0 + 1 }), /FUTURE_EVIDENCE_FORBIDDEN/],
    [readyAccounting({ asOfMs: T0 - 60_001 }), /STALE_EVIDENCE_FORBIDDEN/],
  ]) {
    const adapter = createSimulatedPaperLedgerAdapter({ accountingEvidenceForSettlement: async () => evidence });
    await assert.rejects(
      () => adapter.applySettlement({ ledger: ledger(), settlement: settlement(), settlementId: "settlement-1", cycle }),
      expected,
    );
  }
});

test("currency and KRW conversion mismatch fail closed", async () => {
  for (const [evidence, expected] of [
    [readyAccounting({ sourceCurrency: "KRW", fxRateToKrw: 1, netPnlKrw: 10 }), /CURRENCY_MISMATCH/],
    [readyAccounting({ netPnlKrw: 13_499 }), /CONVERSION_MISMATCH/],
  ]) {
    const adapter = createSimulatedPaperLedgerAdapter({ accountingEvidenceForSettlement: async () => evidence });
    await assert.rejects(
      () => adapter.applySettlement({ ledger: ledger(), settlement: settlement(), settlementId: "settlement-1", cycle }),
      expected,
    );
  }
});

test("learning adapter persists signals and outcomes with idempotency keys", async () => {
  const store = createMemoryPaperLearningStore();
  const adapter = createSimulatedPaperLearningAdapter({ learningStore: store });
  const signalPayload = {
    cycle,
    identity: { strategyId: "profit-first-v1", strategyVersion: "v1" },
    sample: { identity: { signalId: "signal-1", market: "US_STOCK" }, ...safety() },
  };
  const first = await adapter.persistSignal(signalPayload);
  const replay = await adapter.persistSignal(signalPayload);
  assert.equal(first.inserted, true);
  assert.equal(replay.inserted, false);

  const outcomePayload = {
    cycle,
    identity: { strategyId: "profit-first-v1", strategyVersion: "v1" },
    position: position(),
    settlement: settlement(),
  };
  const outcome = await adapter.persistOutcome(outcomePayload);
  const outcomeReplay = await adapter.persistOutcome(outcomePayload);
  assert.equal(outcome.inserted, true);
  assert.equal(outcomeReplay.inserted, false);
  assert.deepEqual(store.snapshot().map((row) => row.key).sort(), ["paper-outcome:settlement-1", "paper-signal:signal-1"]);
});

test("unsafe samples are rejected before ledger mutation", async () => {
  const adapter = createSimulatedPaperLedgerAdapter();
  const unsafe = position();
  unsafe.sample.liveOrderAllowed = true;
  await assert.rejects(() => adapter.applyEntry({ ledger: ledger(), position: unsafe, cycle }), /SAFETY_VIOLATION/);
});

test("unsafe learning inputs are rejected before persistence", async () => {
  const store = createMemoryPaperLearningStore();
  const adapter = createSimulatedPaperLearningAdapter({ learningStore: store });
  const unsafeSample = { identity: { signalId: "unsafe-signal", market: "US_STOCK" }, ...safety(), liveOrderAllowed: true };
  await assert.rejects(
    () => adapter.persistSignal({ cycle, identity: { strategyId: "profit-first-v1", strategyVersion: "v1" }, sample: unsafeSample }),
    /LEARNING_SAMPLE_SAFETY_VIOLATION/,
  );
  await assert.rejects(
    () => adapter.persistOutcome({
      cycle,
      identity: { strategyId: "profit-first-v1", strategyVersion: "v1" },
      position: position(),
      settlement: settlement({ liveOrderAllowed: true }),
    }),
    /LEARNING_SETTLEMENT_SAFETY_VIOLATION/,
  );
  assert.deepEqual(store.snapshot(), []);
});

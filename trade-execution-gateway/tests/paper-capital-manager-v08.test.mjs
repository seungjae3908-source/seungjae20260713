import assert from "node:assert/strict";
import test from "node:test";
import { PaperCompoundingCapitalManager } from "../src/paper-capital-manager.mjs";

const T0 = Date.parse("2026-08-25T14:00:00.000Z");

function settlement(sequence, equity, overrides = {}) {
  return {
    mode: "PAPER",
    settled: true,
    simulated: true,
    source: "PAPER_SETTLEMENT_ENGINE",
    settlementId: `paper-settlement-${sequence}`,
    sequence,
    settledAccountEquityKrw: equity,
    observedAt: new Date(T0 + sequence * 1_000).toISOString(),
    privateApiUsed: false,
    realAccountMutation: false,
    externalWithdrawalPerformed: false,
    ...overrides,
  };
}

test("initial capital is capped at 1,000,000 KRW and excess account cash is excluded", async () => {
  const manager = new PaperCompoundingCapitalManager();
  const state = await manager.applySettlement(settlement(1, 1_250_000), { nowMs: T0 + 10_000 });
  assert.equal(state.compoundBaseKrw, 1_000_000);
  assert.equal(state.highWatermarkBaseKrw, 1_000_000);
  assert.equal(state.initialExcludedCapitalKrw, 250_000);
  assert.equal(state.effectiveTradingCapitalKrw, 1_000_000);
  assert.equal(state.nextProfitTriggerKrw, 1_100_000);
  assert.equal(state.profitReserveKrw, 0);
});

test("600k -> 660k locks 30k reserve and compounds only the other 30k", async () => {
  const manager = new PaperCompoundingCapitalManager();
  await manager.applySettlement(settlement(1, 600_000), { nowMs: T0 + 10_000 });
  const state = await manager.applySettlement(settlement(2, 660_000), { nowMs: T0 + 10_000 });
  assert.equal(state.reserveStepsCreated, 1);
  assert.equal(state.profitReserveKrw, 30_000);
  assert.equal(state.compoundBaseKrw, 630_000);
  assert.equal(state.highWatermarkBaseKrw, 630_000);
  assert.equal(state.managedActiveEquityKrw, 630_000);
  assert.equal(state.effectiveTradingCapitalKrw, 630_000);
  assert.equal(state.nextProfitTriggerKrw, 693_000);
  assert.equal(state.externalWithdrawalPerformed, false);
});

test("drawdown lowers effective trading capital without lowering the high-watermark base", async () => {
  const manager = new PaperCompoundingCapitalManager();
  await manager.applySettlement(settlement(1, 600_000), { nowMs: T0 + 10_000 });
  await manager.applySettlement(settlement(2, 660_000), { nowMs: T0 + 10_000 });
  const drawdown = await manager.applySettlement(settlement(3, 630_000), { nowMs: T0 + 10_000 });
  assert.equal(drawdown.compoundBaseKrw, 630_000);
  assert.equal(drawdown.highWatermarkBaseKrw, 630_000);
  assert.equal(drawdown.profitReserveKrw, 30_000);
  assert.equal(drawdown.managedActiveEquityKrw, 600_000);
  assert.equal(drawdown.effectiveTradingCapitalKrw, 600_000);
  assert.equal(drawdown.nextProfitTriggerKrw, 693_000);
});

test("simple recovery to prior high watermark does not create a second reserve event", async () => {
  const manager = new PaperCompoundingCapitalManager();
  await manager.applySettlement(settlement(1, 600_000), { nowMs: T0 + 10_000 });
  await manager.applySettlement(settlement(2, 660_000), { nowMs: T0 + 10_000 });
  await manager.applySettlement(settlement(3, 630_000), { nowMs: T0 + 10_000 });
  const recovered = await manager.applySettlement(settlement(4, 660_000), { nowMs: T0 + 10_000 });
  assert.equal(recovered.reserveStepsCreated, 0);
  assert.equal(recovered.reserveEventCount, 1);
  assert.equal(recovered.profitReserveKrw, 30_000);
  assert.equal(recovered.compoundBaseKrw, 630_000);
  assert.equal(recovered.effectiveTradingCapitalKrw, 630_000);
});

test("next 10 percent milestone compounds from 630k and locks 31,500 KRW", async () => {
  const manager = new PaperCompoundingCapitalManager();
  await manager.applySettlement(settlement(1, 600_000), { nowMs: T0 + 10_000 });
  await manager.applySettlement(settlement(2, 660_000), { nowMs: T0 + 10_000 });
  const secondMilestone = await manager.applySettlement(settlement(3, 723_000), { nowMs: T0 + 10_000 });
  assert.equal(secondMilestone.reserveStepsCreated, 1);
  assert.equal(secondMilestone.reserveSteps[0].baseBeforeKrw, 630_000);
  assert.equal(secondMilestone.reserveSteps[0].triggerKrw, 693_000);
  assert.equal(secondMilestone.reserveSteps[0].reserveAmountKrw, 31_500);
  assert.equal(secondMilestone.profitReserveKrw, 61_500);
  assert.equal(secondMilestone.compoundBaseKrw, 661_500);
  assert.equal(secondMilestone.effectiveTradingCapitalKrw, 661_500);
  assert.equal(secondMilestone.nextProfitTriggerKrw, 727_650);
});

test("same settlement identity is idempotent but conflicting replay fails closed", async () => {
  const manager = new PaperCompoundingCapitalManager();
  const first = settlement(1, 600_000);
  await manager.applySettlement(first, { nowMs: T0 + 10_000 });
  const replay = await manager.applySettlement(first, { nowMs: T0 + 10_000 });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.reserveStepsCreated, 0);
  await assert.rejects(
    manager.applySettlement({ ...first, settledAccountEquityKrw: 601_000 }, { nowMs: T0 + 10_000 }),
    (error) => error.code === "CAPITAL_SETTLEMENT_IDEMPOTENCY_CONFLICT",
  );
});

test("settlement sequence and timestamp regressions fail closed", async () => {
  const manager = new PaperCompoundingCapitalManager();
  await manager.applySettlement(settlement(1, 600_000), { nowMs: T0 + 10_000 });
  await manager.applySettlement(settlement(2, 610_000), { nowMs: T0 + 10_000 });
  await assert.rejects(
    manager.applySettlement(settlement(1, 620_000, { settlementId: "different-id" }), { nowMs: T0 + 10_000 }),
    (error) => error.code === "CAPITAL_SETTLEMENT_SEQUENCE_REGRESSION",
  );
  await assert.rejects(
    manager.applySettlement(settlement(3, 620_000, { observedAt: new Date(T0).toISOString() }), { nowMs: T0 + 10_000 }),
    (error) => error.code === "CAPITAL_SETTLEMENT_TIME_REGRESSION",
  );
});

test("unsafe live/private/withdrawal assertions are rejected", async () => {
  for (const unsafe of [
    { serverAttested: true },
    { privateApiUsed: true },
    { realAccountMutation: true },
    { externalWithdrawalPerformed: true },
  ]) {
    const manager = new PaperCompoundingCapitalManager();
    await assert.rejects(
      manager.applySettlement(settlement(1, 600_000, unsafe), { nowMs: T0 + 10_000 }),
      (error) => error.code === "UNSAFE_CAPITAL_SETTLEMENT_REJECTED",
    );
  }
});

test("locked reserve integrity breach fails closed instead of spending reserved profit", async () => {
  const manager = new PaperCompoundingCapitalManager();
  await manager.applySettlement(settlement(1, 600_000), { nowMs: T0 + 10_000 });
  await manager.applySettlement(settlement(2, 660_000), { nowMs: T0 + 10_000 });
  await assert.rejects(
    manager.applySettlement(settlement(3, 29_999), { nowMs: T0 + 10_000 }),
    (error) => error.code === "CAPITAL_LOCKED_FUNDS_INTEGRITY_BREACH",
  );
});

test("enabled admission gate binds to latest settlement and enforces current drawdown limit", async () => {
  const manager = new PaperCompoundingCapitalManager({ admissionGateEnabled: true });
  await manager.applySettlement(settlement(1, 600_000), { nowMs: T0 + 10_000 });
  await manager.applySettlement(settlement(2, 660_000), { nowMs: T0 + 10_000 });
  await manager.applySettlement(settlement(3, 630_000), { nowMs: T0 + 10_000 });

  const accepted = manager.assessAdmission({
    settlementId: "paper-settlement-3",
    settlementSequence: 3,
    currentManagedExposureKrw: 450_000,
    requestedNewExposureKrw: 150_000,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.effectiveTradingCapitalKrw, 600_000);
  assert.equal(accepted.availableNewExposureKrw, 150_000);

  assert.throws(
    () => manager.assessAdmission({
      settlementId: "paper-settlement-3",
      settlementSequence: 3,
      currentManagedExposureKrw: 450_000,
      requestedNewExposureKrw: 150_001,
    }),
    (error) => error.code === "COMPOUNDING_CAPITAL_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => manager.assessAdmission({
      settlementId: "paper-settlement-2",
      settlementSequence: 2,
      currentManagedExposureKrw: 0,
      requestedNewExposureKrw: 1,
    }),
    (error) => error.code === "CAPITAL_ADMISSION_STALE_SETTLEMENT",
  );
});

test("disabled admission gate never grants execution authority", () => {
  const manager = new PaperCompoundingCapitalManager({ admissionGateEnabled: false });
  const result = manager.assessAdmission({});
  assert.equal(result.accepted, true);
  assert.equal(result.gateEnabled, false);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveAuthorityGranted, false);
});


test("100만원 KRW virtual Paper wallet initializes without account/order or withdrawal authority", async () => {
  const manager = new PaperCompoundingCapitalManager({ admissionGateEnabled: true });
  const seeded = await manager.initializeVirtualPaperWallet({ nowMs: T0 });
  assert.equal(seeded.initialized, true);
  assert.equal(seeded.initialVirtualSeed.initialCapitalKrw, 1_000_000);
  assert.equal(seeded.effectiveTradingCapitalKrw, 1_000_000);
  assert.equal(seeded.compoundBaseKrw, 1_000_000);
  assert.equal(seeded.nextProfitTriggerKrw, 1_100_000);
  assert.equal(seeded.lastSettlement, null);
  assert.equal(seeded.canonicalSettlementVerified, false);
  assert.equal(seeded.paperOrderAuthorityGranted, false);
  assert.equal(seeded.financialMutationCount, 0);
  assert.equal(seeded.externalWithdrawalPerformed, false);
  assert.equal(seeded.liveAuthorityGranted, false);
  const replay = await manager.initializeVirtualPaperWallet({ nowMs: T0 + 1_000 });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.initialVirtualSeed.createdAt, seeded.initialVirtualSeed.createdAt);
  assert.throws(() => manager.assessAdmission({
    settlementId: "not-a-real-settlement",
    settlementSequence: 1,
    currentManagedExposureKrw: 0,
    requestedNewExposureKrw: 1,
  }), (error) => error.code === "CAPITAL_NOT_INITIALIZED");
  const restored = new PaperCompoundingCapitalManager({ initialState: manager.exportState(), admissionGateEnabled: true });
  assert.equal(restored.getState().initialVirtualSeed.initialCapitalKrw, 1_000_000);
  await restored.applySettlement(settlement(1, 1_000_000), { nowMs: T0 + 10_000 });
  assert.equal(restored.getState().initialVirtualSeed.initialCapitalKrw, 1_000_000);
  assert.equal(restored.getState().lastSettlement.sequence, 1);
});

test("virtual 1M Paper bootstrap refuses to reset an existing 500k account or a nonmatching restored seed", async () => {
  const manager = new PaperCompoundingCapitalManager();
  await manager.applySettlement(settlement(1, 500_000), { nowMs: T0 + 10_000 });
  const before = manager.exportState();
  await assert.rejects(
    () => manager.initializeVirtualPaperWallet({ nowMs: T0 + 20_000 }),
    (error) => error.code === "CAPITAL_WALLET_ALREADY_INITIALIZED",
  );
  assert.deepEqual(manager.exportState(), before);
  const virtual = new PaperCompoundingCapitalManager();
  await virtual.initializeVirtualPaperWallet({ nowMs: T0 });
  const tampered = structuredClone(virtual.exportState());
  tampered.initialVirtualSeed.initialCapitalKrw = 500_000;
  assert.throws(
    () => new PaperCompoundingCapitalManager({ initialState: tampered }),
    (error) => error.code === "CAPITAL_VIRTUAL_SEED_INVALID",
  );
});

test("virtual Paper bootstrap rolls back its in-memory state if durable persistence fails", async () => {
  const manager = new PaperCompoundingCapitalManager({
    persistState: async () => { throw new Error("DISK_UNAVAILABLE"); },
  });
  await assert.rejects(
    () => manager.initializeVirtualPaperWallet({ nowMs: T0 }),
    (error) => error.code === "CAPITAL_STATE_PERSIST_FAILED",
  );
  assert.equal(manager.getState().initialized, false);
  assert.equal(manager.getState().effectiveTradingCapitalKrw, 0);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PaperCompoundingCapitalManager } from "../src/paper-capital-manager.mjs";
import { FilePaperCapitalStateStore } from "../src/paper-capital-state-store.mjs";

const T0 = Date.parse("2026-08-25T14:00:00.000Z");

function settlement(sequence, equity) {
  return {
    mode: "PAPER",
    settled: true,
    simulated: true,
    source: "PAPER_SETTLEMENT_ENGINE",
    settlementId: `capital-store-${sequence}`,
    sequence,
    settledAccountEquityKrw: equity,
    observedAt: new Date(T0 + sequence * 1_000).toISOString(),
    privateApiUsed: false,
    realAccountMutation: false,
    externalWithdrawalPerformed: false,
  };
}

test("durable compounding state survives restart with reserve and high-watermark intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teg-capital-v08-"));
  try {
    const path = join(dir, "paper-capital.json");
    const store1 = new FilePaperCapitalStateStore(path);
    const manager1 = new PaperCompoundingCapitalManager({
      initialState: await store1.load(),
      persistState: (snapshot, reason) => store1.save(snapshot, reason),
      admissionGateEnabled: true,
    });
    await manager1.applySettlement(settlement(1, 600_000), { nowMs: T0 + 10_000 });
    await manager1.applySettlement(settlement(2, 660_000), { nowMs: T0 + 10_000 });

    const store2 = new FilePaperCapitalStateStore(path);
    const manager2 = new PaperCompoundingCapitalManager({
      initialState: await store2.load(),
      persistState: (snapshot, reason) => store2.save(snapshot, reason),
      admissionGateEnabled: true,
    });
    const restored = manager2.getState();
    assert.equal(restored.compoundBaseKrw, 630_000);
    assert.equal(restored.highWatermarkBaseKrw, 630_000);
    assert.equal(restored.profitReserveKrw, 30_000);
    assert.equal(restored.nextProfitTriggerKrw, 693_000);
    assert.equal(restored.externalWithdrawalSupported, false);
    assert.equal(store2.getHealth().integrityChecksum, "SHA256");
    assert.equal(store2.getHealth().externalWithdrawalPerformed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capital state checksum corruption fails closed instead of silently resetting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teg-capital-corrupt-v08-"));
  try {
    const path = join(dir, "paper-capital.json");
    const store = new FilePaperCapitalStateStore(path);
    const manager = new PaperCompoundingCapitalManager({
      initialState: await store.load(),
      persistState: (snapshot, reason) => store.save(snapshot, reason),
    });
    await manager.applySettlement(settlement(1, 600_000), { nowMs: T0 + 10_000 });
    const document = JSON.parse(await readFile(path, "utf8"));
    document.state.compoundBaseKrw = 999_999;
    await writeFile(path, JSON.stringify(document), "utf8");
    const reopened = new FilePaperCapitalStateStore(path);
    await assert.rejects(reopened.load(), (error) => error.code === "CAPITAL_STATE_CHECKSUM_MISMATCH");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unsafe restored withdrawal/live authority is rejected by durable state validation", async () => {
  const manager = new PaperCompoundingCapitalManager();
  await manager.applySettlement(settlement(1, 600_000), { nowMs: T0 + 10_000 });
  const unsafe = manager.exportState();
  unsafe.externalWithdrawalPerformed = true;
  assert.throws(
    () => new PaperCompoundingCapitalManager({ initialState: unsafe }),
    (error) => error.code === "UNSAFE_CAPITAL_STATE_REJECTED",
  );
});

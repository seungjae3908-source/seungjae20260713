import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PUMP_PROSPECTIVE_SCHEDULE_CONTRACT,
  createFilePumpProspectiveStoreV1,
  runPumpProspectiveScheduledInvocationV1,
} from "../src/crypto-pump-reversal-prospective-store-v1.js";
import { buildPumpProspectivePolicyV1 } from "../src/crypto-pump-reversal-prospective-policy-v1.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const FROZEN = Date.parse("2026-10-01T00:00:00.000Z");
const SHA = "e".repeat(40);

function policy() {
  return buildPumpProspectivePolicyV1({
    researchCodeSha: SHA,
    policyFrozenAtMs: FROZEN,
    eligibleAfterMs: FROZEN + DAY,
  });
}

test("file store initializes outside deploy tree and enforces state-digest CAS", async () => {
  const root = await mkdtemp(join(tmpdir(), "pump-state-"));
  try {
    const p = policy();
    const store = createFilePumpProspectiveStoreV1({ rootDirectory: root });
    const state = await store.initialize(p);
    assert.equal((await store.load(p)).stateDigest, state.stateDigest);

    await assert.rejects(
      () => store.save({
        previousStateDigest: "f".repeat(64),
        state,
        cycleId: "bad-cas",
        completedAtMs: FROZEN + 1,
        runtimeSummary: null,
      }),
      /PUMP_PROSPECTIVE_STORE_CAS_MISMATCH/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduled invocation persists one minute-cycle exactly once and replay is mutation-free", async () => {
  const root = await mkdtemp(join(tmpdir(), "pump-schedule-"));
  try {
    const p = policy();
    const nowMs = FROZEN + DAY + MINUTE;
    let calls = 0;
    const runtime = {
      async run({ state }) {
        calls += 1;
        return {
          state,
          summary: {
            records: state.records.length,
            openPositions: 0,
            exitTriggered: 0,
          },
        };
      },
    };

    const first = await runPumpProspectiveScheduledInvocationV1({
      rootDirectory: root,
      policy: p,
      nowMs,
      ownerId: "test-owner",
      runtime,
    });
    assert.equal(first.status, "COMPLETED");
    assert.equal(calls, 1);
    assert.equal(first.realOrderCount, 0);
    assert.equal(first.executionAuthority, "NONE");

    const second = await runPumpProspectiveScheduledInvocationV1({
      rootDirectory: root,
      policy: p,
      nowMs,
      ownerId: "test-owner",
      runtime,
    });
    assert.equal(second.status, "REPLAYED");
    assert.equal(calls, 1);

    const receiptPath = join(
      root,
      "cycle-receipts",
      first.cycleId.replace(/[^A-Za-z0-9_.:-]/gu, "_") + ".json",
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.profitabilityProven, false);
    assert.equal(receipt.fullCostSettled, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schedule contract remains inactive and cannot imply deployment or trading authority", () => {
  assert.equal(PUMP_PROSPECTIVE_SCHEDULE_CONTRACT.scheduleActive, false);
  assert.equal(PUMP_PROSPECTIVE_SCHEDULE_CONTRACT.productionAppDeployAllowed, false);
  assert.equal(PUMP_PROSPECTIVE_SCHEDULE_CONTRACT.productionMutationAllowed, false);
  assert.equal(PUMP_PROSPECTIVE_SCHEDULE_CONTRACT.privateTradingApiAllowed, false);
  assert.equal(PUMP_PROSPECTIVE_SCHEDULE_CONTRACT.realOrderEnabled, false);
  assert.equal(PUMP_PROSPECTIVE_SCHEDULE_CONTRACT.executionAuthority, "NONE");
});

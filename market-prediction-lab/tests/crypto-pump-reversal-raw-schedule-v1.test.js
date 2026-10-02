import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runPumpRawProspectiveScheduleV1,
} from "../scripts/run-pump-raw-prospective-schedule-v1.mjs";
import {
  buildPumpProspectivePolicyV1,
} from "../src/crypto-pump-reversal-prospective-policy-v1.js";

const SHA = "c".repeat(40);
const FROZEN = Date.parse("2026-10-02T00:00:00.000Z");
const NOW = FROZEN + 2 * 24 * 60 * 60 * 1000;

test("raw schedule invokes Paper runtime with zero execution authority and no economic owners", async () => {
  const root = await mkdtemp(join(tmpdir(), "pump-raw-"));
  try {
    const policyPath = join(root, "policy.json");
    const stateRoot = join(root, "state");
    const policy = buildPumpProspectivePolicyV1({
      researchCodeSha: SHA,
      policyFrozenAtMs: FROZEN,
      eligibleAfterMs: FROZEN + 24 * 60 * 60 * 1000,
    });
    await writeFile(policyPath, JSON.stringify(policy), "utf8");
    let calls = 0;
    const runtime = Object.freeze({ run: async () => ({}) });
    const result = await runPumpRawProspectiveScheduleV1({
      stateRoot,
      policyPath,
      nowMs: NOW,
      runtime,
      invocationRunner: async (input) => {
        calls += 1;
        assert.equal(input.rootDirectory, stateRoot);
        assert.equal(input.policy.candidate.researchCodeSha, SHA);
        assert.equal(input.runtime, runtime);
        return {
          status: "COMPLETED",
          cycleId: "raw-cycle",
          runtime: {
            summary: {
              records: 2,
              waitingNextBar: 0,
              entryMissed: 0,
              openPositions: 1,
              exitTriggered: 1,
              riskSized: 0,
              fullCostSettled: 0,
              netEconomicOutcomesAvailable: 0,
            },
          },
        };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.rawProspectiveScheduleActive, true);
    assert.equal(result.riskSizingOwnerConnected, false);
    assert.equal(result.fullCostSettlementOwnerConnected, false);
    assert.equal(result.economicSampleCreditAllowed, false);
    assert.equal(result.executionAuthority, "NONE");
    assert.equal(result.liveTrading, false);
    assert.equal(result.autoTrading, false);
    assert.equal(result.realOrderEnabled, false);
    assert.equal(result.privateTradingApiAllowed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("raw schedule refuses invalid policy before cycle creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pump-raw-"));
  try {
    const policyPath = join(root, "policy.json");
    await writeFile(policyPath, JSON.stringify({ candidate: { researchCodeSha: SHA } }), "utf8");
    let calls = 0;
    await assert.rejects(
      () => runPumpRawProspectiveScheduleV1({
        stateRoot: join(root, "state"),
        policyPath,
        nowMs: NOW,
        runtime: { run: async () => ({}) },
        invocationRunner: async () => {
          calls += 1;
          return {};
        },
      }),
      /PUMP_RAW_POLICY_INVALID/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

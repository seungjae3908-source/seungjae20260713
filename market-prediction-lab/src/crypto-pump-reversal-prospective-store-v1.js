import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { createFilePaperSchedulerLeaseStore } from "./paper-scheduler-driver-v1.js";
import {
  createPumpProspectiveStateV1,
  restorePumpProspectiveStateV1,
  serializePumpProspectiveStateV1,
  validatePumpProspectiveStateV1,
} from "./crypto-pump-reversal-prospective-state-v1.js";
import { verifyPumpProspectivePolicyV1 } from "./crypto-pump-reversal-prospective-policy-v1.js";
import { createPumpProspectivePaperRuntimeV1 } from "./crypto-pump-reversal-prospective-runtime-v1.js";

export const PUMP_PROSPECTIVE_STORE_VERSION =
  "crypto-pump-reversal-prospective-file-store-v1";
export const PUMP_PROSPECTIVE_SCHEDULE_CADENCE = Object.freeze({
  version: "crypto-pump-reversal-minute-cycle-v1",
  intervalMs: 60_000,
});
export const PUMP_PROSPECTIVE_SCHEDULE_CONTRACT = Object.freeze({
  version: "crypto-pump-reversal-prospective-schedule-contract-v1",
  scheduleActive: false,
  cadenceMs: 60_000,
  signalUniverseScanCadence: "ONCE_PER_CLOSED_1H_BAR",
  positionMonitoringCadence: "INCREMENTAL_CLOSED_1M",
  publicDataOnly: true,
  simulatedOnly: true,
  productionAppDeployAllowed: false,
  productionMutationAllowed: false,
  privateTradingApiAllowed: false,
  realOrderEnabled: false,
  executionAuthority: "NONE",
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertRoot(rootDirectory) {
  if (!nonEmpty(rootDirectory) || !isAbsolute(rootDirectory)) {
    throw new Error("PUMP_PROSPECTIVE_ABSOLUTE_STATE_ROOT_REQUIRED");
  }
  const root = resolve(rootDirectory);
  if (root === "/" || root === "/opt/stock-app" || root.startsWith("/opt/stock-app/")) {
    throw new Error("PUMP_PROSPECTIVE_STATE_ROOT_INSIDE_DEPLOY_TREE_FORBIDDEN");
  }
  return root;
}

async function readTextOrNull(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path, content) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function paths(root) {
  return Object.freeze({
    root,
    state: join(root, "state.json"),
    policy: join(root, "policy.json"),
    leases: join(root, "leases"),
    receipts: join(root, "cycle-receipts"),
  });
}

export function createFilePumpProspectiveStoreV1({ rootDirectory } = {}) {
  const target = paths(assertRoot(rootDirectory));

  return Object.freeze({
    version: PUMP_PROSPECTIVE_STORE_VERSION,
    rootDirectory: target.root,

    async load(policy) {
      const verdict = verifyPumpProspectivePolicyV1(policy);
      if (!verdict.valid) {
        throw new Error(`PUMP_PROSPECTIVE_POLICY_INVALID:${verdict.blockers.join(",")}`);
      }
      const serialized = await readTextOrNull(target.state);
      if (serialized == null) return null;
      return restorePumpProspectiveStateV1(serialized, policy);
    },

    async initialize(policy) {
      const verdict = verifyPumpProspectivePolicyV1(policy);
      if (!verdict.valid) {
        throw new Error(`PUMP_PROSPECTIVE_POLICY_INVALID:${verdict.blockers.join(",")}`);
      }
      await mkdir(target.root, { recursive: true, mode: 0o700 });
      await mkdir(target.receipts, { recursive: true, mode: 0o700 });
      const existing = await readTextOrNull(target.state);
      if (existing != null) return restorePumpProspectiveStateV1(existing, policy);

      const state = createPumpProspectiveStateV1({
        policy,
        createdAtMs: policy.policyFrozenAtMs,
      });
      await atomicWrite(target.policy, `${JSON.stringify(policy, null, 2)}\n`);
      await atomicWrite(target.state, serializePumpProspectiveStateV1(state));
      return state;
    },

    async save({ previousStateDigest, state, cycleId, completedAtMs, runtimeSummary }) {
      validatePumpProspectiveStateV1(state);
      if (!nonEmpty(previousStateDigest) || !nonEmpty(cycleId)
        || !Number.isSafeInteger(completedAtMs) || completedAtMs <= 0) {
        throw new Error("PUMP_PROSPECTIVE_STORE_SAVE_INPUT_INVALID");
      }
      await mkdir(target.root, { recursive: true, mode: 0o700 });
      await mkdir(target.receipts, { recursive: true, mode: 0o700 });

      const currentText = await readTextOrNull(target.state);
      if (currentText == null) throw new Error("PUMP_PROSPECTIVE_STORE_STATE_MISSING");
      const current = JSON.parse(currentText);
      if (current.stateDigest !== previousStateDigest) {
        throw new Error("PUMP_PROSPECTIVE_STORE_CAS_MISMATCH");
      }

      await atomicWrite(target.state, serializePumpProspectiveStateV1(state));
      const receipt = Object.freeze({
        schemaVersion: "crypto-pump-reversal-cycle-receipt-v1",
        cycleId,
        completedAtMs,
        previousStateDigest,
        stateDigest: state.stateDigest,
        records: state.records.length,
        openPositions: state.records.filter((row) => row.status === "OPEN").length,
        exitTriggered: state.records.filter((row) => row.status === "EXIT_TRIGGERED").length,
        fullCostSettled: Number.isInteger(runtimeSummary?.fullCostSettled)
          ? runtimeSummary.fullCostSettled
          : 0,
        netEconomicOutcomesAvailable: Number.isInteger(runtimeSummary?.netEconomicOutcomesAvailable)
          ? runtimeSummary.netEconomicOutcomesAvailable
          : 0,
        runtimeSummary: runtimeSummary ?? null,
        profitabilityProven: false,
        profitabilityClaimAllowed: false,
        profitabilityCredit: 0,
        executionAuthority: "NONE",
      });
      await atomicWrite(
        join(target.receipts, `${cycleId.replace(/[^A-Za-z0-9_.:-]/gu, "_")}.json`),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
      return receipt;
    },

    paths: target,
  });
}

function cycleFor(nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("PUMP_PROSPECTIVE_CYCLE_TIME_INVALID");
  }
  const bucket = Math.floor(nowMs / PUMP_PROSPECTIVE_SCHEDULE_CADENCE.intervalMs);
  return Object.freeze({
    cycleId: `${PUMP_PROSPECTIVE_SCHEDULE_CADENCE.version}:${bucket}`,
    scheduledAtMs: bucket * PUMP_PROSPECTIVE_SCHEDULE_CADENCE.intervalMs,
  });
}

export async function runPumpProspectiveScheduledInvocationV1({
  rootDirectory,
  policy,
  nowMs = Date.now(),
  ownerId = `pump:${process.pid}`,
  runtime = createPumpProspectivePaperRuntimeV1(),
  leaseDurationMs = 55_000,
} = {}) {
  const verdict = verifyPumpProspectivePolicyV1(policy);
  if (!verdict.valid) {
    throw new Error(`PUMP_PROSPECTIVE_POLICY_INVALID:${verdict.blockers.join(",")}`);
  }
  if (!runtime || typeof runtime.run !== "function") {
    throw new TypeError("Pump prospective runtime is required");
  }
  if (!nonEmpty(ownerId) || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000) {
    throw new Error("PUMP_PROSPECTIVE_SCHEDULER_INPUT_INVALID");
  }

  const store = createFilePumpProspectiveStoreV1({ rootDirectory });
  const cycle = cycleFor(nowMs);
  const leaseStore = createFilePaperSchedulerLeaseStore({ directory: store.paths.leases });
  const leaseKey = `pump:${policy.candidate.candidateId}:${cycle.cycleId}`;
  const lease = await leaseStore.acquire({
    leaseKey,
    cycleId: cycle.cycleId,
    ownerId,
    nowMs,
    leaseDurationMs,
  });
  if (!lease.acquired) {
    const existingState = await store.load(policy);
    return Object.freeze({
      schemaVersion: "crypto-pump-reversal-scheduled-invocation-v1",
      status: lease.status === "COMPLETED" ? "REPLAYED" : "BUSY",
      cycleId: cycle.cycleId,
      leaseStatus: lease.status,
      state: existingState,
      schedule: PUMP_PROSPECTIVE_SCHEDULE_CONTRACT,
      executionAuthority: "NONE",
      realOrderCount: 0,
      profitabilityProven: false,
    });
  }

  try {
    let state = await store.load(policy);
    if (state == null) state = await store.initialize(policy);
    const previousStateDigest = state.stateDigest;
    const result = await runtime.run({ state, nowMs });
    state = result.state;
    const receipt = await store.save({
      previousStateDigest,
      state,
      cycleId: cycle.cycleId,
      completedAtMs: nowMs,
      runtimeSummary: result.summary,
    });
    await leaseStore.complete({
      leaseKey,
      cycleId: cycle.cycleId,
      ownerId,
      token: lease.token,
      completedAtMs: nowMs,
      summary: {
        stateDigest: state.stateDigest,
        records: result.summary.records,
        openPositions: result.summary.openPositions,
        exitTriggered: result.summary.exitTriggered,
        fullCostSettled: result.summary.fullCostSettled,
        netEconomicOutcomesAvailable: result.summary.netEconomicOutcomesAvailable,
      },
    });
    return Object.freeze({
      schemaVersion: "crypto-pump-reversal-scheduled-invocation-v1",
      status: "COMPLETED",
      cycleId: cycle.cycleId,
      receipt,
      runtime: result,
      state,
      schedule: PUMP_PROSPECTIVE_SCHEDULE_CONTRACT,
      executionAuthority: "NONE",
      realOrderCount: 0,
      privateRequestCount: 0,
      financialMutationCount: 0,
      profitabilityProven: false,
      profitabilityClaimAllowed: false,
    });
  } catch (error) {
    await leaseStore.release({
      leaseKey,
      ownerId,
      token: lease.token,
    });
    throw error;
  }
}

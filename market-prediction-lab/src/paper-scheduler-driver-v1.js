import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RECURRING_PAPER_MARKETS,
  runRecurringPaperCycle,
} from "./recurring-paper-loop-v1.js";

export const PAPER_SCHEDULER_CONTRACT = Object.freeze({
  version: "paper-scheduler-v1",
  publicDataOnly: true,
  simulatedOnly: true,
  privateAccountAccess: false,
  liveTrading: false,
  orderAuthority: false,
  scheduleActive: false,
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cycleFor({ cadence, identityFingerprint, nowMs }) {
  if (!cadence || !nonEmpty(cadence.version) || !positiveInteger(cadence.intervalMs)) {
    throw new TypeError("cadence.version and cadence.intervalMs are required");
  }
  if (!nonEmpty(identityFingerprint) || !Number.isFinite(nowMs)) {
    throw new TypeError("identityFingerprint and finite nowMs are required");
  }
  const window = Math.floor(nowMs / cadence.intervalMs);
  return Object.freeze({
    cycleId: `${cadence.version}:${window}`,
    scheduledAtMs: window * cadence.intervalMs,
    evaluatedAtMs: nowMs,
    leaseKey: `paper:${identityFingerprint}:${cadence.version}:${window}`,
  });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonExclusive(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
}

/**
 * Durable local CAS boundary. Atomic directory creation elects one process; a
 * completion marker makes stale-state retries replay instead of mutating again.
 */
export function createFilePaperSchedulerLeaseStore({ directory }) {
  if (!nonEmpty(directory)) throw new TypeError("lease directory is required");

  function paths(leaseKey) {
    const name = hash(leaseKey);
    return {
      lease: join(directory, `${name}.lease`),
      owner: join(directory, `${name}.lease`, "owner.json"),
      completed: join(directory, `${name}.complete.json`),
    };
  }

  async function acquire({ leaseKey, cycleId, ownerId, nowMs, leaseDurationMs }) {
    if (![leaseKey, cycleId, ownerId].every(nonEmpty) || !Number.isFinite(nowMs) || !positiveInteger(leaseDurationMs)) {
      throw new TypeError("valid lease acquisition fields are required");
    }
    await mkdir(directory, { recursive: true });
    const target = paths(leaseKey);
    const completed = await readJson(target.completed);
    if (completed?.cycleId === cycleId) return Object.freeze({ acquired: false, status: "COMPLETED", completed });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomUUID();
      try {
        await mkdir(target.lease);
        const owner = Object.freeze({ leaseKey, cycleId, ownerId, token, expiresAtMs: nowMs + leaseDurationMs });
        await writeJsonExclusive(target.owner, owner);
        return Object.freeze({ acquired: true, status: "ACQUIRED", ...owner });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          await rm(target.lease, { recursive: true, force: true });
          throw error;
        }
      }

      const active = await readJson(target.owner);
      if (!active || !Number.isFinite(active.expiresAtMs) || active.expiresAtMs > nowMs) {
        return Object.freeze({ acquired: false, status: "BUSY", ownerId: active?.ownerId ?? null, expiresAtMs: active?.expiresAtMs ?? null });
      }

      const tombstone = `${target.lease}.expired-${ownerId}-${randomUUID()}`;
      try {
        await rename(target.lease, tombstone);
        await rm(tombstone, { recursive: true, force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return Object.freeze({ acquired: false, status: "BUSY", ownerId: null, expiresAtMs: null });
  }

  async function assertOwner(leaseKey, token) {
    const target = paths(leaseKey);
    const owner = await readJson(target.owner);
    if (!owner || owner.token !== token) throw new Error("paper scheduler lease ownership lost");
    return { target, owner };
  }

  async function complete({ leaseKey, cycleId, ownerId, token, completedAtMs, summary }) {
    const { target, owner } = await assertOwner(leaseKey, token);
    if (owner.ownerId !== ownerId || owner.cycleId !== cycleId) throw new Error("paper scheduler lease identity mismatch");
    const completion = { cycleId, ownerId, completedAtMs, summary };
    try {
      await writeJsonExclusive(target.completed, completion);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readJson(target.completed);
      if (existing?.cycleId !== cycleId) throw new Error("paper scheduler completion CAS mismatch");
    }
    await rm(target.lease, { recursive: true, force: true });
    return Object.freeze(completion);
  }

  async function release({ leaseKey, token }) {
    const target = paths(leaseKey);
    const owner = await readJson(target.owner);
    if (owner?.token === token) await rm(target.lease, { recursive: true, force: true });
  }

  return Object.freeze({ acquire, complete, release });
}

function retryableProviderError(error) {
  return error?.status === 429 || error?.code === "PROVIDER_RATE_LIMITED";
}

async function collectLane({ provider, market, cycle, retry, sleep }) {
  let lastError;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error("public evidence provider timed out"), { code: "PROVIDER_TIMEOUT" }));
        }, retry.timeoutMs);
      });
      const result = await Promise.race([
        provider.collectPublicEvidence({ market, cycle, attempt, signal: controller.signal }),
        timeout,
      ]).finally(() => clearTimeout(timer));
      if (!result || result.publicOnly !== true) throw new Error("provider evidence is not explicitly public-only");
      return { market, result };
    } catch (error) {
      lastError = error;
      if (!retryableProviderError(error) || attempt === retry.maxAttempts) break;
      await sleep(retry.baseBackoffMs * attempt);
    }
  }
  return { market, error: lastError };
}

function evidenceBlock(lane, evaluatedAtMs) {
  if (lane.error?.status === 429) return "PROVIDER_RATE_LIMITED";
  if (lane.error?.code === "PROVIDER_TIMEOUT") return "PROVIDER_TIMEOUT";
  if (lane.error) return "PROVIDER_FAILED";
  const evidence = lane.result;
  if (evidence.status === "BLOCKED_DATA") return "BLOCKED_DATA";
  if (evidence.status !== "READY") return "INVALID_PROVIDER_STATUS";
  if (!Number.isFinite(evidence.observedAtMs) || !positiveInteger(evidence.maxAgeMs)) return "INVALID_EVIDENCE_TIME";
  if (evidence.observedAtMs > evaluatedAtMs) return "FUTURE_EVIDENCE";
  if (evaluatedAtMs - evidence.observedAtMs > evidence.maxAgeMs) return "STALE_EVIDENCE";
  if (!Array.isArray(evidence.candidates) || !Array.isArray(evidence.exits)) return "INVALID_EVIDENCE_PAYLOAD";
  return null;
}

export async function runScheduledPaperCycle({
  state,
  cadence,
  nowMs,
  ownerId,
  leaseStore,
  leaseDurationMs,
  publicEvidenceProvider,
  ledgerAdapter,
  learningAdapter,
  stateStore,
  retry = { maxAttempts: 3, baseBackoffMs: 250, timeoutMs: 5_000 },
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  runCycle = runRecurringPaperCycle,
} = {}) {
  if (!state || !nonEmpty(state.identityFingerprint)) throw new TypeError("canonical Paper state is required");
  if (!nonEmpty(ownerId) || !leaseStore || !publicEvidenceProvider) throw new TypeError("owner, lease store, and public provider are required");
  if (!positiveInteger(leaseDurationMs) || !positiveInteger(retry?.maxAttempts) || !positiveInteger(retry?.baseBackoffMs) || !positiveInteger(retry?.timeoutMs)) {
    throw new TypeError("bounded lease and retry configuration are required");
  }
  const providerBudgetMs = retry.maxAttempts * retry.timeoutMs
    + retry.baseBackoffMs * ((retry.maxAttempts - 1) * retry.maxAttempts / 2);
  if (leaseDurationMs <= providerBudgetMs) throw new TypeError("leaseDurationMs must exceed the bounded provider retry budget");

  const cycle = cycleFor({ cadence, identityFingerprint: state.identityFingerprint, nowMs });
  const lease = await leaseStore.acquire({ ...cycle, ownerId, nowMs, leaseDurationMs });
  if (!lease.acquired) {
    return Object.freeze({
      status: lease.status === "COMPLETED" ? "REPLAYED" : "SKIPPED_BUSY",
      cycleId: cycle.cycleId,
      mutationCount: 0,
      busyOwnerId: lease.ownerId ?? null,
      safety: PAPER_SCHEDULER_CONTRACT,
    });
  }

  try {
    const lanes = await Promise.all(RECURRING_PAPER_MARKETS.map((market) => collectLane({
      provider: publicEvidenceProvider,
      market,
      cycle,
      retry,
      sleep,
    })));
    const blockers = lanes.map((lane) => ({ market: lane.market, reason: evidenceBlock(lane, cycle.evaluatedAtMs) })).filter((row) => row.reason);
    if (blockers.length > 0) {
      return Object.freeze({ status: "BLOCKED_DATA", cycleId: cycle.cycleId, mutationCount: 0, blockers: Object.freeze(blockers), safety: PAPER_SCHEDULER_CONTRACT });
    }

    const result = await runCycle({
      state,
      cycle: { cycleId: cycle.cycleId, evaluatedAtMs: cycle.evaluatedAtMs },
      candidates: lanes.flatMap((lane) => lane.result.candidates),
      exits: lanes.flatMap((lane) => lane.result.exits),
      ledgerAdapter,
      learningAdapter,
      stateStore,
    });
    await leaseStore.complete({
      leaseKey: cycle.leaseKey,
      cycleId: cycle.cycleId,
      ownerId,
      token: lease.token,
      completedAtMs: nowMs,
      summary: result.summary,
    });
    return Object.freeze({ status: "COMPLETED", cycleId: cycle.cycleId, mutationCount: 1, ...result, safety: PAPER_SCHEDULER_CONTRACT });
  } finally {
    await leaseStore.release({ leaseKey: cycle.leaseKey, token: lease.token });
  }
}

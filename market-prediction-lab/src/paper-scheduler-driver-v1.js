import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  RECURRING_PAPER_MARKETS,
  runRecurringPaperCycle,
} from "./recurring-paper-loop-v1.js";

export const PAPER_SCHEDULER_OWNER_LIVENESS = Object.freeze({
  ALIVE: "ALIVE",
  DEAD: "DEAD",
  UNKNOWN: "UNKNOWN",
});

export const PAPER_SCHEDULER_CONTRACT = Object.freeze({
  version: "paper-scheduler-v1",
  publicDataOnly: true,
  simulatedOnly: true,
  privateAccountAccess: false,
  liveTrading: false,
  orderAuthority: false,
  scheduleActive: false,
  leaseScope: "SINGLE_HOST_FILE_CAS",
  distributedMultiHostSupported: false,
  remoteOwnerRecoveryAllowed: false,
  liveOwnerExpiryStealAllowed: false,
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cycleFor({ cadence, identityFingerprint, nowMs }) {
  if (!cadence || !nonEmpty(cadence.version) || !positiveInteger(cadence.intervalMs)) {
    throw new TypeError("cadence.version and cadence.intervalMs are required");
  }
  if (!nonEmpty(identityFingerprint) || !finiteNumber(nowMs)) {
    throw new TypeError("identityFingerprint and finite nowMs are required");
  }
  const window = Math.floor(nowMs / cadence.intervalMs);
  return Object.freeze({
    cycleId: `${cadence.version}:${window}`,
    scheduledAtMs: window * cadence.intervalMs,
    startedAtMs: nowMs,
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

async function readOwner(path) {
  try {
    return { state: "PRESENT", owner: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "MISSING", owner: null };
    if (error instanceof SyntaxError) return { state: "CORRUPT", owner: null };
    throw error;
  }
}

async function writeJsonExclusive(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
}

function ownerRecordValid(owner) {
  return Boolean(
    owner
    && [owner.leaseKey, owner.cycleId, owner.ownerId, owner.token, owner.hostId].every(nonEmpty)
    && positiveInteger(owner.processId)
    && finiteNumber(owner.acquiredAtMs)
    && finiteNumber(owner.recoveryEligibleAtMs),
  );
}

function normalizeLiveness(value) {
  if (value === true || value === PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE) {
    return PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE;
  }
  if (value === false || value === PAPER_SCHEDULER_OWNER_LIVENESS.DEAD) {
    return PAPER_SCHEDULER_OWNER_LIVENESS.DEAD;
  }
  return PAPER_SCHEDULER_OWNER_LIVENESS.UNKNOWN;
}

function defaultOwnerLiveness(owner, { localHostId }) {
  if (owner.hostId !== localHostId) return PAPER_SCHEDULER_OWNER_LIVENESS.UNKNOWN;
  try {
    process.kill(owner.processId, 0);
    return PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE;
  } catch (error) {
    if (error?.code === "ESRCH") return PAPER_SCHEDULER_OWNER_LIVENESS.DEAD;
    if (error?.code === "EPERM") return PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE;
    return PAPER_SCHEDULER_OWNER_LIVENESS.UNKNOWN;
  }
}

async function reclaimLease(target, ownerId) {
  const tombstone = `${target.lease}.reclaim-${ownerId}-${randomUUID()}`;
  try {
    await rename(target.lease, tombstone);
    await rm(tombstone, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Durable single-host CAS boundary.
 *
 * - Atomic directory creation elects one process.
 * - A live local owner is never stolen merely because wall-clock time elapsed.
 * - A definitively dead local owner can be reclaimed.
 * - An ownerless mkdir->owner-write crash is reclaimed only after bounded grace.
 * - Unknown or remote-host ownership fails closed. Multi-host execution requires
 *   a separate distributed CAS implementation.
 */
export function createFilePaperSchedulerLeaseStore({
  directory,
  localHostId = hostname(),
  localProcessId = process.pid,
  ownerLiveness = defaultOwnerLiveness,
} = {}) {
  if (!nonEmpty(directory)) throw new TypeError("lease directory is required");
  if (!nonEmpty(localHostId) || !positiveInteger(localProcessId)) {
    throw new TypeError("local host and process identity are required");
  }
  if (typeof ownerLiveness !== "function") throw new TypeError("ownerLiveness must be a function");

  function paths(leaseKey) {
    const name = hash(leaseKey);
    return {
      lease: join(directory, `${name}.lease`),
      owner: join(directory, `${name}.lease`, "owner.json"),
      completed: join(directory, `${name}.complete.json`),
    };
  }

  async function acquire({ leaseKey, cycleId, ownerId, nowMs, leaseDurationMs }) {
    if (![leaseKey, cycleId, ownerId].every(nonEmpty) || !finiteNumber(nowMs) || !positiveInteger(leaseDurationMs)) {
      throw new TypeError("valid lease acquisition fields are required");
    }
    await mkdir(directory, { recursive: true });
    const target = paths(leaseKey);
    const completed = await readJson(target.completed);
    if (completed?.cycleId === cycleId) {
      return Object.freeze({ acquired: false, status: "COMPLETED", completed });
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = randomUUID();
      try {
        await mkdir(target.lease);
        const owner = Object.freeze({
          leaseKey,
          cycleId,
          ownerId,
          token,
          hostId: localHostId,
          processId: localProcessId,
          acquiredAtMs: nowMs,
          recoveryEligibleAtMs: nowMs + leaseDurationMs,
        });
        try {
          await writeJsonExclusive(target.owner, owner);
        } catch (error) {
          await rm(target.lease, { recursive: true, force: true });
          throw error;
        }
        return Object.freeze({ acquired: true, status: "ACQUIRED", ...owner });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      const activeState = await readOwner(target.owner);
      if (activeState.state === "MISSING") {
        let leaseInfo;
        try {
          leaseInfo = await stat(target.lease);
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          throw error;
        }
        const leaseAgeMs = Math.max(0, nowMs - leaseInfo.mtimeMs);
        if (leaseAgeMs <= leaseDurationMs) {
          return Object.freeze({
            acquired: false,
            status: "BUSY",
            reason: "OWNER_INITIALIZING",
            ownerId: null,
          });
        }
        if (await reclaimLease(target, ownerId)) continue;
        continue;
      }

      if (activeState.state === "CORRUPT" || !ownerRecordValid(activeState.owner)) {
        return Object.freeze({
          acquired: false,
          status: "BUSY",
          reason: activeState.state === "CORRUPT" ? "OWNER_CORRUPT" : "OWNER_INVALID",
          ownerId: null,
        });
      }

      const active = activeState.owner;
      if (active.hostId !== localHostId) {
        return Object.freeze({
          acquired: false,
          status: "BUSY",
          reason: "REMOTE_HOST_OWNER",
          ownerId: active.ownerId,
          hostId: active.hostId,
        });
      }

      const liveness = normalizeLiveness(await ownerLiveness(active, {
        localHostId,
        localProcessId,
        nowMs,
      }));
      if (liveness === PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE) {
        return Object.freeze({
          acquired: false,
          status: "BUSY",
          reason: "LIVE_LOCAL_OWNER",
          ownerId: active.ownerId,
          processId: active.processId,
        });
      }
      if (liveness === PAPER_SCHEDULER_OWNER_LIVENESS.UNKNOWN) {
        return Object.freeze({
          acquired: false,
          status: "BUSY",
          reason: "UNKNOWN_LOCAL_OWNER",
          ownerId: active.ownerId,
          processId: active.processId,
        });
      }

      if (await reclaimLease(target, ownerId)) continue;
    }

    return Object.freeze({
      acquired: false,
      status: "BUSY",
      reason: "LEASE_CONTENTION",
      ownerId: null,
    });
  }

  async function assertOwned({ leaseKey, ownerId, token }) {
    if (![leaseKey, ownerId, token].every(nonEmpty)) {
      throw new TypeError("lease ownership identity is required");
    }
    const target = paths(leaseKey);
    const activeState = await readOwner(target.owner);
    const owner = activeState.owner;
    if (
      activeState.state !== "PRESENT"
      || !ownerRecordValid(owner)
      || owner.token !== token
      || owner.ownerId !== ownerId
      || owner.hostId !== localHostId
      || owner.processId !== localProcessId
    ) {
      throw new Error("paper scheduler lease ownership lost");
    }
    return Object.freeze({ ...owner });
  }

  async function complete({ leaseKey, cycleId, ownerId, token, completedAtMs, summary }) {
    if (!finiteNumber(completedAtMs)) throw new TypeError("completedAtMs must be finite");
    await assertOwned({ leaseKey, ownerId, token });
    const target = paths(leaseKey);
    const completion = {
      cycleId,
      ownerId,
      completedAtMs,
      summary,
    };
    try {
      await writeJsonExclusive(target.completed, completion);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readJson(target.completed);
      if (existing?.cycleId !== cycleId) {
        throw new Error("paper scheduler completion CAS mismatch");
      }
      await rm(target.lease, { recursive: true, force: true });
      return Object.freeze(existing);
    }
    await rm(target.lease, { recursive: true, force: true });
    return Object.freeze(completion);
  }

  async function release({ leaseKey, ownerId, token }) {
    if (![leaseKey, ownerId, token].every(nonEmpty)) return;
    const target = paths(leaseKey);
    const activeState = await readOwner(target.owner);
    const owner = activeState.owner;
    if (
      activeState.state === "PRESENT"
      && ownerRecordValid(owner)
      && owner.token === token
      && owner.ownerId === ownerId
      && owner.hostId === localHostId
      && owner.processId === localProcessId
    ) {
      await rm(target.lease, { recursive: true, force: true });
    }
  }

  return Object.freeze({ acquire, assertOwned, complete, release });
}

function retryableProviderError(error) {
  return error?.status === 429
    || error?.code === "PROVIDER_RATE_LIMITED"
    || error?.code === "PROVIDER_TIMEOUT";
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
          reject(Object.assign(new Error("public evidence provider timed out"), {
            code: "PROVIDER_TIMEOUT",
          }));
        }, retry.timeoutMs);
      });
      const result = await Promise.race([
        provider.collectPublicEvidence({ market, cycle, attempt, signal: controller.signal }),
        timeout,
      ]).finally(() => clearTimeout(timer));
      if (!result || result.publicOnly !== true) {
        throw new Error("provider evidence is not explicitly public-only");
      }
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
  if (lane.error?.status === 429 || lane.error?.code === "PROVIDER_RATE_LIMITED") {
    return "PROVIDER_RATE_LIMITED";
  }
  if (lane.error?.code === "PROVIDER_TIMEOUT") return "PROVIDER_TIMEOUT";
  if (lane.error) return "PROVIDER_FAILED";
  const evidence = lane.result;
  if (evidence.status === "BLOCKED_DATA") return "BLOCKED_DATA";
  if (evidence.status !== "READY") return "INVALID_PROVIDER_STATUS";
  if (!finiteNumber(evidence.observedAtMs) || !positiveInteger(evidence.maxAgeMs)) {
    return "INVALID_EVIDENCE_TIME";
  }
  if (evidence.observedAtMs > evaluatedAtMs) return "FUTURE_EVIDENCE";
  if (evaluatedAtMs - evidence.observedAtMs > evidence.maxAgeMs) return "STALE_EVIDENCE";
  if (!Array.isArray(evidence.candidates) || !Array.isArray(evidence.exits)) {
    return "INVALID_EVIDENCE_PAYLOAD";
  }
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
  clock = Date.now,
  runCycle = runRecurringPaperCycle,
} = {}) {
  if (!state || !nonEmpty(state.identityFingerprint)) {
    throw new TypeError("canonical Paper state is required");
  }
  if (
    !nonEmpty(ownerId)
    || !leaseStore
    || typeof leaseStore.acquire !== "function"
    || typeof leaseStore.assertOwned !== "function"
    || typeof leaseStore.complete !== "function"
    || typeof leaseStore.release !== "function"
    || !publicEvidenceProvider
  ) {
    throw new TypeError("owner, lease store, and public provider are required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (
    !positiveInteger(leaseDurationMs)
    || !positiveInteger(retry?.maxAttempts)
    || !positiveInteger(retry?.baseBackoffMs)
    || !positiveInteger(retry?.timeoutMs)
  ) {
    throw new TypeError("bounded lease and retry configuration are required");
  }

  const providerBudgetMs = retry.maxAttempts * retry.timeoutMs
    + retry.baseBackoffMs * ((retry.maxAttempts - 1) * retry.maxAttempts / 2);
  if (leaseDurationMs <= providerBudgetMs) {
    throw new TypeError("leaseDurationMs must exceed the bounded provider retry budget");
  }

  const cycle = cycleFor({
    cadence,
    identityFingerprint: state.identityFingerprint,
    nowMs,
  });
  const leaseNowMs = clock();
  if (!finiteNumber(leaseNowMs)) throw new TypeError("clock must return a finite number");

  const lease = await leaseStore.acquire({
    ...cycle,
    ownerId,
    nowMs: leaseNowMs,
    leaseDurationMs,
  });
  if (!lease.acquired) {
    return Object.freeze({
      status: lease.status === "COMPLETED" ? "REPLAYED" : "SKIPPED_BUSY",
      cycleId: cycle.cycleId,
      mutationCount: 0,
      busyOwnerId: lease.ownerId ?? null,
      busyReason: lease.reason ?? null,
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

    const evidenceEvaluatedAtMs = clock();
    if (!finiteNumber(evidenceEvaluatedAtMs)) {
      throw new TypeError("clock must return a finite number");
    }
    const blockers = lanes
      .map((lane) => ({
        market: lane.market,
        reason: evidenceBlock(lane, evidenceEvaluatedAtMs),
      }))
      .filter((row) => row.reason);

    if (blockers.length > 0) {
      return Object.freeze({
        status: "BLOCKED_DATA",
        cycleId: cycle.cycleId,
        mutationCount: 0,
        blockers: Object.freeze(blockers),
        evidenceEvaluatedAtMs,
        safety: PAPER_SCHEDULER_CONTRACT,
      });
    }

    await leaseStore.assertOwned({
      leaseKey: cycle.leaseKey,
      ownerId,
      token: lease.token,
    });
    const result = await runCycle({
      state,
      cycle: {
        cycleId: cycle.cycleId,
        evaluatedAtMs: evidenceEvaluatedAtMs,
      },
      candidates: lanes.flatMap((lane) => lane.result.candidates),
      exits: lanes.flatMap((lane) => lane.result.exits),
      ledgerAdapter,
      learningAdapter,
      stateStore,
    });

    const completedAtMs = clock();
    if (!finiteNumber(completedAtMs)) throw new TypeError("clock must return a finite number");
    await leaseStore.complete({
      leaseKey: cycle.leaseKey,
      cycleId: cycle.cycleId,
      ownerId,
      token: lease.token,
      completedAtMs,
      summary: result.summary,
    });
    return Object.freeze({
      status: "COMPLETED",
      cycleId: cycle.cycleId,
      mutationCount: 1,
      evidenceEvaluatedAtMs,
      completedAtMs,
      ...result,
      safety: PAPER_SCHEDULER_CONTRACT,
    });
  } finally {
    await leaseStore.release({
      leaseKey: cycle.leaseKey,
      ownerId,
      token: lease.token,
    });
  }
}

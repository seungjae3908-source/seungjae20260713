import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PAPER_SCHEDULER_CONTRACT,
  PAPER_SCHEDULER_OWNER_LIVENESS,
  createFilePaperSchedulerLeaseStore,
  runScheduledPaperCycle,
} from "../src/paper-scheduler-driver-v1.js";

const NOW = Date.parse("2026-08-15T03:00:00.000Z");
const CADENCE = Object.freeze({ version: "paper-hourly-v1", intervalMs: 60 * 60 * 1_000 });
const CYCLE_ID = "paper-hourly-v1:496323";
const LEASE_KEY = `paper:paper-identity-v1:${CYCLE_ID}`;
const LEASE_DURATION_MS = 30_000;

function state() {
  return { identityFingerprint: "paper-identity-v1" };
}

function readyLane(overrides = {}) {
  return {
    publicOnly: true,
    status: "READY",
    observedAtMs: NOW,
    maxAgeMs: 60_000,
    candidates: [],
    exits: [],
    ...overrides,
  };
}

function leasePaths(directory, leaseKey = LEASE_KEY) {
  const name = createHash("sha256").update(leaseKey).digest("hex");
  return {
    lease: join(directory, `${name}.lease`),
    owner: join(directory, `${name}.lease`, "owner.json"),
    completed: join(directory, `${name}.complete.json`),
  };
}

function leaseStore(directory, overrides = {}) {
  return createFilePaperSchedulerLeaseStore({
    directory,
    localHostId: "paper-host-a",
    localProcessId: 101,
    ownerLiveness: () => PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE,
    ...overrides,
  });
}

async function harness(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "paper-scheduler-v1-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const providerCalls = [];
  const options = {
    state: state(),
    cadence: CADENCE,
    nowMs: NOW,
    ownerId: "worker-a",
    leaseDurationMs: LEASE_DURATION_MS,
    leaseStore: leaseStore(directory),
    publicEvidenceProvider: {
      async collectPublicEvidence(input) {
        providerCalls.push(input);
        return readyLane();
      },
    },
    retry: { maxAttempts: 3, baseBackoffMs: 1, timeoutMs: 100 },
    sleep: async () => {},
    clock: () => NOW,
    async runCycle(input) {
      calls.push(input);
      return {
        state: input.state,
        summary: { cycleId: input.cycle.cycleId, entries: 0, settled: 0 },
      };
    },
    ...overrides,
  };
  return { directory, calls, providerCalls, options };
}

test("deterministic public-only invocation uses an explicit versioned cadence", async (t) => {
  const { calls, providerCalls, options } = await harness(t);
  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.cycleId, CYCLE_ID);
  assert.equal(calls.length, 1);
  assert.equal(providerCalls.length, 4);
  assert.deepEqual(
    new Set(providerCalls.map((row) => row.market)),
    new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]),
  );
  assert.deepEqual(result.safety, PAPER_SCHEDULER_CONTRACT);
  assert.equal(result.safety.privateAccountAccess, false);
  assert.equal(result.safety.liveTrading, false);
  assert.equal(result.safety.scheduleActive, false);
  assert.equal(result.safety.leaseScope, "SINGLE_HOST_FILE_CAS");
  assert.equal(result.safety.distributedMultiHostSupported, false);
});

test("two concurrent invocations elect one owner and the loser performs zero mutation", async (t) => {
  let releaseWinner;
  let markWinnerEntered;
  const gate = new Promise((resolve) => { releaseWinner = resolve; });
  const winnerEntered = new Promise((resolve) => { markWinnerEntered = resolve; });
  const { calls, options } = await harness(t, {
    async runCycle(input) {
      calls.push(input);
      markWinnerEntered();
      await gate;
      return { state: input.state, summary: { cycleId: input.cycle.cycleId } };
    },
  });

  const winner = runScheduledPaperCycle(options);
  await winnerEntered;
  const loser = await runScheduledPaperCycle({ ...options, ownerId: "worker-b" });
  releaseWinner();
  const completed = await winner;

  assert.equal(completed.status, "COMPLETED");
  assert.equal(loser.status, "SKIPPED_BUSY");
  assert.equal(loser.busyReason, "LIVE_LOCAL_OWNER");
  assert.equal(loser.mutationCount, 0);
  assert.equal(calls.length, 1);
});

test("a live local owner cannot be stolen after nominal lease duration", async (t) => {
  let releaseWinner;
  let markWinnerEntered;
  const gate = new Promise((resolve) => { releaseWinner = resolve; });
  const winnerEntered = new Promise((resolve) => { markWinnerEntered = resolve; });
  const { directory, calls, options } = await harness(t, {
    async runCycle(input) {
      calls.push(input);
      markWinnerEntered();
      await gate;
      return { state: input.state, summary: { cycleId: input.cycle.cycleId } };
    },
  });

  const winner = runScheduledPaperCycle(options);
  await winnerEntered;
  const competingStore = leaseStore(directory, {
    localProcessId: 202,
    ownerLiveness: () => PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE,
  });
  const loser = await runScheduledPaperCycle({
    ...options,
    ownerId: "worker-b",
    leaseStore: competingStore,
    clock: () => NOW + LEASE_DURATION_MS + 10_000,
  });
  releaseWinner();
  await winner;

  assert.equal(loser.status, "SKIPPED_BUSY");
  assert.equal(loser.busyReason, "LIVE_LOCAL_OWNER");
  assert.equal(loser.mutationCount, 0);
  assert.equal(calls.length, 1);
});

test("an ownerless mkdir-to-owner-write orphan is recovered after bounded grace", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-scheduler-orphan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = leasePaths(directory);
  await mkdir(paths.lease, { recursive: true });
  const old = new Date(NOW - LEASE_DURATION_MS - 1);
  await utimes(paths.lease, old, old);

  const acquired = await leaseStore(directory).acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "recovery-worker",
    nowMs: NOW,
    leaseDurationMs: LEASE_DURATION_MS,
  });

  assert.equal(acquired.acquired, true);
  assert.equal(acquired.status, "ACQUIRED");
  assert.equal(acquired.ownerId, "recovery-worker");
});

test("a fresh ownerless lease fails closed while owner initialization may be in progress", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-scheduler-initializing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = leasePaths(directory);
  await mkdir(paths.lease, { recursive: true });
  const fresh = new Date(NOW);
  await utimes(paths.lease, fresh, fresh);

  const result = await leaseStore(directory).acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "competing-worker",
    nowMs: NOW,
    leaseDurationMs: LEASE_DURATION_MS,
  });

  assert.equal(result.acquired, false);
  assert.equal(result.status, "BUSY");
  assert.equal(result.reason, "OWNER_INITIALIZING");
});

test("a definitively dead same-host owner is recovered", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-scheduler-dead-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalStore = leaseStore(directory, { localProcessId: 101 });
  const original = await originalStore.acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "dead-worker",
    nowMs: NOW,
    leaseDurationMs: LEASE_DURATION_MS,
  });
  assert.equal(original.acquired, true);

  const recoveryStore = leaseStore(directory, {
    localProcessId: 202,
    ownerLiveness: () => PAPER_SCHEDULER_OWNER_LIVENESS.DEAD,
  });
  const recovered = await recoveryStore.acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "recovery-worker",
    nowMs: NOW + 1,
    leaseDurationMs: LEASE_DURATION_MS,
  });

  assert.equal(recovered.acquired, true);
  assert.equal(recovered.ownerId, "recovery-worker");
});

test("remote-host ownership fails closed even when the caller cannot prove liveness", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-scheduler-remote-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await leaseStore(directory, {
    localHostId: "paper-host-a",
    localProcessId: 101,
  }).acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "remote-worker",
    nowMs: NOW,
    leaseDurationMs: LEASE_DURATION_MS,
  });
  assert.equal(original.acquired, true);

  const result = await leaseStore(directory, {
    localHostId: "paper-host-b",
    localProcessId: 202,
    ownerLiveness: () => PAPER_SCHEDULER_OWNER_LIVENESS.DEAD,
  }).acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "local-worker",
    nowMs: NOW + LEASE_DURATION_MS + 1,
    leaseDurationMs: LEASE_DURATION_MS,
  });

  assert.equal(result.acquired, false);
  assert.equal(result.status, "BUSY");
  assert.equal(result.reason, "REMOTE_HOST_OWNER");
});

test("unknown same-host owner liveness fails closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-scheduler-unknown-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await leaseStore(directory, { localProcessId: 101 }).acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "uncertain-worker",
    nowMs: NOW,
    leaseDurationMs: LEASE_DURATION_MS,
  });
  assert.equal(original.acquired, true);

  const result = await leaseStore(directory, {
    localProcessId: 202,
    ownerLiveness: () => PAPER_SCHEDULER_OWNER_LIVENESS.UNKNOWN,
  }).acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "competing-worker",
    nowMs: NOW + LEASE_DURATION_MS + 1,
    leaseDurationMs: LEASE_DURATION_MS,
  });

  assert.equal(result.acquired, false);
  assert.equal(result.status, "BUSY");
  assert.equal(result.reason, "UNKNOWN_LOCAL_OWNER");
});

test("completed-cycle retry and restart replay without duplicate mutation", async (t) => {
  const { directory, calls, options } = await harness(t);
  assert.equal((await runScheduledPaperCycle(options)).status, "COMPLETED");
  const restartedStore = leaseStore(directory);
  const replay = await runScheduledPaperCycle({
    ...options,
    ownerId: "worker-restarted",
    leaseStore: restartedStore,
  });
  assert.equal(replay.status, "REPLAYED");
  assert.equal(replay.mutationCount, 0);
  assert.equal(calls.length, 1);
});

test("failed owner releases lease so the same cycle retries safely", async (t) => {
  let attempts = 0;
  const { calls, options } = await harness(t, {
    async runCycle(input) {
      attempts += 1;
      if (attempts === 1) throw new Error("transient persistence failure");
      calls.push(input);
      return { state: input.state, summary: { cycleId: input.cycle.cycleId } };
    },
  });
  await assert.rejects(runScheduledPaperCycle(options), /transient persistence failure/);
  const retry = await runScheduledPaperCycle(options);
  assert.equal(retry.status, "COMPLETED");
  assert.equal(calls.length, 1);
});

test("freshness is evaluated after public collection rather than against cycle start", async (t) => {
  const clockValues = [NOW, NOW + 5_000, NOW + 6_000];
  let clockIndex = 0;
  const { calls, options } = await harness(t, {
    clock: () => clockValues[Math.min(clockIndex++, clockValues.length - 1)],
    publicEvidenceProvider: {
      async collectPublicEvidence() {
        return readyLane({ observedAtMs: NOW + 4_000, maxAgeMs: 10_000 });
      },
    },
  });

  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.evidenceEvaluatedAtMs, NOW + 5_000);
  assert.equal(result.completedAtMs, NOW + 6_000);
  assert.equal(calls.length, 1);
});

for (const [name, lane] of [
  ["BLOCKED_DATA", readyLane({ status: "BLOCKED_DATA" })],
  ["stale", readyLane({ observedAtMs: NOW - 60_001 })],
  ["future", readyLane({ observedAtMs: NOW + 1 })],
  ["invalid", { publicOnly: true, status: "READY", candidates: [], exits: [] }],
]) {
  test(`${name} public evidence fails closed before Paper mutation`, async (t) => {
    const { calls, options } = await harness(t, {
      publicEvidenceProvider: { async collectPublicEvidence() { return lane; } },
    });
    const result = await runScheduledPaperCycle(options);
    assert.equal(result.status, "BLOCKED_DATA");
    assert.equal(result.mutationCount, 0);
    assert.equal(calls.length, 0);
  });
}

test("429 exhaustion blocks all lanes and does not fabricate another lane success", async (t) => {
  const attempts = new Map();
  const backoffs = [];
  const { calls, options } = await harness(t, {
    publicEvidenceProvider: {
      async collectPublicEvidence({ market }) {
        attempts.set(market, (attempts.get(market) ?? 0) + 1);
        if (market === "US_STOCK") {
          throw Object.assign(new Error("rate limited"), { status: 429 });
        }
        return readyLane();
      },
    },
    sleep: async (delay) => { backoffs.push(delay); },
  });
  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.mutationCount, 0);
  assert.equal(calls.length, 0);
  assert.equal(attempts.get("US_STOCK"), 3);
  assert.deepEqual(backoffs, [1, 2]);
  assert.deepEqual(result.blockers, [{ market: "US_STOCK", reason: "PROVIDER_RATE_LIMITED" }]);
});

test("provider timeout retry is bounded and fails closed without Paper mutation", async (t) => {
  let futuresAttempts = 0;
  const backoffs = [];
  const { calls, options } = await harness(t, {
    publicEvidenceProvider: {
      async collectPublicEvidence({ market }) {
        if (market === "CRYPTO_FUTURES") {
          futuresAttempts += 1;
          return new Promise(() => {});
        }
        return readyLane();
      },
    },
    retry: { maxAttempts: 2, baseBackoffMs: 1, timeoutMs: 5 },
    sleep: async (delay) => { backoffs.push(delay); },
  });
  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.mutationCount, 0);
  assert.equal(calls.length, 0);
  assert.equal(futuresAttempts, 2);
  assert.deepEqual(backoffs, [1]);
  assert.deepEqual(result.blockers, [{ market: "CRYPTO_FUTURES", reason: "PROVIDER_TIMEOUT" }]);
});

test("NO_TRADE empty public lanes reach canonical path without fake entries or outcomes", async (t) => {
  const { calls, options } = await harness(t);
  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(calls[0].candidates, []);
  assert.deepEqual(calls[0].exits, []);
  assert.equal(result.summary.entries, 0);
  assert.equal(result.summary.settled, 0);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PAPER_SCHEDULER_CONTRACT,
  createFilePaperSchedulerLeaseStore,
  runScheduledPaperCycle,
} from "../src/paper-scheduler-driver-v1.js";

const NOW = Date.parse("2026-08-15T03:00:00.000Z");
const CADENCE = Object.freeze({ version: "paper-hourly-v1", intervalMs: 60 * 60 * 1_000 });
const CYCLE_ID = "paper-hourly-v1:496323";

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
    leaseDurationMs: 30_000,
    leaseStore: createFilePaperSchedulerLeaseStore({ directory }),
    publicEvidenceProvider: {
      async collectPublicEvidence(input) {
        providerCalls.push(input);
        return readyLane();
      },
    },
    retry: { maxAttempts: 3, baseBackoffMs: 1, timeoutMs: 100 },
    sleep: async () => {},
    async runCycle(input) {
      calls.push(input);
      return { state: input.state, summary: { cycleId: input.cycle.cycleId, entries: 0, settled: 0 } };
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
  assert.deepEqual(new Set(providerCalls.map((row) => row.market)), new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]));
  assert.deepEqual(result.safety, PAPER_SCHEDULER_CONTRACT);
  assert.equal(result.safety.privateAccountAccess, false);
  assert.equal(result.safety.liveTrading, false);
  assert.equal(result.safety.scheduleActive, false);
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
  assert.equal(loser.mutationCount, 0);
  assert.equal(calls.length, 1);
});

test("completed-cycle retry and restart replay without duplicate mutation", async (t) => {
  const { directory, calls, options } = await harness(t);
  assert.equal((await runScheduledPaperCycle(options)).status, "COMPLETED");
  const restartedStore = createFilePaperSchedulerLeaseStore({ directory });
  const replay = await runScheduledPaperCycle({ ...options, ownerId: "worker-restarted", leaseStore: restartedStore });
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

test("an expired lease is recovered after restart", async (t) => {
  const { options } = await harness(t);
  const cycleId = CYCLE_ID;
  const leaseKey = `paper:${options.state.identityFingerprint}:${cycleId}`;
  const expired = await options.leaseStore.acquire({ leaseKey, cycleId, ownerId: "dead-worker", nowMs: NOW - 60_000, leaseDurationMs: 1_000 });
  assert.equal(expired.acquired, true);
  const result = await runScheduledPaperCycle({ ...options, ownerId: "recovery-worker" });
  assert.equal(result.status, "COMPLETED");
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
        if (market === "US_STOCK") throw Object.assign(new Error("rate limited"), { status: 429 });
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

test("provider timeout is bounded and fails closed without Paper mutation", async (t) => {
  const { calls, options } = await harness(t, {
    publicEvidenceProvider: {
      async collectPublicEvidence({ market }) {
        if (market === "CRYPTO_FUTURES") return new Promise(() => {});
        return readyLane();
      },
    },
    retry: { maxAttempts: 1, baseBackoffMs: 1, timeoutMs: 5 },
  });
  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.mutationCount, 0);
  assert.equal(calls.length, 0);
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

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  __paperForwardScheduleTestables,
  readPaperForwardScheduleSnapshot,
  runPaperForwardScheduledInvocation,
} from "../src/paper-forward-schedule-runtime-v1.js";

const RESEARCH_SHA = "a".repeat(40);
const MARKETS = ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"];

function readyProvider(nowMs) {
  return Object.freeze({
    async collectPublicEvidence({ market }) {
      return Object.freeze({
        status: "READY",
        publicOnly: true,
        market,
        provider: `test-public-${market.toLowerCase()}`,
        provenance: Object.freeze({ provider: "test", market }),
        observedAtMs: nowMs - 1_000,
        dataAsOfMs: nowMs - 1_000,
        maxAgeMs: 60_000,
        candidates: Object.freeze([]),
        exits: Object.freeze([]),
        blocker: null,
      });
    },
  });
}

test("natural cron invocation persists one canonical 4h cycle and active status", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-forward-schedule-"));
  const root = join(sandbox, "persistent-state");
  const nowMs = 1_800_000_000_000;
  const clock = () => nowMs;
  try {
    const first = await runPaperForwardScheduledInvocation({
      rootDirectory: root,
      researchCodeSha: RESEARCH_SHA,
      triggerSource: "cron",
      activationAtMs: nowMs - 10_000,
      ownerId: "test-owner:first",
      clock,
      publicEvidenceProvider: readyProvider(nowMs),
    });

    assert.equal(first.status, "COMPLETED");
    assert.equal(first.mutationCount, 1);
    assert.equal(first.invocation.naturalScheduleInvocation, true);
    assert.equal(first.invocation.publicForwardEvidenceAccumulating, true);
    assert.equal(first.invocation.paperTradeOutcomeAccumulating, false);
    assert.equal(first.persistedStatus.scheduleActive, true);
    assert.equal(first.persistedStatus.allProvidersReady, true);
    assert.equal(first.persistedStatus.privateRequestCount, 0);
    assert.equal(first.persistedStatus.orderCount, 0);
    assert.equal(first.invocation.providerLanes.length, MARKETS.length);
    assert.deepEqual(first.invocation.providerLanes.map((lane) => lane.market), MARKETS);

    const persistedState = JSON.parse(await readFile(
      join(root, "state", "recurring-paper-loop.json"),
      "utf8",
    ));
    assert.equal(persistedState.cycles.length, 1);
    assert.equal(persistedState.positions.length, 0);
    assert.equal(persistedState.settlements.length, 0);
    assert.equal(persistedState.liveOrderAllowed, false);
    assert.equal(persistedState.privateTradingApiAllowed, false);

    const snapshot = await readPaperForwardScheduleSnapshot(root);
    assert.equal(snapshot.scheduleActive, true);
    assert.equal(snapshot.stateCycleCount, 1);
    assert.equal(snapshot.lastInvocation.status, "COMPLETED");
    assert.equal(snapshot.lastInvocation.privateRequestCount, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("same 4h cycle replays without provider calls or duplicate mutation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-forward-replay-"));
  const root = join(sandbox, "persistent-state");
  let nowMs = 1_800_000_000_000;
  let providerCalls = 0;
  const provider = Object.freeze({
    async collectPublicEvidence({ market }) {
      providerCalls += 1;
      return {
        status: "READY",
        publicOnly: true,
        market,
        provider: "test-public",
        observedAtMs: nowMs - 1_000,
        dataAsOfMs: nowMs - 1_000,
        maxAgeMs: 60_000,
        candidates: [],
        exits: [],
      };
    },
  });
  const clock = () => nowMs;
  try {
    const first = await runPaperForwardScheduledInvocation({
      rootDirectory: root,
      researchCodeSha: RESEARCH_SHA,
      triggerSource: "cron",
      activationAtMs: nowMs - 10_000,
      ownerId: "test-owner:first",
      clock,
      publicEvidenceProvider: provider,
    });
    assert.equal(first.status, "COMPLETED");
    assert.equal(providerCalls, 4);

    nowMs += 60_000;
    const second = await runPaperForwardScheduledInvocation({
      rootDirectory: root,
      researchCodeSha: RESEARCH_SHA,
      triggerSource: "cron",
      activationAtMs: nowMs - 70_000,
      ownerId: "test-owner:second",
      clock,
      publicEvidenceProvider: provider,
    });
    assert.equal(second.status, "REPLAYED");
    assert.equal(second.mutationCount, 0);
    assert.equal(providerCalls, 4);
    assert.equal(second.persistedStatus.allProvidersReady, true);
    assert.equal(second.persistedStatus.lanes.every((lane) => lane.status === "READY"), true);

    const persistedState = JSON.parse(await readFile(
      join(root, "state", "recurring-paper-loop.json"),
      "utf8",
    ));
    assert.equal(persistedState.cycles.length, 1);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("financial adapters fail closed if a future candidate path attempts mutation", async () => {
  const { ledgerAdapter, learningAdapter } = __paperForwardScheduleTestables.failClosedFinancialAdapters();
  await assert.rejects(
    ledgerAdapter.applyEntry({}),
    (error) => error?.code === "PAPER_FORWARD_FINANCIAL_MUTATION_DISABLED",
  );
  await assert.rejects(
    ledgerAdapter.applySettlement({}),
    (error) => error?.code === "PAPER_FORWARD_FINANCIAL_MUTATION_DISABLED",
  );
  await assert.rejects(
    learningAdapter.persistSignal({}),
    (error) => error?.code === "PAPER_FORWARD_FINANCIAL_MUTATION_DISABLED",
  );
  await assert.rejects(
    learningAdapter.persistOutcome({}),
    (error) => error?.code === "PAPER_FORWARD_FINANCIAL_MUTATION_DISABLED",
  );
});

test("state root cannot be relative or inside the live deploy tree", () => {
  assert.throws(
    () => __paperForwardScheduleTestables.assertRootDirectory("relative/path"),
    /absolute Paper Forward state root/u,
  );
  assert.throws(
    () => __paperForwardScheduleTestables.assertRootDirectory("/opt/stock-app/state"),
    /outside the deploy source tree/u,
  );
});

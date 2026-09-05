import assert from "node:assert/strict";
import test from "node:test";
import { runPaperForwardEvidenceRuntime } from "../src/paper-forward-evidence-runtime-v1.js";

const NOW = 1_800_000_000_000;

test("runtime passes only same-market canonical OPEN positions to the natural evidence provider", async () => {
  const received = [];
  const publicEvidenceProvider = {
    async collectPublicEvidence(input) {
      received.push(input);
      return {
        status: "READY",
        publicOnly: true,
        market: input.market,
        provider: "fixture-public",
        dataAsOfMs: NOW - 1000,
        observedAtMs: NOW - 1000,
        maxAgeMs: 60000,
        candidates: [],
        exits: [],
        blocker: null,
      };
    },
  };
  let saved = null;
  const state = {
    positions: [
      { positionId: "futures-open", market: "CRYPTO_FUTURES", lifecycleState: "OPEN", signalId: "ETH-V6-1" },
      { positionId: "spot-open", market: "CRYPTO_SPOT", lifecycleState: "OPEN", signalId: "SPOT-1" },
      { positionId: "futures-closed", market: "CRYPTO_FUTURES", lifecycleState: "CLOSED", signalId: "OLD" },
    ],
  };
  const result = await runPaperForwardEvidenceRuntime({
    publicEvidenceProvider,
    state,
    runtimeClock: () => NOW,
    runtimeStatusStore: {
      async load() { return null; },
      async save(value) { saved = value; },
    },
    runScheduled: async ({ publicEvidenceProvider: tracked }) => {
      await tracked.collectPublicEvidence({ market: "CRYPTO_FUTURES", signal: new AbortController().signal });
      return { status: "SUCCESS", cycleId: "cycle-1", mutationCount: 0, summary: { tradesSettled: 0 } };
    },
  });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].openPositions.map((row) => row.positionId), ["futures-open"]);
  assert.notEqual(received[0].openPositions[0], state.positions[0], "handoff is a read-only clone, not mutable state ownership");
  assert.equal(result.runtimeStatus.privateRequestCount, 0);
  assert.equal(result.runtimeStatus.orderCount, 0);
  assert.equal(saved.liveTrading, false);
});
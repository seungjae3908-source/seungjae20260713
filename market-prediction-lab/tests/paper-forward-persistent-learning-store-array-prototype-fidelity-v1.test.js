import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFilePaperLearningStore } from "../src/paper-forward-persistent-learning-store-v1.js";

function safeValue(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "signal",
    signalId: "signal-1",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    ...overrides,
  };
}

class ExecutionSamples extends Array {}

test("array subclasses fail closed before persistence flattens their prototype", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-learning-array-prototype-fidelity-"));
  const directory = join(sandbox, "learning");
  try {
    const store = createFilePaperLearningStore({ directory });
    const executionSamples = new ExecutionSamples({ slippageBps: 1 });

    await assert.rejects(
      store.putIfAbsent({
        key: "paper-signal:signal-1",
        value: safeValue({ executionSamples }),
      }),
      /PAPER_FORWARD_LEARNING_VALUE_NOT_JSON_SAFE/u,
    );
    assert.equal((await store.snapshot()).length, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("nested array subclasses also fail closed", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-learning-nested-array-prototype-fidelity-"));
  const directory = join(sandbox, "learning");
  try {
    const store = createFilePaperLearningStore({ directory });
    const executionSamples = [new ExecutionSamples({ latencyMs: 12 })];

    await assert.rejects(
      store.putIfAbsent({
        key: "paper-signal:signal-1",
        value: safeValue({ executionSamples }),
      }),
      /PAPER_FORWARD_LEARNING_VALUE_NOT_JSON_SAFE/u,
    );
    assert.equal((await store.snapshot()).length, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

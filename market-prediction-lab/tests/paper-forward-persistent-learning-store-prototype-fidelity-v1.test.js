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

test("null-prototype learning objects fail closed before persistence changes their prototype", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-learning-prototype-fidelity-"));
  const directory = join(sandbox, "learning");
  try {
    const store = createFilePaperLearningStore({ directory });
    const payload = Object.assign(Object.create(null), safeValue());

    await assert.rejects(
      store.putIfAbsent({ key: "paper-signal:signal-1", value: payload }),
      /PAPER_FORWARD_LEARNING_VALUE_NOT_JSON_SAFE/u,
    );
    assert.equal((await store.snapshot()).length, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("nested null-prototype learning objects also fail closed", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-learning-nested-prototype-fidelity-"));
  const directory = join(sandbox, "learning");
  try {
    const store = createFilePaperLearningStore({ directory });
    const executionQuality = Object.assign(Object.create(null), { slippageBps: 1 });

    await assert.rejects(
      store.putIfAbsent({
        key: "paper-signal:signal-1",
        value: safeValue({ executionQuality }),
      }),
      /PAPER_FORWARD_LEARNING_VALUE_NOT_JSON_SAFE/u,
    );
    assert.equal((await store.snapshot()).length, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

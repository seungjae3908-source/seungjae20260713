import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("file learning store survives restart and replays the same record idempotently", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-learning-store-"));
  const directory = join(sandbox, "learning");
  try {
    const firstStore = createFilePaperLearningStore({ directory });
    assert.deepEqual(await firstStore.putIfAbsent({ key: "paper-signal:signal-1", value: safeValue() }), { inserted: true });

    const restartedStore = createFilePaperLearningStore({ directory });
    assert.deepEqual(await restartedStore.putIfAbsent({ key: "paper-signal:signal-1", value: safeValue() }), { inserted: false });
    const snapshot = await restartedStore.snapshot();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].key, "paper-signal:signal-1");
    assert.equal(snapshot[0].value.signalId, "signal-1");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("same learning key with a different payload fails closed", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-learning-conflict-"));
  const directory = join(sandbox, "learning");
  try {
    const store = createFilePaperLearningStore({ directory });
    await store.putIfAbsent({ key: "paper-signal:signal-1", value: safeValue() });
    await assert.rejects(
      store.putIfAbsent({ key: "paper-signal:signal-1", value: safeValue({ signalId: "different" }) }),
      /PAPER_FORWARD_LEARNING_KEY_CONFLICT/u,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("unsafe learning payload cannot be persisted", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-learning-unsafe-"));
  const directory = join(sandbox, "learning");
  try {
    const store = createFilePaperLearningStore({ directory });
    await assert.rejects(
      store.putIfAbsent({ key: "paper-signal:signal-1", value: safeValue({ liveOrderAllowed: true }) }),
      /PAPER_FORWARD_LEARNING_SAFETY_VIOLATION/u,
    );
    assert.equal((await store.snapshot()).length, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

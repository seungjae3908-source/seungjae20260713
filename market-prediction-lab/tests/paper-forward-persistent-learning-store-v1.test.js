import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

test("concurrent identical learning writes publish exactly one complete canonical record", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-learning-concurrent-"));
  const directory = join(sandbox, "learning");
  try {
    const store = createFilePaperLearningStore({ directory });
    const results = await Promise.all(Array.from({ length: 32 }, () => (
      store.putIfAbsent({ key: "paper-signal:signal-1", value: safeValue() })
    )));
    assert.equal(results.filter((result) => result.inserted).length, 1);
    assert.equal(results.filter((result) => !result.inserted).length, 31);

    const names = await readdir(directory);
    assert.equal(names.length, 1);
    assert.match(names[0], /^[a-f0-9]{64}\.json$/u);
    const persisted = JSON.parse(await readFile(join(directory, names[0]), "utf8"));
    assert.equal(persisted.key, "paper-signal:signal-1");

    const restartedStore = createFilePaperLearningStore({ directory });
    assert.equal((await restartedStore.snapshot()).length, 1);
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

test("lossy JSON learning payloads fail closed before persistence", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-learning-json-fidelity-"));
  const directory = join(sandbox, "learning");
  try {
    const store = createFilePaperLearningStore({ directory });
    for (const lossyValue of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      await assert.rejects(
        store.putIfAbsent({
          key: "paper-signal:signal-1",
          value: safeValue({ executionQuality: { slippageBps: lossyValue } }),
        }),
        /PAPER_FORWARD_LEARNING_VALUE_NOT_JSON_SAFE/u,
      );
    }
    assert.equal((await store.snapshot()).length, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("JSON-ignored own properties fail closed before persistence", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-learning-json-own-properties-"));
  const directory = join(sandbox, "learning");
  try {
    const store = createFilePaperLearningStore({ directory });

    const symbolPayload = safeValue();
    symbolPayload[Symbol("ignored")] = "would-be-dropped";

    const arrayWithExtraProperty = [1, 2];
    arrayWithExtraProperty.extra = "would-be-dropped";
    const arrayPayload = safeValue({ diagnostics: arrayWithExtraProperty });

    const nonEnumerablePayload = safeValue();
    Object.defineProperty(nonEnumerablePayload, "hidden", {
      value: "would-be-dropped",
      enumerable: false,
    });

    for (const value of [symbolPayload, arrayPayload, nonEnumerablePayload]) {
      await assert.rejects(
        store.putIfAbsent({ key: "paper-signal:signal-1", value }),
        /PAPER_FORWARD_LEARNING_VALUE_NOT_JSON_SAFE/u,
      );
    }
    assert.equal((await store.snapshot()).length, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("snapshot rejects a copied learning record whose filename is not bound to its key", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-learning-filename-truth-"));
  const directory = join(sandbox, "learning");
  try {
    const store = createFilePaperLearningStore({ directory });
    await store.putIfAbsent({ key: "paper-signal:signal-1", value: safeValue() });
    const [canonicalName] = await readdir(directory);
    const canonicalRecord = await readFile(join(directory, canonicalName), "utf8");
    await writeFile(join(directory, "copied-stale-record.json"), canonicalRecord, "utf8");

    await assert.rejects(
      store.snapshot(),
      /PAPER_FORWARD_LEARNING_RECORD_FILENAME_MISMATCH/u,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

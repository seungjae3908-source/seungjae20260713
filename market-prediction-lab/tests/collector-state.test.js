import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendCollectedRecord, readCollectorState, saveCollectedSnapshot, sha256Object } from "../src/collector-state.js";

test("stable hash is independent of object key order and volatile timestamps", () => {
  assert.equal(
    sha256Object({ b: 2, a: 1, collectedAt: 100 }),
    sha256Object({ a: 1, b: 2, collectedAt: 200 }),
  );
});

test("snapshot save is atomic and idempotent when only collection time changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-state-"));
  try {
    const dataPath = join(directory, "btc.json");
    const statePath = join(directory, "state.json");
    const firstSnapshot = { collectedAt: 1, candles: [{ timestamp: 1, close: 2 }] };
    const secondSnapshot = { collectedAt: 2, candles: [{ timestamp: 1, close: 2 }] };
    const first = await saveCollectedSnapshot({ dataPath, statePath, key: "CRYPTO_FUTURES:BTCUSDT:15m", snapshot: firstSnapshot });
    const second = await saveCollectedSnapshot({ dataPath, statePath, key: "CRYPTO_FUTURES:BTCUSDT:15m", snapshot: secondSnapshot });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.deepEqual(JSON.parse(await readFile(dataPath, "utf8")), firstSnapshot);
    const state = await readCollectorState(statePath);
    assert.equal(Object.keys(state.entries).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("context records append only when market content changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-context-"));
  try {
    const filePath = join(directory, "context.jsonl");
    const statePath = join(directory, "state.json");
    const first = await appendCollectedRecord({
      filePath, statePath, key: "context:BTCUSDT",
      record: { collectedAt: 1, openInterest: 100, fundingRate: 0.001 },
    });
    const duplicate = await appendCollectedRecord({
      filePath, statePath, key: "context:BTCUSDT",
      record: { collectedAt: 2, openInterest: 100, fundingRate: 0.001 },
    });
    const changed = await appendCollectedRecord({
      filePath, statePath, key: "context:BTCUSDT",
      record: { collectedAt: 3, openInterest: 101, fundingRate: 0.001 },
    });
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    assert.equal(first.changed, true);
    assert.equal(duplicate.changed, false);
    assert.equal(changed.changed, true);
    assert.equal(lines.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

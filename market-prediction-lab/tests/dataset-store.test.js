import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendDatasetRecord, readDataset, writeModelAtomically } from "../src/dataset-store.js";
import { analyzeMarket } from "../src/engine.js";

function fixture() {
  const candles = [];
  let close = 50;
  const start = Date.UTC(2025, 0, 1);
  for (let index = 0; index < 80; index += 1) {
    const open = close;
    close = open * (1 + Math.sin(index / 6) * 0.002 + 0.0004);
    candles.push({
      timestamp: start + index * 4 * 60 * 60 * 1000,
      open,
      high: Math.max(open, close) * 1.005,
      low: Math.min(open, close) * 0.995,
      close,
      volume: 500 + index,
    });
  }
  return {
    market: "CRYPTO_SPOT",
    symbol: "ETHUSDT",
    timeframe: "4h",
    horizon: 5,
    candles,
    collectedAt: Date.UTC(2026, 6, 30),
    source: "dataset-test",
  };
}

test("dataset records append as valid JSONL and read back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prediction-lab-"));
  try {
    const filePath = join(directory, "records.jsonl");
    const input = fixture();
    const prediction = analyzeMarket(input);
    await appendDatasetRecord(filePath, input, prediction);
    await appendDatasetRecord(filePath, input, prediction);
    const records = await readDataset(filePath);
    assert.equal(records.length, 2);
    assert.equal(records[0].schemaVersion, 1);
    assert.equal(records[0].symbol, "ETHUSDT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("model writes atomically as valid JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prediction-model-"));
  try {
    const filePath = join(directory, "model.json");
    const model = { id: "model-test", trained: true, weights: [1, 2, 3] };
    await writeModelAtomically(filePath, model);
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(parsed, model);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

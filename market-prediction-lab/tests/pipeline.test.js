import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCandleRows } from "../src/normalizers.js";
import { inspectCandleQuality, stableStringify } from "../src/data-quality.js";
import { generateCandles, toBitgetRows } from "../src/synthetic-data.js";
import { ingestSnapshotFile, readNormalizedSnapshot } from "../src/snapshot-store.js";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { walkForwardSplit } from "../src/walk-forward.js";
import { exportWalkForwardDataset } from "../src/dataset-export.js";

function baseConfig(overrides = {}) {
  return { market: "CRYPTO_FUTURES", symbol: "BTCUSDT", timeframe: "15m", source: "test", ...overrides };
}

test("canonical rows normalize to unique ascending candles", () => {
  const rows = generateCandles({ count: 80 });
  rows.push({ ...rows[20], close: rows[20].close * 1.001, high: rows[20].high * 1.002 });
  rows.reverse();
  const snapshot = normalizeCandleRows(rows, baseConfig({ format: "canonical-object" }));
  assert.equal(snapshot.candles.length, 80);
  assert.ok(snapshot.candles.every((candle, index) => index === 0 || candle.timestamp > snapshot.candles[index - 1].timestamp));
});

test("bitget array rows parse numeric strings", () => {
  const candles = generateCandles({ count: 80 });
  const snapshot = normalizeCandleRows(toBitgetRows(candles), baseConfig({ format: "bitget-array" }));
  assert.equal(snapshot.candles[0].timestamp, candles[0].timestamp);
  assert.equal(snapshot.candles.at(-1).close, candles.at(-1).close);
});

test("strict normalization rejects invalid OHLC", () => {
  const rows = generateCandles({ count: 80 });
  rows[5] = { ...rows[5], high: rows[5].low - 1 };
  assert.throws(() => normalizeCandleRows(rows, baseConfig({ format: "canonical-object" })), /invalid OHLC/);
});

test("lenient normalization reports rejected rows", () => {
  const rows = generateCandles({ count: 80 });
  rows[5] = { ...rows[5], volume: -1 };
  const snapshot = normalizeCandleRows(rows, baseConfig({ format: "canonical-object", strict: false }));
  assert.equal(snapshot.candles.length, 79);
  assert.equal(snapshot.quality.rejectedRows, 1);
});

test("quality inspection reports intraday gaps", () => {
  const rows = generateCandles({ count: 80 });
  rows[40] = { ...rows[40], timestamp: rows[39].timestamp + 15 * 60 * 1000 * 5 };
  for (let index = 41; index < rows.length; index += 1) rows[index] = { ...rows[index], timestamp: rows[index - 1].timestamp + 15 * 60 * 1000 };
  const quality = inspectCandleQuality(rows, baseConfig());
  assert.equal(quality.gaps, 1);
  assert.equal(quality.status, "warning");
});

test("stable stringify ignores object key insertion order", () => {
  assert.equal(stableStringify({ b: 2, a: { d: 4, c: 3 } }), stableStringify({ a: { c: 3, d: 4 }, b: 2 }));
});

test("stable stringify supports repeated non-circular references and rejects cycles", () => {
  const shared = { value: 1 };
  assert.equal(stableStringify({ a: shared, b: shared }), '{"a":{"value":1},"b":{"value":1}}');
  const circular = {};
  circular.self = circular;
  assert.throws(() => stableStringify(circular), /circular/);
});

test("snapshot ingestion preserves raw data and normalized hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-test-"));
  try {
    const input = join(directory, "input.json");
    await writeFile(input, JSON.stringify({ data: toBitgetRows(generateCandles({ count: 100 })) }), "utf8");
    const result = await ingestSnapshotFile(input, join(directory, "store"), baseConfig({ format: "bitget-array" }));
    const raw = await readFile(result.manifest.rawPath, "utf8");
    const normalized = await readNormalizedSnapshot(result.manifest.normalizedPath);
    assert.match(raw, /data/);
    assert.equal(normalized.candles.length, 100);
    assert.equal(result.manifest.rawSha256.length, 64);
    assert.equal(result.manifest.normalizedSha256.length, 64);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("snapshot ingestion is idempotent for identical raw content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snapshot-idempotent-"));
  try {
    const input = join(directory, "input.json");
    await writeFile(input, JSON.stringify({ data: toBitgetRows(generateCandles({ count: 100 })) }), "utf8");
    const first = await ingestSnapshotFile(input, join(directory, "store"), baseConfig({ format: "bitget-array" }));
    const second = await ingestSnapshotFile(input, join(directory, "store"), baseConfig({ format: "bitget-array" }));
    assert.equal(first.manifest.duplicateIngest, false);
    assert.equal(second.manifest.duplicateIngest, true);
    assert.equal(first.manifest.rawSha256, second.manifest.rawSha256);
    const manifestText = await readFile(join(directory, "store", "manifests", "CRYPTO_FUTURES", "BTCUSDT", "15m.jsonl"), "utf8");
    assert.equal(manifestText.trim().split("\n").length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("training records never include future candles in features", () => {
  const snapshot = normalizeCandleRows(generateCandles({ count: 420 }), baseConfig({ format: "canonical-object" }));
  const records = buildTrainingRecords(snapshot, { lookback: 120, horizon: 5, stride: 7 });
  assert.ok(records.length > 30);
  for (const record of records) {
    assert.ok(record.anchorTimestamp < record.futureStartTimestamp);
    assert.ok(record.futureStartTimestamp <= record.futureEndTimestamp);
    assert.equal(Object.hasOwn(record, "futureCandles"), false);
    assert.equal(typeof record.label.return, "number");
  }
});

test("training record generation is deterministic", () => {
  const snapshot = normalizeCandleRows(generateCandles({ count: 300 }), baseConfig({ format: "canonical-object" }));
  const first = buildTrainingRecords(snapshot, { lookback: 100, horizon: 4, stride: 5 });
  const second = buildTrainingRecords(snapshot, { lookback: 100, horizon: 4, stride: 5 });
  assert.deepEqual(first, second);
});

test("walk-forward split purges overlapping forecast horizons", () => {
  const snapshot = normalizeCandleRows(generateCandles({ count: 600 }), baseConfig({ format: "canonical-object" }));
  const records = buildTrainingRecords(snapshot, { lookback: 120, horizon: 10, stride: 2 });
  const split = walkForwardSplit(records);
  assert.ok(split.report.trainLastFutureTimestamp < split.report.validationFirstAnchorTimestamp);
  assert.ok(split.report.validationLastFutureTimestamp < split.report.testFirstAnchorTimestamp);
});

test("dataset export writes non-empty hash-addressed splits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataset-test-"));
  try {
    const snapshot = normalizeCandleRows(generateCandles({ count: 500 }), baseConfig({ format: "canonical-object" }));
    const split = walkForwardSplit(buildTrainingRecords(snapshot, { lookback: 100, horizon: 5, stride: 2 }));
    const manifest = await exportWalkForwardDataset(directory, split, snapshot.metadata);
    for (const name of ["train", "validation", "test"]) {
      const content = await readFile(manifest.outputs[name].path, "utf8");
      assert.ok(content.length > 0);
      assert.equal(manifest.outputs[name].sha256.length, 64);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

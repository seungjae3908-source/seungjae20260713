import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCandles, toBitgetRows } from "../src/synthetic-data.js";
import { ingestSnapshotFile } from "../src/snapshot-store.js";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { walkForwardSplit } from "../src/walk-forward.js";
import { exportWalkForwardDataset } from "../src/dataset-export.js";

const directory = await mkdtemp(join(tmpdir(), "prediction-pipeline-"));
try {
  const input = join(directory, "bitget-export.json");
  await writeFile(input, JSON.stringify({ data: toBitgetRows(generateCandles({ count: 600 })) }), "utf8");
  const ingested = await ingestSnapshotFile(input, join(directory, "store"), {
    market: "CRYPTO_FUTURES", symbol: "BTCUSDT", timeframe: "15m", format: "bitget-array", source: "smoke-export",
  });
  const records = buildTrainingRecords(ingested.normalized, { lookback: 200, horizon: 5, stride: 2 });
  const split = walkForwardSplit(records);
  const manifest = await exportWalkForwardDataset(join(directory, "dataset"), split, ingested.normalized.metadata);
  const writtenManifest = JSON.parse(await readFile(join(directory, "dataset", "manifest.json"), "utf8"));
  if (records.length < 100 || manifest.outputs.train.count === 0 || writtenManifest.outputs.test.count === 0) throw new Error("pipeline produced an empty dataset");
  console.log(JSON.stringify({ candleCount: ingested.normalized.candles.length, records: records.length, split: split.report, hashes: manifest.outputs }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}

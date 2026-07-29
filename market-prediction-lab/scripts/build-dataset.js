import { readNormalizedSnapshot } from "../src/snapshot-store.js";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { walkForwardSplit } from "../src/walk-forward.js";
import { exportWalkForwardDataset } from "../src/dataset-export.js";

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!key?.startsWith("--") || args[index + 1] === undefined) throw new Error(`invalid argument near: ${key}`);
    result[key.slice(2)] = args[index + 1];
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.output) throw new Error("--input and --output are required");
const snapshot = await readNormalizedSnapshot(args.input);
const records = buildTrainingRecords(snapshot, {
  lookback: Number(args.lookback ?? 200),
  horizon: Number(args.horizon ?? 5),
  stride: Number(args.stride ?? 1),
});
const split = walkForwardSplit(records, {
  trainRatio: Number(args.trainRatio ?? 0.7),
  validationRatio: Number(args.validationRatio ?? 0.15),
});
const manifest = await exportWalkForwardDataset(args.output, split, {
  market: snapshot.metadata.market,
  symbol: snapshot.metadata.symbol,
  timeframe: snapshot.metadata.timeframe,
});
console.log(JSON.stringify(manifest, null, 2));

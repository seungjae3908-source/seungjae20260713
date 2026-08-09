import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validatePredictionInput } from "./contracts.js";

function assertSerializable(value, label) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.includes("NaN") || serialized.includes("Infinity")) {
    throw new TypeError(`${label} is not safely serializable`);
  }
  return serialized;
}

export async function appendDatasetRecord(filePath, rawInput, prediction = null, outcome = null) {
  const input = validatePredictionInput(rawInput);
  await mkdir(dirname(filePath), { recursive: true });
  const record = {
    schemaVersion: 1,
    collectedAt: input.collectedAt,
    market: input.market,
    symbol: input.symbol,
    timeframe: input.timeframe,
    horizon: input.horizon,
    source: input.source,
    input,
    prediction,
    outcome,
  };
  const line = `${assertSerializable(record, "dataset record")}\n`;
  await appendFile(filePath, line, { encoding: "utf8", flag: "a", mode: 0o600 });
  return record;
}

export async function readDataset(filePath) {
  const content = await readFile(filePath, "utf8");
  if (content.trim() === "") return [];
  return content.trimEnd().split("\n").map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new SyntaxError(`invalid JSONL at line ${index + 1}: ${error.message}`);
    }
  });
}

export async function writeModelAtomically(filePath, model) {
  const serialized = `${assertSerializable(model, "model")}\n`;
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

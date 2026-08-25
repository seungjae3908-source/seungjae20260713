import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256 } from "./data-quality.js";

export function serializeJsonl(records) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

async function atomicWrite(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await rename(temp, filePath);
}

async function writeExactSplit(filePath, records) {
  const bytes = Buffer.from(serializeJsonl(records), "utf8");
  await atomicWrite(filePath, bytes);
  const storedBytes = await readFile(filePath);
  const digest = sha256(storedBytes);
  if (digest !== sha256(bytes)) throw new Error(`stored split bytes changed during write: ${filePath}`);
  return Object.freeze({ path: filePath, count: records.length, sha256: digest, byteLength: storedBytes.length });
}

export async function exportRawTrainValidationSplits(outputRoot, { train, validation } = {}) {
  if (!Array.isArray(train) || train.length === 0) throw new TypeError("train records are required");
  if (!Array.isArray(validation) || validation.length === 0) throw new TypeError("validation records are required");
  return Object.freeze({
    train: await writeExactSplit(`${outputRoot}/train.jsonl`, train),
    validation: await writeExactSplit(`${outputRoot}/validation.jsonl`, validation),
  });
}

export async function exportWalkForwardDataset(outputRoot, split, metadata = {}) {
  const outputs = {};
  for (const name of ["train", "validation", "test"]) {
    const path = `${outputRoot}/${name}.jsonl`;
    outputs[name] = await writeExactSplit(path, split[name]);
  }
  const manifest = {
    schemaVersion: 1,
    createdAt: Date.now(),
    metadata,
    splitReport: split.report,
    outputs,
  };
  await atomicWrite(`${outputRoot}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return Object.freeze(manifest);
}

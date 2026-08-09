import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256 } from "./data-quality.js";

function serializeJsonl(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

async function atomicWrite(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await rename(temp, filePath);
}

export async function exportWalkForwardDataset(outputRoot, split, metadata = {}) {
  const outputs = {};
  for (const name of ["train", "validation", "test"]) {
    const text = serializeJsonl(split[name]);
    const path = `${outputRoot}/${name}.jsonl`;
    await atomicWrite(path, text);
    outputs[name] = Object.freeze({ path, count: split[name].length, sha256: sha256(text) });
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

import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const VOLATILE_HASH_KEYS = new Set(["collectedAt", "requestTime", "savedAt", "updatedAt"]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => !VOLATILE_HASH_KEYS.has(key)).sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Object(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function withStateLock(statePath, operation) {
  await mkdir(dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`collector state is locked: ${statePath}`);
    throw error;
  }
  try {
    return await operation();
  } finally {
    await handle?.close();
    await unlink(lockPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function readCollectorState(filePath) {
  try {
    const state = JSON.parse(await readFile(filePath, "utf8"));
    if (state?.schemaVersion !== 1 || typeof state.entries !== "object" || Array.isArray(state.entries)) {
      throw new TypeError("collector state has an unsupported schema");
    }
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 1, updatedAt: 0, entries: {} };
    throw error;
  }
}

export async function saveCollectorState(filePath, state) {
  if (state?.schemaVersion !== 1 || typeof state.entries !== "object" || Array.isArray(state.entries)) {
    throw new TypeError("invalid collector state");
  }
  await writeJsonAtomically(filePath, { ...state, updatedAt: Date.now() });
}

function assertKey(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{3,160}$/.test(key)) throw new TypeError("invalid collection key");
}

export async function saveCollectedSnapshot({ dataPath, statePath, key, snapshot }) {
  assertKey(key);
  return withStateLock(statePath, async () => {
    const hash = sha256Object(snapshot);
    const state = await readCollectorState(statePath);
    if (state.entries[key]?.hash === hash) {
      return Object.freeze({ changed: false, hash, dataPath: state.entries[key].dataPath });
    }
    await writeJsonAtomically(dataPath, snapshot);
    state.entries[key] = { hash, dataPath, collectedAt: snapshot.collectedAt ?? Date.now() };
    await saveCollectorState(statePath, state);
    return Object.freeze({ changed: true, hash, dataPath });
  });
}

async function readLastJsonlRecord(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.trimEnd().split("\n");
    if (lines.length === 0 || lines[0] === "") return null;
    return JSON.parse(lines.at(-1));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function appendCollectedRecord({ filePath, statePath, key, record }) {
  assertKey(key);
  return withStateLock(statePath, async () => {
    const hash = sha256Object(record);
    const state = await readCollectorState(statePath);
    if (state.entries[key]?.hash === hash) {
      return Object.freeze({ changed: false, hash, filePath });
    }
    const lastRecord = await readLastJsonlRecord(filePath);
    if (lastRecord?.contentHash === hash) {
      state.entries[key] = { hash, dataPath: filePath, collectedAt: record.collectedAt ?? Date.now() };
      await saveCollectorState(statePath, state);
      return Object.freeze({ changed: false, hash, filePath });
    }
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify({ ...record, contentHash: hash })}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
    state.entries[key] = { hash, dataPath: filePath, collectedAt: record.collectedAt ?? Date.now() };
    await saveCollectorState(statePath, state);
    return Object.freeze({ changed: true, hash, filePath });
  });
}

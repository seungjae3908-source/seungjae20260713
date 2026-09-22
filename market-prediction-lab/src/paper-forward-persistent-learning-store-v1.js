import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertJsonSafe(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("PAPER_FORWARD_LEARNING_VALUE_NOT_JSON_SAFE");
    return;
  }
  if (!value || typeof value !== "object") {
    throw new Error("PAPER_FORWARD_LEARNING_VALUE_NOT_JSON_SAFE");
  }
  if (seen.has(value)) throw new Error("PAPER_FORWARD_LEARNING_VALUE_NOT_JSON_SAFE");

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("PAPER_FORWARD_LEARNING_VALUE_NOT_JSON_SAFE");
  }

  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) assertJsonSafe(child, seen);
  seen.delete(value);
}

function assertSafeLearningValue(value) {
  if (!value || typeof value !== "object") throw new Error("PAPER_FORWARD_LEARNING_VALUE_REQUIRED");
  assertJsonSafe(value);
  if (value.simulatedOnly !== true
    || value.liveOrderAllowed !== false
    || value.privateTradingApiAllowed !== false
    || value.orderSubmitted !== false
    || value.exchangeRequestSent !== false
    || value.productionMutationAllowed !== false) {
    throw new Error("PAPER_FORWARD_LEARNING_SAFETY_VIOLATION");
  }
}

function assertDirectory(directory) {
  if (!nonEmpty(directory) || !isAbsolute(directory)) {
    throw new TypeError("absolute Paper Forward learning directory is required");
  }
  return resolve(directory);
}

function fileFor(directory, key) {
  return join(directory, `${sha256(key)}.json`);
}

function envelope(key, value) {
  return Object.freeze({
    schemaVersion: "paper-forward-learning-record-v1",
    key,
    value: structuredClone(value),
  });
}

async function readEnvelope(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function removeTemp(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function createFilePaperLearningStore({ directory } = {}) {
  const root = assertDirectory(directory);

  return Object.freeze({
    async putIfAbsent({ key, value }) {
      if (!nonEmpty(key)) throw new Error("PAPER_FORWARD_LEARNING_KEY_REQUIRED");
      assertSafeLearningValue(value);
      const record = envelope(key, value);
      const path = fileFor(root, key);
      const tempPath = join(root, `.${sha256(key)}.${process.pid}.${randomUUID()}.tmp`);
      await mkdir(root, { recursive: true, mode: 0o700 });

      let published = false;
      try {
        const handle = await open(tempPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }

        try {
          await link(tempPath, path);
          published = true;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      } finally {
        await removeTemp(tempPath);
      }

      if (published) return Object.freeze({ inserted: true });

      const existing = await readEnvelope(path);
      if (existing?.schemaVersion !== "paper-forward-learning-record-v1"
        || existing?.key !== key
        || stableSerialize(existing?.value) !== stableSerialize(value)) {
        throw new Error("PAPER_FORWARD_LEARNING_KEY_CONFLICT");
      }
      assertSafeLearningValue(existing.value);
      return Object.freeze({ inserted: false });
    },

    async snapshot() {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const names = (await readdir(root)).filter((name) => name.endsWith(".json")).sort();
      const rows = [];
      for (const name of names) {
        const record = await readEnvelope(join(root, name));
        if (record?.schemaVersion !== "paper-forward-learning-record-v1" || !nonEmpty(record?.key)) {
          throw new Error("PAPER_FORWARD_LEARNING_RECORD_INVALID");
        }
        if (name !== `${sha256(record.key)}.json`) {
          throw new Error("PAPER_FORWARD_LEARNING_RECORD_FILENAME_MISMATCH");
        }
        assertSafeLearningValue(record.value);
        rows.push(Object.freeze({ key: record.key, value: structuredClone(record.value) }));
      }
      return Object.freeze(rows);
    },
  });
}

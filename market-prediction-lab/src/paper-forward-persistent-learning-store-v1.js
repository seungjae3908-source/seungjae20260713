import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
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

function assertSafeLearningValue(value) {
  if (!value || typeof value !== "object") throw new Error("PAPER_FORWARD_LEARNING_VALUE_REQUIRED");
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

export function createFilePaperLearningStore({ directory } = {}) {
  const root = assertDirectory(directory);

  return Object.freeze({
    async putIfAbsent({ key, value }) {
      if (!nonEmpty(key)) throw new Error("PAPER_FORWARD_LEARNING_KEY_REQUIRED");
      assertSafeLearningValue(value);
      const record = envelope(key, value);
      const path = fileFor(root, key);
      await mkdir(root, { recursive: true, mode: 0o700 });
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return Object.freeze({ inserted: true });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

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
        assertSafeLearningValue(record.value);
        rows.push(Object.freeze({ key: record.key, value: structuredClone(record.value) }));
      }
      return Object.freeze(rows);
    },
  });
}

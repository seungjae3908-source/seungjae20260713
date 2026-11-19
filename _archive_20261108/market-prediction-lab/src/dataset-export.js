import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256 } from "./data-quality.js";

const MATERIALIZED_REFERENCE_SPLITS = new WeakSet();

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

function parseExactJsonlBytes(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new TypeError(`${label} exact stored bytes are required`);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`${label} must be valid exact UTF-8 bytes`);
  if (!text.endsWith("\n")) throw new Error(`${label} JSONL must end with one newline`);
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => line.length === 0)) throw new Error(`${label} JSONL contains an empty record`);
  const records = lines.map((line) => JSON.parse(line));
  if (records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) {
    throw new Error(`${label} JSONL records must be objects`);
  }
  return Object.freeze(records);
}

function recordIds(records, label) {
  const ids = records.map((record) => {
    if (typeof record?.id !== "string" || record.id.length === 0) throw new Error(`${label} record identity is required`);
    return record.id;
  });
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate record identity`);
  return Object.freeze(ids);
}

function identityDigest(ids) {
  return sha256(Buffer.from(`${[...ids].sort().join("\n")}\n`, "utf8"));
}

function splitDatasetIdentity(role, digest) {
  return `prediction-lab-model-reference:${role.toLowerCase()}:sha256:${digest}`;
}

export async function materializeExactTrainValidationSplits(outputRoot, { train, validation, oos } = {}) {
  if (!Array.isArray(train) || train.length === 0) throw new TypeError("train records are required");
  if (!Array.isArray(validation) || validation.length === 0) throw new TypeError("validation records are required");
  if (!Array.isArray(oos) || oos.length === 0) throw new TypeError("untouched OOS records are required for contamination proof");

  const written = {
    train: await writeExactSplit(`${outputRoot}/train.jsonl`, train),
    validation: await writeExactSplit(`${outputRoot}/validation.jsonl`, validation),
  };
  const [trainBytes, validationBytes] = await Promise.all([
    readFile(written.train.path),
    readFile(written.validation.path),
  ]);
  if (trainBytes.equals(validationBytes) || written.train.sha256 === written.validation.sha256) {
    throw new Error("TRAIN and VALIDATION exact stored bytes must be distinct");
  }

  const trainRecords = parseExactJsonlBytes(trainBytes, "TRAIN");
  const validationRecords = parseExactJsonlBytes(validationBytes, "VALIDATION");
  const trainIds = recordIds(trainRecords, "TRAIN");
  const validationIds = recordIds(validationRecords, "VALIDATION");
  const oosIds = recordIds(oos, "OOS");
  const validationSet = new Set(validationIds);
  const oosSet = new Set(oosIds);
  if (trainIds.some((id) => validationSet.has(id))) throw new Error("TRAIN and VALIDATION record identity overlap");
  if (trainIds.some((id) => oosSet.has(id)) || validationIds.some((id) => oosSet.has(id))) {
    throw new Error("TRAIN or VALIDATION contains an OOS record identity");
  }

  const result = Object.freeze({
    schemaVersion: "PredictionLabConsumedExactSplitBytesV1",
    train: Object.freeze({
      ...written.train,
      role: "TRAIN",
      datasetIdentity: splitDatasetIdentity("TRAIN", written.train.sha256),
      datasetDigest: written.train.sha256,
      bytes: trainBytes,
      records: trainRecords,
      recordIdentityDigest: identityDigest(trainIds),
    }),
    validation: Object.freeze({
      ...written.validation,
      role: "VALIDATION",
      datasetIdentity: splitDatasetIdentity("VALIDATION", written.validation.sha256),
      datasetDigest: written.validation.sha256,
      bytes: validationBytes,
      records: validationRecords,
      recordIdentityDigest: identityDigest(validationIds),
    }),
    isolation: Object.freeze({
      schemaVersion: "PredictionLabReferenceSplitIsolationV1",
      status: "PASS",
      trainValidationOverlapN: 0,
      trainOosOverlapN: 0,
      validationOosOverlapN: 0,
      oosSampleN: oosIds.length,
      oosRecordIdentityDigest: identityDigest(oosIds),
      oosRawBytesPublished: false,
      finalHoldoutAccessed: false,
      finalHoldoutIncluded: false,
    }),
  });
  MATERIALIZED_REFERENCE_SPLITS.add(result);
  return result;
}

export function isMaterializedExactTrainValidationSplits(value) {
  return Boolean(value && MATERIALIZED_REFERENCE_SPLITS.has(value));
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

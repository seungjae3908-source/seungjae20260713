import { constants } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { normalizeCandleRows } from "./normalizers.js";
import { sha256, stableStringify } from "./data-quality.js";

function safeSegment(value) {
  const segment = String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  if (!segment || segment === "." || segment === "..") throw new TypeError("invalid path segment");
  return segment;
}

function extractRows(parsed, rowsPath) {
  if (Array.isArray(parsed)) return parsed;
  if (rowsPath) {
    const rows = rowsPath.split(".").reduce((value, key) => value?.[key], parsed);
    if (Array.isArray(rows)) return rows;
  }
  for (const key of ["data", "rows", "candles", "result"]) if (Array.isArray(parsed?.[key])) return parsed[key];
  throw new TypeError("snapshot JSON does not contain an array of rows");
}

async function writeAtomically(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function appendManifestUnique(manifestPath, record) {
  await mkdir(dirname(manifestPath), { recursive: true });
  try {
    const content = await readFile(manifestPath, "utf8");
    const existing = content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const match = existing.find((item) => item.rawSha256 === record.rawSha256 && item.normalizedSha256 === record.normalizedSha256);
    if (match) return Object.freeze({ ...match, duplicateIngest: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await appendFile(manifestPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  return Object.freeze({ ...record, duplicateIngest: false });
}

export async function ingestSnapshotFile(inputPath, outputRoot, config) {
  const absoluteInput = resolve(inputPath);
  const rawBytes = await readFile(absoluteInput);
  if (rawBytes.byteLength === 0) throw new TypeError("snapshot file is empty");
  if (rawBytes.byteLength > (config.maxBytes ?? 50 * 1024 * 1024)) throw new RangeError("snapshot file exceeds maximum size");
  const extension = extname(absoluteInput).toLowerCase();
  if (extension !== ".json") throw new TypeError("only JSON snapshots are accepted in the isolated pipeline");
  const parsed = JSON.parse(rawBytes.toString("utf8"));
  const rows = extractRows(parsed, config.rowsPath);
  const normalized = normalizeCandleRows(rows, config);
  if (normalized.candles.length < 60) throw new RangeError("normalized snapshot must contain at least 60 candles");

  const rawHash = sha256(rawBytes);
  const normalizedText = `${stableStringify(normalized)}\n`;
  const normalizedHash = sha256(normalizedText);
  const root = resolve(outputRoot);
  const market = safeSegment(normalized.metadata.market);
  const symbol = safeSegment(normalized.metadata.symbol);
  const timeframe = safeSegment(normalized.metadata.timeframe);
  const fileStem = `${normalized.candles[0].timestamp}-${normalized.candles.at(-1).timestamp}-${rawHash.slice(0, 16)}`;
  const rawPath = join(root, "raw", market, symbol, timeframe, `${fileStem}${extension}`);
  const normalizedPath = join(root, "normalized", market, symbol, timeframe, `${fileStem}.normalized.json`);
  const manifestPath = join(root, "manifests", market, symbol, `${timeframe}.jsonl`);

  await mkdir(dirname(rawPath), { recursive: true });
  try { await copyFile(absoluteInput, rawPath, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  await writeAtomically(normalizedPath, normalizedText);
  const manifestRecord = {
    schemaVersion: 1,
    ingestedAt: Date.now(),
    originalName: basename(absoluteInput),
    rawPath,
    normalizedPath,
    rawSha256: rawHash,
    normalizedSha256: normalizedHash,
    candleCount: normalized.candles.length,
    firstTimestamp: normalized.candles[0].timestamp,
    lastTimestamp: normalized.candles.at(-1).timestamp,
    quality: normalized.quality,
  };
  const manifest = await appendManifestUnique(manifestPath, manifestRecord);
  return Object.freeze({ normalized, manifest });
}

export async function readNormalizedSnapshot(filePath) {
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  if (parsed?.schemaVersion !== 2 || !Array.isArray(parsed.candles)) throw new TypeError("invalid normalized snapshot schema");
  return parsed;
}

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildScannerQualityEntryV1,
  buildScannerQualityBatchV1,
  materializeForwardObserverScannerQualityArtifactV1,
} from "../src/scanner-quality-artifact-producer-v1.js";

function argument(name) {
  const prefix = `--${name}=`;
  const direct = process.argv.find((value) => value.startsWith(prefix));
  if (direct) return direct.slice(prefix.length).trim();
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`SCANNER_QUALITY_${name.toUpperCase().replace(/-/gu, "_")}_REQUIRED`);
  return value;
}

async function jsonFile(file) {
  return JSON.parse(await readFile(path.resolve(file), "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function writeMaterialized(materialized) {
  const outputDir = path.resolve(requiredArgument("output-dir"));
  await mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { mode: 0o700 });
  const qualityPath = path.join(outputDir, "quality.json");
  const manifestPath = path.join(outputDir, "manifest.json");

  // Create-only: a pre-existing evidence artifact is never silently rewritten.
  await writeFile(qualityPath, materialized.qualityText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await writeFile(manifestPath, materialized.manifestText, { encoding: "utf8", mode: 0o600, flag: "wx" });

  const [qualityReadback, manifestReadback] = await Promise.all([
    readFile(qualityPath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestReadback);
  if (sha256(qualityReadback) !== materialized.qualitySha256
      || manifest.qualitySha256 !== materialized.qualitySha256) {
    throw new Error("SCANNER_QUALITY_ARTIFACT_READBACK_DIGEST_MISMATCH");
  }

  process.stdout.write(`${JSON.stringify({
    status: "READY",
    qualityPath,
    manifestPath,
    entryCount: materialized.artifact.entries.length,
    qualitySha256: materialized.qualitySha256,
    qualityArtifactWritten: true,
    automaticPromotionAuthority: false,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
  }, null, 2)}\n`);
}

function blockedStatus(result) {
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    reason: result.reason,
    details: result.details ?? null,
    qualityArtifactWritten: false,
    executionAuthority: "NONE",
  }, null, 2)}\n`);
  process.exitCode = 2;
}

async function batchJob(row, base, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`SCANNER_QUALITY_BATCH_JOB_INVALID:${index}`);
  }
  const readRelative = async (name) => {
    const file = String(row[name] ?? "").trim();
    if (!file) throw new Error(`SCANNER_QUALITY_BATCH_FILE_REQUIRED:${name}:${index}`);
    return await jsonFile(path.resolve(base, file));
  };
  const job = {
    identity: await readRelative("identity"),
    folds: await readRelative("folds"),
    foldResults: await readRelative("foldResults"),
    datasetAudit: await readRelative("datasetAudit"),
    transactionCostEvidence: await readRelative("transactionCostEvidence"),
  };
  if (row.stockUniverseBias != null) job.stockUniverseBiasAudit = await readRelative("stockUniverseBias");
  if (row.minimumTradeCount != null) job.minimumTradeCount = row.minimumTradeCount;
  return job;
}

const batchIndexPath = argument("batch-index");
if (batchIndexPath) {
  const absolute = path.resolve(batchIndexPath);
  const batch = await jsonFile(absolute);
  if (batch?.schemaVersion !== 1 || !Array.isArray(batch.jobs)
      || batch.jobs.length === 0 || batch.jobs.length > 25_000) {
    throw new Error("SCANNER_QUALITY_BATCH_INDEX_INVALID");
  }
  const jobs = [];
  for (const [index, row] of batch.jobs.entries()) {
    jobs.push(await batchJob(row, path.dirname(absolute), index));
  }
  const built = buildScannerQualityBatchV1({ researchCodeSha: batch.researchCodeSha, jobs });
  if (built.status !== "READY") blockedStatus(built);
  else await writeMaterialized(built);
} else {
  const identity = await jsonFile(requiredArgument("identity"));
  const folds = await jsonFile(requiredArgument("folds"));
  const foldResults = await jsonFile(requiredArgument("fold-results"));
  const datasetAudit = await jsonFile(requiredArgument("dataset-audit"));
  const transactionCostEvidence = await jsonFile(requiredArgument("transaction-cost-evidence"));
  const stockUniversePath = argument("stock-universe-bias");
  const stockUniverseBiasAudit = stockUniversePath ? await jsonFile(stockUniversePath) : null;
  const minimumRaw = argument("minimum-trade-count");
  const minimumTradeCount = minimumRaw ? Number(minimumRaw) : 40;
  if (!Number.isInteger(minimumTradeCount) || minimumTradeCount < 40) {
    throw new Error("SCANNER_QUALITY_MINIMUM_TRADE_COUNT_INVALID");
  }
  const built = buildScannerQualityEntryV1({
    identity, folds, foldResults, datasetAudit, stockUniverseBiasAudit,
    transactionCostEvidence, minimumTradeCount,
  });
  if (built.status !== "READY") blockedStatus(built);
  else await writeMaterialized(materializeForwardObserverScannerQualityArtifactV1({
    researchCodeSha: identity.researchCodeSha,
    entries: [built],
  }));
}

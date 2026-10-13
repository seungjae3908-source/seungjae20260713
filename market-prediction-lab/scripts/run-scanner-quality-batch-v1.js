#!/usr/bin/env node
// Offline public-data evidence materializer, not a scanner or an order path.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildScannerQualityBatchV1 } from "../src/scanner-quality-artifact-producer-v1.js";

function argument(key) {
  const prefix = key + "=";
  const direct = process.argv.find((value) => value.startsWith(prefix));
  if (direct) return direct.slice(prefix.length).trim();
  const index = process.argv.indexOf(key);
  return index < 0 ? "" : String(process.argv[index + 1] ?? "").trim();
}

function requiredArgument(key) {
  const value = argument(key);
  if (!value || value.startsWith("--")) throw new Error("QUALITY_BATCH_ARGUMENT_REQUIRED:" + key);
  return value;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function fileFor(base, file, label) {
  if (typeof file !== "string" || !file.trim()) {
    throw new Error("QUALITY_BATCH_EVIDENCE_FILE_REQUIRED:" + label);
  }
  return path.resolve(base, file);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function main() {
  const inputPath = path.resolve(requiredArgument("--input"));
  const outputDir = path.resolve(requiredArgument("--output-dir"));
  const input = await readJson(inputPath);
  if (input?.schemaVersion !== 1 || !Array.isArray(input.jobs)
      || input.jobs.length === 0 || input.jobs.length > 25000) {
    throw new Error("QUALITY_BATCH_INDEX_SCHEMA_OR_SIZE_INVALID");
  }
  const base = path.dirname(inputPath);
  const jobs = [];
  for (const [index, row] of input.jobs.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("QUALITY_BATCH_JOB_INVALID:" + index);
    }
    const fields = [
      "identity", "folds", "foldResults", "datasetAudit", "transactionCostEvidence",
    ];
    const job = {};
    for (const name of fields) {
      job[name] = await readJson(fileFor(base, row[name], name + ":" + index));
    }
    if (row.stockUniverseBias != null) {
      job.stockUniverseBiasAudit = await readJson(
        fileFor(base, row.stockUniverseBias, "stockUniverseBias:" + index),
      );
    }
    if (row.minimumTradeCount != null) job.minimumTradeCount = row.minimumTradeCount;
    jobs.push(job);
  }
  const result = buildScannerQualityBatchV1({
    researchCodeSha: input.researchCodeSha, jobs,
  });
  if (result.status !== "READY") {
    process.stdout.write(JSON.stringify({
      status: result.status, reason: result.reason, details: result.details ?? null,
      qualityArtifactWritten: false, executionAuthority: "NONE",
    }, null, 2) + "\n");
    process.exitCode = 2;
    return;
  }
  // Deliberate create-only directory. Never overwrite a previous evidence seal.
  await mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { mode: 0o700 });
  const qualityPath = path.join(outputDir, "quality.json");
  const manifestPath = path.join(outputDir, "manifest.json");
  await writeFile(qualityPath, result.qualityText, { mode: 0o600, flag: "wx" });
  await writeFile(manifestPath, result.manifestText, { mode: 0o600, flag: "wx" });
  const [qualityReadback, manifestReadback] = await Promise.all([
    readFile(qualityPath, "utf8"), readFile(manifestPath, "utf8"),
  ]);
  if (sha256(qualityReadback) !== result.qualitySha256
      || JSON.parse(manifestReadback).qualitySha256 !== result.qualitySha256) {
    throw new Error("QUALITY_BATCH_OUTPUT_DIGEST_MISMATCH");
  }
  process.stdout.write(JSON.stringify({
    status: "READY", entryCount: result.diagnostics.entryCount,
    markets: result.diagnostics.markets, qualityPath, manifestPath,
    qualitySha256: result.qualitySha256, executionAuthority: "NONE",
    automaticPromotionAuthority: false, profitabilityClaimAllowed: false,
    liveOrderAllowed: false,
  }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({
    status: "BLOCKED_DATA", reason: String(error?.message ?? error).split(":")[0],
    qualityArtifactWritten: false, executionAuthority: "NONE",
  }) + "\n");
  process.exitCode = 1;
});

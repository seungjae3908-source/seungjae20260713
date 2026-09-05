#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildModelReferenceDriftDiagnosticV1 } from "../src/model-reference-drift-diagnostics-v1.js";
import { validateModelReferenceDurableReceiptV1 } from "../src/model-reference-durable-store-v1.js";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function requireArg(name) {
  const value = argValue(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(resolve(filePath), "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or invalid JSON: ${error?.message ?? error}`);
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function run() {
  const referenceRoot = resolve(requireArg("--reference-root"));
  const bundlePath = resolve(requireArg("--bundle"));
  const receiptPath = resolve(requireArg("--receipt"));
  const releaseMetadataPath = resolve(requireArg("--release-metadata"));
  const bundleAssetMetadataPath = resolve(requireArg("--bundle-asset-metadata"));
  const receiptAssetMetadataPath = resolve(requireArg("--receipt-asset-metadata"));
  const outputDir = resolve(requireArg("--output-dir"));
  const requestedBins = Number(argValue("--requested-bins") ?? 10);

  const [
    receipt,
    releaseMetadata,
    assetMetadata,
    receiptAssetMetadata,
    exactBundleBytes,
    exactReceiptBytes,
  ] = await Promise.all([
    readJson(receiptPath, "durable receipt"),
    readJson(releaseMetadataPath, "release metadata"),
    readJson(bundleAssetMetadataPath, "bundle asset metadata"),
    readJson(receiptAssetMetadataPath, "receipt asset metadata"),
    readFile(bundlePath),
    readFile(receiptPath),
  ]);

  const durableReceiptValidation = validateModelReferenceDurableReceiptV1(receipt, {
    releaseMetadata,
    assetMetadata,
    exactBundleBytes,
    receiptAssetMetadata,
    exactReceiptBytes,
  });
  if (!durableReceiptValidation.valid
      || durableReceiptValidation.status !== "VALID"
      || durableReceiptValidation.longTermReferenceProven !== true
      || durableReceiptValidation.publicationReceiptProven !== true) {
    throw new Error(`DURABLE_REFERENCE_PROVEN=false: ${durableReceiptValidation.reason ?? durableReceiptValidation.status}`);
  }

  const entries = await readdir(referenceRoot, { withFileTypes: true });
  const groups = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (!groups.length) throw new Error("DURABLE_REFERENCE_PROVEN=false: no reference groups in immutable bundle");

  await mkdir(outputDir, { recursive: true });
  const diagnostics = [];
  for (const group of groups) {
    const packageRoot = join(referenceRoot, group);
    const [manifest, trainBytes, validationBytes] = await Promise.all([
      readJson(join(packageRoot, "reference-manifest.json"), `${group} reference manifest`),
      readFile(join(packageRoot, "records", "train.jsonl")),
      readFile(join(packageRoot, "records", "validation.jsonl")),
    ]);
    if (manifest.group !== group) throw new Error(`${group} durable package identity mismatch`);
    const result = buildModelReferenceDriftDiagnosticV1({
      manifest,
      trainBytes,
      validationBytes,
      durableReceiptValidation,
      requestedBins,
      generatedAt: Date.now(),
    });
    await writeJson(join(outputDir, `${group}.json`), result);
    diagnostics.push(result);
  }

  const aggregate = Object.freeze({
    schemaVersion: "PredictionLabModelReferenceDriftDiagnosticBundleV1",
    status: "VALID",
    decisionStatus: "DIAGNOSTIC_ONLY",
    durableReferenceProven: true,
    durableReferenceStore: durableReceiptValidation.durableReferenceStore,
    releaseId: durableReceiptValidation.receipt.releaseId,
    releaseTag: durableReceiptValidation.receipt.releaseTag,
    targetCommitSha: durableReceiptValidation.receipt.targetCommitSha,
    groupCount: diagnostics.length,
    groups: diagnostics.map((diagnostic) => Object.freeze({
      group: diagnostic.reference.group,
      trainSampleN: diagnostic.reference.trainSampleN,
      validationSampleN: diagnostic.reference.validationSampleN,
      maxima: diagnostic.metrics.maxima,
    })),
    authority: Object.freeze({
      tuningAllowed: false,
      promotionDecisionAllowed: false,
      profitabilityClaimAllowed: false,
      statement: "Authenticated PSI/KS/JSD diagnostics do not authorize tuning, promotion, or profitability claims.",
    }),
    safety: Object.freeze({
      LIVE_TRADING: false,
      PRIVATE_TRADING_API_ALLOWED: false,
      executionAuthority: "NONE",
      orderSubmitted: false,
    }),
  });
  await writeJson(join(outputDir, "model-reference-drift-diagnostics-v1.json"), aggregate);
  process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
}

run().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});

#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSettlementProfitabilityEvidenceGate } from "../src/settlement-profitability-evidence-gate-v1.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

async function readArray(pathValue, label, { required = false } = {}) {
  if (!pathValue) {
    if (required) throw new Error(`${label} path is required`);
    return [];
  }
  const absolute = resolve(ROOT, pathValue);
  const parsed = JSON.parse(await readFile(absolute, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${label} must contain a JSON array`);
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const settlements = await readArray(args.settlements, "settlements", { required: true });
  const naturalEligibilityReceipts = await readArray(args["natural-receipts"], "natural receipts");
  const fullCostReceipts = await readArray(args["full-cost-receipts"], "full-cost receipts");
  const regimeReceipts = await readArray(args["regime-receipts"], "regime receipts");

  const result = buildSettlementProfitabilityEvidenceGate({
    settlements,
    naturalEligibilityReceipts,
    fullCostReceipts,
    regimeReceipts,
  });

  const output = args.output ? resolve(ROOT, args.output) : null;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: result.schemaVersion,
    sampleCount: result.sampleCount,
    sampleCountStatus: result.sampleCountStatus,
    naturalEligibilityStatus: result.naturalEligibility.status,
    fullCostEvidenceStatus: result.fullCostEvidence.status,
    pathEvidenceStatus: result.pathEvidence.status,
    regimeEvidenceStatus: result.regimeEvidence.status,
    scalarMaeMfeAggregationPolicy: result.scalarMaeMfeAggregationPolicy,
    p1_5Status: result.p1_5Status,
    p1_5Complete: result.p1_5Complete,
    profitabilityProven: result.profitabilityProven,
    promotion: result.promotion,
    currentValidatedChampion: result.currentValidatedChampion,
    liveTrading: result.liveTrading,
    privateTradingApiAllowed: result.privateTradingApiAllowed,
    executionAuthority: result.executionAuthority,
    realOrderCount: result.realOrderCount,
    output: output ? output.replace(`${ROOT}/`, "") : null,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});

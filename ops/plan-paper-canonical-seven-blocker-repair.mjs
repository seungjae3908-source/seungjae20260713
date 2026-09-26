#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  buildPaperCanonicalSevenBlockerRepairPlan,
} from "../market-prediction-lab/src/paper-canonical-seven-blocker-repair-plan-v1.js";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

const readinessPath = argument("readiness");
const maximumAgeText = argument("maximum-age-ms");
if (!readinessPath) fail("PAPER_CANONICAL_REPAIR_READINESS_PATH_REQUIRED");

let readiness;
try {
  readiness = JSON.parse(await readFile(readinessPath, "utf8"));
} catch {
  fail("PAPER_CANONICAL_REPAIR_READINESS_INVALID");
}

const plan = buildPaperCanonicalSevenBlockerRepairPlan(readiness);
let maximumAgeMs = null;
if (maximumAgeText) {
  maximumAgeMs = Number(maximumAgeText);
  if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs <= 0) {
    fail("PAPER_CANONICAL_REPAIR_MAXIMUM_AGE_INVALID");
  }
}

const freshnessPending = plan.sevenBlockers.includes(
  "PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_UNCONFIGURED",
);
if (freshnessPending && maximumAgeMs == null) {
  fail("PAPER_CANONICAL_REPAIR_EXPLICIT_MAXIMUM_AGE_REQUIRED");
}

process.stdout.write(`${JSON.stringify({
  ...plan,
  maximumAgeMs,
  explicitFreshnessPolicyRequired: freshnessPending,
  operationalMutationApplied: false,
}, null, 2)}\n`);

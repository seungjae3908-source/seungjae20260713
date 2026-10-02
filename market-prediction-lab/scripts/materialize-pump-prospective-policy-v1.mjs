#!/usr/bin/env node
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPumpProspectivePolicyV1,
  verifyPumpProspectivePolicyV1,
} from "../src/crypto-pump-reversal-prospective-policy-v1.js";

export const PUMP_POLICY_MATERIALIZER_VERSION =
  "crypto-pump-reversal-prospective-policy-materializer-v1";

const DAY_MS = 24 * 60 * 60 * 1000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function exactSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}
function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}
async function readExisting(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) fail("PUMP_POLICY_EXISTING_JSON_INVALID");
    throw error;
  }
}
async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function materializePumpProspectivePolicyV1({
  researchCodeSha,
  policyFrozenAtMs,
  outputPath,
} = {}) {
  const sha = String(researchCodeSha ?? "").trim().toLowerCase();
  if (!exactSha(sha)) fail("PUMP_POLICY_RESEARCH_SHA_REQUIRED");
  if (!positiveInteger(policyFrozenAtMs)) fail("PUMP_POLICY_FROZEN_AT_REQUIRED");
  if (typeof outputPath !== "string" || !isAbsolute(outputPath)) {
    fail("PUMP_POLICY_ABSOLUTE_OUTPUT_REQUIRED");
  }
  const output = resolve(outputPath);
  const existing = await readExisting(output);
  if (existing != null) {
    const verdict = verifyPumpProspectivePolicyV1(existing);
    if (!verdict.valid) fail(`PUMP_POLICY_EXISTING_INVALID:${verdict.blockers.join(",")}`);
    if (existing?.candidate?.researchCodeSha !== sha) {
      fail("PUMP_POLICY_EXISTING_RESEARCH_SHA_MISMATCH");
    }
    if (!positiveInteger(existing?.policyFrozenAtMs)
      || !positiveInteger(existing?.eligibleAfterMs)
      || existing.eligibleAfterMs < existing.policyFrozenAtMs + DAY_MS) {
      fail("PUMP_POLICY_EXISTING_FUTURE_BOUNDARY_INVALID");
    }
    return Object.freeze({
      schemaVersion: PUMP_POLICY_MATERIALIZER_VERSION,
      status: "PRESERVED_EXISTING",
      outputPath: output,
      researchCodeSha: sha,
      policyFrozenAtMs: existing.policyFrozenAtMs,
      eligibleAfterMs: existing.eligibleAfterMs,
      policyDigest: existing.policyDigest,
      executionAuthority: "NONE",
      liveTrading: false,
      privateTradingApiAllowed: false,
    });
  }

  const policy = buildPumpProspectivePolicyV1({
    researchCodeSha: sha,
    policyFrozenAtMs,
    eligibleAfterMs: policyFrozenAtMs + DAY_MS,
  });
  const verdict = verifyPumpProspectivePolicyV1(policy);
  if (!verdict.valid) fail(`PUMP_POLICY_MATERIALIZED_INVALID:${verdict.blockers.join(",")}`);
  await atomicWrite(output, policy);
  return Object.freeze({
    schemaVersion: PUMP_POLICY_MATERIALIZER_VERSION,
    status: "CREATED",
    outputPath: output,
    researchCodeSha: sha,
    policyFrozenAtMs: policy.policyFrozenAtMs,
    eligibleAfterMs: policy.eligibleAfterMs,
    policyDigest: policy.policyDigest,
    executionAuthority: "NONE",
    liveTrading: false,
    privateTradingApiAllowed: false,
  });
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const direct = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  materializePumpProspectivePolicyV1({
    researchCodeSha: arg("--research-sha"),
    policyFrozenAtMs: Number(arg("--frozen-at-ms")),
    outputPath: arg("--output"),
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: PUMP_POLICY_MATERIALIZER_VERSION,
      status: "BLOCKED_DATA",
      code: String(error?.code ?? error?.message ?? "PUMP_POLICY_MATERIALIZATION_FAILED"),
      executionAuthority: "NONE",
      liveTrading: false,
      privateTradingApiAllowed: false,
    })}\n`);
    process.exitCode = 1;
  });
}

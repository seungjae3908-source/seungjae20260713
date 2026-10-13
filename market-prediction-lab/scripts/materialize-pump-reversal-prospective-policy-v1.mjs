#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPumpProspectivePolicyV1,
  verifyPumpProspectivePolicyV1,
} from "../src/crypto-pump-reversal-prospective-policy-v1.js";

export const PUMP_PROSPECTIVE_POLICY_MATERIALIZER_VERSION =
  "pump-prospective-policy-materializer-v1";
export const PUMP_PROSPECTIVE_MINIMUM_FUTURE_BUFFER_MS = 24 * 60 * 60 * 1000;

function exactSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}
function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}
async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function materializePumpProspectivePolicyV1({
  researchCodeSha,
  policyFrozenAtMs,
  outputPath,
} = {}) {
  if (!exactSha(researchCodeSha)) throw new Error("PUMP_POLICY_RESEARCH_SHA_INVALID");
  if (!positiveInteger(policyFrozenAtMs)) throw new Error("PUMP_POLICY_FROZEN_AT_INVALID");
  if (typeof outputPath !== "string" || !isAbsolute(outputPath)) {
    throw new Error("PUMP_POLICY_OUTPUT_PATH_INVALID");
  }
  const existing = await readJsonOrNull(outputPath);
  if (existing != null) {
    const verdict = verifyPumpProspectivePolicyV1(existing);
    if (!verdict.valid
      || existing?.candidate?.researchCodeSha !== researchCodeSha
      || existing?.policyFrozenAtMs !== policyFrozenAtMs
      || existing?.eligibleAfterMs !== policyFrozenAtMs + PUMP_PROSPECTIVE_MINIMUM_FUTURE_BUFFER_MS) {
      throw new Error("PUMP_POLICY_EXISTING_IDENTITY_MISMATCH");
    }
    return Object.freeze({
      status: "REUSED",
      policy: existing,
      executionAuthority: "NONE",
      liveTrading: false,
    });
  }
  const policy = buildPumpProspectivePolicyV1({
    researchCodeSha,
    policyFrozenAtMs,
    eligibleAfterMs: policyFrozenAtMs + PUMP_PROSPECTIVE_MINIMUM_FUTURE_BUFFER_MS,
  });
  const verdict = verifyPumpProspectivePolicyV1(policy);
  if (!verdict.valid) throw new Error(`PUMP_POLICY_INVALID:${verdict.blockers.join(",")}`);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temp = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(policy, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temp, outputPath);
  return Object.freeze({
    status: "CREATED",
    policy,
    executionAuthority: "NONE",
    liveTrading: false,
  });
}

const direct = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  const researchCodeSha = String(process.env.PUMP_PROSPECTIVE_RESEARCH_SHA ?? "").trim().toLowerCase();
  const policyFrozenAtMs = Number(process.env.PUMP_PROSPECTIVE_POLICY_FROZEN_AT_MS ?? "");
  const outputPath = String(process.env.PUMP_PROSPECTIVE_POLICY_PATH ?? "");
  materializePumpProspectivePolicyV1({ researchCodeSha, policyFrozenAtMs, outputPath })
    .then((result) => process.stdout.write(`${JSON.stringify({
      schemaVersion: PUMP_PROSPECTIVE_POLICY_MATERIALIZER_VERSION,
      status: result.status,
      researchCodeSha: result.policy.candidate.researchCodeSha,
      policyFrozenAtMs: result.policy.policyFrozenAtMs,
      eligibleAfterMs: result.policy.eligibleAfterMs,
      profitabilityProven: false,
      executionAuthority: "NONE",
    })}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        schemaVersion: PUMP_PROSPECTIVE_POLICY_MATERIALIZER_VERSION,
        status: "BLOCKED_DATA",
        code: String(error?.message ?? "PUMP_POLICY_MATERIALIZATION_FAILED"),
        executionAuthority: "NONE",
      })}\n`);
      process.exitCode = 1;
    });
}

#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createPumpProspectivePaperRuntimeV1 } from "../src/crypto-pump-reversal-prospective-runtime-v1.js";
import { runPumpProspectiveScheduledInvocationV1 } from "../src/crypto-pump-reversal-prospective-store-v1.js";
import { verifyPumpProspectivePolicyV1 } from "../src/crypto-pump-reversal-prospective-policy-v1.js";

export const PUMP_RAW_SCHEDULE_RUNNER_VERSION =
  "crypto-pump-reversal-raw-prospective-schedule-v1";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function absolute(value, code) {
  if (typeof value !== "string" || !isAbsolute(value)) fail(code);
  return resolve(value);
}
async function readJson(path, code) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    fail(code);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${code}_INVALID_JSON`);
  }
}

export async function runPumpRawProspectiveScheduleV1({
  stateRoot,
  policyPath,
  ownerId = `pump-raw:${process.pid}`,
  nowMs = Date.now(),
  runtime = createPumpProspectivePaperRuntimeV1({
    sizePaperRisk: null,
    settleFullCost: null,
  }),
  invocationRunner = runPumpProspectiveScheduledInvocationV1,
} = {}) {
  const root = absolute(stateRoot, "PUMP_RAW_STATE_ROOT_REQUIRED");
  const policyFile = absolute(policyPath, "PUMP_RAW_POLICY_PATH_REQUIRED");
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) fail("PUMP_RAW_CLOCK_INVALID");
  if (!runtime || typeof runtime.run !== "function"
    || typeof invocationRunner !== "function") {
    fail("PUMP_RAW_RUNTIME_REQUIRED");
  }
  const policy = await readJson(policyFile, "PUMP_RAW_POLICY_READ_FAILED");
  const verdict = verifyPumpProspectivePolicyV1(policy);
  if (!verdict.valid) fail(`PUMP_RAW_POLICY_INVALID:${verdict.blockers.join(",")}`);
  if (policy?.candidate?.researchCodeSha == null) fail("PUMP_RAW_RESEARCH_SHA_REQUIRED");

  const result = await invocationRunner({
    rootDirectory: root,
    policy,
    nowMs,
    ownerId,
    runtime,
  });
  const summary = result?.runtime?.summary ?? result?.receipt?.runtimeSummary ?? null;
  return Object.freeze({
    schemaVersion: PUMP_RAW_SCHEDULE_RUNNER_VERSION,
    status: result?.status ?? "UNKNOWN",
    cycleId: result?.cycleId ?? null,
    policyFrozenAtMs: policy.policyFrozenAtMs,
    eligibleAfterMs: policy.eligibleAfterMs,
    researchCodeSha: policy.candidate.researchCodeSha,
    rawProspectiveScheduleActive: true,
    rawProspectiveSampleCollectionAllowed: true,
    riskSizingOwnerConnected: false,
    fullCostSettlementOwnerConnected: false,
    economicSampleCreditAllowed: false,
    summary,
    financialMutationCount: 0,
    realOrderCount: 0,
    privateRequestCount: 0,
    executionAuthority: "NONE",
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
  });
}

const direct = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  runPumpRawProspectiveScheduleV1({
    stateRoot: process.env.PUMP_PROSPECTIVE_STATE_ROOT ?? "",
    policyPath: process.env.PUMP_PROSPECTIVE_POLICY_PATH ?? "",
    ownerId: process.env.PUMP_PROSPECTIVE_OWNER_ID,
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: PUMP_RAW_SCHEDULE_RUNNER_VERSION,
      status: "BLOCKED_DATA",
      code: String(error?.code ?? error?.message ?? "PUMP_RAW_SCHEDULE_FAILED"),
      executionAuthority: "NONE",
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
    })}\n`);
    process.exitCode = 1;
  });
}

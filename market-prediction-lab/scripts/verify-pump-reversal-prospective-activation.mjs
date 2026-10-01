#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PUMP_PROSPECTIVE_ACTIVATION_VERIFIER_VERSION =
  "pump-reversal-prospective-activation-verifier-v1";
const ROOT = "/opt/stock-app-data/pump-reversal-v1";
const APP_SHA_PATH = "/opt/stock-app/.deploy/current-sha";
const TAG = "# stock-app-pump-reversal-v1";

function exactSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}
function fail(code, exitCode = 77) {
  const error = new Error(code);
  error.code = code;
  error.exitCode = exitCode;
  throw error;
}
async function json(path, code) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(code);
  }
}
async function text(path, code) {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    fail(code);
  }
}

export async function verifyPumpProspectiveActivation({
  targetSha,
  expectedProductionAppSha,
  root = ROOT,
  crontabText = null,
} = {}) {
  if (!exactSha(targetSha) || !exactSha(expectedProductionAppSha)) {
    fail("PUMP_ACTIVATION_VERIFY_IDENTITY_INVALID");
  }
  const activation = await json(join(root, "activation.json"), "PUMP_ACTIVATION_RECEIPT_MISSING");
  const policy = await json(
    join(root, "policy", "pump-prospective-policy-v1.json"),
    "PUMP_ACTIVATION_POLICY_MISSING",
  );
  const appSha = root === ROOT
    ? await text(APP_SHA_PATH, "PUMP_ACTIVATION_APP_SHA_UNREADABLE")
    : expectedProductionAppSha;
  if (appSha !== expectedProductionAppSha) fail("PUMP_ACTIVATION_PRODUCTION_APP_MUTATED");

  const activationValid = activation?.schemaVersion === "pump-reversal-prospective-schedule-activation-v1"
    && ["ACTIVE_WAITING_FOR_24H_FUTURE_BOUNDARY", "ACTIVE_GENUINE_PROSPECTIVE_ELIGIBLE"].includes(activation?.status)
    && activation?.targetSha === targetSha
    && activation?.paperRuntimeSourceSha === targetSha
    && activation?.productionAppShaBefore === expectedProductionAppSha
    && activation?.productionAppDeployPerformed === false
    && activation?.productionAppMutationAllowed === false
    && activation?.scheduleActive === true
    && activation?.pollCadence === "EVERY_1_MINUTE"
    && activation?.signalUniverseScanCadence === "ONCE_PER_CLOSED_1H_BAR"
    && activation?.positionMonitoringCadence === "INCREMENTAL_CLOSED_1M"
    && activation?.rawProspectiveCollectionActive === true
    && activation?.rawProspectiveCreditBeforeEligibleAfterMs === 0
    && activation?.economicSizingRequiresAuthoritativeEvidence === true
    && activation?.fullCostRequiresEightComponents === true
    && activation?.missingEconomicEvidenceMayBecomeZero === false
    && activation?.publicDataOnly === true
    && activation?.simulatedOnly === true
    && activation?.liveTrading === false
    && activation?.autoTrading === false
    && activation?.realOrderEnabled === false
    && activation?.privateAccountAccess === false
    && activation?.privateTradingApiAllowed === false
    && activation?.financialMutationAllowed === false
    && activation?.executionAuthority === "NONE"
    && activation?.profitabilityProven === false
    && activation?.currentValidatedChampion === "NONE"
    && Number.isSafeInteger(activation?.activationAtMs)
    && Number.isSafeInteger(activation?.policyFrozenAtMs)
    && Number.isSafeInteger(activation?.eligibleAfterMs)
    && activation.eligibleAfterMs >= activation.policyFrozenAtMs + 86_400_000;
  if (!activationValid) fail("PUMP_ACTIVATION_RECEIPT_INVALID");

  const policyValid = policy?.schemaVersion === "crypto-pump-reversal-prospective-policy-v1"
    && policy?.candidate?.researchCodeSha === targetSha
    && policy?.candidate?.strategyId === "CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1"
    && policy?.candidate?.direction === "SHORT"
    && policy?.candidate?.market === "CRYPTO_FUTURES"
    && policy?.policyFrozenAtMs === activation.policyFrozenAtMs
    && policy?.eligibleAfterMs === activation.eligibleAfterMs
    && policy?.policyDigest === activation.policyDigest
    && policy?.safety?.profitabilityProven === false
    && policy?.safety?.executionAuthority === "NONE"
    && policy?.safety?.liveTrading === false
    && policy?.safety?.autoTrading === false
    && policy?.safety?.realOrderEnabled === false
    && policy?.safety?.privateTradingApiAllowed === false;
  if (!policyValid) fail("PUMP_ACTIVATION_POLICY_INVALID");

  const cron = crontabText ?? execFileSync("crontab", ["-l"], { encoding: "utf8" });
  const cronMatches = String(cron).split(/\r?\n/u).filter((line) => line.includes(TAG));
  if (cronMatches.length !== 1) fail("PUMP_ACTIVATION_CRON_COUNT_INVALID");

  try {
    await readFile(join(root, "DISABLED"));
    fail("PUMP_ACTIVATION_DISABLED_SENTINEL_PRESENT");
  } catch (error) {
    if (error?.code && error.code !== "ENOENT") throw error;
  }

  const receiptRoot = join(root, "runtime-state", "cycle-receipts");
  let names;
  try {
    names = await readdir(receiptRoot);
  } catch {
    fail("PUMP_ACTIVATION_FIRST_CRON_NOT_OBSERVED", 75);
  }
  const receipts = [];
  for (const name of names.filter((value) => value.endsWith(".json"))) {
    const value = await json(join(receiptRoot, name), "PUMP_ACTIVATION_RECEIPT_FILE_INVALID");
    if (Number(value?.completedAtMs) >= activation.activationAtMs) receipts.push(value);
  }
  receipts.sort((left, right) => Number(left.completedAtMs) - Number(right.completedAtMs));
  const receipt = receipts.at(-1);
  if (!receipt) fail("PUMP_ACTIVATION_FIRST_CRON_NOT_OBSERVED", 75);
  if (receipt?.schemaVersion !== "crypto-pump-reversal-cycle-receipt-v1"
    || receipt?.executionAuthority !== "NONE"
    || receipt?.profitabilityProven !== false
    || receipt?.profitabilityClaimAllowed !== false
    || receipt?.profitabilityCredit !== 0
    || !Number.isInteger(receipt?.records)
    || !Number.isInteger(receipt?.fullCostSettled)
    || !Number.isInteger(receipt?.netEconomicOutcomesAvailable)) {
    fail("PUMP_ACTIVATION_FIRST_RECEIPT_INVALID");
  }

  const state = await json(join(root, "runtime-state", "state.json"), "PUMP_ACTIVATION_STATE_MISSING");
  if (state?.executionAuthority !== "NONE"
    || state?.profitabilityProven !== false
    || state?.profitabilityClaimAllowed !== false
    || state?.profitabilityCredit !== 0
    || state?.liveTrading !== false
    || state?.autoTrading !== false
    || state?.realOrderEnabled !== false
    || state?.privateTradingApiAllowed !== false
    || !Array.isArray(state?.records)) {
    fail("PUMP_ACTIVATION_STATE_SAFETY_INVALID");
  }

  return Object.freeze({
    schemaVersion: PUMP_PROSPECTIVE_ACTIVATION_VERIFIER_VERSION,
    status: "PASSED",
    targetSha,
    productionAppSha: expectedProductionAppSha,
    activationAtMs: activation.activationAtMs,
    eligibleAfterMs: activation.eligibleAfterMs,
    scheduleActive: true,
    paperStateSnapshotAvailableAtActivation: activation.paperStateSnapshotAvailableAtActivation === true,
    supplementalCostEvidenceAvailableAtActivation:
      activation.supplementalCostEvidenceAvailableAtActivation === true,
    economicSizingReadyAtActivation: activation.economicSizingReadyAtActivation === true,
    firstCycle: Object.freeze({
      cycleId: receipt.cycleId,
      completedAtMs: receipt.completedAtMs,
      records: receipt.records,
      openPositions: receipt.openPositions,
      exitTriggered: receipt.exitTriggered,
      fullCostSettled: receipt.fullCostSettled,
      netEconomicOutcomesAvailable: receipt.netEconomicOutcomesAvailable,
    }),
    rawProspectiveCreditBeforeEligibleAfterMs: 0,
    profitabilityProven: false,
    currentValidatedChampion: "NONE",
    financialMutationCount: 0,
    realOrderCount: 0,
    privateRequestCount: 0,
    executionAuthority: "NONE",
    liveTrading: false,
    sensitiveValuesEmitted: false,
  });
}

const direct = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  const targetSha = String(process.argv[2] ?? "").trim().toLowerCase();
  const expectedProductionAppSha = String(process.argv[3] ?? "").trim().toLowerCase();
  verifyPumpProspectiveActivation({ targetSha, expectedProductionAppSha })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const code = String(error?.code ?? error?.message ?? "PUMP_ACTIVATION_VERIFY_FAILED");
      process.stderr.write(`${JSON.stringify({
        schemaVersion: PUMP_PROSPECTIVE_ACTIVATION_VERIFIER_VERSION,
        status: "BLOCKED_DATA",
        code,
        executionAuthority: "NONE",
        sensitiveValuesEmitted: false,
      })}\n`);
      process.exitCode = Number(error?.exitCode ?? 77);
    });
}

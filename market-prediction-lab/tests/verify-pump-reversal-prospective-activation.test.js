import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyPumpProspectiveActivation } from "../scripts/verify-pump-reversal-prospective-activation.mjs";

const SHA = "a".repeat(40);
const APP = "b".repeat(40);
const NOW = 1_800_000_000_000;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pump-verify-"));
  await mkdir(join(root, "policy"), { recursive: true });
  await mkdir(join(root, "runtime-state", "cycle-receipts"), { recursive: true });
  const policy = {
    schemaVersion: "crypto-pump-reversal-prospective-policy-v1",
    policyFrozenAtMs: NOW,
    eligibleAfterMs: NOW + 86_400_000,
    policyDigest: "c".repeat(64),
    candidate: {
      researchCodeSha: SHA,
      strategyId: "CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1",
      direction: "SHORT",
      market: "CRYPTO_FUTURES",
    },
    safety: {
      profitabilityProven: false,
      executionAuthority: "NONE",
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
    },
  };
  const activation = {
    schemaVersion: "pump-reversal-prospective-schedule-activation-v1",
    status: "ACTIVE_WAITING_FOR_24H_FUTURE_BOUNDARY",
    targetSha: SHA,
    paperRuntimeSourceSha: SHA,
    policyResearchCodeSha: SHA,
    operationalRetryEquivalenceVerified: false,
    productionAppShaBefore: APP,
    productionAppDeployPerformed: false,
    productionAppMutationAllowed: false,
    activationAtMs: NOW + 1,
    policyFrozenAtMs: NOW,
    eligibleAfterMs: NOW + 86_400_000,
    policyDigest: policy.policyDigest,
    scheduleActive: true,
    pollCadence: "EVERY_1_MINUTE",
    signalUniverseScanCadence: "ONCE_PER_CLOSED_1H_BAR",
    positionMonitoringCadence: "INCREMENTAL_CLOSED_1M",
    rawProspectiveCollectionActive: true,
    rawProspectiveCreditBeforeEligibleAfterMs: 0,
    paperStateSnapshotAvailableAtActivation: false,
    supplementalCostEvidenceAvailableAtActivation: false,
    economicSizingReadyAtActivation: false,
    economicSizingRequiresAuthoritativeEvidence: true,
    fullCostRequiresEightComponents: true,
    missingEconomicEvidenceMayBecomeZero: false,
    publicDataOnly: true,
    simulatedOnly: true,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateAccountAccess: false,
    privateTradingApiAllowed: false,
    financialMutationAllowed: false,
    executionAuthority: "NONE",
    profitabilityProven: false,
    currentValidatedChampion: "NONE",
  };
  const receipt = {
    schemaVersion: "crypto-pump-reversal-cycle-receipt-v1",
    cycleId: "cycle-1",
    completedAtMs: NOW + 60_000,
    records: 0,
    openPositions: 0,
    exitTriggered: 0,
    fullCostSettled: 0,
    netEconomicOutcomesAvailable: 0,
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
    profitabilityCredit: 0,
    executionAuthority: "NONE",
  };
  const state = {
    records: [],
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
    profitabilityCredit: 0,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
  await writeFile(join(root, "policy", "pump-prospective-policy-v1.json"), JSON.stringify(policy));
  await writeFile(join(root, "activation.json"), JSON.stringify(activation));
  await writeFile(join(root, "runtime-state", "cycle-receipts", "cycle.json"), JSON.stringify(receipt));
  await writeFile(join(root, "runtime-state", "state.json"), JSON.stringify(state));
  return root;
}

test("activation verifier accepts a zero-credit first natural cron", async () => {
  const root = await fixture();
  try {
    const result = await verifyPumpProspectiveActivation({
      targetSha: SHA,
      expectedProductionAppSha: APP,
      root,
      crontabText: "* * * * * /usr/bin/flock -n /tmp/pump /tmp/wrapper # stock-app-pump-reversal-v1\n",
    });
    assert.equal(result.status, "PASSED");
    assert.equal(result.firstCycle.records, 0);
    assert.equal(result.firstCycle.fullCostSettled, 0);
    assert.equal(result.rawProspectiveCreditBeforeEligibleAfterMs, 0);
    assert.equal(result.executionAuthority, "NONE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activation verifier waits when no post-activation receipt exists", async () => {
  const root = await fixture();
  try {
    await rm(join(root, "runtime-state", "cycle-receipts", "cycle.json"));
    await assert.rejects(
      () => verifyPumpProspectiveActivation({
        targetSha: SHA,
        expectedProductionAppSha: APP,
        root,
        crontabText: "* * * * * x # stock-app-pump-reversal-v1\n",
      }),
      (error) => error?.code === "PUMP_ACTIVATION_FIRST_CRON_NOT_OBSERVED"
        && error?.exitCode === 75,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("activation verifier accepts a verified operational-only cross-SHA retry", async () => {
  const root = await fixture();
  const retrySha = "d".repeat(40);
  try {
    const activationPath = join(root, "activation.json");
    const activation = JSON.parse(await readFile(activationPath, "utf8"));
    activation.targetSha = retrySha;
    activation.paperRuntimeSourceSha = retrySha;
    activation.policyResearchCodeSha = SHA;
    activation.operationalRetryEquivalenceVerified = true;
    await writeFile(activationPath, JSON.stringify(activation));

    const result = await verifyPumpProspectiveActivation({
      targetSha: retrySha,
      expectedProductionAppSha: APP,
      root,
      crontabText: "* * * * * x # stock-app-pump-reversal-v1\n",
    });
    assert.equal(result.status, "PASSED");
    assert.equal(result.policyResearchCodeSha, SHA);
    assert.equal(result.operationalRetryEquivalenceVerified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activation verifier rejects cross-SHA policy reuse without operational equivalence proof", async () => {
  const root = await fixture();
  const retrySha = "d".repeat(40);
  try {
    const activationPath = join(root, "activation.json");
    const activation = JSON.parse(await readFile(activationPath, "utf8"));
    activation.targetSha = retrySha;
    activation.paperRuntimeSourceSha = retrySha;
    activation.policyResearchCodeSha = SHA;
    activation.operationalRetryEquivalenceVerified = false;
    await writeFile(activationPath, JSON.stringify(activation));

    await assert.rejects(
      () => verifyPumpProspectiveActivation({
        targetSha: retrySha,
        expectedProductionAppSha: APP,
        root,
        crontabText: "* * * * * x # stock-app-pump-reversal-v1\n",
      }),
      (error) => error?.code === "PUMP_ACTIVATION_RECEIPT_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

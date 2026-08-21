import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  prepareResearchProductionIdentityCutover,
  runPaperForwardScheduleCli,
} from "../scripts/run-paper-forward-schedule.js";

const SHA = "1".repeat(40);
const PUBLISHER_DIGEST = "2".repeat(64);
const NOW = Date.UTC(2026, 7, 22, 1, 0, 0);

function runtimePackage(snapshot) {
  return Object.freeze({
    schemaVersion: "authoritative-paper-runtime-package-loaded-v1",
    sourceSha: SHA,
    sourceGraphSha256: "3".repeat(64),
    bundleSha256: "4".repeat(64),
    admissionBundleSchemaVersion: "scanner-paper-admission-evidence-bundle-v1",
    callbackOwnerContractSchemaVersion: "authoritative-paper-callback-owner-contract-v1",
    blockedDataSourceContractSchemaVersion: "authoritative-paper-blocked-data-source-contract-v1",
    costPolicyVersion: null,
    costPolicyVersionBinding: Object.freeze({ status: "RUNTIME_EXACT_REQUIRED", unknownIsZero: false }),
    executionAuthority: "NONE",
    privateApiAllowed: false,
    liveTrading: false,
    scheduleActivationAuthority: false,
    financialMutationAllowed: false,
    createPaperAdmissionEvidenceProducer: () => async () => Object.freeze({ status: "BLOCKED" }),
    createAuthoritativePaperEvidenceSourceWiring: () => Object.freeze({}),
    validateImmutablePaperTradingStateSnapshot: (value) => {
      assert.equal(value.sourceSha, snapshot.sourceSha);
      return value;
    },
  });
}

function snapshot() {
  const at = new Date(NOW).toISOString();
  return {
    schemaVersion: "paper-trading-state-snapshot-v2",
    state: {
      schemaVersion: 1,
      account: {
        id: "paper-cli-account",
        initialBalance: 10_000,
        cashBalance: 10_000,
        realizedPnl: 0,
        unrealizedPnl: 0,
        equity: 10_000,
        usedMargin: 0,
        availableMargin: 10_000,
        createdAt: at,
        updatedAt: at,
      },
      orders: [], positions: [], fills: [], journal: [], processedEventIds: [],
      riskState: { dayKey: "2026-08-22", weekKey: "2026-W34", dailyRealizedPnl: 0, weeklyRealizedPnl: 0, consecutiveLosses: 0 },
      createdAt: at,
      updatedAt: at,
    },
    sourceOwner: "authenticated-paper-trading-evaluate-v2",
    sourceSha: SHA,
    market: "CRYPTO_FUTURES",
    currency: "USDT",
    provenance: ["authenticated-member-session"],
    publisherAccountIdSha256: PUBLISHER_DIGEST,
    observedAtMs: NOW,
    stateUpdatedAtMs: NOW,
    maximumAgeMs: 3_600_000,
    accountId: "paper-cli-account",
    equity: 10_000,
    openPositionCount: 0,
    stateDigestSha256: "5".repeat(64),
    immutable: true,
    executionAuthority: "NONE",
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
    unknownIsZero: false,
  };
}

test("explicit no-deploy outcome mode fails closed before state cutover when authenticated seed config is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-cli-account-missing-"));
  const stateFile = join(root, "state", "recurring-paper-loop.json");
  await mkdir(dirname(stateFile), { recursive: true });
  const predecessor = { identity: { researchCodeSha: "a".repeat(40), strategyId: "paper-forward-simulated-outcome-v1" } };
  await writeFile(stateFile, `${JSON.stringify(predecessor)}\n`);

  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const output = await runPaperForwardScheduleCli({
      PAPER_FORWARD_SCHEDULE_ACTIVE: "true",
      RESEARCH_PRODUCTION: "true",
      PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED: "true",
      PAPER_FORWARD_RESEARCH_SHA: SHA,
      PAPER_FORWARD_ACTIVATION_AT_MS: String(NOW),
      PAPER_FORWARD_ROOT: root,
    }, {
      authoritativePaperPackageLoader: async () => runtimePackage(snapshot()),
      runScheduledInvocation: async () => {
        throw new Error("must not run without authenticated seed");
      },
    });

    assert.equal(output, undefined);
    assert.equal(process.exitCode, 1);
    const stillThere = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(stillThere.identity.researchCodeSha, "a".repeat(40));
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("authoritative identity cutover uses a distinct strategy id", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-cli-account-cutover-"));
  const result = await prepareResearchProductionIdentityCutover({
    rootDirectory: root,
    researchCodeSha: SHA,
    outcomeAccumulationEnabled: true,
    authoritativeAccountRequired: true,
    nowMs: NOW,
  });
  assert.equal(result.targetStrategyId, "paper-forward-authoritative-account-v1");
});

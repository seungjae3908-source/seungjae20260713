import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function buildEnv(stateRoot) {
  return Object.freeze({
    PAPER_FORWARD_SCHEDULE_ACTIVE: "true",
    RESEARCH_PRODUCTION: "true",
    PAPER_FORWARD_RESEARCH_SHA: SHA,
    PAPER_FORWARD_ACTIVATION_AT_MS: "1",
    PAPER_FORWARD_ROOT: join(stateRoot, "runtime"),
  });
}

function buildBasePackage() {
  return Object.freeze({
    schemaVersion: "authoritative-paper-runtime-package-loaded-v1",
    manifest: Object.freeze({ paperStateSnapshotSchemaVersion: "paper-trading-state-snapshot-v2" }),
    sourceSha: SHA,
    sourceGraphSha256: "a".repeat(64),
    bundleSha256: "b".repeat(64),
    admissionBundleSchemaVersion: "scanner-paper-admission-evidence-bundle-v1",
    callbackOwnerContractSchemaVersion: "authoritative-paper-callback-owner-contract-v1",
    blockedDataSourceContractSchemaVersion: "authoritative-paper-blocked-data-source-contract-v1",
    simulatedExecutionEvidenceSchemaVersion: "paper-simulated-execution-evidence-v1",
    costPolicyVersion: null,
    costPolicyVersionBinding: Object.freeze({ status: "RUNTIME_EXACT_REQUIRED" }),
    createPaperAdmissionEvidenceProducer: () => async () => Object.freeze({ status: "BLOCKED_DATA" }),
    createAuthoritativePaperNaturalCycleEvidenceSourceWiring: () => ({}),
    createImmutablePaperTradingStateSnapshot: () => ({}),
    validateImmutablePaperTradingStateSnapshot: () => ({}),
    buildPaperSimulatedExecutionEvidence: () => ({}),
    collectAuthoritativePaperLatencyCostEvidence: () => ({}),
    readBitgetPublicLatencyMidpointQuote: () => null,
    executionAuthority: "NONE",
    privateApiAllowed: false,
    liveTrading: false,
    scheduleActivationAuthority: false,
    financialMutationAllowed: false,
  });
}

function baseDeps(overrides) {
  return {
    authoritativePaperDependenciesFactory: () => ({
      sourceWiringAudit: { status: "BLOCKED_DATA", blockers: [], missingCallbacks: [], dataBlockers: [] },
      publicEvidenceProvider: { collectPublicEvidence: async () => ({}) },
    }),
    runScheduledInvocation: async () => ({ status: "READY", cycleId: null, mutationCount: 0 }),
    alphaHandoffReader: async () => null,
    alphaArchitectureReadinessBuilder: () => ({ architectureReady: false, blockers: [] }),
    paperStateOwnerFactory: () => ({
      schemaVersion: "lossless-paper-state-snapshot-file-owner-v2",
      snapshotPath: null,
      paperStateForCard: () => null,
      writePaperStateSnapshot: null,
      initializesPaperState: false,
      recurringLedgerDerivationAllowed: false,
      authenticatedPublisherRequired: true,
      exactAccountBindingRequired: true,
      unknownIsZero: false,
    }),
    ...overrides,
  };
}

async function loadScheduler() {
  return import("../scripts/run-paper-forward-schedule.js");
}

test("M1' fallback: paperStateForCard wired from paperStateSnapshotForCard when canonical omits paperStateForCard", async () => {
  const root = await mkdtemp(join(tmpdir(), "m1p-fallback-a-"));
  try {
    await mkdir(join(root, "forward", "paper"), { recursive: true });
    let capturedSourceWiring = null;
    const snapshotFn = async () => ({ sourceSha: SHA, state: {} });
    const mockCanonical = Object.freeze({
      paperStateSnapshotForCard: snapshotFn,
      paperCandidateForCard: async () => null,
      learningSnapshotForCard: async () => null,
      contractRulesForCard: async () => null,
      publicEvidenceForCard: async () => null,
      executionObservationForCard: async () => null,
      supplementalCostEvidenceForCard: async () => null,
    });
    const pkg = Object.freeze({
      ...buildBasePackage(),
      createAuthoritativePaperNaturalCycleEvidenceSourceWiring: () => mockCanonical,
    });
    const deps = baseDeps({
      authoritativePaperDependenciesFactory: ({ sourceWiring }) => {
        capturedSourceWiring = sourceWiring;
        return {
          sourceWiringAudit: { status: "BLOCKED_DATA", blockers: [], missingCallbacks: [], dataBlockers: [] },
          publicEvidenceProvider: { collectPublicEvidence: async () => ({}) },
        };
      },
    });
    const { runPaperForwardScheduleCli } = await loadScheduler();
    await runPaperForwardScheduleCli(buildEnv(root), {
      ...deps,
      authoritativePaperPackageLoader: async () => pkg,
    });
    assert.ok(capturedSourceWiring, "dependencies factory was invoked");
    assert.equal(typeof capturedSourceWiring.paperStateSnapshotForCard, "function", "original paperStateSnapshotForCard preserved");
    assert.equal(typeof capturedSourceWiring.paperStateForCard, "function", "M1' fallback added paperStateForCard");
    assert.equal(capturedSourceWiring.paperStateForCard, snapshotFn, "fallback points to paperStateSnapshotForCard");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("M1' fallback: does not override an explicitly provided paperStateForCard", async () => {
  const root = await mkdtemp(join(tmpdir(), "m1p-fallback-b-"));
  try {
    await mkdir(join(root, "forward", "paper"), { recursive: true });
    let capturedSourceWiring = null;
    const snapshotFn = async () => ({ sourceSha: SHA, state: {} });
    const explicitFn = async () => ({ sourceSha: SHA, state: { explicit: true } });
    const mockCanonical = Object.freeze({
      paperStateSnapshotForCard: snapshotFn,
      paperStateForCard: explicitFn,
      paperCandidateForCard: async () => null,
      learningSnapshotForCard: async () => null,
      contractRulesForCard: async () => null,
      publicEvidenceForCard: async () => null,
      executionObservationForCard: async () => null,
      supplementalCostEvidenceForCard: async () => null,
    });
    const pkg = Object.freeze({
      ...buildBasePackage(),
      createAuthoritativePaperNaturalCycleEvidenceSourceWiring: () => mockCanonical,
    });
    const deps = baseDeps({
      authoritativePaperDependenciesFactory: ({ sourceWiring }) => {
        capturedSourceWiring = sourceWiring;
        return {
          sourceWiringAudit: { status: "BLOCKED_DATA", blockers: [], missingCallbacks: [], dataBlockers: [] },
          publicEvidenceProvider: { collectPublicEvidence: async () => ({}) },
        };
      },
    });
    const { runPaperForwardScheduleCli } = await loadScheduler();
    await runPaperForwardScheduleCli(buildEnv(root), {
      ...deps,
      authoritativePaperPackageLoader: async () => pkg,
    });
    assert.ok(capturedSourceWiring, "dependencies factory was invoked");
    assert.equal(capturedSourceWiring.paperStateForCard, explicitFn, "explicit paperStateForCard preserved");
    assert.equal(capturedSourceWiring.paperStateSnapshotForCard, snapshotFn, "original snapshot preserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("M1' fallback: does NOT apply when paperStateSnapshotForCard is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "m1p-fallback-c-"));
  try {
    await mkdir(join(root, "forward", "paper"), { recursive: true });
    let capturedSourceWiring = null;
    const mockCanonical = Object.freeze({
      paperCandidateForCard: async () => null,
      learningSnapshotForCard: async () => null,
      contractRulesForCard: async () => null,
      publicEvidenceForCard: async () => null,
      executionObservationForCard: async () => null,
      supplementalCostEvidenceForCard: async () => null,
    });
    const pkg = Object.freeze({
      ...buildBasePackage(),
      createAuthoritativePaperNaturalCycleEvidenceSourceWiring: () => mockCanonical,
    });
    const deps = baseDeps({
      authoritativePaperDependenciesFactory: ({ sourceWiring }) => {
        capturedSourceWiring = sourceWiring;
        return {
          sourceWiringAudit: { status: "BLOCKED_DATA", blockers: [], missingCallbacks: [], dataBlockers: [] },
          publicEvidenceProvider: { collectPublicEvidence: async () => ({}) },
        };
      },
    });
    const { runPaperForwardScheduleCli } = await loadScheduler();
    await runPaperForwardScheduleCli(buildEnv(root), {
      ...deps,
      authoritativePaperPackageLoader: async () => pkg,
    });
    assert.ok(capturedSourceWiring, "dependencies factory was invoked");
    assert.equal(capturedSourceWiring.paperStateForCard, undefined, "fallback NOT applied when snapshot is missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

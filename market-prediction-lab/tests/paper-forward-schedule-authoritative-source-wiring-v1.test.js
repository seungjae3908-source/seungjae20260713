import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as authoritativePaperRuntime from "../runtime/authoritative-paper-runtime-v1/authoritative-paper-runtime-v1.mjs";
import {
  finalizeCanonicalNaturalStageEvidence,
  runPaperForwardScheduleCli,
} from "../scripts/run-paper-forward-schedule.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PUBLISHER_ACCOUNT_ID_SHA256 = createHash("sha256")
  .update("publisher-account-fixture")
  .digest("hex");

function paperState(nowMs) {
  const at = new Date(nowMs - 1_000).toISOString();
  return {
    schemaVersion: 1,
    account: {
      id: "paper_state_schedule_fixture",
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
    orders: [],
    positions: [],
    fills: [],
    journal: [],
    riskState: {
      dayKey: at.slice(0, 10),
      weekKey: "2026-W35",
      dailyRealizedPnl: 0,
      weeklyRealizedPnl: 0,
      consecutiveLosses: 0,
    },
    processedEventIds: [],
    createdAt: at,
    updatedAt: at,
  };
}

function runtimePackageFixture() {
  return Object.freeze({
    schemaVersion: "authoritative-paper-runtime-package-loaded-v1",
    manifest: Object.freeze({ paperStateSnapshotSchemaVersion: "paper-trading-state-snapshot-v2" }),
    sourceSha: "3dae58f78d1118bc5b9f5b431adbfa50d63d4f5c",
    sourceGraphSha256: "a".repeat(64),
    bundleSha256: "b".repeat(64),
    admissionBundleSchemaVersion: "scanner-paper-admission-evidence-bundle-v1",
    callbackOwnerContractSchemaVersion: "authoritative-paper-callback-owner-contract-v1",
    blockedDataSourceContractSchemaVersion: "authoritative-paper-blocked-data-source-contract-v1",
    simulatedExecutionEvidenceSchemaVersion: "paper-simulated-execution-evidence-v1",
    costPolicyVersion: null,
    costPolicyVersionBinding: Object.freeze({ status: "RUNTIME_EXACT_REQUIRED" }),
    createPaperAdmissionEvidenceProducer: () => async () => Object.freeze({ status: "BLOCKED_DATA" }),
    createAuthoritativePaperEvidenceSourceWiring:
      authoritativePaperRuntime.createAuthoritativePaperEvidenceSourceWiring,
    createImmutablePaperTradingStateSnapshot:
      authoritativePaperRuntime.createImmutablePaperTradingStateSnapshot,
    validateImmutablePaperTradingStateSnapshot:
      authoritativePaperRuntime.validateImmutablePaperTradingStateSnapshot,
    executionAuthority: "NONE",
    privateApiAllowed: false,
    liveTrading: false,
    scheduleActivationAuthority: false,
    financialMutationAllowed: false,
  });
}

async function runReadonlyPaperStateCase({
  bindingSha = SHA,
  snapshotSha = bindingSha,
  bindingDigest = PUBLISHER_ACCOUNT_ID_SHA256,
  snapshotDigest = bindingDigest,
  observedAtMs = Date.now(),
  maximumAgeMs = 30_000,
  removeBeforeCallback = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "paper-state-readonly-schedule-"));
  const snapshotPath = join(root, "publisher", "paper-state-v2.json");
  const bindingPath = join(root, "publisher-binding.json");
  await mkdir(join(root, "publisher"), { recursive: true });
  const runtimePackage = runtimePackageFixture();
  const state = paperState(observedAtMs);
  const snapshot = runtimePackage.createImmutablePaperTradingStateSnapshot({
    state,
    sourceOwner: "AUTHENTICATED_PAPER_STATE_TEST_FIXTURE",
    sourceSha: snapshotSha,
    market: "CRYPTO_FUTURES",
    currency: "USDT",
    provenance: ["canonical-paper-state-readonly-transport-test"],
    publisherAccountIdSha256: snapshotDigest,
    observedAtMs,
    maximumAgeMs,
  });
  const binding = {
    schemaVersion: "paper-state-publisher-runtime-binding-v1",
    paperRuntimeSourceSha: bindingSha,
    snapshotPath,
    publisherAccountIdSha256: bindingDigest,
    immutable: true,
    executionAuthority: "NONE",
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  };
  await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
  await writeFile(bindingPath, `${JSON.stringify(binding)}\n`);

  let paperStateSeen = undefined;
  let callbackError = null;
  const output = await runPaperForwardScheduleCli(Object.freeze({
    PAPER_FORWARD_SCHEDULE_ACTIVE: "true",
    RESEARCH_PRODUCTION: "true",
    PAPER_FORWARD_RESEARCH_SHA: SHA,
    PAPER_FORWARD_ACTIVATION_AT_MS: "1",
    PAPER_FORWARD_PUBLISHER_BINDING_PATH: bindingPath,
    PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH: snapshotPath,
    PAPER_FORWARD_ROOT: join(root, "runtime"),
  }), {
    authoritativePaperPackageLoader: async () => runtimePackage,
    authoritativePaperDependenciesFactory: ({ sourceWiring }) => Object.freeze({
      publicEvidenceProvider: Object.freeze({
        async collectPublicEvidence() {
          paperStateSeen = await sourceWiring.paperStateForCard();
          return Object.freeze({ status: "BLOCKED_DATA" });
        },
      }),
      sourceWiringAudit: Object.freeze({
        status: "CALLBACKS_CONNECTED_BLOCKED_DATA",
        firstZeroStage: "UNKNOWN",
        firstZeroReason: "AUTHORITATIVE_EVIDENCE_DATA_UNAVAILABLE",
        blockers: Object.freeze([]),
        stageMeasurements: Object.freeze([]),
      }),
    }),
    runScheduledInvocation: async (input) => {
      if (removeBeforeCallback) await rm(snapshotPath, { force: true });
      try {
        await input.publicEvidenceProvider.collectPublicEvidence({ market: "CRYPTO_FUTURES" });
      } catch (error) {
        if (!removeBeforeCallback) throw error;
        callbackError = error;
      }
      return Object.freeze({ status: "READY", mutationCount: 0 });
    },
  });
  return { root, output, paperStateSeen, state, callbackError };
}

function directStage(count, prefix, overrides = {}) {
  return Object.freeze({
    status: "MEASURED",
    count,
    blocker: null,
    provenance: `${prefix}-direct-boundary`,
    observedAt: "2026-08-24T00:00:00.000Z",
    observationIds: Object.freeze(Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`)),
    ...overrides,
  });
}

function canonicalSources(overrides = {}) {
  return {
    producerEvidence: {
      stageCounts: {
        signalCandidate: directStage(3, "signal"),
        qualityPassed: directStage(2, "quality"),
        riskPassed: directStage(1, "risk"),
      },
      reasonObservations: [],
    },
    loopEvidence: {
      stageCounts: {
        entryEligible: directStage(1, "eligible"),
        entry: directStage(1, "entry"),
        position: directStage(1, "position"),
        settlement: directStage(1, "settlement"),
      },
      reasonObservations: [],
    },
    exitEligibilityEvidence: {
      status: "MEASURED",
      exitEligibleCount: 1,
      provenance: "exact-open-position-identity-join",
      observations: [{ observationId: "exit-1", exitEligible: true, observedAt: "2026-08-24T00:00:00.000Z" }],
      reasonObservations: [],
    },
    cycleId: "natural-cycle-1",
    researchCodeSha: SHA,
    datasetIdentity: "natural-dataset-1",
    naturalScheduleInvocation: true,
    replayed: false,
    ...overrides,
  };
}

test("Research Production recurring CLI injects the audited authoritative source-wiring provider by default", async () => {
  const sourceWiring = Object.freeze({ marker: "concrete-source-owner-input" });
  const publicEvidenceProvider = Object.freeze({
    collectPublicEvidence: async () => Object.freeze({ status: "BLOCKED_DATA" }),
  });
  const sourceWiringAudit = Object.freeze({
    status: "CALLBACKS_CONNECTED_BLOCKED_DATA",
    firstZeroStage: "UNKNOWN",
    firstZeroReason: "AUTHORITATIVE_EVIDENCE_DATA_UNAVAILABLE",
    blockers: Object.freeze(["AUTHORITATIVE_PAPER_STATE_SOURCE_UNAVAILABLE"]),
    stageMeasurements: Object.freeze([]),
    scannerCandidateCount: null,
    canonicalPaperCandidateCount: null,
    entryCount: null,
    settlementCount: null,
  });
  let dependenciesInput = null;
  let invocation = null;

  const output = await runPaperForwardScheduleCli(Object.freeze({
    PAPER_FORWARD_SCHEDULE_ACTIVE: "true",
    RESEARCH_PRODUCTION: "true",
    PAPER_FORWARD_RESEARCH_SHA: SHA,
    PAPER_FORWARD_ACTIVATION_AT_MS: "1",
    PAPER_FORWARD_ROOT: join(tmpdir(), `paper-forward-source-wiring-${process.pid}-${Date.now()}`),
  }), {
    authoritativePaperSourceWiring: sourceWiring,
    authoritativePaperDependenciesFactory: (input) => {
      dependenciesInput = input;
      return Object.freeze({ publicEvidenceProvider, sourceWiringAudit });
    },
    runScheduledInvocation: async (input) => {
      invocation = input;
      return Object.freeze({
        status: "READY",
        cycleId: null,
        mutationCount: 0,
        invocation: Object.freeze({
          naturalScheduleInvocation: true,
          publicForwardEvidenceAccumulating: false,
          paperTradeOutcomeAccumulationEnabled: true,
          paperTradeOutcomeAccumulating: false,
        }),
        persistedStatus: Object.freeze({ simulatedFinancialAdaptersEnabled: true }),
      });
    },
  });

  assert.equal(dependenciesInput.sourceWiring.marker, sourceWiring.marker);
  assert.equal(typeof dependenciesInput.sourceWiring.createPaperAdmissionEvidenceProducer, "function");
  assert.equal(dependenciesInput.providerOptions.env.RESEARCH_PRODUCTION, "true");
  assert.equal(typeof invocation.publicEvidenceProvider.collectPublicEvidence, "function");
  assert.equal(invocation.outcomeAccumulationEnabled, true);
  assert.equal(output.authoritativeSourceWiringStatus, "CALLBACKS_CONNECTED_BLOCKED_DATA");
  assert.equal(output.firstZeroStage, "UNKNOWN");
  assert.equal(output.firstZeroReason, "AUTHORITATIVE_EVIDENCE_DATA_UNAVAILABLE");
  assert.deepEqual(output.authoritativeSourceBlockers, sourceWiringAudit.blockers);
  assert.equal(output.scannerCandidateCount, null);
  assert.equal(output.entryCount, null);
  assert.match(output.authoritativeRuntimePackage.bundleSha256, /^[0-9a-f]{64}$/u);
  assert.equal(output.authoritativeRuntimePackage.sourceSha, "3dae58f78d1118bc5b9f5b431adbfa50d63d4f5c");
  assert.equal(output.authoritativeRuntimePackage.executionAuthority, "NONE");
  assert.equal(output.authoritativeRuntimePackage.privateApiAllowed, false);
  assert.equal(
    output.authoritativeRuntimePackage.blockedDataSourceContractSchemaVersion,
    "authoritative-paper-blocked-data-source-contract-v1",
  );
  assert.equal(
    output.authoritativeRuntimePackage.callbackOwnerContractSchemaVersion,
    "authoritative-paper-callback-owner-contract-v1",
  );
  assert.deepEqual(output.authoritativeEvidenceOwners, {
    ownerExists: 7,
    ownerMissing: 0,
    callbacksWired: 7,
    authoritativeOwnersConnected: 7,
    runtimeBlockedDataOwners: 4,
    scannerCallbackWired: true,
    scheduledCanonicalWriter: "AUTHENTICATED_EXACT_ACCOUNT_PUBLISHER_CONNECTED",
    allOwnersReady: false,
    firstZeroStage: "UNKNOWN",
    firstBlocker: "AUTHORITATIVE_EVIDENCE_DATA_UNAVAILABLE",
    unknownIsZero: false,
  });
  assert.equal(output.paperStateTransport.status, "BLOCKED_DATA_CONFIG_ABSENT");
  assert.equal(output.paperStateTransport.state, "MISSING");
  assert.equal(output.paperStateTransport.reason, "PAPER_STATE_SNAPSHOT_MISSING");
  assert.equal(output.paperStateTransport.callbackInvoked, false);
});

test("configured lossless Paper snapshot reader replaces only the scheduled state owner callback", async () => {
  let snapshotCallbackCalls = 0;
  const snapshotReader = async () => {
    snapshotCallbackCalls += 1;
    return Object.freeze({ schemaVersion: 1, account: Object.freeze({ id: "paper" }) });
  };
  let sourceWiringSeen = null;
  let snapshotFactoryInput = null;
  const output = await runPaperForwardScheduleCli(Object.freeze({
    PAPER_FORWARD_SCHEDULE_ACTIVE: "true",
    RESEARCH_PRODUCTION: "true",
    PAPER_FORWARD_RESEARCH_SHA: SHA,
    PAPER_FORWARD_ACTIVATION_AT_MS: "1",
    PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH: "C:/lossless/paper-state.json",
    PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256: PUBLISHER_ACCOUNT_ID_SHA256,
    PAPER_FORWARD_ROOT: join(tmpdir(), `paper-forward-lossless-state-${process.pid}-${Date.now()}`),
  }), {
    paperStateSourceFactory: (input) => {
      snapshotFactoryInput = input;
      return snapshotReader;
    },
    authoritativePaperDependenciesFactory: ({ sourceWiring }) => {
      sourceWiringSeen = sourceWiring;
      return Object.freeze({
        publicEvidenceProvider: Object.freeze({
          collectPublicEvidence: async () => {
            await sourceWiring.paperStateForCard();
            return Object.freeze({ status: "BLOCKED_DATA" });
          },
        }),
        sourceWiringAudit: Object.freeze({
          status: "CALLBACKS_CONNECTED_BLOCKED_DATA",
          firstZeroStage: "UNKNOWN",
          firstZeroReason: "AUTHORITATIVE_EVIDENCE_DATA_UNAVAILABLE",
          blockers: Object.freeze([
            "AUTHORITATIVE_CONTRACT_RULES_SOURCE_UNAVAILABLE",
            "AUTHORITATIVE_EXECUTION_OBSERVATION_SOURCE_UNAVAILABLE",
            "AUTHORITATIVE_SUPPLEMENTAL_COST_SOURCE_UNAVAILABLE",
          ]),
          stageMeasurements: Object.freeze([]),
        }),
      });
    },
    runScheduledInvocation: async (input) => {
      await input.publicEvidenceProvider.collectPublicEvidence({ market: "CRYPTO_FUTURES" });
      return Object.freeze({ status: "READY", mutationCount: 0 });
    },
  });

  assert.equal(snapshotFactoryInput.snapshotPath, "C:/lossless/paper-state.json");
  assert.equal(snapshotFactoryInput.expectedPublisherAccountIdSha256, PUBLISHER_ACCOUNT_ID_SHA256);
  assert.equal(typeof snapshotFactoryInput.runtimePackage.validateImmutablePaperTradingStateSnapshot, "function");
  assert.equal(typeof sourceWiringSeen.paperStateForCard, "function");
  assert.equal(sourceWiringSeen.paperStateForCard.authoritativeBlockedData, undefined);
  assert.equal(sourceWiringSeen.contractRulesForCard.authoritativeOwner.ownerStatus, "OWNER_EXISTS");
  assert.equal(sourceWiringSeen.contractRulesForCard.authoritativeOwner.missingDataBehavior, "BLOCKED_DATA");
  assert.equal(snapshotCallbackCalls, 1);
  assert.equal(output.paperStateTransport.status, "CONFIGURED_EXACT_ACCOUNT_BOUND");
  assert.equal(output.paperStateTransport.state, "PRESENT");
  assert.equal(output.paperStateTransport.publisherAccountBound, true);
  assert.equal(output.paperStateTransport.callbackInvocationCount, 1);
  assert.equal(output.paperStateTransport.callbackInvoked, true);
  assert.equal(output.paperStateTransport.unknownIsZero, false);
});

test("fresh exact-account and exact-cycle snapshot becomes PRESENT through the existing callback owner", async () => {
  const result = await runReadonlyPaperStateCase();
  try {
    assert.deepEqual(result.paperStateSeen, result.state);
    assert.equal(result.output.paperStateTransport.state, "PRESENT");
    assert.equal(result.output.paperStateTransport.reason, null);
    assert.equal(result.output.paperStateTransport.publisherAccountBound, true);
    assert.equal(result.output.paperStateTransport.sourceShaExact, true);
    assert.equal(result.output.paperStateTransport.observedAtMs > 0, true);
    assert.equal(result.output.paperStateTransport.callbackInvocationCount, 1);
  } finally {
    await rm(result.root, { recursive: true, force: true });
  }
});

test("stale canonical snapshot is classified STALE and remains fail-closed", async () => {
  const result = await runReadonlyPaperStateCase({ observedAtMs: Date.now() - 120_000 });
  try {
    assert.equal(result.paperStateSeen, null);
    assert.equal(result.output.paperStateTransport.state, "STALE");
    assert.equal(result.output.paperStateTransport.reason, "PAPER_STATE_SNAPSHOT_STALE_OR_FUTURE");
    assert.equal(result.output.paperStateTransport.callbackInvoked, false);
  } finally {
    await rm(result.root, { recursive: true, force: true });
  }
});

test("wrong publisher account snapshot is classified and fails closed", async () => {
  const result = await runReadonlyPaperStateCase({
    bindingDigest: "b".repeat(64),
    snapshotDigest: PUBLISHER_ACCOUNT_ID_SHA256,
  });
  try {
    assert.equal(result.paperStateSeen, null);
    assert.equal(result.output.paperStateTransport.state, "WRONG_ACCOUNT");
    assert.equal(
      result.output.paperStateTransport.reason,
      "PAPER_STATE_PUBLISHER_ACCOUNT_BINDING_MISMATCH",
    );
    assert.equal(result.output.paperStateTransport.publisherAccountBound, false);
    assert.equal(result.output.paperStateTransport.callbackInvoked, false);
  } finally {
    await rm(result.root, { recursive: true, force: true });
  }
});

test("wrong Research cycle snapshot is classified and fails closed", async () => {
  const wrongSha = "f".repeat(40);
  const result = await runReadonlyPaperStateCase({ bindingSha: wrongSha });
  try {
    assert.equal(result.paperStateSeen, null);
    assert.equal(result.output.paperStateTransport.state, "WRONG_CYCLE");
    assert.equal(result.output.paperStateTransport.reason, "PAPER_STATE_SOURCE_SHA_MISMATCH");
    assert.equal(result.output.paperStateTransport.sourceShaExact, false);
    assert.equal(result.output.paperStateTransport.callbackInvoked, false);
  } finally {
    await rm(result.root, { recursive: true, force: true });
  }
});

test("callback read failure is controlled and leaks neither raw exception nor snapshot path", async () => {
  const result = await runReadonlyPaperStateCase({ removeBeforeCallback: true });
  try {
    assert.equal(result.paperStateSeen, undefined);
    assert.equal(result.output.paperStateTransport.state, "INVALID");
    assert.equal(result.output.paperStateTransport.reason, "PAPER_STATE_SNAPSHOT_INVALID");
    assert.equal(result.output.paperStateTransport.callbackInvoked, true);
    assert.equal(result.callbackError?.code, "PAPER_STATE_SNAPSHOT_INVALID");
    assert.equal(result.callbackError?.message, "PAPER_STATE_SNAPSHOT_INVALID");
    assert.equal(String(result.callbackError).includes(result.root), false);
  } finally {
    await rm(result.root, { recursive: true, force: true });
  }
});

test("scheduled CLI reports a FIRST_ZERO only from the actually executed measured stage prefix", async () => {
  const stageMeasurements = Object.freeze([
    Object.freeze({ stage: "Scanner Candidate", status: "MEASURED", count: 2, blocker: null, provenance: "scanner", measuredAtMs: 10 }),
    Object.freeze({ stage: "Profit Gate", status: "MEASURED", count: 0, blocker: null, provenance: "profit-gate", measuredAtMs: 10 }),
    Object.freeze({ stage: "Identity", status: "MEASURED", count: 0, blocker: null, provenance: "identity", measuredAtMs: 10 }),
    Object.freeze({ stage: "Paper Admission", status: "MEASURED", count: 0, blocker: null, provenance: "admission", measuredAtMs: 10 }),
    Object.freeze({ stage: "Entry", status: "UNKNOWN", count: null, blocker: "ENTRY_NOT_MEASURED", provenance: null, measuredAtMs: null }),
    Object.freeze({ stage: "Position", status: "UNKNOWN", count: null, blocker: "POSITION_NOT_MEASURED", provenance: null, measuredAtMs: null }),
    Object.freeze({ stage: "Exit", status: "MEASURED", count: 0, blocker: null, provenance: "exit-signal", measuredAtMs: 10 }),
    Object.freeze({ stage: "Settlement", status: "UNKNOWN", count: null, blocker: "SETTLEMENT_NOT_MEASURED", provenance: null, measuredAtMs: null }),
  ]);
  const publicEvidenceProvider = Object.freeze({
    collectPublicEvidence: async () => Object.freeze({
      status: "BLOCKED_DATA",
      blocker: "AUTHORITATIVE_PAPER_STATE_SOURCE_UNAVAILABLE",
      paperCandidateSource: Object.freeze({
        stageMeasurements,
        firstZeroStage: "Profit Gate",
        firstZeroReason: "MEASURED_ZERO",
      }),
    }),
  });
  const output = await runPaperForwardScheduleCli(Object.freeze({
    PAPER_FORWARD_SCHEDULE_ACTIVE: "true",
    RESEARCH_PRODUCTION: "true",
    PAPER_FORWARD_RESEARCH_SHA: SHA,
    PAPER_FORWARD_ACTIVATION_AT_MS: "1",
    PAPER_FORWARD_ROOT: join(tmpdir(), `paper-forward-stage-measurements-${process.pid}-${Date.now()}`),
  }), {
    authoritativePaperDependenciesFactory: () => Object.freeze({
      publicEvidenceProvider,
      sourceWiringAudit: Object.freeze({
        status: "CALLBACKS_CONNECTED_BLOCKED_DATA",
        firstZeroStage: "UNKNOWN",
        firstZeroReason: "AUTHORITATIVE_EVIDENCE_DATA_UNAVAILABLE",
        blockers: Object.freeze(["AUTHORITATIVE_PAPER_STATE_SOURCE_UNAVAILABLE"]),
        stageMeasurements: Object.freeze([]),
      }),
    }),
    runScheduledInvocation: async (input) => {
      await input.publicEvidenceProvider.collectPublicEvidence({ market: "CRYPTO_FUTURES" });
      return Object.freeze({ status: "READY", mutationCount: 0 });
    },
  });

  assert.equal(output.firstZeroStage, "Profit Gate");
  assert.equal(output.firstZeroReason, "MEASURED_ZERO");
  assert.equal(output.scannerCandidateCount, 2);
  assert.equal(output.canonicalPaperCandidateCount, 0);
  assert.equal(output.entryCount, null);
  assert.equal(output.settlementCount, null);
  assert.equal(output.authoritativeStageMeasurements, stageMeasurements);
});

test("Research Production recurring CLI does not double-wrap an explicitly injected canonical runtime", async () => {
  const paperRuntimeForMarket = async () => Object.freeze({ status: "VALID_NO_TRADE" });
  let invocation = null;

  const output = await runPaperForwardScheduleCli(Object.freeze({
    PAPER_FORWARD_SCHEDULE_ACTIVE: "true",
    RESEARCH_PRODUCTION: "true",
    PAPER_FORWARD_RESEARCH_SHA: SHA,
    PAPER_FORWARD_ACTIVATION_AT_MS: "1",
    PAPER_FORWARD_ROOT: join(tmpdir(), `paper-forward-runtime-wiring-${process.pid}-${Date.now()}`),
  }), {
    meaningfulSearchPaperRuntimeForMarket: paperRuntimeForMarket,
    runScheduledInvocation: async (input) => {
      invocation = input;
      return Object.freeze({ status: "READY", mutationCount: 0 });
    },
  });

  assert.equal(typeof invocation.publicEvidenceProvider?.collectPublicEvidence, "function");
  assert.equal(output.authoritativeSourceWiringStatus, null);
});

test("Research Production recurring CLI installs callback owners and defers missing data to per-card validation", async () => {
  let invocation = null;
  const output = await runPaperForwardScheduleCli(Object.freeze({
    PAPER_FORWARD_SCHEDULE_ACTIVE: "true",
    RESEARCH_PRODUCTION: "true",
    PAPER_FORWARD_RESEARCH_SHA: SHA,
    PAPER_FORWARD_ACTIVATION_AT_MS: "1",
    PAPER_FORWARD_ROOT: join(tmpdir(), `paper-forward-missing-sources-${process.pid}-${Date.now()}`),
  }), {
    runScheduledInvocation: async (input) => {
      invocation = input;
      return Object.freeze({ status: "READY", mutationCount: 0 });
    },
  });

  assert.equal(typeof invocation.publicEvidenceProvider?.collectPublicEvidence, "function");
  assert.equal(invocation.outcomeAccumulationEnabled, true);
  assert.equal(output.authoritativeSourceWiringStatus, "CALLABLES_READY");
  assert.equal(output.firstZeroStage, "UNKNOWN");
  assert.equal(output.firstZeroReason, null);
  assert.deepEqual(output.authoritativeSourceBlockers, []);
  assert.equal(output.scannerCandidateCount, null);
  assert.equal(output.canonicalPaperCandidateCount, null);
  assert.equal(output.entryCount, null);
  assert.equal(output.settlementCount, null);
});

test("canonical Natural Paper evidence preserves distinct stage provenance and classifies only a measured prefix", () => {
  const sources = canonicalSources();
  sources.loopEvidence = {
    ...sources.loopEvidence,
    stageCounts: {
      ...sources.loopEvidence.stageCounts,
      entryEligible: directStage(0, "eligible"),
      entry: directStage(0, "entry"),
      position: directStage(0, "position"),
      settlement: directStage(0, "settlement"),
    },
    reasonObservations: [{
      observationId: "account-block-1",
      sourceStage: "ENTRY_ELIGIBLE",
      rawReason: "AUTHORITATIVE_ACCOUNT_STATE_BLOCKED",
      canonicalReason: "ACCOUNT_STATE_BLOCK",
      lossless: true,
    }],
  };
  sources.exitEligibilityEvidence = {
    ...sources.exitEligibilityEvidence,
    exitEligibleCount: 0,
    observations: [],
  };

  const evidence = finalizeCanonicalNaturalStageEvidence(sources);

  assert.equal(evidence.firstZeroStage, "ENTRY_ELIGIBLE");
  assert.equal(evidence.firstZeroReason, "ACCOUNT_STATE_BLOCK");
  assert.equal(evidence.stageCounts.signalCandidate.count, 3);
  assert.equal(evidence.stageCounts.qualityPassed.count, 2);
  assert.equal(evidence.stageCounts.riskPassed.count, 1);
  assert.notEqual(evidence.stageCounts.entry.provenance, evidence.stageCounts.position.provenance);
  assert.equal(evidence.replayCredit, 0);
  assert.equal(evidence.duplicateCredit, 0);
});

test("canonical Natural Paper evidence leaves FIRST_ZERO unknown when an earlier direct boundary is unmeasured", () => {
  const sources = canonicalSources();
  sources.producerEvidence = {
    ...sources.producerEvidence,
    stageCounts: {
      ...sources.producerEvidence.stageCounts,
      qualityPassed: { status: "UNKNOWN", count: null, blocker: "QUALITY_GATE_NOT_DIRECTLY_OBSERVED" },
      riskPassed: directStage(0, "risk"),
    },
  };

  const evidence = finalizeCanonicalNaturalStageEvidence(sources);

  assert.equal(evidence.stageCounts.qualityPassed.status, "UNKNOWN");
  assert.equal(evidence.firstZeroStage, "UNKNOWN");
  assert.equal(evidence.firstZeroReason, "UNKNOWN");
  assert.equal(evidence.unknownIsZero, false);
});

test("replay never receives canonical Natural Paper stage credit", () => {
  const evidence = finalizeCanonicalNaturalStageEvidence(canonicalSources({ replayed: true }));

  assert.equal(evidence.firstZeroStage, "UNKNOWN");
  assert.equal(evidence.firstZeroReason, "REPLAY_ONLY");
  assert.equal(evidence.naturalCredit, 0);
  assert.equal(evidence.replayCredit, 0);
  assert.equal(evidence.duplicateCredit, 0);
  assert.ok(Object.values(evidence.stageCounts).every((stage) => stage.status === "UNKNOWN"));
});

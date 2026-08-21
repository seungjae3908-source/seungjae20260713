import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPaperForwardScheduleCli } from "../scripts/run-paper-forward-schedule.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

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
  assert.equal(output.authoritativeRuntimePackage.sourceSha, "3f85003368830fb570c05b3b2060da39f515696d");
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
    scheduledCanonicalWriter: "CONNECTED_NO_UPSTREAM_STATE_SYNTHESIS",
    allOwnersReady: false,
    firstZeroStage: "UNKNOWN",
    firstBlocker: "AUTHORITATIVE_EVIDENCE_DATA_UNAVAILABLE",
    unknownIsZero: false,
  });
});

test("configured lossless Paper snapshot reader replaces only the scheduled state owner callback", async () => {
  const snapshotReader = async () => Object.freeze({ schemaVersion: 1, account: Object.freeze({ id: "paper" }) });
  let sourceWiringSeen = null;
  let snapshotFactoryInput = null;
  await runPaperForwardScheduleCli(Object.freeze({
    PAPER_FORWARD_SCHEDULE_ACTIVE: "true",
    RESEARCH_PRODUCTION: "true",
    PAPER_FORWARD_RESEARCH_SHA: SHA,
    PAPER_FORWARD_ACTIVATION_AT_MS: "1",
    PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH: "C:/lossless/paper-state.json",
    PAPER_FORWARD_ROOT: join(tmpdir(), `paper-forward-lossless-state-${process.pid}-${Date.now()}`),
  }), {
    paperStateSourceFactory: (input) => {
      snapshotFactoryInput = input;
      return snapshotReader;
    },
    authoritativePaperDependenciesFactory: ({ sourceWiring }) => {
      sourceWiringSeen = sourceWiring;
      return Object.freeze({
        publicEvidenceProvider: Object.freeze({ collectPublicEvidence: async () => Object.freeze({ status: "BLOCKED_DATA" }) }),
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
    runScheduledInvocation: async () => Object.freeze({ status: "READY", mutationCount: 0 }),
  });

  assert.equal(snapshotFactoryInput.snapshotPath, "C:/lossless/paper-state.json");
  assert.equal(typeof snapshotFactoryInput.runtimePackage.validateImmutablePaperTradingStateSnapshot, "function");
  assert.equal(sourceWiringSeen.paperStateForCard, snapshotReader);
  assert.equal(sourceWiringSeen.paperStateForCard.authoritativeBlockedData, undefined);
  assert.equal(sourceWiringSeen.contractRulesForCard.authoritativeOwner.ownerStatus, "OWNER_EXISTS");
  assert.equal(sourceWiringSeen.contractRulesForCard.authoritativeOwner.missingDataBehavior, "BLOCKED_DATA");
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

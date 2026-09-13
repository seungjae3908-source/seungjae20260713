import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTHORITATIVE_PAPER_SCHEDULE_STAGE_ADOPTION_VERSION,
  runPaperForwardScheduledInvocationWithAuthoritativeStageEvidenceV1,
} from "../src/paper-forward-schedule-runtime-v1.js";

const RESEARCH_SHA = "c".repeat(40);
const DIGEST = "b".repeat(64);
const CANDIDATE_ID = `phase3-candidate:sha256:${"a".repeat(64)}`;
const IDENTITY = Object.freeze({
  candidateId: CANDIDATE_ID,
  strategyFamily: "trend-following",
  strategyId: "strategy-alpha",
  strategyVersion: "v7",
  parameterHash: DIGEST,
  parameterDigest: DIGEST,
  researchCodeSha: RESEARCH_SHA,
  costPolicyVersion: "full-cost-v3",
  executionPolicyVersion: "paper-exec-v1",
  market: "CRYPTO_FUTURES",
  provider: "bitget",
  symbol: "BTCUSDT",
  timeframe: "15m",
  sidePolicy: "LONG",
  accountMode: "PAPER",
});

function safety() {
  return {
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
  };
}

function strategyIdentity() {
  return Object.freeze({
    candidateId: IDENTITY.candidateId,
    strategyFamily: IDENTITY.strategyFamily,
    strategyId: IDENTITY.strategyId,
    strategyVersion: IDENTITY.strategyVersion,
    parameterHash: IDENTITY.parameterHash,
    parameterDigest: IDENTITY.parameterDigest,
    researchCodeSha: IDENTITY.researchCodeSha,
    costPolicyVersion: IDENTITY.costPolicyVersion,
    executionPolicyVersion: IDENTITY.executionPolicyVersion,
    accountMode: IDENTITY.accountMode,
  });
}

function scheduleIdentity(researchCodeSha = RESEARCH_SHA) {
  return Object.freeze({
    strategyId: "paper-forward-authoritative-account-v1",
    strategyVersion: "1.0.0",
    parameterHash: "d".repeat(64),
    researchCodeSha,
    costPolicyVersion: "paper-forward-authoritative-accounting-v1",
    executionPolicyVersion: "public-evidence-simulated-paper-v1",
  });
}

function candidate() {
  const identity = strategyIdentity();
  return Object.freeze({
    signal: Object.freeze({
      signalId: "signal-1",
      market: IDENTITY.market,
      symbol: IDENTITY.symbol,
      timeframe: IDENTITY.timeframe,
      direction: IDENTITY.sidePolicy,
      signalDirection: IDENTITY.sidePolicy,
      strategyIdentity: identity,
    }),
    execution: Object.freeze({
      dataEvidence: Object.freeze({ provider: IDENTITY.provider }),
    }),
    paperIdentity: Object.freeze({
      ...identity,
      market: IDENTITY.market,
      symbol: IDENTITY.symbol,
      timeframe: IDENTITY.timeframe,
      direction: IDENTITY.sidePolicy,
      provider: IDENTITY.provider,
    }),
    ...safety(),
  });
}

function stage(name, status, count, blocker = null) {
  return Object.freeze({
    stage: name,
    status,
    count,
    blocker,
    provenance: status === "MEASURED" ? `test:${name}` : null,
    measuredAtMs: status === "MEASURED" ? 1_789_000_000_000 : null,
  });
}

function evidence(candidates = [candidate()]) {
  return Object.freeze({
    status: "READY",
    candidates: Object.freeze(candidates),
    paperCandidateSource: Object.freeze({
      stageMeasurements: Object.freeze([
        stage("Scanner Candidate", "MEASURED", 1),
        stage("Profit Gate", "MEASURED", 1),
        stage("Identity", "MEASURED", 1),
        stage("Paper Admission", "MEASURED", 1),
        stage("Entry", "UNKNOWN", null, "RECURRING_PAPER_ENTRY_NOT_MEASURED_BY_ADMISSION_RUNTIME"),
        stage("Position", "UNKNOWN", null, "RECURRING_PAPER_POSITION_NOT_MEASURED_BY_ADMISSION_RUNTIME"),
        stage("Exit", "MEASURED", 1),
        stage("Settlement", "UNKNOWN", null, "RECURRING_PAPER_SETTLEMENT_NOT_MEASURED_BY_ADMISSION_RUNTIME"),
      ]),
    }),
  });
}

function directStage(field, id) {
  return Object.freeze({
    field,
    status: "MEASURED",
    count: 1,
    blocker: null,
    provenance: `recurring-paper-loop-v1:${field}`,
    observedAt: 1_789_000_000_100,
    observationIds: Object.freeze([id]),
    naturalCredit: 0,
    replayCredit: 0,
    duplicateCredit: 0,
  });
}

function sample() {
  return Object.freeze({
    paperSampleId: "sample-1",
    identity: Object.freeze({
      candidateId: IDENTITY.candidateId,
      strategyFamily: IDENTITY.strategyFamily,
      strategyId: IDENTITY.strategyId,
      strategyVersion: IDENTITY.strategyVersion,
      parameterHash: IDENTITY.parameterHash,
      parameterDigest: IDENTITY.parameterDigest,
      researchCodeSha: IDENTITY.researchCodeSha,
      accountMode: IDENTITY.accountMode,
      market: IDENTITY.market,
      symbol: IDENTITY.symbol,
      timeframe: IDENTITY.timeframe,
      executionDirection: IDENTITY.sidePolicy,
    }),
    profitEvidence: Object.freeze({ costPolicyId: IDENTITY.costPolicyVersion }),
    entryEvidenceProvenance: Object.freeze({ provider: IDENTITY.provider }),
  });
}

function position() {
  return Object.freeze({
    positionId: "position-1",
    candidateId: IDENTITY.candidateId,
    strategyFamily: IDENTITY.strategyFamily,
    strategyId: IDENTITY.strategyId,
    strategyVersion: IDENTITY.strategyVersion,
    parameterHash: IDENTITY.parameterHash,
    parameterDigest: IDENTITY.parameterDigest,
    researchCodeSha: IDENTITY.researchCodeSha,
    accountMode: IDENTITY.accountMode,
    costPolicyVersion: IDENTITY.costPolicyVersion,
    market: IDENTITY.market,
    symbol: IDENTITY.symbol,
    direction: IDENTITY.sidePolicy,
    sample: sample(),
  });
}

function settlement() {
  return Object.freeze({
    settlementId: "settlement-1",
    candidateId: IDENTITY.candidateId,
    strategyFamily: IDENTITY.strategyFamily,
    strategyId: IDENTITY.strategyId,
    strategyVersion: IDENTITY.strategyVersion,
    parameterHash: IDENTITY.parameterHash,
    parameterDigest: IDENTITY.parameterDigest,
    researchCodeSha: IDENTITY.researchCodeSha,
    accountMode: IDENTITY.accountMode,
    costPolicyVersion: IDENTITY.costPolicyVersion,
    market: IDENTITY.market,
    symbol: IDENTITY.symbol,
    timeframe: IDENTITY.timeframe,
    entryDirection: IDENTITY.sidePolicy,
    entryEvidenceProvenance: Object.freeze({ provider: IDENTITY.provider }),
    exitEvidenceProvenance: Object.freeze({ provider: IDENTITY.provider }),
  });
}

function recurringResult() {
  return Object.freeze({
    status: "COMPLETED",
    state: Object.freeze({
      identity: scheduleIdentity(),
      samples: Object.freeze([sample()]),
      positions: Object.freeze([position()]),
      settlements: Object.freeze([settlement()]),
    }),
    summary: Object.freeze({
      canonicalNaturalStageEvidence: Object.freeze({
        schemaVersion: "canonical-natural-paper-loop-stage-evidence-v1",
        identity: Object.freeze({ strategySha: RESEARCH_SHA, runtimeSha: RESEARCH_SHA }),
        stageCounts: Object.freeze({
          entry: directStage("entry", "sample-1"),
          position: directStage("position", "position-1"),
          settlement: directStage("settlement", "settlement-1"),
        }),
        naturalCredit: 0,
        replayCredit: 0,
        duplicateCredit: 0,
        replayed: false,
      }),
    }),
  });
}

test("schedule callsite adopts already-produced authoritative runtime and recurring evidence without dispatch", async () => {
  let providerCalls = 0;
  let baseCalls = 0;
  const result = await runPaperForwardScheduledInvocationWithAuthoritativeStageEvidenceV1({
    input: {
      publicEvidenceProvider: Object.freeze({
        async collectPublicEvidence(input) {
          providerCalls += 1;
          assert.equal(input.market, "CRYPTO_FUTURES");
          return evidence();
        },
      }),
    },
    runBase: async (input) => {
      baseCalls += 1;
      await input.publicEvidenceProvider.collectPublicEvidence({ market: "CRYPTO_FUTURES" });
      return recurringResult();
    },
  });

  assert.equal(baseCalls, 1);
  assert.equal(providerCalls, 1);
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.status, "RECONCILED");
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.candidateId, CANDIDATE_ID);
  assert.equal(result.summary.authoritativeRuntimeStageEvidenceConnection.status, "RECONCILED");
  assert.equal(result.authoritativeRuntimeStageMeasurements.find((row) => row.stage === "Entry")?.status, "MEASURED");
  assert.equal(result.authoritativeRuntimeStageMeasurements.find((row) => row.stage === "Position")?.status, "MEASURED");
  assert.equal(result.authoritativeRuntimeStageMeasurements.find((row) => row.stage === "Settlement")?.status, "MEASURED");
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.sampleCredit, 0);
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.executionRealismCredit, 0);
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.profitabilityCredit, 0);
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.executionAuthority, "NONE");
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.dispatchAllowed, false);
});

test("schedule process identity must bind to the same immutable research SHA", async () => {
  const result = await runPaperForwardScheduledInvocationWithAuthoritativeStageEvidenceV1({
    input: {
      publicEvidenceProvider: Object.freeze({
        async collectPublicEvidence() {
          return evidence();
        },
      }),
    },
    runBase: async (input) => {
      await input.publicEvidenceProvider.collectPublicEvidence({ market: "CRYPTO_FUTURES" });
      const recurring = recurringResult();
      return Object.freeze({
        ...recurring,
        state: Object.freeze({ ...recurring.state, identity: scheduleIdentity("d".repeat(40)) }),
      });
    },
  });

  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.status, "BLOCKED");
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.blocker, "PAPER_STAGE_SCHEDULE_RUNTIME_RESEARCH_SHA_MISMATCH");
  assert.equal(result.authoritativeRuntimeStageMeasurements, null);
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.profitabilityCredit, 0);
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.executionAuthority, "NONE");
});

test("schedule callsite fails closed on ambiguous runtime evidence and keeps lifecycle measurements unavailable", async () => {
  const result = await runPaperForwardScheduledInvocationWithAuthoritativeStageEvidenceV1({
    input: {
      publicEvidenceProvider: Object.freeze({
        async collectPublicEvidence() {
          return evidence();
        },
      }),
    },
    runBase: async (input) => {
      await input.publicEvidenceProvider.collectPublicEvidence({ market: "CRYPTO_FUTURES" });
      await input.publicEvidenceProvider.collectPublicEvidence({ market: "CRYPTO_FUTURES" });
      return recurringResult();
    },
  });

  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.schemaVersion, AUTHORITATIVE_PAPER_SCHEDULE_STAGE_ADOPTION_VERSION);
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.status, "BLOCKED");
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.blocker, "PAPER_SCHEDULE_AUTHORITATIVE_STAGE_EVIDENCE_AMBIGUOUS");
  assert.equal(result.authoritativeRuntimeStageMeasurements, null);
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.sampleCredit, 0);
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.profitabilityCredit, 0);
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.executionAuthority, "NONE");
  assert.equal(result.authoritativeRuntimeStageEvidenceConnection.dispatchAllowed, false);
});

test("production schedule callsite publishes candidate performance at its canonical status path", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "paper-schedule-performance-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const result = await runPaperForwardScheduledInvocationWithAuthoritativeStageEvidenceV1({
    input: {
      rootDirectory,
      publicEvidenceProvider: Object.freeze({
        async collectPublicEvidence() {
          return evidence();
        },
      }),
    },
    runBase: async (input) => {
      await input.publicEvidenceProvider.collectPublicEvidence({ market: "CRYPTO_FUTURES" });
      return Object.freeze({ ...recurringResult(), rootDirectory });
    },
  });
  const artifact = JSON.parse(await readFile(join(rootDirectory, "status", "candidate-performance.json"), "utf8"));
  assert.equal(result.frozenCandidatePerformancePublication.status, "PUBLISHED");
  assert.equal(result.frozenCandidatePerformancePublication.artifactRelativePath, "status/candidate-performance.json");
  assert.equal(artifact.status, "BLOCKED");
  assert.equal(artifact.FIRST_ZERO, "PHASE4_EXISTING_OWNER_PERFORMANCE_SOURCE_MISSING");
  assert.equal(artifact.candidateMatchedN, null);
  assert.equal(artifact.realOrderCount, 0);
});

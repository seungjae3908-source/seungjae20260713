import test from "node:test";
import assert from "node:assert/strict";
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

function candidate() {
  return Object.freeze({
    signal: Object.freeze({ strategyIdentity: IDENTITY }),
    paperIdentity: IDENTITY,
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

function recurringResult() {
  return Object.freeze({
    status: "COMPLETED",
    state: Object.freeze({
      samples: Object.freeze([Object.freeze({ paperSampleId: "sample-1", identity: IDENTITY })]),
      positions: Object.freeze([Object.freeze({ positionId: "position-1", identity: IDENTITY })]),
      settlements: Object.freeze([Object.freeze({ settlementId: "settlement-1", identity: IDENTITY })]),
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

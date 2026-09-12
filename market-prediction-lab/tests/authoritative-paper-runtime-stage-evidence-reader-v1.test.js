import test from "node:test";
import assert from "node:assert/strict";
import { readAuthoritativePaperRuntimeStageEvidenceV1 } from "../src/authoritative-paper-runtime-stage-evidence-reader-v1.js";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const CANDIDATE_ID = `phase3-candidate:sha256:${"c".repeat(64)}`;

function expectedIdentity() {
  return Object.freeze({
    candidateId: CANDIDATE_ID,
    strategyFamily: "trend-following",
    strategyId: "strategy-v1",
    strategyVersion: "1.0.0",
    parameterHash: DIGEST,
    parameterDigest: DIGEST,
    researchCodeSha: SHA,
    costPolicyVersion: "full-cost-v1",
    accountMode: "PAPER",
  });
}

function paperRuntimeResult() {
  return Object.freeze({
    status: "AUTHORITATIVE_PAPER_ADMISSION_MEASURED",
    runtimeStageMeasurements: Object.freeze({
      Admission: Object.freeze({
        status: "MEASURED",
        count: 1,
        blocker: null,
        provenance: "canonical-paper-admission-bridge-v1",
      }),
    }),
    sampleCredit: 0,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    executionAuthority: "NONE",
  });
}

function row(extra = {}) {
  return Object.freeze({
    candidateId: CANDIDATE_ID,
    strategyFamily: "trend-following",
    strategyId: "strategy-v1",
    strategyVersion: "1.0.0",
    parameterHash: DIGEST,
    parameterDigest: DIGEST,
    researchCodeSha: SHA,
    costPolicyVersion: "full-cost-v1",
    accountMode: "PAPER",
    ...extra,
  });
}

function directStage(field, observationIds) {
  return Object.freeze({
    field,
    status: "MEASURED",
    count: observationIds.length,
    blocker: null,
    provenance: `recurring-paper-loop-v1 ${field}`,
    observedAt: 1_789_200_000_000,
    observationIds: Object.freeze([...observationIds]),
    naturalCredit: 0,
    replayCredit: 0,
    duplicateCredit: 0,
  });
}

function recurringCycleResult({ zero = false, mismatch = false, replayed = false } = {}) {
  const entryIds = zero ? [] : ["paper-sample-1"];
  const positionIds = zero ? [] : ["position-1"];
  const settlementIds = zero ? [] : ["d".repeat(64)];
  return Object.freeze({
    state: Object.freeze({
      samples: Object.freeze(zero ? [] : [row({ paperSampleId: "paper-sample-1", strategyId: mismatch ? "wrong" : "strategy-v1" })]),
      positions: Object.freeze(zero ? [] : [row({ positionId: "position-1" })]),
      settlements: Object.freeze(zero ? [] : [row({ settlementId: "d".repeat(64) })]),
    }),
    summary: Object.freeze({
      canonicalNaturalStageEvidence: Object.freeze({
        schemaVersion: "canonical-natural-paper-loop-stage-evidence-v1",
        identity: Object.freeze({ cycleId: "cycle-1", strategySha: SHA, runtimeSha: SHA, datasetIdentity: null }),
        stageCounts: Object.freeze({
          entryEligible: directStage("entryEligible", zero ? [] : ["position-1"]),
          entry: directStage("entry", entryIds),
          position: directStage("position", positionIds),
          settlement: directStage("settlement", settlementIds),
        }),
        reasonObservations: Object.freeze([]),
        naturalCredit: 0,
        replayCredit: 0,
        duplicateCredit: 0,
        replayed,
      }),
    }),
  });
}

test("binds recurring Entry/Position/Settlement measurements to one exact Paper candidate without creating credit", () => {
  const result = readAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult: paperRuntimeResult(),
    recurringCycleResult: recurringCycleResult(),
    expectedCandidateIdentity: expectedIdentity(),
  });

  assert.equal(result.status, "AUTHORITATIVE_PAPER_RUNTIME_STAGES_RECONCILED");
  assert.equal(result.runtimeStageMeasurements.Admission.status, "MEASURED");
  assert.equal(result.runtimeStageMeasurements.Entry.status, "MEASURED");
  assert.equal(result.runtimeStageMeasurements.Position.status, "MEASURED");
  assert.equal(result.runtimeStageMeasurements.Settlement.status, "MEASURED");
  assert.equal(result.runtimeStageMeasurements.Entry.count, 1);
  assert.equal(result.runtimeStageMeasurements.Position.count, 1);
  assert.equal(result.runtimeStageMeasurements.Settlement.count, 1);
  assert.equal(result.runtimeStageMeasurements.Entry.candidateBound, true);
  assert.equal(result.runtimeStageMeasurements.Settlement.candidateBound, true);
  assert.equal(result.sampleCredit, 0);
  assert.equal(result.executionRealismCredit, 0);
  assert.equal(result.profitabilityCredit, 0);
  assert.equal(result.fullCostReady, false);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.runtimeActivationAllowed, false);
  assert.equal(result.scheduleActivationAllowed, false);
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.liveTrading, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.realOrderAllowed, false);
});

test("does not convert an aggregate measured zero into candidate-bound Entry/Position/Settlement evidence", () => {
  const result = readAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult: paperRuntimeResult(),
    recurringCycleResult: recurringCycleResult({ zero: true }),
    expectedCandidateIdentity: expectedIdentity(),
  });

  for (const stage of ["Entry", "Position", "Settlement"]) {
    assert.equal(result.runtimeStageMeasurements[stage].status, "UNKNOWN");
    assert.equal(result.runtimeStageMeasurements[stage].count, null);
    assert.equal(result.runtimeStageMeasurements[stage].candidateBound, false);
    assert.match(result.runtimeStageMeasurements[stage].blocker, /ZERO_NOT_CANDIDATE_BOUND$/u);
  }
});

test("fails closed when a recurring stage row belongs to a different candidate identity", () => {
  assert.throws(() => readAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult: paperRuntimeResult(),
    recurringCycleResult: recurringCycleResult({ mismatch: true }),
    expectedCandidateIdentity: expectedIdentity(),
  }), /PAPER_STAGE_ENTRY_IDENTITY_MISMATCH/u);
});

test("rejects replay evidence and any authority or economic-credit elevation", () => {
  assert.throws(() => readAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult: paperRuntimeResult(),
    recurringCycleResult: recurringCycleResult({ replayed: true }),
    expectedCandidateIdentity: expectedIdentity(),
  }), /PAPER_STAGE_REPLAY_EVIDENCE_FORBIDDEN/u);

  assert.throws(() => readAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult: Object.freeze({ ...paperRuntimeResult(), profitabilityCredit: 1 }),
    recurringCycleResult: recurringCycleResult(),
    expectedCandidateIdentity: expectedIdentity(),
  }), /PAPER_STAGE_RUNTIME_AUTHORITY_OR_CREDIT_VIOLATION/u);
});

test("requires an exact same-parameter PAPER identity and never invents missing cost policy", () => {
  assert.throws(() => readAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult: paperRuntimeResult(),
    recurringCycleResult: recurringCycleResult(),
    expectedCandidateIdentity: Object.freeze({ ...expectedIdentity(), costPolicyVersion: "" }),
  }), /PAPER_STAGE_EXPECTED_COSTPOLICYVERSION_REQUIRED/u);

  assert.throws(() => readAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult: paperRuntimeResult(),
    recurringCycleResult: recurringCycleResult(),
    expectedCandidateIdentity: Object.freeze({ ...expectedIdentity(), parameterDigest: "e".repeat(64) }),
  }), /PAPER_STAGE_EXPECTED_PARAMETER_IDENTITY_MISMATCH/u);
});

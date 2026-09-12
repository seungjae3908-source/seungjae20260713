import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORITATIVE_PAPER_RUNTIME_STAGE_EVIDENCE_CALLER_VERSION,
  callAuthoritativePaperRuntimeWithStageEvidenceV1,
  reconcileAuthoritativePaperRuntimeStageEvidenceV1,
} from "../src/authoritative-paper-runtime-stage-evidence-caller-v1.js";

const RESEARCH_SHA = "c".repeat(40);
const PARAMETER_DIGEST = "b".repeat(64);
const CANDIDATE_ID = `phase3-candidate:sha256:${"a".repeat(64)}`;

const EXPECTED = Object.freeze({
  candidateId: CANDIDATE_ID,
  strategyFamily: "trend-following",
  strategyId: "strategy-alpha",
  strategyVersion: "v7",
  parameterHash: PARAMETER_DIGEST,
  parameterDigest: PARAMETER_DIGEST,
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

function candidate(identity = EXPECTED) {
  return Object.freeze({
    signal: Object.freeze({
      signalId: "signal-1",
      strategyIdentity: Object.freeze({ ...identity }),
    }),
    paperIdentity: Object.freeze({
      candidateId: identity.candidateId,
      strategyFamily: identity.strategyFamily,
      strategyId: identity.strategyId,
      strategyVersion: identity.strategyVersion,
      parameterHash: identity.parameterHash,
      parameterDigest: identity.parameterDigest,
      researchCodeSha: identity.researchCodeSha,
      costPolicyVersion: identity.costPolicyVersion,
      accountMode: identity.accountMode,
    }),
    ...safety(),
  });
}

function stage(stageName, status, count, blocker = null) {
  return Object.freeze({
    stage: stageName,
    status,
    count,
    blocker,
    provenance: status === "MEASURED" ? `test:${stageName}` : null,
    measuredAtMs: status === "MEASURED" ? 1_789_000_000_000 : null,
  });
}

function factoryResult(factoryCandidate = candidate()) {
  return Object.freeze({
    schemaVersion: "canonical-meaningful-search-paper-runtime-v1",
    market: "CRYPTO_FUTURES",
    status: "PAPER_CANDIDATES_READY",
    search: Object.freeze({ outcome: "TRADE_CANDIDATES" }),
    admissionBridgeReadyCandidates: 1,
    paperBridge: Object.freeze({
      candidates: Object.freeze([factoryCandidate]),
      exitSignals: Object.freeze([]),
      blocked: 0,
      noTrade: 0,
      eligible: 1,
      exits: 0,
    }),
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
    firstZeroStage: "UNKNOWN",
    firstZeroReason: "RECURRING_PAPER_ENTRY_NOT_MEASURED_BY_ADMISSION_RUNTIME",
    entryCount: null,
    settlementCount: null,
    ...safety(),
    profitabilityClaimAllowed: false,
  });
}

function stageEvidence(field, ids, status = "MEASURED") {
  return Object.freeze({
    field,
    status,
    count: status === "MEASURED" ? ids.length : null,
    blocker: status === "MEASURED" ? null : `UNMEASURED_${field.toUpperCase()}`,
    provenance: `recurring-paper-loop-v1:${field}`,
    observedAt: 1_789_000_000_100,
    observationIds: Object.freeze(status === "MEASURED" ? [...ids] : []),
    naturalCredit: 0,
    replayCredit: 0,
    duplicateCredit: 0,
  });
}

function stateRow(idField, id, identity = EXPECTED) {
  return Object.freeze({
    [idField]: id,
    identity: Object.freeze({ ...identity }),
  });
}

function recurringResult({ entryIds = ["sample-1"], positionIds = ["position-1"], settlementIds = ["settlement-1"] } = {}) {
  return Object.freeze({
    state: Object.freeze({
      samples: Object.freeze(entryIds.map((id) => stateRow("paperSampleId", id))),
      positions: Object.freeze(positionIds.map((id) => stateRow("positionId", id))),
      settlements: Object.freeze(settlementIds.map((id) => stateRow("settlementId", id))),
    }),
    summary: Object.freeze({
      canonicalNaturalStageEvidence: Object.freeze({
        schemaVersion: "canonical-natural-paper-loop-stage-evidence-v1",
        identity: Object.freeze({
          strategySha: RESEARCH_SHA,
          runtimeSha: RESEARCH_SHA,
        }),
        stageCounts: Object.freeze({
          entry: stageEvidence("entry", entryIds),
          position: stageEvidence("position", positionIds),
          settlement: stageEvidence("settlement", settlementIds),
        }),
        naturalCredit: 0,
        replayCredit: 0,
        duplicateCredit: 0,
        replayed: false,
      }),
    }),
  });
}

test("caller reconciles exact candidate-bound recurring Entry/Position/Settlement into factory placeholders without economic credit", () => {
  const result = reconcileAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult: factoryResult(),
    recurringCycleResult: recurringResult(),
    expectedCandidateIdentity: EXPECTED,
  });
  const byStage = Object.fromEntries(result.stageMeasurements.map((row) => [row.stage, row]));
  assert.equal(byStage.Entry.status, "MEASURED");
  assert.equal(byStage.Entry.count, 1);
  assert.equal(byStage.Entry.candidateBound, true);
  assert.equal(byStage.Position.status, "MEASURED");
  assert.equal(byStage.Position.count, 1);
  assert.equal(byStage.Settlement.status, "MEASURED");
  assert.equal(byStage.Settlement.count, 1);
  assert.equal(result.entryCount, 1);
  assert.equal(result.settlementCount, 1);
  assert.equal(result.stageEvidenceConnection.schemaVersion, AUTHORITATIVE_PAPER_RUNTIME_STAGE_EVIDENCE_CALLER_VERSION);
  assert.equal(result.stageEvidenceConnection.status, "RECONCILED");
  assert.equal(result.sampleCredit, 0);
  assert.equal(result.executionRealismCredit, 0);
  assert.equal(result.profitabilityCredit, 0);
  assert.equal(result.fullCostReady, false);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.stageEvidenceConnection.runtimeActivationAllowed, false);
  assert.equal(result.stageEvidenceConnection.scheduleActivationAllowed, false);
  assert.equal(result.stageEvidenceConnection.dispatchAllowed, false);
});

test("caller preserves measured aggregate zero as UNKNOWN rather than candidate-bound zero", () => {
  const result = reconcileAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult: factoryResult(),
    recurringCycleResult: recurringResult({ entryIds: [], positionIds: [], settlementIds: [] }),
    expectedCandidateIdentity: EXPECTED,
  });
  const byStage = Object.fromEntries(result.stageMeasurements.map((row) => [row.stage, row]));
  assert.equal(byStage.Entry.status, "UNKNOWN");
  assert.equal(byStage.Entry.count, null);
  assert.equal(byStage.Entry.blocker, "PAPER_ENTRY_ZERO_NOT_CANDIDATE_BOUND");
  assert.equal(byStage.Entry.candidateBound, false);
  assert.equal(result.entryCount, null);
  assert.equal(result.settlementCount, null);
  assert.equal(result.firstZeroStage, "UNKNOWN");
  assert.equal(result.firstZeroReason, "PAPER_ENTRY_ZERO_NOT_CANDIDATE_BOUND");
});

test("caller rejects aggregate admission when the exact frozen candidate identity is absent", () => {
  const contaminated = Object.freeze({
    ...EXPECTED,
    candidateId: `phase3-candidate:sha256:${"d".repeat(64)}`,
  });
  assert.throws(() => reconcileAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult: factoryResult(candidate(contaminated)),
    recurringCycleResult: recurringResult(),
    expectedCandidateIdentity: EXPECTED,
  }), /PAPER_STAGE_FACTORY_CANDIDATE_BINDING_MISSING/u);
});

test("caller rejects ambiguous duplicate candidate binding instead of double-crediting one identity", () => {
  const base = factoryResult();
  const duplicated = Object.freeze({
    ...base,
    paperBridge: Object.freeze({
      ...base.paperBridge,
      candidates: Object.freeze([candidate(), candidate()]),
      eligible: 2,
    }),
  });
  assert.throws(() => reconcileAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult: duplicated,
    recurringCycleResult: recurringResult(),
    expectedCandidateIdentity: EXPECTED,
  }), /PAPER_STAGE_FACTORY_CANDIDATE_BINDING_AMBIGUOUS/u);
});

test("runtime caller fails closed and leaves original UNKNOWN placeholders untouched on identity contamination", async () => {
  const contaminated = Object.freeze({
    ...EXPECTED,
    strategyVersion: "wrong-version",
  });
  const original = factoryResult(candidate(contaminated));
  let runtimeCalls = 0;
  const result = await callAuthoritativePaperRuntimeWithStageEvidenceV1({
    paperRuntimeForMarket: async (input) => {
      runtimeCalls += 1;
      assert.deepEqual(input, { market: "CRYPTO_FUTURES", cycle: { cycleId: "cycle-1" } });
      return original;
    },
    runtimeInput: { market: "CRYPTO_FUTURES", cycle: { cycleId: "cycle-1" } },
    recurringCycleResult: recurringResult(),
    expectedCandidateIdentity: EXPECTED,
  });
  assert.equal(runtimeCalls, 1);
  assert.equal(result.stageEvidenceConnection.status, "BLOCKED");
  assert.equal(result.stageEvidenceConnection.blocker, "PAPER_STAGE_FACTORY_CANDIDATE_BINDING_MISSING");
  assert.equal(result.stageMeasurements.find((row) => row.stage === "Entry").status, "UNKNOWN");
  assert.equal(result.entryCount, null);
  assert.equal(result.executionAuthority, "NONE");
});

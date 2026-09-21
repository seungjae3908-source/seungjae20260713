import test from "node:test";
import assert from "node:assert/strict";
import { runPaperForwardEvidenceRuntime } from "../src/paper-forward-evidence-runtime-v1.js";
import { adoptPaperForwardStageEvidenceV1 } from "../src/paper-forward-stage-evidence-adoption-v1.js";

const SHA = "c".repeat(40);
const DIGEST = "b".repeat(64);
const CANDIDATE_ID = `phase3-candidate:sha256:${"a".repeat(64)}`;
const EXPECTED = Object.freeze({
  candidateId: CANDIDATE_ID,
  strategyFamily: "trend",
  strategyId: "s1",
  strategyVersion: "v1",
  parameterHash: DIGEST,
  parameterDigest: DIGEST,
  researchCodeSha: SHA,
  costPolicyVersion: "cost-v1",
  executionPolicyVersion: "exec-v1",
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

function candidate() {
  const strategyIdentity = Object.freeze({
    candidateId: EXPECTED.candidateId,
    strategyFamily: EXPECTED.strategyFamily,
    strategyId: EXPECTED.strategyId,
    strategyVersion: EXPECTED.strategyVersion,
    parameterHash: EXPECTED.parameterHash,
    parameterDigest: EXPECTED.parameterDigest,
    researchCodeSha: EXPECTED.researchCodeSha,
    costPolicyVersion: EXPECTED.costPolicyVersion,
    executionPolicyVersion: EXPECTED.executionPolicyVersion,
    accountMode: EXPECTED.accountMode,
  });
  return Object.freeze({
    signal: Object.freeze({
      signalId: "sig1",
      market: EXPECTED.market,
      symbol: EXPECTED.symbol,
      timeframe: EXPECTED.timeframe,
      direction: EXPECTED.sidePolicy,
      signalDirection: EXPECTED.sidePolicy,
      strategyIdentity,
    }),
    execution: Object.freeze({
      dataEvidence: Object.freeze({ provider: EXPECTED.provider }),
    }),
    paperIdentity: Object.freeze({
      candidateId: EXPECTED.candidateId,
      strategyFamily: EXPECTED.strategyFamily,
      strategyId: EXPECTED.strategyId,
      strategyVersion: EXPECTED.strategyVersion,
      parameterHash: EXPECTED.parameterHash,
      parameterDigest: EXPECTED.parameterDigest,
      researchCodeSha: EXPECTED.researchCodeSha,
      costPolicyVersion: EXPECTED.costPolicyVersion,
      market: EXPECTED.market,
      symbol: EXPECTED.symbol,
      timeframe: EXPECTED.timeframe,
      direction: EXPECTED.sidePolicy,
      accountMode: EXPECTED.accountMode,
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
    provenance: status === "MEASURED" ? `factory:${stageName}` : null,
    measuredAtMs: 1_789_000_000_000,
  });
}

function scheduledEvidence() {
  return Object.freeze({
    status: "READY",
    provider: EXPECTED.provider,
    dataAsOfMs: 1_789_000_000_000,
    candidates: Object.freeze([candidate()]),
    exits: Object.freeze([]),
    blocker: null,
    paperCandidateSource: Object.freeze({
      schemaVersion: "meaningful-search-scheduled-paper-provider-v1",
      status: "PAPER_CANDIDATES_READY",
      stageMeasurements: Object.freeze([
        stage("Scanner Candidate", "MEASURED", 1),
        stage("Profit Gate", "MEASURED", 1),
        stage("Identity", "MEASURED", 1),
        stage("Paper Admission", "MEASURED", 1),
        stage("Entry", "UNKNOWN", null, "ENTRY_UNKNOWN"),
        stage("Position", "UNKNOWN", null, "POSITION_UNKNOWN"),
        stage("Exit", "MEASURED", 1),
        stage("Settlement", "UNKNOWN", null, "SETTLEMENT_UNKNOWN"),
      ]),
    }),
  });
}

function directEvidence(field, ids) {
  return Object.freeze({
    field,
    status: "MEASURED",
    count: ids.length,
    blocker: null,
    provenance: `loop:${field}`,
    observedAt: 1_789_000_000_100,
    observationIds: Object.freeze([...ids]),
    naturalCredit: 0,
    replayCredit: 0,
    duplicateCredit: 0,
  });
}

function sample() {
  return Object.freeze({
    paperSampleId: "e1",
    identity: Object.freeze({
      candidateId: EXPECTED.candidateId,
      strategyFamily: EXPECTED.strategyFamily,
      strategyId: EXPECTED.strategyId,
      strategyVersion: EXPECTED.strategyVersion,
      parameterHash: EXPECTED.parameterHash,
      parameterDigest: EXPECTED.parameterDigest,
      researchCodeSha: EXPECTED.researchCodeSha,
      accountMode: EXPECTED.accountMode,
      market: EXPECTED.market,
      symbol: EXPECTED.symbol,
      timeframe: EXPECTED.timeframe,
      executionDirection: EXPECTED.sidePolicy,
    }),
    profitEvidence: Object.freeze({ costPolicyId: EXPECTED.costPolicyVersion }),
    entryEvidenceProvenance: Object.freeze({ provider: EXPECTED.provider }),
  });
}

function position() {
  return Object.freeze({
    positionId: "p1",
    candidateId: EXPECTED.candidateId,
    strategyFamily: EXPECTED.strategyFamily,
    strategyId: EXPECTED.strategyId,
    strategyVersion: EXPECTED.strategyVersion,
    parameterHash: EXPECTED.parameterHash,
    parameterDigest: EXPECTED.parameterDigest,
    researchCodeSha: EXPECTED.researchCodeSha,
    accountMode: EXPECTED.accountMode,
    costPolicyVersion: EXPECTED.costPolicyVersion,
    market: EXPECTED.market,
    symbol: EXPECTED.symbol,
    direction: EXPECTED.sidePolicy,
    sample: sample(),
  });
}

function settlement() {
  return Object.freeze({
    settlementId: "z1",
    candidateId: EXPECTED.candidateId,
    strategyFamily: EXPECTED.strategyFamily,
    strategyId: EXPECTED.strategyId,
    strategyVersion: EXPECTED.strategyVersion,
    parameterHash: EXPECTED.parameterHash,
    parameterDigest: EXPECTED.parameterDigest,
    researchCodeSha: EXPECTED.researchCodeSha,
    accountMode: EXPECTED.accountMode,
    costPolicyVersion: EXPECTED.costPolicyVersion,
    market: EXPECTED.market,
    symbol: EXPECTED.symbol,
    timeframe: EXPECTED.timeframe,
    entryDirection: EXPECTED.sidePolicy,
    entryEvidenceProvenance: Object.freeze({ provider: EXPECTED.provider }),
    exitEvidenceProvenance: Object.freeze({ provider: EXPECTED.provider }),
  });
}

function recurringCycleResult({ researchCodeSha = EXPECTED.researchCodeSha } = {}) {
  return Object.freeze({
    cycleId: "cycle:paper-forward-stage-evidence",
    status: "EXECUTED",
    mutationCount: 0,
    state: Object.freeze({
      identity: Object.freeze({
        strategyId: EXPECTED.strategyId,
        strategyVersion: EXPECTED.strategyVersion,
        parameterHash: EXPECTED.parameterHash,
        costPolicyVersion: EXPECTED.costPolicyVersion,
        executionPolicyVersion: EXPECTED.executionPolicyVersion,
        researchCodeSha,
      }),
      samples: Object.freeze([sample()]),
      positions: Object.freeze([position()]),
      settlements: Object.freeze([settlement()]),
    }),
    summary: Object.freeze({
      tradesSettled: 1,
      canonicalNaturalStageEvidence: Object.freeze({
        schemaVersion: "canonical-natural-paper-loop-stage-evidence-v1",
        identity: Object.freeze({ strategySha: researchCodeSha, runtimeSha: researchCodeSha }),
        stageCounts: Object.freeze({
          entry: directEvidence("entry", ["e1"]),
          position: directEvidence("position", ["p1"]),
          settlement: directEvidence("settlement", ["z1"]),
        }),
        naturalCredit: 0,
        replayCredit: 0,
        duplicateCredit: 0,
        replayed: false,
      }),
    }),
  });
}

test("Paper forward runtime adopts authoritative Entry/Position/Settlement evidence after the same scheduled cycle", async () => {
  const evidence = scheduledEvidence();
  const recurring = recurringCycleResult();
  const publicEvidenceProvider = Object.freeze({
    async collectPublicEvidence({ market }) {
      assert.equal(market, "CRYPTO_FUTURES");
      return evidence;
    },
  });
  const runScheduled = async ({ publicEvidenceProvider: trackedProvider }) => {
    await trackedProvider.collectPublicEvidence({
      market: "CRYPTO_FUTURES",
      cycle: Object.freeze({ cycleId: recurring.cycleId }),
      attempt: 1,
      signal: new AbortController().signal,
    });
    return recurring;
  };

  const result = await runPaperForwardEvidenceRuntime({
    publicEvidenceProvider,
    runScheduled,
    runtimeClock: () => 1_789_000_000_200,
    state: Object.freeze({ positions: Object.freeze([]) }),
  });

  assert.equal(result.authoritativePaperStageEvidence.stageEvidenceConnection.status, "RECONCILED");
  assert.equal(result.authoritativePaperStageEvidence.entryCount, 1);
  assert.equal(result.authoritativePaperStageEvidence.settlementCount, 1);
  assert.equal(result.authoritativePaperStageEvidence.stageMeasurements.find((row) => row.stage === "Position").count, 1);
  assert.equal(result.authoritativePaperStageEvidence.sampleCredit, 0);
  assert.equal(result.authoritativePaperStageEvidence.executionRealismCredit, 0);
  assert.equal(result.authoritativePaperStageEvidence.profitabilityCredit, 0);
  assert.equal(result.authoritativePaperStageEvidence.fullCostReady, false);
  assert.equal(result.authoritativePaperStageEvidence.profitabilityProven, false);
  assert.equal(result.authoritativePaperStageEvidence.executionAuthority, "NONE");
  assert.equal(result.authoritativePaperStageEvidence.liveOrderAllowed, false);
  assert.equal(result.authoritativePaperStageEvidence.privateTradingApiAllowed, false);
  assert.equal(result.runtimeStatus.privateRequestCount, 0);
  assert.equal(result.runtimeStatus.orderCount, 0);
});

test("Paper forward stage adoption fails closed on schedule-process research identity mismatch", () => {
  const result = adoptPaperForwardStageEvidenceV1({
    scheduledEvidence: scheduledEvidence(),
    recurringCycleResult: recurringCycleResult({ researchCodeSha: "d".repeat(40) }),
  });

  assert.equal(result.stageEvidenceConnection.status, "BLOCKED");
  assert.match(result.stageEvidenceConnection.blocker, /RESEARCH_SHA_MISMATCH/u);
  assert.equal(result.stageEvidenceConnection.sampleCredit, 0);
  assert.equal(result.stageEvidenceConnection.executionRealismCredit, 0);
  assert.equal(result.stageEvidenceConnection.profitabilityCredit, 0);
  assert.equal(result.stageEvidenceConnection.fullCostReady, false);
  assert.equal(result.stageEvidenceConnection.profitabilityProven, false);
  assert.equal(result.stageEvidenceConnection.executionAuthority, "NONE");
  assert.equal(result.stageEvidenceConnection.runtimeActivationAllowed, false);
  assert.equal(result.stageEvidenceConnection.scheduleActivationAllowed, false);
  assert.equal(result.stageEvidenceConnection.dispatchAllowed, false);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecurringPaperLoopState,
  runRecurringPaperCycle,
} from "../src/recurring-paper-loop-v1.js";

const T0 = 1_800_000_000_000;
const SHA = "a".repeat(40);
const PARAMETER_DIGEST = "b".repeat(64);

function runtimeIdentity() {
  return {
    strategyId: "phase4-paper-compatibility",
    strategyVersion: "v1",
    parameterHash: PARAMETER_DIGEST,
    researchCodeSha: SHA,
    costPolicyVersion: "cost-v1",
    executionPolicyVersion: "execution-v1",
  };
}

function ledger() {
  return {
    status: "READY",
    initialCapitalKrw: 1_000_000,
    baseCurrency: "KRW",
    knownEquityKrw: 1_000_000,
    totalEquityKrw: 1_000_000,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function candidate(candidateId) {
  return {
    testOnly: false,
    candidateId,
    naturalEvidence: {
      provenanceClass: "NATURAL_FORWARD",
      synthetic: false,
      replay: false,
      testOnly: false,
      backfill: false,
      historical: false,
      duplicate: false,
    },
    signal: {
      signalId: `signal:${candidateId}`,
      market: "CRYPTO_SPOT",
      symbol: "BTCUSDT",
      timestampMs: T0,
      strategyIdentity: {
        strategyId: "phase4-paper-compatibility",
        strategyVersion: "v1",
        parameterHash: PARAMETER_DIGEST,
        researchCodeSha: SHA,
        candidateId,
        strategyFamily: "MOMENTUM_CROSS",
        parameterDigest: PARAMETER_DIGEST,
        accountMode: "PAPER",
      },
    },
    riskEvidence: {
      status: "APPROVED",
      simulatedOnly: true,
      evaluatedAtMs: T0,
    },
    execution: {
      dataEvidence: {
        dataQuality: "BLOCKED",
      },
    },
  };
}

async function runCandidate(candidateId) {
  const identity = runtimeIdentity();
  const state = createRecurringPaperLoopState({
    identity,
    ledger: ledger(),
    createdAtMs: T0,
  });
  return runRecurringPaperCycle({
    state,
    cycle: {
      cycleId: `cycle:${candidateId}`,
      evaluatedAtMs: T0 + 1,
      identity,
    },
    candidates: [candidate(candidateId)],
    ledgerAdapter: {
      async applyEntry() { throw new Error("unexpected entry"); },
      async applySettlement() { throw new Error("unexpected settlement"); },
    },
    learningAdapter: {
      async persistSignal() { throw new Error("unexpected signal persistence"); },
      async persistOutcome() { throw new Error("unexpected outcome persistence"); },
    },
    stateStore: {
      async save() {},
    },
  });
}

test("recurring Paper gate accepts canonical Phase 3 candidate namespace without remapping", async () => {
  const candidateId = `phase3-candidate:sha256:${"c".repeat(64)}`;
  const result = await runCandidate(candidateId);
  assert.equal(result.state.samples.length, 1);
  assert.equal(result.state.samples[0].status, "BLOCKED");
  assert.ok(result.state.samples[0].blockers.includes("BLOCKED_DATA"));
  assert.equal(result.state.samples[0].blockers.includes("PAPER_CANDIDATE_ID_REQUIRED"), false);
  assert.equal(result.summary.entries, 0);
  assert.equal(result.summary.blocked, 1);
  assert.equal(result.summary.liveOrderAllowed, false);
  assert.equal(result.summary.privateTradingApiAllowed, false);
});

test("recurring Paper gate keeps rejecting an unknown candidate namespace", async () => {
  const candidateId = `unknown-candidate:${"d".repeat(64)}`;
  const result = await runCandidate(candidateId);
  assert.equal(result.state.samples.length, 1);
  assert.equal(result.state.samples[0].status, "BLOCKED");
  assert.ok(result.state.samples[0].blockers.includes("PAPER_CANDIDATE_ID_REQUIRED"));
  assert.equal(result.summary.entries, 0);
});

import assert from "node:assert/strict";
import test from "node:test";

import { createNaturalPaperPositionLifecycle } from "../src/natural-paper-position-settlement-lifecycle-v1.js";

const T0 = 1_800_000_000_000;
const SHA = "a".repeat(40);
const PARAMETER_DIGEST = "b".repeat(64);

function fixture(candidateId) {
  const sample = {
    status: "OPEN",
    identity: {
      symbol: "BTCUSDT",
      market: "CRYPTO_SPOT",
      executionDirection: "BUY",
      researchCodeSha: SHA,
      evaluatedAtMs: T0,
      timeframe: "15m",
      horizon: 4,
      candidateId,
      strategyFamily: "MOMENTUM_CROSS",
      parameterDigest: PARAMETER_DIGEST,
      accountMode: "PAPER",
    },
    fill: {
      fillPrice: 100,
      filledQuantity: 1,
      status: "FILLED",
    },
    entryEvidenceProvenance: {
      evidenceSnapshotDigest: "c".repeat(64),
      source: "phase4-paper-identity-contract-test",
    },
  };
  const position = {
    positionId: "position-phase4-identity",
    paperSampleId: "sample-phase4-identity",
    signalId: "signal-phase4-identity",
    market: "CRYPTO_SPOT",
    symbol: "BTCUSDT",
    direction: "BUY",
    candidateId,
    strategyFamily: "MOMENTUM_CROSS",
    strategyId: "formula-family:MOMENTUM_CROSS",
    strategyVersion: "1.0.0",
    parameterHash: PARAMETER_DIGEST,
    parameterDigest: PARAMETER_DIGEST,
    researchCodeSha: SHA,
    costPolicyVersion: "cost-v1",
    accountMode: "PAPER",
    sample,
    entryTimestampMs: T0,
    entryFillPrice: 100,
    quantity: 1,
    lifecycleState: "OPEN",
  };
  const candidate = {
    naturalEvidence: {
      provenanceClass: "NATURAL_FORWARD",
      synthetic: false,
      replay: false,
      testOnly: false,
      backfill: false,
      historical: false,
      duplicate: false,
      observationId: "phase4-forward-observation",
      source: "phase4-forward-contract",
      observedAtMs: T0 - 1,
    },
    signal: {
      timestampMs: T0 - 1,
      expiresAtMs: T0 + 60 * 60 * 1000,
      learningSnapshot: {},
    },
    execution: {
      executionPolicy: {
        sameBarPolicy: "STOP_FIRST",
      },
    },
    riskEvidence: {
      policyIdentity: {
        policyId: "paper-risk-v1",
        policyVersion: "v1",
        source: "canonical-risk-policy-record",
        researchCodeSha: SHA,
      },
    },
  };
  return { position, sample, candidate };
}

for (const candidateId of [
  `phase3-candidate:sha256:${"d".repeat(64)}`,
  `paper-candidate-v1:${"e".repeat(64)}`,
]) {
  test(`Natural lifecycle preserves canonical candidate id without remapping: ${candidateId.split(":")[0]}`, () => {
    const input = fixture(candidateId);
    const lifecycle = createNaturalPaperPositionLifecycle(input);
    assert.equal(lifecycle.identity.candidateId, candidateId);
    assert.equal(lifecycle.strategyIdentity.candidateId, candidateId);
    assert.equal(lifecycle.strategyIdentity.parameterDigest, PARAMETER_DIGEST);
    assert.equal(lifecycle.strategyIdentity.parameterHash, PARAMETER_DIGEST);
    assert.equal(lifecycle.strategyIdentity.accountMode, "PAPER");
    assert.equal(lifecycle.sampleEligibility.provenanceClass, "NATURAL_FORWARD");
    assert.equal(lifecycle.sampleEligibility.naturalSampleCredit, 0);
    assert.equal(lifecycle.executionAuthority, "NONE");
    assert.equal(lifecycle.liveOrderAllowed, false);
    assert.equal(lifecycle.privateTradingApiAllowed, false);
  });
}

test("Natural lifecycle still rejects an unknown candidate namespace", () => {
  const input = fixture(`unknown-candidate:${"f".repeat(64)}`);
  assert.throws(
    () => createNaturalPaperPositionLifecycle(input),
    /PAPER_POSITION_CANDIDATE_ID_REQUIRED/u,
  );
});

test("Phase3 candidate identity cannot bypass parameter or account-mode invariants", () => {
  const candidateId = `phase3-candidate:sha256:${"d".repeat(64)}`;
  {
    const input = fixture(candidateId);
    input.position.parameterHash = "f".repeat(64);
    assert.throws(
      () => createNaturalPaperPositionLifecycle(input),
      /PAPER_POSITION_PARAMETER_IDENTITY_MISMATCH/u,
    );
  }
  {
    const input = fixture(candidateId);
    input.position.accountMode = "LIVE";
    input.sample.identity.accountMode = "LIVE";
    assert.throws(
      () => createNaturalPaperPositionLifecycle(input),
      /PAPER_ACCOUNT_MODE_REQUIRED/u,
    );
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_CHAIN_BROKEN,
  DUPLICATE_ACCEPTED_ONCE,
  EVIDENCE_ACCEPTED,
  EVIDENCE_ID_CONFLICT,
  assertGlobalEvidenceContinuity,
  buildGlobalEvidenceId,
  canonicalUniqueEvidence,
  createGlobalEvidenceLedger,
  recordGlobalEvidence,
  summarizeGlobalEvidenceLedger,
  verifyGlobalEvidenceLedger,
} from "../src/global-evidence-dedup-ledger-v1.js";

const SHA = "1111111111111111111111111111111111111111";
const PROVENANCE = "a".repeat(64);
const LINEAGE = "b".repeat(64);

function evidence(overrides = {}) {
  return {
    producerFamily: "PAPER",
    workflowFamily: "natural-paper-settlement-v1",
    strategyIdentity: {
      strategyFamily: "CANONICAL_SCANNER_PROFILE",
      strategyVersion: "v1",
      parameterHash: "parameter-hash-v1",
      costPolicyVersion: "BACKTEST_FEES_SLIPPAGE_FUNDING_V1",
      executionPolicyFingerprint: "paper-sim-v1",
    },
    researchCodeSha: SHA,
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "15m",
    side: "LONG",
    observationTimestamp: "2026-08-18T10:00:00.000Z",
    horizon: "15m",
    sourceDatasetId: "bitget-public-v2",
    provenanceDigest: PROVENANCE,
    outcomeKind: "SETTLEMENT",
    artifactLineageDigest: LINEAGE,
    payload: { outcome: "TP_BEFORE_SL", netReturn: 0.012, costsApplied: true },
    ...overrides,
  };
}

test("evidenceId is deterministic across object key order and runtimes", () => {
  const first = evidence();
  const second = evidence({
    strategyIdentity: {
      executionPolicyFingerprint: "paper-sim-v1",
      costPolicyVersion: "BACKTEST_FEES_SLIPPAGE_FUNDING_V1",
      parameterHash: "parameter-hash-v1",
      strategyVersion: "v1",
      strategyFamily: "CANONICAL_SCANNER_PROFILE",
    },
  });
  assert.equal(buildGlobalEvidenceId(first), buildGlobalEvidenceId(second));
});

test("same evidence and payload across retry is counted once", () => {
  const initial = createGlobalEvidenceLedger();
  const accepted = recordGlobalEvidence(initial, evidence());
  assert.equal(accepted.status, EVIDENCE_ACCEPTED);
  assert.equal(accepted.sampleCountDelta, 1);
  assert.equal(accepted.ledger.records.length, 1);

  const duplicate = recordGlobalEvidence(accepted.ledger, evidence());
  assert.equal(duplicate.status, DUPLICATE_ACCEPTED_ONCE);
  assert.equal(duplicate.sampleCountDelta, 0);
  assert.equal(duplicate.ledger.records.length, 1);
  assert.equal(duplicate.ledger.duplicateAttempts.length, 1);
  assertGlobalEvidenceContinuity(accepted.ledger, duplicate.ledger);

  const summary = summarizeGlobalEvidenceLedger(duplicate.ledger);
  assert.equal(summary.canonicalUniqueEvidenceCount, 1);
  assert.equal(summary.duplicateAcceptedOnceCount, 1);
  assert.equal(summary.conflictCount, 0);
  assert.equal(summary.byProducer.PAPER, 1);
});

test("same evidenceId with conflicting payload fails closed without incrementing sample count", () => {
  const accepted = recordGlobalEvidence(createGlobalEvidenceLedger(), evidence());
  const conflict = recordGlobalEvidence(accepted.ledger, evidence({
    payload: { outcome: "SL_BEFORE_TP", netReturn: -0.01, costsApplied: true },
  }));

  assert.equal(conflict.status, EVIDENCE_ID_CONFLICT);
  assert.equal(conflict.sampleCountDelta, 0);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.ledger.records.length, 1);
  const summary = summarizeGlobalEvidenceLedger(conflict.ledger);
  assert.equal(summary.canonicalUniqueEvidenceCount, 1);
  assert.equal(summary.conflictCount, 1);
  assert.equal(summary.failClosed, true);
  assert.throws(() => canonicalUniqueEvidence(conflict.ledger), new RegExp(EVIDENCE_ID_CONFLICT));
});

test("legitimate different cohort or horizon observation remains separate evidence", () => {
  const first = recordGlobalEvidence(createGlobalEvidenceLedger(), evidence());
  const second = recordGlobalEvidence(first.ledger, evidence({
    observationTimestamp: "2026-08-18T10:15:00.000Z",
    payload: { outcome: "PENDING", netReturn: null, costsApplied: true },
  }));
  assert.equal(second.status, EVIDENCE_ACCEPTED);
  assert.equal(second.sampleCountDelta, 1);
  assert.equal(second.ledger.records.length, 2);
});

test("Paper, Shadow, Backtest and Fake-Wall aggregates consume canonical unique records only", () => {
  let ledger = recordGlobalEvidence(createGlobalEvidenceLedger(), evidence()).ledger;
  for (const [producerFamily, outcomeKind, minute, lineage] of [
    ["SHADOW", "MATURED_LABEL", "15", "c".repeat(64)],
    ["BACKTEST", "OOS_TRIAL", "30", "d".repeat(64)],
    ["FAKE_WALL", "FORWARD_OUTCOME", "45", "e".repeat(64)],
  ]) {
    const recorded = recordGlobalEvidence(ledger, evidence({
      producerFamily,
      workflowFamily: `${producerFamily.toLowerCase()}-evidence-v1`,
      outcomeKind,
      observationTimestamp: `2026-08-18T10:${minute}:00.000Z`,
      artifactLineageDigest: lineage,
      payload: { status: "OBSERVED" },
    }));
    ledger = recorded.ledger;
  }
  const retry = recordGlobalEvidence(ledger, evidence());
  assert.equal(retry.status, DUPLICATE_ACCEPTED_ONCE);
  ledger = retry.ledger;

  assert.equal(canonicalUniqueEvidence(ledger).length, 4);
  assert.equal(canonicalUniqueEvidence(ledger, { producerFamily: "PAPER" }).length, 1);
  assert.equal(canonicalUniqueEvidence(ledger, { producerFamily: "SHADOW" }).length, 1);
  assert.equal(canonicalUniqueEvidence(ledger, { producerFamily: "BACKTEST" }).length, 1);
  assert.equal(canonicalUniqueEvidence(ledger, { producerFamily: "FAKE_WALL" }).length, 1);
  assert.equal(summarizeGlobalEvidenceLedger(ledger).duplicateAcceptedOnceCount, 1);
});

test("tampered immutable predecessor fails closed", () => {
  const accepted = recordGlobalEvidence(createGlobalEvidenceLedger(), evidence());
  const tampered = { ...accepted.ledger, records: [] };
  assert.deepEqual(verifyGlobalEvidenceLedger(tampered), { valid: false, reason: ARTIFACT_CHAIN_BROKEN });
  assert.throws(() => recordGlobalEvidence(tampered, evidence()), new RegExp(ARTIFACT_CHAIN_BROKEN));
});

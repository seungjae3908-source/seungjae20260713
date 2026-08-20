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
const STRATEGY = "9".repeat(64);
const PROVENANCE = "a".repeat(64);
const LINEAGE = "b".repeat(64);

function evidence(overrides = {}) {
  return {
    producerFamily: "PAPER",
    workflowFamily: "research-production-paper-v1",
    strategyIdentityDigest: STRATEGY,
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

test("canonical sample id ignores runtime workflow and artifact lineage", () => {
  const server = evidence();
  const actions = evidence({
    workflowFamily: "github-actions-paper-reverify-v1",
    artifactLineageDigest: "c".repeat(64),
  });
  assert.equal(buildGlobalEvidenceId(server), buildGlobalEvidenceId(actions));
});

test("same natural sample observed by server and Actions is counted once while both provenances remain", () => {
  const first = recordGlobalEvidence(createGlobalEvidenceLedger(), evidence());
  const duplicate = recordGlobalEvidence(first.ledger, evidence({
    workflowFamily: "github-actions-paper-reverify-v1",
    artifactLineageDigest: "c".repeat(64),
  }));

  assert.equal(first.status, EVIDENCE_ACCEPTED);
  assert.equal(first.sampleCountDelta, 1);
  assert.equal(duplicate.status, DUPLICATE_ACCEPTED_ONCE);
  assert.equal(duplicate.sampleCountDelta, 0);
  assert.equal(duplicate.ledger.records.length, 1);
  assert.equal(duplicate.ledger.records[0].sources.length, 2);
  assert.notEqual(duplicate.ledger.records[0].sources[0].sourceDigest, duplicate.ledger.records[0].sources[1].sourceDigest);
  assertGlobalEvidenceContinuity(first.ledger, duplicate.ledger);

  const summary = summarizeGlobalEvidenceLedger(duplicate.ledger);
  assert.equal(summary.canonicalUniqueEvidenceCount, 1);
  assert.equal(summary.runtimeSourceCount, 2);
  assert.equal(summary.duplicateAcceptedOnceCount, 1);
});

test("same runtime retry stays one canonical sample and one runtime provenance", () => {
  const first = recordGlobalEvidence(createGlobalEvidenceLedger(), evidence());
  const retry = recordGlobalEvidence(first.ledger, evidence());
  assert.equal(retry.status, DUPLICATE_ACCEPTED_ONCE);
  assert.equal(retry.sampleCountDelta, 0);
  assert.equal(retry.ledger.records.length, 1);
  assert.equal(retry.ledger.records[0].sources.length, 1);
  assert.equal(retry.ledger.duplicateAttempts[0].sourceAlreadyRecorded, true);
});

test("same canonical sample with conflicting payload fails closed even when runtime provenance differs", () => {
  const first = recordGlobalEvidence(createGlobalEvidenceLedger(), evidence());
  const conflict = recordGlobalEvidence(first.ledger, evidence({
    workflowFamily: "github-actions-paper-reverify-v1",
    artifactLineageDigest: "c".repeat(64),
    payload: { outcome: "SL_BEFORE_TP", netReturn: -0.01, costsApplied: true },
  }));

  assert.equal(conflict.status, EVIDENCE_ID_CONFLICT);
  assert.equal(conflict.sampleCountDelta, 0);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.ledger.records.length, 1);
  assert.equal(summarizeGlobalEvidenceLedger(conflict.ledger).failClosed, true);
  assert.throws(() => canonicalUniqueEvidence(conflict.ledger), new RegExp(EVIDENCE_ID_CONFLICT));
});

test("different semantic producer family remains separate evidence", () => {
  const paper = recordGlobalEvidence(createGlobalEvidenceLedger(), evidence());
  const shadow = recordGlobalEvidence(paper.ledger, evidence({
    producerFamily: "SHADOW",
    workflowFamily: "shadow-natural-v1",
    outcomeKind: "MATURED_LABEL",
    artifactLineageDigest: "d".repeat(64),
    payload: { status: "OBSERVED" },
  }));
  assert.equal(shadow.status, EVIDENCE_ACCEPTED);
  assert.equal(shadow.ledger.records.length, 2);
  assert.equal(canonicalUniqueEvidence(shadow.ledger, { producerFamily: "PAPER" }).length, 1);
  assert.equal(canonicalUniqueEvidence(shadow.ledger, { producerFamily: "SHADOW" }).length, 1);
});

test("canonical strategy identity digest is required; arbitrary identity objects do not silently hash", () => {
  assert.throws(() => buildGlobalEvidenceId(evidence({ strategyIdentityDigest: undefined, strategyIdentity: { strategyId: "x" } })), /strategyIdentityDigest is required/);
  assert.throws(() => buildGlobalEvidenceId(evidence({ strategyIdentityDigest: "not-a-digest" })), /64-character SHA-256 digest/);
});

test("legitimate different observation remains separate evidence", () => {
  const first = recordGlobalEvidence(createGlobalEvidenceLedger(), evidence());
  const second = recordGlobalEvidence(first.ledger, evidence({
    observationTimestamp: "2026-08-18T10:15:00.000Z",
    artifactLineageDigest: "e".repeat(64),
    payload: { outcome: "PENDING", netReturn: null, costsApplied: true },
  }));
  assert.equal(second.status, EVIDENCE_ACCEPTED);
  assert.equal(second.sampleCountDelta, 1);
  assert.equal(second.ledger.records.length, 2);
});

test("Paper, Shadow, Backtest and Forward aggregates consume canonical unique records only", () => {
  let ledger = recordGlobalEvidence(createGlobalEvidenceLedger(), evidence()).ledger;
  for (const [producerFamily, outcomeKind, minute, lineage] of [
    ["SHADOW", "MATURED_LABEL", "15", "c".repeat(64)],
    ["BACKTEST", "OOS_TRIAL", "30", "d".repeat(64)],
    ["FORWARD", "FORWARD_OUTCOME", "45", "e".repeat(64)],
  ]) {
    ledger = recordGlobalEvidence(ledger, evidence({
      producerFamily,
      workflowFamily: `${producerFamily.toLowerCase()}-evidence-v1`,
      outcomeKind,
      observationTimestamp: `2026-08-18T10:${minute}:00.000Z`,
      artifactLineageDigest: lineage,
      payload: { status: "OBSERVED" },
    })).ledger;
  }
  const retry = recordGlobalEvidence(ledger, evidence({
    workflowFamily: "github-actions-paper-reverify-v1",
    artifactLineageDigest: "f".repeat(64),
  }));
  assert.equal(retry.status, DUPLICATE_ACCEPTED_ONCE);
  ledger = retry.ledger;

  assert.equal(canonicalUniqueEvidence(ledger).length, 4);
  assert.equal(canonicalUniqueEvidence(ledger, { producerFamily: "PAPER" }).length, 1);
  assert.equal(canonicalUniqueEvidence(ledger, { producerFamily: "SHADOW" }).length, 1);
  assert.equal(canonicalUniqueEvidence(ledger, { producerFamily: "BACKTEST" }).length, 1);
  assert.equal(canonicalUniqueEvidence(ledger, { producerFamily: "FORWARD" }).length, 1);
  assert.equal(summarizeGlobalEvidenceLedger(ledger).runtimeSourceCount, 5);
});

test("tampered record internals or immutable predecessor fail closed", () => {
  const accepted = recordGlobalEvidence(createGlobalEvidenceLedger(), evidence());
  const tamperedPayload = {
    ...accepted.ledger,
    records: [{ ...accepted.ledger.records[0], payload: { outcome: "TAMPERED" } }],
  };
  assert.deepEqual(verifyGlobalEvidenceLedger(tamperedPayload), { valid: false, reason: ARTIFACT_CHAIN_BROKEN });

  const tamperedSource = {
    ...accepted.ledger,
    records: [{
      ...accepted.ledger.records[0],
      sources: [{ ...accepted.ledger.records[0].sources[0], workflowFamily: "tampered-runtime" }],
    }],
  };
  assert.deepEqual(verifyGlobalEvidenceLedger(tamperedSource), { valid: false, reason: ARTIFACT_CHAIN_BROKEN });

  assert.throws(() => recordGlobalEvidence(tamperedPayload, evidence()), new RegExp(ARTIFACT_CHAIN_BROKEN));
});

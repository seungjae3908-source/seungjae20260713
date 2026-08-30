import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import {
  CAPTURE_PARAMETER_POLICY,
  CAPTURE_PARAMETER_POLICY_DIGEST,
  SCHEDULED_TRIGGER_SOURCE,
  V3_POLICY_BINDING,
  buildV3ScheduleEntries,
} from '../src/public-forward-liquidity-capture-seam-v3.mjs';
import {
  buildStrictCompleteWindowLog,
  verifyProducedCompleteWindow,
  verifyScheduledFinalReceipt,
} from '../scripts/verify-public-forward-liquidity-v3-complete-window.mjs';

const CONTRACT_URL = new URL('../config/public-forward-liquidity-v3-activation-contract.json', import.meta.url);
const EXACT_MAIN = 'a'.repeat(40);

async function activationContract() {
  return JSON.parse(await readFile(CONTRACT_URL, 'utf8'));
}

function finalizeCaptureReceipt(captureBody, artifact = {}) {
  const captureReceipt = {
    ...captureBody,
    captureReceiptDigest: sha256(canonicalJson(captureBody)),
  };
  const finalBody = {
    ...captureReceipt,
    artifactId: artifact.artifactId ?? '800001',
    artifactName: artifact.artifactName,
    artifactDigest: artifact.artifactDigest ?? 'b'.repeat(64),
    artifactReference: artifact.artifactReference,
  };
  return {
    ...finalBody,
    receiptDigest: sha256(canonicalJson(finalBody)),
  };
}

async function validEnvelope(overrides = {}) {
  const contract = await activationContract();
  const slot = buildV3ScheduleEntries()[0];
  const runId = String(overrides.runId ?? '900001');
  const runAttempt = String(overrides.runAttempt ?? '1');
  const rawArtifactId = '800001';
  const rawArtifactName = overrides.rawArtifactName
    ?? `public-forward-liquidity-v3-slot-${slot.slotIndex}-${slot.canonicalSlotKeyDigest}`;
  const captureBody = {
    schemaVersion: 'public-forward-liquidity-capture-receipt-v3',
    evidenceClass: 'PUBLIC_FORWARD_LIQUIDITY_CAPTURE_ATTEMPT_RECEIPT',
    triggerSource: SCHEDULED_TRIGGER_SOURCE,
    ATTEMPTED: true,
    collectorInvoked: true,
    runId,
    runAttempt,
    repository: 'seungjae3908-source/seungjae20260713',
    exactMainSha: EXACT_MAIN,
    collectorCodeSha: EXACT_MAIN,
    collectorImplementationBlobSha: CAPTURE_PARAMETER_POLICY.collectorImplementationBlobSha,
    symbol: V3_POLICY_BINDING.symbol,
    market: V3_POLICY_BINDING.market,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    eventObservationDelayMs: CAPTURE_PARAMETER_POLICY.eventObservationDelayMs,
    postObservationDelaysMs: [...CAPTURE_PARAMETER_POLICY.postObservationDelaysMs],
    maxPreEventBookAgeMs: CAPTURE_PARAMETER_POLICY.maxPreEventBookAgeMs,
    captureParameterPolicyDigest: CAPTURE_PARAMETER_POLICY_DIGEST,
    activationContractVersion: contract.activationContractVersion,
    activationContractDigest: contract.activationContractDigest,
    captureStatus: 'PRESENT',
    blockers: [],
    prospectiveObservationCount: 1,
    droppedObservationCount: 0,
    rawBatchDigest: 'c'.repeat(64),
    prospectiveSlotCredit: 1,
    manualCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    operatorSelectedCredit: 0,
    canonicalDatasetPersistencePerformed: false,
    canonicalDatasetCreditApplied: false,
    duplicateCreditEvaluated: true,
    splitAssignmentPerformed: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    realOrders: 0,
    policyVersion: V3_POLICY_BINDING.policyVersion,
    policyDigest: overrides.policyDigest ?? V3_POLICY_BINDING.policyDigest,
    policyArtifactId: V3_POLICY_BINDING.policyArtifactId,
    policyArtifactDigest: V3_POLICY_BINDING.policyArtifactDigest,
    policyInternalArtifactDigest: V3_POLICY_BINDING.policyInternalArtifactDigest,
    cohortId: V3_POLICY_BINDING.cohortId,
    cohortDigest: overrides.cohortDigest ?? V3_POLICY_BINDING.cohortDigest,
    cohortEligibleAfterMs: V3_POLICY_BINDING.cohortEligibleAfterMs,
    captureSelectionPolicyDigest: V3_POLICY_BINDING.captureSelectionPolicyDigest,
    slotIntervalMs: V3_POLICY_BINDING.slotIntervalMs,
    slotIndex: slot.slotIndex,
    split: slot.split,
    slotStartMs: slot.slotStartMs,
    slotEndMs: slot.slotEndMs,
    nominalScheduledAtMs: slot.nominalScheduledAtMs,
    actualRunStartedAtMs: slot.nominalScheduledAtMs,
    actualRunCompletedAtMs: slot.nominalScheduledAtMs + 10_000,
    cronUtc: slot.cronUtc,
    canonicalSlotKey: slot.canonicalSlotKey,
    canonicalSlotKeyDigest: slot.canonicalSlotKeyDigest,
  };
  const receipt = finalizeCaptureReceipt(captureBody, {
    artifactId: rawArtifactId,
    artifactName: rawArtifactName,
    artifactDigest: 'b'.repeat(64),
    artifactReference: `https://github.com/seungjae3908-source/seungjae20260713/actions/runs/${runId}/artifacts/${rawArtifactId}`,
  });
  const metadata = {
    receiptArtifactId: '700001',
    receiptArtifactName: `public-forward-liquidity-v3-slot-receipt-${slot.slotIndex}-${runId}-${runAttempt}`,
    receiptArtifactDigest: 'd'.repeat(64),
    receiptArtifactCreatedAtMs: slot.nominalScheduledAtMs + 20_000,
    expired: false,
    workflowRunId: runId,
    workflowRunHeadBranch: 'main',
    workflowRunHeadSha: EXACT_MAIN,
  };
  return { receipt, metadata, contract, slot };
}

test('strict verifier accepts a fully bound finalized scheduled receipt', async () => {
  const envelope = await validEnvelope();
  const verified = verifyScheduledFinalReceipt({
    receipt: envelope.receipt,
    metadata: envelope.metadata,
    activationContract: envelope.contract,
  });
  assert.equal(verified.prospectiveSlotCredit, 1);
  assert.equal(verified.captureStatus, 'PRESENT');
});

test('strict verifier rejects semantically fabricated V3 policy even with recomputed self-digests', async () => {
  const envelope = await validEnvelope({ policyDigest: '0'.repeat(64) });
  assert.throws(() => verifyScheduledFinalReceipt({
    receipt: envelope.receipt,
    metadata: envelope.metadata,
    activationContract: envelope.contract,
  }), /FINAL_RECEIPT_V3_BINDING_MISMATCH/u);
});

test('strict verifier rejects tampered finalized receipt digest and mismatched GitHub run provenance', async () => {
  const envelope = await validEnvelope();
  const tampered = { ...envelope.receipt, prospectiveObservationCount: 2 };
  assert.throws(() => verifyScheduledFinalReceipt({
    receipt: tampered,
    metadata: envelope.metadata,
    activationContract: envelope.contract,
  }), /FINAL_RECEIPT_DIGEST_MISMATCH/u);

  const wrongMetadata = { ...envelope.metadata, workflowRunId: '999999' };
  assert.throws(() => verifyScheduledFinalReceipt({
    receipt: envelope.receipt,
    metadata: wrongMetadata,
    activationContract: envelope.contract,
  }), /FINAL_RECEIPT_GITHUB_PROVENANCE_MISMATCH/u);
});

test('strict complete-window reconstruction matches canonical producer output and rejects count drift', async () => {
  const envelope = await validEnvelope();
  const verified = verifyScheduledFinalReceipt({
    receipt: envelope.receipt,
    metadata: envelope.metadata,
    activationContract: envelope.contract,
  });
  const asOfMs = envelope.slot.nominalScheduledAtMs + 20_000;
  const producedLog = buildStrictCompleteWindowLog([verified], { asOfMs });
  assert.equal(producedLog.policyExpectedTotalSlotN, 48);
  assert.equal(producedLog.expectedTotalSlotN, 1);
  assert.equal(producedLog.splits.TRAIN.attemptedSlotN, 1);
  assert.equal(producedLog.splits.TRAIN.validCaptureSlotN, 1);
  const sourceSummary = {
    schemaVersion: 'public-forward-liquidity-v3-complete-window-source-summary-v1',
    asOfMs,
    receiptFileN: 1,
    acceptedScheduledReceiptN: 1,
    policyDigest: V3_POLICY_BINDING.policyDigest,
    cohortDigest: V3_POLICY_BINDING.cohortDigest,
    selectionComplete: false,
    fullCostReady: false,
    evidenceComplete: 0,
  };
  assert.equal(verifyProducedCompleteWindow({
    receipts: [verified],
    producedLog,
    sourceSummary,
  }).inScopeReceiptN, 1);

  const drifted = structuredClone(producedLog);
  drifted.splits.TRAIN.validCaptureSlotN = 0;
  assert.throws(() => verifyProducedCompleteWindow({
    receipts: [verified],
    producedLog: drifted,
    sourceSummary,
  }), /PRODUCED_COMPLETE_WINDOW_LOG_MISMATCH/u);
});

test('pre-first-slot strict complete-window counters are zero while policy totals remain frozen', () => {
  const asOfMs = V3_POLICY_BINDING.cohortEligibleAfterMs - 1;
  const log = buildStrictCompleteWindowLog([], { asOfMs });
  assert.equal(log.policyExpectedTotalSlotN, 48);
  assert.equal(log.expectedTotalSlotN, 0);
  for (const split of ['TRAIN', 'VALIDATION', 'OOS']) {
    assert.equal(log.splits[split].expectedSlotN, 0);
    assert.equal(log.splits[split].attemptedSlotN, 0);
    assert.equal(log.splits[split].missingSlotN, 0);
    assert.equal(log.splits[split].duplicateSlotAttemptN, 0);
    assert.equal(log.splits[split].validCaptureSlotN, 0);
    assert.equal(log.splits[split].blockedDataSlotN, 0);
  }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  normalizeBitgetPublicOrderBookFrame,
  normalizeBitgetPublicTradesFrame,
} from '../src/public-data.mjs';
import {
  buildPublicLiquidityObservationBatch,
  canonicalJson,
  sha256,
  verifyLiquidityCalibrationDataset,
} from '../src/public-forward-liquidity-calibration.mjs';
import { computePublicForwardLiquidityCaptureIngestReceiptDigest } from '../src/public-forward-liquidity-capture-ingest.mjs';
import {
  CAPTURE_PARAMETER_POLICY,
  CAPTURE_PARAMETER_POLICY_DIGEST,
  SCHEDULED_TRIGGER_SOURCE,
  V3_POLICY_BINDING,
  buildV3SlotDescriptor,
} from '../src/public-forward-liquidity-capture-seam-v3.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_V3_ACTIVATION_CONTRACT_DIGEST,
  PUBLIC_FORWARD_LIQUIDITY_V3_ACTIVATION_CONTRACT_VERSION,
  PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_ARTIFACT_RECEIPT_VERSION,
  PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_EVIDENCE_CLASS,
  PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_RECEIPT_VERSION,
  ingestPublicForwardLiquidityV3Capture,
} from '../src/public-forward-liquidity-v3-capture-ingest.mjs';

const SOURCE_MAIN_SHA = String(process.env.EXPECTED_SHA
  ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toLowerCase();
const REPOSITORY = 'seungjae3908-source/seungjae20260713';
const ARTIFACT_DIGEST = 'b'.repeat(64);
assert.match(SOURCE_MAIN_SHA, /^[a-f0-9]{40}$/u);

function bookFrame(offset = 0, { bids = [[100, 4], [99, 5]], asks = [[101, 3], [102, 6]] } = {}) {
  return normalizeBitgetPublicOrderBookFrame({
    symbol: 'BTCUSDT',
    payload: { code: '00000', data: { ts: String(1_000 + offset), b: bids, a: asks } },
    requestStartedAtMs: 900 + offset,
    receiveTimestampMs: 1_050 + offset,
    maxFrameAgeMs: 10_000,
    endpoint: '/api/v3/market/orderbook',
    query: 'category=USDT-FUTURES&symbol=BTCUSDT&limit=50',
  });
}

function tradesFrame(offset, execId) {
  return normalizeBitgetPublicTradesFrame({
    symbol: 'BTCUSDT',
    payload: { code: '00000', data: [{
      execId,
      execLinkId: `${execId}-link`,
      price: '101',
      size: '2',
      side: 'buy',
      ts: String(1_200 + offset),
      isRPI: 'NO',
    }] },
    requestStartedAtMs: 1_100 + offset,
    receiveTimestampMs: 1_300 + offset,
    endpoint: '/api/v3/market/fills',
    query: 'category=USDT-FUTURES&symbol=BTCUSDT&limit=100',
  });
}

function batch(offset, execId) {
  return buildPublicLiquidityObservationBatch({
    preEventBook: bookFrame(offset),
    tradeFrame: tradesFrame(offset, execId),
    postEventBooks: [bookFrame(offset + 500, {
      bids: [[101, 2], [100, 5]],
      asks: [[102, 4], [103, 5]],
    })],
    collectorCodeSha: SOURCE_MAIN_SHA,
  });
}

function captureReceipt(rawBatch, slotIndex, overrides = {}) {
  const slot = buildV3SlotDescriptor(slotIndex);
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_RECEIPT_VERSION,
    evidenceClass: PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_EVIDENCE_CLASS,
    triggerSource: SCHEDULED_TRIGGER_SOURCE,
    ATTEMPTED: true,
    collectorInvoked: true,
    runId: String(40_000_000_000 + slotIndex),
    runAttempt: '1',
    repository: REPOSITORY,
    exactMainSha: SOURCE_MAIN_SHA,
    collectorCodeSha: SOURCE_MAIN_SHA,
    collectorImplementationBlobSha: CAPTURE_PARAMETER_POLICY.collectorImplementationBlobSha,
    symbol: V3_POLICY_BINDING.symbol,
    market: V3_POLICY_BINDING.market,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    eventObservationDelayMs: CAPTURE_PARAMETER_POLICY.eventObservationDelayMs,
    postObservationDelaysMs: [...CAPTURE_PARAMETER_POLICY.postObservationDelaysMs],
    maxPreEventBookAgeMs: CAPTURE_PARAMETER_POLICY.maxPreEventBookAgeMs,
    captureParameterPolicyDigest: CAPTURE_PARAMETER_POLICY_DIGEST,
    activationContractVersion: PUBLIC_FORWARD_LIQUIDITY_V3_ACTIVATION_CONTRACT_VERSION,
    activationContractDigest: PUBLIC_FORWARD_LIQUIDITY_V3_ACTIVATION_CONTRACT_DIGEST,
    captureStatus: 'PRESENT',
    blockers: [],
    prospectiveObservationCount: rawBatch.observations.length,
    droppedObservationCount: rawBatch.droppedEvents.length,
    rawBatchDigest: sha256(canonicalJson(rawBatch)),
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
    policyDigest: V3_POLICY_BINDING.policyDigest,
    policyArtifactId: V3_POLICY_BINDING.policyArtifactId,
    policyArtifactDigest: V3_POLICY_BINDING.policyArtifactDigest,
    policyInternalArtifactDigest: V3_POLICY_BINDING.policyInternalArtifactDigest,
    cohortId: V3_POLICY_BINDING.cohortId,
    cohortDigest: V3_POLICY_BINDING.cohortDigest,
    cohortEligibleAfterMs: V3_POLICY_BINDING.cohortEligibleAfterMs,
    captureSelectionPolicyDigest: V3_POLICY_BINDING.captureSelectionPolicyDigest,
    slotIntervalMs: V3_POLICY_BINDING.slotIntervalMs,
    slotIndex: slot.slotIndex,
    split: slot.split,
    slotStartMs: slot.slotStartMs,
    slotEndMs: slot.slotEndMs,
    nominalScheduledAtMs: slot.nominalScheduledAtMs,
    actualRunStartedAtMs: slot.nominalScheduledAtMs + 1_000,
    actualRunCompletedAtMs: slot.nominalScheduledAtMs + 5_000,
    cronUtc: slot.cronUtc,
    canonicalSlotKey: slot.canonicalSlotKey,
    canonicalSlotKeyDigest: slot.canonicalSlotKeyDigest,
    ...overrides,
  };
  return { ...body, captureReceiptDigest: sha256(canonicalJson(body)) };
}

function artifactReceipt(capture, artifactId, overrides = {}) {
  const body = {
    ...capture,
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_ARTIFACT_RECEIPT_VERSION,
    artifactId: String(artifactId),
    artifactName: `public-forward-liquidity-v3-slot-${capture.slotIndex}-${capture.canonicalSlotKeyDigest}`,
    artifactDigest: ARTIFACT_DIGEST,
    artifactReference: `https://github.com/${REPOSITORY}/actions/runs/${capture.runId}/artifacts/${artifactId}`,
    ...overrides,
  };
  return { ...body, receiptDigest: sha256(canonicalJson(body)) };
}

async function ingest(stateRoot, rawBatch, capture, artifact, artifactId) {
  return ingestPublicForwardLiquidityV3Capture({
    stateRoot,
    researchRepoRoot: resolve('.'),
    expectedMainSha: SOURCE_MAIN_SHA,
    expectedRepository: REPOSITORY,
    expectedArtifactId: String(artifactId),
    expectedArtifactDigest: ARTIFACT_DIGEST,
    rawBatch,
    captureReceipt: capture,
    artifactReceipt: artifact,
  });
}

test('genuine scheduled V3 slots accumulate one exact same-collector predecessor chain without independent credit', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'liquidity-v3-state-'));
  try {
    const raw0 = batch(0, 'v3-slot-0');
    const cap0 = captureReceipt(raw0, 0);
    const first = await ingest(stateRoot, raw0, cap0, artifactReceipt(cap0, 500001), 500001);
    assert.equal(first.predecessorDatasetDigest, null);
    assert.equal(first.batchProvenanceIndex, 0);
    assert.equal(first.sourceV3Lineage.slotIndex, 0);
    assert.equal(first.sourceV3Lineage.split, 'TRAIN');
    assert.equal(first.effectiveIndependentCalibrationN, null);
    assert.equal(first.fullCostReady, false);
    assert.equal(first.receiptDigest, computePublicForwardLiquidityCaptureIngestReceiptDigest(first));

    const raw1 = batch(10_000, 'v3-slot-1');
    const cap1 = captureReceipt(raw1, 1);
    const second = await ingest(stateRoot, raw1, cap1, artifactReceipt(cap1, 500002), 500002);
    assert.equal(second.predecessorDatasetDigest, first.datasetDigest);
    assert.equal(second.batchProvenanceIndex, 1);
    assert.equal(second.datasetBatchProvenanceCount, 2);
    assert.equal(second.sourceV3Lineage.slotIndex, 1);
    assert.equal(second.sourceV3Lineage.captureReceiptDigest, cap1.captureReceiptDigest);
    const stored = JSON.parse(await readFile(join(stateRoot, second.datasetRelativePath), 'utf8'));
    assert.deepEqual(verifyLiquidityCalibrationDataset(stored), { valid: true, reason: null });
    assert.equal(stored.batchProvenance.length, 2);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('V3 ingest fails closed on manual/rerun/policy/slot/chronology/authority/artifact tampering', async () => {
  const raw = batch(20_000, 'v3-tamper');
  const mutations = [
    [(value) => ({ ...value, triggerSource: 'MANUAL_WORKFLOW_DISPATCH' }), /V3_CAPTURE_RECEIPT_CONTRACT_INVALID/],
    [(value) => ({ ...value, runAttempt: '2' }), /V3_RERUN_CREDIT_FORBIDDEN/],
    [(value) => ({ ...value, policyDigest: 'c'.repeat(64) }), /V3_POLICYDIGEST_MISMATCH/],
    [(value) => ({ ...value, split: 'OOS' }), /V3_SLOT_SPLIT_MISMATCH/],
    [(value) => ({ ...value, actualRunCompletedAtMs: value.slotEndMs }), /V3_SLOT_CHRONOLOGY_INVALID/],
    [(value) => ({ ...value, fullCostReady: true }), /V3_CAPTURE_TRUTH_BOUNDARY_INVALID/],
  ];
  for (const [mutate, expected] of mutations) {
    const stateRoot = await mkdtemp(join(tmpdir(), 'liquidity-v3-tamper-'));
    try {
      const changed = mutate(captureReceipt(raw, 2));
      const { captureReceiptDigest: _ignored, ...body } = changed;
      const capture = { ...changed, captureReceiptDigest: sha256(canonicalJson(body)) };
      await assert.rejects(ingest(stateRoot, raw, capture, artifactReceipt(capture, 500003), 500003), expected);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  }

  const stateRoot = await mkdtemp(join(tmpdir(), 'liquidity-v3-artifact-'));
  try {
    const capture = captureReceipt(raw, 3);
    const artifact = artifactReceipt(capture, 500004, { artifactName: 'wrong-artifact' });
    artifact.receiptDigest = sha256(canonicalJson(Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== 'receiptDigest'))));
    await assert.rejects(ingest(stateRoot, raw, capture, artifact, 500004), /V3_ARTIFACT_NAME_MISMATCH/);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

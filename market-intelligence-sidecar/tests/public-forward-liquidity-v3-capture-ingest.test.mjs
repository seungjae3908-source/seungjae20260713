import assert from 'node:assert/strict';
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
import {
  computePublicForwardLiquidityCaptureIngestReceiptDigest,
} from '../src/public-forward-liquidity-capture-ingest.mjs';
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

const SOURCE_MAIN_SHA = 'c1e38a23247b0022ced22b6643f74ed94bb06403';
const REPOSITORY = 'seungjae3908-source/seungjae20260713';
const ARTIFACT_DIGEST = 'b'.repeat(64);

function bookFrame(offset = 0, overrides = {}) {
  const marketTimestampMs = 1_000 + offset;
  return normalizeBitgetPublicOrderBookFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: {
        ts: String(marketTimestampMs),
        b: overrides.bids ?? [[100, 4], [99, 5]],
        a: overrides.asks ?? [[101, 3], [102, 6]],
      },
    },
    requestStartedAtMs: 900 + offset,
    receiveTimestampMs: 1_050 + offset,
    maxFrameAgeMs: 10_000,
    endpoint: '/api/v3/market/orderbook',
    query: 'category=USDT-FUTURES&symbol=BTCUSDT&limit=50',
  });
}

function tradesFrame(offset = 0, execId = 'public-exec-v3-0') {
  return normalizeBitgetPublicTradesFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: [{
        execId,
        execLinkId: `${execId}-link`,
        price: '101',
        size: '2',
        side: 'buy',
        ts: String(1_200 + offset),
        isRPI: 'NO',
      }],
    },
    requestStartedAtMs: 1_100 + offset,
    receiveTimestampMs: 1_300 + offset,
    endpoint: '/api/v3/market/fills',
    query: 'category=USDT-FUTURES&symbol=BTCUSDT&limit=100',
  });
}

function validBatch(offset = 0, execId = `public-exec-v3-${offset}`) {
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

function scheduledCapture(batch, slotIndex, overrides = {}) {
  const slot = buildV3SlotDescriptor(slotIndex);
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_RECEIPT_VERSION,
    evidenceClass: PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_EVIDENCE_CLASS,
    triggerSource: SCHEDULED_TRIGGER_SOURCE,
    ATTEMPTED: true,
    collectorInvoked: true,
    runId: String(40000000000 + slotIndex),
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
    prospectiveObservationCount: batch.observations.length,
    droppedObservationCount: batch.droppedEvents.length,
    rawBatchDigest: sha256(canonicalJson(batch)),
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
  const { captureReceiptDigest: _ignored, ...digestBody } = body;
  return { ...body, captureReceiptDigest: sha256(canonicalJson(digestBody)) };
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

async function ingestFixture({ stateRoot, batch, capture, artifact, artifactId }) {
  return ingestPublicForwardLiquidityV3Capture({
    stateRoot,
    researchRepoRoot: resolve('.'),
    expectedMainSha: SOURCE_MAIN_SHA,
    expectedRepository: REPOSITORY,
    expectedArtifactId: String(artifactId),
    expectedArtifactDigest: ARTIFACT_DIGEST,
    rawBatch: batch,
    captureReceipt: capture,
    artifactReceipt: artifact,
  });
}

test('ingests ordered genuine V3 scheduled slots into one cumulative same-collector receipt chain', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'liquidity-v3-state-'));
  try {
    const batch0 = validBatch(0, 'public-exec-v3-slot0');
    const capture0 = scheduledCapture(batch0, 0);
    const artifact0 = artifactReceipt(capture0, 500001);
    const first = await ingestFixture({ stateRoot, batch: batch0, capture: capture0, artifact: artifact0, artifactId: 500001 });

    assert.equal(first.predecessorDatasetDigest, null);
    assert.equal(first.batchProvenanceIndex, 0);
    assert.equal(first.datasetBatchProvenanceCount, 1);
    assert.equal(first.sourceV3Lineage.slotIndex, 0);
    assert.equal(first.sourceV3Lineage.split, 'TRAIN');
    assert.equal(first.sourceV3Lineage.prospectiveSlotCredit, 1);
    assert.equal(first.sourceV3Lineage.replayCredit, 0);
    assert.equal(first.fullCostReady, false);
    assert.equal(first.effectiveIndependentCalibrationN, null);
    assert.equal(first.receiptDigest, computePublicForwardLiquidityCaptureIngestReceiptDigest(first));

    const batch1 = validBatch(10_000, 'public-exec-v3-slot1');
    const capture1 = scheduledCapture(batch1, 1);
    const artifact1 = artifactReceipt(capture1, 500002);
    const second = await ingestFixture({ stateRoot, batch: batch1, capture: capture1, artifact: artifact1, artifactId: 500002 });

    assert.equal(second.predecessorDatasetDigest, first.datasetDigest);
    assert.equal(second.batchProvenanceIndex, 1);
    assert.equal(second.datasetBatchProvenanceCount, 2);
    assert.equal(second.datasetObservationCount, 2);
    assert.equal(second.sourceV3Lineage.slotIndex, 1);
    assert.equal(second.sourceV3Lineage.split, 'TRAIN');
    assert.equal(second.sourceV3Lineage.captureReceiptDigest, capture1.captureReceiptDigest);
    assert.equal(second.receiptDigest, computePublicForwardLiquidityCaptureIngestReceiptDigest(second));

    const stored = JSON.parse(await readFile(join(stateRoot, second.datasetRelativePath), 'utf8'));
    assert.deepEqual(verifyLiquidityCalibrationDataset(stored), { valid: true, reason: null });
    assert.equal(stored.batchProvenance.length, 2);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('fails closed for manual, rerun, policy, slot, chronology, artifact and authority tampering', async () => {
  const cases = [
    ['manual trigger', (capture) => ({ ...capture, triggerSource: 'MANUAL_WORKFLOW_DISPATCH' }), /V3_CAPTURE_RECEIPT_CONTRACT_INVALID/],
    ['rerun', (capture) => ({ ...capture, runAttempt: '2' }), /V3_RERUN_CREDIT_FORBIDDEN/],
    ['policy', (capture) => ({ ...capture, policyDigest: 'c'.repeat(64) }), /V3_POLICYDIGEST_MISMATCH|V3_POLICYDIGEST/i],
    ['slot split', (capture) => ({ ...capture, split: 'OOS' }), /V3_SLOT_SPLIT_MISMATCH/],
    ['late completion', (capture) => ({ ...capture, actualRunCompletedAtMs: capture.slotEndMs }), /V3_SLOT_CHRONOLOGY_INVALID/],
    ['authority', (capture) => ({ ...capture, fullCostReady: true }), /V3_CAPTURE_TRUTH_BOUNDARY_INVALID/],
  ];

  for (const [name, mutate, pattern] of cases) {
    const stateRoot = await mkdtemp(join(tmpdir(), `liquidity-v3-${name.replaceAll(' ', '-')}-`));
    try {
      const batch = validBatch(20_000, `public-exec-${name}`);
      const base = scheduledCapture(batch, 2);
      const mutatedBody = mutate(base);
      const { captureReceiptDigest: _old, ...body } = mutatedBody;
      const capture = { ...mutatedBody, captureReceiptDigest: sha256(canonicalJson(body)) };
      const artifact = artifactReceipt(capture, 500003);
      await assert.rejects(
        ingestFixture({ stateRoot, batch, capture, artifact, artifactId: 500003 }),
        pattern,
      );
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  }

  const stateRoot = await mkdtemp(join(tmpdir(), 'liquidity-v3-artifact-name-'));
  try {
    const batch = validBatch(30_000, 'public-exec-artifact-name');
    const capture = scheduledCapture(batch, 3);
    const artifact = artifactReceipt(capture, 500004, { artifactName: 'wrong-artifact' });
    artifact.receiptDigest = sha256(canonicalJson(Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== 'receiptDigest'))));
    await assert.rejects(
      ingestFixture({ stateRoot, batch, capture, artifact, artifactId: 500004 }),
      /V3_ARTIFACT_NAME_MISMATCH/,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

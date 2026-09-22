import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertIncrementalContinuation,
  sha256Canonical,
  validatePreviousCanonicalState,
} from '../src/public-forward-liquidity-v3-canonical-continuation.mjs';

function fixture(targetSlotIndex = 468) {
  const inventoryBody = {
    schemaVersion: 'public-forward-liquidity-authoritative-ingest-inventory-v1',
    kind: 'PUBLIC_FORWARD_LIQUIDITY_RECEIPT_BOUND_INGEST_EVIDENCE',
    producerHeadSha: 'a'.repeat(40),
    executionMode: 'GITHUB_HOSTED_EPHEMERAL_STATE_ROOT',
    evidenceGeneration: 'V3_SCHEDULED_CUMULATIVE_REBUILD',
    persistentResearchStateMutation: false,
    productionMutation: false,
    targetSlotIndex,
    genuineScheduledSlotN: 2,
    genuineScheduledLaneReceiptN: 3,
    rawN: 3,
    acceptedN: 3,
    droppedN: 0,
    buyN: 2,
    sellN: 1,
    independentSampleCredit: 0,
    sources: [],
    fullCostReady: false,
    evidenceComplete: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    realOrders: 0,
  };
  const inventory = { ...inventoryBody, inventoryDigest: sha256Canonical(inventoryBody) };
  const reportBody = {
    schemaVersion: 'public-forward-liquidity-authoritative-ingest-report-v1',
    realIngestExecuted: true,
    realIngestAuthority: 'IMMUTABLE_GITHUB_ARTIFACT_EPHEMERAL_CANONICAL_STORE',
    producerHeadSha: 'a'.repeat(40),
    sourceInventoryDigest: inventory.inventoryDigest,
    sourceCount: 0,
    genuineScheduledSlotN: 2,
    genuineScheduledLaneReceiptN: 3,
    targetSlotIndex,
    canonicalDatasetDigests: [],
    ingestReceiptDigests: [],
    collectorImplementationBlobShas: [],
    rawN: 3,
    acceptedN: 3,
    droppedN: 0,
    buyN: 2,
    sellN: 1,
    effectiveIndependentN: null,
    buyCoverageProven: false,
    fullCostReady: false,
    evidenceComplete: 0,
    persistentResearchStateMutation: false,
    executionAuthority: 'NONE',
  };
  const report = { ...reportBody, reportDigest: sha256Canonical(reportBody) };
  return { inventory, report };
}

function receipt(runId, slotIndex, laneId = undefined) {
  return {
    captureRunId: String(runId),
    sourceV3Lineage: {
      slotIndex,
      ...(laneId === undefined ? {} : { laneId }),
    },
  };
}

test('accepts a strictly later natural source without replaying history', () => {
  const { inventory, report } = fixture(468);
  const result = assertIncrementalContinuation({
    previousInventory: inventory,
    previousReport: report,
    existingReceipts: [receipt('35713173402', 464, 'P2_V3_BTCUSDT_UTC17')],
    nextCapture: { slotIndex: 469, laneId: 'P2_V3_BTCUSDT_UTC17' },
    nextRunId: '35750000001',
  });
  assert.equal(result.previousTargetSlotIndex, 468);
  assert.equal(result.targetSlotIndex, 469);
});

test('allows the second frozen lane in the same prospective slot', () => {
  const { inventory, report } = fixture(468);
  const result = assertIncrementalContinuation({
    previousInventory: inventory,
    previousReport: report,
    existingReceipts: [receipt('35740000001', 468, 'P2_V3_BTCUSDT_UTC17')],
    nextCapture: { slotIndex: 468, laneId: 'P2_V3_BTCUSDT_UTC37' },
    nextRunId: '35740000002',
  });
  assert.equal(result.nextCreditKey, 'phase2:468:P2_V3_BTCUSDT_UTC37');
});

test('rejects a hindsight/backfill source older than the canonical anchor', () => {
  const { inventory, report } = fixture(468);
  assert.throws(() => assertIncrementalContinuation({
    previousInventory: inventory,
    previousReport: report,
    existingReceipts: [],
    nextCapture: { slotIndex: 467, laneId: 'P2_V3_BTCUSDT_UTC17' },
    nextRunId: '35730000001',
  }), /V3_INCREMENTAL_BACKFILL_FORBIDDEN/);
});

test('rejects duplicate source-run and lane-slot credit', () => {
  const { inventory, report } = fixture(468);
  const prior = receipt('35740000001', 468, 'P2_V3_BTCUSDT_UTC17');
  assert.throws(() => assertIncrementalContinuation({
    previousInventory: inventory,
    previousReport: report,
    existingReceipts: [prior],
    nextCapture: { slotIndex: 468, laneId: 'P2_V3_BTCUSDT_UTC37' },
    nextRunId: '35740000001',
  }), /V3_INCREMENTAL_SOURCE_ALREADY_CONSUMED/);
  assert.throws(() => assertIncrementalContinuation({
    previousInventory: inventory,
    previousReport: report,
    existingReceipts: [prior],
    nextCapture: { slotIndex: 468, laneId: 'P2_V3_BTCUSDT_UTC17' },
    nextRunId: '35740000002',
  }), /V3_INCREMENTAL_CREDIT_ALREADY_CONSUMED/);
});

test('rejects prior canonical state that weakens the no-authority boundary', () => {
  const { inventory, report } = fixture(468);
  const unsafeBody = { ...inventory, liveTrading: true };
  delete unsafeBody.inventoryDigest;
  const unsafe = { ...unsafeBody, inventoryDigest: sha256Canonical(unsafeBody) };
  assert.throws(() => validatePreviousCanonicalState(unsafe, report), /V3_PREVIOUS_AUTHORITY_BOUNDARY_INVALID/);
});

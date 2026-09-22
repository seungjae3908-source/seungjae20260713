import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL_ID = /^[0-9]+$/u;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value;
}

function integer(value, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function decimalId(value, code) {
  const normalized = String(value ?? '').trim();
  if (!DECIMAL_ID.test(normalized)) throw new Error(code);
  return normalized;
}

function digest(value, code) {
  const normalized = String(value ?? '').replace(/^sha256:/u, '').toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(code);
  return normalized;
}

function verifyEmbeddedDigest(value, key, code) {
  const actual = digest(value[key], code);
  const body = Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
  if (actual !== sha256Canonical(body)) throw new Error(code);
  return actual;
}

export function validatePreviousCanonicalState(inventoryInput, reportInput) {
  const inventory = object(inventoryInput, 'V3_PREVIOUS_INVENTORY_INVALID');
  const report = object(reportInput, 'V3_PREVIOUS_REPORT_INVALID');
  if (inventory.schemaVersion !== 'public-forward-liquidity-authoritative-ingest-inventory-v1') {
    throw new Error('V3_PREVIOUS_INVENTORY_SCHEMA_INVALID');
  }
  if (report.schemaVersion !== 'public-forward-liquidity-authoritative-ingest-report-v1') {
    throw new Error('V3_PREVIOUS_REPORT_SCHEMA_INVALID');
  }
  const inventoryDigest = verifyEmbeddedDigest(inventory, 'inventoryDigest', 'V3_PREVIOUS_INVENTORY_DIGEST_INVALID');
  verifyEmbeddedDigest(report, 'reportDigest', 'V3_PREVIOUS_REPORT_DIGEST_INVALID');
  if (digest(report.sourceInventoryDigest, 'V3_PREVIOUS_SOURCE_INVENTORY_DIGEST_INVALID') !== inventoryDigest) {
    throw new Error('V3_PREVIOUS_SOURCE_INVENTORY_DIGEST_MISMATCH');
  }
  const inventoryTarget = integer(inventory.targetSlotIndex, 'V3_PREVIOUS_TARGET_SLOT_INVALID');
  const reportTarget = integer(report.targetSlotIndex, 'V3_PREVIOUS_REPORT_TARGET_SLOT_INVALID');
  if (inventoryTarget !== reportTarget) throw new Error('V3_PREVIOUS_TARGET_SLOT_MISMATCH');
  if (report.realIngestExecuted !== true
    || inventory.persistentResearchStateMutation !== false
    || report.persistentResearchStateMutation !== false
    || inventory.productionMutation !== false
    || inventory.executionAuthority !== 'NONE'
    || report.executionAuthority !== 'NONE'
    || inventory.privateApiUsed !== false
    || inventory.liveTrading !== false
    || Number(inventory.realOrders) !== 0
    || inventory.fullCostReady !== false
    || report.fullCostReady !== false
    || Number(inventory.evidenceComplete) !== 0
    || Number(report.evidenceComplete) !== 0) {
    throw new Error('V3_PREVIOUS_AUTHORITY_BOUNDARY_INVALID');
  }
  return { targetSlotIndex: inventoryTarget, inventoryDigest };
}

export function continuationCreditKey(lineageInput) {
  const lineage = object(lineageInput, 'V3_CONTINUATION_LINEAGE_INVALID');
  const slotIndex = integer(lineage.slotIndex, 'V3_CONTINUATION_SLOT_INVALID');
  const laneId = lineage.laneId == null ? null : String(lineage.laneId).trim();
  if (laneId === '') throw new Error('V3_CONTINUATION_LANE_INVALID');
  return laneId == null ? `legacy:${slotIndex}` : `phase2:${slotIndex}:${laneId}`;
}

function modeFor(lineage) {
  return lineage?.laneId == null ? 'LEGACY_SINGLE_LANE' : 'PHASE2_MULTI_LANE';
}

export function assertIncrementalContinuation({
  previousInventory,
  previousReport,
  existingReceipts = [],
  nextCapture,
  nextRunId,
}) {
  const previous = validatePreviousCanonicalState(previousInventory, previousReport);
  const capture = object(nextCapture, 'V3_INCREMENTAL_CAPTURE_INVALID');
  const nextSlot = integer(capture.slotIndex, 'V3_INCREMENTAL_SLOT_INVALID');
  const runId = decimalId(nextRunId, 'V3_INCREMENTAL_RUN_ID_INVALID');
  if (nextSlot < previous.targetSlotIndex) throw new Error('V3_INCREMENTAL_BACKFILL_FORBIDDEN');

  const nextKey = continuationCreditKey(capture);
  const existingKeys = new Set();
  let sameSlotMode = null;
  for (const receiptInput of existingReceipts) {
    const receipt = object(receiptInput, 'V3_EXISTING_RECEIPT_INVALID');
    if (String(receipt.captureRunId ?? '') === runId) throw new Error('V3_INCREMENTAL_SOURCE_ALREADY_CONSUMED');
    const lineage = object(receipt.sourceV3Lineage, 'V3_EXISTING_LINEAGE_INVALID');
    const key = continuationCreditKey(lineage);
    if (existingKeys.has(key)) throw new Error('V3_EXISTING_CREDIT_KEY_DUPLICATE');
    existingKeys.add(key);
    if (integer(lineage.slotIndex, 'V3_EXISTING_SLOT_INVALID') === nextSlot) {
      const mode = modeFor(lineage);
      if (sameSlotMode && sameSlotMode !== mode) throw new Error('MIXED_CREDIT_POLICY_WITHIN_V3_SLOT');
      sameSlotMode = mode;
    }
  }
  if (existingKeys.has(nextKey)) throw new Error('V3_INCREMENTAL_CREDIT_ALREADY_CONSUMED');
  if (sameSlotMode && sameSlotMode !== modeFor(capture)) throw new Error('MIXED_CREDIT_POLICY_WITHIN_V3_SLOT');

  return {
    previousTargetSlotIndex: previous.targetSlotIndex,
    targetSlotIndex: nextSlot,
    nextCreditKey: nextKey,
    existingReceiptN: existingReceipts.length,
  };
}

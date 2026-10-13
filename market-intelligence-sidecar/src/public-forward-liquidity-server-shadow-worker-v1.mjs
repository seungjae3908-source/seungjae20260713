import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  CALIBRATION_RESEARCH_SAMPLE,
  canonicalJson,
  collectBitgetForwardLiquidityObservationBatch,
  sha256,
} from './public-forward-liquidity-calibration.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  buildSuccessorScheduleReliabilityV3SlotDescriptor,
  verifySuccessorScheduleReliabilityV3Contract,
} from './public-forward-liquidity-successor-schedule-reliability-v3.mjs';

export const SERVER_EVIDENCE_SHADOW_SCHEMA =
  'public-forward-liquidity-server-shadow-receipt-v1';
export const SERVER_EVIDENCE_SHADOW_MODE = 'SHADOW_ONLY';
export const SERVER_EVIDENCE_TRIGGER_GRACE_MS = 55_000;
export const SERVER_EVIDENCE_STATE_CONTRACT =
  'public-forward-liquidity-server-shadow-state-root-v1';

const TRIGGER_MINUTES = Object.freeze([17, 27, 37]);

function exactSha(value, code = 'SERVER_EVIDENCE_SHA_INVALID') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function exactDigest(value, code = 'SERVER_EVIDENCE_DIGEST_INVALID') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function positiveInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

function bool(value) {
  return value === true || String(value ?? '').toLowerCase() === 'true';
}

export function resolveServerEvidenceNtpSynchronization({
  timedatectlSucceeded,
  timedatectlValue,
  systemdSyncMarkerPresent,
} = {}) {
  if (timedatectlSucceeded === true) {
    return String(timedatectlValue ?? '').trim().toLowerCase() === 'yes';
  }
  return systemdSyncMarkerPresent === true;
}

function safeErrorCode(error) {
  const first = String(error?.message ?? 'UNKNOWN').split('\n')[0].slice(0, 160);
  return first.replace(/[^A-Za-z0-9_.:-]/gu, '_');
}

function safety() {
  return Object.freeze({
    shadowOnly: true,
    serverCanonical: false,
    prospectiveSlotCredit: 0,
    canonicalEconomicCredit: 0,
    economicSampleCredit: 0,
    profitabilityCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    hindsightCredit: 0,
    fullCostReady: false,
    evidenceComplete: 0,
    profitabilityProven: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: 'NONE',
    replitAllowed: false,
  });
}

export function buildServerEvidenceShadowSelfCheck(
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
) {
  const verdict = verifySuccessorScheduleReliabilityV3Contract(contract);
  return Object.freeze({
    schemaVersion: 'public-forward-liquidity-server-shadow-self-check-v1',
    contractValid: verdict.valid,
    activationBound: verdict.activationBound,
    contractBlockers: Object.freeze([...verdict.blockers]),
    triggerMinutesUtc: TRIGGER_MINUTES,
    slotCadenceMs: contract.policyCore.cohort.slotCadenceMs,
    splits: Object.freeze({
      TRAIN: Object.freeze({ ...contract.policyCore.splits.TRAIN }),
      VALIDATION: Object.freeze({ ...contract.policyCore.splits.VALIDATION }),
      OOS: Object.freeze({ ...contract.policyCore.splits.OOS }),
    }),
    safety: safety(),
  });
}

export function resolveServerEvidenceShadowSlot({
  nowMs,
  triggerGraceMs = SERVER_EVIDENCE_TRIGGER_GRACE_MS,
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} = {}) {
  const verdict = verifySuccessorScheduleReliabilityV3Contract(contract);
  if (!verdict.valid || contract.activationBound !== true) {
    return Object.freeze({
      eligible: false,
      blocker: 'SERVER_EVIDENCE_V3_CONTRACT_NOT_ACTIVE',
      contractBlockers: Object.freeze([...verdict.blockers]),
    });
  }

  const now = Number(nowMs);
  if (!Number.isInteger(now) || now < 0) {
    throw new Error('SERVER_EVIDENCE_NOW_MS_INVALID');
  }
  if (!Number.isInteger(triggerGraceMs) || triggerGraceMs < 0 || triggerGraceMs >= 60_000) {
    throw new Error('SERVER_EVIDENCE_TRIGGER_GRACE_INVALID');
  }

  const cohort = contract.policyCore.cohort;
  if (now < cohort.startInclusiveMs || now >= cohort.endExclusiveMs) {
    return Object.freeze({
      eligible: false,
      blocker: 'SERVER_EVIDENCE_OUTSIDE_FROZEN_COHORT',
    });
  }

  const date = new Date(now);
  const minute = date.getUTCMinutes();
  const attemptIndex = TRIGGER_MINUTES.indexOf(minute);
  if (attemptIndex < 0) {
    return Object.freeze({
      eligible: false,
      blocker: 'SERVER_EVIDENCE_NOT_FROZEN_TRIGGER_MINUTE',
      triggerMinuteUtc: minute,
    });
  }

  const triggerAtMs = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    minute,
    0,
    0,
  );
  const triggerLagMs = now - triggerAtMs;
  if (triggerLagMs < 0 || triggerLagMs > triggerGraceMs) {
    return Object.freeze({
      eligible: false,
      blocker: 'SERVER_EVIDENCE_TRIGGER_STARTED_TOO_LATE',
      triggerMinuteUtc: minute,
      triggerLagMs,
      triggerGraceMs,
    });
  }

  const slotIndex = Math.floor(
    (now - cohort.startInclusiveMs) / cohort.slotCadenceMs,
  );
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(slotIndex, contract);
  if (triggerAtMs < slot.nominalScheduledAtMs
    || triggerAtMs > slot.allowedStartThroughMs) {
    return Object.freeze({
      eligible: false,
      blocker: 'SERVER_EVIDENCE_TRIGGER_OUTSIDE_FROZEN_SLOT',
      triggerMinuteUtc: minute,
      triggerLagMs,
      slotIndex,
      split: slot.split,
    });
  }

  return Object.freeze({
    eligible: true,
    blocker: null,
    slot,
    slotIndex,
    split: slot.split,
    triggerMinuteUtc: minute,
    attemptIndex: attemptIndex + 1,
    triggerAtMs,
    triggerLagMs,
    triggerGraceMs,
  });
}

async function writeCreateOnly(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(
      typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
      'utf8',
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readReceipt(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function successfulShadowCaptureExists(slotRoot) {
  let entries = [];
  try {
    entries = await readdir(slotRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const receipt = await readReceipt(join(slotRoot, entry.name, 'shadow-receipt.json'));
    if (receipt?.captureStatus === 'PRESENT_SHADOW'
      && receipt?.shadowOnly === true
      && receipt?.canonicalEconomicCredit === 0) {
      return true;
    }
  }
  return false;
}

function receiptWithDigest(body) {
  return Object.freeze({
    ...body,
    receiptDigest: sha256(canonicalJson(body)),
  });
}

function receiptBase({
  authority,
  codeSha,
  activationReceiptCommentId,
  activationReceiptMainSha,
  activationBindingDigest,
  nowMs,
  ntpSynchronized,
  contract,
}) {
  return {
    schemaVersion: SERVER_EVIDENCE_SHADOW_SCHEMA,
    stateContract: SERVER_EVIDENCE_STATE_CONTRACT,
    mode: SERVER_EVIDENCE_SHADOW_MODE,
    shadowOnly: true,
    serverCanonical: false,
    codeSha,
    activationReceiptCommentId,
    activationReceiptMainSha,
    activationBindingDigest,
    policyDigest: contract.policyDigest,
    cohortDigest: contract.cohortDigest,
    slotIndex: authority.slotIndex ?? null,
    split: authority.split ?? null,
    nominalScheduledAtMs: authority.slot?.nominalScheduledAtMs ?? null,
    allowedStartThroughMs: authority.slot?.allowedStartThroughMs ?? null,
    triggerMinuteUtc: authority.triggerMinuteUtc ?? null,
    triggerAttemptIndex: authority.attemptIndex ?? null,
    triggerAtMs: authority.triggerAtMs ?? null,
    serverStartedAtMs: nowMs,
    triggerLagMs: authority.triggerLagMs ?? null,
    ntpSynchronized,
    sampleClass: CALIBRATION_RESEARCH_SAMPLE,
    rawBatchDigest: null,
    blockers: [],
    ...safety(),
  };
}

async function persistAttempt({
  stateRoot,
  authority,
  receipt,
  rawBatch = null,
}) {
  const slotPart = Number.isInteger(authority.slotIndex)
    ? `slot-${String(authority.slotIndex).padStart(4, '0')}`
    : 'slot-unbound';
  const slotRoot = resolve(stateRoot, 'slots', slotPart);
  await mkdir(slotRoot, { recursive: true, mode: 0o700 });
  const attemptName = [
    String(receipt.serverStartedAtMs),
    receipt.triggerMinuteUtc == null ? 'na' : String(receipt.triggerMinuteUtc).padStart(2, '0'),
    receipt.captureStatus.toLowerCase().replace(/[^a-z0-9-]/gu, '-'),
  ].join('-');
  const attemptRoot = join(slotRoot, attemptName);
  await mkdir(attemptRoot, { recursive: false, mode: 0o700 });
  if (rawBatch !== null) {
    await writeCreateOnly(join(attemptRoot, 'raw-batch.json'), rawBatch);
  }
  await writeCreateOnly(join(attemptRoot, 'shadow-receipt.json'), receipt);
  return Object.freeze({ slotRoot, attemptRoot });
}

export async function runServerEvidenceShadowTick({
  nowMs = Date.now(),
  stateRoot,
  codeSha,
  activationReceiptCommentId,
  activationReceiptMainSha,
  activationBindingDigest,
  shadowOnly = true,
  serverCanonical = false,
  ntpSynchronized,
  collector = collectBitgetForwardLiquidityObservationBatch,
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} = {}) {
  if (!bool(shadowOnly) || bool(serverCanonical)) {
    throw new Error('SERVER_EVIDENCE_CANONICAL_CUTOVER_NOT_AUTHORIZED');
  }
  const deployedSha = exactSha(codeSha, 'SERVER_EVIDENCE_CODE_SHA_INVALID');
  const receiptMainSha = exactSha(
    activationReceiptMainSha,
    'SERVER_EVIDENCE_RECEIPT_MAIN_SHA_INVALID',
  );
  if (deployedSha !== receiptMainSha) {
    throw new Error('SERVER_EVIDENCE_RECEIPT_STALE_FOR_DEPLOYED_SHA');
  }
  const receiptCommentId = positiveInteger(
    activationReceiptCommentId,
    'SERVER_EVIDENCE_ACTIVATION_RECEIPT_COMMENT_ID_INVALID',
  );
  const bindingDigest = exactDigest(
    activationBindingDigest,
    'SERVER_EVIDENCE_ACTIVATION_BINDING_DIGEST_INVALID',
  );
  if (ntpSynchronized !== true) {
    throw new Error('SERVER_EVIDENCE_NTP_NOT_SYNCHRONIZED');
  }
  const root = resolve(
    String(stateRoot ?? '').trim() || '/var/lib/stock-app-server-evidence-shadow-v1',
  );
  const authority = resolveServerEvidenceShadowSlot({ nowMs, contract });

  if (!authority.eligible) {
    const receipt = receiptWithDigest({
      ...receiptBase({
        authority,
        codeSha: deployedSha,
        activationReceiptCommentId: receiptCommentId,
        activationReceiptMainSha: receiptMainSha,
        activationBindingDigest: bindingDigest,
        nowMs,
        ntpSynchronized,
        contract,
      }),
      captureStatus: 'NO_CAPTURE_SHADOW',
      blockers: [authority.blocker],
    });
    const persisted = await persistAttempt({
      stateRoot: root,
      authority,
      receipt,
    });
    return Object.freeze({ receipt, rawBatch: null, persisted });
  }

  const slotRoot = resolve(
    root,
    'slots',
    `slot-${String(authority.slotIndex).padStart(4, '0')}`,
  );
  if (await successfulShadowCaptureExists(slotRoot)) {
    const receipt = receiptWithDigest({
      ...receiptBase({
        authority,
        codeSha: deployedSha,
        activationReceiptCommentId: receiptCommentId,
        activationReceiptMainSha: receiptMainSha,
        activationBindingDigest: bindingDigest,
        nowMs,
        ntpSynchronized,
        contract,
      }),
      captureStatus: 'DUPLICATE_SHADOW_SLOT_NOOP',
      blockers: ['SERVER_EVIDENCE_SHADOW_SLOT_ALREADY_CAPTURED'],
    });
    const persisted = await persistAttempt({
      stateRoot: root,
      authority,
      receipt,
    });
    return Object.freeze({ receipt, rawBatch: null, persisted });
  }

  try {
    const rawBatch = await collector({
      symbol: 'BTCUSDT',
      collectorCodeSha: deployedSha,
      sampleClass: CALIBRATION_RESEARCH_SAMPLE,
    });
    const rawBatchDigest = sha256(canonicalJson(rawBatch));
    const receipt = receiptWithDigest({
      ...receiptBase({
        authority,
        codeSha: deployedSha,
        activationReceiptCommentId: receiptCommentId,
        activationReceiptMainSha: receiptMainSha,
        activationBindingDigest: bindingDigest,
        nowMs,
        ntpSynchronized,
        contract,
      }),
      captureStatus: 'PRESENT_SHADOW',
      rawBatchDigest,
      blockers: [],
    });
    const persisted = await persistAttempt({
      stateRoot: root,
      authority,
      receipt,
      rawBatch,
    });
    return Object.freeze({ receipt, rawBatch, persisted });
  } catch (error) {
    const blocker = `SERVER_EVIDENCE_PUBLIC_CAPTURE_FAILED:${safeErrorCode(error)}`;
    const receipt = receiptWithDigest({
      ...receiptBase({
        authority,
        codeSha: deployedSha,
        activationReceiptCommentId: receiptCommentId,
        activationReceiptMainSha: receiptMainSha,
        activationBindingDigest: bindingDigest,
        nowMs,
        ntpSynchronized,
        contract,
      }),
      captureStatus: 'CAPTURE_FAILED_SHADOW',
      blockers: [blocker],
    });
    const persisted = await persistAttempt({
      stateRoot: root,
      authority,
      receipt,
    });
    return Object.freeze({ receipt, rawBatch: null, persisted });
  }
}

function canonicalLineage(receipt) {
  return {
    slotIndex: receipt?.slotIndex ?? null,
    split: receipt?.split ?? null,
    policyDigest:
      receipt?.policyDigest
      ?? receipt?.sourceV3Lineage?.policyDigest
      ?? null,
    cohortDigest:
      receipt?.cohortDigest
      ?? receipt?.sourceV3Lineage?.cohortDigest
      ?? null,
    rawBatchDigest: receipt?.rawBatchDigest ?? null,
  };
}

export function buildServerEvidenceShadowEquivalenceReport({
  shadowReceipt,
  canonicalReceipt,
} = {}) {
  if (!shadowReceipt || shadowReceipt.schemaVersion !== SERVER_EVIDENCE_SHADOW_SCHEMA) {
    throw new Error('SERVER_EVIDENCE_SHADOW_RECEIPT_INVALID');
  }
  if (!canonicalReceipt || typeof canonicalReceipt !== 'object') {
    throw new Error('SERVER_EVIDENCE_CANONICAL_RECEIPT_INVALID');
  }
  const shadow = canonicalLineage(shadowReceipt);
  const canonical = canonicalLineage(canonicalReceipt);
  const identityChecks = Object.freeze({
    slotIndex: canonical.slotIndex != null && shadow.slotIndex === canonical.slotIndex,
    split: canonical.split != null && shadow.split === canonical.split,
    policyDigest:
      canonical.policyDigest != null && shadow.policyDigest === canonical.policyDigest,
    cohortDigest:
      canonical.cohortDigest != null && shadow.cohortDigest === canonical.cohortDigest,
  });
  const identityMatch = Object.values(identityChecks).every(Boolean);
  return Object.freeze({
    schemaVersion: 'public-forward-liquidity-server-shadow-equivalence-v1',
    identityChecks,
    identityMatch,
    rawDigestComparable:
      typeof shadow.rawBatchDigest === 'string'
      && typeof canonical.rawBatchDigest === 'string',
    rawDigestEqual:
      typeof shadow.rawBatchDigest === 'string'
      && typeof canonical.rawBatchDigest === 'string'
      && shadow.rawBatchDigest === canonical.rawBatchDigest,
    economicCreditGranted: 0,
    canonicalCutoverReady: false,
    note:
      'Raw public snapshots are time-specific; rawDigestEqual is evidence only and is not required for slot/policy identity equivalence.',
  });
}

export async function summarizeServerEvidenceShadowState({
  stateRoot,
} = {}) {
  const root = resolve(
    String(stateRoot ?? '').trim() || '/var/lib/stock-app-server-evidence-shadow-v1',
  );
  const slotsRoot = join(root, 'slots');
  let slots = [];
  try {
    slots = await readdir(slotsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({
        schemaVersion: 'public-forward-liquidity-server-shadow-state-summary-v1',
        capturedSlotN: 0,
        attemptN: 0,
        latestReceipt: null,
        ...safety(),
      });
    }
    throw error;
  }

  let capturedSlotN = 0;
  let attemptN = 0;
  let latestReceipt = null;
  for (const slot of slots) {
    if (!slot.isDirectory()) continue;
    const slotRoot = join(slotsRoot, slot.name);
    const attempts = await readdir(slotRoot, { withFileTypes: true });
    let slotCaptured = false;
    for (const attempt of attempts) {
      if (!attempt.isDirectory()) continue;
      const receipt = await readReceipt(join(slotRoot, attempt.name, 'shadow-receipt.json'));
      if (!receipt) continue;
      attemptN += 1;
      if (receipt.captureStatus === 'PRESENT_SHADOW') slotCaptured = true;
      if (!latestReceipt
        || Number(receipt.serverStartedAtMs) > Number(latestReceipt.serverStartedAtMs)) {
        latestReceipt = receipt;
      }
    }
    if (slotCaptured) capturedSlotN += 1;
  }

  return Object.freeze({
    schemaVersion: 'public-forward-liquidity-server-shadow-state-summary-v1',
    capturedSlotN,
    attemptN,
    latestReceipt,
    ...safety(),
  });
}

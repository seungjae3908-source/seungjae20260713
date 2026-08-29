import { createHash } from 'node:crypto';

export const V3_POLICY_HEAD = '43b15ea7cb4edfc84ce7e3055e6b8d7e5443c0f6';
export const V3_POLICY_ARTIFACT_ID = '9722465890';
export const V3_POLICY_ARTIFACT_ZIP_DIGEST = '476b302eb38d8b17c30d4f3ed0d97f87fd16118d5b201cc03d9aff4b26b8eb7a';
export const V3_POLICY_INTERNAL_ARTIFACT_DIGEST = '6cd95ffb7bf23bab34d53ff7d0b2eb6c2fc3b58dcf9a36cad9ef883a68c02009';
export const V3_POLICY_DIGEST = '547bcd9fde985a7920f27c88e5e24f082c1dede18ef35a9ebdaa34edc056589b';
export const V3_COHORT_ID = 'PUBLIC_FORWARD_LIQUIDITY_NEW_PROSPECTIVE_COHORT_V3:43b15ea7cb4edfc84ce7e3055e6b8d7e5443c0f6';
export const V3_COHORT_DIGEST = 'a1f176c286e40b3ca4182167c9357e57b39a7c40540b81ff6e206402f67dff9c';
export const V3_CAPTURE_SELECTION_POLICY_DIGEST = 'ab1ce473bb60ae4231f05f00358d67a0c5e927ec797722962ce9c02d02bf2fe4';
export const V3_COHORT_ELIGIBLE_AFTER_MS = 1_788_129_740_000;
export const V3_COHORT_END_EXCLUSIVE_MS = 1_788_216_140_000;
export const V3_SLOT_INTERVAL_MS = 1_800_000;
export const SCHEDULE_TRIGGER_SOURCE = 'GITHUB_ACTIONS_SCHEDULED_CANONICAL_PUBLIC_CAPTURE';
export const MANUAL_TRIGGER_SOURCE = 'MANUAL_WORKFLOW_DISPATCH';
export const CRON_UTC = '13,43 * * * *';
export const FIRST_NOMINAL_SCHEDULED_AT_MS = Math.ceil(V3_COHORT_ELIGIBLE_AFTER_MS / 60_000) * 60_000;
export const SLOT_EXECUTION_OFFSET_MS = FIRST_NOMINAL_SCHEDULED_AT_MS - V3_COHORT_ELIGIBLE_AFTER_MS;
export const SLOT_EXECUTION_RULE = 'ceil(cohortEligibleAfterMs/60000)*60000 + slotIndex*slotIntervalMs';

export const CAPTURE_PARAMETER_POLICY = Object.freeze({
  schemaVersion: 'public-forward-liquidity-capture-parameter-policy-v1',
  authority: 'EXISTING_CANONICAL_COLLECTOR_DEFAULTS',
  collectorImplementationBlobSha: '8044d5cb136eb30a531608392c73a45be601e5ba',
  eventObservationDelayMs: 2_000,
  postObservationDelaysMs: Object.freeze([1_000, 5_000]),
  maxPreEventBookAgeMs: 5_000,
  publicDataSource: 'BITGET_PUBLIC_UTA_V3',
  market: 'CRYPTO_FUTURES',
  symbol: 'BTCUSDT',
  observedFutureDataUsedToChooseValues: false,
});

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash('sha256').update(input).digest('hex');
}

export const CAPTURE_PARAMETER_POLICY_DIGEST = sha256(canonicalJson(CAPTURE_PARAMETER_POLICY));

function assertSha(value, code) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function assertDigest(value, code) {
  const normalized = String(value ?? '').trim().replace(/^sha256:/u, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function assertInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(code);
  return parsed;
}

export function verifyV3ArtifactBinding(artifact) {
  const blockers = [];
  if (artifact?.schemaVersion !== 'public-forward-liquidity-prospective-policy-artifact-v3') blockers.push('V3_SCHEMA_MISMATCH');
  if (artifact?.exactPolicyHeadSha !== V3_POLICY_HEAD) blockers.push('V3_POLICY_HEAD_MISMATCH');
  if (artifact?.policy?.policyVersion !== '3') blockers.push('V3_POLICY_VERSION_MISMATCH');
  if (artifact?.policy?.policyDigest !== V3_POLICY_DIGEST) blockers.push('V3_POLICY_DIGEST_MISMATCH');
  if (artifact?.artifactDigest !== V3_POLICY_INTERNAL_ARTIFACT_DIGEST) blockers.push('V3_INTERNAL_ARTIFACT_DIGEST_MISMATCH');
  if (artifact?.cohort?.cohortIdentity !== V3_COHORT_ID) blockers.push('V3_COHORT_ID_MISMATCH');
  if (artifact?.cohort?.cohortDigest !== V3_COHORT_DIGEST) blockers.push('V3_COHORT_DIGEST_MISMATCH');
  if (artifact?.cohort?.cohortEligibleAfterMs !== V3_COHORT_ELIGIBLE_AFTER_MS) blockers.push('V3_COHORT_ELIGIBILITY_MISMATCH');
  if (artifact?.cohort?.cohortEndExclusiveMs !== V3_COHORT_END_EXCLUSIVE_MS) blockers.push('V3_COHORT_END_MISMATCH');
  if (artifact?.captureSelectionPolicy?.captureSelectionPolicyDigest !== V3_CAPTURE_SELECTION_POLICY_DIGEST) blockers.push('V3_CAPTURE_POLICY_DIGEST_MISMATCH');
  if (artifact?.captureSelectionPolicy?.triggerType !== SCHEDULE_TRIGGER_SOURCE) blockers.push('V3_TRIGGER_AUTHORITY_MISMATCH');
  if (artifact?.captureSelectionPolicy?.slotIntervalMs !== V3_SLOT_INTERVAL_MS) blockers.push('V3_SLOT_INTERVAL_MISMATCH');
  if (artifact?.captureSelectionPolicy?.manualDispatchCredit !== 0) blockers.push('V3_MANUAL_CREDIT_NOT_ZERO');
  if (artifact?.captureSelectionPolicy?.replaySlotCredit !== 0) blockers.push('V3_REPLAY_CREDIT_NOT_ZERO');
  if (artifact?.captureSelectionPolicy?.backfillSlotCredit !== 0) blockers.push('V3_BACKFILL_CREDIT_NOT_ZERO');
  if (artifact?.captureSelectionPolicy?.operatorSelectedDispatchCredit !== 0) blockers.push('V3_OPERATOR_SELECTED_CREDIT_NOT_ZERO');
  if (artifact?.captureSelectionPolicy?.exactlyOneCanonicalCaptureAttemptPerSlot !== true) blockers.push('V3_EXACTLY_ONE_ATTEMPT_DISABLED');
  if (artifact?.captureSelectionPolicy?.completeWindowAttemptLogRequired !== true) blockers.push('V3_COMPLETENESS_LOG_DISABLED');
  if (artifact?.safety?.executionAuthority !== 'NONE'
    || artifact?.safety?.privateApiUsed !== false
    || artifact?.safety?.liveTrading !== false
    || artifact?.safety?.orderSubmitted !== false) blockers.push('V3_SAFETY_BOUNDARY_INVALID');
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(blockers) });
}

export function slotDescriptor(slotIndex) {
  const index = assertInteger(slotIndex, 'SLOT_INDEX_INVALID');
  if (index < 0 || index >= 48) throw new Error('SLOT_INDEX_OUT_OF_RANGE');
  const slotStartMs = V3_COHORT_ELIGIBLE_AFTER_MS + (index * V3_SLOT_INTERVAL_MS);
  const slotEndMs = slotStartMs + V3_SLOT_INTERVAL_MS;
  const nominalScheduledAtMs = FIRST_NOMINAL_SCHEDULED_AT_MS + (index * V3_SLOT_INTERVAL_MS);
  if (!(slotStartMs <= nominalScheduledAtMs && nominalScheduledAtMs < slotEndMs)) throw new Error('NOMINAL_SCHEDULE_OUTSIDE_SLOT');
  const split = index < 24 ? 'TRAIN' : index < 36 ? 'VALIDATION' : 'OOS';
  const canonicalSlotKey = sha256(canonicalJson({
    policyDigest: V3_POLICY_DIGEST,
    cohortDigest: V3_COHORT_DIGEST,
    slotIndex: index,
  }));
  return Object.freeze({ slotIndex: index, split, slotStartMs, slotEndMs, nominalScheduledAtMs, canonicalSlotKey });
}

export function slotIndexForTimestamp(timestampMs) {
  const timestamp = assertInteger(timestampMs, 'SLOT_TIMESTAMP_INVALID');
  if (timestamp < V3_COHORT_ELIGIBLE_AFTER_MS || timestamp >= V3_COHORT_END_EXCLUSIVE_MS) return null;
  return Math.floor((timestamp - V3_COHORT_ELIGIBLE_AFTER_MS) / V3_SLOT_INTERVAL_MS);
}

export function resolveScheduledAttempt({
  runCreatedAtMs,
  actualRunStartedAtMs,
  runAttempt = 1,
  priorScheduleRuns = [],
  scheduleExpression = CRON_UTC,
}) {
  const createdAtMs = assertInteger(runCreatedAtMs, 'RUN_CREATED_AT_INVALID');
  const startedAtMs = assertInteger(actualRunStartedAtMs, 'RUN_STARTED_AT_INVALID');
  const attempt = assertInteger(runAttempt, 'RUN_ATTEMPT_INVALID');
  if (scheduleExpression !== CRON_UTC) {
    return Object.freeze({ eligible: false, status: 'WRONG_SCHEDULE_EXPRESSION', prospectiveSlotCredit: 0 });
  }
  const createdSlotIndex = slotIndexForTimestamp(createdAtMs);
  if (createdSlotIndex == null) {
    return Object.freeze({
      eligible: false,
      status: createdAtMs < V3_COHORT_ELIGIBLE_AFTER_MS ? 'PRE_ELIGIBILITY' : 'OUTSIDE_COHORT_WINDOW',
      prospectiveSlotCredit: 0,
    });
  }
  const slot = slotDescriptor(createdSlotIndex);
  if (createdAtMs < slot.nominalScheduledAtMs) {
    return Object.freeze({ ...slot, eligible: false, status: 'PRE_NOMINAL_SCHEDULE_EVENT', prospectiveSlotCredit: 0 });
  }
  if (!(slot.slotStartMs <= startedAtMs && startedAtMs < slot.slotEndMs)) {
    return Object.freeze({ ...slot, eligible: false, status: 'MISSED_SLOT', prospectiveSlotCredit: 0 });
  }
  if (attempt !== 1) {
    return Object.freeze({ ...slot, eligible: false, status: 'DIAGNOSTIC_ONLY_RERUN', prospectiveSlotCredit: 0 });
  }
  const duplicate = priorScheduleRuns.some((run) => {
    const priorCreatedAtMs = Number(run?.createdAtMs);
    if (!Number.isInteger(priorCreatedAtMs)) return false;
    return Number(run?.runAttempt ?? 1) === 1 && slotIndexForTimestamp(priorCreatedAtMs) === createdSlotIndex;
  });
  if (duplicate) {
    return Object.freeze({ ...slot, eligible: false, status: 'DIAGNOSTIC_ONLY_DUPLICATE_SLOT', prospectiveSlotCredit: 0 });
  }
  return Object.freeze({ ...slot, eligible: true, status: 'ELIGIBLE_SCHEDULED_ATTEMPT', prospectiveSlotCredit: 1 });
}

export function validateScheduledCaptureBatch(batch, { exactMainSha, symbol = 'BTCUSDT' } = {}) {
  const blockers = [];
  let expectedSha;
  try { expectedSha = assertSha(exactMainSha, 'EXACT_MAIN_SHA_INVALID'); } catch (error) { blockers.push(error.message); }
  const normalizedSymbol = String(symbol ?? '').trim().toUpperCase();
  if (normalizedSymbol !== 'BTCUSDT') blockers.push('WRONG_SYMBOL');
  if (batch?.kind !== 'public-forward-liquidity-calibration-batch') blockers.push('CAPTURE_BATCH_KIND_INVALID');
  if (batch?.sampleClass !== 'FORWARD_NATURAL_SAMPLE') blockers.push('CAPTURE_SAMPLE_CLASS_INVALID');
  if (batch?.datasetProvenance?.rawSource?.provider !== 'BITGET_PUBLIC_UTA_V3') blockers.push('PRIVATE_OR_WRONG_PROVIDER');
  if (batch?.datasetProvenance?.rawSource?.privateApiUsed !== false) blockers.push('PRIVATE_API_USED');
  if (expectedSha && batch?.datasetProvenance?.collectorCodeSha !== expectedSha) blockers.push('COLLECTOR_SHA_MISMATCH');
  if (batch?.safety?.executionAuthority !== 'NONE'
    || batch?.safety?.privateTradingApiAllowed !== false
    || batch?.safety?.liveTradingAllowed !== false
    || batch?.safety?.realOrderAllowed !== false
    || batch?.safety?.financialMutationAllowed !== false) blockers.push('CAPTURE_SAFETY_INVALID');
  for (const observation of batch?.observations ?? []) {
    if (observation?.symbol !== normalizedSymbol) blockers.push('WRONG_SYMBOL');
    if (observation?.market !== 'CRYPTO_FUTURES') blockers.push('WRONG_MARKET');
    if (observation?.publicDataSource !== 'BITGET_PUBLIC_UTA_V3') blockers.push('PRIVATE_OR_WRONG_PROVIDER');
    if (expectedSha && observation?.collectorCodeSha !== expectedSha) blockers.push('OBSERVATION_COLLECTOR_SHA_MISMATCH');
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]) });
}

export function buildAttemptReceipt({
  triggerSource,
  runId,
  runAttempt,
  exactMainSha,
  collectorCodeSha,
  actualRunStartedAtMs,
  runCreatedAtMs,
  scheduleResolution = null,
  captureStatus,
  rawBatchDigest = null,
  prospectiveObservationCount = 0,
  droppedObservationCount = 0,
  blockers = [],
}) {
  const normalizedTrigger = String(triggerSource ?? '').trim();
  const scheduled = normalizedTrigger === SCHEDULE_TRIGGER_SOURCE;
  const manual = normalizedTrigger === MANUAL_TRIGGER_SOURCE;
  if (!scheduled && !manual) throw new Error('TRIGGER_SOURCE_INVALID');
  const mainSha = assertSha(exactMainSha, 'EXACT_MAIN_SHA_INVALID');
  const collectorSha = assertSha(collectorCodeSha, 'COLLECTOR_CODE_SHA_INVALID');
  const status = String(captureStatus ?? '').trim().toUpperCase();
  const allowedStatuses = new Set(['PRESENT', 'BLOCKED_DATA', 'PROVIDER_FAILURE', 'VALIDATION_FAILURE', 'DIAGNOSTIC_ONLY', 'MISSED_SLOT', 'PRE_ELIGIBILITY']);
  if (!allowedStatuses.has(status)) throw new Error('CAPTURE_STATUS_INVALID');
  const slotCredit = scheduled && scheduleResolution?.eligible === true ? 1 : 0;
  const captureCredit = slotCredit === 1 && status === 'PRESENT' ? 1 : 0;
  const body = {
    schemaVersion: 'public-forward-liquidity-v3-scheduled-attempt-receipt-v1',
    evidenceClass: 'PUBLIC_FORWARD_LIQUIDITY_SCHEDULED_CAPTURE_ATTEMPT',
    policyVersion: '3',
    policyDigest: V3_POLICY_DIGEST,
    policyArtifactId: V3_POLICY_ARTIFACT_ID,
    policyArtifactDigest: V3_POLICY_ARTIFACT_ZIP_DIGEST,
    policyInternalArtifactDigest: V3_POLICY_INTERNAL_ARTIFACT_DIGEST,
    cohortId: V3_COHORT_ID,
    cohortDigest: V3_COHORT_DIGEST,
    cohortEligibleAfterMs: V3_COHORT_ELIGIBLE_AFTER_MS,
    captureSelectionPolicyDigest: V3_CAPTURE_SELECTION_POLICY_DIGEST,
    captureParameterPolicyDigest: CAPTURE_PARAMETER_POLICY_DIGEST,
    slotIntervalMs: V3_SLOT_INTERVAL_MS,
    slotIndex: scheduled && Number.isInteger(scheduleResolution?.slotIndex) ? scheduleResolution.slotIndex : null,
    slotStartMs: scheduled ? scheduleResolution?.slotStartMs ?? null : null,
    slotEndMs: scheduled ? scheduleResolution?.slotEndMs ?? null : null,
    nominalScheduledAtMs: scheduled ? scheduleResolution?.nominalScheduledAtMs ?? null : null,
    actualRunStartedAtMs: assertInteger(actualRunStartedAtMs, 'RUN_STARTED_AT_INVALID'),
    runCreatedAtMs: assertInteger(runCreatedAtMs, 'RUN_CREATED_AT_INVALID'),
    exactMainSha: mainSha,
    collectorCodeSha: collectorSha,
    symbol: 'BTCUSDT',
    market: 'CRYPTO_FUTURES',
    triggerSource: normalizedTrigger,
    attemptAuthorityStatus: scheduled ? String(scheduleResolution?.status ?? 'UNRESOLVED') : 'MANUAL_ZERO_CREDIT',
    attempted: scheduled && slotCredit === 1,
    captureStatus: status,
    rawBatchDigest: rawBatchDigest == null ? null : assertDigest(rawBatchDigest, 'RAW_BATCH_DIGEST_INVALID'),
    prospectiveObservationCount: assertInteger(prospectiveObservationCount, 'PROSPECTIVE_COUNT_INVALID'),
    droppedObservationCount: assertInteger(droppedObservationCount, 'DROPPED_COUNT_INVALID'),
    blockers: Object.freeze([...blockers].map(String).sort()),
    runId: String(runId ?? ''),
    runAttempt: assertInteger(runAttempt, 'RUN_ATTEMPT_INVALID'),
    artifactId: null,
    artifactDigest: null,
    canonicalSlotKey: scheduled ? scheduleResolution?.canonicalSlotKey ?? null : null,
    canonicalAttemptCredit: slotCredit,
    prospectiveCaptureCredit: captureCredit,
    prospectiveSlotCredit: slotCredit,
    manualCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    operatorSelectedCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  return Object.freeze({ ...body, receiptDigest: sha256(canonicalJson(body)) });
}

export function bindAttemptReceiptArtifact(receipt, { artifactId, artifactDigest, artifactName }) {
  const id = String(artifactId ?? '').trim();
  if (!/^[0-9]+$/u.test(id)) throw new Error('ARTIFACT_ID_INVALID');
  const digest = assertDigest(artifactDigest, 'ARTIFACT_DIGEST_INVALID');
  const body = {
    ...receipt,
    artifactId: id,
    artifactDigest: digest,
    artifactName: String(artifactName ?? ''),
  };
  delete body.receiptDigest;
  return Object.freeze({ ...body, receiptDigest: sha256(canonicalJson(body)) });
}

function splitSlotIndexes(split) {
  if (split === 'TRAIN') return { start: 0, count: 24 };
  if (split === 'VALIDATION') return { start: 24, count: 12 };
  if (split === 'OOS') return { start: 36, count: 12 };
  throw new Error('SPLIT_INVALID');
}

export function buildCompleteWindowAttemptLog(receipts = [], { asOfMs = Date.now() } = {}) {
  const now = assertInteger(asOfMs, 'AS_OF_INVALID');
  const rows = {};
  for (const split of ['TRAIN', 'VALIDATION', 'OOS']) {
    const { start, count } = splitSlotIndexes(split);
    const eligibleSlots = Array.from({ length: count }, (_, index) => start + index)
      .filter((slotIndex) => slotDescriptor(slotIndex).slotEndMs <= now);
    const firstAttempts = new Map();
    const duplicateAttempts = new Map();
    for (const receipt of receipts) {
      const index = Number(receipt?.slotIndex);
      if (!eligibleSlots.includes(index)) continue;
      if (receipt?.triggerSource !== SCHEDULE_TRIGGER_SOURCE) continue;
      if (receipt?.canonicalAttemptCredit === 1 && !firstAttempts.has(index)) firstAttempts.set(index, receipt);
      else duplicateAttempts.set(index, (duplicateAttempts.get(index) ?? 0) + 1);
    }
    const attemptedSlotN = firstAttempts.size;
    const validCaptureSlotN = [...firstAttempts.values()].filter((receipt) => receipt.captureStatus === 'PRESENT').length;
    const blockedDataSlotN = [...firstAttempts.values()].filter((receipt) => receipt.captureStatus === 'BLOCKED_DATA').length;
    rows[split] = Object.freeze({
      policyExpectedSlotN: count,
      expectedSlotN: eligibleSlots.length,
      attemptedSlotN,
      missingSlotN: Math.max(0, eligibleSlots.length - attemptedSlotN),
      duplicateSlotAttemptN: [...duplicateAttempts.values()].reduce((sum, value) => sum + value, 0),
      validCaptureSlotN,
      blockedDataSlotN,
      complete: eligibleSlots.length === count && attemptedSlotN === count && duplicateAttempts.size === 0,
    });
  }
  return Object.freeze({
    schemaVersion: 'public-forward-liquidity-v3-complete-window-attempt-log-v1',
    asOfMs: now,
    policyDigest: V3_POLICY_DIGEST,
    cohortDigest: V3_COHORT_DIGEST,
    splits: Object.freeze(rows),
    complete: rows.TRAIN.complete && rows.VALIDATION.complete && rows.OOS.complete,
  });
}

export function markAttemptReceiptValidationFailure(receipt, blocker) {
  const body = {
    ...receipt,
    captureStatus: 'VALIDATION_FAILURE',
    prospectiveCaptureCredit: 0,
    blockers: Object.freeze([...new Set([...(receipt?.blockers ?? []), String(blocker)])].sort()),
  };
  delete body.receiptDigest;
  return Object.freeze({ ...body, receiptDigest: sha256(canonicalJson(body)) });
}

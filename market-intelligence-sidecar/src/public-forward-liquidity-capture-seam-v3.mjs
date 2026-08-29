import {
  canonicalJson,
  collectBitgetForwardLiquidityObservationBatch,
  sha256,
} from './public-forward-liquidity-calibration.mjs';

export const V3_POLICY_BINDING = Object.freeze({
  policyVersion: '3',
  policyHeadSha: '43b15ea7cb4edfc84ce7e3055e6b8d7e5443c0f6',
  policyArtifactId: '9722465890',
  policyArtifactDigest: '476b302eb38d8b17c30d4f3ed0d97f87fd16118d5b201cc03d9aff4b26b8eb7a',
  policyInternalArtifactDigest: '6cd95ffb7bf23bab34d53ff7d0b2eb6c2fc3b58dcf9a36cad9ef883a68c02009',
  policyDigest: '547bcd9fde985a7920f27c88e5e24f082c1dede18ef35a9ebdaa34edc056589b',
  captureSelectionPolicyDigest: 'ab1ce473bb60ae4231f05f00358d67a0c5e927ec797722962ce9c02d02bf2fe4',
  cohortId: 'PUBLIC_FORWARD_LIQUIDITY_NEW_PROSPECTIVE_COHORT_V3:43b15ea7cb4edfc84ce7e3055e6b8d7e5443c0f6',
  cohortDigest: 'a1f176c286e40b3ca4182167c9357e57b39a7c40540b81ff6e206402f67dff9c',
  cohortEligibleAfterMs: 1_788_129_740_000,
  cohortEndExclusiveMs: 1_788_216_140_000,
  slotIntervalMs: 1_800_000,
  slotCounts: Object.freeze({ TRAIN: 24, VALIDATION: 12, OOS: 12 }),
  market: 'CRYPTO_FUTURES',
  symbol: 'BTCUSDT',
});

export const CAPTURE_PARAMETER_POLICY = Object.freeze({
  schemaVersion: 'public-forward-liquidity-capture-parameter-policy-v1',
  authority: 'MERGED_CANONICAL_COLLECTOR_DEFAULTS',
  collectorImplementationBlobSha: '8044d5cb136eb30a531608392c73a45be601e5ba',
  eventObservationDelayMs: 2_000,
  postObservationDelaysMs: Object.freeze([1_000, 5_000]),
  maxPreEventBookAgeMs: 5_000,
  outcomeInspectionUsed: false,
});

export const CAPTURE_PARAMETER_POLICY_DIGEST = sha256(canonicalJson(CAPTURE_PARAMETER_POLICY));
export const SLOT_EXECUTION_RULE = 'FIRST_WHOLE_MINUTE_STRICTLY_AT_OR_AFTER_COHORT_ELIGIBLE_THEN_EXACT_30_MINUTE_SEQUENCE';
export const FIRST_NOMINAL_SCHEDULED_AT_MS = Math.ceil(V3_POLICY_BINDING.cohortEligibleAfterMs / 60_000) * 60_000;
export const SLOT_EXECUTION_OFFSET_MS = FIRST_NOMINAL_SCHEDULED_AT_MS - V3_POLICY_BINDING.cohortEligibleAfterMs;
export const SCHEDULED_TRIGGER_SOURCE = 'GITHUB_ACTIONS_SCHEDULED_CANONICAL_PUBLIC_CAPTURE';
export const MANUAL_TRIGGER_SOURCE = 'MANUAL_WORKFLOW_DISPATCH';

function exactSha(value, code = 'EXACT_SHA_INVALID') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function exactDigest(value, code = 'SHA256_DIGEST_INVALID') {
  const normalized = String(value ?? '').trim().replace(/^sha256:/u, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function positiveInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

export function splitForSlotIndex(slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 48) throw new Error('V3_SLOT_INDEX_INVALID');
  if (slotIndex < 24) return 'TRAIN';
  if (slotIndex < 36) return 'VALIDATION';
  return 'OOS';
}

export function buildV3SlotDescriptor(slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 48) throw new Error('V3_SLOT_INDEX_INVALID');
  const slotStartMs = V3_POLICY_BINDING.cohortEligibleAfterMs + (slotIndex * V3_POLICY_BINDING.slotIntervalMs);
  const slotEndMs = slotStartMs + V3_POLICY_BINDING.slotIntervalMs;
  const nominalScheduledAtMs = FIRST_NOMINAL_SCHEDULED_AT_MS + (slotIndex * V3_POLICY_BINDING.slotIntervalMs);
  if (!(slotStartMs <= nominalScheduledAtMs && nominalScheduledAtMs < slotEndMs)) {
    throw new Error('V3_NOMINAL_OUTSIDE_SLOT');
  }
  const utc = new Date(nominalScheduledAtMs);
  const cronUtc = `${utc.getUTCMinutes()} ${utc.getUTCHours()} ${utc.getUTCDate()} ${utc.getUTCMonth() + 1} *`;
  const canonicalSlotKey = Object.freeze({
    policyDigest: V3_POLICY_BINDING.policyDigest,
    cohortDigest: V3_POLICY_BINDING.cohortDigest,
    slotIndex,
  });
  const canonicalSlotKeyDigest = sha256(canonicalJson(canonicalSlotKey));
  return Object.freeze({
    slotIndex,
    split: splitForSlotIndex(slotIndex),
    slotStartMs,
    slotEndMs,
    nominalScheduledAtMs,
    cronUtc,
    canonicalSlotKey,
    canonicalSlotKeyDigest,
  });
}

export function buildV3ScheduleEntries() {
  return Object.freeze(Array.from({ length: 48 }, (_, slotIndex) => buildV3SlotDescriptor(slotIndex)));
}

const SCHEDULE_BY_CRON = new Map(buildV3ScheduleEntries().map((slot) => [slot.cronUtc, slot]));

export function resolveScheduledAuthority({
  scheduleExpression,
  actualRunStartedAtMs,
  runAttempt = 1,
  duplicateCanonicalArtifact = false,
} = {}) {
  const slot = SCHEDULE_BY_CRON.get(String(scheduleExpression ?? '').trim());
  if (!slot) {
    return Object.freeze({
      eligible: false,
      attempted: false,
      collectorInvoked: false,
      captureStatus: 'WRONG_SCHEDULE_EXPRESSION',
      blocker: 'SCHEDULE_EXPRESSION_NOT_BOUND_TO_V3_SLOT',
      prospectiveSlotCredit: 0,
      slot: null,
    });
  }
  const actual = positiveInteger(actualRunStartedAtMs, 'ACTUAL_RUN_STARTED_AT_MS_INVALID');
  const attempt = positiveInteger(runAttempt, 'RUN_ATTEMPT_INVALID');
  if (actual < V3_POLICY_BINDING.cohortEligibleAfterMs || actual < slot.nominalScheduledAtMs) {
    return Object.freeze({
      eligible: false,
      attempted: true,
      collectorInvoked: false,
      captureStatus: 'PRE_ELIGIBILITY_ATTEMPT',
      blocker: 'SCHEDULED_ATTEMPT_BEFORE_NOMINAL_SLOT_TIME',
      prospectiveSlotCredit: 0,
      slot,
    });
  }
  if (actual >= slot.slotEndMs) {
    return Object.freeze({
      eligible: false,
      attempted: true,
      collectorInvoked: false,
      captureStatus: 'MISSED_SLOT',
      blocker: 'ACTUAL_RUN_STARTED_OUTSIDE_BOUND_SLOT',
      prospectiveSlotCredit: 0,
      slot,
    });
  }
  if (attempt !== 1 || duplicateCanonicalArtifact === true) {
    return Object.freeze({
      eligible: false,
      attempted: true,
      collectorInvoked: false,
      captureStatus: 'DIAGNOSTIC_ONLY',
      blocker: attempt !== 1 ? 'RERUN_ZERO_CREDIT' : 'DUPLICATE_SLOT_ATTEMPT_ZERO_CREDIT',
      prospectiveSlotCredit: 0,
      slot,
    });
  }
  return Object.freeze({
    eligible: true,
    attempted: true,
    collectorInvoked: true,
    captureStatus: 'ELIGIBLE_TO_CAPTURE',
    blocker: null,
    prospectiveSlotCredit: 1,
    slot,
  });
}

export function verifyV3PolicyBinding(binding = V3_POLICY_BINDING) {
  const blockers = [];
  const pairs = [
    ['policyVersion', V3_POLICY_BINDING.policyVersion],
    ['policyHeadSha', V3_POLICY_BINDING.policyHeadSha],
    ['policyArtifactId', V3_POLICY_BINDING.policyArtifactId],
    ['policyArtifactDigest', V3_POLICY_BINDING.policyArtifactDigest],
    ['policyInternalArtifactDigest', V3_POLICY_BINDING.policyInternalArtifactDigest],
    ['policyDigest', V3_POLICY_BINDING.policyDigest],
    ['captureSelectionPolicyDigest', V3_POLICY_BINDING.captureSelectionPolicyDigest],
    ['cohortId', V3_POLICY_BINDING.cohortId],
    ['cohortDigest', V3_POLICY_BINDING.cohortDigest],
    ['cohortEligibleAfterMs', V3_POLICY_BINDING.cohortEligibleAfterMs],
    ['slotIntervalMs', V3_POLICY_BINDING.slotIntervalMs],
    ['market', V3_POLICY_BINDING.market],
    ['symbol', V3_POLICY_BINDING.symbol],
  ];
  for (const [key, expected] of pairs) {
    if (binding?.[key] !== expected) blockers.push(`V3_${key.toUpperCase()}_MISMATCH`);
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(blockers) });
}

function validateCapturedBatch(batch, { exactMainSha, symbol }) {
  if (batch?.kind !== 'public-forward-liquidity-calibration-batch') throw new Error('CAPTURE_BATCH_KIND_INVALID');
  if (batch?.sampleClass !== 'FORWARD_NATURAL_SAMPLE') throw new Error('CAPTURE_SAMPLE_CLASS_INVALID');
  if (batch?.capability?.PUBLIC_CALIBRATION_DATA_CAPABLE !== true) throw new Error('PUBLIC_CALIBRATION_DATA_CAPABLE_FALSE');
  if (batch?.datasetProvenance?.collectorCodeSha !== exactMainSha) throw new Error('COLLECTOR_SHA_MISMATCH');
  if (batch?.datasetProvenance?.rawSource?.provider !== 'BITGET_PUBLIC_UTA_V3') throw new Error('PUBLIC_PROVIDER_INVALID');
  if (batch?.datasetProvenance?.rawSource?.privateApiUsed !== false) throw new Error('PRIVATE_API_CLAIM_INVALID');
  if (batch?.safety?.publicDataOnly !== true
    || batch?.safety?.executionAuthority !== 'NONE'
    || batch?.safety?.privateTradingApiAllowed !== false
    || batch?.safety?.liveTradingAllowed !== false
    || batch?.safety?.realOrderAllowed !== false
    || batch?.safety?.financialMutationAllowed !== false) throw new Error('CAPTURE_SAFETY_INVALID');
  if (batch?.readiness?.LIQUIDITY_IMPACT_PRESENT !== false
    || batch?.readiness?.CALIBRATION_SAMPLE_SUFFICIENT !== false
    || batch?.readiness?.LIQUIDITY_IMPACT_STATUS !== 'BLOCKED_DATA'
    || batch?.readiness?.FULL_COST_READY !== false) throw new Error('CAPTURE_TRUTH_BOUNDARY_INVALID');

  const ids = new Set();
  for (const observation of batch.observations ?? []) {
    if (ids.has(observation.observationId)) throw new Error('CAPTURE_DUPLICATE_OBSERVATION_ID');
    ids.add(observation.observationId);
    if (observation.sampleClass !== 'FORWARD_NATURAL_SAMPLE') throw new Error('OBSERVATION_SAMPLE_CLASS_INVALID');
    if (observation.forwardCalibrationSampleCredit !== 1 || observation.historicalBackfillForwardCredit !== 0) {
      throw new Error('OBSERVATION_FORWARD_CLASSIFICATION_INVALID');
    }
    if (observation.collectorCodeSha !== exactMainSha) throw new Error('OBSERVATION_COLLECTOR_SHA_MISMATCH');
    if (observation.market !== V3_POLICY_BINDING.market || observation.symbol !== symbol) throw new Error('OBSERVATION_SCOPE_MISMATCH');
    if (observation.publicDataSource !== 'BITGET_PUBLIC_UTA_V3') throw new Error('OBSERVATION_PUBLIC_SOURCE_INVALID');
    if (!/^[a-f0-9]{64}$/u.test(String(observation.sourceDigest ?? ''))) throw new Error('OBSERVATION_SOURCE_DIGEST_INVALID');
    if (observation.calibrationSourceOnly !== true
      || observation.executionCostEligible !== false
      || observation.liquidityImpactCoefficient !== null
      || observation.causalMarketImpactClaim !== false
      || observation.paperOrderSourceAllowed !== false) throw new Error('OBSERVATION_AUTHORITY_ESCALATION');
  }
}

function classifyCaptureError(error) {
  const code = String(error?.message ?? 'CAPTURE_PROVIDER_OR_COLLECTOR_FAILURE');
  const validationPattern = /(_INVALID|_MISMATCH|_FALSE|_MISSING|_FORBIDDEN|_ESCALATION|_CHRONOLOGY|_OUT_OF_ORDER|_DUPLICATE)/u;
  return Object.freeze({
    captureStatus: validationPattern.test(code) ? 'VALIDATION_FAILURE' : 'PROVIDER_FAILURE',
    blocker: code,
  });
}

function scheduledFields(authority, actualRunStartedAtMs) {
  if (!authority?.slot) return {};
  return {
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
    slotIndex: authority.slot.slotIndex,
    split: authority.slot.split,
    slotStartMs: authority.slot.slotStartMs,
    slotEndMs: authority.slot.slotEndMs,
    nominalScheduledAtMs: authority.slot.nominalScheduledAtMs,
    actualRunStartedAtMs,
    cronUtc: authority.slot.cronUtc,
    canonicalSlotKey: authority.slot.canonicalSlotKey,
    canonicalSlotKeyDigest: authority.slot.canonicalSlotKeyDigest,
  };
}

export async function executeCaptureSeam({
  triggerSource,
  exactMainSha,
  symbol = V3_POLICY_BINDING.symbol,
  eventObservationDelayMs = CAPTURE_PARAMETER_POLICY.eventObservationDelayMs,
  postObservationDelaysMs = CAPTURE_PARAMETER_POLICY.postObservationDelaysMs,
  maxPreEventBookAgeMs = CAPTURE_PARAMETER_POLICY.maxPreEventBookAgeMs,
  runId = '',
  runAttempt = 1,
  repository = '',
  actualRunStartedAtMs = Date.now(),
  scheduledAuthority = null,
  activationContract = null,
  collector = collectBitgetForwardLiquidityObservationBatch,
} = {}) {
  const mainSha = exactSha(exactMainSha, 'EXACT_MAIN_SHA_INVALID');
  const normalizedSymbol = String(symbol ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,30}$/u.test(normalizedSymbol)) throw new Error('CAPTURE_SYMBOL_INVALID');
  const normalizedTrigger = String(triggerSource ?? '').trim();
  if (![MANUAL_TRIGGER_SOURCE, SCHEDULED_TRIGGER_SOURCE].includes(normalizedTrigger)) throw new Error('CAPTURE_TRIGGER_SOURCE_INVALID');
  const actualMs = positiveInteger(actualRunStartedAtMs, 'ACTUAL_RUN_STARTED_AT_MS_INVALID');
  const attempt = positiveInteger(runAttempt, 'RUN_ATTEMPT_INVALID');

  const isScheduled = normalizedTrigger === SCHEDULED_TRIGGER_SOURCE;
  if (isScheduled && normalizedSymbol !== V3_POLICY_BINDING.symbol) throw new Error('CAPTURE_SYMBOL_NOT_V3_SCOPE');
  if (isScheduled) {
    if (!scheduledAuthority?.slot) throw new Error('SCHEDULED_AUTHORITY_MISSING');
    const policyVerification = verifyV3PolicyBinding();
    if (!policyVerification.valid) throw new Error(`V3_POLICY_BINDING_INVALID:${policyVerification.blockers.join(',')}`);
    const activationVerification = verifyActivationContract(activationContract ?? {});
    if (!activationVerification.valid) throw new Error(`ACTIVATION_CONTRACT_INVALID:${activationVerification.blockers.join(',')}`);
  }

  const authority = isScheduled ? scheduledAuthority : Object.freeze({
    eligible: false,
    attempted: true,
    collectorInvoked: true,
    captureStatus: 'MANUAL_ZERO_V3_CREDIT',
    blocker: 'MANUAL_DISPATCH_CREDIT_ZERO',
    prospectiveSlotCredit: 0,
    slot: null,
  });

  let batch = null;
  let captureStatus = authority.captureStatus;
  let blockers = authority.blocker ? [authority.blocker] : [];
  let rawBatchDigest = null;
  let prospectiveObservationCount = 0;
  let droppedObservationCount = 0;
  const collectorInvoked = authority.collectorInvoked === true;

  if (collectorInvoked) {
    try {
      batch = await collector({
        symbol: normalizedSymbol,
        collectorCodeSha: mainSha,
        sampleClass: 'FORWARD_NATURAL_SAMPLE',
        eventObservationDelayMs,
        postObservationDelaysMs: [...postObservationDelaysMs],
        maxPreEventBookAgeMs,
      });
      validateCapturedBatch(batch, { exactMainSha: mainSha, symbol: normalizedSymbol });
      prospectiveObservationCount = batch.observations.length;
      droppedObservationCount = batch.droppedEvents.length;
      rawBatchDigest = sha256(canonicalJson(batch));
      captureStatus = prospectiveObservationCount > 0 ? 'PRESENT' : 'BLOCKED_DATA';
      blockers = prospectiveObservationCount > 0
        ? []
        : ['FORWARD_OBSERVATIONS_EMPTY', ...Object.keys(batch.datasetProvenance?.droppedReasons ?? {}).sort()];
    } catch (error) {
      const classified = classifyCaptureError(error);
      captureStatus = classified.captureStatus;
      blockers = [classified.blocker];
      batch = null;
      rawBatchDigest = null;
      prospectiveObservationCount = 0;
      droppedObservationCount = 0;
    }
  }

  const eligibleScheduledCapture = isScheduled
    && authority.eligible === true
    && captureStatus === 'PRESENT';
  const receiptBody = {
    schemaVersion: 'public-forward-liquidity-capture-receipt-v3',
    evidenceClass: 'PUBLIC_FORWARD_LIQUIDITY_CAPTURE_ATTEMPT_RECEIPT',
    triggerSource: normalizedTrigger,
    ATTEMPTED: authority.attempted === true,
    collectorInvoked,
    runId: String(runId ?? ''),
    runAttempt: String(attempt),
    repository: String(repository ?? ''),
    exactMainSha: mainSha,
    collectorCodeSha: mainSha,
    collectorImplementationBlobSha: CAPTURE_PARAMETER_POLICY.collectorImplementationBlobSha,
    symbol: normalizedSymbol,
    market: V3_POLICY_BINDING.market,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    eventObservationDelayMs,
    postObservationDelaysMs: [...postObservationDelaysMs],
    maxPreEventBookAgeMs,
    captureParameterPolicyDigest: CAPTURE_PARAMETER_POLICY_DIGEST,
    activationContractVersion: isScheduled ? activationContract.activationContractVersion : null,
    activationContractDigest: isScheduled ? activationContract.activationContractDigest : null,
    captureStatus,
    blockers,
    prospectiveObservationCount,
    droppedObservationCount,
    rawBatchDigest,
    prospectiveSlotCredit: eligibleScheduledCapture ? 1 : 0,
    manualCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    operatorSelectedCredit: 0,
    canonicalDatasetPersistencePerformed: false,
    canonicalDatasetCreditApplied: false,
    duplicateCreditEvaluated: isScheduled,
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
    ...scheduledFields(authority, actualMs),
  };
  const captureReceipt = Object.freeze({ ...receiptBody, captureReceiptDigest: sha256(canonicalJson(receiptBody)) });
  return Object.freeze({ batch, captureReceipt });
}

export function finalizeArtifactReceipt({ captureReceipt, artifactId, artifactDigest, artifactName, artifactReference = null } = {}) {
  if (!captureReceipt || typeof captureReceipt !== 'object') throw new Error('CAPTURE_RECEIPT_MISSING');
  const normalizedArtifactId = String(artifactId ?? '').trim();
  if (!/^[0-9]+$/u.test(normalizedArtifactId)) throw new Error('ARTIFACT_ID_INVALID');
  const normalizedArtifactDigest = exactDigest(artifactDigest, 'ARTIFACT_DIGEST_INVALID');
  const body = {
    schemaVersion: 'public-forward-liquidity-capture-artifact-receipt-v3',
    ...captureReceipt,
    artifactId: normalizedArtifactId,
    artifactName: String(artifactName ?? '').trim(),
    artifactDigest: normalizedArtifactDigest,
    artifactReference,
  };
  return Object.freeze({ ...body, receiptDigest: sha256(canonicalJson(body)) });
}

export function buildCompleteWindowAttemptLog(receipts = [], { asOfMs = Date.now() } = {}) {
  const now = positiveInteger(asOfMs, 'ATTEMPT_LOG_AS_OF_INVALID');
  const bySplit = {};
  for (const split of ['TRAIN', 'VALIDATION', 'OOS']) {
    const expectedSlots = buildV3ScheduleEntries().filter((slot) => slot.split === split);
    const receiptsForSplit = receipts.filter((receipt) => receipt?.triggerSource === SCHEDULED_TRIGGER_SOURCE && receipt?.split === split);
    const receiptsBySlot = new Map();
    for (const receipt of receiptsForSplit) {
      if (!Number.isInteger(receipt.slotIndex)) continue;
      if (!receiptsBySlot.has(receipt.slotIndex)) receiptsBySlot.set(receipt.slotIndex, []);
      receiptsBySlot.get(receipt.slotIndex).push(receipt);
    }
    let attemptedSlotN = 0;
    let missingSlotN = 0;
    let duplicateSlotAttemptN = 0;
    let validCaptureSlotN = 0;
    let blockedDataSlotN = 0;
    let providerFailureSlotN = 0;
    let validationFailureSlotN = 0;
    let missedSlotN = 0;
    for (const slot of expectedSlots) {
      const attempts = receiptsBySlot.get(slot.slotIndex) ?? [];
      const attempted = attempts.filter((receipt) => receipt?.ATTEMPTED === true);
      if (attempted.length > 0) attemptedSlotN += 1;
      if (attempted.length > 1) duplicateSlotAttemptN += attempted.length - 1;
      const credited = attempted.find((receipt) => receipt?.prospectiveSlotCredit === 1 && receipt?.captureStatus === 'PRESENT');
      if (credited) validCaptureSlotN += 1;
      if (attempted.some((receipt) => receipt?.captureStatus === 'BLOCKED_DATA')) blockedDataSlotN += 1;
      if (attempted.some((receipt) => receipt?.captureStatus === 'PROVIDER_FAILURE')) providerFailureSlotN += 1;
      if (attempted.some((receipt) => receipt?.captureStatus === 'VALIDATION_FAILURE')) validationFailureSlotN += 1;
      if (attempted.some((receipt) => receipt?.captureStatus === 'MISSED_SLOT')) missedSlotN += 1;
      if (slot.slotEndMs <= now && attempted.length === 0) missingSlotN += 1;
    }
    bySplit[split] = Object.freeze({
      expectedSlotN: expectedSlots.length,
      attemptedSlotN,
      missingSlotN,
      duplicateSlotAttemptN,
      validCaptureSlotN,
      blockedDataSlotN,
      providerFailureSlotN,
      validationFailureSlotN,
      missedSlotN,
    });
  }
  const selectionComplete = now >= V3_POLICY_BINDING.cohortEndExclusiveMs
    && Object.values(bySplit).every((entry) => entry.missingSlotN === 0 && entry.duplicateSlotAttemptN === 0 && entry.attemptedSlotN === entry.expectedSlotN);
  return Object.freeze({
    schemaVersion: 'public-forward-liquidity-complete-window-attempt-log-v1',
    asOfMs: now,
    expectedTotalSlotN: 48,
    splits: Object.freeze(bySplit),
    selectionComplete,
    fullCostReady: false,
    evidenceComplete: 0,
  });
}

export function verifyActivationContract(contract, {
  scheduledWorkflowBlobSha,
  captureWorkflowBlobSha,
  collectorBlobSha = CAPTURE_PARAMETER_POLICY.collectorImplementationBlobSha,
} = {}) {
  const blockers = [];
  const digest = contract?.activationContractDigest;
  if (!/^[a-f0-9]{64}$/u.test(String(digest ?? ''))) blockers.push('ACTIVATION_CONTRACT_DIGEST_INVALID');
  else {
    const { activationContractDigest: _ignored, ...body } = contract;
    if (sha256(canonicalJson(body)) !== digest) blockers.push('ACTIVATION_CONTRACT_DIGEST_MISMATCH');
  }
  if (contract?.activationContractVersion !== 'public-forward-liquidity-v3-activation-contract-v1') blockers.push('ACTIVATION_CONTRACT_VERSION_INVALID');
  if (contract?.v3PolicyHeadSha !== V3_POLICY_BINDING.policyHeadSha) blockers.push('ACTIVATION_V3_POLICY_HEAD_MISMATCH');
  if (contract?.v3PolicyDigest !== V3_POLICY_BINDING.policyDigest) blockers.push('ACTIVATION_V3_POLICY_DIGEST_MISMATCH');
  if (String(contract?.v3PolicyArtifactId ?? '') !== V3_POLICY_BINDING.policyArtifactId) blockers.push('ACTIVATION_V3_ARTIFACT_ID_MISMATCH');
  if (contract?.v3PolicyArtifactDigest !== V3_POLICY_BINDING.policyArtifactDigest) blockers.push('ACTIVATION_V3_ARTIFACT_DIGEST_MISMATCH');
  if (contract?.v3CohortDigest !== V3_POLICY_BINDING.cohortDigest) blockers.push('ACTIVATION_V3_COHORT_DIGEST_MISMATCH');
  if (contract?.captureParameterPolicyDigest !== CAPTURE_PARAMETER_POLICY_DIGEST) blockers.push('ACTIVATION_CAPTURE_PARAMETER_POLICY_MISMATCH');
  if (contract?.slotExecutionRule !== SLOT_EXECUTION_RULE) blockers.push('ACTIVATION_SLOT_RULE_MISMATCH');
  if (contract?.slotExecutionOffsetMs !== SLOT_EXECUTION_OFFSET_MS) blockers.push('ACTIVATION_SLOT_OFFSET_MISMATCH');
  const expectedCron = buildV3ScheduleEntries().map((entry) => entry.cronUtc);
  if (canonicalJson(contract?.cronUtc ?? null) !== canonicalJson(expectedCron)) blockers.push('ACTIVATION_CRON_SET_MISMATCH');
  if (contract?.defaultBranchRequired !== true || contract?.manualCredit !== 0) blockers.push('ACTIVATION_AUTHORITY_BOUNDARY_INVALID');
  if (scheduledWorkflowBlobSha && contract?.exactScheduledWorkflowSha !== exactSha(scheduledWorkflowBlobSha, 'SCHEDULED_WORKFLOW_BLOB_SHA_INVALID')) blockers.push('ACTIVATION_SCHEDULED_WORKFLOW_SHA_MISMATCH');
  if (captureWorkflowBlobSha && contract?.captureWorkflowSha !== exactSha(captureWorkflowBlobSha, 'CAPTURE_WORKFLOW_BLOB_SHA_INVALID')) blockers.push('ACTIVATION_CAPTURE_WORKFLOW_SHA_MISMATCH');
  if (collectorBlobSha && contract?.collectorCodeSha !== exactSha(collectorBlobSha, 'COLLECTOR_BLOB_SHA_INVALID')) blockers.push('ACTIVATION_COLLECTOR_CODE_SHA_MISMATCH');
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(blockers) });
}

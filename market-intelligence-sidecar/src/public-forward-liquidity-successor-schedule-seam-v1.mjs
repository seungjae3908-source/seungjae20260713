import {
  canonicalJson,
  collectBitgetForwardLiquidityObservationBatch,
  sha256,
} from './public-forward-liquidity-calibration.mjs';
import {
  SUCCESSOR_PROSPECTIVE_CONTRACT,
  buildSuccessorSlotDescriptor,
  verifySuccessorProspectiveContract,
} from './public-forward-liquidity-successor-prospective-cohort.mjs';
import {
  SUCCESSOR_OOS_HORIZON_CONTRACT,
  verifySuccessorOosOutcomeHorizonContract,
} from './public-forward-liquidity-successor-oos-outcome-horizon.mjs';

export const SUCCESSOR_SCHEDULE_EVENT_NAME = 'schedule';
export const SUCCESSOR_SCHEDULE_CRON_UTC = '17 * * * *';
export const SUCCESSOR_CAPTURE_RECEIPT_SCHEMA =
  'public-forward-liquidity-successor-scheduled-capture-receipt-v1';
export const SUCCESSOR_ARTIFACT_RECEIPT_SCHEMA =
  'public-forward-liquidity-successor-scheduled-capture-artifact-receipt-v1';

const POLICY = SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore;
const COHORT = POLICY.cohort;
const TECHNICAL = POLICY.technicalIdentity;
const CAPTURE_POLICY = TECHNICAL.captureParameterPolicy;
const CREDIT_POLICY = POLICY.creditPolicy;
const MAX_PROSPECTIVE_SLOT_CREDIT =
  CREDIT_POLICY.prospectiveCreditPerEligiblePresentFirstAttempt;

function exactSha(value, code) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function exactDigest(value, code) {
  const normalized = String(value ?? '').trim().replace(/^sha256:/u, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function nonNegativeInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function positiveInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}

function frozenContractVerdict() {
  const cohortVerdict = verifySuccessorProspectiveContract();
  const horizonVerdict = verifySuccessorOosOutcomeHorizonContract();
  const blockers = [];
  if (!cohortVerdict.valid) {
    for (const blocker of cohortVerdict.blockers) addUnique(blockers, `COHORT:${blocker}`);
  }
  if (!horizonVerdict.valid) {
    for (const blocker of horizonVerdict.blockers) addUnique(blockers, `OOS:${blocker}`);
  }
  if (COHORT.cronUtc !== SUCCESSOR_SCHEDULE_CRON_UTC) {
    addUnique(blockers, 'SUCCESSOR_CRON_NOT_FROZEN_VALUE');
  }
  if (TECHNICAL.captureParameterPolicyDigest
    !== sha256(canonicalJson(CAPTURE_POLICY))) {
    addUnique(blockers, 'SUCCESSOR_CAPTURE_PARAMETER_DIGEST_MISMATCH');
  }
  if (MAX_PROSPECTIVE_SLOT_CREDIT !== 1) {
    addUnique(blockers, 'SUCCESSOR_MAX_PROSPECTIVE_SLOT_CREDIT_INVALID');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
    cohortPolicyDigest: cohortVerdict.policyDigest ?? null,
    cohortDigest: cohortVerdict.cohortDigest ?? null,
    oosPolicyDigest: horizonVerdict.policyDigest ?? null,
    oosContractDigest: horizonVerdict.contractDigest ?? null,
  });
}

export function verifySuccessorScheduleSeamFrozenBindings() {
  return frozenContractVerdict();
}

function zeroAuthorityResult({
  attempted,
  status,
  blocker,
  slot = null,
  collectorInvoked = false,
}) {
  return Object.freeze({
    eligible: false,
    attempted,
    collectorInvoked,
    captureStatus: status,
    blocker,
    creditEligibleIfPresent: false,
    maximumProspectiveSlotCredit: MAX_PROSPECTIVE_SLOT_CREDIT,
    prospectiveSlotCredit: 0,
    slot,
  });
}

function slotIndexForTimestamp(timestampMs) {
  return Math.floor((timestampMs - COHORT.startInclusiveMs) / COHORT.slotCadenceMs);
}

export function resolveSuccessorScheduledAuthority({
  eventName,
  scheduleExpression,
  scheduledRunCreatedAtMs,
  actualRunStartedAtMs,
  runAttempt = 1,
} = {}) {
  const frozen = frozenContractVerdict();
  if (!frozen.valid) {
    return zeroAuthorityResult({
      attempted: false,
      status: 'FROZEN_CONTRACT_INVALID',
      blocker: `SUCCESSOR_FROZEN_CONTRACT_INVALID:${frozen.blockers.join(',')}`,
    });
  }

  if (String(eventName ?? '').trim() !== SUCCESSOR_SCHEDULE_EVENT_NAME) {
    return zeroAuthorityResult({
      attempted: false,
      status: 'WRONG_EVENT',
      blocker: 'SUCCESSOR_SCHEDULE_EVENT_REQUIRED',
    });
  }
  if (String(scheduleExpression ?? '').trim() !== SUCCESSOR_SCHEDULE_CRON_UTC) {
    return zeroAuthorityResult({
      attempted: false,
      status: 'WRONG_SCHEDULE_EXPRESSION',
      blocker: 'SUCCESSOR_SCHEDULE_EXPRESSION_NOT_FROZEN_CRON',
    });
  }

  const created = nonNegativeInteger(
    scheduledRunCreatedAtMs,
    'SUCCESSOR_SCHEDULED_RUN_CREATED_AT_MS_INVALID',
  );
  const actual = nonNegativeInteger(
    actualRunStartedAtMs,
    'SUCCESSOR_ACTUAL_RUN_STARTED_AT_MS_INVALID',
  );
  const attempt = positiveInteger(runAttempt, 'SUCCESSOR_RUN_ATTEMPT_INVALID');

  if (actual < COHORT.startInclusiveMs) {
    return zeroAuthorityResult({
      attempted: true,
      status: 'PRE_COHORT_ATTEMPT',
      blocker: 'SUCCESSOR_ATTEMPT_BEFORE_COHORT_START',
    });
  }
  if (actual >= COHORT.endExclusiveMs) {
    return zeroAuthorityResult({
      attempted: true,
      status: 'POST_COHORT_ATTEMPT',
      blocker: 'SUCCESSOR_ATTEMPT_AT_OR_AFTER_COHORT_END',
    });
  }
  if (created < COHORT.startInclusiveMs || created >= COHORT.endExclusiveMs) {
    return zeroAuthorityResult({
      attempted: true,
      status: 'SCHEDULE_PROVENANCE_INVALID',
      blocker: 'SUCCESSOR_SCHEDULED_RUN_CREATED_OUTSIDE_COHORT',
    });
  }
  if (created > actual) {
    return zeroAuthorityResult({
      attempted: true,
      status: 'SCHEDULE_PROVENANCE_INVALID',
      blocker: 'SUCCESSOR_SCHEDULED_RUN_CREATED_AFTER_ACTUAL_START',
    });
  }

  const slotIndex = slotIndexForTimestamp(actual);
  const createdSlotIndex = slotIndexForTimestamp(created);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= COHORT.totalSlotN) {
    return zeroAuthorityResult({
      attempted: true,
      status: 'INVALID_SLOT',
      blocker: 'SUCCESSOR_COMPUTED_SLOT_INDEX_INVALID',
    });
  }
  const slot = buildSuccessorSlotDescriptor(slotIndex);
  if (createdSlotIndex !== slotIndex) {
    return zeroAuthorityResult({
      attempted: true,
      status: 'SCHEDULE_PROVENANCE_INVALID',
      blocker: 'SUCCESSOR_SCHEDULE_QUEUE_CROSSED_SLOT_BOUNDARY',
      slot,
    });
  }
  if (slot.cronUtc !== SUCCESSOR_SCHEDULE_CRON_UTC) {
    return zeroAuthorityResult({
      attempted: true,
      status: 'INVALID_SLOT',
      blocker: 'SUCCESSOR_SLOT_CRON_MISMATCH',
      slot,
    });
  }
  if (created < slot.nominalScheduledAtMs || created > slot.allowedStartThroughMs) {
    return zeroAuthorityResult({
      attempted: true,
      status: 'SCHEDULE_PROVENANCE_INVALID',
      blocker: 'SUCCESSOR_SCHEDULED_RUN_CREATED_OUTSIDE_ALLOWED_SLOT_WINDOW',
      slot,
    });
  }
  if (actual < slot.nominalScheduledAtMs) {
    return zeroAuthorityResult({
      attempted: true,
      status: 'PRE_NOMINAL_ATTEMPT',
      blocker: 'SUCCESSOR_ATTEMPT_BEFORE_NOMINAL_SLOT_TIME',
      slot,
    });
  }
  if (actual > slot.allowedStartThroughMs) {
    return zeroAuthorityResult({
      attempted: true,
      status: 'MISSED_SLOT',
      blocker: 'SUCCESSOR_ATTEMPT_AFTER_ALLOWED_START_DELAY',
      slot,
    });
  }
  if (attempt !== 1) {
    return zeroAuthorityResult({
      attempted: true,
      status: 'DIAGNOSTIC_ONLY',
      blocker: 'SUCCESSOR_RERUN_ZERO_CREDIT',
      slot,
    });
  }

  return Object.freeze({
    eligible: true,
    attempted: true,
    collectorInvoked: false,
    captureStatus: 'ELIGIBLE_TO_ATTEMPT_CAPTURE',
    blocker: null,
    creditEligibleIfPresent: true,
    maximumProspectiveSlotCredit: MAX_PROSPECTIVE_SLOT_CREDIT,
    prospectiveSlotCredit: 0,
    slot,
  });
}

function validateCapturedBatch(batch, { exactMainSha } = {}) {
  if (batch?.kind !== 'public-forward-liquidity-calibration-batch') {
    throw new Error('SUCCESSOR_CAPTURE_BATCH_KIND_INVALID');
  }
  if (batch?.sampleClass !== 'FORWARD_NATURAL_SAMPLE') {
    throw new Error('SUCCESSOR_CAPTURE_SAMPLE_CLASS_INVALID');
  }
  if (batch?.capability?.PUBLIC_CALIBRATION_DATA_CAPABLE !== true) {
    throw new Error('SUCCESSOR_PUBLIC_CALIBRATION_CAPABILITY_FALSE');
  }
  if (batch?.datasetProvenance?.collectorCodeSha !== exactMainSha) {
    throw new Error('SUCCESSOR_COLLECTOR_SHA_MISMATCH');
  }
  if (batch?.datasetProvenance?.rawSource?.provider !== TECHNICAL.publicDataSource) {
    throw new Error('SUCCESSOR_PUBLIC_PROVIDER_INVALID');
  }
  if (batch?.datasetProvenance?.rawSource?.privateApiUsed !== false) {
    throw new Error('SUCCESSOR_PRIVATE_API_CLAIM_INVALID');
  }
  if (batch?.safety?.publicDataOnly !== true
    || batch?.safety?.executionAuthority !== 'NONE'
    || batch?.safety?.privateTradingApiAllowed !== false
    || batch?.safety?.liveTradingAllowed !== false
    || batch?.safety?.realOrderAllowed !== false
    || batch?.safety?.financialMutationAllowed !== false) {
    throw new Error('SUCCESSOR_CAPTURE_SAFETY_INVALID');
  }
  if (batch?.readiness?.LIQUIDITY_IMPACT_PRESENT !== false
    || batch?.readiness?.CALIBRATION_SAMPLE_SUFFICIENT !== false
    || batch?.readiness?.LIQUIDITY_IMPACT_STATUS !== 'BLOCKED_DATA'
    || batch?.readiness?.FULL_COST_READY !== false) {
    throw new Error('SUCCESSOR_CAPTURE_TRUTH_BOUNDARY_INVALID');
  }
  if (!Array.isArray(batch?.observations)) {
    throw new Error('SUCCESSOR_OBSERVATIONS_INVALID');
  }

  const ids = new Set();
  for (const observation of batch.observations) {
    if (ids.has(observation?.observationId)) {
      throw new Error('SUCCESSOR_CAPTURE_DUPLICATE_OBSERVATION_ID');
    }
    ids.add(observation?.observationId);
    if (observation?.sampleClass !== 'FORWARD_NATURAL_SAMPLE'
      || observation?.forwardCalibrationSampleCredit !== 1
      || observation?.historicalBackfillForwardCredit !== 0
      || observation?.collectorCodeSha !== exactMainSha
      || observation?.market !== TECHNICAL.market
      || observation?.symbol !== TECHNICAL.symbol
      || observation?.publicDataSource !== TECHNICAL.publicDataSource
      || !/^[a-f0-9]{64}$/u.test(String(observation?.sourceDigest ?? ''))
      || observation?.calibrationSourceOnly !== true
      || observation?.executionCostEligible !== false
      || observation?.liquidityImpactCoefficient !== null
      || observation?.causalMarketImpactClaim !== false
      || observation?.paperOrderSourceAllowed !== false) {
      throw new Error('SUCCESSOR_OBSERVATION_AUTHORITY_OR_LINEAGE_INVALID');
    }
  }
  if (!Array.isArray(batch?.droppedEvents)) {
    throw new Error('SUCCESSOR_DROPPED_EVENTS_INVALID');
  }
}

function classifyCaptureError(error) {
  const code = String(error?.message ?? 'SUCCESSOR_CAPTURE_PROVIDER_OR_COLLECTOR_FAILURE');
  const validationPattern = /(_INVALID|_MISMATCH|_FALSE|_MISSING|_FORBIDDEN|_ESCALATION|_DUPLICATE)/u;
  return Object.freeze({
    captureStatus: validationPattern.test(code) ? 'VALIDATION_FAILURE' : 'PROVIDER_FAILURE',
    blocker: code,
  });
}

function slotReceiptFields(authority, scheduledRunCreatedAtMs, actualRunStartedAtMs) {
  if (!authority?.slot) return {};
  const slot = authority.slot;
  return {
    cohortId: SUCCESSOR_PROSPECTIVE_CONTRACT.cohortId,
    policyDigest: SUCCESSOR_PROSPECTIVE_CONTRACT.policyDigest,
    cohortDigest: SUCCESSOR_PROSPECTIVE_CONTRACT.cohortDigest,
    slotCadenceMs: COHORT.slotCadenceMs,
    slotIndex: slot.slotIndex,
    split: slot.split,
    nominalScheduledAtMs: slot.nominalScheduledAtMs,
    allowedStartThroughMs: slot.allowedStartThroughMs,
    slotEndExclusiveMs: slot.slotEndExclusiveMs,
    scheduledRunCreatedAtMs,
    actualRunStartedAtMs,
    cronUtc: slot.cronUtc,
    canonicalSlotKey: slot.canonicalSlotKey,
    canonicalSlotKeyDigest: sha256(canonicalJson(slot.canonicalSlotKey)),
  };
}

function receiptBody({
  authority,
  eventName,
  scheduleExpression,
  exactMainSha,
  remoteMainShaBefore,
  remoteMainShaAfter,
  defaultBranchRef,
  scheduledRunCreatedAtMs,
  actualRunStartedAtMs,
  completedAtMs,
  runId,
  runAttempt,
  repository,
  captureStatus,
  blockers,
  collectorInvoked,
  priorCreditedSlotCheck,
  rawBatchDigest,
  rawEvidencePreserved,
  prospectiveObservationCount,
  droppedObservationCount,
  prospectiveSlotCredit,
}) {
  return {
    schemaVersion: SUCCESSOR_CAPTURE_RECEIPT_SCHEMA,
    evidenceClass: 'PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_CAPTURE_ATTEMPT_RECEIPT',
    cohortContractVersion: SUCCESSOR_PROSPECTIVE_CONTRACT.contractVersion,
    oosHorizonContractVersion: SUCCESSOR_OOS_HORIZON_CONTRACT.contractVersion,
    oosHorizonPolicyDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.policyDigest,
    oosHorizonContractDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.contractDigest,
    oosOutcomeHorizonMs: SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeHorizonMs,
    oosOutcomeSelectionPolicy:
      SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeSelectionPolicy,
    eventName: String(eventName ?? '').trim(),
    scheduleExpression: String(scheduleExpression ?? '').trim(),
    ATTEMPTED: authority?.attempted === true,
    collectorInvoked,
    runId: String(runId ?? ''),
    runAttempt: String(runAttempt),
    repository: String(repository ?? ''),
    defaultBranchRef,
    exactMainSha,
    remoteMainShaBefore,
    remoteMainShaAfter,
    collectorCodeSha: exactMainSha,
    collectorImplementationBlobSha: TECHNICAL.collectorImplementationBlobSha,
    runtimeCollectorCodeShaRule: TECHNICAL.runtimeCollectorCodeShaRule,
    market: TECHNICAL.market,
    symbol: TECHNICAL.symbol,
    publicDataSource: TECHNICAL.publicDataSource,
    observationContract: TECHNICAL.observationContract,
    storeContract: TECHNICAL.storeContract,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    eventObservationDelayMs: CAPTURE_POLICY.eventObservationDelayMs,
    postObservationDelaysMs: [...CAPTURE_POLICY.postObservationDelaysMs],
    maxPreEventBookAgeMs: CAPTURE_POLICY.maxPreEventBookAgeMs,
    captureParameterPolicyDigest: TECHNICAL.captureParameterPolicyDigest,
    captureStatus,
    blockers: [...blockers],
    priorCreditedSlotCheck,
    prospectiveObservationCount,
    droppedObservationCount,
    rawBatchDigest,
    rawEvidencePreserved,
    completedAtMs,
    maximumProspectiveSlotCredit: MAX_PROSPECTIVE_SLOT_CREDIT,
    prospectiveSlotCredit,
    manualCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    operatorSelectedCredit: 0,
    duplicateOrRerunCredit: 0,
    missedSlotCredit: 0,
    syntheticCredit: 0,
    canonicalDatasetPersistencePerformed: false,
    canonicalDatasetCreditApplied: false,
    splitAssignmentPerformed: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE',
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    autoTrading: false,
    orderSubmitted: false,
    realOrders: 0,
    ...slotReceiptFields(authority, scheduledRunCreatedAtMs, actualRunStartedAtMs),
  };
}

export async function executeSuccessorScheduledCaptureSeam({
  eventName,
  scheduleExpression,
  scheduledRunCreatedAtMs,
  exactMainSha,
  defaultBranchRef = 'refs/heads/main',
  actualRunStartedAtMs,
  runAttempt = 1,
  runId = '',
  repository = '',
  hasPriorCreditedSlot,
  getRemoteMainSha,
  clock = () => Date.now(),
  collector = collectBitgetForwardLiquidityObservationBatch,
} = {}) {
  const mainSha = exactSha(exactMainSha, 'SUCCESSOR_EXACT_MAIN_SHA_INVALID');
  if (defaultBranchRef !== 'refs/heads/main') {
    throw new Error('SUCCESSOR_DEFAULT_BRANCH_REF_INVALID');
  }
  if (typeof clock !== 'function') throw new Error('SUCCESSOR_CLOCK_INVALID');
  if (typeof collector !== 'function') throw new Error('SUCCESSOR_COLLECTOR_INVALID');

  const created = nonNegativeInteger(
    scheduledRunCreatedAtMs,
    'SUCCESSOR_SCHEDULED_RUN_CREATED_AT_MS_INVALID',
  );
  const actual = nonNegativeInteger(
    actualRunStartedAtMs,
    'SUCCESSOR_ACTUAL_RUN_STARTED_AT_MS_INVALID',
  );
  const attempt = positiveInteger(runAttempt, 'SUCCESSOR_RUN_ATTEMPT_INVALID');
  const authority = resolveSuccessorScheduledAuthority({
    eventName,
    scheduleExpression,
    scheduledRunCreatedAtMs: created,
    actualRunStartedAtMs: actual,
    runAttempt: attempt,
  });

  let remoteMainShaBefore = null;
  let remoteMainShaAfter = null;
  let batch = null;
  let collectorInvoked = false;
  let captureStatus = authority.captureStatus;
  let blockers = authority.blocker ? [authority.blocker] : [];
  let priorCreditedSlotCheck = 'NOT_APPLICABLE';
  let rawBatchDigest = null;
  let prospectiveObservationCount = 0;
  let droppedObservationCount = 0;
  let completedAtMs = null;
  let credit = 0;

  if (authority.eligible === true) {
    if (typeof hasPriorCreditedSlot !== 'function') {
      captureStatus = 'PRIOR_CREDIT_STATE_UNVERIFIED';
      blockers = ['SUCCESSOR_PRIOR_CREDIT_LOOKUP_MISSING'];
      priorCreditedSlotCheck = 'UNVERIFIED';
    } else {
      try {
        const priorExists = await hasPriorCreditedSlot(Object.freeze({
          cohortId: SUCCESSOR_PROSPECTIVE_CONTRACT.cohortId,
          policyDigest: SUCCESSOR_PROSPECTIVE_CONTRACT.policyDigest,
          cohortDigest: SUCCESSOR_PROSPECTIVE_CONTRACT.cohortDigest,
          slotIndex: authority.slot.slotIndex,
          split: authority.slot.split,
          canonicalSlotKey: authority.slot.canonicalSlotKey,
          canonicalSlotKeyDigest: sha256(canonicalJson(authority.slot.canonicalSlotKey)),
        }));
        if (priorExists === true) {
          captureStatus = 'DIAGNOSTIC_ONLY';
          blockers = ['SUCCESSOR_DUPLICATE_SLOT_ATTEMPT_ZERO_CREDIT'];
          priorCreditedSlotCheck = 'PRESENT';
        } else if (priorExists === false) {
          priorCreditedSlotCheck = 'CLEAR';
        } else {
          captureStatus = 'PRIOR_CREDIT_STATE_UNVERIFIED';
          blockers = ['SUCCESSOR_PRIOR_CREDIT_LOOKUP_RESULT_INVALID'];
          priorCreditedSlotCheck = 'UNVERIFIED';
        }
      } catch (error) {
        captureStatus = 'PRIOR_CREDIT_STATE_UNVERIFIED';
        blockers = [
          `SUCCESSOR_PRIOR_CREDIT_LOOKUP_FAILED:${String(error?.message ?? 'UNKNOWN')}`,
        ];
        priorCreditedSlotCheck = 'UNVERIFIED';
      }
    }

    if (priorCreditedSlotCheck === 'CLEAR') {
      if (typeof getRemoteMainSha !== 'function') {
        captureStatus = 'REMOTE_MAIN_PRE_CAPTURE_UNVERIFIED';
        blockers = ['SUCCESSOR_REMOTE_MAIN_RESOLVER_MISSING'];
      } else {
        try {
          remoteMainShaBefore = exactSha(
            await getRemoteMainSha(),
            'SUCCESSOR_REMOTE_MAIN_SHA_BEFORE_INVALID',
          );
        } catch (error) {
          captureStatus = 'REMOTE_MAIN_PRE_CAPTURE_UNVERIFIED';
          blockers = [String(error?.message ?? 'SUCCESSOR_REMOTE_MAIN_PRE_CAPTURE_UNVERIFIED')];
        }
      }
    }

    if (remoteMainShaBefore && remoteMainShaBefore !== mainSha) {
      captureStatus = 'STALE_MAIN_PRE_CAPTURE';
      blockers = ['SUCCESSOR_REMOTE_MAIN_CHANGED_BEFORE_CAPTURE'];
    }

    if (priorCreditedSlotCheck === 'CLEAR' && remoteMainShaBefore === mainSha) {
      collectorInvoked = true;
      try {
        batch = await collector({
          symbol: TECHNICAL.symbol,
          collectorCodeSha: mainSha,
          sampleClass: 'FORWARD_NATURAL_SAMPLE',
          eventObservationDelayMs: CAPTURE_POLICY.eventObservationDelayMs,
          postObservationDelaysMs: [...CAPTURE_POLICY.postObservationDelaysMs],
          maxPreEventBookAgeMs: CAPTURE_POLICY.maxPreEventBookAgeMs,
        });
        completedAtMs = nonNegativeInteger(
          clock(),
          'SUCCESSOR_CAPTURE_COMPLETED_AT_MS_INVALID',
        );

        try {
          rawBatchDigest = sha256(canonicalJson(batch));
          validateCapturedBatch(batch, { exactMainSha: mainSha });
          prospectiveObservationCount = batch.observations.length;
          droppedObservationCount = batch.droppedEvents.length;
          captureStatus = prospectiveObservationCount > 0 ? 'PRESENT' : 'BLOCKED_DATA';
          blockers = prospectiveObservationCount > 0
            ? []
            : ['SUCCESSOR_FORWARD_OBSERVATIONS_EMPTY',
              ...Object.keys(batch.datasetProvenance?.droppedReasons ?? {}).sort()];
        } catch (error) {
          const classified = classifyCaptureError(error);
          captureStatus = classified.captureStatus;
          blockers = [classified.blocker];
        }
      } catch (error) {
        const classified = classifyCaptureError(error);
        captureStatus = classified.captureStatus;
        blockers = [classified.blocker];
        batch = null;
        rawBatchDigest = null;
        prospectiveObservationCount = 0;
        droppedObservationCount = 0;
        try {
          completedAtMs = nonNegativeInteger(
            clock(),
            'SUCCESSOR_CAPTURE_COMPLETED_AT_MS_INVALID',
          );
        } catch {
          completedAtMs = null;
          addUnique(blockers, 'SUCCESSOR_CAPTURE_COMPLETION_CLOCK_UNAVAILABLE');
        }
      }

      if (completedAtMs !== null) {
        if (completedAtMs < actual) {
          addUnique(blockers, 'SUCCESSOR_CAPTURE_COMPLETED_BEFORE_ACTUAL_START');
        }
        if (completedAtMs > actual + COHORT.allowedCompletionDelayMs) {
          addUnique(blockers, 'SUCCESSOR_CAPTURE_COMPLETED_AFTER_ALLOWED_DELAY');
        }
      } else {
        addUnique(blockers, 'SUCCESSOR_CAPTURE_COMPLETION_TIME_MISSING');
      }

      if (typeof getRemoteMainSha !== 'function') {
        addUnique(blockers, 'SUCCESSOR_REMOTE_MAIN_POST_CAPTURE_RESOLVER_MISSING');
      } else {
        try {
          remoteMainShaAfter = exactSha(
            await getRemoteMainSha(),
            'SUCCESSOR_REMOTE_MAIN_SHA_AFTER_INVALID',
          );
          if (remoteMainShaAfter !== mainSha) {
            addUnique(blockers, 'SUCCESSOR_REMOTE_MAIN_CHANGED_DURING_CAPTURE');
          }
        } catch (error) {
          addUnique(
            blockers,
            `SUCCESSOR_REMOTE_MAIN_POST_CAPTURE_UNVERIFIED:${String(error?.message ?? 'UNKNOWN')}`,
          );
        }
      }

      if (captureStatus === 'PRESENT' && blockers.length === 0) {
        credit = MAX_PROSPECTIVE_SLOT_CREDIT;
      } else if (captureStatus === 'PRESENT') {
        captureStatus = 'PRESENT_ZERO_CREDIT';
      }
    }
  }

  const body = receiptBody({
    authority,
    eventName,
    scheduleExpression,
    exactMainSha: mainSha,
    remoteMainShaBefore,
    remoteMainShaAfter,
    defaultBranchRef,
    scheduledRunCreatedAtMs: created,
    actualRunStartedAtMs: actual,
    completedAtMs,
    runId,
    runAttempt: attempt,
    repository,
    captureStatus,
    blockers,
    collectorInvoked,
    priorCreditedSlotCheck,
    rawBatchDigest,
    rawEvidencePreserved: batch !== null,
    prospectiveObservationCount,
    droppedObservationCount,
    prospectiveSlotCredit: credit,
  });
  const captureReceipt = Object.freeze({
    ...body,
    captureReceiptDigest: sha256(canonicalJson(body)),
  });
  return Object.freeze({ batch, captureReceipt });
}

export function finalizeSuccessorArtifactReceipt({
  captureReceipt,
  artifactId,
  artifactDigest,
  artifactName,
  artifactReference = null,
} = {}) {
  if (!captureReceipt || typeof captureReceipt !== 'object') {
    throw new Error('SUCCESSOR_CAPTURE_RECEIPT_MISSING');
  }
  if (!captureReceipt.rawBatchDigest || captureReceipt.rawEvidencePreserved !== true) {
    throw new Error('SUCCESSOR_RAW_BATCH_DIGEST_MISSING');
  }
  const normalizedArtifactId = String(artifactId ?? '').trim();
  if (!/^[0-9]+$/u.test(normalizedArtifactId)) {
    throw new Error('SUCCESSOR_ARTIFACT_ID_INVALID');
  }
  const normalizedArtifactDigest = exactDigest(
    artifactDigest,
    'SUCCESSOR_ARTIFACT_DIGEST_INVALID',
  );
  const normalizedArtifactName = String(artifactName ?? '').trim();
  if (!normalizedArtifactName) throw new Error('SUCCESSOR_ARTIFACT_NAME_MISSING');

  const body = {
    ...captureReceipt,
    schemaVersion: SUCCESSOR_ARTIFACT_RECEIPT_SCHEMA,
    artifactId: normalizedArtifactId,
    artifactName: normalizedArtifactName,
    artifactDigest: normalizedArtifactDigest,
    artifactReference,
  };
  return Object.freeze({
    ...body,
    receiptDigest: sha256(canonicalJson(body)),
  });
}

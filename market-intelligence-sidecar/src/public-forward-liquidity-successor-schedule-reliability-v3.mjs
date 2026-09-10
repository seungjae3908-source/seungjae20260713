import { existsSync, readFileSync } from 'node:fs';

import { canonicalJson, sha256 } from './public-forward-liquidity-calibration.mjs';
import {
  SUCCESSOR_PROSPECTIVE_CONTRACT as SUCCESSOR_V2_PROSPECTIVE_CONTRACT,
  verifySuccessorProspectiveContract as verifySuccessorV2ProspectiveContract,
} from './public-forward-liquidity-successor-prospective-cohort.mjs';
import {
  SUCCESSOR_OOS_HORIZON_CONTRACT,
  verifySuccessorOosOutcomeHorizonContract,
} from './public-forward-liquidity-successor-oos-outcome-horizon.mjs';

export const SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONFIG_PATH = new URL(
  '../config/public-forward-liquidity-successor-schedule-reliability-v3.json',
  import.meta.url,
);

export const SUCCESSOR_SCHEDULE_RELIABILITY_V3_ACTIVATION_PATH = new URL(
  '../config/public-forward-liquidity-successor-schedule-reliability-activation-v3.json',
  import.meta.url,
);

const TEMPLATE = Object.freeze(
  JSON.parse(readFileSync(SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONFIG_PATH, 'utf8')),
);

const EXPECTED_NUMERIC_FREEZE_SHA256 =
  '10b157de8e1902865f9b386a02439bb56d67b5c2fcd20dd48870d851bdb97ff1';
const EXPECTED_V2_POLICY_DIGEST =
  '5d91ea09ac5a2982a26d00197433142455fa6634488fadc9201e4ddf1346ed6c';
const EXPECTED_V2_COHORT_DIGEST =
  '9b2853a361e17dc429288cec4499fc972189b0bc2427a6d8bb2a999eff847454';
const ACTIVATION_SCHEMA =
  'public-forward-liquidity-successor-schedule-reliability-activation-binding-v3';

export const SUCCESSOR_V3_GITHUB_PRIMARY_CRON_BOUNDARY_SKEW_MS = 60_000;
export const SUCCESSOR_V3_GITHUB_PRIMARY_CRON_BOUNDARY_NORMALIZATION =
  'GITHUB_PRIMARY_CRON_BOUNDARY_SKEW';

function add(blockers, code) {
  if (!blockers.includes(code)) blockers.push(code);
}

function integer(value) {
  return Number.isInteger(value);
}

function exactSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
}

function exactDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function exactUtcCron(minute) {
  return `${minute} * * * *`;
}

function splitForIndex(slotIndex, splits = TEMPLATE.policyCore.splits) {
  if (!integer(slotIndex) || slotIndex < 0 || slotIndex >= 1024) {
    throw new Error('SUCCESSOR_V3_SLOT_INDEX_INVALID');
  }
  for (const name of ['TRAIN', 'VALIDATION', 'OOS']) {
    const split = splits[name];
    if (slotIndex >= split.startIndexInclusive && slotIndex <= split.endIndexInclusive) {
      return name;
    }
  }
  throw new Error('SUCCESSOR_V3_SLOT_SPLIT_UNBOUND');
}

function loadActivationBinding() {
  if (!existsSync(SUCCESSOR_SCHEDULE_RELIABILITY_V3_ACTIVATION_PATH)) return null;
  return JSON.parse(
    readFileSync(SUCCESSOR_SCHEDULE_RELIABILITY_V3_ACTIVATION_PATH, 'utf8'),
  );
}

function verifyActivationBinding(binding, template = TEMPLATE) {
  const blockers = [];
  if (!binding || typeof binding !== 'object') {
    return Object.freeze({
      valid: false,
      blockers: Object.freeze(['SUCCESSOR_V3_ACTIVATION_BINDING_MISSING']),
    });
  }
  const cohort = template.policyCore.cohortTemplate;
  if (binding.schemaVersion !== ACTIVATION_SCHEMA) {
    add(blockers, 'SUCCESSOR_V3_ACTIVATION_SCHEMA_INVALID');
  }
  if (binding.authorityIssue !== 23) {
    add(blockers, 'SUCCESSOR_V3_ACTIVATION_AUTHORITY_ISSUE_INVALID');
  }
  if (!integer(binding.authorityCommentId) || binding.authorityCommentId <= 0) {
    add(blockers, 'SUCCESSOR_V3_ACTIVATION_COMMENT_ID_INVALID');
  }
  if (!integer(binding.activationBoundaryMs) || binding.activationBoundaryMs < 0) {
    add(blockers, 'SUCCESSOR_V3_ACTIVATION_BOUNDARY_INVALID');
  }
  if (!integer(binding.cutoverStartMs) || binding.cutoverStartMs < 0) {
    add(blockers, 'SUCCESSOR_V3_CUTOVER_START_INVALID');
  }
  if (!exactSha(binding.authorizedCurrentMainSha)) {
    add(blockers, 'SUCCESSOR_V3_ACTIVATION_MAIN_SHA_INVALID');
  }
  if (binding.numericFreezeSha256 !== EXPECTED_NUMERIC_FREEZE_SHA256) {
    add(blockers, 'SUCCESSOR_V3_ACTIVATION_NUMERIC_FREEZE_MISMATCH');
  }
  if (binding.minActivationLeadSlots !== cohort.minActivationLeadSlots) {
    add(blockers, 'SUCCESSOR_V3_ACTIVATION_LEAD_SLOT_MISMATCH');
  }
  if (binding.priorV2CreditImported !== 0
    || binding.priorV2MissedSlotRecovery !== 0
    || binding.priorV2DiagnosticArtifactCredit !== 0
    || binding.replayCredit !== 0
    || binding.backfillCredit !== 0
    || binding.syntheticCredit !== 0) {
    add(blockers, 'SUCCESSOR_V3_ACTIVATION_RETROACTIVE_CREDIT_FORBIDDEN');
  }

  if (integer(binding.activationBoundaryMs)
    && integer(binding.cutoverStartMs)
    && binding.cutoverStartMs
      < binding.activationBoundaryMs + (cohort.minActivationLeadSlots * cohort.slotCadenceMs)) {
    add(blockers, 'SUCCESSOR_V3_CUTOVER_LEAD_TOO_SHORT');
  }
  if (integer(binding.cutoverStartMs)
    && binding.cutoverStartMs % cohort.slotCadenceMs !== 17 * 60_000) {
    add(blockers, 'SUCCESSOR_V3_CUTOVER_NOT_ALIGNED_TO_PRIMARY_MINUTE');
  }
  if (integer(binding.activationBoundaryMs)
    && binding.activationBoundaryMs < template.authority.humanApprovalCreatedAtMs) {
    add(blockers, 'SUCCESSOR_V3_ACTIVATION_PREDATES_NUMERIC_FREEZE');
  }

  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

function materializedSplits(startInclusiveMs, template = TEMPLATE) {
  const cadence = template.policyCore.cohortTemplate.slotCadenceMs;
  const splits = {};
  for (const name of ['TRAIN', 'VALIDATION', 'OOS']) {
    const source = template.policyCore.splits[name];
    splits[name] = Object.freeze({
      ...source,
      startInclusiveMs:
        startInclusiveMs == null
          ? null
          : startInclusiveMs + source.startIndexInclusive * cadence,
      endExclusiveMs:
        startInclusiveMs == null
          ? null
          : startInclusiveMs + (source.endIndexInclusive + 1) * cadence,
    });
  }
  return Object.freeze({
    mode: template.policyCore.splits.mode,
    TRAIN: splits.TRAIN,
    VALIDATION: splits.VALIDATION,
    OOS: splits.OOS,
  });
}

export function materializeSuccessorScheduleReliabilityV3Contract(
  activationBinding = null,
  template = TEMPLATE,
) {
  const cohortTemplate = template.policyCore.cohortTemplate;
  const activationVerdict =
    activationBinding == null
      ? Object.freeze({
          valid: false,
          blockers: Object.freeze(['SUCCESSOR_V3_ACTIVATION_BINDING_MISSING']),
        })
      : verifyActivationBinding(activationBinding, template);
  const activationBound = activationVerdict.valid === true;

  const startInclusiveMs = activationBound ? activationBinding.cutoverStartMs : null;
  const endExclusiveMs =
    startInclusiveMs == null
      ? null
      : startInclusiveMs + cohortTemplate.totalSlotN * cohortTemplate.slotCadenceMs;
  const splits = materializedSplits(startInclusiveMs, template);

  const cohort = Object.freeze({
    ...cohortTemplate,
    activationBindingStatus: activationBound
      ? 'BOUND_BY_SEPARATE_AUTHORITY'
      : 'PENDING_SEPARATE_AUTHORITY',
    startInclusiveMs,
    endExclusiveMs,
  });

  const policyCore = Object.freeze({
    schemaVersion: template.policyCore.schemaVersion,
    authority: Object.freeze({ ...template.authority }),
    supersedes: Object.freeze({ ...template.supersedes }),
    cohort,
    splits,
    creditPolicy: Object.freeze({ ...template.policyCore.creditPolicy }),
    prospectiveIntegrity: Object.freeze({ ...template.policyCore.prospectiveIntegrity }),
    oosBinding: Object.freeze({ ...template.policyCore.oosBinding }),
    workflowConcurrency: Object.freeze({ ...template.policyCore.workflowConcurrency }),
    technicalIdentity: SUCCESSOR_V2_PROSPECTIVE_CONTRACT.policyCore.technicalIdentity,
    safety: Object.freeze({ ...template.policyCore.safety }),
    activationBinding: activationBound
      ? Object.freeze({ ...activationBinding })
      : null,
  });
  const policyDigest = sha256(canonicalJson(policyCore));

  let cohortId = null;
  let cohortDigest = null;
  let cohortIdentityCore = null;
  if (activationBound) {
    cohortId = `${cohort.identitySeed}:${policyDigest}`;
    cohortIdentityCore = Object.freeze({
      schemaVersion:
        'public-forward-liquidity-successor-schedule-reliability-cohort-identity-v3',
      cohortId,
      policyDigest,
      startInclusiveMs,
      endExclusiveMs,
      slotCadenceMs: cohort.slotCadenceMs,
      totalSlotN: cohort.totalSlotN,
      triggerMinutesUtc: [...cohort.triggerMinutesUtc],
      splits,
    });
    cohortDigest = sha256(canonicalJson(cohortIdentityCore));
  }

  return Object.freeze({
    contractVersion: template.contractVersion,
    freezeStatus: template.freezeStatus,
    numericFreezeSha256: template.authority.canonicalNumericFreezeSha256,
    activationBound,
    activationBlockers: Object.freeze([...activationVerdict.blockers]),
    policyCore,
    policyDigest,
    cohortId,
    cohortDigest,
    cohortIdentityCore,
  });
}

export const SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT =
  materializeSuccessorScheduleReliabilityV3Contract(loadActivationBinding());

export function verifySuccessorScheduleReliabilityV3Contract(
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  template = TEMPLATE,
) {
  const blockers = [];
  const v2Verdict = verifySuccessorV2ProspectiveContract();
  const oosVerdict = verifySuccessorOosOutcomeHorizonContract();

  if (!v2Verdict.valid) add(blockers, 'SUCCESSOR_V3_V2_BASE_CONTRACT_INVALID');
  if (!oosVerdict.valid) add(blockers, 'SUCCESSOR_V3_OOS_BASE_CONTRACT_INVALID');
  if (SUCCESSOR_V2_PROSPECTIVE_CONTRACT.policyDigest !== EXPECTED_V2_POLICY_DIGEST
    || SUCCESSOR_V2_PROSPECTIVE_CONTRACT.cohortDigest !== EXPECTED_V2_COHORT_DIGEST) {
    add(blockers, 'SUCCESSOR_V3_V2_BASE_IDENTITY_MISMATCH');
  }
  if (template.contractVersion
    !== 'public-forward-liquidity-successor-schedule-reliability-contract-v3') {
    add(blockers, 'SUCCESSOR_V3_CONTRACT_VERSION_INVALID');
  }
  if (template.freezeStatus
    !== 'HUMAN_NUMERIC_FREEZE_APPROVED_IMPLEMENTATION_INACTIVE') {
    add(blockers, 'SUCCESSOR_V3_FREEZE_STATUS_INVALID');
  }
  if (template.authority.canonicalHubIssue !== 838
    || template.authority.releaseControlIssue !== 23
    || template.authority.humanApprovalCommentId !== 5517324618
    || template.authority.humanApprovalCreatedAt !== '2026-09-02T22:28:47Z'
    || template.authority.humanApprovalCreatedAtMs !== 1788388127000
    || template.authority.sourceMainSha !== 'e77f077be73ebcd37fa0e725212f566c45c6a7e4'
    || template.authority.canonicalNumericFreezeSha256 !== EXPECTED_NUMERIC_FREEZE_SHA256
    || template.authority.marketOutcomeConsulted !== false
    || template.authority.profitabilityOutcomeConsulted !== false
    || template.authority.aiNumericAuthority !== 'NONE'
    || template.authority.humanFinalNumericAuthority !== true) {
    add(blockers, 'SUCCESSOR_V3_NUMERIC_FREEZE_AUTHORITY_INVALID');
  }
  if (template.supersedes.policyDigest !== EXPECTED_V2_POLICY_DIGEST
    || template.supersedes.cohortDigest !== EXPECTED_V2_COHORT_DIGEST
    || template.supersedes.v2MutationAllowed !== false
    || template.supersedes.retroactiveReclassificationAllowed !== false
    || template.supersedes.priorV2CreditImported !== 0
    || template.supersedes.priorV2MissedSlotRecovery !== 0
    || template.supersedes.priorV2DiagnosticArtifactCredit !== 0) {
    add(blockers, 'SUCCESSOR_V3_SUPERSESSION_BOUNDARY_INVALID');
  }

  const cohort = template.policyCore.cohortTemplate;
  if (cohort.slotCadenceMs !== 3_600_000
    || canonicalJson(cohort.triggerMinutesUtc) !== canonicalJson([17, 27, 37])
    || canonicalJson(cohort.scheduleExpressionsUtc)
      !== canonicalJson([exactUtcCron(17), exactUtcCron(27), exactUtcCron(37)])
    || cohort.scheduledAttemptNPerSlot !== 3
    || cohort.allowedStartDelayMs !== 2_700_000
    || cohort.allowedCompletionDelayMs !== 600_000
    || cohort.hardSafetyGapMs !== 300_000
    || cohort.totalSlotN !== 1024
    || cohort.minActivationLeadSlots !== 1
    || cohort.startInclusiveMs !== null
    || cohort.endExclusiveMs !== null) {
    add(blockers, 'SUCCESSOR_V3_FROZEN_RELIABILITY_NUMBERS_INVALID');
  }
  if (cohort.allowedStartDelayMs
      + cohort.allowedCompletionDelayMs
      + cohort.hardSafetyGapMs !== cohort.slotCadenceMs) {
    add(blockers, 'SUCCESSOR_V3_SLOT_WINDOW_ACCOUNTING_INVALID');
  }

  const splits = template.policyCore.splits;
  if (splits.mode !== 'CHRONOLOGICAL_IMMUTABLE_SLOT_RANGE'
    || splits.TRAIN.startIndexInclusive !== 0
    || splits.TRAIN.endIndexInclusive !== 511
    || splits.TRAIN.expectedSlotN !== 512
    || splits.VALIDATION.startIndexInclusive !== 512
    || splits.VALIDATION.endIndexInclusive !== 767
    || splits.VALIDATION.expectedSlotN !== 256
    || splits.OOS.startIndexInclusive !== 768
    || splits.OOS.endIndexInclusive !== 1023
    || splits.OOS.expectedSlotN !== 256) {
    add(blockers, 'SUCCESSOR_V3_SPLITS_INVALID');
  }

  const credits = template.policyCore.creditPolicy;
  if (credits.prospectiveCreditPerEligiblePresentFirstAttempt !== 1
    || credits.manualCredit !== 0
    || credits.replayCredit !== 0
    || credits.backfillCredit !== 0
    || credits.syntheticCredit !== 0
    || credits.operatorSelectedCredit !== 0
    || credits.duplicateOrRerunCredit !== 0
    || credits.missedSlotCredit !== 0
    || credits.priorV2CreditImported !== 0) {
    add(blockers, 'SUCCESSOR_V3_CREDIT_POLICY_INVALID');
  }

  if (template.policyCore.workflowConcurrency.queue !== 'max'
    || template.policyCore.workflowConcurrency.cancelInProgress !== false) {
    add(blockers, 'SUCCESSOR_V3_CONCURRENCY_POLICY_INVALID');
  }
  if (template.policyCore.oosBinding.outcomeHorizonMs !== 5_000
    || template.policyCore.oosBinding.outcomeHorizonRetuned !== false
    || SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeHorizonMs !== 5_000
    || template.policyCore.oosBinding.outcomeSelectionPolicy
      !== SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeSelectionPolicy) {
    add(blockers, 'SUCCESSOR_V3_OOS_REBINDING_INVARIANT_INVALID');
  }

  const safety = template.policyCore.safety;
  if (safety.executionAuthority !== 'NONE'
    || safety.privateTradingApiAllowed !== false
    || safety.liveTradingAllowed !== false
    || safety.autoTradingAllowed !== false
    || safety.realOrderAllowed !== false
    || safety.financialMutationAllowed !== false
    || safety.replitAgentAllowed !== false
    || safety.fullCostReady !== false
    || safety.evidenceComplete !== 0
    || safety.profitabilityProven !== false
    || safety.currentValidatedChampion !== 'NONE') {
    add(blockers, 'SUCCESSOR_V3_SAFETY_BOUNDARY_INVALID');
  }

  if (!exactDigest(contract.policyDigest)
    || contract.numericFreezeSha256 !== EXPECTED_NUMERIC_FREEZE_SHA256) {
    add(blockers, 'SUCCESSOR_V3_MATERIALIZED_IDENTITY_INVALID');
  }

  for (const blocker of contract.activationBlockers ?? []) {
    if (blocker !== 'SUCCESSOR_V3_ACTIVATION_BINDING_MISSING') add(blockers, blocker);
  }

  if (contract.activationBound === true) {
    const activationVerdict = verifyActivationBinding(
      contract.policyCore.activationBinding,
      template,
    );
    if (!activationVerdict.valid) {
      for (const blocker of activationVerdict.blockers) add(blockers, blocker);
    }
    if (!exactDigest(contract.cohortDigest) || !contract.cohortId) {
      add(blockers, 'SUCCESSOR_V3_ACTIVE_COHORT_IDENTITY_INVALID');
    }
  } else {
    if (contract.cohortId !== null
      || contract.cohortDigest !== null
      || contract.cohortIdentityCore !== null
      || contract.policyCore.cohort.startInclusiveMs !== null
      || contract.policyCore.cohort.endExclusiveMs !== null) {
      add(blockers, 'SUCCESSOR_V3_INACTIVE_COHORT_MUST_BE_UNBOUND');
    }
  }

  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
    activationBound: contract.activationBound === true,
    activationBlockers: Object.freeze([...contract.activationBlockers]),
    policyDigest: contract.policyDigest,
    cohortDigest: contract.cohortDigest,
  });
}

export function buildSuccessorScheduleReliabilityV3SlotDescriptor(
  slotIndex,
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
) {
  if (contract.activationBound !== true) {
    throw new Error('SUCCESSOR_V3_ACTIVATION_BINDING_MISSING');
  }
  const cohort = contract.policyCore.cohort;
  if (!integer(slotIndex) || slotIndex < 0 || slotIndex >= cohort.totalSlotN) {
    throw new Error('SUCCESSOR_V3_SLOT_INDEX_INVALID');
  }
  const split = splitForIndex(slotIndex, contract.policyCore.splits);
  const nominalScheduledAtMs =
    cohort.startInclusiveMs + slotIndex * cohort.slotCadenceMs;
  const slotEndExclusiveMs = nominalScheduledAtMs + cohort.slotCadenceMs;
  const allowedStartThroughMs =
    nominalScheduledAtMs + cohort.allowedStartDelayMs;
  const latestCompletionIfLatestEligibleStartMs =
    allowedStartThroughMs + cohort.allowedCompletionDelayMs;
  return Object.freeze({
    slotIndex,
    split,
    nominalScheduledAtMs,
    slotEndExclusiveMs,
    allowedStartThroughMs,
    latestCompletionIfLatestEligibleStartMs,
    hardSafetyGapMs: cohort.hardSafetyGapMs,
    triggerMinutesUtc: Object.freeze([...cohort.triggerMinutesUtc]),
    scheduleExpressionsUtc: Object.freeze([...cohort.scheduleExpressionsUtc]),
    canonicalSlotKey: Object.freeze({
      policyDigest: contract.policyDigest,
      cohortDigest: contract.cohortDigest,
      slotIndex,
    }),
  });
}

export function normalizeSuccessorV3GithubScheduleCreatedAt({
  scheduleExpression,
  scheduledRunCreatedAtMs,
  actualRunStartedAtMs,
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} = {}) {
  const rawCreatedAtMs = Number(scheduledRunCreatedAtMs);
  const actual = Number(actualRunStartedAtMs);
  if (!Number.isInteger(rawCreatedAtMs) || rawCreatedAtMs < 0) {
    throw new Error('SUCCESSOR_V3_GITHUB_CREATED_AT_INVALID');
  }
  if (!Number.isInteger(actual) || actual < 0) {
    throw new Error('SUCCESSOR_V3_GITHUB_ACTUAL_START_INVALID');
  }

  const unchanged = () => Object.freeze({
    rawCreatedAtMs,
    authorityCreatedAtMs: rawCreatedAtMs,
    boundaryNormalized: false,
    normalization: null,
  });
  if (contract.activationBound !== true
    || String(scheduleExpression ?? '').trim() !== exactUtcCron(17)) {
    return unchanged();
  }

  const cohort = contract.policyCore.cohort;
  if (actual < cohort.startInclusiveMs || actual >= cohort.endExclusiveMs) {
    return unchanged();
  }
  const slotIndex = Math.floor(
    (actual - cohort.startInclusiveMs) / cohort.slotCadenceMs,
  );
  if (!integer(slotIndex) || slotIndex < 0 || slotIndex >= cohort.totalSlotN) {
    return unchanged();
  }
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(slotIndex, contract);
  const earlyByMs = slot.nominalScheduledAtMs - rawCreatedAtMs;
  if (rawCreatedAtMs > actual
    || earlyByMs <= 0
    || earlyByMs >= SUCCESSOR_V3_GITHUB_PRIMARY_CRON_BOUNDARY_SKEW_MS) {
    return unchanged();
  }

  return Object.freeze({
    rawCreatedAtMs,
    authorityCreatedAtMs: slot.nominalScheduledAtMs,
    boundaryNormalized: true,
    normalization: SUCCESSOR_V3_GITHUB_PRIMARY_CRON_BOUNDARY_NORMALIZATION,
  });
}

export function bindSuccessorV3GithubScheduleMetadataReceipt({
  captureReceipt,
  scheduleMetadata,
} = {}) {
  if (!captureReceipt || typeof captureReceipt !== 'object') {
    throw new Error('SUCCESSOR_V3_CAPTURE_RECEIPT_MISSING');
  }
  if (!scheduleMetadata || typeof scheduleMetadata !== 'object') {
    throw new Error('SUCCESSOR_V3_GITHUB_SCHEDULE_METADATA_MISSING');
  }
  if (scheduleMetadata.boundaryNormalized !== true) return captureReceipt;
  if (captureReceipt.scheduledRunCreatedAtMs !== scheduleMetadata.authorityCreatedAtMs) {
    throw new Error('SUCCESSOR_V3_GITHUB_AUTHORITY_CREATED_AT_MISMATCH');
  }
  const { captureReceiptDigest: _previousDigest, ...body } = captureReceipt;
  const reboundBody = Object.freeze({
    ...body,
    scheduledRunCreatedAtRawMs: scheduleMetadata.rawCreatedAtMs,
    scheduledRunCreatedAtBoundaryNormalized: true,
    scheduledRunCreatedAtNormalization: scheduleMetadata.normalization,
  });
  return Object.freeze({
    ...reboundBody,
    captureReceiptDigest: sha256(canonicalJson(reboundBody)),
  });
}

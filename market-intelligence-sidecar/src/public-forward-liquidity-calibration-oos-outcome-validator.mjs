import { createHash } from 'node:crypto';

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
} from './public-forward-liquidity-calibration.mjs';
import { PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_VERSION } from './public-forward-liquidity-calibration-split-audit.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_VERSION =
  'public-forward-liquidity-calibration-oos-validation-v1';

export const PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY = Object.freeze({
  verifiedFrozenSplitAuditRequired: true,
  exactOosCoverageRequired: true,
  genuinePublicForwardMarketDataRequired: true,
  methodologyFrozenBeforeOosRequired: true,
  oosDataAccessBeforeFreezeAllowed: false,
  historicalBackfillCreditAllowed: false,
  testFixtureRuntimeCreditAllowed: false,
  causalMarketImpactClaimAllowed: false,
  outcomeExecutionCostEligible: false,
  calibrationArtifactProduced: false,
  liquidityImpactProduced: false,
  naturalEntryCredit: 0,
  runtimeCostCredit: 0,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
  fullCostReady: false,
});

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 && normalized.length <= 240 ? normalized : null;
}

function exactDigest(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && SHA256.test(normalized) ? normalized : null;
}

function exactCommitSha(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && COMMIT_SHA.test(normalized) ? normalized : null;
}

function positiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_NUMBER_NOT_CANONICAL');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) throw new TypeError('UNSUPPORTED_CANONICAL_VALUE');
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function withoutKey(value, omittedKey) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== omittedKey));
}

export function computePublicForwardLiquidityOosMethodologyDigest(methodology) {
  if (!object(methodology)) throw new TypeError('OOS_METHODOLOGY_REQUIRED');
  return sha256(withoutKey(methodology, 'methodologyDigest'));
}

function add(list, code) {
  if (!list.includes(code)) list.push(code);
}

function blocked(blockers) {
  return Object.freeze({
    status: 'BLOCKED_DATA',
    blockers: Object.freeze([...new Set(blockers)]),
    validation: null,
    safety: PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY,
  });
}

function validateSplitAudit(audit) {
  const blockers = [];
  if (!object(audit)) return ['SPLIT_AUDIT_REQUIRED'];
  if (audit.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_VERSION) add(blockers, 'SPLIT_AUDIT_VERSION_INVALID');
  if (audit.datasetContract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT
    || audit.datasetStoreContract !== PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT) {
    add(blockers, 'SPLIT_AUDIT_DATASET_CONTRACT_INVALID');
  }
  if (audit.sampleClass !== FORWARD_NATURAL_SAMPLE) add(blockers, 'SPLIT_AUDIT_FORWARD_SAMPLE_REQUIRED');
  if (!exactDigest(audit.datasetDigest)) add(blockers, 'SPLIT_AUDIT_DATASET_DIGEST_INVALID');
  if (!exactCommitSha(audit.collectorCodeSha)) add(blockers, 'SPLIT_AUDIT_COLLECTOR_SHA_INVALID');
  if (!exactDigest(audit.splitPolicyDigest)) add(blockers, 'SPLIT_POLICY_DIGEST_INVALID');
  if (!text(audit.splitPolicyIdentity) || !text(audit.splitPolicyVersion)) add(blockers, 'SPLIT_POLICY_IDENTITY_INVALID');
  if (!positiveFinite(audit.splitPolicyFrozenAtMs)) add(blockers, 'SPLIT_POLICY_FROZEN_AT_INVALID');
  if (!Array.isArray(audit.assignments) || audit.assignments.length === 0) add(blockers, 'SPLIT_ASSIGNMENTS_REQUIRED');
  if (!exactDigest(audit.assignmentDigest)) add(blockers, 'SPLIT_ASSIGNMENT_DIGEST_INVALID');
  else if (Array.isArray(audit.assignments) && audit.assignmentDigest !== sha256(audit.assignments)) {
    add(blockers, 'SPLIT_ASSIGNMENT_DIGEST_MISMATCH');
  }
  if (!exactDigest(audit.auditDigest)) add(blockers, 'SPLIT_AUDIT_DIGEST_INVALID');
  else if (audit.auditDigest !== sha256(withoutKey(audit, 'auditDigest'))) add(blockers, 'SPLIT_AUDIT_DIGEST_MISMATCH');
  if (audit.regimeScopeComplete !== true) add(blockers, 'REGIME_SCOPE_INCOMPLETE');
  if (audit.splitAssignmentComplete !== true) add(blockers, 'SPLIT_ASSIGNMENT_INCOMPLETE');
  if (audit.calibrationSampleSufficient !== true) add(blockers, 'CALIBRATION_SAMPLE_INSUFFICIENT');
  if (audit.oosValidationComplete !== false) add(blockers, 'UPSTREAM_OOS_VALIDATION_STATE_INVALID');
  if (audit.calibrationArtifactProduced !== false || audit.liquidityImpactPresent !== false) {
    add(blockers, 'UPSTREAM_LIQUIDITY_COST_BOUNDARY_INVALID');
  }
  if (audit.liquidityImpactStatus !== 'BLOCKED_DATA' || audit.fullCostReady !== false) {
    add(blockers, 'UPSTREAM_FULL_COST_BOUNDARY_INVALID');
  }
  if (audit.naturalEntryCredit !== 0 || audit.runtimeCostCredit !== 0) add(blockers, 'UPSTREAM_RUNTIME_CREDIT_INVALID');
  if (audit.executionAuthority !== 'NONE' || audit.privateApiUsed !== false
    || audit.liveTrading !== false || audit.orderSubmitted !== false) {
    add(blockers, 'UPSTREAM_EXECUTION_SAFETY_INVALID');
  }
  return blockers;
}

function validateMethodology(methodology, earliestOosEventMs) {
  const blockers = [];
  if (!object(methodology)) return ['OOS_METHODOLOGY_REQUIRED'];
  if (!text(methodology.methodologyIdentity)) add(blockers, 'OOS_METHODOLOGY_IDENTITY_INVALID');
  if (!exactDigest(methodology.methodologyDigest)) add(blockers, 'OOS_METHODOLOGY_DIGEST_INVALID');
  else if (methodology.methodologyDigest !== computePublicForwardLiquidityOosMethodologyDigest(methodology)) {
    add(blockers, 'OOS_METHODOLOGY_DIGEST_MISMATCH');
  }
  if (!positiveFinite(methodology.methodologyFrozenAtMs)) add(blockers, 'OOS_METHODOLOGY_FROZEN_AT_INVALID');
  if (positiveFinite(methodology.methodologyFrozenAtMs)
    && positiveFinite(earliestOosEventMs)
    && methodology.methodologyFrozenAtMs > earliestOosEventMs) {
    add(blockers, 'OOS_METHODOLOGY_NOT_FROZEN_BEFORE_OOS');
  }
  if (methodology.oosDataAccessBeforeFreeze !== false) add(blockers, 'OOS_PRE_FREEZE_DATA_ACCESS_FORBIDDEN');
  if (!Array.isArray(methodology.allowedCalibrationSplits)
    || methodology.allowedCalibrationSplits.length !== 2
    || methodology.allowedCalibrationSplits[0] !== 'TRAIN'
    || methodology.allowedCalibrationSplits[1] !== 'VALIDATION') {
    add(blockers, 'OOS_CALIBRATION_SPLITS_INVALID');
  }
  if (!text(methodology.outcomeHorizonIdentity)) add(blockers, 'OOS_HORIZON_IDENTITY_INVALID');
  return blockers;
}

function validateAssignment(assignment) {
  const blockers = [];
  if (!object(assignment)) return ['OOS_ASSIGNMENT_INVALID'];
  if (!text(assignment.observationId)) add(blockers, 'OOS_ASSIGNMENT_OBSERVATION_ID_INVALID');
  if (!exactDigest(assignment.sourceDigest)) add(blockers, 'OOS_ASSIGNMENT_SOURCE_DIGEST_INVALID');
  if (!text(assignment.publicExecutionId)) add(blockers, 'OOS_ASSIGNMENT_PUBLIC_EXECUTION_ID_INVALID');
  if (!positiveFinite(assignment.eventTimestampMs)) add(blockers, 'OOS_ASSIGNMENT_EVENT_TIMESTAMP_INVALID');
  if (assignment.split !== 'OOS') add(blockers, 'NON_OOS_ASSIGNMENT_FORBIDDEN');
  if (!text(assignment.scopeKey)) add(blockers, 'OOS_ASSIGNMENT_SCOPE_KEY_INVALID');
  if (!text(assignment.quantityNotionalBucketIdentity)) add(blockers, 'OOS_ASSIGNMENT_BUCKET_INVALID');
  if (!text(assignment.volatilityRegimeIdentity) || !text(assignment.liquidityRegimeIdentity)) {
    add(blockers, 'OOS_ASSIGNMENT_REGIME_INVALID');
  }
  return blockers;
}

function validateOutcome(outcome, assignment, audit, methodology, expectedOutcomeProducerCodeSha) {
  const blockers = [];
  if (!object(outcome)) return ['OOS_OUTCOME_INVALID'];
  if (!text(outcome.outcomeId)) add(blockers, 'OOS_OUTCOME_ID_INVALID');
  if (outcome.observationId !== assignment.observationId) add(blockers, 'OOS_OBSERVATION_ID_MISMATCH');
  if (outcome.referenceSourceDigest !== assignment.sourceDigest) add(blockers, 'OOS_REFERENCE_SOURCE_DIGEST_MISMATCH');
  if (outcome.publicExecutionId !== assignment.publicExecutionId) add(blockers, 'OOS_PUBLIC_EXECUTION_ID_MISMATCH');
  if (outcome.splitAuditDigest !== audit.auditDigest) add(blockers, 'OOS_SPLIT_AUDIT_DIGEST_MISMATCH');
  if (outcome.datasetDigest !== audit.datasetDigest) add(blockers, 'OOS_DATASET_DIGEST_MISMATCH');
  if (outcome.splitPolicyDigest !== audit.splitPolicyDigest) add(blockers, 'OOS_SPLIT_POLICY_DIGEST_MISMATCH');
  if (outcome.scopeKey !== assignment.scopeKey) add(blockers, 'OOS_SCOPE_KEY_MISMATCH');
  if (outcome.referenceEventTimestampMs !== assignment.eventTimestampMs) add(blockers, 'OOS_EVENT_TIMESTAMP_MISMATCH');
  if (!positiveFinite(outcome.observedAtMs) || outcome.observedAtMs <= assignment.eventTimestampMs) {
    add(blockers, 'OOS_OUTCOME_NOT_OBSERVED_AFTER_EVENT');
  }
  if (outcome.sourceType !== 'PUBLIC_FORWARD_MARKET_DATA') add(blockers, 'OOS_SOURCE_TYPE_INVALID');
  if (!text(outcome.publicDataSource)) add(blockers, 'OOS_PUBLIC_DATA_SOURCE_INVALID');
  if (!text(outcome.outcomeSourceIdentity)) add(blockers, 'OOS_OUTCOME_SOURCE_IDENTITY_INVALID');
  if (!exactDigest(outcome.outcomeSourceDigest)) add(blockers, 'OOS_OUTCOME_SOURCE_DIGEST_INVALID');
  if (!exactCommitSha(outcome.outcomeProducerCodeSha)
    || outcome.outcomeProducerCodeSha !== expectedOutcomeProducerCodeSha) {
    add(blockers, 'OOS_OUTCOME_PRODUCER_SHA_MISMATCH');
  }
  if (!positiveFinite(outcome.observedPublicMidPrice)) add(blockers, 'OOS_PUBLIC_MID_PRICE_INVALID');
  if (outcome.methodologyIdentity !== methodology.methodologyIdentity) add(blockers, 'OOS_METHODOLOGY_IDENTITY_MISMATCH');
  if (outcome.methodologyDigest !== methodology.methodologyDigest) add(blockers, 'OOS_METHODOLOGY_DIGEST_MISMATCH');
  if (outcome.methodologyFrozenAtMs !== methodology.methodologyFrozenAtMs) add(blockers, 'OOS_METHODOLOGY_FROZEN_AT_MISMATCH');
  if (outcome.outcomeHorizonIdentity !== methodology.outcomeHorizonIdentity) add(blockers, 'OOS_HORIZON_IDENTITY_MISMATCH');
  if (outcome.heldOut !== true) add(blockers, 'OOS_OUTCOME_NOT_HELD_OUT');
  if (outcome.contaminationFree !== true) add(blockers, 'OOS_OUTCOME_CONTAMINATED');
  if (outcome.causalMarketImpactClaim !== false) add(blockers, 'OOS_CAUSAL_MARKET_IMPACT_CLAIM_FORBIDDEN');
  if (outcome.executionCostEligible !== false) add(blockers, 'OOS_EXECUTION_COST_CREDIT_FORBIDDEN');
  if (outcome.liquidityImpactCoefficient !== null) add(blockers, 'OOS_LIQUIDITY_COEFFICIENT_FORBIDDEN');
  if (outcome.historicalBackfillCredit !== 0 || outcome.testFixtureCredit !== 0) add(blockers, 'OOS_NON_FORWARD_CREDIT_FORBIDDEN');
  if (outcome.naturalEntryCredit !== 0 || outcome.runtimeCostCredit !== 0) add(blockers, 'OOS_RUNTIME_CREDIT_FORBIDDEN');
  return blockers;
}

export function validatePublicForwardLiquidityOosOutcomes({
  splitAudit,
  outcomes = [],
  methodology,
  expectedOutcomeProducerCodeSha,
} = {}) {
  const auditBlockers = validateSplitAudit(splitAudit);
  if (auditBlockers.length > 0) return blocked(auditBlockers);
  if (!exactCommitSha(expectedOutcomeProducerCodeSha)) return blocked(['OOS_OUTCOME_PRODUCER_SHA_INVALID']);

  const oosAssignments = splitAudit.assignments.filter((assignment) => assignment.split === 'OOS');
  if (oosAssignments.length === 0) return blocked(['OOS_ASSIGNMENTS_MISSING']);
  const assignmentBlockers = [];
  oosAssignments.forEach((assignment) => validateAssignment(assignment).forEach((code) => add(assignmentBlockers, code)));
  if (assignmentBlockers.length > 0) return blocked(assignmentBlockers);

  const earliestOosEventMs = Math.min(...oosAssignments.map((assignment) => assignment.eventTimestampMs));
  const methodologyBlockers = validateMethodology(methodology, earliestOosEventMs);
  if (methodologyBlockers.length > 0) return blocked(methodologyBlockers);
  if (!Array.isArray(outcomes) || outcomes.length === 0) return blocked(['OOS_OUTCOMES_MISSING']);

  const assignmentsByObservationId = new Map(oosAssignments.map((assignment) => [assignment.observationId, assignment]));
  const outcomeIds = new Set();
  const outcomeByObservationId = new Map();
  const outcomeSourceDigests = new Set();
  const blockers = [];

  for (const outcome of outcomes) {
    if (outcomeIds.has(outcome?.outcomeId)) add(blockers, 'OOS_OUTCOME_ID_DUPLICATE');
    outcomeIds.add(outcome?.outcomeId);
    if (outcomeByObservationId.has(outcome?.observationId)) add(blockers, 'OOS_OUTCOME_DUPLICATE_OBSERVATION');
    outcomeByObservationId.set(outcome?.observationId, outcome);
    if (outcomeSourceDigests.has(outcome?.outcomeSourceDigest)) add(blockers, 'OOS_OUTCOME_SOURCE_DIGEST_REUSED');
    outcomeSourceDigests.add(outcome?.outcomeSourceDigest);
    const assignment = assignmentsByObservationId.get(outcome?.observationId);
    if (!assignment) {
      add(blockers, 'OOS_OUTCOME_ORPHAN');
      continue;
    }
    validateOutcome(outcome, assignment, splitAudit, methodology, expectedOutcomeProducerCodeSha)
      .forEach((code) => add(blockers, code));
  }
  for (const assignment of oosAssignments) {
    if (!outcomeByObservationId.has(assignment.observationId)) add(blockers, 'OOS_OUTCOME_MISSING');
  }
  if (outcomes.length !== oosAssignments.length) add(blockers, 'OOS_EXACT_COVERAGE_MISMATCH');
  if (blockers.length > 0) return blocked(blockers);

  const orderedOutcomes = [...outcomes].sort((left, right) => left.observationId.localeCompare(right.observationId));
  const outcomeDigest = sha256(orderedOutcomes);
  const oosAssignmentDigest = sha256(oosAssignments);
  const validationBody = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_VERSION,
    splitAuditDigest: splitAudit.auditDigest,
    datasetContract: splitAudit.datasetContract,
    datasetStoreContract: splitAudit.datasetStoreContract,
    datasetDigest: splitAudit.datasetDigest,
    collectorCodeSha: splitAudit.collectorCodeSha,
    sampleClass: splitAudit.sampleClass,
    splitPolicyIdentity: splitAudit.splitPolicyIdentity,
    splitPolicyVersion: splitAudit.splitPolicyVersion,
    splitPolicyDigest: splitAudit.splitPolicyDigest,
    methodologyIdentity: methodology.methodologyIdentity,
    methodologyDigest: methodology.methodologyDigest,
    methodologyFrozenAtMs: methodology.methodologyFrozenAtMs,
    outcomeHorizonIdentity: methodology.outcomeHorizonIdentity,
    outcomeProducerCodeSha: expectedOutcomeProducerCodeSha,
    oosAssignmentCount: oosAssignments.length,
    scoredOutcomeCount: orderedOutcomes.length,
    oosAssignmentDigest,
    outcomeIds: Object.freeze(orderedOutcomes.map((outcome) => outcome.outcomeId)),
    outcomeDigest,
    exactOosCoverage: true,
    heldOut: true,
    contaminationFree: true,
    genuinePublicForwardMarketData: true,
    causalMarketImpactClaim: false,
    oosValidationComplete: true,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    fullCostReady: false,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  const validation = Object.freeze({ ...validationBody, validationDigest: sha256(validationBody) });
  return Object.freeze({
    status: 'PRESENT',
    blockers: Object.freeze([]),
    validation,
    safety: PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY,
  });
}

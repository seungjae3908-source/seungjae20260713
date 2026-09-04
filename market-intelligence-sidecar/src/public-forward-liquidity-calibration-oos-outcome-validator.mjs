import { createHash } from 'node:crypto';

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
} from './public-forward-liquidity-calibration.mjs';
import { PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_VERSION } from './public-forward-liquidity-calibration-split-audit.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_AUDIT_VERSION,
} from './public-forward-liquidity-multi-source-split-audit.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION,
} from './public-forward-liquidity-v3-independence-binding.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  buildSuccessorScheduleReliabilityV3SlotDescriptor,
  verifySuccessorScheduleReliabilityV3Contract,
} from './public-forward-liquidity-successor-schedule-reliability-v3.mjs';
import {
  SUCCESSOR_OOS_HORIZON_CONTRACT,
  verifySuccessorOosOutcomeHorizonContract,
} from './public-forward-liquidity-successor-oos-outcome-horizon.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_VERSION =
  'public-forward-liquidity-calibration-oos-validation-v1';
export const PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_OOS_VALIDATION_VERSION =
  'public-forward-liquidity-calibration-oos-validation-v2';
export const PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_RECEIPT_VERSION =
  'public-forward-liquidity-multi-source-split-receipt-v1';
export const PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION =
  'public-forward-liquidity-successor-v3-oos-validation-v1';

export const SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY = 'SUCCESSOR_SCHEDULE_RELIABILITY_V3';

export const PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY = Object.freeze({
  verifiedFrozenSplitAuditRequired: true,
  authenticatedMultiSourceSplitReceiptRequired: true,
  multiSourceLineageRequired: true,
  completeIngestReceiptChainRequired: true,
  syntheticAggregateDatasetAllowed: false,
  syntheticSingleCollectorAllowed: false,
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
  return normalized.length > 0 && normalized.length <= 320 ? normalized : null;
}

function exactDigest(value) {
  const normalized = text(value)?.replace(/^sha256:/u, '').toLowerCase() ?? null;
  return normalized && SHA256.test(normalized) ? normalized : null;
}

function exactCommitSha(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && COMMIT_SHA.test(normalized) ? normalized : null;
}

function positiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
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

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
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

function multiSource(audit) {
  return audit?.schemaVersion === PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_AUDIT_VERSION;
}

function validateChainArray(source, key, count, validator, code, blockers) {
  const values = source[key];
  if (!Array.isArray(values) || values.length !== count || values.some((value) => !validator(value))) {
    add(blockers, code);
  }
}

function validateUpstreamSource(source, blockers) {
  if (!object(source)) {
    add(blockers, 'UPSTREAM_SOURCE_INVALID');
    return;
  }
  if (!text(source.sourceIdentity)) add(blockers, 'UPSTREAM_SOURCE_IDENTITY_INVALID');
  if (!exactCommitSha(source.producerCodeSha)) add(blockers, 'UPSTREAM_SOURCE_PRODUCER_SHA_INVALID');
  if (!exactCommitSha(source.collectorCodeSha)) add(blockers, 'UPSTREAM_SOURCE_COLLECTOR_SHA_INVALID');
  if (!text(source.collectorImplementationPath)) add(blockers, 'UPSTREAM_SOURCE_COLLECTOR_PATH_INVALID');
  if (!exactCommitSha(source.collectorImplementationBlobSha)) add(blockers, 'UPSTREAM_SOURCE_COLLECTOR_BLOB_INVALID');
  if (!text(source.ingestReceiptChainVersion)) add(blockers, 'UPSTREAM_SOURCE_RECEIPT_CHAIN_VERSION_INVALID');
  if (!exactDigest(source.ingestReceiptChainDigest)) add(blockers, 'UPSTREAM_SOURCE_RECEIPT_CHAIN_DIGEST_INVALID');
  if (!positiveInteger(source.ingestReceiptCount)) add(blockers, 'UPSTREAM_SOURCE_RECEIPT_CHAIN_COUNT_INVALID');
  const count = positiveInteger(source.ingestReceiptCount) ? source.ingestReceiptCount : 0;
  validateChainArray(source, 'ingestReceiptDigests', count, exactDigest, 'UPSTREAM_SOURCE_RECEIPT_CHAIN_RECEIPTS_INVALID', blockers);
  validateChainArray(source, 'artifactIds', count, text, 'UPSTREAM_SOURCE_RECEIPT_CHAIN_ARTIFACT_IDS_INVALID', blockers);
  validateChainArray(source, 'artifactDigests', count, exactDigest, 'UPSTREAM_SOURCE_RECEIPT_CHAIN_ARTIFACT_DIGESTS_INVALID', blockers);
  validateChainArray(source, 'rawBatchDigests', count, exactDigest, 'UPSTREAM_SOURCE_RECEIPT_CHAIN_RAW_DIGESTS_INVALID', blockers);
  if (!exactDigest(source.datasetDigest)) add(blockers, 'UPSTREAM_SOURCE_DATASET_DIGEST_INVALID');
  if (!text(source.datasetRelativePath)) add(blockers, 'UPSTREAM_SOURCE_DATASET_PATH_INVALID');
  if (!exactDigest(source.receiptDigest)) add(blockers, 'UPSTREAM_SOURCE_RECEIPT_DIGEST_INVALID');
  if (!text(source.artifactId)) add(blockers, 'UPSTREAM_SOURCE_ARTIFACT_ID_INVALID');
  if (!exactDigest(source.artifactDigest)) add(blockers, 'UPSTREAM_SOURCE_ARTIFACT_DIGEST_INVALID');
  if (!exactDigest(source.rawBatchDigest)) add(blockers, 'UPSTREAM_SOURCE_RAW_BATCH_DIGEST_INVALID');
  if (Array.isArray(source.ingestReceiptDigests) && source.ingestReceiptDigests.at(-1) !== source.receiptDigest) {
    add(blockers, 'UPSTREAM_SOURCE_RECEIPT_CHAIN_FINAL_RECEIPT_MISMATCH');
  }
  if (Array.isArray(source.artifactIds) && source.artifactIds.at(-1) !== source.artifactId) {
    add(blockers, 'UPSTREAM_SOURCE_RECEIPT_CHAIN_FINAL_ARTIFACT_ID_MISMATCH');
  }
  if (Array.isArray(source.artifactDigests) && source.artifactDigests.at(-1) !== source.artifactDigest) {
    add(blockers, 'UPSTREAM_SOURCE_RECEIPT_CHAIN_FINAL_ARTIFACT_DIGEST_MISMATCH');
  }
  if (Array.isArray(source.rawBatchDigests) && source.rawBatchDigests.at(-1) !== source.rawBatchDigest) {
    add(blockers, 'UPSTREAM_SOURCE_RECEIPT_CHAIN_FINAL_RAW_DIGEST_MISMATCH');
  }
}

function validateMultiSourceLineage(audit, blockers) {
  if (!exactDigest(audit.independentSplitSourceDigest)) add(blockers, 'INDEPENDENT_SPLIT_SOURCE_DIGEST_INVALID');
  if (!exactDigest(audit.independenceAuditDigest)) add(blockers, 'INDEPENDENCE_AUDIT_DIGEST_INVALID');
  if (!exactCommitSha(audit.producerCodeSha)) add(blockers, 'MULTI_SOURCE_PRODUCER_SHA_INVALID');
  if (!Array.isArray(audit.upstreamSources) || audit.upstreamSources.length === 0) {
    add(blockers, 'UPSTREAM_SOURCES_REQUIRED');
    return;
  }
  audit.upstreamSources.forEach((source) => validateUpstreamSource(source, blockers));
  for (const key of ['sourceIdentity', 'ingestReceiptChainDigest', 'datasetDigest', 'receiptDigest', 'artifactId']) {
    const values = audit.upstreamSources.map((source) => source?.[key]);
    if (new Set(values).size !== values.length) add(blockers, `UPSTREAM_SOURCE_DUPLICATE:${key}`);
  }
  const ordered = [...audit.upstreamSources].sort((left, right) => left.sourceIdentity.localeCompare(right.sourceIdentity));
  const implementationBlobs = new Set(ordered.map((source) => source.collectorImplementationBlobSha));
  if (implementationBlobs.size !== 1) add(blockers, 'UPSTREAM_COLLECTOR_IMPLEMENTATION_COHORT_MISMATCH');
  if (!exactDigest(audit.upstreamLineageDigest)) add(blockers, 'UPSTREAM_LINEAGE_DIGEST_INVALID');
  else if (audit.upstreamLineageDigest !== sha256(ordered)) add(blockers, 'UPSTREAM_LINEAGE_DIGEST_MISMATCH');

  const datasetDigests = ordered.map((source) => source.datasetDigest);
  const receiptDigests = ordered.map((source) => source.receiptDigest);
  const receiptChainDigests = ordered.map((source) => source.ingestReceiptChainDigest);
  const receiptCounts = ordered.map((source) => source.ingestReceiptCount);
  const collectorCodeShas = [...new Set(ordered.map((source) => source.collectorCodeSha))].sort();
  if (!sameArray(audit.datasetDigests, datasetDigests)) add(blockers, 'UPSTREAM_DATASET_DIGESTS_MISMATCH');
  if (!sameArray(audit.receiptDigests, receiptDigests)) add(blockers, 'UPSTREAM_RECEIPT_DIGESTS_MISMATCH');
  if (!sameArray(audit.receiptChainDigests, receiptChainDigests)) add(blockers, 'UPSTREAM_RECEIPT_CHAIN_DIGESTS_MISMATCH');
  if (!sameArray(audit.receiptCounts, receiptCounts)) add(blockers, 'UPSTREAM_RECEIPT_COUNTS_MISMATCH');
  if (!sameArray(audit.collectorCodeShas, collectorCodeShas)) add(blockers, 'UPSTREAM_COLLECTOR_SHAS_MISMATCH');
  if (audit.datasetDigest !== undefined && audit.datasetDigest !== null) add(blockers, 'SYNTHETIC_AGGREGATE_DATASET_FORBIDDEN');
  if (audit.collectorCodeSha !== undefined && audit.collectorCodeSha !== null) add(blockers, 'SYNTHETIC_SINGLE_COLLECTOR_FORBIDDEN');
}

function validateMultiSourceReceipt(receipt, audit) {
  const blockers = [];
  if (!object(receipt)) return ['MULTI_SOURCE_SPLIT_RECEIPT_REQUIRED'];
  if (receipt.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_RECEIPT_VERSION) {
    add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_VERSION_INVALID');
  }
  if (receipt.status !== 'PRESENT' || !Array.isArray(receipt.blockers) || receipt.blockers.length !== 0) {
    add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_STATUS_INVALID');
  }
  if (!exactDigest(receipt.receiptDigest)) add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_DIGEST_INVALID');
  else if (receipt.receiptDigest !== sha256(withoutKey(receipt, 'receiptDigest'))) {
    add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_DIGEST_MISMATCH');
  }
  if (receipt.producerCodeSha !== audit.producerCodeSha) add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_PRODUCER_SHA_MISMATCH');
  if (receipt.independenceAuditDigest !== audit.independenceAuditDigest) add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_INDEPENDENCE_DIGEST_MISMATCH');
  if (receipt.independentSplitSourceDigest !== audit.independentSplitSourceDigest) add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_SPLIT_SOURCE_DIGEST_MISMATCH');
  if (receipt.splitAuditDigest !== audit.auditDigest) add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_AUDIT_DIGEST_MISMATCH');
  if (receipt.upstreamLineageDigest !== audit.upstreamLineageDigest) add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_UPSTREAM_DIGEST_MISMATCH');
  if (!sameArray(receipt.datasetDigests, audit.datasetDigests)) add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_DATASET_DIGESTS_MISMATCH');
  if (!sameArray(receipt.receiptDigests, audit.receiptDigests)) add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_RECEIPT_DIGESTS_MISMATCH');
  if (!sameArray(receipt.collectorCodeShas, audit.collectorCodeShas)) add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_COLLECTOR_SHAS_MISMATCH');
  if (receipt.splitPolicyDigest !== audit.splitPolicyDigest) add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_POLICY_DIGEST_MISMATCH');
  if (!exactDigest(receipt.scopeBindingsDigest)) add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_SCOPE_BINDINGS_DIGEST_INVALID');
  if (!exactDigest(receipt.regimeBindingsDigest)) add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_REGIME_BINDINGS_DIGEST_INVALID');
  if (!object(receipt.splitAudit)
    || receipt.splitAudit.auditDigest !== audit.auditDigest
    || receipt.splitAudit.auditDigest !== receipt.splitAuditDigest
    || receipt.splitAudit.auditDigest !== sha256(withoutKey(receipt.splitAudit, 'auditDigest'))) {
    add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_EMBEDDED_AUDIT_MISMATCH');
  }
  if (receipt.syntheticAggregateDataset !== false
    || receipt.syntheticSingleCollector !== false
    || receipt.oosValidationComplete !== false
    || receipt.calibrationArtifactProduced !== false
    || receipt.liquidityImpactPresent !== false
    || receipt.liquidityImpactStatus !== 'BLOCKED_DATA'
    || receipt.evidenceCompleteCredit !== 0
    || receipt.naturalEntryCredit !== 0
    || receipt.runtimeCostCredit !== 0
    || receipt.fullCostReady !== false
    || receipt.executionAuthority !== 'NONE'
    || receipt.privateApiUsed !== false
    || receipt.liveTrading !== false
    || receipt.orderSubmitted !== false) {
    add(blockers, 'MULTI_SOURCE_SPLIT_RECEIPT_SAFETY_INVALID');
  }
  return blockers;
}

function validateSplitAudit(audit) {
  const blockers = [];
  if (!object(audit)) return ['SPLIT_AUDIT_REQUIRED'];
  const isLegacy = audit.schemaVersion === PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_VERSION;
  const isMulti = multiSource(audit);
  if (!isLegacy && !isMulti) add(blockers, 'SPLIT_AUDIT_VERSION_INVALID');
  if (audit.datasetContract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT
    || audit.datasetStoreContract !== PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT) {
    add(blockers, 'SPLIT_AUDIT_DATASET_CONTRACT_INVALID');
  }
  if (audit.sampleClass !== FORWARD_NATURAL_SAMPLE) add(blockers, 'SPLIT_AUDIT_FORWARD_SAMPLE_REQUIRED');
  if (isLegacy) {
    if (!exactDigest(audit.datasetDigest)) add(blockers, 'SPLIT_AUDIT_DATASET_DIGEST_INVALID');
    if (!exactCommitSha(audit.collectorCodeSha)) add(blockers, 'SPLIT_AUDIT_COLLECTOR_SHA_INVALID');
  }
  if (isMulti) validateMultiSourceLineage(audit, blockers);
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
  if ((audit.evidenceCompleteCredit ?? 0) !== 0
    || audit.naturalEntryCredit !== 0 || audit.runtimeCostCredit !== 0) {
    add(blockers, 'UPSTREAM_RUNTIME_CREDIT_INVALID');
  }
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

function validateAssignment(assignment, audit) {
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
  if (multiSource(audit)) {
    if (!text(assignment.sourceObservationId)) add(blockers, 'OOS_ASSIGNMENT_SOURCE_OBSERVATION_ID_INVALID');
    if (!text(assignment.sourceIdentity)) add(blockers, 'OOS_ASSIGNMENT_SOURCE_IDENTITY_INVALID');
    if (!exactDigest(assignment.sourceDatasetDigest)) add(blockers, 'OOS_ASSIGNMENT_SOURCE_DATASET_DIGEST_INVALID');
    if (!exactDigest(assignment.sourceReceiptDigest)) add(blockers, 'OOS_ASSIGNMENT_SOURCE_RECEIPT_DIGEST_INVALID');
    if (!exactDigest(assignment.sourceReceiptChainDigest)) add(blockers, 'OOS_ASSIGNMENT_SOURCE_RECEIPT_CHAIN_DIGEST_INVALID');
    if (!positiveInteger(assignment.sourceReceiptCount)) add(blockers, 'OOS_ASSIGNMENT_SOURCE_RECEIPT_COUNT_INVALID');
    if (!exactCommitSha(assignment.sourceCollectorCodeSha)) add(blockers, 'OOS_ASSIGNMENT_SOURCE_COLLECTOR_SHA_INVALID');
    if (!text(assignment.eventIdentity)) add(blockers, 'OOS_ASSIGNMENT_EVENT_IDENTITY_INVALID');
    if (!text(assignment.sourceFrameIdentity)) add(blockers, 'OOS_ASSIGNMENT_SOURCE_FRAME_IDENTITY_INVALID');
    const upstream = audit.upstreamSources.find((source) => source.sourceIdentity === assignment.sourceIdentity);
    if (!upstream) add(blockers, 'OOS_ASSIGNMENT_SOURCE_ORPHAN');
    else if (assignment.sourceDatasetDigest !== upstream.datasetDigest
      || assignment.sourceReceiptDigest !== upstream.receiptDigest
      || assignment.sourceReceiptChainDigest !== upstream.ingestReceiptChainDigest
      || assignment.sourceReceiptCount !== upstream.ingestReceiptCount
      || assignment.sourceCollectorCodeSha !== upstream.collectorCodeSha) {
      add(blockers, 'OOS_ASSIGNMENT_SOURCE_LINEAGE_MISMATCH');
    }
  }
  return blockers;
}

function validateOutcome(outcome, assignment, audit, methodology, expectedOutcomeProducerCodeSha, splitReceipt) {
  const blockers = [];
  if (!object(outcome)) return ['OOS_OUTCOME_INVALID'];
  if (!text(outcome.outcomeId)) add(blockers, 'OOS_OUTCOME_ID_INVALID');
  if (outcome.observationId !== assignment.observationId) add(blockers, 'OOS_OBSERVATION_ID_MISMATCH');
  if (outcome.referenceSourceDigest !== assignment.sourceDigest) add(blockers, 'OOS_REFERENCE_SOURCE_DIGEST_MISMATCH');
  if (outcome.publicExecutionId !== assignment.publicExecutionId) add(blockers, 'OOS_PUBLIC_EXECUTION_ID_MISMATCH');
  if (outcome.splitAuditDigest !== audit.auditDigest) add(blockers, 'OOS_SPLIT_AUDIT_DIGEST_MISMATCH');
  if (multiSource(audit)) {
    if (outcome.datasetDigest !== undefined && outcome.datasetDigest !== null) {
      add(blockers, 'OOS_SYNTHETIC_AGGREGATE_DATASET_FORBIDDEN');
    }
    if (outcome.splitReceiptDigest !== splitReceipt?.receiptDigest) add(blockers, 'OOS_SPLIT_RECEIPT_DIGEST_MISMATCH');
    if (outcome.sourceIdentity !== assignment.sourceIdentity) add(blockers, 'OOS_SOURCE_IDENTITY_MISMATCH');
    if (outcome.sourceObservationId !== assignment.sourceObservationId) add(blockers, 'OOS_SOURCE_OBSERVATION_ID_MISMATCH');
    if (outcome.sourceDatasetDigest !== assignment.sourceDatasetDigest) add(blockers, 'OOS_SOURCE_DATASET_DIGEST_MISMATCH');
    if (outcome.sourceReceiptDigest !== assignment.sourceReceiptDigest) add(blockers, 'OOS_SOURCE_RECEIPT_DIGEST_MISMATCH');
    if (outcome.sourceReceiptChainDigest !== assignment.sourceReceiptChainDigest) add(blockers, 'OOS_SOURCE_RECEIPT_CHAIN_DIGEST_MISMATCH');
    if (outcome.sourceReceiptCount !== assignment.sourceReceiptCount) add(blockers, 'OOS_SOURCE_RECEIPT_COUNT_MISMATCH');
    if (outcome.sourceCollectorCodeSha !== assignment.sourceCollectorCodeSha) add(blockers, 'OOS_SOURCE_COLLECTOR_SHA_MISMATCH');
    if (outcome.upstreamLineageDigest !== audit.upstreamLineageDigest) add(blockers, 'OOS_UPSTREAM_LINEAGE_DIGEST_MISMATCH');
    if (outcome.independenceAuditDigest !== audit.independenceAuditDigest) add(blockers, 'OOS_INDEPENDENCE_AUDIT_DIGEST_MISMATCH');
    if (outcome.independentSplitSourceDigest !== audit.independentSplitSourceDigest) {
      add(blockers, 'OOS_INDEPENDENT_SPLIT_SOURCE_DIGEST_MISMATCH');
    }
  } else if (outcome.datasetDigest !== audit.datasetDigest) {
    add(blockers, 'OOS_DATASET_DIGEST_MISMATCH');
  }
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
  splitReceipt = null,
  outcomes = [],
  methodology,
  expectedOutcomeProducerCodeSha,
} = {}) {
  const auditBlockers = validateSplitAudit(splitAudit);
  if (auditBlockers.length > 0) return blocked(auditBlockers);
  const isMulti = multiSource(splitAudit);
  if (isMulti) {
    const receiptBlockers = validateMultiSourceReceipt(splitReceipt, splitAudit);
    if (receiptBlockers.length > 0) return blocked(receiptBlockers);
  }
  if (!exactCommitSha(expectedOutcomeProducerCodeSha)) return blocked(['OOS_OUTCOME_PRODUCER_SHA_INVALID']);

  const oosAssignments = splitAudit.assignments.filter((assignment) => assignment.split === 'OOS');
  if (oosAssignments.length === 0) return blocked(['OOS_ASSIGNMENTS_MISSING']);
  const assignmentBlockers = [];
  oosAssignments.forEach((assignment) => validateAssignment(assignment, splitAudit)
    .forEach((code) => add(assignmentBlockers, code)));
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
    validateOutcome(outcome, assignment, splitAudit, methodology, expectedOutcomeProducerCodeSha, splitReceipt)
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
    schemaVersion: isMulti
      ? PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_OOS_VALIDATION_VERSION
      : PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_VERSION,
    splitAuditVersion: splitAudit.schemaVersion,
    splitAuditDigest: splitAudit.auditDigest,
    datasetContract: splitAudit.datasetContract,
    datasetStoreContract: splitAudit.datasetStoreContract,
    ...(isMulti ? {
      splitReceiptVersion: splitReceipt.schemaVersion,
      splitReceiptDigest: splitReceipt.receiptDigest,
      evidenceLineageDigest: splitReceipt.receiptDigest,
      scopeBindingsDigest: splitReceipt.scopeBindingsDigest,
      regimeBindingsDigest: splitReceipt.regimeBindingsDigest,
      independentSplitSourceDigest: splitAudit.independentSplitSourceDigest,
      independenceAuditDigest: splitAudit.independenceAuditDigest,
      upstreamLineageDigest: splitAudit.upstreamLineageDigest,
      upstreamSources: Object.freeze([...splitAudit.upstreamSources]),
      datasetDigests: Object.freeze([...splitAudit.datasetDigests]),
      receiptDigests: Object.freeze([...splitAudit.receiptDigests]),
      receiptChainDigests: Object.freeze([...splitAudit.receiptChainDigests]),
      receiptCounts: Object.freeze([...splitAudit.receiptCounts]),
      collectorCodeShas: Object.freeze([...splitAudit.collectorCodeShas]),
    } : {
      datasetDigest: splitAudit.datasetDigest,
      collectorCodeSha: splitAudit.collectorCodeSha,
    }),
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
    syntheticAggregateDataset: false,
    syntheticSingleCollector: false,
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

function successorV3ExpectedNativePolicy() {
  const contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT;
  const outcome = SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy;
  const splits = Object.fromEntries(['TRAIN', 'VALIDATION', 'OOS'].map((name) => {
    const split = contract.policyCore.splits[name];
    return [name, {
      startIndexInclusive: split.startIndexInclusive,
      endIndexInclusive: split.endIndexInclusive,
      expectedSlotN: split.expectedSlotN,
    }];
  }));
  return {
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    scheduleReliabilityContractVersion: contract.contractVersion,
    scheduleReliabilityNumericFreezeSha256: contract.numericFreezeSha256,
    policyDigest: contract.policyDigest,
    cohortDigest: contract.cohortDigest,
    splitMode: contract.policyCore.splits.mode,
    splits,
    oosHorizonContractVersion: SUCCESSOR_OOS_HORIZON_CONTRACT.contractVersion,
    oosHorizonPolicyDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.policyDigest,
    oosHorizonContractDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.contractDigest,
    oosOutcomeHorizonMs: outcome.outcomeHorizonMs,
    oosOutcomeSelectionPolicy: outcome.outcomeSelectionPolicy,
  };
}

export function validatePublicForwardLiquiditySuccessorV3SplitIndex(index) {
  const blockers = [];
  if (!object(index)) return Object.freeze({ valid: false, blockers: Object.freeze(['SUCCESSOR_V3_SPLIT_INDEX_REQUIRED']), oosAssignments: Object.freeze([]) });
  if (index.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION
    || index.kind !== 'PUBLIC_FORWARD_LIQUIDITY_V3_FROZEN_SPLIT_PROPAGATION') {
    add(blockers, 'SUCCESSOR_V3_SPLIT_INDEX_VERSION_INVALID');
  }
  if (!exactDigest(index.indexDigest)) add(blockers, 'SUCCESSOR_V3_SPLIT_INDEX_DIGEST_INVALID');
  else if (index.indexDigest !== sha256(withoutKey(index, 'indexDigest'))) {
    add(blockers, 'SUCCESSOR_V3_SPLIT_INDEX_DIGEST_MISMATCH');
  }
  if (index.sourceContractFamily !== SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY) {
    add(blockers, 'SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY_INVALID');
  }
  const contractVerdict = verifySuccessorScheduleReliabilityV3Contract();
  const horizonVerdict = verifySuccessorOosOutcomeHorizonContract();
  if (!contractVerdict.valid || SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.activationBound !== true) {
    add(blockers, 'SUCCESSOR_V3_SCHEDULE_RELIABILITY_CONTRACT_INVALID');
  }
  if (!horizonVerdict.valid) add(blockers, 'SUCCESSOR_V3_OOS_HORIZON_CONTRACT_INVALID');
  const expectedPolicy = successorV3ExpectedNativePolicy();
  if (canonicalJsonValue(index.successorNativePolicy) !== canonicalJsonValue(expectedPolicy)) {
    add(blockers, 'SUCCESSOR_V3_NATIVE_POLICY_LINEAGE_MISMATCH');
  }
  if (index.policyDigest !== expectedPolicy.policyDigest || index.cohortDigest !== expectedPolicy.cohortDigest) {
    add(blockers, 'SUCCESSOR_V3_INDEX_POLICY_COHORT_MISMATCH');
  }
  if (!exactCommitSha(index.producerCodeSha)) add(blockers, 'SUCCESSOR_V3_INDEX_PRODUCER_SHA_INVALID');
  if (!exactDigest(index.sourceInventoryDigest)
    || !exactDigest(index.independenceAuditDigest)
    || !exactDigest(index.independentSplitSourceDigest)) {
    add(blockers, 'SUCCESSOR_V3_INDEX_UPSTREAM_DIGEST_INVALID');
  }
  if (!positiveInteger(index.genuineScheduledSlotN)
    || !positiveInteger(index.creditedReceiptN)
    || index.creditedReceiptN !== index.genuineScheduledSlotN) {
    add(blockers, 'SUCCESSOR_V3_INDEX_GENUINE_SLOT_COUNT_INVALID');
  }
  if (!Number.isInteger(index.targetSlotIndex) || index.targetSlotIndex < 0) {
    add(blockers, 'SUCCESSOR_V3_INDEX_TARGET_SLOT_INVALID');
  } else {
    try {
      buildSuccessorScheduleReliabilityV3SlotDescriptor(index.targetSlotIndex);
    } catch {
      add(blockers, 'SUCCESSOR_V3_INDEX_TARGET_SLOT_INVALID');
    }
  }
  if (!Array.isArray(index.sourceDatasetDigests)
    || index.sourceDatasetDigests.length === 0
    || index.sourceDatasetDigests.some((value) => !exactDigest(value))
    || new Set(index.sourceDatasetDigests).size !== index.sourceDatasetDigests.length) {
    add(blockers, 'SUCCESSOR_V3_INDEX_SOURCE_DATASETS_INVALID');
  }
  if (!Array.isArray(index.observations)) add(blockers, 'SUCCESSOR_V3_INDEX_OBSERVATIONS_INVALID');
  const observations = Array.isArray(index.observations) ? index.observations : [];
  if (!Number.isInteger(index.effectiveIndependentN)
    || index.effectiveIndependentN < 0
    || index.effectiveIndependentN !== observations.length) {
    add(blockers, 'SUCCESSOR_V3_INDEX_INDEPENDENT_N_MISMATCH');
  }
  if (!Number.isInteger(index.duplicateObservationLineageN) || index.duplicateObservationLineageN < 0
    || index.frozenSplitSource !== 'V3_SCHEDULED_SLOT_RECEIPT_ONLY'
    || index.retrospectiveSplitSelection !== false
    || index.syntheticSplitAssignment !== false
    || index.additionalIndependentSampleCredit !== 0
    || index.oosOutcomeCredit !== 0
    || index.calibrationArtifactProduced !== false
    || index.liquidityImpactStatus !== 'BLOCKED_DATA'
    || index.fullCostReady !== false
    || index.evidenceCompleteCredit !== 0
    || index.executionAuthority !== 'NONE'
    || index.privateApiUsed !== false
    || index.liveTrading !== false
    || index.realOrders !== 0) {
    add(blockers, 'SUCCESSOR_V3_INDEX_TRUTH_BOUNDARY_INVALID');
  }

  const counts = {
    TRAIN: 0, TRAIN_BUY: 0, TRAIN_SELL: 0,
    VALIDATION: 0, VALIDATION_BUY: 0, VALIDATION_SELL: 0,
    OOS: 0, OOS_BUY: 0, OOS_SELL: 0,
  };
  const observationIds = new Set();
  const sourceLineages = new Set();
  const slotLineages = new Map();
  for (const assignment of observations) {
    if (!object(assignment)) {
      add(blockers, 'SUCCESSOR_V3_INDEX_ASSIGNMENT_INVALID');
      continue;
    }
    if (!text(assignment.observationId) || observationIds.has(assignment.observationId)) {
      add(blockers, 'SUCCESSOR_V3_INDEX_OBSERVATION_ID_INVALID');
    } else observationIds.add(assignment.observationId);
    const sourceLineage = `${assignment.ingestSourceIdentity}\u0000${assignment.sourceObservationId}`;
    if (!text(assignment.sourceObservationId)
      || !text(assignment.sourceIdentity)
      || !text(assignment.ingestSourceIdentity)
      || sourceLineages.has(sourceLineage)) {
      add(blockers, 'SUCCESSOR_V3_INDEX_SOURCE_LINEAGE_INVALID');
    } else sourceLineages.add(sourceLineage);
    if (!text(assignment.eventIdentity)
      || !text(assignment.sourceFrameIdentity)
      || !positiveInteger(assignment.eventTimestampMs)
      || !['BUY', 'SELL'].includes(assignment.aggressiveSide)
      || !['TRAIN', 'VALIDATION', 'OOS'].includes(assignment.split)
      || !Number.isInteger(assignment.slotIndex)
      || assignment.slotIndex < 0) {
      add(blockers, 'SUCCESSOR_V3_INDEX_ASSIGNMENT_IDENTITY_INVALID');
      continue;
    }
    let slot = null;
    try {
      slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(assignment.slotIndex);
    } catch {
      add(blockers, 'SUCCESSOR_V3_INDEX_ASSIGNMENT_SLOT_INVALID');
    }
    if (slot && (slot.split !== assignment.split
      || sha256(slot.canonicalSlotKey) !== assignment.canonicalSlotKeyDigest)) {
      add(blockers, 'SUCCESSOR_V3_INDEX_ASSIGNMENT_FROZEN_SPLIT_MISMATCH');
    }
    const priorSlotDigest = slotLineages.get(assignment.slotIndex);
    if (priorSlotDigest && priorSlotDigest !== assignment.canonicalSlotKeyDigest) {
      add(blockers, 'SUCCESSOR_V3_INDEX_SLOT_LINEAGE_AMBIGUOUS');
    } else slotLineages.set(assignment.slotIndex, assignment.canonicalSlotKeyDigest);
    if (!exactDigest(assignment.canonicalSlotKeyDigest)
      || !exactCommitSha(assignment.collectorCodeSha)
      || !exactDigest(assignment.datasetDigest)
      || !text(assignment.ingestReceiptRelativePath)
      || !exactDigest(assignment.ingestReceiptDigest)
      || !exactDigest(assignment.captureReceiptDigest)
      || !exactDigest(assignment.artifactReceiptDigest)
      || assignment.policyDigest !== expectedPolicy.policyDigest
      || assignment.cohortDigest !== expectedPolicy.cohortDigest) {
      add(blockers, 'SUCCESSOR_V3_INDEX_ASSIGNMENT_LINEAGE_MISMATCH');
    }
    counts[assignment.split] += 1;
    counts[`${assignment.split}_${assignment.aggressiveSide}`] += 1;
  }
  if (!object(index.counts)
    || Object.entries(counts).some(([key, value]) => index.counts[key] !== value)) {
    add(blockers, 'SUCCESSOR_V3_INDEX_COUNTS_MISMATCH');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
    oosAssignments: Object.freeze(observations.filter((assignment) => assignment?.split === 'OOS')),
    expectedPolicy: Object.freeze(expectedPolicy),
  });
}

function canonicalJsonValue(value) {
  try {
    return JSON.stringify(canonicalize(value));
  } catch {
    return null;
  }
}

function validateSuccessorV3Outcome(outcome, assignment, index, expectedProducerCodeSha, blockers) {
  if (!object(outcome)) {
    add(blockers, 'SUCCESSOR_V3_OOS_OUTCOME_INVALID');
    return;
  }
  const horizon = SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy;
  if (!text(outcome.outcomeId)
    || outcome.v3IndependentSplitIndexDigest !== index.indexDigest
    || outcome.observationId !== assignment.observationId
    || outcome.sourceObservationId !== assignment.sourceObservationId
    || outcome.sourceIdentity !== assignment.sourceIdentity
    || outcome.ingestSourceIdentity !== assignment.ingestSourceIdentity
    || outcome.aggressiveSide !== assignment.aggressiveSide
    || outcome.slotIndex !== assignment.slotIndex
    || outcome.split !== 'OOS'
    || outcome.canonicalSlotKeyDigest !== assignment.canonicalSlotKeyDigest
    || outcome.collectorCodeSha !== assignment.collectorCodeSha
    || outcome.datasetDigest !== assignment.datasetDigest
    || outcome.ingestReceiptDigest !== assignment.ingestReceiptDigest
    || outcome.captureReceiptDigest !== assignment.captureReceiptDigest
    || outcome.artifactReceiptDigest !== assignment.artifactReceiptDigest
    || outcome.policyDigest !== assignment.policyDigest
    || outcome.cohortDigest !== assignment.cohortDigest) {
    add(blockers, 'SUCCESSOR_V3_OOS_OUTCOME_LINEAGE_MISMATCH');
  }
  if (outcome.referenceEventTimestampMs !== assignment.eventTimestampMs
    || !positiveInteger(outcome.observedAtMs)
    || outcome.observedAtMs < assignment.eventTimestampMs + horizon.outcomeHorizonMs
    || outcome.outcomeHorizonIdentity !== horizon.outcomeHorizonIdentity
    || outcome.outcomeHorizonMs !== horizon.outcomeHorizonMs
    || outcome.outcomeSelectionPolicy !== horizon.outcomeSelectionPolicy
    || outcome.oosHorizonContractVersion !== SUCCESSOR_OOS_HORIZON_CONTRACT.contractVersion
    || outcome.oosHorizonPolicyDigest !== SUCCESSOR_OOS_HORIZON_CONTRACT.policyDigest
    || outcome.oosHorizonContractDigest !== SUCCESSOR_OOS_HORIZON_CONTRACT.contractDigest) {
    add(blockers, 'SUCCESSOR_V3_OOS_OUTCOME_HORIZON_MISMATCH');
  }
  if (outcome.sourceType !== 'PUBLIC_FORWARD_MARKET_DATA'
    || outcome.publicDataSource !== 'BITGET_PUBLIC_UTA_V3'
    || !text(outcome.outcomeSourceIdentity)
    || !exactDigest(outcome.outcomeSourceDigest)
    || outcome.outcomeProducerCodeSha !== expectedProducerCodeSha
    || !positiveFinite(outcome.observedPublicMidPrice)
    || outcome.heldOut !== true
    || outcome.contaminationFree !== true
    || outcome.causalMarketImpactClaim !== false
    || outcome.executionCostEligible !== false
    || outcome.liquidityImpactCoefficient !== null
    || outcome.historicalBackfillCredit !== 0
    || outcome.replayCredit !== 0
    || outcome.syntheticCredit !== 0
    || outcome.testFixtureCredit !== 0
    || outcome.naturalEntryCredit !== 0
    || outcome.runtimeCostCredit !== 0
    || outcome.executionAuthority !== 'NONE') {
    add(blockers, 'SUCCESSOR_V3_OOS_OUTCOME_TRUTH_BOUNDARY_INVALID');
  }
}

export function validatePublicForwardLiquiditySuccessorV3OosOutcomes({
  v3SplitIndex,
  outcomes = [],
  expectedOutcomeProducerCodeSha,
} = {}) {
  const indexVerdict = validatePublicForwardLiquiditySuccessorV3SplitIndex(v3SplitIndex);
  if (!indexVerdict.valid) return blocked(indexVerdict.blockers);
  if (!exactCommitSha(expectedOutcomeProducerCodeSha)) return blocked(['OOS_OUTCOME_PRODUCER_SHA_INVALID']);
  const assignments = indexVerdict.oosAssignments;
  if (assignments.length === 0) return blocked(['SUCCESSOR_V3_OOS_ASSIGNMENTS_MISSING']);
  if (!Array.isArray(outcomes) || outcomes.length === 0) return blocked(['SUCCESSOR_V3_OOS_OUTCOMES_MISSING']);
  const blockers = [];
  const byObservation = new Map();
  const outcomeIds = new Set();
  const outcomeSourceDigests = new Set();
  for (const outcome of outcomes) {
    if (outcomeIds.has(outcome?.outcomeId)) add(blockers, 'SUCCESSOR_V3_OOS_OUTCOME_ID_DUPLICATE');
    else outcomeIds.add(outcome?.outcomeId);
    if (byObservation.has(outcome?.observationId)) add(blockers, 'SUCCESSOR_V3_OOS_OUTCOME_OBSERVATION_DUPLICATE');
    else byObservation.set(outcome?.observationId, outcome);
    if (outcomeSourceDigests.has(outcome?.outcomeSourceDigest)) add(blockers, 'SUCCESSOR_V3_OOS_OUTCOME_SOURCE_REUSED');
    else outcomeSourceDigests.add(outcome?.outcomeSourceDigest);
    const assignment = assignments.find((item) => item.observationId === outcome?.observationId);
    if (!assignment) add(blockers, 'SUCCESSOR_V3_OOS_OUTCOME_ORPHAN');
    else validateSuccessorV3Outcome(outcome, assignment, v3SplitIndex, expectedOutcomeProducerCodeSha, blockers);
  }
  for (const assignment of assignments) {
    if (!byObservation.has(assignment.observationId)) add(blockers, 'SUCCESSOR_V3_OOS_OUTCOME_MISSING');
  }
  if (outcomes.length !== assignments.length) add(blockers, 'SUCCESSOR_V3_OOS_EXACT_COVERAGE_MISMATCH');
  if (blockers.length > 0) return blocked(blockers);
  const orderedOutcomes = [...outcomes].sort((left, right) => left.observationId.localeCompare(right.observationId));
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION,
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    v3IndependentSplitIndexDigest: v3SplitIndex.indexDigest,
    sourceInventoryDigest: v3SplitIndex.sourceInventoryDigest,
    independenceAuditDigest: v3SplitIndex.independenceAuditDigest,
    independentSplitSourceDigest: v3SplitIndex.independentSplitSourceDigest,
    scheduleReliabilityContractVersion: v3SplitIndex.successorNativePolicy.scheduleReliabilityContractVersion,
    scheduleReliabilityNumericFreezeSha256: v3SplitIndex.successorNativePolicy.scheduleReliabilityNumericFreezeSha256,
    policyDigest: v3SplitIndex.policyDigest,
    cohortDigest: v3SplitIndex.cohortDigest,
    oosHorizonContractVersion: SUCCESSOR_OOS_HORIZON_CONTRACT.contractVersion,
    oosHorizonPolicyDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.policyDigest,
    oosHorizonContractDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.contractDigest,
    outcomeHorizonMs: SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeHorizonMs,
    genuineScheduledSlotN: v3SplitIndex.genuineScheduledSlotN,
    effectiveIndependentN: v3SplitIndex.effectiveIndependentN,
    genuineV3OosSlotN: new Set(assignments.map((assignment) => assignment.slotIndex)).size,
    genuineOosOutcomeN: orderedOutcomes.length,
    buyOosOutcomeN: orderedOutcomes.filter((outcome) => outcome.aggressiveSide === 'BUY').length,
    sellOosOutcomeN: orderedOutcomes.filter((outcome) => outcome.aggressiveSide === 'SELL').length,
    outcomeIds: Object.freeze(orderedOutcomes.map((outcome) => outcome.outcomeId)),
    outcomeDigest: sha256(orderedOutcomes),
    exactOosCoverage: true,
    heldOut: true,
    contaminationFree: true,
    retrospectiveSplitSelection: false,
    replayCredit: 0,
    backfillCredit: 0,
    syntheticCredit: 0,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    executionAuthority: 'NONE',
  };
  const validation = Object.freeze({ ...body, validationDigest: sha256(body) });
  return Object.freeze({
    status: 'PRESENT',
    blockers: Object.freeze([]),
    validation,
    safety: PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY,
  });
}

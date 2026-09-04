import { createHash } from 'node:crypto';

import {
  PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION,
  SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
  validatePublicForwardLiquiditySuccessorV3SplitIndex,
} from './public-forward-liquidity-calibration-oos-outcome-validator.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  verifySuccessorScheduleReliabilityV3Contract,
} from './public-forward-liquidity-successor-schedule-reliability-v3.mjs';
import {
  SUCCESSOR_OOS_HORIZON_CONTRACT,
  verifySuccessorOosOutcomeHorizonContract,
} from './public-forward-liquidity-successor-oos-outcome-horizon.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION,
} from './public-forward-liquidity-v3-independence-binding.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION =
  'public-forward-liquidity-calibration-artifact-v1';

export const GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING =
  'GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING';

export const PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY = Object.freeze({
  sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
  nativeSuccessorV3OosValidationRequired: true,
  nativeIndependentSplitIndexRequired: true,
  preFrozenCalibrationMethodologyRequired: true,
  trainValidationFitOnly: true,
  oosFitAllowed: false,
  historicalOosAllowed: false,
  replayAllowed: false,
  backfillAllowed: false,
  syntheticEconomicCreditAllowed: false,
  rawNAsIndependentNAllowed: false,
  ciAsEconomicCreditAllowed: false,
  missingAsZeroAllowed: false,
  coefficientInventedByThisContract: false,
  runtimeCostProduced: false,
  liquidityImpactPresent: false,
  naturalEntryCredit: 0,
  runtimeCostCredit: 0,
  evidenceComplete: 0,
  fullCostReady: false,
  netAlphaReady: false,
  profitabilityProven: false,
  currentValidatedChampion: 'NONE',
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
});

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const FORBIDDEN_PERFORMANCE_FIELDS = Object.freeze([
  'winRate',
  'winRatePct',
  'expectedValue',
  'ev',
  'alpha',
  'netAlpha',
  'probability',
  'profitProbability',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 && normalized.length <= 320 ? normalized : null;
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

function nonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
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

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  const payload = typeof value === 'string' ? value : canonicalJson(value);
  return createHash('sha256').update(payload).digest('hex');
}

function withoutKey(value, omittedKey) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== omittedKey));
}

function add(list, code) {
  if (!list.includes(code)) list.push(code);
}

function frozenSplitDescriptor() {
  const splits = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyCore.splits;
  return Object.freeze({
    mode: splits.mode,
    TRAIN: Object.freeze({
      startIndexInclusive: splits.TRAIN.startIndexInclusive,
      endIndexInclusive: splits.TRAIN.endIndexInclusive,
      expectedSlotN: splits.TRAIN.expectedSlotN,
    }),
    VALIDATION: Object.freeze({
      startIndexInclusive: splits.VALIDATION.startIndexInclusive,
      endIndexInclusive: splits.VALIDATION.endIndexInclusive,
      expectedSlotN: splits.VALIDATION.expectedSlotN,
    }),
    OOS: Object.freeze({
      startIndexInclusive: splits.OOS.startIndexInclusive,
      endIndexInclusive: splits.OOS.endIndexInclusive,
      expectedSlotN: splits.OOS.expectedSlotN,
    }),
  });
}

function canonicalNotReadyReason(blockers) {
  const codes = Array.isArray(blockers) ? blockers : [];
  if (codes.some((code) => [
    'SUCCESSOR_V3_OOS_ASSIGNMENTS_MISSING',
    'SUCCESSOR_V3_OOS_OUTCOMES_MISSING',
    'NATIVE_SUCCESSOR_V3_OOS_VALIDATION_REQUIRED',
    'NATIVE_SUCCESSOR_V3_SPLIT_INDEX_REQUIRED',
  ].includes(code))) return GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING;
  return codes[0] ?? 'CALIBRATION_CONTRACT_NOT_READY';
}

function notReady(blockers, { calibrationInputN = null } = {}) {
  const unique = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION,
    status: 'NOT_READY',
    calibrationStatus: 'NOT_READY',
    calibrationReason: canonicalNotReadyReason(unique),
    calibrationInputN,
    blockers: unique,
    artifact: null,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    runtimeLiquidityImpactCoefficient: null,
    liquidityImpactCostBps: null,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    evidenceComplete: 0,
    fullCostReady: false,
    netAlphaReady: false,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE',
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    safety: PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY,
  });
}

export function computePublicForwardLiquidityCalibrationMethodologyDigest(methodology) {
  if (!object(methodology)) throw new TypeError('CALIBRATION_METHODOLOGY_REQUIRED');
  return sha256(withoutKey(methodology, 'methodologyDigest'));
}

function normalizeNativeValidationInput(oosValidationResult, oosValidation) {
  if (object(oosValidationResult)) {
    if (oosValidationResult.status !== 'PRESENT' || !object(oosValidationResult.validation)) {
      const blockers = Array.isArray(oosValidationResult.blockers)
        ? oosValidationResult.blockers
        : ['NATIVE_SUCCESSOR_V3_OOS_VALIDATION_REQUIRED'];
      return { validation: null, blockers, calibrationInputN: 0 };
    }
    return { validation: oosValidationResult.validation, blockers: [], calibrationInputN: null };
  }
  if (object(oosValidation)) return { validation: oosValidation, blockers: [], calibrationInputN: null };
  return {
    validation: null,
    blockers: ['NATIVE_SUCCESSOR_V3_OOS_VALIDATION_REQUIRED'],
    calibrationInputN: 0,
  };
}

function validateNativeOosValidation(validation, v3SplitIndex) {
  const blockers = [];
  if (!object(validation)) return ['NATIVE_SUCCESSOR_V3_OOS_VALIDATION_REQUIRED'];

  const scheduleVerdict = verifySuccessorScheduleReliabilityV3Contract();
  const horizonVerdict = verifySuccessorOosOutcomeHorizonContract();
  if (!scheduleVerdict.valid || SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.activationBound !== true) {
    add(blockers, 'SUCCESSOR_V3_SCHEDULE_RELIABILITY_CONTRACT_INVALID');
  }
  if (!horizonVerdict.valid) add(blockers, 'SUCCESSOR_V3_OOS_HORIZON_CONTRACT_INVALID');

  if (validation.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION) {
    add(blockers, 'NATIVE_SUCCESSOR_V3_OOS_VALIDATION_VERSION_INVALID');
  }
  if (validation.sourceContractFamily !== SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY) {
    add(blockers, 'SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY_INVALID');
  }
  if (!exactDigest(validation.validationDigest)) add(blockers, 'SUCCESSOR_V3_OOS_VALIDATION_DIGEST_INVALID');
  else if (validation.validationDigest !== sha256(withoutKey(validation, 'validationDigest'))) {
    add(blockers, 'SUCCESSOR_V3_OOS_VALIDATION_DIGEST_MISMATCH');
  }

  for (const key of [
    'v3IndependentSplitIndexDigest',
    'sourceInventoryDigest',
    'independenceAuditDigest',
    'independentSplitSourceDigest',
    'scheduleReliabilityNumericFreezeSha256',
    'policyDigest',
    'cohortDigest',
    'oosHorizonPolicyDigest',
    'oosHorizonContractDigest',
    'outcomeDigest',
  ]) {
    if (!exactDigest(validation[key])) add(blockers, `SUCCESSOR_V3_${key.toUpperCase()}_INVALID`);
  }

  const contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT;
  const horizon = SUCCESSOR_OOS_HORIZON_CONTRACT;
  if (validation.scheduleReliabilityContractVersion !== contract.contractVersion
    || validation.scheduleReliabilityNumericFreezeSha256 !== contract.numericFreezeSha256
    || validation.policyDigest !== contract.policyDigest
    || validation.cohortDigest !== contract.cohortDigest) {
    add(blockers, 'SUCCESSOR_V3_FROZEN_POLICY_LINEAGE_MISMATCH');
  }
  if (validation.oosHorizonContractVersion !== horizon.contractVersion
    || validation.oosHorizonPolicyDigest !== horizon.policyDigest
    || validation.oosHorizonContractDigest !== horizon.contractDigest
    || validation.outcomeHorizonMs !== 5_000
    || validation.outcomeHorizonMs !== horizon.policyCore.outcomePolicy.outcomeHorizonMs) {
    add(blockers, 'SUCCESSOR_V3_OOS_HORIZON_LINEAGE_MISMATCH');
  }

  if (!positiveInteger(validation.genuineScheduledSlotN)
    || !positiveInteger(validation.effectiveIndependentN)
    || !positiveInteger(validation.genuineV3OosSlotN)
    || !positiveInteger(validation.genuineOosOutcomeN)
    || validation.genuineV3OosSlotN > validation.genuineOosOutcomeN
    || validation.effectiveIndependentN < validation.genuineOosOutcomeN
    || validation.genuineScheduledSlotN < validation.effectiveIndependentN) {
    add(blockers, 'SUCCESSOR_V3_OOS_COUNT_LINEAGE_INVALID');
  }
  if (!nonnegativeInteger(validation.buyOosOutcomeN)
    || !nonnegativeInteger(validation.sellOosOutcomeN)
    || validation.buyOosOutcomeN + validation.sellOosOutcomeN !== validation.genuineOosOutcomeN) {
    add(blockers, 'SUCCESSOR_V3_OOS_SIDE_COUNT_INVALID');
  }
  if (!Array.isArray(validation.outcomeIds)
    || validation.outcomeIds.length !== validation.genuineOosOutcomeN
    || validation.outcomeIds.some((value) => !text(value))
    || new Set(validation.outcomeIds).size !== validation.outcomeIds.length) {
    add(blockers, 'SUCCESSOR_V3_OOS_OUTCOME_IDENTITY_INVALID');
  }
  if (validation.exactOosCoverage !== true
    || validation.heldOut !== true
    || validation.contaminationFree !== true
    || validation.retrospectiveSplitSelection !== false) {
    add(blockers, 'SUCCESSOR_V3_OOS_HOLDOUT_INTEGRITY_INVALID');
  }
  if (validation.replayCredit !== 0 || validation.backfillCredit !== 0 || validation.syntheticCredit !== 0) {
    add(blockers, 'SUCCESSOR_V3_NON_GENUINE_CREDIT_FORBIDDEN');
  }
  if (validation.calibrationArtifactProduced !== false
    || validation.liquidityImpactPresent !== false
    || validation.liquidityImpactStatus !== 'BLOCKED_DATA'
    || validation.fullCostReady !== false
    || validation.evidenceCompleteCredit !== 0
    || validation.executionAuthority !== 'NONE') {
    add(blockers, 'SUCCESSOR_V3_UPSTREAM_ECONOMIC_BOUNDARY_INVALID');
  }

  if (!object(v3SplitIndex)) {
    add(blockers, 'NATIVE_SUCCESSOR_V3_SPLIT_INDEX_REQUIRED');
    return blockers;
  }
  const indexVerdict = validatePublicForwardLiquiditySuccessorV3SplitIndex(v3SplitIndex);
  if (!indexVerdict.valid) {
    add(blockers, 'NATIVE_SUCCESSOR_V3_SPLIT_INDEX_INVALID');
    for (const code of indexVerdict.blockers) add(blockers, `INDEX:${code}`);
    return blockers;
  }
  if (v3SplitIndex.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION
    || v3SplitIndex.indexDigest !== validation.v3IndependentSplitIndexDigest
    || v3SplitIndex.sourceInventoryDigest !== validation.sourceInventoryDigest
    || v3SplitIndex.independenceAuditDigest !== validation.independenceAuditDigest
    || v3SplitIndex.independentSplitSourceDigest !== validation.independentSplitSourceDigest
    || v3SplitIndex.policyDigest !== validation.policyDigest
    || v3SplitIndex.cohortDigest !== validation.cohortDigest
    || v3SplitIndex.genuineScheduledSlotN !== validation.genuineScheduledSlotN
    || v3SplitIndex.effectiveIndependentN !== validation.effectiveIndependentN) {
    add(blockers, 'SUCCESSOR_V3_SPLIT_INDEX_VALIDATION_BINDING_MISMATCH');
  }
  if (indexVerdict.oosAssignments.length !== validation.genuineOosOutcomeN) {
    add(blockers, 'SUCCESSOR_V3_OOS_ASSIGNMENT_VALIDATION_COVERAGE_MISMATCH');
  }
  if (indexVerdict.oosAssignments.some((assignment) => assignment.slotIndex < 768 || assignment.split !== 'OOS')) {
    add(blockers, 'SUCCESSOR_V3_NON_OOS_ASSIGNMENT_FORBIDDEN');
  }
  return blockers;
}

function validateMethodology(methodology, validation) {
  const blockers = [];
  if (!object(methodology)) return ['CALIBRATION_METHODOLOGY_REQUIRED'];
  if (!text(methodology.methodologyIdentity) || !text(methodology.methodologyVersion)) {
    add(blockers, 'CALIBRATION_METHODOLOGY_IDENTITY_INVALID');
  }
  if (!exactDigest(methodology.methodologyDigest)) add(blockers, 'CALIBRATION_METHODOLOGY_DIGEST_INVALID');
  else if (methodology.methodologyDigest !== computePublicForwardLiquidityCalibrationMethodologyDigest(methodology)) {
    add(blockers, 'CALIBRATION_METHODOLOGY_DIGEST_MISMATCH');
  }
  if (!positiveFinite(methodology.methodologyFrozenAtMs)) add(blockers, 'CALIBRATION_METHODOLOGY_FROZEN_AT_INVALID');
  if (!Array.isArray(methodology.fitSplits)
    || methodology.fitSplits.length !== 2
    || methodology.fitSplits[0] !== 'TRAIN'
    || methodology.fitSplits[1] !== 'VALIDATION') {
    add(blockers, 'CALIBRATION_FIT_SPLITS_INVALID');
  }
  if (methodology.oosUsedForFit !== false) add(blockers, 'OOS_FIT_FORBIDDEN');
  if (methodology.noRetuningAssertion !== true) add(blockers, 'NO_RETUNING_ASSERTION_REQUIRED');
  if (!text(methodology.estimatorIdentity) || !exactDigest(methodology.estimatorDigest)) {
    add(blockers, 'ESTIMATOR_IDENTITY_INVALID');
  }
  if (!text(methodology.parameterSchemaIdentity) || !exactDigest(methodology.parameterSchemaDigest)) {
    add(blockers, 'PARAMETER_SCHEMA_INVALID');
  }
  if (positiveFinite(methodology.methodologyFrozenAtMs)
    && positiveFinite(validation?.validationObservedAtMs)
    && methodology.methodologyFrozenAtMs > validation.validationObservedAtMs) {
    add(blockers, 'CALIBRATION_METHODOLOGY_FROZEN_TOO_LATE');
  }
  return blockers;
}

function validateCandidate(candidate, validation, v3SplitIndex, methodology, expectedArtifactProducerCodeSha) {
  const blockers = [];
  if (!object(candidate)) return ['CALIBRATION_ARTIFACT_CANDIDATE_REQUIRED'];
  if (!text(candidate.artifactIdentity) || !text(candidate.artifactVersion)) add(blockers, 'ARTIFACT_IDENTITY_INVALID');
  if (!exactCommitSha(expectedArtifactProducerCodeSha)
    || candidate.artifactProducerCodeSha !== expectedArtifactProducerCodeSha) {
    add(blockers, 'ARTIFACT_PRODUCER_SHA_MISMATCH');
  }
  if (!positiveFinite(candidate.producedAtMs)) add(blockers, 'ARTIFACT_PRODUCED_AT_INVALID');
  if (candidate.sourceContractFamily !== SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY
    || candidate.oosValidationSchemaVersion !== PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION) {
    add(blockers, 'ARTIFACT_NATIVE_SUCCESSOR_V3_SOURCE_INVALID');
  }
  if (candidate.oosValidationDigest !== validation.validationDigest
    || candidate.v3IndependentSplitIndexDigest !== validation.v3IndependentSplitIndexDigest
    || candidate.sourceInventoryDigest !== validation.sourceInventoryDigest
    || candidate.independenceAuditDigest !== validation.independenceAuditDigest
    || candidate.independentSplitSourceDigest !== validation.independentSplitSourceDigest) {
    add(blockers, 'ARTIFACT_NATIVE_OOS_LINEAGE_MISMATCH');
  }
  if (candidate.scheduleReliabilityNumericFreezeSha256 !== validation.scheduleReliabilityNumericFreezeSha256
    || candidate.policyDigest !== validation.policyDigest
    || candidate.cohortDigest !== validation.cohortDigest
    || candidate.oosHorizonPolicyDigest !== validation.oosHorizonPolicyDigest
    || candidate.oosHorizonContractDigest !== validation.oosHorizonContractDigest
    || candidate.oosOutcomeHorizonMs !== validation.outcomeHorizonMs
    || candidate.oosOutcomeSelectionPolicy !== SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeSelectionPolicy) {
    add(blockers, 'ARTIFACT_FROZEN_POLICY_HORIZON_MISMATCH');
  }
  if (candidate.calibrationMethodologyDigest !== methodology.methodologyDigest
    || candidate.estimatorIdentity !== methodology.estimatorIdentity
    || candidate.estimatorDigest !== methodology.estimatorDigest
    || candidate.parameterSchemaIdentity !== methodology.parameterSchemaIdentity
    || candidate.parameterSchemaDigest !== methodology.parameterSchemaDigest) {
    add(blockers, 'ARTIFACT_METHODOLOGY_BINDING_MISMATCH');
  }
  if (!exactDigest(candidate.parameterPayloadDigest)) add(blockers, 'PARAMETER_PAYLOAD_DIGEST_INVALID');
  if (!exactDigest(candidate.fitEvidenceDigest)) add(blockers, 'FIT_EVIDENCE_DIGEST_INVALID');
  if (!positiveInteger(candidate.trainObservationCount) || !positiveInteger(candidate.validationObservationCount)) {
    add(blockers, 'FIT_SAMPLE_COUNT_INVALID');
  }
  if (!positiveInteger(candidate.oosObservationCount)
    || candidate.oosObservationCount !== validation.genuineOosOutcomeN
    || candidate.acceptedGenuineOosN !== validation.genuineOosOutcomeN
    || candidate.buyOosOutcomeN !== validation.buyOosOutcomeN
    || candidate.sellOosOutcomeN !== validation.sellOosOutcomeN) {
    add(blockers, 'OOS_SAMPLE_COUNT_MISMATCH');
  }
  if (!nonnegativeInteger(candidate.rejectedOosN)
    || !Array.isArray(candidate.rejectionReasons)
    || candidate.rejectionReasons.some((reason) => !text(reason))) {
    add(blockers, 'OOS_REJECTION_PROVENANCE_INVALID');
  }
  if (candidate.oosUsedForFit !== false || candidate.noRetuningAssertion !== true) {
    add(blockers, 'ARTIFACT_HOLDOUT_OR_RETUNING_INVALID');
  }
  if (candidate.historicalBackfillCredit !== 0
    || candidate.replayCredit !== 0
    || candidate.backfillCredit !== 0
    || candidate.manualCredit !== 0
    || candidate.syntheticCredit !== 0
    || candidate.testFixtureCredit !== 0
    || candidate.naturalEntryCredit !== 0
    || candidate.runtimeCostCredit !== 0) {
    add(blockers, 'NON_GENUINE_OR_ECONOMIC_CREDIT_FORBIDDEN');
  }
  if (candidate.liquidityImpactCostBps !== null || candidate.runtimeLiquidityImpactCoefficient !== null) {
    add(blockers, 'RUNTIME_LIQUIDITY_COST_FORBIDDEN');
  }
  if (candidate.fullCostReady !== false
    || candidate.netAlphaReady !== false
    || candidate.profitabilityProven !== false
    || candidate.currentValidatedChampion !== 'NONE'
    || candidate.executionAuthority !== 'NONE') {
    add(blockers, 'PREMATURE_ECONOMIC_PROMOTION_FORBIDDEN');
  }
  if (FORBIDDEN_PERFORMANCE_FIELDS.some((key) => candidate[key] != null)) {
    add(blockers, 'UNAUTHORIZED_PERFORMANCE_STATISTIC_FORBIDDEN');
  }
  if (positiveFinite(candidate.producedAtMs) && positiveFinite(methodology.methodologyFrozenAtMs)
    && candidate.producedAtMs < methodology.methodologyFrozenAtMs) {
    add(blockers, 'ARTIFACT_PRECEDES_FROZEN_METHODOLOGY');
  }
  if (!Array.isArray(v3SplitIndex.sourceDatasetDigests)
    || v3SplitIndex.sourceDatasetDigests.length === 0
    || v3SplitIndex.sourceDatasetDigests.some((value) => !exactDigest(value))) {
    add(blockers, 'ARTIFACT_OOS_SOURCE_DATASET_LINEAGE_INVALID');
  }
  return blockers;
}

function oosLineageSummary(v3SplitIndex) {
  const verdict = validatePublicForwardLiquiditySuccessorV3SplitIndex(v3SplitIndex);
  const assignments = verdict.valid ? verdict.oosAssignments : [];
  return Object.freeze(assignments.map((assignment) => Object.freeze({
    observationId: assignment.observationId,
    sourceObservationId: assignment.sourceObservationId,
    sourceIdentity: assignment.sourceIdentity,
    ingestSourceIdentity: assignment.ingestSourceIdentity,
    slotIndex: assignment.slotIndex,
    split: assignment.split,
    canonicalSlotKeyDigest: assignment.canonicalSlotKeyDigest,
    collectorCodeSha: assignment.collectorCodeSha,
    datasetDigest: assignment.datasetDigest,
    ingestReceiptRelativePath: assignment.ingestReceiptRelativePath,
    ingestReceiptDigest: assignment.ingestReceiptDigest,
    captureReceiptDigest: assignment.captureReceiptDigest,
    artifactReceiptDigest: assignment.artifactReceiptDigest,
    policyDigest: assignment.policyDigest,
    cohortDigest: assignment.cohortDigest,
  })));
}

export function validatePublicForwardLiquidityCalibrationArtifact({
  oosValidationResult,
  oosValidation,
  v3SplitIndex,
  calibrationMethodology,
  candidate,
  expectedArtifactProducerCodeSha,
} = {}) {
  const normalized = normalizeNativeValidationInput(oosValidationResult, oosValidation);
  if (!normalized.validation) {
    return notReady(normalized.blockers, { calibrationInputN: normalized.calibrationInputN });
  }

  const validation = normalized.validation;
  const validationBlockers = validateNativeOosValidation(validation, v3SplitIndex);
  if (validationBlockers.length > 0) {
    return notReady(validationBlockers, {
      calibrationInputN: nonnegativeInteger(validation.genuineOosOutcomeN)
        ? validation.genuineOosOutcomeN
        : null,
    });
  }
  const methodologyBlockers = validateMethodology(calibrationMethodology, validation);
  if (methodologyBlockers.length > 0) {
    return notReady(methodologyBlockers, { calibrationInputN: validation.genuineOosOutcomeN });
  }
  const candidateBlockers = validateCandidate(
    candidate,
    validation,
    v3SplitIndex,
    calibrationMethodology,
    expectedArtifactProducerCodeSha,
  );
  if (candidateBlockers.length > 0) {
    return notReady(candidateBlockers, { calibrationInputN: validation.genuineOosOutcomeN });
  }

  const split = frozenSplitDescriptor();
  const lineage = oosLineageSummary(v3SplitIndex);
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION,
    artifactIdentity: candidate.artifactIdentity,
    artifactVersion: candidate.artifactVersion,
    artifactProducerCodeSha: expectedArtifactProducerCodeSha,
    exactProducerVersion: candidate.artifactVersion,
    createdAtMs: candidate.producedAtMs,
    producedAtMs: candidate.producedAtMs,
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    independentSplitIndexSchemaVersion: PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION,
    v3IndependentSplitIndexDigest: validation.v3IndependentSplitIndexDigest,
    sourceInventoryDigest: validation.sourceInventoryDigest,
    sourceDatasetDigests: Object.freeze([...v3SplitIndex.sourceDatasetDigests]),
    predecessorFinalDatasetChainValidatedByIndependentIndex: true,
    independenceAuditDigest: validation.independenceAuditDigest,
    independentSplitSourceDigest: validation.independentSplitSourceDigest,
    oosValidationSchemaVersion: PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION,
    oosValidationDigest: validation.validationDigest,
    oosOutcomeDigest: validation.outcomeDigest,
    scheduleReliabilityContractVersion: validation.scheduleReliabilityContractVersion,
    scheduleReliabilityNumericFreezeSha256: validation.scheduleReliabilityNumericFreezeSha256,
    policyDigest: validation.policyDigest,
    cohortDigest: validation.cohortDigest,
    frozenSplit: split,
    oosHorizonContractVersion: validation.oosHorizonContractVersion,
    oosHorizonPolicyDigest: validation.oosHorizonPolicyDigest,
    oosHorizonContractDigest: validation.oosHorizonContractDigest,
    oosOutcomeHorizonMs: validation.outcomeHorizonMs,
    oosOutcomeSelectionPolicy: SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeSelectionPolicy,
    oosLineage: lineage,
    calibrationMethodologyIdentity: calibrationMethodology.methodologyIdentity,
    calibrationMethodologyVersion: calibrationMethodology.methodologyVersion,
    calibrationMethodologyDigest: calibrationMethodology.methodologyDigest,
    calibrationMethodIdentity: calibrationMethodology.estimatorIdentity,
    estimatorIdentity: calibrationMethodology.estimatorIdentity,
    estimatorDigest: calibrationMethodology.estimatorDigest,
    parameterSchemaIdentity: calibrationMethodology.parameterSchemaIdentity,
    parameterSchemaDigest: calibrationMethodology.parameterSchemaDigest,
    parameterPayloadDigest: candidate.parameterPayloadDigest,
    fitEvidenceDigest: candidate.fitEvidenceDigest,
    trainObservationCount: candidate.trainObservationCount,
    validationObservationCount: candidate.validationObservationCount,
    oosObservationCount: candidate.oosObservationCount,
    acceptedGenuineOosN: validation.genuineOosOutcomeN,
    buyOosOutcomeN: validation.buyOosOutcomeN,
    sellOosOutcomeN: validation.sellOosOutcomeN,
    rejectedOosN: candidate.rejectedOosN,
    rejectionReasons: Object.freeze([...candidate.rejectionReasons]),
    oosUsedForFit: false,
    heldOutOosValidated: true,
    contaminationFree: true,
    noRetuningAssertion: true,
    historicalBackfillCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    testFixtureCredit: 0,
    calibrationArtifactProduced: true,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    runtimeLiquidityImpactCoefficient: null,
    liquidityImpactCostBps: null,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    evidenceComplete: 0,
    fullCostReady: false,
    netAlphaReady: false,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE',
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  const artifact = Object.freeze({ ...body, artifactDigest: sha256(body) });
  return Object.freeze({
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION,
    status: 'PRESENT',
    calibrationStatus: 'READY',
    calibrationReason: null,
    calibrationInputN: validation.genuineOosOutcomeN,
    blockers: Object.freeze([]),
    artifact,
    calibrationArtifactProduced: true,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    evidenceComplete: 0,
    fullCostReady: false,
    netAlphaReady: false,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE',
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    safety: PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY,
  });
}

import { createHash } from 'node:crypto';

import {
  PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION,
  SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
} from './public-forward-liquidity-calibration-oos-outcome-validator.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  verifySuccessorScheduleReliabilityV3Contract,
} from './public-forward-liquidity-successor-schedule-reliability-v3.mjs';
import {
  SUCCESSOR_OOS_HORIZON_CONTRACT,
  verifySuccessorOosOutcomeHorizonContract,
} from './public-forward-liquidity-successor-oos-outcome-horizon.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION =
  'public-forward-liquidity-successor-v3-calibration-artifact-v2';

export const GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING =
  'GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING';

export const PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY = Object.freeze({
  nativeSuccessorV3OosOnly: true,
  verifiedOosReceiptRequired: true,
  preFrozenCalibrationMethodologyRequired: true,
  trainValidationFitOnly: true,
  oosFitAllowed: false,
  outcomeInspectionRetuningAllowed: false,
  coefficientInventedByThisContract: false,
  probabilityInventedByThisContract: false,
  expectedValueInventedByThisContract: false,
  statisticalResultInventedByThisContract: false,
  runtimeCostProduced: false,
  liquidityImpactPresent: false,
  naturalEntryCredit: 0,
  runtimeCostCredit: 0,
  syntheticEconomicCredit: 0,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
  fullCostReady: false,
  netAlphaReady: false,
  evidenceComplete: 0,
  profitabilityProven: false,
  currentValidatedChampion: 'NONE',
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

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
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

function add(list, code) {
  if (!list.includes(code)) list.push(code);
}

function nativeBinding() {
  const schedule = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT;
  const horizon = SUCCESSOR_OOS_HORIZON_CONTRACT;
  return Object.freeze({
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    scheduleReliabilityContractVersion: schedule.contractVersion,
    scheduleReliabilityNumericFreezeSha256: schedule.numericFreezeSha256,
    policyDigest: schedule.policyDigest,
    cohortDigest: schedule.cohortDigest,
    trainStartIndexInclusive: schedule.policyCore.splits.TRAIN.startIndexInclusive,
    trainEndIndexInclusive: schedule.policyCore.splits.TRAIN.endIndexInclusive,
    validationStartIndexInclusive: schedule.policyCore.splits.VALIDATION.startIndexInclusive,
    validationEndIndexInclusive: schedule.policyCore.splits.VALIDATION.endIndexInclusive,
    oosStartIndexInclusive: schedule.policyCore.splits.OOS.startIndexInclusive,
    oosEndIndexInclusive: schedule.policyCore.splits.OOS.endIndexInclusive,
    oosHorizonContractVersion: horizon.contractVersion,
    oosHorizonPolicyDigest: horizon.policyDigest,
    oosHorizonContractDigest: horizon.contractDigest,
    outcomeHorizonMs: horizon.policyCore.outcomePolicy.outcomeHorizonMs,
    outcomeSelectionPolicy: horizon.policyCore.outcomePolicy.outcomeSelectionPolicy,
  });
}

export const SUCCESSOR_V3_CALIBRATION_NATIVE_BINDING = nativeBinding();

function notReady(reason, blockers = []) {
  return Object.freeze({
    status: 'NOT_READY',
    reason,
    blockers: Object.freeze([...new Set(blockers)]),
    calibrationInputN: 0,
    calibrationArtifactProduced: false,
    artifact: null,
    statisticalResults: null,
    fullCostReady: false,
    netAlphaReady: false,
    evidenceComplete: 0,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE',
    executionAuthority: 'NONE',
    safety: PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY,
  });
}

export function computePublicForwardLiquidityCalibrationMethodologyDigest(methodology) {
  if (!object(methodology)) throw new TypeError('CALIBRATION_METHODOLOGY_REQUIRED');
  return sha256(withoutKey(methodology, 'methodologyDigest'));
}

function validateNativeOosValidation(validation) {
  const blockers = [];
  if (!object(validation)) return [GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING];
  const scheduleVerdict = verifySuccessorScheduleReliabilityV3Contract();
  const horizonVerdict = verifySuccessorOosOutcomeHorizonContract();
  if (!scheduleVerdict.valid || SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.activationBound !== true) {
    add(blockers, 'SUCCESSOR_V3_SCHEDULE_RELIABILITY_CONTRACT_INVALID');
  }
  if (!horizonVerdict.valid) add(blockers, 'SUCCESSOR_V3_OOS_HORIZON_CONTRACT_INVALID');
  if (validation.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION) {
    add(blockers, 'SUCCESSOR_V3_OOS_VALIDATION_VERSION_INVALID');
  }
  if (validation.sourceContractFamily !== SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY) {
    add(blockers, 'SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY_INVALID');
  }
  if (!exactDigest(validation.validationDigest)) add(blockers, 'SUCCESSOR_V3_OOS_VALIDATION_DIGEST_INVALID');
  else if (validation.validationDigest !== sha256(withoutKey(validation, 'validationDigest'))) {
    add(blockers, 'SUCCESSOR_V3_OOS_VALIDATION_DIGEST_MISMATCH');
  }
  for (const [field, code] of [
    ['v3IndependentSplitIndexDigest', 'SUCCESSOR_V3_SPLIT_INDEX_DIGEST_INVALID'],
    ['sourceInventoryDigest', 'SUCCESSOR_V3_SOURCE_INVENTORY_DIGEST_INVALID'],
    ['independenceAuditDigest', 'SUCCESSOR_V3_INDEPENDENCE_AUDIT_DIGEST_INVALID'],
    ['independentSplitSourceDigest', 'SUCCESSOR_V3_INDEPENDENT_SPLIT_SOURCE_DIGEST_INVALID'],
    ['oosHorizonPolicyDigest', 'SUCCESSOR_V3_OOS_HORIZON_POLICY_DIGEST_INVALID'],
    ['oosHorizonContractDigest', 'SUCCESSOR_V3_OOS_HORIZON_CONTRACT_DIGEST_INVALID'],
    ['outcomeDigest', 'SUCCESSOR_V3_OOS_OUTCOME_DIGEST_INVALID'],
  ]) {
    if (!exactDigest(validation[field])) add(blockers, code);
  }
  const expected = SUCCESSOR_V3_CALIBRATION_NATIVE_BINDING;
  if (validation.scheduleReliabilityContractVersion !== expected.scheduleReliabilityContractVersion
    || validation.scheduleReliabilityNumericFreezeSha256 !== expected.scheduleReliabilityNumericFreezeSha256) {
    add(blockers, 'SUCCESSOR_V3_NUMERIC_FREEZE_LINEAGE_MISMATCH');
  }
  if (validation.policyDigest !== expected.policyDigest) add(blockers, 'SUCCESSOR_V3_POLICY_DIGEST_MISMATCH');
  if (validation.cohortDigest !== expected.cohortDigest) add(blockers, 'SUCCESSOR_V3_COHORT_DIGEST_MISMATCH');
  if (validation.oosHorizonContractVersion !== expected.oosHorizonContractVersion
    || validation.oosHorizonPolicyDigest !== expected.oosHorizonPolicyDigest
    || validation.oosHorizonContractDigest !== expected.oosHorizonContractDigest
    || validation.outcomeHorizonMs !== expected.outcomeHorizonMs) {
    add(blockers, 'SUCCESSOR_V3_OOS_HORIZON_MISMATCH');
  }
  if (!positiveInteger(validation.genuineV3OosSlotN)
    || !positiveInteger(validation.genuineOosOutcomeN)) {
    add(blockers, GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING);
  }
  if (!nonNegativeInteger(validation.buyOosOutcomeN)
    || !nonNegativeInteger(validation.sellOosOutcomeN)
    || validation.buyOosOutcomeN + validation.sellOosOutcomeN !== validation.genuineOosOutcomeN) {
    add(blockers, 'SUCCESSOR_V3_OOS_SIDE_BREAKDOWN_INVALID');
  }
  if (!Array.isArray(validation.outcomeIds)
    || validation.outcomeIds.length !== validation.genuineOosOutcomeN
    || new Set(validation.outcomeIds).size !== validation.outcomeIds.length
    || validation.outcomeIds.some((value) => !text(value))) {
    add(blockers, 'SUCCESSOR_V3_OOS_OUTCOME_IDENTITY_INVALID');
  }
  if (validation.exactOosCoverage !== true
    || validation.heldOut !== true
    || validation.contaminationFree !== true
    || validation.retrospectiveSplitSelection !== false) {
    add(blockers, 'SUCCESSOR_V3_OOS_HOLDOUT_INTEGRITY_INVALID');
  }
  if (validation.replayCredit !== 0
    || validation.backfillCredit !== 0
    || validation.syntheticCredit !== 0
    || validation.calibrationArtifactProduced !== false
    || validation.liquidityImpactPresent !== false
    || validation.liquidityImpactStatus !== 'BLOCKED_DATA'
    || validation.fullCostReady !== false
    || validation.evidenceCompleteCredit !== 0
    || validation.executionAuthority !== 'NONE') {
    add(blockers, 'SUCCESSOR_V3_OOS_TRUTH_BOUNDARY_INVALID');
  }
  return blockers;
}

function validateMethodology(methodology) {
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
  if (methodology.outcomeInspectionUsedForSelection !== false || methodology.noRetuningAssertion !== true) {
    add(blockers, 'CALIBRATION_NO_RETUNING_ASSERTION_INVALID');
  }
  if (!text(methodology.calibrationMethodIdentity) || !exactDigest(methodology.calibrationMethodDigest)) {
    add(blockers, 'CALIBRATION_METHOD_IDENTITY_INVALID');
  }
  return blockers;
}

function validateCandidate(candidate, validation, methodology, expectedArtifactProducerCodeSha) {
  const blockers = [];
  if (!object(candidate)) return ['CALIBRATION_ARTIFACT_CANDIDATE_REQUIRED'];
  if (!text(candidate.artifactIdentity) || !text(candidate.artifactVersion)) add(blockers, 'ARTIFACT_IDENTITY_INVALID');
  if (!exactCommitSha(expectedArtifactProducerCodeSha)
    || candidate.artifactProducerCodeSha !== expectedArtifactProducerCodeSha) {
    add(blockers, 'ARTIFACT_PRODUCER_SHA_MISMATCH');
  }
  if (!positiveFinite(candidate.producedAtMs)) add(blockers, 'ARTIFACT_PRODUCED_AT_INVALID');
  for (const [candidateField, validationField, code] of [
    ['oosValidationDigest', 'validationDigest', 'ARTIFACT_OOS_VALIDATION_DIGEST_MISMATCH'],
    ['v3IndependentSplitIndexDigest', 'v3IndependentSplitIndexDigest', 'ARTIFACT_SPLIT_INDEX_DIGEST_MISMATCH'],
    ['sourceInventoryDigest', 'sourceInventoryDigest', 'ARTIFACT_SOURCE_INVENTORY_DIGEST_MISMATCH'],
    ['independenceAuditDigest', 'independenceAuditDigest', 'ARTIFACT_INDEPENDENCE_DIGEST_MISMATCH'],
    ['independentSplitSourceDigest', 'independentSplitSourceDigest', 'ARTIFACT_SPLIT_SOURCE_DIGEST_MISMATCH'],
    ['policyDigest', 'policyDigest', 'ARTIFACT_POLICY_DIGEST_MISMATCH'],
    ['cohortDigest', 'cohortDigest', 'ARTIFACT_COHORT_DIGEST_MISMATCH'],
    ['oosHorizonContractDigest', 'oosHorizonContractDigest', 'ARTIFACT_OOS_HORIZON_DIGEST_MISMATCH'],
    ['oosOutcomeDigest', 'outcomeDigest', 'ARTIFACT_OOS_OUTCOME_DIGEST_MISMATCH'],
  ]) {
    if (candidate[candidateField] !== validation[validationField]) add(blockers, code);
  }
  if (candidate.calibrationMethodologyDigest !== methodology.methodologyDigest) {
    add(blockers, 'ARTIFACT_METHODOLOGY_DIGEST_MISMATCH');
  }
  if (!exactDigest(candidate.fitEvidenceDigest)) add(blockers, 'FIT_EVIDENCE_DIGEST_INVALID');
  if (!positiveInteger(candidate.trainObservationCount)
    || !positiveInteger(candidate.validationObservationCount)) {
    add(blockers, 'FIT_SAMPLE_COUNT_INVALID');
  }
  if (candidate.oosObservationCount !== validation.genuineOosOutcomeN
    || !positiveInteger(candidate.oosObservationCount)) {
    add(blockers, 'OOS_SAMPLE_COUNT_MISMATCH');
  }
  if (candidate.statisticalAdmissionReady !== true
    || !exactDigest(candidate.statisticalAdmissionDigest)) {
    add(blockers, 'STATISTICAL_ADMISSION_NOT_READY');
  }
  if (candidate.oosUsedForFit !== false || candidate.noRetuningAssertion !== true) {
    add(blockers, 'ARTIFACT_OOS_FIT_OR_RETUNING_FORBIDDEN');
  }
  if (candidate.manualSampleCredit !== 0
    || candidate.historicalBackfillCredit !== 0
    || candidate.replayCredit !== 0
    || candidate.testFixtureCredit !== 0
    || candidate.syntheticEconomicCredit !== 0
    || candidate.naturalEntryCredit !== 0
    || candidate.runtimeCostCredit !== 0) {
    add(blockers, 'NON_FORWARD_ARTIFACT_CREDIT_FORBIDDEN');
  }
  if (candidate.probability !== null
    || candidate.expectedValue !== null
    || candidate.netAlpha !== null
    || candidate.winRate !== null
    || candidate.liquidityImpactCostBps !== null
    || candidate.runtimeLiquidityImpactCoefficient !== null) {
    add(blockers, 'RUNTIME_LIQUIDITY_COST_FORBIDDEN');
  }
  if (candidate.fullCostReady !== false
    || candidate.netAlphaReady !== false
    || candidate.profitabilityProven !== false
    || candidate.currentValidatedChampion !== 'NONE'
    || candidate.executionAuthority !== 'NONE') {
    add(blockers, 'ARTIFACT_ECONOMIC_OR_EXECUTION_PROMOTION_FORBIDDEN');
  }
  if (!nonNegativeInteger(candidate.rejectedOosN)
    || !Array.isArray(candidate.rejectionReasons)
    || candidate.rejectionReasons.some((value) => !text(value))) {
    add(blockers, 'ARTIFACT_REJECTION_PROVENANCE_INVALID');
  }
  return blockers;
}

export function validatePublicForwardLiquidityCalibrationArtifact({
  oosValidation,
  calibrationMethodology,
  candidate,
  expectedArtifactProducerCodeSha,
} = {}) {
  const validationBlockers = validateNativeOosValidation(oosValidation);
  if (validationBlockers.length > 0) {
    const missing = validationBlockers.includes(GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING);
    return notReady(
      missing ? GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING : 'SUCCESSOR_V3_NATIVE_OOS_LINEAGE_INVALID',
      validationBlockers,
    );
  }
  const methodologyBlockers = validateMethodology(calibrationMethodology);
  if (methodologyBlockers.length > 0) {
    return notReady('CALIBRATION_METHODOLOGY_NOT_READY', methodologyBlockers);
  }
  const candidateBlockers = validateCandidate(
    candidate,
    oosValidation,
    calibrationMethodology,
    expectedArtifactProducerCodeSha,
  );
  if (candidateBlockers.length > 0) {
    return notReady(
      candidateBlockers.includes('STATISTICAL_ADMISSION_NOT_READY')
        ? 'INSUFFICIENT_STATISTICAL_EVIDENCE'
        : 'CALIBRATION_ARTIFACT_CANDIDATE_INVALID',
      candidateBlockers,
    );
  }

  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION,
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    artifactIdentity: candidate.artifactIdentity,
    artifactVersion: candidate.artifactVersion,
    artifactProducerCodeSha: expectedArtifactProducerCodeSha,
    creationTimestampMs: candidate.producedAtMs,
    scheduleReliabilityContractVersion: oosValidation.scheduleReliabilityContractVersion,
    scheduleReliabilityNumericFreezeSha256: oosValidation.scheduleReliabilityNumericFreezeSha256,
    frozenPolicyDigest: oosValidation.policyDigest,
    frozenCohortDigest: oosValidation.cohortDigest,
    frozenSplit: Object.freeze({
      TRAIN: Object.freeze({ startIndexInclusive: 0, endIndexInclusive: 511 }),
      VALIDATION: Object.freeze({ startIndexInclusive: 512, endIndexInclusive: 767 }),
      OOS: Object.freeze({ startIndexInclusive: 768, endIndexInclusive: 1023 }),
    }),
    oosHorizonMs: oosValidation.outcomeHorizonMs,
    oosHorizonPolicyDigest: oosValidation.oosHorizonPolicyDigest,
    oosHorizonContractDigest: oosValidation.oosHorizonContractDigest,
    v3IndependentSplitIndexDigest: oosValidation.v3IndependentSplitIndexDigest,
    sourceInventoryDigest: oosValidation.sourceInventoryDigest,
    independenceAuditDigest: oosValidation.independenceAuditDigest,
    independentSplitSourceDigest: oosValidation.independentSplitSourceDigest,
    oosValidationDigest: oosValidation.validationDigest,
    oosSourceDatasetDigest: oosValidation.outcomeDigest,
    acceptedGenuineOosN: oosValidation.genuineOosOutcomeN,
    buyOosOutcomeN: oosValidation.buyOosOutcomeN,
    sellOosOutcomeN: oosValidation.sellOosOutcomeN,
    rejectedOosN: candidate.rejectedOosN,
    rejectionReasons: Object.freeze([...candidate.rejectionReasons]),
    calibrationMethodIdentity: calibrationMethodology.calibrationMethodIdentity,
    calibrationMethodDigest: calibrationMethodology.calibrationMethodDigest,
    calibrationMethodologyDigest: calibrationMethodology.methodologyDigest,
    fitEvidenceDigest: candidate.fitEvidenceDigest,
    trainObservationCount: candidate.trainObservationCount,
    validationObservationCount: candidate.validationObservationCount,
    oosObservationCount: candidate.oosObservationCount,
    statisticalAdmissionDigest: candidate.statisticalAdmissionDigest,
    statisticalResults: null,
    probability: null,
    expectedValue: null,
    netAlpha: null,
    winRate: null,
    noRetuningAssertion: true,
    oosUsedForFit: false,
    calibrationArtifactProduced: true,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    runtimeLiquidityImpactCoefficient: null,
    liquidityImpactCostBps: null,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    syntheticEconomicCredit: 0,
    fullCostReady: false,
    netAlphaReady: false,
    evidenceComplete: 0,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE',
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  const artifact = Object.freeze({ ...body, artifactDigest: sha256(body) });
  return Object.freeze({
    status: 'READY',
    reason: null,
    blockers: Object.freeze([]),
    calibrationInputN: oosValidation.genuineOosOutcomeN,
    calibrationArtifactProduced: true,
    artifact,
    statisticalResults: null,
    fullCostReady: false,
    netAlphaReady: false,
    evidenceComplete: 0,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE',
    executionAuthority: 'NONE',
    safety: PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY,
  });
}

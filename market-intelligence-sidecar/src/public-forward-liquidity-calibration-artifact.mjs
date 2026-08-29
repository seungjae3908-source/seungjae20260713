import { createHash } from 'node:crypto';

import { PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_VERSION } from './public-forward-liquidity-calibration-oos-outcome-validator.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION =
  'public-forward-liquidity-calibration-artifact-v1';

export const PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY = Object.freeze({
  verifiedOosReceiptRequired: true,
  preFrozenCalibrationMethodologyRequired: true,
  trainValidationFitOnly: true,
  oosFitAllowed: false,
  coefficientInventedByThisContract: false,
  runtimeCostProduced: false,
  liquidityImpactPresent: false,
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

function add(list, code) {
  if (!list.includes(code)) list.push(code);
}

function blocked(blockers) {
  return Object.freeze({
    status: 'BLOCKED_DATA',
    blockers: Object.freeze([...new Set(blockers)]),
    artifact: null,
    safety: PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY,
  });
}

export function computePublicForwardLiquidityCalibrationMethodologyDigest(methodology) {
  if (!object(methodology)) throw new TypeError('CALIBRATION_METHODOLOGY_REQUIRED');
  return sha256(withoutKey(methodology, 'methodologyDigest'));
}

function validateOosValidation(validation) {
  const blockers = [];
  if (!object(validation)) return ['OOS_VALIDATION_REQUIRED'];
  if (validation.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_VERSION) add(blockers, 'OOS_VALIDATION_VERSION_INVALID');
  if (!exactDigest(validation.validationDigest)) add(blockers, 'OOS_VALIDATION_DIGEST_INVALID');
  else if (validation.validationDigest !== sha256(withoutKey(validation, 'validationDigest'))) add(blockers, 'OOS_VALIDATION_DIGEST_MISMATCH');
  if (!exactDigest(validation.splitAuditDigest)) add(blockers, 'SPLIT_AUDIT_DIGEST_INVALID');
  if (!exactDigest(validation.datasetDigest)) add(blockers, 'DATASET_DIGEST_INVALID');
  if (!exactDigest(validation.splitPolicyDigest)) add(blockers, 'SPLIT_POLICY_DIGEST_INVALID');
  if (!exactDigest(validation.methodologyDigest)) add(blockers, 'OOS_METHODOLOGY_DIGEST_INVALID');
  if (!exactDigest(validation.outcomeDigest)) add(blockers, 'OOS_OUTCOME_DIGEST_INVALID');
  if (!exactDigest(validation.oosAssignmentDigest)) add(blockers, 'OOS_ASSIGNMENT_DIGEST_INVALID');
  if (!exactCommitSha(validation.collectorCodeSha) || !exactCommitSha(validation.outcomeProducerCodeSha)) add(blockers, 'OOS_CODE_SHA_INVALID');
  if (validation.oosValidationComplete !== true || validation.exactOosCoverage !== true) add(blockers, 'OOS_VALIDATION_INCOMPLETE');
  if (validation.heldOut !== true || validation.contaminationFree !== true) add(blockers, 'OOS_HOLDOUT_INTEGRITY_INVALID');
  if (validation.genuinePublicForwardMarketData !== true) add(blockers, 'PUBLIC_FORWARD_OOS_REQUIRED');
  if (validation.causalMarketImpactClaim !== false) add(blockers, 'OOS_CAUSAL_CLAIM_FORBIDDEN');
  if (validation.calibrationArtifactProduced !== false || validation.liquidityImpactPresent !== false) add(blockers, 'UPSTREAM_ARTIFACT_BOUNDARY_INVALID');
  if (validation.liquidityImpactStatus !== 'BLOCKED_DATA' || validation.fullCostReady !== false) add(blockers, 'UPSTREAM_FULL_COST_BOUNDARY_INVALID');
  if (validation.naturalEntryCredit !== 0 || validation.runtimeCostCredit !== 0) add(blockers, 'UPSTREAM_RUNTIME_CREDIT_INVALID');
  if (validation.executionAuthority !== 'NONE' || validation.privateApiUsed !== false || validation.liveTrading !== false || validation.orderSubmitted !== false) {
    add(blockers, 'UPSTREAM_EXECUTION_SAFETY_INVALID');
  }
  return blockers;
}

function validateMethodology(methodology, validation) {
  const blockers = [];
  if (!object(methodology)) return ['CALIBRATION_METHODOLOGY_REQUIRED'];
  if (!text(methodology.methodologyIdentity) || !text(methodology.methodologyVersion)) add(blockers, 'CALIBRATION_METHODOLOGY_IDENTITY_INVALID');
  if (!exactDigest(methodology.methodologyDigest)) add(blockers, 'CALIBRATION_METHODOLOGY_DIGEST_INVALID');
  else if (methodology.methodologyDigest !== computePublicForwardLiquidityCalibrationMethodologyDigest(methodology)) add(blockers, 'CALIBRATION_METHODOLOGY_DIGEST_MISMATCH');
  if (!positiveFinite(methodology.methodologyFrozenAtMs)) add(blockers, 'CALIBRATION_METHODOLOGY_FROZEN_AT_INVALID');
  if (positiveFinite(methodology.methodologyFrozenAtMs) && positiveFinite(validation.methodologyFrozenAtMs)
    && methodology.methodologyFrozenAtMs > validation.methodologyFrozenAtMs) {
    add(blockers, 'CALIBRATION_METHODOLOGY_FROZEN_TOO_LATE');
  }
  if (!Array.isArray(methodology.fitSplits) || methodology.fitSplits.length !== 2
    || methodology.fitSplits[0] !== 'TRAIN' || methodology.fitSplits[1] !== 'VALIDATION') {
    add(blockers, 'CALIBRATION_FIT_SPLITS_INVALID');
  }
  if (methodology.oosUsedForFit !== false) add(blockers, 'OOS_FIT_FORBIDDEN');
  if (!text(methodology.estimatorIdentity) || !exactDigest(methodology.estimatorDigest)) add(blockers, 'ESTIMATOR_IDENTITY_INVALID');
  if (!text(methodology.parameterSchemaIdentity) || !exactDigest(methodology.parameterSchemaDigest)) add(blockers, 'PARAMETER_SCHEMA_INVALID');
  return blockers;
}

function validateCandidate(candidate, validation, methodology, expectedArtifactProducerCodeSha) {
  const blockers = [];
  if (!object(candidate)) return ['CALIBRATION_ARTIFACT_CANDIDATE_REQUIRED'];
  if (!text(candidate.artifactIdentity) || !text(candidate.artifactVersion)) add(blockers, 'ARTIFACT_IDENTITY_INVALID');
  if (!exactCommitSha(expectedArtifactProducerCodeSha) || candidate.artifactProducerCodeSha !== expectedArtifactProducerCodeSha) add(blockers, 'ARTIFACT_PRODUCER_SHA_MISMATCH');
  if (!positiveFinite(candidate.producedAtMs)) add(blockers, 'ARTIFACT_PRODUCED_AT_INVALID');
  if (candidate.oosValidationDigest !== validation.validationDigest) add(blockers, 'ARTIFACT_OOS_VALIDATION_DIGEST_MISMATCH');
  if (candidate.datasetDigest !== validation.datasetDigest) add(blockers, 'ARTIFACT_DATASET_DIGEST_MISMATCH');
  if (candidate.splitPolicyDigest !== validation.splitPolicyDigest) add(blockers, 'ARTIFACT_SPLIT_POLICY_DIGEST_MISMATCH');
  if (candidate.calibrationMethodologyDigest !== methodology.methodologyDigest) add(blockers, 'ARTIFACT_METHODOLOGY_DIGEST_MISMATCH');
  if (candidate.estimatorIdentity !== methodology.estimatorIdentity || candidate.estimatorDigest !== methodology.estimatorDigest) add(blockers, 'ARTIFACT_ESTIMATOR_MISMATCH');
  if (candidate.parameterSchemaIdentity !== methodology.parameterSchemaIdentity || candidate.parameterSchemaDigest !== methodology.parameterSchemaDigest) add(blockers, 'ARTIFACT_PARAMETER_SCHEMA_MISMATCH');
  if (!exactDigest(candidate.parameterPayloadDigest)) add(blockers, 'PARAMETER_PAYLOAD_DIGEST_INVALID');
  if (!exactDigest(candidate.fitEvidenceDigest)) add(blockers, 'FIT_EVIDENCE_DIGEST_INVALID');
  if (!positiveInteger(candidate.trainObservationCount) || !positiveInteger(candidate.validationObservationCount)) add(blockers, 'FIT_SAMPLE_COUNT_INVALID');
  if (candidate.oosObservationCount !== validation.scoredOutcomeCount || !positiveInteger(candidate.oosObservationCount)) add(blockers, 'OOS_SAMPLE_COUNT_MISMATCH');
  if (candidate.oosUsedForFit !== false) add(blockers, 'ARTIFACT_OOS_FIT_FORBIDDEN');
  if (candidate.historicalBackfillCredit !== 0 || candidate.testFixtureCredit !== 0) add(blockers, 'NON_FORWARD_ARTIFACT_CREDIT_FORBIDDEN');
  if (candidate.naturalEntryCredit !== 0 || candidate.runtimeCostCredit !== 0) add(blockers, 'ARTIFACT_RUNTIME_CREDIT_FORBIDDEN');
  if (candidate.liquidityImpactCostBps !== null || candidate.runtimeLiquidityImpactCoefficient !== null) add(blockers, 'RUNTIME_LIQUIDITY_COST_FORBIDDEN');
  return blockers;
}

export function validatePublicForwardLiquidityCalibrationArtifact({
  oosValidation,
  calibrationMethodology,
  candidate,
  expectedArtifactProducerCodeSha,
} = {}) {
  const validationBlockers = validateOosValidation(oosValidation);
  if (validationBlockers.length > 0) return blocked(validationBlockers);
  const methodologyBlockers = validateMethodology(calibrationMethodology, oosValidation);
  if (methodologyBlockers.length > 0) return blocked(methodologyBlockers);
  const candidateBlockers = validateCandidate(candidate, oosValidation, calibrationMethodology, expectedArtifactProducerCodeSha);
  if (candidateBlockers.length > 0) return blocked(candidateBlockers);

  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION,
    artifactIdentity: candidate.artifactIdentity,
    artifactVersion: candidate.artifactVersion,
    artifactProducerCodeSha: expectedArtifactProducerCodeSha,
    producedAtMs: candidate.producedAtMs,
    oosValidationDigest: oosValidation.validationDigest,
    datasetDigest: oosValidation.datasetDigest,
    splitPolicyDigest: oosValidation.splitPolicyDigest,
    calibrationMethodologyIdentity: calibrationMethodology.methodologyIdentity,
    calibrationMethodologyVersion: calibrationMethodology.methodologyVersion,
    calibrationMethodologyDigest: calibrationMethodology.methodologyDigest,
    estimatorIdentity: calibrationMethodology.estimatorIdentity,
    estimatorDigest: calibrationMethodology.estimatorDigest,
    parameterSchemaIdentity: calibrationMethodology.parameterSchemaIdentity,
    parameterSchemaDigest: calibrationMethodology.parameterSchemaDigest,
    parameterPayloadDigest: candidate.parameterPayloadDigest,
    fitEvidenceDigest: candidate.fitEvidenceDigest,
    trainObservationCount: candidate.trainObservationCount,
    validationObservationCount: candidate.validationObservationCount,
    oosObservationCount: candidate.oosObservationCount,
    oosUsedForFit: false,
    heldOutOosValidated: true,
    contaminationFree: true,
    calibrationArtifactProduced: true,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    runtimeLiquidityImpactCoefficient: null,
    liquidityImpactCostBps: null,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    fullCostReady: false,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  const artifact = Object.freeze({ ...body, artifactDigest: sha256(body) });
  return Object.freeze({
    status: 'PRESENT',
    blockers: Object.freeze([]),
    artifact,
    safety: PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY,
  });
}

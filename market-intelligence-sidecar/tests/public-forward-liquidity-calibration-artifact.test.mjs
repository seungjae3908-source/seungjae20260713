import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY,
  PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION,
  computePublicForwardLiquidityCalibrationMethodologyDigest,
  validatePublicForwardLiquidityCalibrationArtifact,
} from '../src/public-forward-liquidity-calibration-artifact.mjs';
import { PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_VERSION } from '../src/public-forward-liquidity-calibration-oos-outcome-validator.mjs';

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalize(v)]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

const D1 = '1'.repeat(64);
const D2 = '2'.repeat(64);
const D3 = '3'.repeat(64);
const D4 = '4'.repeat(64);
const D5 = '5'.repeat(64);
const D6 = '6'.repeat(64);
const D7 = '7'.repeat(64);
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const ARTIFACT_SHA = 'c'.repeat(40);

function validOosValidation() {
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_VERSION,
    splitAuditDigest: D1,
    datasetContract: 'public-forward-liquidity-calibration-v1',
    datasetStoreContract: 'public-forward-liquidity-calibration-store-v1',
    datasetDigest: D2,
    collectorCodeSha: SHA1,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    splitPolicyIdentity: 'liq-split-policy',
    splitPolicyVersion: 'v1',
    splitPolicyDigest: D3,
    methodologyIdentity: 'liq-oos-methodology',
    methodologyDigest: D4,
    methodologyFrozenAtMs: 1_000,
    outcomeHorizonIdentity: 'horizon-5m',
    outcomeProducerCodeSha: SHA2,
    oosAssignmentCount: 3,
    scoredOutcomeCount: 3,
    oosAssignmentDigest: D5,
    outcomeIds: ['o1', 'o2', 'o3'],
    outcomeDigest: D6,
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
  return { ...body, validationDigest: digest(body) };
}

function validMethodology() {
  const body = {
    methodologyIdentity: 'liq-calibration-methodology',
    methodologyVersion: 'v1',
    methodologyFrozenAtMs: 900,
    fitSplits: ['TRAIN', 'VALIDATION'],
    oosUsedForFit: false,
    estimatorIdentity: 'pre-registered-estimator',
    estimatorDigest: D7,
    parameterSchemaIdentity: 'liq-impact-parameter-payload-v1',
    parameterSchemaDigest: '8'.repeat(64),
  };
  return { ...body, methodologyDigest: computePublicForwardLiquidityCalibrationMethodologyDigest(body) };
}

function validCandidate(validation, methodology) {
  return {
    artifactIdentity: 'liq-calibration-artifact-001',
    artifactVersion: 'v1',
    artifactProducerCodeSha: ARTIFACT_SHA,
    producedAtMs: 2_000,
    oosValidationDigest: validation.validationDigest,
    datasetDigest: validation.datasetDigest,
    splitPolicyDigest: validation.splitPolicyDigest,
    calibrationMethodologyDigest: methodology.methodologyDigest,
    estimatorIdentity: methodology.estimatorIdentity,
    estimatorDigest: methodology.estimatorDigest,
    parameterSchemaIdentity: methodology.parameterSchemaIdentity,
    parameterSchemaDigest: methodology.parameterSchemaDigest,
    parameterPayloadDigest: '9'.repeat(64),
    fitEvidenceDigest: 'f'.repeat(64),
    trainObservationCount: 30,
    validationObservationCount: 15,
    oosObservationCount: validation.scoredOutcomeCount,
    oosUsedForFit: false,
    historicalBackfillCredit: 0,
    testFixtureCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    liquidityImpactCostBps: null,
    runtimeLiquidityImpactCoefficient: null,
  };
}

test('produces immutable artifact receipt without runtime cost credit', () => {
  const oosValidation = validOosValidation();
  const calibrationMethodology = validMethodology();
  const candidate = validCandidate(oosValidation, calibrationMethodology);
  const result = validatePublicForwardLiquidityCalibrationArtifact({
    oosValidation,
    calibrationMethodology,
    candidate,
    expectedArtifactProducerCodeSha: ARTIFACT_SHA,
  });
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.artifact.schemaVersion, PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION);
  assert.equal(result.artifact.calibrationArtifactProduced, true);
  assert.equal(result.artifact.liquidityImpactPresent, false);
  assert.equal(result.artifact.liquidityImpactStatus, 'BLOCKED_DATA');
  assert.equal(result.artifact.runtimeLiquidityImpactCoefficient, null);
  assert.equal(result.artifact.liquidityImpactCostBps, null);
  assert.equal(result.artifact.fullCostReady, false);
  assert.match(result.artifact.artifactDigest, /^[a-f0-9]{64}$/u);
});

test('rejects forged OOS validation digest', () => {
  const oosValidation = { ...validOosValidation(), validationDigest: D1 };
  const calibrationMethodology = validMethodology();
  const result = validatePublicForwardLiquidityCalibrationArtifact({
    oosValidation,
    calibrationMethodology,
    candidate: validCandidate(oosValidation, calibrationMethodology),
    expectedArtifactProducerCodeSha: ARTIFACT_SHA,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('OOS_VALIDATION_DIGEST_MISMATCH'));
});

test('rejects methodology frozen after OOS methodology', () => {
  const oosValidation = validOosValidation();
  const lateBody = { ...validMethodology(), methodologyFrozenAtMs: 1_001 };
  delete lateBody.methodologyDigest;
  const calibrationMethodology = { ...lateBody, methodologyDigest: computePublicForwardLiquidityCalibrationMethodologyDigest(lateBody) };
  const result = validatePublicForwardLiquidityCalibrationArtifact({
    oosValidation,
    calibrationMethodology,
    candidate: validCandidate(oosValidation, calibrationMethodology),
    expectedArtifactProducerCodeSha: ARTIFACT_SHA,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('CALIBRATION_METHODOLOGY_FROZEN_TOO_LATE'));
});

test('rejects OOS used for fit', () => {
  const oosValidation = validOosValidation();
  const body = { ...validMethodology(), oosUsedForFit: true };
  delete body.methodologyDigest;
  const calibrationMethodology = { ...body, methodologyDigest: computePublicForwardLiquidityCalibrationMethodologyDigest(body) };
  const result = validatePublicForwardLiquidityCalibrationArtifact({
    oosValidation,
    calibrationMethodology,
    candidate: validCandidate(oosValidation, calibrationMethodology),
    expectedArtifactProducerCodeSha: ARTIFACT_SHA,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('OOS_FIT_FORBIDDEN'));
});

test('rejects runtime liquidity cost or coefficient injection', () => {
  const oosValidation = validOosValidation();
  const calibrationMethodology = validMethodology();
  const candidate = {
    ...validCandidate(oosValidation, calibrationMethodology),
    liquidityImpactCostBps: 2.5,
    runtimeLiquidityImpactCoefficient: 0.2,
  };
  const result = validatePublicForwardLiquidityCalibrationArtifact({
    oosValidation,
    calibrationMethodology,
    candidate,
    expectedArtifactProducerCodeSha: ARTIFACT_SHA,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('RUNTIME_LIQUIDITY_COST_FORBIDDEN'));
});

test('rejects historical or fixture credit', () => {
  const oosValidation = validOosValidation();
  const calibrationMethodology = validMethodology();
  const candidate = {
    ...validCandidate(oosValidation, calibrationMethodology),
    historicalBackfillCredit: 1,
    testFixtureCredit: 1,
  };
  const result = validatePublicForwardLiquidityCalibrationArtifact({
    oosValidation,
    calibrationMethodology,
    candidate,
    expectedArtifactProducerCodeSha: ARTIFACT_SHA,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('NON_FORWARD_ARTIFACT_CREDIT_FORBIDDEN'));
});

test('safety contract remains paper-only and fail-closed', () => {
  assert.deepEqual(PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY, {
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
});

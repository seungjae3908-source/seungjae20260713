import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING,
  PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY,
  PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION,
  SUCCESSOR_V3_CALIBRATION_NATIVE_BINDING,
  computePublicForwardLiquidityCalibrationMethodologyDigest,
  validatePublicForwardLiquidityCalibrationArtifact,
} from '../src/public-forward-liquidity-calibration-artifact.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION,
  SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
} from '../src/public-forward-liquidity-calibration-oos-outcome-validator.mjs';
import { SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT } from '../src/public-forward-liquidity-successor-schedule-reliability-v3.mjs';
import { SUCCESSOR_OOS_HORIZON_CONTRACT } from '../src/public-forward-liquidity-successor-oos-outcome-horizon.mjs';

const D = (value) => String(value).repeat(64).slice(0, 64);
const ARTIFACT_SHA = 'a'.repeat(40);
const SUCCESSOR_ACTIVE_TEST = Object.freeze({
  skip: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.activationBound !== true
    ? 'preserved inactive-contract regression mode'
    : false,
});

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function resignValidation(validation, mutate) {
  const next = structuredClone(validation);
  delete next.validationDigest;
  mutate(next);
  return { ...next, validationDigest: digest(next) };
}

function validOosValidation(overrides = {}) {
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION,
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    v3IndependentSplitIndexDigest: D('1'),
    sourceInventoryDigest: D('2'),
    independenceAuditDigest: D('3'),
    independentSplitSourceDigest: D('4'),
    scheduleReliabilityContractVersion: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.contractVersion,
    scheduleReliabilityNumericFreezeSha256: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.numericFreezeSha256,
    policyDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyDigest,
    cohortDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest,
    oosHorizonContractVersion: SUCCESSOR_OOS_HORIZON_CONTRACT.contractVersion,
    oosHorizonPolicyDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.policyDigest,
    oosHorizonContractDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.contractDigest,
    outcomeHorizonMs: SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeHorizonMs,
    genuineScheduledSlotN: 769,
    effectiveIndependentN: 769,
    genuineV3OosSlotN: 1,
    genuineOosOutcomeN: 1,
    buyOosOutcomeN: 1,
    sellOosOutcomeN: 0,
    outcomeIds: ['native-oos-768'],
    outcomeDigest: D('5'),
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
    ...overrides,
  };
  return { ...body, validationDigest: digest(body) };
}

function validMethodology(overrides = {}) {
  const body = {
    methodologyIdentity: 'successor-v3-calibration-methodology',
    methodologyVersion: 'v1',
    methodologyFrozenAtMs: 1_788_388_127_000,
    fitSplits: ['TRAIN', 'VALIDATION'],
    oosUsedForFit: false,
    outcomeInspectionUsedForSelection: false,
    noRetuningAssertion: true,
    calibrationMethodIdentity: 'existing-canonical-statistical-firewall',
    calibrationMethodDigest: D('6'),
    ...overrides,
  };
  return { ...body, methodologyDigest: computePublicForwardLiquidityCalibrationMethodologyDigest(body) };
}

function validCandidate(validation, methodology, overrides = {}) {
  return {
    artifactIdentity: 'successor-v3-calibration-artifact-fixture',
    artifactVersion: 'v2',
    artifactProducerCodeSha: ARTIFACT_SHA,
    producedAtMs: 1_800_000_000_000,
    oosValidationDigest: validation.validationDigest,
    v3IndependentSplitIndexDigest: validation.v3IndependentSplitIndexDigest,
    sourceInventoryDigest: validation.sourceInventoryDigest,
    independenceAuditDigest: validation.independenceAuditDigest,
    independentSplitSourceDigest: validation.independentSplitSourceDigest,
    policyDigest: validation.policyDigest,
    cohortDigest: validation.cohortDigest,
    oosHorizonContractDigest: validation.oosHorizonContractDigest,
    oosOutcomeDigest: validation.outcomeDigest,
    calibrationMethodologyDigest: methodology.methodologyDigest,
    fitEvidenceDigest: D('7'),
    trainObservationCount: 512,
    validationObservationCount: 256,
    oosObservationCount: validation.genuineOosOutcomeN,
    statisticalAdmissionReady: true,
    statisticalAdmissionDigest: D('8'),
    oosUsedForFit: false,
    noRetuningAssertion: true,
    manualSampleCredit: 0,
    historicalBackfillCredit: 0,
    replayCredit: 0,
    testFixtureCredit: 0,
    syntheticEconomicCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    probability: null,
    expectedValue: null,
    netAlpha: null,
    winRate: null,
    liquidityImpactCostBps: null,
    runtimeLiquidityImpactCoefficient: null,
    fullCostReady: false,
    netAlphaReady: false,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE',
    executionAuthority: 'NONE',
    rejectedOosN: 0,
    rejectionReasons: [],
    ...overrides,
  };
}

function validate(validation = validOosValidation(), methodology = validMethodology(), candidateOverrides = {}) {
  return validatePublicForwardLiquidityCalibrationArtifact({
    oosValidation: validation,
    calibrationMethodology: methodology,
    candidate: validCandidate(validation, methodology, candidateOverrides),
    expectedArtifactProducerCodeSha: ARTIFACT_SHA,
  });
}

function expectNotReady(result, blocker) {
  assert.equal(result.status, 'NOT_READY');
  assert.equal(result.calibrationArtifactProduced, false);
  assert.equal(result.artifact, null);
  assert.equal(result.statisticalResults, null);
  assert.equal(result.fullCostReady, false);
  assert.equal(result.netAlphaReady, false);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.executionAuthority, 'NONE');
  if (blocker) assert.ok(result.blockers.includes(blocker));
}

test('1 native genuine OOS fixture reaches the artifact contract with zero economic credit', SUCCESSOR_ACTIVE_TEST, () => {
  const result = validate();
  assert.equal(result.status, 'READY');
  assert.equal(result.calibrationInputN, 1);
  assert.equal(result.calibrationArtifactProduced, true);
  assert.equal(result.artifact.schemaVersion, PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION);
  assert.equal(result.artifact.sourceContractFamily, SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY);
  assert.equal(result.artifact.acceptedGenuineOosN, 1);
  assert.equal(result.artifact.naturalEntryCredit, 0);
  assert.equal(result.artifact.runtimeCostCredit, 0);
  assert.equal(result.artifact.syntheticEconomicCredit, 0);
  assert.equal(result.artifact.fullCostReady, false);
  assert.equal(result.artifact.netAlphaReady, false);
  assert.equal(result.artifact.profitabilityProven, false);
  assert.equal(result.artifact.executionAuthority, 'NONE');
});

test('2 TRAIN-like non-native validation is never promoted to OOS', () => {
  const validation = resignValidation(validOosValidation(), (value) => {
    value.schemaVersion = 'public-forward-liquidity-train-validation-v1';
  });
  expectNotReady(validate(validation), 'SUCCESSOR_V3_OOS_VALIDATION_VERSION_INVALID');
});

test('3 VALIDATION-like non-native validation is never promoted to held-out OOS', () => {
  const validation = resignValidation(validOosValidation(), (value) => {
    value.schemaVersion = 'public-forward-liquidity-validation-validation-v1';
  });
  expectNotReady(validate(validation), 'SUCCESSOR_V3_OOS_VALIDATION_VERSION_INVALID');
});

test('4 slot 767 equivalent has zero genuine OOS and fails closed', () => {
  const validation = validOosValidation({ genuineV3OosSlotN: 0, genuineOosOutcomeN: 0, buyOosOutcomeN: 0, outcomeIds: [] });
  expectNotReady(validate(validation), GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING);
});

test('5 first OOS slot 768 structurally admits when exact native lineage is present', SUCCESSOR_ACTIVE_TEST, () => {
  const result = validate();
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.artifact.frozenSplit.OOS, { startIndexInclusive: 768, endIndexInclusive: 1023 });
});

test('6 wrong source contract family is rejected', () => {
  const validation = resignValidation(validOosValidation(), (value) => { value.sourceContractFamily = 'OTHER_FAMILY'; });
  expectNotReady(validate(validation), 'SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY_INVALID');
});

test('7 legacy family relabeled as Successor is rejected by exact native schema binding', () => {
  const validation = resignValidation(validOosValidation(), (value) => { value.schemaVersion = 'public-forward-liquidity-calibration-oos-validation-v1'; });
  expectNotReady(validate(validation), 'SUCCESSOR_V3_OOS_VALIDATION_VERSION_INVALID');
});

test('8 wrong cohort digest is rejected', () => {
  const validation = resignValidation(validOosValidation(), (value) => { value.cohortDigest = D('9'); });
  expectNotReady(validate(validation), 'SUCCESSOR_V3_COHORT_DIGEST_MISMATCH');
});

test('9 wrong policy digest is rejected', () => {
  const validation = resignValidation(validOosValidation(), (value) => { value.policyDigest = D('a'); });
  expectNotReady(validate(validation), 'SUCCESSOR_V3_POLICY_DIGEST_MISMATCH');
});

test('10 wrong numeric freeze is rejected', () => {
  const validation = resignValidation(validOosValidation(), (value) => { value.scheduleReliabilityNumericFreezeSha256 = D('b'); });
  expectNotReady(validate(validation), 'SUCCESSOR_V3_NUMERIC_FREEZE_LINEAGE_MISMATCH');
});

test('11 wrong OOS horizon contract is rejected', () => {
  const validation = resignValidation(validOosValidation(), (value) => { value.oosHorizonContractDigest = D('c'); });
  expectNotReady(validate(validation), 'SUCCESSOR_V3_OOS_HORIZON_MISMATCH');
});

test('12 horizon other than frozen 5000ms is rejected', () => {
  const validation = resignValidation(validOosValidation(), (value) => { value.outcomeHorizonMs = 60_000; });
  expectNotReady(validate(validation), 'SUCCESSOR_V3_OOS_HORIZON_MISMATCH');
});

test('13 wrong slot/index identity is rejected', SUCCESSOR_ACTIVE_TEST, () => {
  const result = validate(validOosValidation(), validMethodology(), { v3IndependentSplitIndexDigest: D('d') });
  expectNotReady(result, 'ARTIFACT_SPLIT_INDEX_DIGEST_MISMATCH');
});

test('14 wrong source/bound outcome lineage digest is rejected', SUCCESSOR_ACTIVE_TEST, () => {
  const result = validate(validOosValidation(), validMethodology(), { oosOutcomeDigest: D('e') });
  expectNotReady(result, 'ARTIFACT_OOS_OUTCOME_DIGEST_MISMATCH');
});

test('15 candidate cannot bind a different #802 validation digest', SUCCESSOR_ACTIVE_TEST, () => {
  const result = validate(validOosValidation(), validMethodology(), { oosValidationDigest: D('f') });
  expectNotReady(result, 'ARTIFACT_OOS_VALIDATION_DIGEST_MISMATCH');
});

test('16 duplicate native OOS outcome identity is rejected with zero extra credit', () => {
  const validation = resignValidation(validOosValidation(), (value) => {
    value.genuineOosOutcomeN = 2;
    value.buyOosOutcomeN = 2;
    value.outcomeIds = ['dup', 'dup'];
  });
  expectNotReady(validate(validation), 'SUCCESSOR_V3_OOS_OUTCOME_IDENTITY_INVALID');
});

test('17 rerun/replay credit is rejected', () => {
  const validation = resignValidation(validOosValidation(), (value) => { value.replayCredit = 1; });
  expectNotReady(validate(validation), 'SUCCESSOR_V3_OOS_TRUTH_BOUNDARY_INVALID');
});

test('18 manual replay backfill fixture or synthetic economic credit is rejected', SUCCESSOR_ACTIVE_TEST, () => {
  const result = validate(validOosValidation(), validMethodology(), {
    manualSampleCredit: 1,
    historicalBackfillCredit: 1,
    replayCredit: 1,
    testFixtureCredit: 1,
    syntheticEconomicCredit: 1,
  });
  expectNotReady(result, 'NON_FORWARD_ARTIFACT_CREDIT_FORBIDDEN');
});

test('19 missing independence lineage stays NOT_READY', () => {
  const validation = resignValidation(validOosValidation(), (value) => { delete value.independentSplitSourceDigest; });
  expectNotReady(validate(validation), 'SUCCESSOR_V3_INDEPENDENT_SPLIT_SOURCE_DIGEST_INVALID');
});

test('20 OOS N=0 produces no artifact and uses the canonical missing-evidence reason', () => {
  const validation = validOosValidation({ genuineV3OosSlotN: 0, genuineOosOutcomeN: 0, buyOosOutcomeN: 0, outcomeIds: [] });
  const result = validate(validation);
  assert.equal(result.reason, GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING);
  assert.equal(result.calibrationInputN, 0);
  expectNotReady(result, GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING);
});

test('21 insufficient statistical admission is NOT_READY and statistics remain null', SUCCESSOR_ACTIVE_TEST, () => {
  const result = validate(validOosValidation(), validMethodology(), { statisticalAdmissionReady: false });
  assert.equal(result.reason, 'INSUFFICIENT_STATISTICAL_EVIDENCE');
  expectNotReady(result, 'STATISTICAL_ADMISSION_NOT_READY');
});

test('22 no false probability can be injected', SUCCESSOR_ACTIVE_TEST, () => {
  const result = validate(validOosValidation(), validMethodology(), { probability: 0 });
  expectNotReady(result, 'RUNTIME_LIQUIDITY_COST_FORBIDDEN');
});

test('23 no false EV or alpha can be injected', SUCCESSOR_ACTIVE_TEST, () => {
  const result = validate(validOosValidation(), validMethodology(), { expectedValue: 0, netAlpha: 0 });
  expectNotReady(result, 'RUNTIME_LIQUIDITY_COST_FORBIDDEN');
});

test('24 Full Cost Net Alpha and Profitability promotion are forbidden', SUCCESSOR_ACTIVE_TEST, () => {
  const result = validate(validOosValidation(), validMethodology(), {
    fullCostReady: true,
    netAlphaReady: true,
    profitabilityProven: true,
  });
  expectNotReady(result, 'ARTIFACT_ECONOMIC_OR_EXECUTION_PROMOTION_FORBIDDEN');
});

test('25 execution authority remains NONE', SUCCESSOR_ACTIVE_TEST, () => {
  const result = validate(validOosValidation(), validMethodology(), { executionAuthority: 'LIVE' });
  expectNotReady(result, 'ARTIFACT_ECONOMIC_OR_EXECUTION_PROMOTION_FORBIDDEN');
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY.fullCostReady, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY.netAlphaReady, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_SAFETY.profitabilityProven, false);
  assert.equal(SUCCESSOR_V3_CALIBRATION_NATIVE_BINDING.trainStartIndexInclusive, 0);
  assert.equal(SUCCESSOR_V3_CALIBRATION_NATIVE_BINDING.trainEndIndexInclusive, 511);
  assert.equal(SUCCESSOR_V3_CALIBRATION_NATIVE_BINDING.validationStartIndexInclusive, 512);
  assert.equal(SUCCESSOR_V3_CALIBRATION_NATIVE_BINDING.validationEndIndexInclusive, 767);
  assert.equal(SUCCESSOR_V3_CALIBRATION_NATIVE_BINDING.oosStartIndexInclusive, 768);
  assert.equal(SUCCESSOR_V3_CALIBRATION_NATIVE_BINDING.oosEndIndexInclusive, 1023);
  assert.equal(SUCCESSOR_V3_CALIBRATION_NATIVE_BINDING.outcomeHorizonMs, 5000);
});
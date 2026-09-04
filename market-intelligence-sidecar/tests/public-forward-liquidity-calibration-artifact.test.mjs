import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING,
  PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION,
  computePublicForwardLiquidityCalibrationMethodologyDigest,
  validatePublicForwardLiquidityCalibrationArtifact,
} from '../src/public-forward-liquidity-calibration-artifact.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION,
  SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
} from '../src/public-forward-liquidity-calibration-oos-outcome-validator.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  buildSuccessorScheduleReliabilityV3SlotDescriptor,
} from '../src/public-forward-liquidity-successor-schedule-reliability-v3.mjs';
import {
  SUCCESSOR_OOS_HORIZON_CONTRACT,
} from '../src/public-forward-liquidity-successor-oos-outcome-horizon.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION,
} from '../src/public-forward-liquidity-v3-independence-binding.mjs';

const PRODUCER_SHA = 'a'.repeat(40);
const COLLECTOR_SHA = 'b'.repeat(40);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nativePolicy() {
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

function assignment({ slotIndex, split, side, suffix }) {
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(slotIndex);
  return {
    observationId: `bound-observation-${suffix}`,
    sourceObservationId: `source-observation-${suffix}`,
    sourceIdentity: 'successor-v3-source',
    ingestSourceIdentity: 'successor-v3-ingest-source',
    eventIdentity: `public-event-${suffix}`,
    sourceFrameIdentity: `public-frame-${suffix}`,
    eventTimestampMs: 1_000 + slotIndex,
    aggressiveSide: side,
    split,
    slotIndex,
    canonicalSlotKeyDigest: sha256(slot.canonicalSlotKey),
    collectorCodeSha: COLLECTOR_SHA,
    datasetDigest: sha256('dataset-final'),
    ingestReceiptRelativePath: `receipts/${slotIndex}.json`,
    ingestReceiptDigest: sha256(`ingest-${suffix}`),
    captureReceiptDigest: sha256(`capture-${suffix}`),
    artifactReceiptDigest: sha256(`artifact-${suffix}`),
    policyDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyDigest,
    cohortDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest,
  };
}

function countsFor(observations) {
  const counts = {
    TRAIN: 0, TRAIN_BUY: 0, TRAIN_SELL: 0,
    VALIDATION: 0, VALIDATION_BUY: 0, VALIDATION_SELL: 0,
    OOS: 0, OOS_BUY: 0, OOS_SELL: 0,
  };
  for (const item of observations) {
    if (counts[item.split] != null) counts[item.split] += 1;
    if (counts[`${item.split}_${item.aggressiveSide}`] != null) counts[`${item.split}_${item.aggressiveSide}`] += 1;
  }
  return counts;
}

function resignIndex(index) {
  const body = Object.fromEntries(Object.entries(index).filter(([key]) => key !== 'indexDigest'));
  return { ...body, indexDigest: sha256(body) };
}

function v3Index(overrides = {}) {
  const observations = [
    assignment({ slotIndex: 20, split: 'TRAIN', side: 'BUY', suffix: 'train' }),
    assignment({ slotIndex: 600, split: 'VALIDATION', side: 'SELL', suffix: 'validation' }),
    assignment({ slotIndex: 768, split: 'OOS', side: 'BUY', suffix: 'oos' }),
  ];
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION,
    kind: 'PUBLIC_FORWARD_LIQUIDITY_V3_FROZEN_SPLIT_PROPAGATION',
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    successorNativePolicy: nativePolicy(),
    producerCodeSha: PRODUCER_SHA,
    sourceInventoryDigest: sha256('inventory'),
    independenceAuditDigest: sha256('independence'),
    independentSplitSourceDigest: sha256('independent-split-source'),
    policyDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyDigest,
    cohortDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest,
    targetSlotIndex: 768,
    genuineScheduledSlotN: 3,
    creditedReceiptN: 3,
    sourceDatasetDigests: [sha256('dataset-final')],
    observations,
    effectiveIndependentN: observations.length,
    duplicateObservationLineageN: 0,
    frozenSplitSource: 'V3_SCHEDULED_SLOT_RECEIPT_ONLY',
    retrospectiveSplitSelection: false,
    syntheticSplitAssignment: false,
    additionalIndependentSampleCredit: 0,
    oosOutcomeCredit: 0,
    calibrationArtifactProduced: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    realOrders: 0,
    counts: countsFor(observations),
    ...overrides,
  };
  if (overrides.observations) {
    body.effectiveIndependentN = overrides.effectiveIndependentN ?? overrides.observations.length;
    body.counts = overrides.counts ?? countsFor(overrides.observations);
  }
  return resignIndex(body);
}

function resignValidation(validation) {
  const body = Object.fromEntries(Object.entries(validation).filter(([key]) => key !== 'validationDigest'));
  return { ...body, validationDigest: sha256(body) };
}

function nativeValidation(index, overrides = {}) {
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION,
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    v3IndependentSplitIndexDigest: index.indexDigest,
    sourceInventoryDigest: index.sourceInventoryDigest,
    independenceAuditDigest: index.independenceAuditDigest,
    independentSplitSourceDigest: index.independentSplitSourceDigest,
    scheduleReliabilityContractVersion: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.contractVersion,
    scheduleReliabilityNumericFreezeSha256: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.numericFreezeSha256,
    policyDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyDigest,
    cohortDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest,
    oosHorizonContractVersion: SUCCESSOR_OOS_HORIZON_CONTRACT.contractVersion,
    oosHorizonPolicyDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.policyDigest,
    oosHorizonContractDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.contractDigest,
    outcomeHorizonMs: SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeHorizonMs,
    genuineScheduledSlotN: index.genuineScheduledSlotN,
    effectiveIndependentN: index.effectiveIndependentN,
    genuineV3OosSlotN: 1,
    genuineOosOutcomeN: 1,
    buyOosOutcomeN: 1,
    sellOosOutcomeN: 0,
    outcomeIds: ['outcome-oos'],
    outcomeDigest: sha256('outcome-set'),
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
  return resignValidation(body);
}

function methodology(overrides = {}) {
  const body = {
    methodologyIdentity: 'successor-v3-liquidity-calibration-method',
    methodologyVersion: 'v1',
    methodologyFrozenAtMs: 1_000,
    fitSplits: ['TRAIN', 'VALIDATION'],
    oosUsedForFit: false,
    noRetuningAssertion: true,
    estimatorIdentity: 'frozen-liquidity-estimator-v1',
    estimatorDigest: sha256('estimator'),
    parameterSchemaIdentity: 'frozen-liquidity-parameter-schema-v1',
    parameterSchemaDigest: sha256('parameter-schema'),
    ...overrides,
  };
  return { ...body, methodologyDigest: computePublicForwardLiquidityCalibrationMethodologyDigest(body) };
}

function candidate(validation, method, overrides = {}) {
  return {
    artifactIdentity: 'successor-v3-liquidity-calibration-artifact',
    artifactVersion: 'v1',
    artifactProducerCodeSha: PRODUCER_SHA,
    producedAtMs: 10_000,
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    oosValidationSchemaVersion: PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION,
    oosValidationDigest: validation.validationDigest,
    v3IndependentSplitIndexDigest: validation.v3IndependentSplitIndexDigest,
    sourceInventoryDigest: validation.sourceInventoryDigest,
    independenceAuditDigest: validation.independenceAuditDigest,
    independentSplitSourceDigest: validation.independentSplitSourceDigest,
    scheduleReliabilityNumericFreezeSha256: validation.scheduleReliabilityNumericFreezeSha256,
    policyDigest: validation.policyDigest,
    cohortDigest: validation.cohortDigest,
    oosHorizonPolicyDigest: validation.oosHorizonPolicyDigest,
    oosHorizonContractDigest: validation.oosHorizonContractDigest,
    oosOutcomeHorizonMs: validation.outcomeHorizonMs,
    oosOutcomeSelectionPolicy: SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeSelectionPolicy,
    calibrationMethodologyDigest: method.methodologyDigest,
    estimatorIdentity: method.estimatorIdentity,
    estimatorDigest: method.estimatorDigest,
    parameterSchemaIdentity: method.parameterSchemaIdentity,
    parameterSchemaDigest: method.parameterSchemaDigest,
    parameterPayloadDigest: sha256('parameters'),
    fitEvidenceDigest: sha256('fit-evidence'),
    trainObservationCount: 1,
    validationObservationCount: 1,
    oosObservationCount: validation.genuineOosOutcomeN,
    acceptedGenuineOosN: validation.genuineOosOutcomeN,
    buyOosOutcomeN: validation.buyOosOutcomeN,
    sellOosOutcomeN: validation.sellOosOutcomeN,
    rejectedOosN: 0,
    rejectionReasons: [],
    oosUsedForFit: false,
    noRetuningAssertion: true,
    historicalBackfillCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    testFixtureCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    runtimeLiquidityImpactCoefficient: null,
    liquidityImpactCostBps: null,
    fullCostReady: false,
    netAlphaReady: false,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE',
    executionAuthority: 'NONE',
    ...overrides,
  };
}

function fixture() {
  const index = v3Index();
  const validation = nativeValidation(index);
  const method = methodology();
  return {
    index,
    validation,
    method,
    candidate: candidate(validation, method),
  };
}

function validateFixture(fx) {
  return validatePublicForwardLiquidityCalibrationArtifact({
    oosValidationResult: { status: 'PRESENT', blockers: [], validation: fx.validation },
    v3SplitIndex: fx.index,
    calibrationMethodology: fx.method,
    candidate: fx.candidate,
    expectedArtifactProducerCodeSha: PRODUCER_SHA,
  });
}

function expectNotReady(result, blocker = null) {
  assert.equal(result.status, 'NOT_READY');
  assert.equal(result.calibrationStatus, 'NOT_READY');
  assert.equal(result.calibrationArtifactProduced, false);
  assert.equal(result.artifact, null);
  assert.equal(result.fullCostReady, false);
  assert.equal(result.netAlphaReady, false);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.currentValidatedChampion, 'NONE');
  assert.equal(result.executionAuthority, 'NONE');
  if (blocker) assert.ok(result.blockers.includes(blocker), JSON.stringify(result.blockers));
}

test('native Successor V3 slot 768 path is structurally eligible without economic promotion', () => {
  const result = validateFixture(fixture());
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.calibrationStatus, 'READY');
  assert.equal(result.calibrationInputN, 1);
  assert.equal(result.calibrationArtifactProduced, true);
  assert.equal(result.artifact.sourceContractFamily, SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY);
  assert.equal(result.artifact.frozenSplit.OOS.startIndexInclusive, 768);
  assert.equal(result.artifact.oosOutcomeHorizonMs, 5_000);
  assert.equal(result.artifact.acceptedGenuineOosN, 1);
  assert.equal(result.artifact.oosLineage[0].slotIndex, 768);
  assert.equal(result.artifact.predecessorFinalDatasetChainValidatedByIndependentIndex, true);
  assert.equal(result.evidenceComplete, 0);
  assert.equal(result.fullCostReady, false);
  assert.equal(result.netAlphaReady, false);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('missing genuine OOS assignments fail closed as normal NOT_READY research state', () => {
  const result = validatePublicForwardLiquidityCalibrationArtifact({
    oosValidationResult: { status: 'BLOCKED_DATA', blockers: ['SUCCESSOR_V3_OOS_ASSIGNMENTS_MISSING'] },
  });
  expectNotReady(result, 'SUCCESSOR_V3_OOS_ASSIGNMENTS_MISSING');
  assert.equal(result.calibrationInputN, 0);
  assert.equal(result.calibrationReason, GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING);
});

test('missing genuine OOS outcomes fail closed and never produce a zero-valued artifact', () => {
  const result = validatePublicForwardLiquidityCalibrationArtifact({
    oosValidationResult: { status: 'BLOCKED_DATA', blockers: ['SUCCESSOR_V3_OOS_OUTCOMES_MISSING'] },
  });
  expectNotReady(result, 'SUCCESSOR_V3_OOS_OUTCOMES_MISSING');
  assert.equal(result.calibrationInputN, 0);
  assert.equal(result.calibrationReason, GENUINE_SUCCESSOR_V3_OOS_EVIDENCE_MISSING);
  assert.equal(Object.hasOwn(result, 'probability'), false);
  assert.equal(Object.hasOwn(result, 'expectedValue'), false);
});

test('legacy validation schema relabeled as Successor is rejected', () => {
  const fx = fixture();
  fx.validation = resignValidation({ ...fx.validation, schemaVersion: 'public-forward-liquidity-oos-validation-v1' });
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'NATIVE_SUCCESSOR_V3_OOS_VALIDATION_VERSION_INVALID');
});

test('wrong source contract family is rejected', () => {
  const fx = fixture();
  fx.validation = resignValidation({ ...fx.validation, sourceContractFamily: 'CALIBRATION_V3' });
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY_INVALID');
});

test('wrong independent split index digest binding is rejected', () => {
  const fx = fixture();
  fx.validation = resignValidation({ ...fx.validation, v3IndependentSplitIndexDigest: sha256('wrong-index') });
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'SUCCESSOR_V3_SPLIT_INDEX_VALIDATION_BINDING_MISMATCH');
});

test('wrong source inventory lineage is rejected', () => {
  const fx = fixture();
  fx.validation = resignValidation({ ...fx.validation, sourceInventoryDigest: sha256('wrong-inventory') });
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'SUCCESSOR_V3_SPLIT_INDEX_VALIDATION_BINDING_MISMATCH');
});

test('wrong frozen policy digest is rejected', () => {
  const fx = fixture();
  fx.validation = resignValidation({ ...fx.validation, policyDigest: sha256('wrong-policy') });
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'SUCCESSOR_V3_FROZEN_POLICY_LINEAGE_MISMATCH');
});

test('wrong cohort digest is rejected', () => {
  const fx = fixture();
  fx.validation = resignValidation({ ...fx.validation, cohortDigest: sha256('wrong-cohort') });
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'SUCCESSOR_V3_FROZEN_POLICY_LINEAGE_MISMATCH');
});

test('wrong numeric freeze digest is rejected', () => {
  const fx = fixture();
  fx.validation = resignValidation({ ...fx.validation, scheduleReliabilityNumericFreezeSha256: sha256('wrong-freeze') });
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'SUCCESSOR_V3_FROZEN_POLICY_LINEAGE_MISMATCH');
});

test('wrong OOS horizon contract digest is rejected', () => {
  const fx = fixture();
  fx.validation = resignValidation({ ...fx.validation, oosHorizonContractDigest: sha256('wrong-horizon-contract') });
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'SUCCESSOR_V3_OOS_HORIZON_LINEAGE_MISMATCH');
});

test('horizon other than 5000ms is rejected', () => {
  const fx = fixture();
  fx.validation = resignValidation({ ...fx.validation, outcomeHorizonMs: 60_000 });
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'SUCCESSOR_V3_OOS_HORIZON_LINEAGE_MISMATCH');
});

test('TRAIN slot cannot be relabeled OOS', () => {
  const fx = fixture();
  const observations = clone(fx.index.observations);
  observations[0].split = 'OOS';
  fx.index = v3Index({ observations });
  fx.validation = nativeValidation(fx.index);
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'NATIVE_SUCCESSOR_V3_SPLIT_INDEX_INVALID');
});

test('VALIDATION slot cannot be relabeled OOS', () => {
  const fx = fixture();
  const observations = clone(fx.index.observations);
  observations[1].split = 'OOS';
  fx.index = v3Index({ observations });
  fx.validation = nativeValidation(fx.index);
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'NATIVE_SUCCESSOR_V3_SPLIT_INDEX_INVALID');
});

test('slot 767 is rejected when labeled OOS', () => {
  const fx = fixture();
  const observations = clone(fx.index.observations);
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(767);
  observations[2] = {
    ...observations[2],
    slotIndex: 767,
    split: 'OOS',
    canonicalSlotKeyDigest: sha256(slot.canonicalSlotKey),
  };
  fx.index = v3Index({ observations, targetSlotIndex: 767 });
  fx.validation = nativeValidation(fx.index);
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'NATIVE_SUCCESSOR_V3_SPLIT_INDEX_INVALID');
});

test('wrong canonical slot identity is rejected', () => {
  const fx = fixture();
  const observations = clone(fx.index.observations);
  observations[2].canonicalSlotKeyDigest = sha256('wrong-slot');
  fx.index = v3Index({ observations });
  fx.validation = nativeValidation(fx.index);
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'NATIVE_SUCCESSOR_V3_SPLIT_INDEX_INVALID');
});

test('missing source observation identity is rejected', () => {
  const fx = fixture();
  const observations = clone(fx.index.observations);
  observations[2].sourceObservationId = '';
  fx.index = v3Index({ observations });
  fx.validation = nativeValidation(fx.index);
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'NATIVE_SUCCESSOR_V3_SPLIT_INDEX_INVALID');
});

test('missing bound observation identity is rejected', () => {
  const fx = fixture();
  const observations = clone(fx.index.observations);
  observations[2].observationId = '';
  fx.index = v3Index({ observations });
  fx.validation = nativeValidation(fx.index);
  fx.candidate = candidate(fx.validation, fx.method);
  expectNotReady(validateFixture(fx), 'NATIVE_SUCCESSOR_V3_SPLIT_INDEX_INVALID');
});

test('duplicate source lineage is rejected with zero extra calibration credit', () => {
  const fx = fixture();
  const observations = clone(fx.index.observations);
  observations[2].sourceObservationId = observations[1].sourceObservationId;
  fx.index = v3Index({ observations });
  fx.validation = nativeValidation(fx.index);
  fx.candidate = candidate(fx.validation, fx.method);
  const result = validateFixture(fx);
  expectNotReady(result, 'NATIVE_SUCCESSOR_V3_SPLIT_INDEX_INVALID');
  assert.equal(result.calibrationArtifactProduced, false);
});

test('replay/backfill/synthetic credit in upstream validation is rejected', () => {
  for (const key of ['replayCredit', 'backfillCredit', 'syntheticCredit']) {
    const fx = fixture();
    fx.validation = resignValidation({ ...fx.validation, [key]: 1 });
    fx.candidate = candidate(fx.validation, fx.method);
    expectNotReady(validateFixture(fx), 'SUCCESSOR_V3_NON_GENUINE_CREDIT_FORBIDDEN');
  }
});

test('missing native split lineage is NOT_READY', () => {
  const fx = fixture();
  const result = validatePublicForwardLiquidityCalibrationArtifact({
    oosValidationResult: { status: 'PRESENT', blockers: [], validation: fx.validation },
    calibrationMethodology: fx.method,
    candidate: fx.candidate,
    expectedArtifactProducerCodeSha: PRODUCER_SHA,
  });
  expectNotReady(result, 'NATIVE_SUCCESSOR_V3_SPLIT_INDEX_REQUIRED');
});

test('zero OOS evidence cannot be represented as a successful calibration artifact', () => {
  const result = validatePublicForwardLiquidityCalibrationArtifact({
    oosValidationResult: { status: 'BLOCKED_DATA', blockers: ['SUCCESSOR_V3_OOS_ASSIGNMENTS_MISSING'] },
  });
  expectNotReady(result);
  assert.equal(result.calibrationInputN, 0);
  assert.equal(result.calibrationArtifactProduced, false);
});

test('insufficient TRAIN/VALIDATION fit evidence remains NOT_READY rather than becoming OOS credit', () => {
  const fx = fixture();
  fx.candidate = { ...fx.candidate, validationObservationCount: 0 };
  const result = validateFixture(fx);
  expectNotReady(result, 'FIT_SAMPLE_COUNT_INVALID');
  assert.equal(result.calibrationInputN, 1);
});

test('OOS may never be used for fit and no-retuning assertion is mandatory', () => {
  const fx = fixture();
  fx.method = methodology({ fitSplits: ['TRAIN', 'OOS'], oosUsedForFit: true, noRetuningAssertion: false });
  fx.candidate = candidate(fx.validation, fx.method);
  const result = validateFixture(fx);
  expectNotReady(result);
  assert.ok(result.blockers.includes('CALIBRATION_FIT_SPLITS_INVALID'));
  assert.ok(result.blockers.includes('OOS_FIT_FORBIDDEN'));
  assert.ok(result.blockers.includes('NO_RETUNING_ASSERTION_REQUIRED'));
});

test('manual/replay/backfill/synthetic candidate credit is rejected', () => {
  for (const key of ['manualCredit', 'replayCredit', 'backfillCredit', 'syntheticCredit', 'historicalBackfillCredit', 'testFixtureCredit']) {
    const fx = fixture();
    fx.candidate = { ...fx.candidate, [key]: 1 };
    expectNotReady(validateFixture(fx), 'NON_GENUINE_OR_ECONOMIC_CREDIT_FORBIDDEN');
  }
});

test('false probability, EV, alpha, or win-rate output is rejected', () => {
  for (const key of ['probability', 'profitProbability', 'expectedValue', 'ev', 'alpha', 'winRate']) {
    const fx = fixture();
    fx.candidate = { ...fx.candidate, [key]: 0 };
    expectNotReady(validateFixture(fx), 'UNAUTHORIZED_PERFORMANCE_STATISTIC_FORBIDDEN');
  }
});

test('Full Cost, Net Alpha, profitability, and champion promotion are forbidden here', () => {
  const cases = [
    { fullCostReady: true },
    { netAlphaReady: true },
    { profitabilityProven: true },
    { currentValidatedChampion: 'candidate-a' },
  ];
  for (const patch of cases) {
    const fx = fixture();
    fx.candidate = { ...fx.candidate, ...patch };
    expectNotReady(validateFixture(fx), 'PREMATURE_ECONOMIC_PROMOTION_FORBIDDEN');
  }
});

test('execution authority remains NONE', () => {
  const fx = fixture();
  fx.candidate = { ...fx.candidate, executionAuthority: 'TRADE' };
  expectNotReady(validateFixture(fx), 'PREMATURE_ECONOMIC_PROMOTION_FORBIDDEN');
});

test('successful artifact contains provenance but no fake normal performance numbers', () => {
  const result = validateFixture(fixture());
  assert.equal(result.artifact.schemaVersion, PUBLIC_FORWARD_LIQUIDITY_CALIBRATION_ARTIFACT_VERSION);
  assert.deepEqual(result.artifact.sourceDatasetDigests, [sha256('dataset-final')]);
  assert.equal(result.artifact.oosValidationSchemaVersion, PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION);
  assert.equal(result.artifact.noRetuningAssertion, true);
  for (const key of ['winRate', 'winRatePct', 'expectedValue', 'ev', 'alpha', 'netAlpha', 'probability', 'profitProbability']) {
    assert.equal(Object.hasOwn(result.artifact, key), false, key);
  }
  assert.equal(result.artifact.runtimeLiquidityImpactCoefficient, null);
  assert.equal(result.artifact.liquidityImpactCostBps, null);
  assert.equal(result.artifact.fullCostReady, false);
  assert.equal(result.artifact.netAlphaReady, false);
  assert.equal(result.artifact.profitabilityProven, false);
  assert.equal(result.artifact.currentValidatedChampion, 'NONE');
  assert.equal(result.artifact.executionAuthority, 'NONE');
});

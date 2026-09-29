import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_SAFETY,
  LIQUIDITY_IMPACT_FIREWALL_SCHEMA,
  LIQUIDITY_IMPACT_FIREWALL_VERSION,
  NATIVE_SUCCESSOR_V3_CALIBRATION_ARTIFACT_VERSION,
  NATIVE_SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
  computeLiquidityImpactFirewallArtifactDigest,
  computeNativeV3CalibrationArtifactDigest,
  computeRuntimeLiquidityImpactMeasurementDigest,
  produceAuthoritativePaperLiquidityImpactCostEvidence,
} from './authoritative-paper-liquidity-impact-cost-evidence.service';

type Mutable = Record<string, any>;

const NOW_MS = 1_800_000_000_000;
const MAXIMUM_AGE_MS = 60_000;
const PRODUCER_SHA = commit('runtime-cost-producer');
const CALIBRATION_SHA = commit('native-calibration-producer');

function sha(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function commit(seed: string): string {
  return createHash('sha1').update(seed).digest('hex');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sealCalibrationArtifact(body: Mutable): Mutable {
  return {
    ...body,
    artifactDigest: computeNativeV3CalibrationArtifactDigest(body),
  };
}

function makeCalibrationAdmission(): Mutable {
  const artifact = sealCalibrationArtifact({
    schemaVersion: NATIVE_SUCCESSOR_V3_CALIBRATION_ARTIFACT_VERSION,
    artifactIdentity: 'native-v3-calibration-artifact-001',
    artifactVersion: 'native-v3-calibration-parameters-v1',
    artifactProducerCodeSha: CALIBRATION_SHA,
    sourceContractFamily: NATIVE_SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    v3IndependentSplitIndexDigest: sha('native-split-index'),
    sourceInventoryDigest: sha('native-source-inventory'),
    sourceDatasetDigests: [sha('native-source-a'), sha('native-source-b')],
    independenceAuditDigest: sha('native-independence-audit'),
    independentSplitSourceDigest: sha('native-independent-split-source'),
    oosValidationDigest: sha('native-oos-validation'),
    oosOutcomeDigest: sha('native-oos-outcome'),
    policyDigest: sha('native-policy'),
    cohortDigest: sha('native-cohort'),
    calibrationMethodologyVersion: 'native-residual-liquidity-impact-v1',
    parameterPayloadDigest: sha('native-parameter-payload'),
    fitEvidenceDigest: sha('native-fit-evidence'),
    trainObservationCount: 512,
    validationObservationCount: 256,
    oosObservationCount: 12,
    acceptedGenuineOosN: 12,
    oosOutcomeHorizonMs: 5000,
    heldOutOosValidated: true,
    contaminationFree: true,
    noRetuningAssertion: true,
    oosUsedForFit: false,
    historicalBackfillCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    testFixtureCredit: 0,
    calibrationArtifactProduced: true,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    netAlphaReady: false,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE',
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  });
  return {
    status: 'PRESENT',
    calibrationStatus: 'READY',
    calibrationArtifactProduced: true,
    artifact,
  };
}

function competingCostEvidence(): Mutable[] {
  return [
    ['VISIBLE_L2_BOOK_WALK_SLIPPAGE', 'book-walk'],
    ['LATENCY_ADVERSE_MOVE', 'latency'],
    ['SPREAD', 'spread'],
  ].map(([costOwner, seed]) => ({
    costOwner,
    evidenceIdentity: `${seed}-evidence-v1`,
    evidenceDigest: sha(`${seed}-evidence`),
    sourceIdentity: `${seed}-source-v1`,
    sourceDigest: sha(`${seed}-source`),
    sourceObservationLineageId: `${seed}-lineage-v1`,
    sourceObservationLineageDigest: sha(`${seed}-lineage`),
  }));
}

function sealMeasurement(body: Mutable): Mutable {
  return {
    ...body,
    measurementDigest: computeRuntimeLiquidityImpactMeasurementDigest(body),
  };
}

function makeRuntimeMeasurement(admission = makeCalibrationAdmission()): Mutable {
  const calibration = admission.artifact as Mutable;
  const trainDatasetIdentity = 'residual-liquidity-train-v1';
  const validationDatasetIdentity = 'residual-liquidity-validation-v1';
  const oosDatasetIdentity = 'residual-liquidity-oos-v1';
  const trainDatasetDigest = sha('residual-liquidity-train');
  const validationDatasetDigest = sha('residual-liquidity-validation');
  const oosDatasetDigest = sha('residual-liquidity-oos');
  const lineageId = 'public-forward-residual-liquidity-lineage-v1';
  const oosReferenceId = 'residual-liquidity-oos-validation-v1';

  return sealMeasurement({
    measurementIdentity: 'runtime-residual-liquidity-measurement-001',
    testOnly: false,
    measurementProducerCodeSha: commit('runtime-residual-measurement-producer'),
    datasetReceiptIdentity: 'runtime-residual-liquidity-dataset-receipt-001',
    datasetReceiptDigest: sha('runtime-residual-liquidity-dataset-receipt'),
    calibrationArtifactIdentity: calibration.artifactIdentity,
    calibrationArtifactDigest: calibration.artifactDigest,
    sourceContractFamily: calibration.sourceContractFamily,
    v3IndependentSplitIndexDigest: calibration.v3IndependentSplitIndexDigest,
    sourceInventoryDigest: calibration.sourceInventoryDigest,
    sourceDatasetDigests: [...calibration.sourceDatasetDigests],
    independenceAuditDigest: calibration.independenceAuditDigest,
    independentSplitSourceDigest: calibration.independentSplitSourceDigest,
    nativeOosValidationDigest: calibration.oosValidationDigest,
    nativeOosOutcomeDigest: calibration.oosOutcomeDigest,
    parameterPayloadDigest: calibration.parameterPayloadDigest,
    fitEvidenceDigest: calibration.fitEvidenceDigest,
    methodologyVersion: calibration.calibrationMethodologyVersion,
    artifactId: 'independent-liquidity-impact-artifact-001',
    datasetIdentity: 'residual-liquidity-measurement-dataset-v1',
    datasetDigest: sha('residual-liquidity-measurement-dataset'),
    sampleN: 30,
    trainDatasetIdentity,
    trainDatasetDigest,
    trainSampleN: 18,
    validationDatasetIdentity,
    validationDatasetDigest,
    validationSampleN: 6,
    oosDatasetIdentity,
    oosDatasetDigest,
    oosSampleN: 6,
    marketScopes: ['CRYPTO_FUTURES'],
    symbolScopes: ['BTCUSDT'],
    sideScopes: ['BUY', 'SELL'],
    quantityNotionalBucketIdentity: 'notional-1000-5000-usdt-v1',
    volatilityRegimeIdentity: 'volatility-normal-v1',
    liquidityRegimeIdentity: 'liquidity-normal-v1',
    measuredAtMs: NOW_MS - 1_000,
    maximumAgeMs: MAXIMUM_AGE_MS,
    provenance: {
      sourceType: 'PUBLIC_FORWARD_MARKET_DATA',
      sourceProvider: 'BITGET_PUBLIC',
      sourceIdentity: 'bitget-public-forward-residual-liquidity-v1',
      sourceDigest: sha('bitget-public-forward-residual-liquidity'),
      immutable: true,
    },
    sourceObservationLineage: {
      lineageId,
      lineageDigest: sha('public-forward-residual-liquidity-lineage'),
      sourceType: 'PUBLIC_FORWARD_MARKET_DATA',
      sourceIdentity: 'bitget-public-forward-residual-liquidity-v1',
      observationCount: 30,
      firstObservedAt: NOW_MS - 20_000,
      lastObservedAt: NOW_MS - 2_000,
    },
    outOfSampleValidationReference: {
      referenceId: oosReferenceId,
      referenceDigest: sha('residual-liquidity-oos-validation-reference'),
      trainDatasetIdentity,
      trainDatasetDigest,
      validationDatasetIdentity,
      validationDatasetDigest,
      oosDatasetIdentity,
      oosDatasetDigest,
      sampleN: 6,
      status: 'PASS',
      heldOut: true,
      contaminationFree: true,
      evaluatedAt: NOW_MS - 1_500,
    },
    estimatedImpactPercent: 0.0012,
    estimatedImpactBps: 0.12,
    zeroEvidenceReason: null,
    zeroEvidenceReference: null,
    costOwnership: {
      owner: 'INDEPENDENT_LIQUIDITY_IMPACT',
      sourceIdentity: 'independent-residual-liquidity-impact-source-v1',
      sourceDigest: sha('independent-residual-liquidity-impact-source'),
      excludedCostOwners: [
        'VISIBLE_L2_BOOK_WALK_SLIPPAGE',
        'LATENCY_ADVERSE_MOVE',
        'PARTIAL_FILL',
        'SPREAD',
      ],
    },
    independenceEvidence: {
      status: 'VERIFIED',
      targetVariable:
        'RESIDUAL_PRICE_IMPACT_AFTER_SPREAD_VISIBLE_BOOK_WALK_LATENCY_AND_PARTIAL_FILL',
      bookWalkExcluded: true,
      latencyAdverseMoveExcluded: true,
      partialFillExcluded: true,
      spreadExcluded: true,
      implementationShortfallDecomposed: true,
      fullImplementationShortfallUsed: false,
      sharedObservationLineageAllowed: false,
      validationReferenceId: oosReferenceId,
    },
    competingCostEvidence: competingCostEvidence(),
  });
}

function produce(admission = makeCalibrationAdmission(), measurement = makeRuntimeMeasurement(admission)) {
  return produceAuthoritativePaperLiquidityImpactCostEvidence({
    calibrationAdmission: admission,
    runtimeMeasurement: measurement,
    expectedProducerCodeSha: PRODUCER_SHA,
    nowMs: NOW_MS,
    maximumAgeMs: MAXIMUM_AGE_MS,
  });
}

test('fails closed when Native V3 calibration admission is missing', () => {
  const result = produceAuthoritativePaperLiquidityImpactCostEvidence({
    runtimeMeasurement: makeRuntimeMeasurement(),
    expectedProducerCodeSha: PRODUCER_SHA,
    nowMs: NOW_MS,
    maximumAgeMs: MAXIMUM_AGE_MS,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.firewallArtifact, null);
  assert.equal(result.fullCostReady, false);
  assert.ok(result.blockers.includes('NATIVE_CALIBRATION_ADMISSION_REQUIRED'));
});

test('fails closed while Native V3 OOS calibration is not ready', () => {
  const admission = makeCalibrationAdmission();
  admission.calibrationStatus = 'NOT_READY';
  admission.calibrationArtifactProduced = false;
  const result = produce(admission, makeRuntimeMeasurement(admission));
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('NATIVE_CALIBRATION_NOT_READY'));
  assert.equal(result.runtimeCostCredit, 0);
});

test('rejects a tampered Native calibration artifact digest', () => {
  const admission = makeCalibrationAdmission();
  admission.artifact.policyDigest = sha('tampered-policy');
  const result = produce(admission, makeRuntimeMeasurement(admission));
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('NATIVE_CALIBRATION_ARTIFACT_DIGEST_MISMATCH'));
});

test('rejects a runtime measurement bound to a different Native calibration lineage', () => {
  const admission = makeCalibrationAdmission();
  const measurement = makeRuntimeMeasurement(admission);
  measurement.nativeOosValidationDigest = sha('wrong-native-oos-validation');
  measurement.measurementDigest = computeRuntimeLiquidityImpactMeasurementDigest(measurement);
  const result = produce(admission, measurement);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('RUNTIME_MEASUREMENT_NATIVE_CALIBRATION_BINDING_MISMATCH'));
});

test('forbids overloading a Native source digest as the measured residual dataset digest', () => {
  const admission = makeCalibrationAdmission();
  const measurement = makeRuntimeMeasurement(admission);
  measurement.datasetDigest = admission.artifact.sourceDatasetDigests[0];
  measurement.measurementDigest = computeRuntimeLiquidityImpactMeasurementDigest(measurement);
  const result = produce(admission, measurement);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('NATIVE_SOURCE_DIGEST_AS_MEASUREMENT_DATASET_FORBIDDEN'));
});

test('does not turn unknown or unproved zero liquidity impact into zero cost', () => {
  const admission = makeCalibrationAdmission();
  const measurement = makeRuntimeMeasurement(admission);
  measurement.estimatedImpactPercent = 0;
  measurement.estimatedImpactBps = 0;
  measurement.zeroEvidenceReason = null;
  measurement.zeroEvidenceReference = null;
  measurement.measurementDigest = computeRuntimeLiquidityImpactMeasurementDigest(measurement);
  const result = produce(admission, measurement);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('MEASURED_ZERO_EVIDENCE_REQUIRED'));
  assert.equal(result.firewallArtifact, null);
});

test('accepts an exact measured zero only with immutable zero-evidence binding', () => {
  const admission = makeCalibrationAdmission();
  const measurement = makeRuntimeMeasurement(admission);
  const lineage = measurement.sourceObservationLineage as Mutable;
  const oos = measurement.outOfSampleValidationReference as Mutable;
  measurement.estimatedImpactPercent = 0;
  measurement.estimatedImpactBps = 0;
  measurement.zeroEvidenceReason = 'EMPIRICALLY_MEASURED_ZERO_RESIDUAL_IMPACT';
  measurement.zeroEvidenceReference = {
    referenceId: 'measured-zero-reference-v1',
    referenceDigest: sha('measured-zero-reference'),
    result: 'MEASURED_ZERO_COMPATIBLE',
    sourceObservationLineageId: lineage.lineageId,
    outOfSampleValidationReferenceId: oos.referenceId,
  };
  measurement.measurementDigest = computeRuntimeLiquidityImpactMeasurementDigest(measurement);
  const result = produce(admission, measurement);
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.firewallArtifact?.estimatedImpactPercent, 0);
  assert.equal(result.firewallArtifact?.estimatedImpactBps, 0);
  assert.equal(result.runtimeEligible, false);
});

test('rejects percent/bps unit disagreement instead of normalizing it', () => {
  const admission = makeCalibrationAdmission();
  const measurement = makeRuntimeMeasurement(admission);
  measurement.estimatedImpactBps = 1.2;
  measurement.measurementDigest = computeRuntimeLiquidityImpactMeasurementDigest(measurement);
  const result = produce(admission, measurement);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('RUNTIME_MEASUREMENT_IMPACT_VALUE_INVALID'));
});

test('test-only measurement never receives runtime cost credit', () => {
  const admission = makeCalibrationAdmission();
  const measurement = makeRuntimeMeasurement(admission);
  measurement.testOnly = true;
  measurement.measurementDigest = computeRuntimeLiquidityImpactMeasurementDigest(measurement);
  const result = produce(admission, measurement);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('TEST_ONLY_MEASUREMENT_RUNTIME_CREDIT_FORBIDDEN'));
  assert.equal(result.runtimeCostCredit, 0);
});

test('requires independent competing cost evidence instead of reusing liquidity lineage', () => {
  const admission = makeCalibrationAdmission();
  const measurement = makeRuntimeMeasurement(admission);
  const competing = measurement.competingCostEvidence as Mutable[];
  competing[0].sourceObservationLineageId = measurement.sourceObservationLineage.lineageId;
  competing[0].sourceObservationLineageDigest = measurement.sourceObservationLineage.lineageDigest;
  measurement.measurementDigest = computeRuntimeLiquidityImpactMeasurementDigest(measurement);
  const result = produce(admission, measurement);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('COMPETING_COST_LINEAGE_REUSE_FORBIDDEN'));
});

test('produces an immutable firewall candidate while preserving Native multi-source lineage separately', () => {
  const admission = makeCalibrationAdmission();
  const measurement = makeRuntimeMeasurement(admission);
  const result = produce(admission, measurement);

  assert.equal(result.status, 'PRESENT');
  assert.equal(result.producerStatus, 'PRESENT');
  assert.equal(result.liquidityImpactStatus, 'BLOCKED_DATA');
  assert.equal(result.firewallValidationRequired, true);
  assert.equal(result.runtimeEligible, false);
  assert.equal(result.naturalEntryCredit, 0);
  assert.equal(result.runtimeCostCredit, 0);
  assert.equal(result.evidenceComplete, 0);
  assert.equal(result.fullCostReady, false);
  assert.equal(result.netAlphaReady, false);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.currentValidatedChampion, 'NONE');
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.privateApiUsed, false);
  assert.equal(result.liveTrading, false);
  assert.equal(result.orderSubmitted, false);
  assert.deepEqual(result.blockers, []);

  const firewall = result.firewallArtifact as Mutable;
  assert.equal(firewall.schema, LIQUIDITY_IMPACT_FIREWALL_SCHEMA);
  assert.equal(firewall.version, LIQUIDITY_IMPACT_FIREWALL_VERSION);
  assert.equal(firewall.evidenceClass, 'CALIBRATION_ARTIFACT');
  assert.equal(firewall.testOnly, false);
  assert.equal(firewall.producerCodeSha, PRODUCER_SHA);
  assert.equal(firewall.calibrationCodeSha, CALIBRATION_SHA);
  assert.equal(
    firewall.artifactDigest,
    computeLiquidityImpactFirewallArtifactDigest(firewall),
  );
  assert.equal('runtimeLiquidityImpactCoefficient' in firewall, false);

  assert.deepEqual(
    result.nativeCalibrationBinding?.sourceDatasetDigests,
    admission.artifact.sourceDatasetDigests,
  );
  assert.equal(
    result.nativeCalibrationBinding?.calibrationArtifactDigest,
    admission.artifact.artifactDigest,
  );
  assert.equal(
    result.nativeCalibrationBinding?.nativeOosValidationDigest,
    admission.artifact.oosValidationDigest,
  );
  assert.notEqual(firewall.datasetDigest, admission.artifact.sourceDatasetDigests[0]);
  assert.notEqual(firewall.datasetDigest, admission.artifact.sourceDatasetDigests[1]);
  assert.equal(
    result.runtimeMeasurementBinding?.measurementDigest,
    measurement.measurementDigest,
  );
});

test('safety contract permanently forbids fitting, synthetic aggregation, and premature promotion', () => {
  assert.equal(AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_SAFETY.parameterFittingAllowed, false);
  assert.equal(AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_SAFETY.oosReuseForFitAllowed, false);
  assert.equal(AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_SAFETY.syntheticAggregateDatasetDigestAllowed, false);
  assert.equal(AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_SAFETY.sourceDatasetDigestOverloadAllowed, false);
  assert.equal(AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_SAFETY.unknownImpactAsZeroAllowed, false);
  assert.equal(AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_SAFETY.fullCostReady, false);
  assert.equal(AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_SAFETY.netAlphaReady, false);
  assert.equal(AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_SAFETY.profitabilityProven, false);
  assert.equal(AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_SAFETY.executionAuthority, 'NONE');
});

import assert from 'node:assert/strict';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION,
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
} from './public-forward-partial-fill-calibration-dataset-store.service';
import {
  buildPublicForwardPartialFillStatisticalCalibrationAdmission,
  computePublicForwardPartialFillBusinessToleranceSemanticsDigest,
  PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_BUSINESS_TOLERANCE_AUTHORITY,
  PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_IDENTITY,
  PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_VERSION,
  type PublicForwardPartialFillStatisticalCalibrationAdmissionInput,
} from './public-forward-partial-fill-statistical-calibration-admission.service';

const D = 'a'.repeat(64);
const D2 = 'b'.repeat(64);
const D3 = 'c'.repeat(64);
const D4 = 'd'.repeat(64);
const D5 = 'e'.repeat(64);
const D6 = 'f'.repeat(64);
const FREEZE_MS = PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_BUSINESS_TOLERANCE_AUTHORITY.freezeEffectiveAtMs;
const ADMISSION_MS = Date.parse('2026-09-02T00:00:00Z');
const METHOD_MS = Date.parse('2026-09-02T12:00:00Z');
const MINIMUM_MS = Date.parse('2026-09-02T13:00:00Z');
const COHORT_MS = Date.parse('2026-09-03T00:00:00Z');
const ELIGIBLE_MS = COHORT_MS;

type MutableInput = any;

function frozen(identity: string, version: string, digest = D, frozenAtMs = METHOD_MS) {
  return { identity, version, digest, frozenAtMs, status: 'FROZEN' as const };
}

function validInput(): PublicForwardPartialFillStatisticalCalibrationAdmissionInput {
  const authority = PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_BUSINESS_TOLERANCE_AUTHORITY;
  return {
    admissionFrozenAtMs: ADMISSION_MS,
    consumerIdentity: 'PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_EVALUATOR_V1',
    datasetSchemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION,
    businessTolerance: {
      completeValidationReceiptUrl: authority.completeValidationReceiptUrl,
      freezeArtifactUrl: authority.freezeArtifactUrl,
      businessToleranceIdentity: authority.businessToleranceIdentity,
      businessToleranceVersion: authority.businessToleranceVersion,
      freezePayloadDigest: authority.freezePayloadDigest,
      freezeEffectiveAtMs: FREEZE_MS,
      semanticsRegistryIdentity: authority.semanticsRegistryIdentity,
      semanticsRegistryDigest: computePublicForwardPartialFillBusinessToleranceSemanticsDigest(),
    },
    successor: {
      cohort: frozen('PUBLIC_FORWARD_PARTIAL_FILL_SUCCESSOR_COHORT_V1', 'V1', D4, COHORT_MS),
      effectiveCohortStartMs: COHORT_MS,
      policyDigest: D5,
      splitPolicy: frozen('PUBLIC_FORWARD_PARTIAL_FILL_SUCCESSOR_SPLIT_POLICY_V1', 'V1', D6, COHORT_MS - 10_000),
      scopeUniverse: frozen('PUBLIC_FORWARD_PARTIAL_FILL_SCOPE_UNIVERSE_V1', 'V1', D, COHORT_MS - 20_000),
    },
    statisticalMethodology: {
      methodology: frozen('PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_METHODOLOGY_V1', 'V1', D2, METHOD_MS),
      numericMinimumArtifact: frozen('PUBLIC_FORWARD_PARTIAL_FILL_NUMERIC_MINIMUM_V1', 'V1', D3, MINIMUM_MS),
    },
    evidence: [
      {
        observationId: 'obs-1',
        sourceObservationLineageDigest: D4,
        sourceReceiptIdentity: 'receipt-1',
        sourceReceiptDigest: D5,
        sourceArtifactIdentity: 'artifact-1',
        sourceArtifactDigest: D6,
        sourceClass: 'FORWARD_NATURAL_SAMPLE',
        datasetIdentity: 'partial-fill-forward-dataset:FORWARD_NATURAL_SAMPLE:v1',
        datasetDigest: D,
        datasetStoreContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
        effectiveIndependenceProven: true,
        split: 'TRAIN',
        splitPolicyDigest: D6,
        scopeUniverseDigest: D,
        market: 'CRYPTO_FUTURES',
        sourceIdentity: 'PUBLIC_MARKET_DATA_V1',
        symbol: 'BTCUSDT',
        side: 'LONG',
        quantityNotionalBucketIdentity: 'NOTIONAL_BUCKET_1',
        volatilityRegimeIdentity: 'VOL_REGIME_1',
        liquidityRegimeIdentity: 'LIQ_REGIME_1',
        observedAtMs: ELIGIBLE_MS + 1_000,
        sourceTimestampMs: ELIGIBLE_MS + 500,
        duplicate: false,
        replay: false,
        backfill: false,
        manual: false,
        synthetic: false,
        predictedOpportunityProbabilityPresent: true,
        realizedOpportunityOutcomePresent: true,
        predictedFillRatioPresent: true,
        actualFillRatioPresent: true,
        queuePositionEvidencePresent: true,
        predictedAllInCostPresent: true,
        actualAllInCostPresent: true,
        predictionIntervalPresent: true,
        settlementEvidencePresent: true,
      },
    ],
  };
}

function mutableInput(): MutableInput {
  return structuredClone(validInput()) as MutableInput;
}

function blockedCodes(input: PublicForwardPartialFillStatisticalCalibrationAdmissionInput): readonly string[] {
  return buildPublicForwardPartialFillStatisticalCalibrationAdmission(input).blockers;
}

{
  const result = buildPublicForwardPartialFillStatisticalCalibrationAdmission(validInput());
  assert.equal(result.status, 'ADMITTED');
  assert.ok(result.artifact);
  assert.equal(result.artifact.schemaVersion, PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_VERSION);
  assert.equal(result.artifact.admissionIdentity, PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_IDENTITY);
  assert.equal(result.artifact.admissionStatus, 'ADMITTED_FOR_PROSPECTIVE_EVALUATION_ONLY');
  assert.equal(result.artifact.eligibleEvidenceStartMs, ELIGIBLE_MS);
  assert.equal(result.artifact.datasetSchemaVersion, PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION);
  assert.equal(result.artifact.datasetStoreContract, PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT);
  assert.equal(result.artifact.effectiveIndependentEligibleN, 1);
  assert.equal(result.artifact.calibrationSampleSufficient, false);
  assert.equal(result.artifact.statisticalNumericizationStarted, false);
  assert.equal(result.artifact.numericMinimumArtifactProduced, false);
  assert.equal(result.artifact.calibrationArtifactProduced, false);
  assert.equal(result.artifact.partialFillCostProduced, false);
  assert.equal(result.artifact.productionPolicyAuthorityConnected, false);
  assert.equal(result.artifact.fullCostReady, false);
  assert.equal(result.artifact.evidenceComplete, 0);
  assert.equal(result.artifact.executionAuthority, 'NONE');
  assert.equal(result.artifact.liveTrading, false);
  assert.equal(result.artifact.admittedEvidence[0]?.metricEvaluability.tol01OpportunityCalibration, true);
  assert.equal(result.artifact.admittedEvidence[0]?.metricEvaluability.tol09CalibrationFreshness, false);
  assert.deepEqual(result.artifact.admittedEvidence[0]?.metricBlockers, []);
  assert.match(result.artifact.digest, /^[a-f0-9]{64}$/u);
}

{
  const a = buildPublicForwardPartialFillStatisticalCalibrationAdmission(validInput());
  const b = buildPublicForwardPartialFillStatisticalCalibrationAdmission(validInput());
  assert.equal(a.artifact?.digest, b.artifact?.digest, 'canonical digest must be deterministic');
}

{
  const input = mutableInput();
  input.businessTolerance.completeValidationReceiptUrl =
    'https://github.com/seungjae3908-source/seungjae20260713/issues/838#issuecomment-1';
  assert.ok(blockedCodes(input).includes('BUSINESS_TOLERANCE_COMPLETE_VALIDATION_RECEIPT_REQUIRED'));
}

{
  const input = mutableInput();
  input.businessTolerance.freezeArtifactUrl =
    'https://github.com/seungjae3908-source/seungjae20260713/issues/838#issuecomment-2';
  assert.ok(blockedCodes(input).includes('BUSINESS_TOLERANCE_FREEZE_ARTIFACT_REQUIRED'));
}

{
  const input = mutableInput();
  input.businessTolerance.freezePayloadDigest = D;
  assert.ok(blockedCodes(input).includes('BUSINESS_TOLERANCE_FREEZE_DIGEST_MISMATCH'));
}

{
  const input = mutableInput();
  input.businessTolerance.freezeEffectiveAtMs += 1;
  assert.ok(blockedCodes(input).includes('BUSINESS_TOLERANCE_FREEZE_TIMESTAMP_MISMATCH'));
}

{
  const input = mutableInput();
  input.businessTolerance.semanticsRegistryIdentity = 'OTHER_REGISTRY';
  assert.ok(blockedCodes(input).includes('BUSINESS_TOLERANCE_SEMANTICS_BINDING_MISMATCH'));
}

{
  const input = mutableInput();
  input.businessTolerance.semanticsRegistryDigest = D;
  assert.ok(blockedCodes(input).includes('BUSINESS_TOLERANCE_SEMANTICS_BINDING_MISMATCH'));
}

{
  const input = mutableInput();
  input.datasetSchemaVersion = 'other-dataset-version';
  assert.ok(blockedCodes(input).includes('DATASET_SCHEMA_VERSION_MISMATCH'));
}

{
  const input = mutableInput();
  input.evidence[0].datasetStoreContract = 'other-store-contract';
  assert.ok(blockedCodes(input).includes('AUTHORITATIVE_DATASET_BINDING_REQUIRED'));
}

{
  const input = mutableInput();
  input.successor.cohort.status = 'BROKEN';
  assert.ok(blockedCodes(input).includes('SUCCESSOR_PROSPECTIVE_COHORT_NOT_FROZEN'));
}

{
  const input = mutableInput();
  input.successor.policyDigest = '';
  assert.ok(blockedCodes(input).includes('SUCCESSOR_POLICY_DIGEST_MISSING'));
}

{
  const input = mutableInput();
  input.successor.splitPolicy.digest = 'bad';
  assert.ok(blockedCodes(input).includes('SPLIT_POLICY_BINDING_MISSING'));
}

{
  const input = mutableInput();
  input.successor.scopeUniverse.status = 'BROKEN';
  assert.ok(blockedCodes(input).includes('SCOPE_UNIVERSE_BINDING_MISSING'));
}

{
  const input = mutableInput();
  input.evidence[0].scopeUniverseDigest = D2;
  assert.ok(blockedCodes(input).includes('SCOPE_UNIVERSE_BINDING_MISSING'));
}

{
  const input = mutableInput();
  input.statisticalMethodology.methodology.digest = 'bad';
  assert.ok(blockedCodes(input).includes('STATISTICAL_METHODOLOGY_NOT_FROZEN'));
}

{
  const input = mutableInput();
  input.statisticalMethodology.numericMinimumArtifact.digest = 'bad';
  assert.ok(blockedCodes(input).includes('NUMERIC_MINIMUM_ARTIFACT_NOT_FROZEN'));
}

{
  const input = mutableInput();
  input.evidence[0].observedAtMs = ADMISSION_MS - 1;
  input.evidence[0].sourceTimestampMs = ADMISSION_MS - 2;
  const codes = blockedCodes(input);
  assert.ok(codes.includes('PRE_ADMISSION_EVIDENCE_FORBIDDEN'));
  assert.ok(codes.includes('PRE_COHORT_EVIDENCE_FORBIDDEN'));
}

{
  const input = mutableInput();
  input.evidence[0].observedAtMs = ELIGIBLE_MS + 1_000;
  input.evidence[0].sourceTimestampMs = ADMISSION_MS - 1;
  const codes = blockedCodes(input);
  assert.ok(codes.includes('PRE_ADMISSION_EVIDENCE_FORBIDDEN'));
  assert.ok(codes.includes('PRE_COHORT_EVIDENCE_FORBIDDEN'));
}

{
  const input = mutableInput();
  input.successor.splitPolicy.frozenAtMs = ELIGIBLE_MS + 5_000;
  input.evidence[0].observedAtMs = ELIGIBLE_MS + 1_000;
  input.evidence[0].sourceTimestampMs = ELIGIBLE_MS + 500;
  assert.ok(blockedCodes(input).includes('PRE_ADMISSION_EVIDENCE_FORBIDDEN'));
}

{
  const input = mutableInput();
  input.successor.scopeUniverse.frozenAtMs = ELIGIBLE_MS + 5_000;
  input.evidence[0].observedAtMs = ELIGIBLE_MS + 1_000;
  input.evidence[0].sourceTimestampMs = ELIGIBLE_MS + 500;
  assert.ok(blockedCodes(input).includes('PRE_ADMISSION_EVIDENCE_FORBIDDEN'));
}

{
  const input = mutableInput();
  input.successor.cohort.frozenAtMs = ELIGIBLE_MS + 5_000;
  input.evidence[0].observedAtMs = ELIGIBLE_MS + 1_000;
  input.evidence[0].sourceTimestampMs = ELIGIBLE_MS + 500;
  assert.ok(blockedCodes(input).includes('PRE_ADMISSION_EVIDENCE_FORBIDDEN'));
}

{
  const input = mutableInput();
  input.evidence[0].effectiveIndependenceProven = false;
  assert.ok(blockedCodes(input).includes('EFFECTIVE_INDEPENDENCE_NOT_PROVEN'));
}

for (const flag of ['duplicate', 'replay', 'backfill', 'manual', 'synthetic'] as const) {
  const input = mutableInput();
  input.evidence[0][flag] = true;
  assert.ok(blockedCodes(input).includes('NON_GENUINE_EVIDENCE_CREDIT_FORBIDDEN'), flag);
}

{
  const input = mutableInput();
  input.evidence[0].sourceClass = 'HISTORICAL_SAMPLE';
  assert.ok(blockedCodes(input).includes('GENUINE_PROSPECTIVE_SOURCE_REQUIRED'));
}

{
  const input = mutableInput();
  input.evidence[0].sourceClass = 'SUCCESSOR_FORWARD_NATURAL_SAMPLE';
  assert.ok(blockedCodes(input).includes('GENUINE_PROSPECTIVE_SOURCE_REQUIRED'));
}

{
  const input = mutableInput();
  input.evidence[0].sourceTimestampMs = input.evidence[0].observedAtMs + 1;
  assert.ok(blockedCodes(input).includes('FUTURE_SOURCE_TIMESTAMP_FORBIDDEN'));
}

{
  const input = mutableInput();
  input.evidence.push(structuredClone(input.evidence[0]));
  const codes = blockedCodes(input);
  assert.ok(codes.includes('DUPLICATE_OBSERVATION_FORBIDDEN'));
  assert.ok(codes.includes('DUPLICATE_LINEAGE_FORBIDDEN'));
}

{
  const input = mutableInput();
  input.evidence[0].predictedFillRatioPresent = false;
  input.evidence[0].actualFillRatioPresent = false;
  input.evidence[0].queuePositionEvidencePresent = false;
  input.evidence[0].predictedAllInCostPresent = false;
  input.evidence[0].actualAllInCostPresent = false;
  input.evidence[0].predictionIntervalPresent = false;
  input.evidence[0].settlementEvidencePresent = false;
  const result = buildPublicForwardPartialFillStatisticalCalibrationAdmission(input);
  assert.equal(result.status, 'ADMITTED');
  assert.equal(result.artifact?.effectiveIndependentEligibleN, 1);
  const evidence = result.artifact?.admittedEvidence[0];
  assert.equal(evidence?.metricEvaluability.tol02FillRatioAbsoluteError, false);
  assert.equal(evidence?.metricEvaluability.tol03FillRatioSignedBias, false);
  assert.equal(evidence?.metricEvaluability.tol04AllInCostAbsoluteError, false);
  assert.equal(evidence?.metricEvaluability.tol05AdverseCostUnderestimation, false);
  assert.equal(evidence?.metricEvaluability.tol06AdverseTailCostUnderestimation, false);
  assert.equal(evidence?.metricEvaluability.tol07PredictionIntervalCoverage, false);
  assert.equal(evidence?.metricEvaluability.tol08SettlementReconciliation, false);
  assert.ok(evidence?.metricBlockers.includes('ACTUAL_FILL_EVIDENCE_MISSING'));
  assert.ok(evidence?.metricBlockers.includes('QUEUE_POSITION_EVIDENCE_MISSING'));
  assert.ok(evidence?.metricBlockers.includes('ACTUAL_COST_EVIDENCE_MISSING'));
  assert.ok(evidence?.metricBlockers.includes('SETTLEMENT_EVIDENCE_MISSING'));
  assert.equal(result.artifact?.calibrationSampleSufficient, false);
  assert.equal(result.artifact?.partialFillCostProduced, false);
}

{
  const input = mutableInput();
  input.evidence = [];
  const result = buildPublicForwardPartialFillStatisticalCalibrationAdmission(input);
  assert.equal(result.status, 'ADMITTED');
  assert.equal(result.artifact?.effectiveIndependentEligibleN, 0);
  assert.equal(result.artifact?.calibrationSampleSufficient, false);
  assert.equal(result.artifact?.statisticalNumericizationStarted, false);
  assert.equal(result.artifact?.fullCostReady, false);
}

console.log('public-forward partial-fill statistical calibration admission tests: PASS');

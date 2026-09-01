import assert from 'node:assert/strict';

import {
  buildPublicForwardPartialFillStatisticalCalibrationAdmission,
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
const FREEZE_MS = Date.parse('2026-09-01T05:59:01Z');
const ADMISSION_MS = Date.parse('2026-09-02T00:00:00Z');
const COHORT_MS = Date.parse('2026-09-03T00:00:00Z');
const METHOD_MS = Date.parse('2026-09-02T12:00:00Z');
const MINIMUM_MS = Date.parse('2026-09-02T13:00:00Z');
const ELIGIBLE_MS = COHORT_MS;

function frozen(identity: string, version: string, digest = D, frozenAtMs = METHOD_MS) {
  return { identity, version, digest, frozenAtMs, status: 'FROZEN' as const };
}

function validInput(): PublicForwardPartialFillStatisticalCalibrationAdmissionInput {
  return {
    admissionFrozenAtMs: ADMISSION_MS,
    consumerIdentity: 'PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_EVALUATOR_V1',
    datasetSchemaVersion: 'public-forward-partial-fill-calibration-dataset-v1',
    businessTolerance: {
      completeValidationReceiptUrl:
        'https://github.com/seungjae3908-source/seungjae20260713/issues/838#issuecomment-5489626816',
      freezeArtifactUrl:
        'https://github.com/seungjae3908-source/seungjae20260713/issues/838#issuecomment-5489589062',
      businessToleranceIdentity: 'PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_V1',
      businessToleranceVersion: 'V1',
      freezePayloadDigest: D2,
      freezeEffectiveAtMs: FREEZE_MS,
      semanticsRegistryIdentity: 'PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS_V1',
      semanticsRegistryDigest: D3,
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
        sourceClass: 'SUCCESSOR_FORWARD_NATURAL_SAMPLE',
        datasetIdentity: 'partial-fill-forward-dataset:SUCCESSOR_FORWARD_NATURAL_SAMPLE:v1',
        datasetDigest: D,
        datasetStoreContract: 'public-forward-partial-fill-calibration-store-v1',
        effectiveIndependenceProven: true,
        split: 'TRAIN',
        splitPolicyDigest: D6,
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function blockedCodes(input: PublicForwardPartialFillStatisticalCalibrationAdmissionInput): readonly string[] {
  return buildPublicForwardPartialFillStatisticalCalibrationAdmission(input).blockers;
}

{
  const result = buildPublicForwardPartialFillStatisticalCalibrationAdmission(validInput());
  assert.equal(result.status, 'ADMITTED');
  assert.ok(result.artifact);
  assert.equal(result.artifact!.schemaVersion, PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_VERSION);
  assert.equal(result.artifact!.admissionIdentity, PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_IDENTITY);
  assert.equal(result.artifact!.admissionStatus, 'ADMITTED_FOR_PROSPECTIVE_EVALUATION_ONLY');
  assert.equal(result.artifact!.eligibleEvidenceStartMs, ELIGIBLE_MS);
  assert.equal(result.artifact!.effectiveIndependentEligibleN, 1);
  assert.equal(result.artifact!.calibrationSampleSufficient, false);
  assert.equal(result.artifact!.statisticalNumericizationStarted, false);
  assert.equal(result.artifact!.numericMinimumArtifactProduced, false);
  assert.equal(result.artifact!.calibrationArtifactProduced, false);
  assert.equal(result.artifact!.partialFillCostProduced, false);
  assert.equal(result.artifact!.productionPolicyAuthorityConnected, false);
  assert.equal(result.artifact!.fullCostReady, false);
  assert.equal(result.artifact!.evidenceComplete, 0);
  assert.equal(result.artifact!.executionAuthority, 'NONE');
  assert.equal(result.artifact!.liveTrading, false);
  assert.equal(result.artifact!.admittedEvidence[0]?.metricEvaluability.tol01OpportunityCalibration, true);
  assert.equal(result.artifact!.admittedEvidence[0]?.metricEvaluability.tol09CalibrationFreshness, false);
  assert.match(result.artifact!.digest, /^[a-f0-9]{64}$/u);
}

{
  const a = buildPublicForwardPartialFillStatisticalCalibrationAdmission(validInput());
  const b = buildPublicForwardPartialFillStatisticalCalibrationAdmission(validInput());
  assert.equal(a.artifact?.digest, b.artifact?.digest, 'canonical digest must be deterministic');
}

{
  const input = validInput();
  input.businessTolerance.completeValidationReceiptUrl = 'https://github.com/example/repo/issues/1#issuecomment-2';
  assert.ok(blockedCodes(input).includes('BUSINESS_TOLERANCE_COMPLETE_VALIDATION_RECEIPT_REQUIRED'));
}

{
  const input = validInput();
  input.businessTolerance.freezeArtifactUrl = 'TBD';
  assert.ok(blockedCodes(input).includes('BUSINESS_TOLERANCE_FREEZE_ARTIFACT_REQUIRED'));
}

{
  const input = validInput();
  input.businessTolerance.freezePayloadDigest = 'bad';
  assert.ok(blockedCodes(input).includes('BUSINESS_TOLERANCE_FREEZE_DIGEST_MISMATCH'));
}

{
  const input = validInput();
  input.businessTolerance.semanticsRegistryDigest = 'bad';
  assert.ok(blockedCodes(input).includes('BUSINESS_TOLERANCE_SEMANTICS_BINDING_MISMATCH'));
}

{
  const input = validInput();
  input.successor.cohort = { ...input.successor.cohort, status: 'BROKEN' as never };
  assert.ok(blockedCodes(input).includes('SUCCESSOR_PROSPECTIVE_COHORT_NOT_FROZEN'));
}

{
  const input = validInput();
  input.successor.policyDigest = '';
  assert.ok(blockedCodes(input).includes('SUCCESSOR_POLICY_DIGEST_MISSING'));
}

{
  const input = validInput();
  input.successor.splitPolicy = { ...input.successor.splitPolicy, digest: 'bad' };
  assert.ok(blockedCodes(input).includes('SPLIT_POLICY_BINDING_MISSING'));
}

{
  const input = validInput();
  input.successor.scopeUniverse = { ...input.successor.scopeUniverse, status: 'BROKEN' as never };
  assert.ok(blockedCodes(input).includes('SCOPE_UNIVERSE_BINDING_MISSING'));
}

{
  const input = validInput();
  input.statisticalMethodology.methodology = { ...input.statisticalMethodology.methodology, digest: 'bad' };
  assert.ok(blockedCodes(input).includes('STATISTICAL_METHODOLOGY_NOT_FROZEN'));
}

{
  const input = validInput();
  input.statisticalMethodology.numericMinimumArtifact = { ...input.statisticalMethodology.numericMinimumArtifact, digest: 'bad' };
  assert.ok(blockedCodes(input).includes('NUMERIC_MINIMUM_ARTIFACT_NOT_FROZEN'));
}

{
  const input = validInput();
  input.evidence[0] = { ...input.evidence[0], observedAtMs: ADMISSION_MS - 1 };
  const codes = blockedCodes(input);
  assert.ok(codes.includes('PRE_ADMISSION_EVIDENCE_FORBIDDEN'));
  assert.ok(codes.includes('PRE_COHORT_EVIDENCE_FORBIDDEN'));
}

{
  const input = validInput();
  input.evidence[0] = { ...input.evidence[0], effectiveIndependenceProven: false };
  assert.ok(blockedCodes(input).includes('EFFECTIVE_INDEPENDENCE_NOT_PROVEN'));
}

for (const flag of ['duplicate', 'replay', 'backfill', 'manual', 'synthetic'] as const) {
  const input = validInput();
  input.evidence[0] = { ...input.evidence[0], [flag]: true };
  assert.ok(blockedCodes(input).includes('NON_GENUINE_EVIDENCE_CREDIT_FORBIDDEN'), flag);
}

{
  const input = validInput();
  input.evidence[0] = { ...input.evidence[0], sourceClass: 'HISTORICAL_SAMPLE' };
  assert.ok(blockedCodes(input).includes('GENUINE_PROSPECTIVE_SOURCE_REQUIRED'));
}

{
  const input = validInput();
  input.evidence[0] = { ...input.evidence[0], sourceTimestampMs: input.evidence[0]!.observedAtMs + 1 };
  assert.ok(blockedCodes(input).includes('FUTURE_SOURCE_TIMESTAMP_FORBIDDEN'));
}

{
  const input = validInput();
  const duplicate = clone(input.evidence[0]!);
  input.evidence = [input.evidence[0]!, { ...duplicate }];
  const codes = blockedCodes(input);
  assert.ok(codes.includes('DUPLICATE_OBSERVATION_FORBIDDEN'));
  assert.ok(codes.includes('DUPLICATE_LINEAGE_FORBIDDEN'));
}

{
  const input = validInput();
  input.evidence[0] = {
    ...input.evidence[0],
    predictedFillRatioPresent: false,
    actualFillRatioPresent: false,
    queuePositionEvidencePresent: false,
    predictedAllInCostPresent: false,
    actualAllInCostPresent: false,
    predictionIntervalPresent: false,
    settlementEvidencePresent: false,
  };
  const result = buildPublicForwardPartialFillStatisticalCalibrationAdmission(input);
  assert.equal(result.status, 'ADMITTED');
  assert.equal(result.artifact?.effectiveIndependentEligibleN, 1);
  const metrics = result.artifact?.admittedEvidence[0]?.metricEvaluability;
  assert.equal(metrics?.tol02FillRatioAbsoluteError, false);
  assert.equal(metrics?.tol03FillRatioSignedBias, false);
  assert.equal(metrics?.tol04AllInCostAbsoluteError, false);
  assert.equal(metrics?.tol05AdverseCostUnderestimation, false);
  assert.equal(metrics?.tol06AdverseTailCostUnderestimation, false);
  assert.equal(metrics?.tol07PredictionIntervalCoverage, false);
  assert.equal(metrics?.tol08SettlementReconciliation, false);
  assert.equal(result.artifact?.calibrationSampleSufficient, false);
  assert.equal(result.artifact?.partialFillCostProduced, false);
}

{
  const input = validInput();
  input.evidence = [];
  const result = buildPublicForwardPartialFillStatisticalCalibrationAdmission(input);
  assert.equal(result.status, 'ADMITTED');
  assert.equal(result.artifact?.effectiveIndependentEligibleN, 0);
  assert.equal(result.artifact?.calibrationSampleSufficient, false);
  assert.equal(result.artifact?.fullCostReady, false);
}

console.log('public-forward partial-fill statistical calibration admission tests: PASS');

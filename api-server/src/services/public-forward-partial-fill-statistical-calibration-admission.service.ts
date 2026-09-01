import { createHash } from 'node:crypto';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS,
} from './public-forward-partial-fill-business-tolerance-decision-evidence.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION,
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
} from './public-forward-partial-fill-calibration-dataset-store.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_VERSION =
  'public-forward-partial-fill-statistical-calibration-admission-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_IDENTITY =
  'PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_V1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_BUSINESS_TOLERANCE_AUTHORITY =
  Object.freeze({
    completeValidationReceiptUrl:
      'https://github.com/seungjae3908-source/seungjae20260713/issues/838#issuecomment-5489626816',
    freezeArtifactUrl:
      'https://github.com/seungjae3908-source/seungjae20260713/issues/838#issuecomment-5489589062',
    businessToleranceIdentity: 'PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_V1' as const,
    businessToleranceVersion: 'V1' as const,
    freezePayloadDigest: 'adef3bbf8f6647f0314a35ca5b0d48eebefed614a0e66ab28e93f6d3dc2a0f7c',
    freezeEffectiveAtMs: Date.parse('2026-09-01T05:59:01Z'),
    semanticsRegistryIdentity: 'PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS_V1',
  });

export const PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_SAFETY = Object.freeze({
  prospectiveOnly: true,
  retrospectiveAdmissionAllowed: false,
  preFreezeSampleCredit: 0,
  preAdmissionSampleCredit: 0,
  replayCredit: 0,
  backfillCredit: 0,
  manualCredit: 0,
  syntheticCredit: 0,
  duplicateCredit: 0,
  resultConditionedRetuningAllowed: false,
  observedSampleMaySelectPolicy: false,
  defaultStatisticalMethodologyAllowed: false,
  defaultNumericMinimumAllowed: false,
  statisticalNumericizationStarted: false,
  numericMinimumArtifactProduced: false,
  calibrationSampleSufficient: false,
  calibrationArtifactProduced: false,
  partialFillCostProduced: false,
  productionPolicyAuthorityConnected: false,
  fullCostReady: false,
  evidenceComplete: 0,
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
});

export type FrozenRef = Readonly<{
  identity: string;
  version: string;
  digest: string;
  frozenAtMs: number;
  status: 'FROZEN';
}>;

export type BusinessToleranceAdmissionBinding = Readonly<{
  completeValidationReceiptUrl: string;
  freezeArtifactUrl: string;
  businessToleranceIdentity: 'PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_V1';
  businessToleranceVersion: 'V1';
  freezePayloadDigest: string;
  freezeEffectiveAtMs: number;
  semanticsRegistryIdentity: string;
  semanticsRegistryDigest: string;
}>;

export type SuccessorProspectiveCohortBinding = Readonly<{
  cohort: FrozenRef;
  effectiveCohortStartMs: number;
  policyDigest: string;
  splitPolicy: FrozenRef;
  scopeUniverse: FrozenRef;
}>;

export type StatisticalMethodologyBinding = Readonly<{
  methodology: FrozenRef;
  numericMinimumArtifact: FrozenRef;
}>;

export type CalibrationEvidenceBinding = Readonly<{
  observationId: string;
  sourceObservationLineageDigest: string;
  sourceReceiptIdentity: string;
  sourceReceiptDigest: string;
  sourceArtifactIdentity: string;
  sourceArtifactDigest: string;
  sourceClass: string;
  datasetIdentity: string;
  datasetDigest: string;
  datasetStoreContract: string;
  effectiveIndependenceProven: boolean;
  split: 'TRAIN' | 'VALIDATION' | 'OOS';
  splitPolicyDigest: string;
  scopeUniverseDigest: string;
  market: 'CRYPTO_FUTURES';
  sourceIdentity: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantityNotionalBucketIdentity: string;
  volatilityRegimeIdentity: string;
  liquidityRegimeIdentity: string;
  observedAtMs: number;
  sourceTimestampMs: number;
  duplicate: boolean;
  replay: boolean;
  backfill: boolean;
  manual: boolean;
  synthetic: boolean;
  predictedOpportunityProbabilityPresent: boolean;
  realizedOpportunityOutcomePresent: boolean;
  predictedFillRatioPresent: boolean;
  actualFillRatioPresent: boolean;
  queuePositionEvidencePresent: boolean;
  predictedAllInCostPresent: boolean;
  actualAllInCostPresent: boolean;
  predictionIntervalPresent: boolean;
  settlementEvidencePresent: boolean;
}>;

export type PublicForwardPartialFillStatisticalCalibrationAdmissionInput = Readonly<{
  admissionFrozenAtMs: number;
  consumerIdentity: string;
  datasetSchemaVersion: string;
  businessTolerance: BusinessToleranceAdmissionBinding;
  successor: SuccessorProspectiveCohortBinding;
  statisticalMethodology: StatisticalMethodologyBinding;
  evidence: readonly CalibrationEvidenceBinding[];
}>;

export type AdmittedCalibrationEvidence = Readonly<{
  observationId: string;
  sourceObservationLineageDigest: string;
  split: 'TRAIN' | 'VALIDATION' | 'OOS';
  scopeKey: string;
  observedAtMs: number;
  metricEvaluability: Readonly<{
    tol01OpportunityCalibration: boolean;
    tol02FillRatioAbsoluteError: boolean;
    tol03FillRatioSignedBias: boolean;
    tol04AllInCostAbsoluteError: boolean;
    tol05AdverseCostUnderestimation: boolean;
    tol06AdverseTailCostUnderestimation: boolean;
    tol07PredictionIntervalCoverage: boolean;
    tol08SettlementReconciliation: boolean;
    tol09CalibrationFreshness: false;
  }>;
  metricBlockers: readonly string[];
}>;

export type PublicForwardPartialFillStatisticalCalibrationAdmissionArtifact = Readonly<{
  schemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_VERSION;
  admissionIdentity: typeof PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_IDENTITY;
  kind: 'IMMUTABLE_PROSPECTIVE_STATISTICAL_CALIBRATION_ADMISSION';
  admissionStatus: 'ADMITTED_FOR_PROSPECTIVE_EVALUATION_ONLY';
  admissionFrozenAtMs: number;
  eligibleEvidenceStartMs: number;
  consumerIdentity: string;
  datasetSchemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION;
  datasetStoreContract: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT;
  businessTolerance: BusinessToleranceAdmissionBinding;
  successor: SuccessorProspectiveCohortBinding;
  statisticalMethodology: StatisticalMethodologyBinding;
  admittedEvidence: readonly AdmittedCalibrationEvidence[];
  effectiveIndependentEligibleN: number;
  calibrationSampleSufficient: false;
  statisticalNumericizationStarted: false;
  numericMinimumArtifactProduced: false;
  calibrationArtifactProduced: false;
  partialFillCostProduced: false;
  productionPolicyAuthorityConnected: false;
  fullCostReady: false;
  evidenceComplete: 0;
  executionAuthority: 'NONE';
  privateApiAllowed: false;
  liveTrading: false;
  orderSubmissionAllowed: false;
  digest: string;
}>;

export type PublicForwardPartialFillStatisticalCalibrationAdmissionResult = Readonly<{
  status: 'ADMITTED' | 'BLOCKED_POLICY' | 'BLOCKED_DATA';
  blockers: readonly string[];
  artifact: PublicForwardPartialFillStatisticalCalibrationAdmissionArtifact | null;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_NUMBER_NOT_CANONICAL');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') throw new TypeError('UNSUPPORTED_CANONICAL_VALUE');
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function deepFreezeCanonical<T>(value: T): T {
  const copy = canonicalize(value) as T;
  const freeze = (node: unknown): void => {
    if (!node || typeof node !== 'object' || Object.isFrozen(node)) return;
    for (const child of Object.values(node as Record<string, unknown>)) freeze(child);
    Object.freeze(node);
  };
  freeze(copy);
  return copy;
}

export function computePublicForwardPartialFillBusinessToleranceSemanticsDigest(): string {
  return digest(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS);
}

function nonEmpty(value: unknown): boolean {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 && normalized.length <= 320;
}

function exactDigest(value: unknown): boolean {
  return SHA256.test(String(value ?? '').trim());
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validFrozenRef(ref: FrozenRef | null | undefined): boolean {
  return Boolean(ref)
    && ref!.status === 'FROZEN'
    && nonEmpty(ref!.identity)
    && nonEmpty(ref!.version)
    && exactDigest(ref!.digest)
    && finitePositive(ref!.frozenAtMs);
}

function blocked(
  status: 'BLOCKED_POLICY' | 'BLOCKED_DATA',
  blockers: readonly string[],
): PublicForwardPartialFillStatisticalCalibrationAdmissionResult {
  return Object.freeze({ status, blockers: Object.freeze([...new Set(blockers)]), artifact: null });
}

function scopeKey(evidence: CalibrationEvidenceBinding): string {
  return [
    evidence.market,
    evidence.sourceIdentity,
    evidence.symbol,
    evidence.side,
    evidence.quantityNotionalBucketIdentity,
    evidence.volatilityRegimeIdentity,
    evidence.liquidityRegimeIdentity,
  ].join('|');
}

function validateAuthority(input: PublicForwardPartialFillStatisticalCalibrationAdmissionInput): string[] {
  const blockers: string[] = [];
  const add = (code: string) => { if (!blockers.includes(code)) blockers.push(code); };
  const tolerance = input.businessTolerance;
  const authority = PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_BUSINESS_TOLERANCE_AUTHORITY;

  if (!finitePositive(input.admissionFrozenAtMs)) add('STATISTICAL_CALIBRATION_ADMISSION_FREEZE_TIMESTAMP_INVALID');
  if (!nonEmpty(input.consumerIdentity)) add('CALIBRATION_CONSUMER_IDENTITY_MISSING');
  if (input.datasetSchemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION) {
    add('DATASET_SCHEMA_VERSION_MISMATCH');
  }
  if (tolerance.completeValidationReceiptUrl !== authority.completeValidationReceiptUrl) {
    add('BUSINESS_TOLERANCE_COMPLETE_VALIDATION_RECEIPT_REQUIRED');
  }
  if (tolerance.freezeArtifactUrl !== authority.freezeArtifactUrl) {
    add('BUSINESS_TOLERANCE_FREEZE_ARTIFACT_REQUIRED');
  }
  if (tolerance.businessToleranceIdentity !== authority.businessToleranceIdentity
    || tolerance.businessToleranceVersion !== authority.businessToleranceVersion) {
    add('BUSINESS_TOLERANCE_SEMANTICS_BINDING_MISMATCH');
  }
  if (tolerance.freezePayloadDigest !== authority.freezePayloadDigest) {
    add('BUSINESS_TOLERANCE_FREEZE_DIGEST_MISMATCH');
  }
  if (tolerance.freezeEffectiveAtMs !== authority.freezeEffectiveAtMs) {
    add('BUSINESS_TOLERANCE_FREEZE_TIMESTAMP_MISMATCH');
  }
  if (tolerance.semanticsRegistryIdentity !== authority.semanticsRegistryIdentity
    || tolerance.semanticsRegistryDigest !== computePublicForwardPartialFillBusinessToleranceSemanticsDigest()) {
    add('BUSINESS_TOLERANCE_SEMANTICS_BINDING_MISMATCH');
  }

  if (!validFrozenRef(input.successor.cohort)) add('SUCCESSOR_PROSPECTIVE_COHORT_NOT_FROZEN');
  if (!finitePositive(input.successor.effectiveCohortStartMs)) add('SUCCESSOR_PROSPECTIVE_COHORT_NOT_FROZEN');
  if (!exactDigest(input.successor.policyDigest)) add('SUCCESSOR_POLICY_DIGEST_MISSING');
  if (!validFrozenRef(input.successor.splitPolicy)) add('SPLIT_POLICY_BINDING_MISSING');
  if (!validFrozenRef(input.successor.scopeUniverse)) add('SCOPE_UNIVERSE_BINDING_MISSING');

  if (!validFrozenRef(input.statisticalMethodology.methodology)) add('STATISTICAL_METHODOLOGY_NOT_FROZEN');
  if (!validFrozenRef(input.statisticalMethodology.numericMinimumArtifact)) {
    add('NUMERIC_MINIMUM_ARTIFACT_NOT_FROZEN');
  }

  return blockers;
}

function eligibleStart(input: PublicForwardPartialFillStatisticalCalibrationAdmissionInput): number {
  return Math.max(
    PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_BUSINESS_TOLERANCE_AUTHORITY.freezeEffectiveAtMs,
    input.admissionFrozenAtMs,
    input.successor.cohort.frozenAtMs,
    input.successor.effectiveCohortStartMs,
    input.successor.splitPolicy.frozenAtMs,
    input.successor.scopeUniverse.frozenAtMs,
    input.statisticalMethodology.methodology.frozenAtMs,
    input.statisticalMethodology.numericMinimumArtifact.frozenAtMs,
  );
}

function validateEvidence(
  evidence: CalibrationEvidenceBinding,
  input: PublicForwardPartialFillStatisticalCalibrationAdmissionInput,
  eligibleEvidenceStartMs: number,
  seenObservationIds: Set<string>,
  seenLineages: Set<string>,
): string[] {
  const blockers: string[] = [];
  const add = (code: string) => { if (!blockers.includes(code)) blockers.push(code); };

  if (!nonEmpty(evidence.observationId) || seenObservationIds.has(evidence.observationId)) {
    add('DUPLICATE_OBSERVATION_FORBIDDEN');
  }
  if (!exactDigest(evidence.sourceObservationLineageDigest) || seenLineages.has(evidence.sourceObservationLineageDigest)) {
    add('DUPLICATE_LINEAGE_FORBIDDEN');
  }
  if (!nonEmpty(evidence.sourceReceiptIdentity) || !exactDigest(evidence.sourceReceiptDigest)
    || !nonEmpty(evidence.sourceArtifactIdentity) || !exactDigest(evidence.sourceArtifactDigest)) {
    add('IMMUTABLE_SOURCE_RECEIPT_REQUIRED');
  }
  if (evidence.sourceClass !== 'FORWARD_NATURAL_SAMPLE') {
    add('GENUINE_PROSPECTIVE_SOURCE_REQUIRED');
  }
  if (!nonEmpty(evidence.datasetIdentity) || !exactDigest(evidence.datasetDigest)
    || evidence.datasetStoreContract !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT) {
    add('AUTHORITATIVE_DATASET_BINDING_REQUIRED');
  }
  if (evidence.effectiveIndependenceProven !== true) add('EFFECTIVE_INDEPENDENCE_NOT_PROVEN');
  if (!['TRAIN', 'VALIDATION', 'OOS'].includes(evidence.split)
    || evidence.splitPolicyDigest !== input.successor.splitPolicy.digest) {
    add('SPLIT_POLICY_BINDING_MISSING');
  }
  if (evidence.scopeUniverseDigest !== input.successor.scopeUniverse.digest) {
    add('SCOPE_UNIVERSE_BINDING_MISSING');
  }
  if (evidence.market !== 'CRYPTO_FUTURES' || !nonEmpty(evidence.sourceIdentity) || !nonEmpty(evidence.symbol)
    || !['LONG', 'SHORT'].includes(evidence.side) || !nonEmpty(evidence.quantityNotionalBucketIdentity)
    || !nonEmpty(evidence.volatilityRegimeIdentity) || !nonEmpty(evidence.liquidityRegimeIdentity)) {
    add('REQUIRED_SCOPE_COVERAGE_INSUFFICIENT');
  }
  if (!finitePositive(evidence.observedAtMs) || !finitePositive(evidence.sourceTimestampMs)) {
    add('EVIDENCE_TIMESTAMP_INVALID');
  }
  if (finitePositive(evidence.observedAtMs) && evidence.observedAtMs < eligibleEvidenceStartMs) {
    add('PRE_ADMISSION_EVIDENCE_FORBIDDEN');
  }
  if (finitePositive(evidence.observedAtMs) && evidence.observedAtMs < input.successor.effectiveCohortStartMs) {
    add('PRE_COHORT_EVIDENCE_FORBIDDEN');
  }
  if (finitePositive(evidence.sourceTimestampMs) && evidence.sourceTimestampMs < eligibleEvidenceStartMs) {
    add('PRE_ADMISSION_EVIDENCE_FORBIDDEN');
  }
  if (finitePositive(evidence.sourceTimestampMs) && evidence.sourceTimestampMs < input.successor.effectiveCohortStartMs) {
    add('PRE_COHORT_EVIDENCE_FORBIDDEN');
  }
  if (finitePositive(evidence.sourceTimestampMs) && finitePositive(evidence.observedAtMs)
    && evidence.sourceTimestampMs > evidence.observedAtMs) {
    add('FUTURE_SOURCE_TIMESTAMP_FORBIDDEN');
  }
  if (evidence.duplicate || evidence.replay || evidence.backfill || evidence.manual || evidence.synthetic) {
    add('NON_GENUINE_EVIDENCE_CREDIT_FORBIDDEN');
  }

  return blockers;
}

function metricEvaluability(evidence: CalibrationEvidenceBinding): AdmittedCalibrationEvidence['metricEvaluability'] {
  const fillPair = evidence.predictedFillRatioPresent && evidence.actualFillRatioPresent;
  const costPair = evidence.predictedAllInCostPresent && evidence.actualAllInCostPresent;
  return Object.freeze({
    tol01OpportunityCalibration: evidence.predictedOpportunityProbabilityPresent && evidence.realizedOpportunityOutcomePresent,
    tol02FillRatioAbsoluteError: fillPair,
    tol03FillRatioSignedBias: fillPair,
    tol04AllInCostAbsoluteError: costPair,
    tol05AdverseCostUnderestimation: costPair,
    tol06AdverseTailCostUnderestimation: false,
    tol07PredictionIntervalCoverage: evidence.predictionIntervalPresent && evidence.realizedOpportunityOutcomePresent,
    tol08SettlementReconciliation: evidence.settlementEvidencePresent,
    tol09CalibrationFreshness: false,
  });
}

function metricBlockers(evidence: CalibrationEvidenceBinding): readonly string[] {
  const blockers: string[] = [];
  if (!evidence.actualFillRatioPresent) blockers.push('ACTUAL_FILL_EVIDENCE_MISSING');
  if (!evidence.queuePositionEvidencePresent) blockers.push('QUEUE_POSITION_EVIDENCE_MISSING');
  if (!evidence.actualAllInCostPresent) blockers.push('ACTUAL_COST_EVIDENCE_MISSING');
  if (!evidence.settlementEvidencePresent) blockers.push('SETTLEMENT_EVIDENCE_MISSING');
  return Object.freeze(blockers);
}

export function buildPublicForwardPartialFillStatisticalCalibrationAdmission(
  input: PublicForwardPartialFillStatisticalCalibrationAdmissionInput,
): PublicForwardPartialFillStatisticalCalibrationAdmissionResult {
  const authorityBlockers = validateAuthority(input);
  if (authorityBlockers.length > 0) return blocked('BLOCKED_POLICY', authorityBlockers);

  const eligibleEvidenceStartMs = eligibleStart(input);
  const seenObservationIds = new Set<string>();
  const seenLineages = new Set<string>();
  const admittedEvidence: AdmittedCalibrationEvidence[] = [];
  const evidenceBlockers: string[] = [];

  for (const evidence of input.evidence) {
    const blockers = validateEvidence(evidence, input, eligibleEvidenceStartMs, seenObservationIds, seenLineages);
    if (blockers.length > 0) {
      evidenceBlockers.push(...blockers);
      continue;
    }
    seenObservationIds.add(evidence.observationId);
    seenLineages.add(evidence.sourceObservationLineageDigest);
    admittedEvidence.push(Object.freeze({
      observationId: evidence.observationId,
      sourceObservationLineageDigest: evidence.sourceObservationLineageDigest,
      split: evidence.split,
      scopeKey: scopeKey(evidence),
      observedAtMs: evidence.observedAtMs,
      metricEvaluability: metricEvaluability(evidence),
      metricBlockers: metricBlockers(evidence),
    }));
  }

  if (evidenceBlockers.length > 0) return blocked('BLOCKED_DATA', evidenceBlockers);

  const artifactWithoutDigest = {
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_VERSION,
    admissionIdentity: PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_CALIBRATION_ADMISSION_IDENTITY,
    kind: 'IMMUTABLE_PROSPECTIVE_STATISTICAL_CALIBRATION_ADMISSION' as const,
    admissionStatus: 'ADMITTED_FOR_PROSPECTIVE_EVALUATION_ONLY' as const,
    admissionFrozenAtMs: input.admissionFrozenAtMs,
    eligibleEvidenceStartMs,
    consumerIdentity: input.consumerIdentity.trim(),
    datasetSchemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION,
    datasetStoreContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    businessTolerance: deepFreezeCanonical(input.businessTolerance),
    successor: deepFreezeCanonical(input.successor),
    statisticalMethodology: deepFreezeCanonical(input.statisticalMethodology),
    admittedEvidence: Object.freeze(admittedEvidence),
    effectiveIndependentEligibleN: admittedEvidence.length,
    calibrationSampleSufficient: false as const,
    statisticalNumericizationStarted: false as const,
    numericMinimumArtifactProduced: false as const,
    calibrationArtifactProduced: false as const,
    partialFillCostProduced: false as const,
    productionPolicyAuthorityConnected: false as const,
    fullCostReady: false as const,
    evidenceComplete: 0 as const,
    executionAuthority: 'NONE' as const,
    privateApiAllowed: false as const,
    liveTrading: false as const,
    orderSubmissionAllowed: false as const,
  };

  const artifact = Object.freeze({
    ...artifactWithoutDigest,
    digest: digest(artifactWithoutDigest),
  });

  return Object.freeze({ status: 'ADMITTED', blockers: Object.freeze([]), artifact });
}

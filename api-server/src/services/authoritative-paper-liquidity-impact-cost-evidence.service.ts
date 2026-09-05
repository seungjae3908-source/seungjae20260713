import { createHash } from 'node:crypto';

export const AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_VERSION =
  'authoritative-paper-liquidity-impact-cost-evidence-v1';

export const NATIVE_SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY =
  'SUCCESSOR_SCHEDULE_RELIABILITY_V3';
export const NATIVE_SUCCESSOR_V3_CALIBRATION_ARTIFACT_VERSION =
  'public-forward-liquidity-calibration-artifact-v1';
export const LIQUIDITY_IMPACT_FIREWALL_SCHEMA =
  'independent-liquidity-impact-calibration-evidence';
export const LIQUIDITY_IMPACT_FIREWALL_VERSION = 1;

const PUBLIC_FORWARD_SOURCE = 'PUBLIC_FORWARD_MARKET_DATA';
const LIQUIDITY_OWNER = 'INDEPENDENT_LIQUIDITY_IMPACT';
const RESIDUAL_TARGET =
  'RESIDUAL_PRICE_IMPACT_AFTER_SPREAD_VISIBLE_BOOK_WALK_LATENCY_AND_PARTIAL_FILL';
const REQUIRED_EXCLUDED_COST_OWNERS = Object.freeze([
  'VISIBLE_L2_BOOK_WALK_SLIPPAGE',
  'LATENCY_ADVERSE_MOVE',
  'PARTIAL_FILL',
  'SPREAD',
]);
const REQUIRED_COMPETING_COST_OWNERS = Object.freeze([
  'VISIBLE_L2_BOOK_WALK_SLIPPAGE',
  'LATENCY_ADVERSE_MOVE',
  'SPREAD',
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;

export const AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_SAFETY = Object.freeze({
  nativeSuccessorV3CalibrationRequired: true,
  explicitRuntimeMeasurementRequired: true,
  parameterFittingAllowed: false,
  oosReuseForFitAllowed: false,
  historicalBackfillAllowed: false,
  replayAllowed: false,
  syntheticEconomicCreditAllowed: false,
  syntheticAggregateDatasetDigestAllowed: false,
  sourceDatasetDigestOverloadAllowed: false,
  unknownImpactAsZeroAllowed: false,
  measuredZeroEvidenceRequired: true,
  firewallRevalidationRequired: true,
  runtimeEligibleBeforeFirewall: false,
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

type JsonRecord = Record<string, unknown>;

export interface AuthoritativePaperLiquidityImpactCostEvidenceInput {
  calibrationAdmission?: unknown;
  runtimeMeasurement?: unknown;
  expectedProducerCodeSha?: unknown;
  nowMs?: unknown;
  maximumAgeMs?: unknown;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 && normalized.length <= 512 ? normalized : null;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function exactDigest(value: unknown): string | null {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && SHA256.test(normalized) ? normalized : null;
}

function exactCommitSha(value: unknown): string | null {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && COMMIT_SHA.test(normalized) ? normalized : null;
}

function digestArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalized = value.map(exactDigest);
  if (normalized.some((item) => item == null)) return null;
  const digests = normalized as string[];
  return new Set(digests).size === digests.length ? digests : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalized = value.map(text);
  if (normalized.some((item) => item == null || item === '*')) return null;
  const values = normalized as string[];
  return new Set(values).size === values.length ? values : null;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_NUMBER_NOT_CANONICAL');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const object = record(value);
  if (!object) throw new TypeError('UNSUPPORTED_CANONICAL_VALUE');
  return Object.fromEntries(
    Object.entries(object)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function withoutKey(value: JsonRecord, key: string): JsonRecord {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

export function computeNativeV3CalibrationArtifactDigest(artifact: unknown): string {
  const value = record(artifact);
  if (!value) throw new TypeError('NATIVE_CALIBRATION_ARTIFACT_REQUIRED');
  return canonicalDigest(withoutKey(value, 'artifactDigest'));
}

export function computeRuntimeLiquidityImpactMeasurementDigest(measurement: unknown): string {
  const value = record(measurement);
  if (!value) throw new TypeError('RUNTIME_LIQUIDITY_MEASUREMENT_REQUIRED');
  return canonicalDigest(withoutKey(value, 'measurementDigest'));
}

export function computeLiquidityImpactFirewallArtifactDigest(artifact: unknown): string {
  const value = record(artifact);
  if (!value) throw new TypeError('LIQUIDITY_IMPACT_FIREWALL_ARTIFACT_REQUIRED');
  return canonicalDigest(withoutKey(value, 'artifactDigest'));
}

function add(blockers: string[], blocker: string): void {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}

function sameDigest(left: unknown, right: unknown): boolean {
  const leftDigest = exactDigest(left);
  const rightDigest = exactDigest(right);
  return leftDigest != null && leftDigest === rightDigest;
}

function sameStringArray(left: string[] | null, right: string[] | null): boolean {
  return left != null && right != null
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validateCalibrationAdmission(
  input: unknown,
  blockers: string[],
): JsonRecord | null {
  const admission = record(input);
  if (!admission) {
    add(blockers, 'NATIVE_CALIBRATION_ADMISSION_REQUIRED');
    return null;
  }
  if (admission.status !== 'PRESENT'
    || admission.calibrationStatus !== 'READY'
    || admission.calibrationArtifactProduced !== true) {
    add(blockers, 'NATIVE_CALIBRATION_NOT_READY');
  }
  const artifact = record(admission.artifact);
  if (!artifact) {
    add(blockers, 'NATIVE_CALIBRATION_ARTIFACT_REQUIRED');
    return null;
  }
  if (artifact.schemaVersion !== NATIVE_SUCCESSOR_V3_CALIBRATION_ARTIFACT_VERSION) {
    add(blockers, 'NATIVE_CALIBRATION_ARTIFACT_VERSION_MISMATCH');
  }
  if (artifact.sourceContractFamily !== NATIVE_SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY) {
    add(blockers, 'NATIVE_CALIBRATION_SOURCE_FAMILY_MISMATCH');
  }
  if (!text(artifact.artifactIdentity)
    || !exactCommitSha(artifact.artifactProducerCodeSha)
    || !exactDigest(artifact.artifactDigest)) {
    add(blockers, 'NATIVE_CALIBRATION_IDENTITY_INVALID');
  } else {
    try {
      if (!sameDigest(artifact.artifactDigest, computeNativeV3CalibrationArtifactDigest(artifact))) {
        add(blockers, 'NATIVE_CALIBRATION_ARTIFACT_DIGEST_MISMATCH');
      }
    } catch {
      add(blockers, 'NATIVE_CALIBRATION_ARTIFACT_DIGEST_UNVERIFIABLE');
    }
  }

  const sourceDatasetDigests = digestArray(artifact.sourceDatasetDigests);
  if (!sourceDatasetDigests) add(blockers, 'NATIVE_SOURCE_DATASET_LINEAGE_REQUIRED');
  for (const [field, value] of [
    ['NATIVE_V3_SPLIT_INDEX_DIGEST_REQUIRED', artifact.v3IndependentSplitIndexDigest],
    ['NATIVE_SOURCE_INVENTORY_DIGEST_REQUIRED', artifact.sourceInventoryDigest],
    ['NATIVE_INDEPENDENCE_AUDIT_DIGEST_REQUIRED', artifact.independenceAuditDigest],
    ['NATIVE_INDEPENDENT_SPLIT_SOURCE_DIGEST_REQUIRED', artifact.independentSplitSourceDigest],
    ['NATIVE_OOS_VALIDATION_DIGEST_REQUIRED', artifact.oosValidationDigest],
    ['NATIVE_OOS_OUTCOME_DIGEST_REQUIRED', artifact.oosOutcomeDigest],
    ['NATIVE_POLICY_DIGEST_REQUIRED', artifact.policyDigest],
    ['NATIVE_COHORT_DIGEST_REQUIRED', artifact.cohortDigest],
    ['NATIVE_PARAMETER_PAYLOAD_DIGEST_REQUIRED', artifact.parameterPayloadDigest],
    ['NATIVE_FIT_EVIDENCE_DIGEST_REQUIRED', artifact.fitEvidenceDigest],
  ] as const) {
    if (!exactDigest(value)) add(blockers, field);
  }
  if (!text(artifact.calibrationMethodologyVersion)) {
    add(blockers, 'NATIVE_CALIBRATION_METHODOLOGY_VERSION_REQUIRED');
  }
  if (!positiveInteger(artifact.trainObservationCount)
    || !positiveInteger(artifact.validationObservationCount)
    || !positiveInteger(artifact.oosObservationCount)
    || !positiveInteger(artifact.acceptedGenuineOosN)) {
    add(blockers, 'NATIVE_CALIBRATION_SAMPLE_COUNTS_NOT_READY');
  }
  if (artifact.oosOutcomeHorizonMs !== 5000
    || artifact.heldOutOosValidated !== true
    || artifact.contaminationFree !== true
    || artifact.noRetuningAssertion !== true
    || artifact.oosUsedForFit !== false) {
    add(blockers, 'NATIVE_CALIBRATION_OOS_SAFETY_INVALID');
  }
  if (artifact.historicalBackfillCredit !== 0
    || artifact.replayCredit !== 0
    || artifact.backfillCredit !== 0
    || artifact.manualCredit !== 0
    || artifact.syntheticCredit !== 0
    || artifact.testFixtureCredit !== 0) {
    add(blockers, 'NATIVE_CALIBRATION_FORBIDDEN_CREDIT_PRESENT');
  }
  if (artifact.fullCostReady !== false
    || artifact.netAlphaReady !== false
    || artifact.profitabilityProven !== false
    || artifact.currentValidatedChampion !== 'NONE'
    || artifact.executionAuthority !== 'NONE'
    || artifact.privateApiUsed !== false
    || artifact.liveTrading !== false
    || artifact.orderSubmitted !== false) {
    add(blockers, 'NATIVE_CALIBRATION_AUTHORITY_BOUNDARY_INVALID');
  }
  return artifact;
}

function validateCompetingCostEvidence(value: unknown, blockers: string[]): JsonRecord[] | null {
  if (!Array.isArray(value)) {
    add(blockers, 'COMPETING_COST_EVIDENCE_REQUIRED');
    return null;
  }
  const items: JsonRecord[] = [];
  for (const raw of value) {
    const item = record(raw);
    if (!item
      || !text(item.costOwner)
      || !text(item.evidenceIdentity)
      || !exactDigest(item.evidenceDigest)
      || !text(item.sourceIdentity)
      || !exactDigest(item.sourceDigest)
      || !text(item.sourceObservationLineageId)
      || !exactDigest(item.sourceObservationLineageDigest)) {
      add(blockers, 'COMPETING_COST_EVIDENCE_INVALID');
      continue;
    }
    items.push(item);
  }
  for (const owner of REQUIRED_COMPETING_COST_OWNERS) {
    if (!items.some((item) => item.costOwner === owner)) {
      add(blockers, `${owner}_EVIDENCE_REQUIRED`);
    }
  }
  return items;
}

function validateRuntimeMeasurement(
  value: unknown,
  calibrationArtifact: JsonRecord | null,
  expectedProducerCodeSha: string | null,
  nowMs: unknown,
  maximumAgeMs: unknown,
  blockers: string[],
): JsonRecord | null {
  const measurement = record(value);
  if (!measurement) {
    add(blockers, 'RUNTIME_LIQUIDITY_MEASUREMENT_REQUIRED');
    return null;
  }
  if (!text(measurement.measurementIdentity)
    || !exactDigest(measurement.measurementDigest)) {
    add(blockers, 'RUNTIME_LIQUIDITY_MEASUREMENT_IDENTITY_INVALID');
  } else {
    try {
      if (!sameDigest(
        measurement.measurementDigest,
        computeRuntimeLiquidityImpactMeasurementDigest(measurement),
      )) {
        add(blockers, 'RUNTIME_LIQUIDITY_MEASUREMENT_DIGEST_MISMATCH');
      }
    } catch {
      add(blockers, 'RUNTIME_LIQUIDITY_MEASUREMENT_DIGEST_UNVERIFIABLE');
    }
  }
  if (measurement.testOnly !== false) {
    add(blockers, 'TEST_ONLY_MEASUREMENT_RUNTIME_CREDIT_FORBIDDEN');
  }
  if (!exactCommitSha(expectedProducerCodeSha)) {
    add(blockers, 'EXPECTED_PRODUCER_CODE_SHA_REQUIRED');
  }
  if (!positiveFinite(nowMs)) add(blockers, 'RUNTIME_NOW_REQUIRED');
  if (!positiveFinite(maximumAgeMs)) add(blockers, 'RUNTIME_MAXIMUM_AGE_REQUIRED');
  if (!exactCommitSha(measurement.measurementProducerCodeSha)
    || !text(measurement.datasetReceiptIdentity)
    || !exactDigest(measurement.datasetReceiptDigest)) {
    add(blockers, 'RUNTIME_MEASUREMENT_PROVENANCE_REQUIRED');
  }

  if (calibrationArtifact) {
    if (measurement.calibrationArtifactIdentity !== calibrationArtifact.artifactIdentity
      || !sameDigest(measurement.calibrationArtifactDigest, calibrationArtifact.artifactDigest)
      || measurement.sourceContractFamily !== calibrationArtifact.sourceContractFamily
      || !sameDigest(
        measurement.v3IndependentSplitIndexDigest,
        calibrationArtifact.v3IndependentSplitIndexDigest,
      )
      || !sameDigest(measurement.sourceInventoryDigest, calibrationArtifact.sourceInventoryDigest)
      || !sameDigest(measurement.independenceAuditDigest, calibrationArtifact.independenceAuditDigest)
      || !sameDigest(
        measurement.independentSplitSourceDigest,
        calibrationArtifact.independentSplitSourceDigest,
      )
      || !sameDigest(measurement.nativeOosValidationDigest, calibrationArtifact.oosValidationDigest)
      || !sameDigest(measurement.nativeOosOutcomeDigest, calibrationArtifact.oosOutcomeDigest)
      || !sameDigest(measurement.parameterPayloadDigest, calibrationArtifact.parameterPayloadDigest)
      || !sameDigest(measurement.fitEvidenceDigest, calibrationArtifact.fitEvidenceDigest)) {
      add(blockers, 'RUNTIME_MEASUREMENT_NATIVE_CALIBRATION_BINDING_MISMATCH');
    }
    const measurementSources = digestArray(measurement.sourceDatasetDigests);
    const calibrationSources = digestArray(calibrationArtifact.sourceDatasetDigests);
    if (!sameStringArray(measurementSources, calibrationSources)) {
      add(blockers, 'RUNTIME_MEASUREMENT_SOURCE_DATASET_LINEAGE_MISMATCH');
    }
    if (measurement.methodologyVersion !== calibrationArtifact.calibrationMethodologyVersion) {
      add(blockers, 'RUNTIME_MEASUREMENT_METHODOLOGY_MISMATCH');
    }

    const protectedDigests = new Set<string>([
      ...(calibrationSources ?? []),
      calibrationArtifact.v3IndependentSplitIndexDigest,
      calibrationArtifact.sourceInventoryDigest,
      calibrationArtifact.independenceAuditDigest,
      calibrationArtifact.independentSplitSourceDigest,
      calibrationArtifact.oosValidationDigest,
      calibrationArtifact.oosOutcomeDigest,
      calibrationArtifact.parameterPayloadDigest,
      calibrationArtifact.fitEvidenceDigest,
    ].map(exactDigest).filter((item): item is string => item != null));
    for (const rawDigest of [
      measurement.datasetDigest,
      measurement.trainDatasetDigest,
      measurement.validationDatasetDigest,
      measurement.oosDatasetDigest,
    ]) {
      const normalized = exactDigest(rawDigest);
      if (normalized && protectedDigests.has(normalized)) {
        add(blockers, 'NATIVE_SOURCE_DIGEST_AS_MEASUREMENT_DATASET_FORBIDDEN');
      }
    }
  }

  if (!text(measurement.artifactId)
    || !text(measurement.datasetIdentity)
    || !exactDigest(measurement.datasetDigest)
    || !positiveInteger(measurement.sampleN)
    || !text(measurement.trainDatasetIdentity)
    || !exactDigest(measurement.trainDatasetDigest)
    || !positiveInteger(measurement.trainSampleN)
    || !text(measurement.validationDatasetIdentity)
    || !exactDigest(measurement.validationDatasetDigest)
    || !positiveInteger(measurement.validationSampleN)
    || !text(measurement.oosDatasetIdentity)
    || !exactDigest(measurement.oosDatasetDigest)
    || !positiveInteger(measurement.oosSampleN)) {
    add(blockers, 'RUNTIME_MEASUREMENT_DATASET_SPLIT_INVALID');
  } else {
    const identities = [
      measurement.trainDatasetIdentity,
      measurement.validationDatasetIdentity,
      measurement.oosDatasetIdentity,
    ];
    const digests = [
      exactDigest(measurement.trainDatasetDigest),
      exactDigest(measurement.validationDatasetDigest),
      exactDigest(measurement.oosDatasetDigest),
    ];
    if (new Set(identities).size !== 3 || new Set(digests).size !== 3
      || measurement.sampleN !== (measurement.trainSampleN as number)
        + (measurement.validationSampleN as number)
        + (measurement.oosSampleN as number)) {
      add(blockers, 'RUNTIME_MEASUREMENT_DATASET_SPLIT_INVALID');
    }
  }

  const markets = stringArray(measurement.marketScopes);
  const symbols = stringArray(measurement.symbolScopes);
  const sides = stringArray(measurement.sideScopes);
  if (!markets || !symbols || !sides
    || !text(measurement.quantityNotionalBucketIdentity)
    || !text(measurement.volatilityRegimeIdentity)
    || !text(measurement.liquidityRegimeIdentity)) {
    add(blockers, 'RUNTIME_MEASUREMENT_SCOPE_INVALID');
  }
  if (!positiveFinite(measurement.measuredAtMs)
    || !positiveFinite(measurement.maximumAgeMs)) {
    add(blockers, 'RUNTIME_MEASUREMENT_FRESHNESS_INVALID');
  } else {
    if (positiveFinite(nowMs) && measurement.measuredAtMs > nowMs) {
      add(blockers, 'RUNTIME_MEASUREMENT_FROM_FUTURE');
    }
    if (positiveFinite(maximumAgeMs) && measurement.maximumAgeMs > maximumAgeMs) {
      add(blockers, 'RUNTIME_MEASUREMENT_MAXIMUM_AGE_EXCEEDS_POLICY');
    }
    if (positiveFinite(nowMs) && nowMs - measurement.measuredAtMs > measurement.maximumAgeMs) {
      add(blockers, 'RUNTIME_MEASUREMENT_STALE');
    }
  }

  const provenance = record(measurement.provenance);
  if (!provenance
    || provenance.sourceType !== PUBLIC_FORWARD_SOURCE
    || !text(provenance.sourceProvider)
    || !text(provenance.sourceIdentity)
    || !exactDigest(provenance.sourceDigest)
    || provenance.immutable !== true) {
    add(blockers, 'RUNTIME_MEASUREMENT_PROVENANCE_INVALID');
  }
  const lineage = record(measurement.sourceObservationLineage);
  if (!lineage
    || !text(lineage.lineageId)
    || !exactDigest(lineage.lineageDigest)
    || lineage.sourceType !== PUBLIC_FORWARD_SOURCE
    || !text(lineage.sourceIdentity)
    || !positiveInteger(lineage.observationCount)
    || !positiveFinite(lineage.firstObservedAt)
    || !positiveFinite(lineage.lastObservedAt)
    || (positiveFinite(lineage.firstObservedAt)
      && positiveFinite(lineage.lastObservedAt)
      && lineage.firstObservedAt > lineage.lastObservedAt)
    || (positiveFinite(lineage.lastObservedAt)
      && positiveFinite(measurement.measuredAtMs)
      && lineage.lastObservedAt > measurement.measuredAtMs)
    || (positiveInteger(lineage.observationCount)
      && positiveInteger(measurement.sampleN)
      && lineage.observationCount < measurement.sampleN)
    || (provenance && lineage.sourceIdentity !== provenance.sourceIdentity)) {
    add(blockers, 'RUNTIME_MEASUREMENT_OBSERVATION_LINEAGE_INVALID');
  }

  const oos = record(measurement.outOfSampleValidationReference);
  if (!oos
    || !text(oos.referenceId)
    || !exactDigest(oos.referenceDigest)
    || oos.trainDatasetIdentity !== measurement.trainDatasetIdentity
    || !sameDigest(oos.trainDatasetDigest, measurement.trainDatasetDigest)
    || oos.validationDatasetIdentity !== measurement.validationDatasetIdentity
    || !sameDigest(oos.validationDatasetDigest, measurement.validationDatasetDigest)
    || oos.oosDatasetIdentity !== measurement.oosDatasetIdentity
    || !sameDigest(oos.oosDatasetDigest, measurement.oosDatasetDigest)
    || !positiveInteger(oos.sampleN)
    || oos.sampleN !== measurement.oosSampleN
    || oos.status !== 'PASS'
    || oos.heldOut !== true
    || oos.contaminationFree !== true
    || !positiveFinite(oos.evaluatedAt)
    || (positiveFinite(oos.evaluatedAt)
      && positiveFinite(measurement.measuredAtMs)
      && oos.evaluatedAt > measurement.measuredAtMs)) {
    add(blockers, 'RUNTIME_MEASUREMENT_OOS_VALIDATION_INVALID');
  }

  if (!nonNegativeFinite(measurement.estimatedImpactPercent)
    || !nonNegativeFinite(measurement.estimatedImpactBps)
    || (nonNegativeFinite(measurement.estimatedImpactPercent)
      && nonNegativeFinite(measurement.estimatedImpactBps)
      && Math.abs(measurement.estimatedImpactPercent * 100 - measurement.estimatedImpactBps) > 1e-9)) {
    add(blockers, 'RUNTIME_MEASUREMENT_IMPACT_VALUE_INVALID');
  }
  if (measurement.estimatedImpactPercent === 0 && measurement.estimatedImpactBps === 0) {
    const zero = record(measurement.zeroEvidenceReference);
    if (!text(measurement.zeroEvidenceReason)
      || !zero
      || !text(zero.referenceId)
      || !exactDigest(zero.referenceDigest)
      || zero.result !== 'MEASURED_ZERO_COMPATIBLE'
      || zero.sourceObservationLineageId !== lineage?.lineageId
      || zero.outOfSampleValidationReferenceId !== oos?.referenceId) {
      add(blockers, 'MEASURED_ZERO_EVIDENCE_REQUIRED');
    }
  } else if (measurement.zeroEvidenceReason != null || measurement.zeroEvidenceReference != null) {
    add(blockers, 'ZERO_EVIDENCE_ONLY_ALLOWED_FOR_EXACT_ZERO');
  }

  const ownership = record(measurement.costOwnership);
  const excludedOwners = stringArray(ownership?.excludedCostOwners);
  if (!ownership
    || ownership.owner !== LIQUIDITY_OWNER
    || !text(ownership.sourceIdentity)
    || !exactDigest(ownership.sourceDigest)
    || !excludedOwners
    || REQUIRED_EXCLUDED_COST_OWNERS.some((owner) => !excludedOwners.includes(owner))) {
    add(blockers, 'RUNTIME_MEASUREMENT_COST_OWNERSHIP_INVALID');
  }
  const independence = record(measurement.independenceEvidence);
  if (!independence
    || independence.status !== 'VERIFIED'
    || independence.targetVariable !== RESIDUAL_TARGET
    || independence.bookWalkExcluded !== true
    || independence.latencyAdverseMoveExcluded !== true
    || independence.partialFillExcluded !== true
    || independence.spreadExcluded !== true
    || independence.implementationShortfallDecomposed !== true
    || independence.fullImplementationShortfallUsed !== false
    || independence.sharedObservationLineageAllowed !== false
    || independence.validationReferenceId !== oos?.referenceId) {
    add(blockers, 'RUNTIME_MEASUREMENT_INDEPENDENCE_INVALID');
  }

  const competing = validateCompetingCostEvidence(measurement.competingCostEvidence, blockers);
  if (competing && ownership && provenance && lineage) {
    for (const item of competing) {
      if (item.evidenceIdentity === measurement.artifactId
        || sameDigest(item.evidenceDigest, measurement.datasetDigest)
        || item.sourceIdentity === ownership.sourceIdentity
        || item.sourceIdentity === provenance.sourceIdentity
        || sameDigest(item.sourceDigest, ownership.sourceDigest)
        || sameDigest(item.sourceDigest, provenance.sourceDigest)
        || sameDigest(item.sourceDigest, measurement.datasetDigest)
        || item.sourceObservationLineageId === lineage.lineageId
        || sameDigest(item.sourceObservationLineageDigest, lineage.lineageDigest)) {
        add(blockers, 'COMPETING_COST_LINEAGE_REUSE_FORBIDDEN');
      }
    }
  }
  return measurement;
}

function blocked(blockers: string[]) {
  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_VERSION,
    status: 'BLOCKED_DATA' as const,
    producerStatus: 'BLOCKED_DATA' as const,
    liquidityImpactStatus: 'BLOCKED_DATA' as const,
    firewallValidationRequired: true,
    firewallArtifact: null,
    nativeCalibrationBinding: null,
    runtimeMeasurementBinding: null,
    runtimeEligible: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    evidenceComplete: 0,
    fullCostReady: false,
    netAlphaReady: false,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE' as const,
    executionAuthority: 'NONE' as const,
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    blockers: Object.freeze([...new Set(blockers)]),
    safety: AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_SAFETY,
  });
}

export function produceAuthoritativePaperLiquidityImpactCostEvidence(
  input: AuthoritativePaperLiquidityImpactCostEvidenceInput = {},
) {
  const blockers: string[] = [];
  const producerCodeSha = exactCommitSha(input.expectedProducerCodeSha);
  const calibrationArtifact = validateCalibrationAdmission(input.calibrationAdmission, blockers);
  const measurement = validateRuntimeMeasurement(
    input.runtimeMeasurement,
    calibrationArtifact,
    producerCodeSha,
    input.nowMs,
    input.maximumAgeMs,
    blockers,
  );
  if (blockers.length > 0 || !calibrationArtifact || !measurement || !producerCodeSha) {
    return blocked(blockers);
  }

  const firewallBody = {
    schema: LIQUIDITY_IMPACT_FIREWALL_SCHEMA,
    version: LIQUIDITY_IMPACT_FIREWALL_VERSION,
    evidenceClass: 'CALIBRATION_ARTIFACT',
    testOnly: false,
    artifactId: measurement.artifactId,
    methodologyVersion: measurement.methodologyVersion,
    producerCodeSha,
    calibrationCodeSha: calibrationArtifact.artifactProducerCodeSha,
    datasetIdentity: measurement.datasetIdentity,
    datasetDigest: measurement.datasetDigest,
    sampleN: measurement.sampleN,
    trainDatasetIdentity: measurement.trainDatasetIdentity,
    trainDatasetDigest: measurement.trainDatasetDigest,
    trainSampleN: measurement.trainSampleN,
    validationDatasetIdentity: measurement.validationDatasetIdentity,
    validationDatasetDigest: measurement.validationDatasetDigest,
    validationSampleN: measurement.validationSampleN,
    oosDatasetIdentity: measurement.oosDatasetIdentity,
    oosDatasetDigest: measurement.oosDatasetDigest,
    oosSampleN: measurement.oosSampleN,
    marketScopes: canonicalize(measurement.marketScopes),
    symbolScopes: canonicalize(measurement.symbolScopes),
    sideScopes: canonicalize(measurement.sideScopes),
    quantityNotionalBucketIdentity: measurement.quantityNotionalBucketIdentity,
    volatilityRegimeIdentity: measurement.volatilityRegimeIdentity,
    liquidityRegimeIdentity: measurement.liquidityRegimeIdentity,
    calibratedAt: measurement.measuredAtMs,
    maximumAge: measurement.maximumAgeMs,
    provenance: canonicalize(measurement.provenance),
    sourceObservationLineage: canonicalize(measurement.sourceObservationLineage),
    outOfSampleValidationReference: canonicalize(measurement.outOfSampleValidationReference),
    estimatedImpactPercent: measurement.estimatedImpactPercent,
    estimatedImpactBps: measurement.estimatedImpactBps,
    zeroEvidenceReason: measurement.zeroEvidenceReason ?? null,
    zeroEvidenceReference: measurement.zeroEvidenceReference ?? null,
    costOwnership: canonicalize(measurement.costOwnership),
    independenceEvidence: canonicalize(measurement.independenceEvidence),
  };
  const firewallArtifact = Object.freeze({
    ...firewallBody,
    artifactDigest: computeLiquidityImpactFirewallArtifactDigest(firewallBody),
  });

  const nativeCalibrationBinding = Object.freeze({
    sourceContractFamily: calibrationArtifact.sourceContractFamily,
    calibrationArtifactIdentity: calibrationArtifact.artifactIdentity,
    calibrationArtifactDigest: calibrationArtifact.artifactDigest,
    v3IndependentSplitIndexDigest: calibrationArtifact.v3IndependentSplitIndexDigest,
    sourceInventoryDigest: calibrationArtifact.sourceInventoryDigest,
    sourceDatasetDigests: Object.freeze([...(digestArray(calibrationArtifact.sourceDatasetDigests) ?? [])]),
    independenceAuditDigest: calibrationArtifact.independenceAuditDigest,
    independentSplitSourceDigest: calibrationArtifact.independentSplitSourceDigest,
    nativeOosValidationDigest: calibrationArtifact.oosValidationDigest,
    nativeOosOutcomeDigest: calibrationArtifact.oosOutcomeDigest,
    policyDigest: calibrationArtifact.policyDigest,
    cohortDigest: calibrationArtifact.cohortDigest,
    parameterPayloadDigest: calibrationArtifact.parameterPayloadDigest,
    fitEvidenceDigest: calibrationArtifact.fitEvidenceDigest,
    trainObservationCount: calibrationArtifact.trainObservationCount,
    validationObservationCount: calibrationArtifact.validationObservationCount,
    oosObservationCount: calibrationArtifact.oosObservationCount,
    acceptedGenuineOosN: calibrationArtifact.acceptedGenuineOosN,
    heldOutOosValidated: true,
    contaminationFree: true,
    oosUsedForFit: false,
    noRetuningAssertion: true,
  });
  const runtimeMeasurementBinding = Object.freeze({
    measurementIdentity: measurement.measurementIdentity,
    measurementDigest: measurement.measurementDigest,
    measurementProducerCodeSha: measurement.measurementProducerCodeSha,
    datasetReceiptIdentity: measurement.datasetReceiptIdentity,
    datasetReceiptDigest: measurement.datasetReceiptDigest,
    residualDatasetIdentity: measurement.datasetIdentity,
    residualDatasetDigest: measurement.datasetDigest,
    residualOosValidationReferenceDigest:
      record(measurement.outOfSampleValidationReference)?.referenceDigest ?? null,
    competingCostEvidence: canonicalize(measurement.competingCostEvidence),
  });

  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_VERSION,
    status: 'PRESENT' as const,
    producerStatus: 'PRESENT' as const,
    liquidityImpactStatus: 'BLOCKED_DATA' as const,
    firewallValidationRequired: true,
    firewallArtifact,
    nativeCalibrationBinding,
    runtimeMeasurementBinding,
    runtimeEligible: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    evidenceComplete: 0,
    fullCostReady: false,
    netAlphaReady: false,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE' as const,
    executionAuthority: 'NONE' as const,
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    blockers: Object.freeze([]),
    safety: AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_SAFETY,
  });
}

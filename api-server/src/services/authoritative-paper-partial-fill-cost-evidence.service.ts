import { createHash } from 'node:crypto';
import type { PercentCostEvidence } from './scanner-profit-cost-evidence-adapter.service';

export const AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION =
  'authoritative-paper-partial-fill-cost-evidence-v1' as const;
export const AUTHORITATIVE_PAPER_PARTIAL_FILL_CALIBRATION_VERSION =
  'authoritative-paper-partial-fill-calibration-v1' as const;

export type PartialFillCostOwner =
  | 'SPREAD'
  | 'VISIBLE_L2_BOOK_WALK_SLIPPAGE'
  | 'LATENCY_ADVERSE_MOVE'
  | 'INDEPENDENT_LIQUIDITY_IMPACT'
  | 'PARTIAL_FILL';

export type CompetingCostEvidenceIdentity = Readonly<{
  costOwner: Exclude<PartialFillCostOwner, 'PARTIAL_FILL'>;
  evidenceIdentity: string;
  evidenceDigest: string;
  sourceIdentity: string;
  sourceDigest: string;
  sourceObservationLineageId: string;
  sourceObservationLineageDigest: string;
}>;

export type PartialFillCalibrationArtifact = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_PARTIAL_FILL_CALIBRATION_VERSION;
  evidenceClass: 'CALIBRATION_ARTIFACT' | 'TEST_FIXTURE';
  testOnly: boolean;
  artifactId: string;
  artifactDigest: string;
  methodologyVersion: string;
  producerCodeSha: string;
  calibrationCodeSha: string;
  datasetIdentity: string;
  datasetDigest: string;
  sampleN: number;
  trainDatasetIdentity: string;
  trainDatasetDigest: string;
  trainSampleN: number;
  validationDatasetIdentity: string;
  validationDatasetDigest: string;
  validationSampleN: number;
  oosDatasetIdentity: string;
  oosDatasetDigest: string;
  oosSampleN: number;
  marketScopes: readonly string[];
  symbolScopes: readonly string[];
  sideScopes: readonly string[];
  quantityNotionalBucketIdentity: string;
  volatilityRegimeIdentity: string;
  liquidityRegimeIdentity: string;
  calibratedAtMs: number;
  maximumAgeMs: number;
  provenance: Readonly<{
    sourceType: 'PUBLIC_FORWARD_SIMULATION';
    sourceProvider: string;
    sourceIdentity: string;
    sourceDigest: string;
    immutable: boolean;
  }>;
  sourceObservationLineage: Readonly<{
    lineageId: string;
    lineageDigest: string;
    sourceType: 'PUBLIC_FORWARD_SIMULATION';
    sourceIdentity: string;
    observationCount: number;
    firstObservedAtMs: number;
    lastObservedAtMs: number;
  }>;
  outOfSampleValidationReference: Readonly<{
    referenceId: string;
    referenceDigest: string;
    trainDatasetIdentity: string;
    trainDatasetDigest: string;
    validationDatasetIdentity: string;
    validationDatasetDigest: string;
    oosDatasetIdentity: string;
    oosDatasetDigest: string;
    sampleN: number;
    status: 'PASS';
    heldOut: boolean;
    contaminationFree: boolean;
    evaluatedAtMs: number;
  }>;
  estimatedPartialFillImpactPercent: number;
  estimatedPartialFillImpactBps: number;
  zeroEvidenceReason: string | null;
  zeroEvidenceReference: Readonly<{
    referenceId: string;
    referenceDigest: string;
    result: 'MEASURED_ZERO_COMPATIBLE';
    sourceObservationLineageId: string;
    outOfSampleValidationReferenceId: string;
  }> | null;
  costOwnership: Readonly<{
    owner: 'PARTIAL_FILL';
    sourceIdentity: string;
    sourceDigest: string;
  }>;
  independenceEvidence: Readonly<{
    status: 'VERIFIED';
    targetVariable: 'PARTIAL_FILL_INCREMENTAL_COST_EXCLUDING_SPREAD_BOOK_WALK_LATENCY_AND_LIQUIDITY_IMPACT';
    spreadExcluded: boolean;
    bookWalkExcluded: boolean;
    latencyAdverseMoveExcluded: boolean;
    liquidityImpactExcluded: boolean;
    fullImplementationShortfallUsed: boolean;
    sharedObservationLineageAllowed: boolean;
    validationReferenceId: string;
  }>;
}>;

export type PartialFillCalibrationContext = Readonly<{
  market: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantityNotionalBucketIdentity: string;
  volatilityRegimeIdentity: string;
  liquidityRegimeIdentity: string;
  producerCodeSha: string;
  calibrationCodeSha: string;
  nowMs: number;
  maximumAgeMs: number;
  competingCostEvidence: readonly CompetingCostEvidenceIdentity[];
}>;

export type AuthoritativePaperPartialFillCostEvidenceResult = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION;
  status: 'PRESENT' | 'BLOCKED_DATA';
  evidence: PercentCostEvidence | null;
  artifactId: string | null;
  artifactDigest: string | null;
  sampleN: number | null;
  oosSampleN: number | null;
  blockers: readonly string[];
  executionAuthority: 'NONE';
  privateApiUsed: false;
  liveTrading: false;
  realFillObserved: false;
  publicDepthIsRealFillProof: false;
  unknownCostIsZero: false;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const FORBIDDEN_SOURCE = /(?:VISIBLE[_ -]?L2[_ -]?BOOK[_ -]?WALK|BOOK[_ -]?WALK|SLIPPAGE|LATENCY[_ -]?ADVERSE[_ -]?MOVE|INDEPENDENT[_ -]?LIQUIDITY[_ -]?IMPACT|IMPLEMENTATION[_ -]?SHORTFALL|SPREAD(?:[_ -]?(?:ONLY|EVIDENCE|OUTPUT))?)/iu;
const REQUIRED_COMPETING_OWNERS = Object.freeze([
  'SPREAD',
  'VISIBLE_L2_BOOK_WALK_SLIPPAGE',
  'LATENCY_ADVERSE_MOVE',
  'INDEPENDENT_LIQUIDITY_IMPACT',
] as const);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function digest(value: unknown): string | null {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && SHA256.test(normalized) ? normalized : null;
}

function commitSha(value: unknown): string | null {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && COMMIT_SHA.test(normalized) ? normalized : null;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function scopeIncludes(scopes: unknown, expected: unknown): boolean {
  const normalizedExpected = text(expected)?.toUpperCase() ?? null;
  if (!normalizedExpected || !Array.isArray(scopes) || scopes.length === 0) return false;
  const normalized = scopes.map((item) => text(item)?.toUpperCase() ?? null);
  return normalized.every((item) => item != null && item !== '*')
    && new Set(normalized).size === normalized.length
    && normalized.includes(normalizedExpected);
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

export function computeAuthoritativePaperPartialFillCalibrationDigest(
  artifact: Omit<PartialFillCalibrationArtifact, 'artifactDigest'> | PartialFillCalibrationArtifact,
): string {
  const object = record(artifact);
  if (!object) throw new TypeError('PARTIAL_FILL_CALIBRATION_ARTIFACT_REQUIRED');
  const payload = Object.fromEntries(
    Object.entries(object).filter(([key]) => key !== 'artifactDigest'),
  );
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

function sameText(left: unknown, right: unknown): boolean {
  const lhs = text(left);
  return lhs != null && lhs === text(right);
}

function sameDigest(left: unknown, right: unknown): boolean {
  const lhs = digest(left);
  return lhs != null && lhs === digest(right);
}

function blocked(
  blockers: readonly string[],
  artifact: PartialFillCalibrationArtifact | null = null,
): AuthoritativePaperPartialFillCostEvidenceResult {
  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION,
    status: 'BLOCKED_DATA' as const,
    evidence: null,
    artifactId: text(artifact?.artifactId),
    artifactDigest: digest(artifact?.artifactDigest),
    sampleN: positiveInteger(artifact?.sampleN) ? artifact.sampleN : null,
    oosSampleN: positiveInteger(artifact?.oosSampleN) ? artifact.oosSampleN : null,
    blockers: Object.freeze([...new Set(blockers)]),
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    realFillObserved: false as const,
    publicDepthIsRealFillProof: false as const,
    unknownCostIsZero: false as const,
  });
}

export function buildAuthoritativePaperPartialFillCostEvidence(input: Readonly<{
  artifact?: PartialFillCalibrationArtifact | null;
  expected: PartialFillCalibrationContext;
}>): AuthoritativePaperPartialFillCostEvidenceResult {
  const artifact = input?.artifact ?? null;
  const expected = input?.expected;
  const blockers: string[] = [];
  const add = (code: string) => {
    if (!blockers.includes(code)) blockers.push(code);
  };

  if (!artifact) return blocked(['PARTIAL_FILL_CALIBRATION_ARTIFACT_REQUIRED']);
  if (artifact.schemaVersion !== AUTHORITATIVE_PAPER_PARTIAL_FILL_CALIBRATION_VERSION) add('PARTIAL_FILL_CALIBRATION_SCHEMA_INVALID');
  if (!['CALIBRATION_ARTIFACT', 'TEST_FIXTURE'].includes(artifact.evidenceClass)) add('PARTIAL_FILL_EVIDENCE_CLASS_INVALID');
  if (typeof artifact.testOnly !== 'boolean'
    || (artifact.evidenceClass === 'TEST_FIXTURE') !== artifact.testOnly) add('PARTIAL_FILL_TEST_ONLY_CLASSIFICATION_INVALID');
  if (artifact.testOnly || artifact.evidenceClass === 'TEST_FIXTURE') add('PARTIAL_FILL_TEST_FIXTURE_RUNTIME_CREDIT_FORBIDDEN');
  if (!text(artifact.artifactId)) add('PARTIAL_FILL_ARTIFACT_ID_REQUIRED');
  if (!digest(artifact.artifactDigest)) add('PARTIAL_FILL_ARTIFACT_DIGEST_INVALID');
  try {
    if (!sameDigest(artifact.artifactDigest, computeAuthoritativePaperPartialFillCalibrationDigest(artifact))) {
      add('PARTIAL_FILL_ARTIFACT_DIGEST_MISMATCH');
    }
  } catch {
    add('PARTIAL_FILL_ARTIFACT_DIGEST_UNVERIFIABLE');
  }
  if (!text(artifact.methodologyVersion) || FORBIDDEN_SOURCE.test(artifact.methodologyVersion)) add('PARTIAL_FILL_METHODOLOGY_INVALID_OR_REUSED');

  const producerSha = commitSha(artifact.producerCodeSha);
  const calibrationSha = commitSha(artifact.calibrationCodeSha);
  if (!producerSha || producerSha !== commitSha(expected?.producerCodeSha)) add('PARTIAL_FILL_PRODUCER_CODE_SHA_MISMATCH');
  if (!calibrationSha || calibrationSha !== commitSha(expected?.calibrationCodeSha)) add('PARTIAL_FILL_CALIBRATION_CODE_SHA_MISMATCH');

  if (!text(artifact.datasetIdentity) || !digest(artifact.datasetDigest) || !positiveInteger(artifact.sampleN)) {
    add('PARTIAL_FILL_DATASET_IDENTITY_INVALID');
  }
  const splitIdentities = [artifact.trainDatasetIdentity, artifact.validationDatasetIdentity, artifact.oosDatasetIdentity].map(text);
  const splitDigests = [artifact.trainDatasetDigest, artifact.validationDatasetDigest, artifact.oosDatasetDigest].map(digest);
  if (splitIdentities.some((item) => item == null) || new Set(splitIdentities).size !== 3
    || splitDigests.some((item) => item == null) || new Set(splitDigests).size !== 3
    || !positiveInteger(artifact.trainSampleN) || !positiveInteger(artifact.validationSampleN)
    || !positiveInteger(artifact.oosSampleN)
    || !positiveInteger(artifact.sampleN)
    || artifact.sampleN !== artifact.trainSampleN + artifact.validationSampleN + artifact.oosSampleN) {
    add('PARTIAL_FILL_SAMPLE_SPLIT_INVALID');
  }

  if (!scopeIncludes(artifact.marketScopes, expected?.market)) add('PARTIAL_FILL_MARKET_SCOPE_MISMATCH');
  if (!scopeIncludes(artifact.symbolScopes, expected?.symbol)) add('PARTIAL_FILL_SYMBOL_SCOPE_MISMATCH');
  if (!scopeIncludes(artifact.sideScopes, expected?.side)) add('PARTIAL_FILL_SIDE_SCOPE_MISMATCH');
  if (!sameText(artifact.quantityNotionalBucketIdentity, expected?.quantityNotionalBucketIdentity)) add('PARTIAL_FILL_QUANTITY_NOTIONAL_BUCKET_MISMATCH');
  if (!sameText(artifact.volatilityRegimeIdentity, expected?.volatilityRegimeIdentity)) add('PARTIAL_FILL_VOLATILITY_REGIME_MISMATCH');
  if (!sameText(artifact.liquidityRegimeIdentity, expected?.liquidityRegimeIdentity)) add('PARTIAL_FILL_LIQUIDITY_REGIME_MISMATCH');

  if (!positive(expected?.nowMs) || !positive(expected?.maximumAgeMs)) add('PARTIAL_FILL_VALIDATION_CLOCK_INVALID');
  if (!positive(artifact.calibratedAtMs) || !positive(artifact.maximumAgeMs)) add('PARTIAL_FILL_CALIBRATION_TIME_INVALID');
  if (positive(artifact.maximumAgeMs) && positive(expected?.maximumAgeMs)
    && artifact.maximumAgeMs > expected.maximumAgeMs) add('PARTIAL_FILL_MAXIMUM_AGE_EXCEEDS_POLICY');
  if (positive(artifact.calibratedAtMs) && positive(expected?.nowMs)) {
    if (artifact.calibratedAtMs > expected.nowMs) add('PARTIAL_FILL_CALIBRATION_FROM_FUTURE');
    else if (positive(artifact.maximumAgeMs) && expected.nowMs - artifact.calibratedAtMs > artifact.maximumAgeMs) {
      add('PARTIAL_FILL_CALIBRATION_STALE');
    }
  }

  const provenance = artifact.provenance;
  if (provenance?.sourceType !== 'PUBLIC_FORWARD_SIMULATION'
    || !text(provenance?.sourceProvider) || !text(provenance?.sourceIdentity)
    || !digest(provenance?.sourceDigest) || provenance?.immutable !== true
    || FORBIDDEN_SOURCE.test(String(provenance?.sourceIdentity ?? ''))) {
    add('PARTIAL_FILL_PROVENANCE_INVALID_OR_REUSED');
  }

  const lineage = artifact.sourceObservationLineage;
  if (lineage?.sourceType !== 'PUBLIC_FORWARD_SIMULATION'
    || !text(lineage?.lineageId) || !digest(lineage?.lineageDigest)
    || !text(lineage?.sourceIdentity) || FORBIDDEN_SOURCE.test(String(lineage?.sourceIdentity ?? ''))
    || !positiveInteger(lineage?.observationCount) || !positive(lineage?.firstObservedAtMs)
    || !positive(lineage?.lastObservedAtMs) || lineage.firstObservedAtMs > lineage.lastObservedAtMs
    || lineage.lastObservedAtMs > artifact.calibratedAtMs
    || lineage.observationCount < artifact.sampleN
    || lineage.sourceIdentity !== provenance?.sourceIdentity) {
    add('PARTIAL_FILL_SOURCE_OBSERVATION_LINEAGE_INVALID_OR_REUSED');
  }

  const oos = artifact.outOfSampleValidationReference;
  if (!text(oos?.referenceId) || !digest(oos?.referenceDigest)
    || oos?.trainDatasetIdentity !== artifact.trainDatasetIdentity
    || !sameDigest(oos?.trainDatasetDigest, artifact.trainDatasetDigest)
    || oos?.validationDatasetIdentity !== artifact.validationDatasetIdentity
    || !sameDigest(oos?.validationDatasetDigest, artifact.validationDatasetDigest)
    || oos?.oosDatasetIdentity !== artifact.oosDatasetIdentity
    || !sameDigest(oos?.oosDatasetDigest, artifact.oosDatasetDigest)
    || oos?.sampleN !== artifact.oosSampleN || oos?.status !== 'PASS'
    || oos?.heldOut !== true || oos?.contaminationFree !== true
    || !positive(oos?.evaluatedAtMs) || oos.evaluatedAtMs > artifact.calibratedAtMs) {
    add('PARTIAL_FILL_OOS_VALIDATION_REFERENCE_INVALID');
  }

  if (!nonNegative(artifact.estimatedPartialFillImpactPercent)
    || !nonNegative(artifact.estimatedPartialFillImpactBps)
    || Math.abs(artifact.estimatedPartialFillImpactPercent * 100 - artifact.estimatedPartialFillImpactBps) > 1e-9) {
    add('PARTIAL_FILL_COST_VALUE_INVALID');
  }
  if (artifact.estimatedPartialFillImpactPercent === 0 && artifact.estimatedPartialFillImpactBps === 0) {
    const zero = artifact.zeroEvidenceReference;
    if (!text(artifact.zeroEvidenceReason) || !zero || !text(zero.referenceId)
      || !digest(zero.referenceDigest) || zero.result !== 'MEASURED_ZERO_COMPATIBLE'
      || !sameText(zero.sourceObservationLineageId, lineage?.lineageId)
      || !sameText(zero.outOfSampleValidationReferenceId, oos?.referenceId)) {
      add('PARTIAL_FILL_MEASURED_ZERO_EVIDENCE_REQUIRED');
    }
  } else if (artifact.zeroEvidenceReason != null || artifact.zeroEvidenceReference != null) {
    add('PARTIAL_FILL_ZERO_EVIDENCE_ONLY_ALLOWED_FOR_EXACT_ZERO');
  }

  const ownership = artifact.costOwnership;
  if (ownership?.owner !== 'PARTIAL_FILL' || !text(ownership?.sourceIdentity)
    || !digest(ownership?.sourceDigest) || FORBIDDEN_SOURCE.test(String(ownership?.sourceIdentity ?? ''))) {
    add('PARTIAL_FILL_COST_OWNERSHIP_INVALID');
  }
  const independence = artifact.independenceEvidence;
  if (independence?.status !== 'VERIFIED'
    || independence?.targetVariable !== 'PARTIAL_FILL_INCREMENTAL_COST_EXCLUDING_SPREAD_BOOK_WALK_LATENCY_AND_LIQUIDITY_IMPACT'
    || independence?.spreadExcluded !== true || independence?.bookWalkExcluded !== true
    || independence?.latencyAdverseMoveExcluded !== true || independence?.liquidityImpactExcluded !== true
    || independence?.fullImplementationShortfallUsed !== false
    || independence?.sharedObservationLineageAllowed !== false
    || !sameText(independence?.validationReferenceId, oos?.referenceId)) {
    add('PARTIAL_FILL_INDEPENDENCE_EVIDENCE_INVALID');
  }

  const competing = Array.isArray(expected?.competingCostEvidence) ? expected.competingCostEvidence : [];
  for (const owner of REQUIRED_COMPETING_OWNERS) {
    if (!competing.some((item) => item?.costOwner === owner)) add(`PARTIAL_FILL_COMPETING_${owner}_EVIDENCE_REQUIRED`);
  }
  for (const item of competing) {
    if (!REQUIRED_COMPETING_OWNERS.includes(item?.costOwner as typeof REQUIRED_COMPETING_OWNERS[number])
      || !text(item?.evidenceIdentity) || !digest(item?.evidenceDigest)
      || !text(item?.sourceIdentity) || !digest(item?.sourceDigest)
      || !text(item?.sourceObservationLineageId) || !digest(item?.sourceObservationLineageDigest)) {
      add('PARTIAL_FILL_COMPETING_COST_EVIDENCE_INVALID');
      continue;
    }
    if (sameText(artifact.artifactId, item.evidenceIdentity)) add('PARTIAL_FILL_COST_EVIDENCE_IDENTITY_REUSED');
    if (sameDigest(artifact.artifactDigest, item.evidenceDigest)) add('PARTIAL_FILL_COST_EVIDENCE_DIGEST_REUSED');
    if (sameText(provenance?.sourceIdentity, item.sourceIdentity)
      || sameText(ownership?.sourceIdentity, item.sourceIdentity)) add('PARTIAL_FILL_COST_SOURCE_IDENTITY_REUSED');
    if (sameDigest(provenance?.sourceDigest, item.sourceDigest)
      || sameDigest(ownership?.sourceDigest, item.sourceDigest)
      || sameDigest(artifact.datasetDigest, item.sourceDigest)) add('PARTIAL_FILL_COST_SOURCE_DIGEST_REUSED');
    if (sameText(lineage?.lineageId, item.sourceObservationLineageId)
      || sameDigest(lineage?.lineageDigest, item.sourceObservationLineageDigest)) {
      add('PARTIAL_FILL_SOURCE_OBSERVATION_LINEAGE_REUSED');
    }
  }

  if (blockers.length > 0) return blocked(blockers, artifact);

  const evidence: PercentCostEvidence = Object.freeze({
    valuePercent: artifact.estimatedPartialFillImpactPercent,
    quality: 'ESTIMATED',
    source: `INDEPENDENT_PARTIAL_FILL_CALIBRATION:${artifact.artifactId.trim()}:${artifact.methodologyVersion.trim()}`,
    observedAtMs: artifact.calibratedAtMs,
  });
  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION,
    status: 'PRESENT' as const,
    evidence,
    artifactId: artifact.artifactId.trim(),
    artifactDigest: artifact.artifactDigest.toLowerCase(),
    sampleN: artifact.sampleN,
    oosSampleN: artifact.oosSampleN,
    blockers: Object.freeze([]),
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    realFillObserved: false as const,
    publicDepthIsRealFillProof: false as const,
    unknownCostIsZero: false as const,
  });
}

export const AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY = Object.freeze({
  schemaVersion: AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION,
  publicForwardCalibrationOnly: true,
  directPublicL2SnapshotMayProducePartialFillCost: false,
  bookWalkSlippageReusedAsPartialFillCost: false,
  latencyAdverseMoveReusedAsPartialFillCost: false,
  liquidityImpactReusedAsPartialFillCost: false,
  spreadReusedAsPartialFillCost: false,
  implementationShortfallReusedAsPartialFillCost: false,
  sharedObservationLineageAllowed: false,
  testFixtureRuntimeCredit: 0,
  missingDataMayProduceZeroCost: false,
  measuredZeroRequiresIndependentEvidence: true,
  publicDepthIsRealFillProof: false,
  realFillObserved: false,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
  financialMutationAllowed: false,
});

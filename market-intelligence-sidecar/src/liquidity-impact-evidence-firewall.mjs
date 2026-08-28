import { createHash } from 'node:crypto';

export const LIQUIDITY_IMPACT_EVIDENCE_SCHEMA =
  'independent-liquidity-impact-calibration-evidence';
export const LIQUIDITY_IMPACT_EVIDENCE_VERSION = 1;

export const LIQUIDITY_IMPACT_COST_OWNERS = Object.freeze({
  BOOK_WALK: 'VISIBLE_L2_BOOK_WALK_SLIPPAGE',
  LATENCY: 'LATENCY_ADVERSE_MOVE',
  PARTIAL_FILL: 'PARTIAL_FILL',
  SPREAD: 'SPREAD',
  LIQUIDITY: 'INDEPENDENT_LIQUIDITY_IMPACT',
});

const PUBLIC_HISTORICAL_SOURCE = 'PUBLIC_HISTORICAL_MARKET_DATA';
const RESIDUAL_TARGET =
  'RESIDUAL_PRICE_IMPACT_AFTER_SPREAD_VISIBLE_BOOK_WALK_LATENCY_AND_PARTIAL_FILL';
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const FORBIDDEN_SOURCE = /(?:VISIBLE[_ -]?L2[_ -]?BOOK[_ -]?WALK|BOOK[_ -]?WALK|IMPLEMENTATION[_ -]?SHORTFALL|LATENCY[_ -]?ADVERSE[_ -]?MOVE|(?:SPREAD|SLIPPAGE|PARTIAL[_ -]?FILL)(?:[_ -]?(?:ONLY|EVIDENCE|OUTPUT)))/iu;
const REQUIRED_EXCLUDED_OWNERS = Object.freeze([
  LIQUIDITY_IMPACT_COST_OWNERS.BOOK_WALK,
  LIQUIDITY_IMPACT_COST_OWNERS.LATENCY,
  LIQUIDITY_IMPACT_COST_OWNERS.PARTIAL_FILL,
  LIQUIDITY_IMPACT_COST_OWNERS.SPREAD,
]);
const REQUIRED_COMPETING_EVIDENCE_OWNERS = Object.freeze([
  LIQUIDITY_IMPACT_COST_OWNERS.BOOK_WALK,
  LIQUIDITY_IMPACT_COST_OWNERS.LATENCY,
  LIQUIDITY_IMPACT_COST_OWNERS.SPREAD,
]);

export const LIQUIDITY_IMPACT_EVIDENCE_JSON_SCHEMA = deepFreeze({
  $id: `${LIQUIDITY_IMPACT_EVIDENCE_SCHEMA}/v${LIQUIDITY_IMPACT_EVIDENCE_VERSION}`,
  type: 'object',
  additionalProperties: false,
  properties: {
    schema: { const: LIQUIDITY_IMPACT_EVIDENCE_SCHEMA },
    version: { const: LIQUIDITY_IMPACT_EVIDENCE_VERSION },
    evidenceClass: { enum: ['CALIBRATION_ARTIFACT', 'TEST_FIXTURE'] },
    testOnly: { type: 'boolean' },
    artifactId: { type: 'string', minLength: 1 },
    artifactDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    methodologyVersion: { type: 'string', minLength: 1 },
    producerCodeSha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
    calibrationCodeSha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
    datasetIdentity: { type: 'string', minLength: 1 },
    datasetDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    sampleN: { type: 'integer', minimum: 1 },
    trainDatasetIdentity: { type: 'string', minLength: 1 },
    trainDatasetDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    trainSampleN: { type: 'integer', minimum: 1 },
    validationDatasetIdentity: { type: 'string', minLength: 1 },
    validationDatasetDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    validationSampleN: { type: 'integer', minimum: 1 },
    oosDatasetIdentity: { type: 'string', minLength: 1 },
    oosDatasetDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    oosSampleN: { type: 'integer', minimum: 1 },
    marketScopes: stringArraySchema(),
    symbolScopes: stringArraySchema(),
    sideScopes: stringArraySchema(),
    quantityNotionalBucketIdentity: { type: 'string', minLength: 1 },
    volatilityRegimeIdentity: { type: 'string', minLength: 1 },
    liquidityRegimeIdentity: { type: 'string', minLength: 1 },
    calibratedAt: { type: 'number', exclusiveMinimum: 0 },
    maximumAge: { type: 'number', exclusiveMinimum: 0 },
    provenance: { type: 'object' },
    sourceObservationLineage: { type: 'object' },
    outOfSampleValidationReference: { type: 'object' },
    estimatedImpactPercent: { type: 'number', minimum: 0 },
    estimatedImpactBps: { type: 'number', minimum: 0 },
    zeroEvidenceReason: { type: ['string', 'null'] },
    zeroEvidenceReference: { type: ['object', 'null'] },
    costOwnership: { type: 'object' },
    independenceEvidence: { type: 'object' },
  },
  required: [
    'schema',
    'version',
    'evidenceClass',
    'testOnly',
    'artifactId',
    'artifactDigest',
    'methodologyVersion',
    'producerCodeSha',
    'calibrationCodeSha',
    'datasetIdentity',
    'datasetDigest',
    'sampleN',
    'trainDatasetIdentity',
    'trainDatasetDigest',
    'trainSampleN',
    'validationDatasetIdentity',
    'validationDatasetDigest',
    'validationSampleN',
    'oosDatasetIdentity',
    'oosDatasetDigest',
    'oosSampleN',
    'marketScopes',
    'symbolScopes',
    'sideScopes',
    'quantityNotionalBucketIdentity',
    'volatilityRegimeIdentity',
    'liquidityRegimeIdentity',
    'calibratedAt',
    'maximumAge',
    'provenance',
    'sourceObservationLineage',
    'outOfSampleValidationReference',
    'estimatedImpactPercent',
    'estimatedImpactBps',
    'zeroEvidenceReason',
    'zeroEvidenceReference',
    'costOwnership',
    'independenceEvidence',
  ],
});

export const LIQUIDITY_IMPACT_EVIDENCE_FIREWALL_SAFETY = deepFreeze({
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  realOrderCount: 0,
  unknownImpactIsZero: false,
  bookWalkReuseAllowed: false,
  implementationShortfallReuseAllowed: false,
  testFixtureRuntimeCredit: 0,
  naturalEvidenceCredit: 0,
  fullCostReady: false,
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stringArraySchema() {
  return {
    type: 'array',
    minItems: 1,
    uniqueItems: true,
    items: { type: 'string', minLength: 1, not: { const: '*' } },
  };
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function positiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function digest(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && SHA256.test(normalized) ? normalized : null;
}

function commitSha(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && COMMIT_SHA.test(normalized) ? normalized : null;
}

function stringArray(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalized = value.map(text);
  if (normalized.some((item) => item == null || item === '*')) return null;
  return Object.freeze([...new Set(normalized)]);
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

export function computeLiquidityImpactArtifactDigest(artifact) {
  if (!object(artifact)) throw new TypeError('LIQUIDITY_IMPACT_ARTIFACT_REQUIRED');
  const payload = Object.fromEntries(
    Object.entries(artifact).filter(([key]) => key !== 'artifactDigest'),
  );
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

function same(left, right) {
  return text(left) != null && text(left) === text(right);
}

function sameDigest(left, right) {
  return digest(left) != null && digest(left) === digest(right);
}

function scopeContains(scopes, expected) {
  const target = text(expected)?.toUpperCase() ?? null;
  return target != null && scopes?.some((item) => item.toUpperCase() === target);
}

function add(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

function validateArtifactShape(artifact, reasons) {
  const allowed = new Set(Object.keys(LIQUIDITY_IMPACT_EVIDENCE_JSON_SCHEMA.properties));
  const required = LIQUIDITY_IMPACT_EVIDENCE_JSON_SCHEMA.required;
  if (Object.keys(artifact).some((field) => !allowed.has(field))
    || required.some((field) => !Object.prototype.hasOwnProperty.call(artifact, field))) {
    add(reasons, 'ARTIFACT_SCHEMA_MALFORMED');
  }
}

function validateContext(context, reasons) {
  const expected = object(context);
  if (!expected) {
    add(reasons, 'VALIDATION_CONTEXT_REQUIRED');
    return null;
  }
  for (const [field, value] of [
    ['EXPECTED_MARKET_REQUIRED', expected.market],
    ['EXPECTED_SYMBOL_REQUIRED', expected.symbol],
    ['EXPECTED_SIDE_REQUIRED', expected.side],
    ['EXPECTED_QUANTITY_NOTIONAL_BUCKET_REQUIRED', expected.quantityNotionalBucketIdentity],
    ['EXPECTED_VOLATILITY_REGIME_REQUIRED', expected.volatilityRegimeIdentity],
    ['EXPECTED_LIQUIDITY_REGIME_REQUIRED', expected.liquidityRegimeIdentity],
  ]) {
    if (!text(value)) add(reasons, field);
  }
  if (!positiveFinite(expected.nowMs)) add(reasons, 'VALIDATION_NOW_REQUIRED');
  if (!commitSha(expected.producerCodeSha)) add(reasons, 'EXPECTED_PRODUCER_CODE_SHA_REQUIRED');
  if (!commitSha(expected.calibrationCodeSha)) add(reasons, 'EXPECTED_CALIBRATION_CODE_SHA_REQUIRED');
  if (!positiveFinite(expected.maximumAge)) add(reasons, 'EXPECTED_MAXIMUM_AGE_REQUIRED');
  const provenance = object(expected.provenance);
  if (!provenance || !text(provenance.sourceType) || !text(provenance.sourceProvider)
    || !text(provenance.sourceIdentity) || !digest(provenance.sourceDigest)) {
    add(reasons, 'EXPECTED_PROVENANCE_REQUIRED');
  }
  if (!Array.isArray(expected.competingCostEvidence)) {
    add(reasons, 'COMPETING_COST_EVIDENCE_REQUIRED');
  }
  return expected;
}

function validateProvenance(artifact, expected, reasons) {
  const provenance = object(artifact.provenance);
  if (!provenance) {
    add(reasons, 'PROVENANCE_REQUIRED');
    return null;
  }
  if (provenance.sourceType !== PUBLIC_HISTORICAL_SOURCE
    || !text(provenance.sourceProvider)
    || !text(provenance.sourceIdentity)
    || !digest(provenance.sourceDigest)
    || provenance.immutable !== true) {
    add(reasons, 'PROVENANCE_INVALID');
  }
  const expectedProvenance = object(expected?.provenance);
  if (expectedProvenance && (
    provenance.sourceType !== expectedProvenance.sourceType
    || provenance.sourceProvider !== expectedProvenance.sourceProvider
    || provenance.sourceIdentity !== expectedProvenance.sourceIdentity
    || !sameDigest(provenance.sourceDigest, expectedProvenance.sourceDigest)
  )) {
    add(reasons, 'PROVENANCE_MISMATCH');
  }
  if (FORBIDDEN_SOURCE.test(String(provenance.sourceIdentity ?? ''))) {
    add(reasons, 'FORBIDDEN_COST_SOURCE_REUSED');
  }
  return provenance;
}

function validateLineage(artifact, provenance, reasons) {
  const lineage = object(artifact.sourceObservationLineage);
  if (!lineage) {
    add(reasons, 'SOURCE_OBSERVATION_LINEAGE_REQUIRED');
    return null;
  }
  if (!text(lineage.lineageId) || !digest(lineage.lineageDigest)
    || lineage.sourceType !== PUBLIC_HISTORICAL_SOURCE
    || !text(lineage.sourceIdentity)
    || !positiveInteger(lineage.observationCount)
    || !positiveFinite(lineage.firstObservedAt)
    || !positiveFinite(lineage.lastObservedAt)
    || lineage.firstObservedAt > lineage.lastObservedAt
    || lineage.lastObservedAt > artifact.calibratedAt) {
    add(reasons, 'SOURCE_OBSERVATION_LINEAGE_INVALID');
  }
  if (positiveInteger(artifact.sampleN) && lineage.observationCount < artifact.sampleN) {
    add(reasons, 'SOURCE_OBSERVATION_COUNT_INSUFFICIENT');
  }
  if (provenance && lineage.sourceIdentity !== provenance.sourceIdentity) {
    add(reasons, 'SOURCE_OBSERVATION_PROVENANCE_MISMATCH');
  }
  if (FORBIDDEN_SOURCE.test(String(lineage.sourceIdentity ?? ''))) {
    add(reasons, 'FORBIDDEN_OBSERVATION_LINEAGE_REUSED');
  }
  return lineage;
}

function validateOutOfSample(artifact, reasons) {
  const reference = object(artifact.outOfSampleValidationReference);
  if (!reference) {
    add(reasons, 'OOS_VALIDATION_REFERENCE_REQUIRED');
    return null;
  }
  if (!text(reference.referenceId) || !digest(reference.referenceDigest)
    || !text(reference.trainDatasetIdentity)
    || reference.trainDatasetIdentity !== artifact.trainDatasetIdentity
    || !digest(reference.trainDatasetDigest)
    || !sameDigest(reference.trainDatasetDigest, artifact.trainDatasetDigest)
    || !text(reference.validationDatasetIdentity)
    || reference.validationDatasetIdentity !== artifact.validationDatasetIdentity
    || !digest(reference.validationDatasetDigest)
    || !sameDigest(reference.validationDatasetDigest, artifact.validationDatasetDigest)
    || !text(reference.oosDatasetIdentity)
    || reference.oosDatasetIdentity !== artifact.oosDatasetIdentity
    || !digest(reference.oosDatasetDigest)
    || !sameDigest(reference.oosDatasetDigest, artifact.oosDatasetDigest)
    || new Set([
      reference.trainDatasetIdentity,
      reference.validationDatasetIdentity,
      reference.oosDatasetIdentity,
    ]).size !== 3
    || new Set([
      digest(reference.trainDatasetDigest),
      digest(reference.validationDatasetDigest),
      digest(reference.oosDatasetDigest),
    ]).size !== 3
    || !positiveInteger(reference.sampleN)
    || reference.sampleN !== artifact.oosSampleN
    || reference.status !== 'PASS'
    || reference.heldOut !== true
    || reference.contaminationFree !== true
    || !positiveFinite(reference.evaluatedAt)
    || reference.evaluatedAt > artifact.calibratedAt) {
    add(reasons, 'OOS_VALIDATION_REFERENCE_INVALID');
  }
  return reference;
}

function validateImpactValue(artifact, lineage, oos, reasons) {
  const percent = artifact.estimatedImpactPercent;
  const bps = artifact.estimatedImpactBps;
  if (!nonNegativeFinite(percent) || !nonNegativeFinite(bps)) {
    add(reasons, 'LIQUIDITY_IMPACT_COST_INVALID');
    return;
  }
  if (Math.abs(percent * 100 - bps) > 1e-9) {
    add(reasons, 'LIQUIDITY_IMPACT_UNIT_MISMATCH');
  }
  if (percent === 0 && bps === 0) {
    const zero = object(artifact.zeroEvidenceReference);
    if (!text(artifact.zeroEvidenceReason) || !zero
      || !text(zero.referenceId)
      || !digest(zero.referenceDigest)
      || zero.result !== 'MEASURED_ZERO_COMPATIBLE'
      || !same(zero.sourceObservationLineageId, lineage?.lineageId)
      || !same(zero.outOfSampleValidationReferenceId, oos?.referenceId)) {
      add(reasons, 'MEASURED_ZERO_EVIDENCE_REQUIRED');
    }
  } else if (artifact.zeroEvidenceReason != null || artifact.zeroEvidenceReference != null) {
    add(reasons, 'ZERO_EVIDENCE_ONLY_ALLOWED_FOR_EXACT_ZERO');
  }
}

function validateOwnership(artifact, oos, reasons) {
  const ownership = object(artifact.costOwnership);
  const independence = object(artifact.independenceEvidence);
  const excluded = stringArray(ownership?.excludedCostOwners);
  if (!ownership || ownership.owner !== LIQUIDITY_IMPACT_COST_OWNERS.LIQUIDITY
    || !text(ownership.sourceIdentity) || !digest(ownership.sourceDigest)
    || !excluded || REQUIRED_EXCLUDED_OWNERS.some((owner) => !excluded.includes(owner))) {
    add(reasons, 'LIQUIDITY_COST_OWNERSHIP_INVALID');
  }
  if (FORBIDDEN_SOURCE.test(String(ownership?.sourceIdentity ?? ''))) {
    add(reasons, 'FORBIDDEN_COST_SOURCE_REUSED');
  }
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
    || !same(independence.validationReferenceId, oos?.referenceId)) {
    add(reasons, 'INDEPENDENCE_EVIDENCE_INVALID');
  }
  if (FORBIDDEN_SOURCE.test(String(artifact.methodologyVersion ?? ''))) {
    add(reasons, 'FORBIDDEN_METHODOLOGY_REUSED');
  }
  return ownership;
}

function validateCompetingCosts(artifact, expected, provenance, lineage, ownership, reasons) {
  const competing = Array.isArray(expected?.competingCostEvidence)
    ? expected.competingCostEvidence
    : [];
  for (const owner of REQUIRED_COMPETING_EVIDENCE_OWNERS) {
    if (!competing.some((item) => item?.costOwner === owner)) {
      add(reasons, `${owner}_EVIDENCE_REQUIRED`);
    }
  }
  const acceptedOwners = new Set(Object.values(LIQUIDITY_IMPACT_COST_OWNERS));
  const validCompeting = [];
  for (const raw of competing) {
    const item = object(raw);
    if (!item || !text(item.costOwner) || !text(item.evidenceIdentity)
      || !digest(item.evidenceDigest) || !text(item.sourceIdentity)
      || !digest(item.sourceDigest) || !text(item.sourceObservationLineageId)
      || !digest(item.sourceObservationLineageDigest)) {
      add(reasons, 'COMPETING_COST_EVIDENCE_INVALID');
      continue;
    }
    if (!acceptedOwners.has(item.costOwner)
      || item.costOwner === LIQUIDITY_IMPACT_COST_OWNERS.LIQUIDITY) {
      add(reasons, 'COMPETING_COST_OWNER_INVALID');
      continue;
    }
    validCompeting.push(item);
    if (same(artifact.artifactId, item.evidenceIdentity)) {
      add(reasons, 'COST_EVIDENCE_IDENTITY_REUSED');
    }
    if (sameDigest(artifact.artifactDigest, item.evidenceDigest)) {
      add(reasons, 'COST_EVIDENCE_DIGEST_REUSED');
    }
    if (same(ownership?.sourceIdentity, item.sourceIdentity)
      || same(provenance?.sourceIdentity, item.sourceIdentity)) {
      add(reasons, 'COST_SOURCE_IDENTITY_REUSED');
    }
    if (sameDigest(ownership?.sourceDigest, item.sourceDigest)
      || sameDigest(provenance?.sourceDigest, item.sourceDigest)
      || sameDigest(artifact.datasetDigest, item.sourceDigest)) {
      add(reasons, 'COST_SOURCE_DIGEST_REUSED');
    }
    if (same(lineage?.lineageId, item.sourceObservationLineageId)
      || sameDigest(lineage?.lineageDigest, item.sourceObservationLineageDigest)) {
      add(reasons, 'SOURCE_OBSERVATION_LINEAGE_REUSED');
    }
  }
  for (let leftIndex = 0; leftIndex < validCompeting.length; leftIndex += 1) {
    const left = validCompeting[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < validCompeting.length; rightIndex += 1) {
      const right = validCompeting[rightIndex];
      if (left.costOwner === right.costOwner) continue;
      if (same(left.evidenceIdentity, right.evidenceIdentity)) {
        add(reasons, 'COST_EVIDENCE_IDENTITY_REUSED');
      }
      if (sameDigest(left.evidenceDigest, right.evidenceDigest)) {
        add(reasons, 'COST_EVIDENCE_DIGEST_REUSED');
      }
      if (same(left.sourceIdentity, right.sourceIdentity)) {
        add(reasons, 'COST_SOURCE_IDENTITY_REUSED');
      }
      if (sameDigest(left.sourceDigest, right.sourceDigest)) {
        add(reasons, 'COST_SOURCE_DIGEST_REUSED');
      }
      if (same(left.sourceObservationLineageId, right.sourceObservationLineageId)
        || sameDigest(left.sourceObservationLineageDigest, right.sourceObservationLineageDigest)) {
        add(reasons, 'SOURCE_OBSERVATION_LINEAGE_REUSED');
      }
    }
  }
}

function rejectResult(reasons) {
  return deepFreeze({
    contract: `liquidity-impact-evidence-firewall/v${LIQUIDITY_IMPACT_EVIDENCE_VERSION}`,
    validationStatus: 'REJECTED',
    liquidityImpactStatus: 'BLOCKED_DATA',
    artifact: null,
    runtimeEligible: false,
    blockers: [...new Set(reasons)],
    testFixtureRuntimeCredit: 0,
    naturalEvidenceCredit: 0,
    fullCostReady: false,
    safety: LIQUIDITY_IMPACT_EVIDENCE_FIREWALL_SAFETY,
  });
}

export function validateLiquidityImpactCalibrationEvidence(input = {}) {
  const reasons = [];
  const artifact = object(input.artifact);
  const expected = validateContext(input.expected, reasons);
  if (!artifact) {
    add(reasons, 'CALIBRATION_ARTIFACT_REQUIRED');
    return rejectResult(reasons);
  }

  validateArtifactShape(artifact, reasons);
  if (artifact.schema !== LIQUIDITY_IMPACT_EVIDENCE_SCHEMA) add(reasons, 'SCHEMA_INVALID');
  if (artifact.version !== LIQUIDITY_IMPACT_EVIDENCE_VERSION) add(reasons, 'VERSION_INVALID');
  if (!['CALIBRATION_ARTIFACT', 'TEST_FIXTURE'].includes(artifact.evidenceClass)) {
    add(reasons, 'EVIDENCE_CLASS_INVALID');
  }
  if (typeof artifact.testOnly !== 'boolean'
    || (artifact.evidenceClass === 'TEST_FIXTURE') !== artifact.testOnly) {
    add(reasons, 'TEST_ONLY_CLASSIFICATION_INVALID');
  }
  if (!text(artifact.artifactId)) add(reasons, 'ARTIFACT_ID_REQUIRED');
  if (!digest(artifact.artifactDigest)) add(reasons, 'ARTIFACT_DIGEST_INVALID');
  try {
    if (!sameDigest(artifact.artifactDigest, computeLiquidityImpactArtifactDigest(artifact))) {
      add(reasons, 'ARTIFACT_DIGEST_MISMATCH');
    }
  } catch {
    add(reasons, 'ARTIFACT_DIGEST_UNVERIFIABLE');
  }
  if (!text(artifact.methodologyVersion)) add(reasons, 'METHODOLOGY_VERSION_REQUIRED');
  if (!commitSha(artifact.producerCodeSha)) add(reasons, 'PRODUCER_CODE_SHA_INVALID');
  if (!commitSha(artifact.calibrationCodeSha)) add(reasons, 'CALIBRATION_CODE_SHA_INVALID');
  if (expected && commitSha(artifact.producerCodeSha) !== commitSha(expected.producerCodeSha)) {
    add(reasons, 'PRODUCER_CODE_SHA_MISMATCH');
  }
  if (expected && commitSha(artifact.calibrationCodeSha) !== commitSha(expected.calibrationCodeSha)) {
    add(reasons, 'CALIBRATION_CODE_SHA_MISMATCH');
  }
  if (!text(artifact.datasetIdentity)) add(reasons, 'DATASET_IDENTITY_REQUIRED');
  if (!digest(artifact.datasetDigest)) add(reasons, 'DATASET_DIGEST_REQUIRED');
  if (!positiveInteger(artifact.sampleN)) add(reasons, 'SAMPLE_N_REQUIRED');
  if (!text(artifact.trainDatasetIdentity)) add(reasons, 'TRAIN_DATASET_IDENTITY_REQUIRED');
  if (!digest(artifact.trainDatasetDigest)) add(reasons, 'TRAIN_DATASET_DIGEST_REQUIRED');
  if (!positiveInteger(artifact.trainSampleN)) add(reasons, 'TRAIN_SAMPLE_N_REQUIRED');
  if (!text(artifact.validationDatasetIdentity)) add(reasons, 'VALIDATION_DATASET_IDENTITY_REQUIRED');
  if (!digest(artifact.validationDatasetDigest)) add(reasons, 'VALIDATION_DATASET_DIGEST_REQUIRED');
  if (!positiveInteger(artifact.validationSampleN)) add(reasons, 'VALIDATION_SAMPLE_N_REQUIRED');
  if (!text(artifact.oosDatasetIdentity)) add(reasons, 'OOS_DATASET_IDENTITY_REQUIRED');
  if (!digest(artifact.oosDatasetDigest)) add(reasons, 'OOS_DATASET_DIGEST_REQUIRED');
  if (!positiveInteger(artifact.oosSampleN)) add(reasons, 'OOS_SAMPLE_N_REQUIRED');
  const splitIdentities = [
    text(artifact.trainDatasetIdentity),
    text(artifact.validationDatasetIdentity),
    text(artifact.oosDatasetIdentity),
  ];
  const splitDigests = [
    digest(artifact.trainDatasetDigest),
    digest(artifact.validationDatasetDigest),
    digest(artifact.oosDatasetDigest),
  ];
  if (splitIdentities.every(Boolean) && new Set(splitIdentities).size !== 3) {
    add(reasons, 'SAMPLE_SPLIT_IDENTITY_INVALID');
  }
  if (splitDigests.every(Boolean) && new Set(splitDigests).size !== 3) {
    add(reasons, 'SAMPLE_SPLIT_DIGEST_INVALID');
  }
  if (positiveInteger(artifact.sampleN) && positiveInteger(artifact.trainSampleN)
    && positiveInteger(artifact.validationSampleN)
    && positiveInteger(artifact.oosSampleN)
    && artifact.sampleN !== artifact.trainSampleN
      + artifact.validationSampleN + artifact.oosSampleN) {
    add(reasons, 'SAMPLE_SPLIT_IDENTITY_INVALID');
  }

  const markets = stringArray(artifact.marketScopes);
  const symbols = stringArray(artifact.symbolScopes);
  const sides = stringArray(artifact.sideScopes);
  if (!markets || !scopeContains(markets, expected?.market)) add(reasons, 'MARKET_SCOPE_MISMATCH');
  if (!symbols || !scopeContains(symbols, expected?.symbol)) add(reasons, 'SYMBOL_SCOPE_MISMATCH');
  if (!sides || !scopeContains(sides, expected?.side)) add(reasons, 'SIDE_SCOPE_MISMATCH');
  if (!text(artifact.quantityNotionalBucketIdentity)
    || artifact.quantityNotionalBucketIdentity !== expected?.quantityNotionalBucketIdentity) {
    add(reasons, 'QUANTITY_NOTIONAL_BUCKET_MISMATCH');
  }
  if (!text(artifact.volatilityRegimeIdentity)
    || artifact.volatilityRegimeIdentity !== expected?.volatilityRegimeIdentity) {
    add(reasons, 'VOLATILITY_REGIME_MISMATCH');
  }
  if (!text(artifact.liquidityRegimeIdentity)
    || artifact.liquidityRegimeIdentity !== expected?.liquidityRegimeIdentity) {
    add(reasons, 'LIQUIDITY_REGIME_MISMATCH');
  }
  if (!positiveFinite(artifact.calibratedAt)) add(reasons, 'CALIBRATED_AT_INVALID');
  if (!positiveFinite(artifact.maximumAge)) add(reasons, 'MAXIMUM_AGE_INVALID');
  if (positiveFinite(artifact.maximumAge) && positiveFinite(expected?.maximumAge)
    && artifact.maximumAge > expected.maximumAge) add(reasons, 'MAXIMUM_AGE_EXCEEDS_POLICY');
  if (positiveFinite(artifact.calibratedAt) && positiveFinite(expected?.nowMs)) {
    if (artifact.calibratedAt > expected.nowMs) add(reasons, 'CALIBRATION_FROM_FUTURE');
    else if (positiveFinite(artifact.maximumAge)
      && expected.nowMs - artifact.calibratedAt > artifact.maximumAge) {
      add(reasons, 'CALIBRATION_STALE');
    }
  }

  const provenance = validateProvenance(artifact, expected, reasons);
  const lineage = validateLineage(artifact, provenance, reasons);
  const oos = validateOutOfSample(artifact, reasons);
  validateImpactValue(artifact, lineage, oos, reasons);
  const ownership = validateOwnership(artifact, oos, reasons);
  validateCompetingCosts(artifact, expected, provenance, lineage, ownership, reasons);

  if (reasons.length > 0) return rejectResult(reasons);
  const testOnly = artifact.evidenceClass === 'TEST_FIXTURE' || artifact.testOnly === true;
  return deepFreeze({
    contract: `liquidity-impact-evidence-firewall/v${LIQUIDITY_IMPACT_EVIDENCE_VERSION}`,
    validationStatus: 'PASS',
    liquidityImpactStatus: 'BLOCKED_DATA',
    artifact: canonicalize(artifact),
    runtimeEligible: !testOnly,
    blockers: [],
    testFixtureRuntimeCredit: 0,
    naturalEvidenceCredit: 0,
    fullCostReady: false,
    safety: LIQUIDITY_IMPACT_EVIDENCE_FIREWALL_SAFETY,
  });
}

export function admitValidatedLiquidityImpactEvidenceForRuntime(input = {}) {
  const validation = validateLiquidityImpactCalibrationEvidence(input);
  if (validation.validationStatus !== 'PASS' || !validation.artifact) return validation;
  if (validation.artifact.evidenceClass === 'TEST_FIXTURE'
    || validation.artifact.testOnly === true
    || validation.runtimeEligible !== true) {
    return rejectResult(['TEST_FIXTURE_RUNTIME_CREDIT_FORBIDDEN']);
  }
  return deepFreeze({
    contract: `liquidity-impact-runtime-admission/v${LIQUIDITY_IMPACT_EVIDENCE_VERSION}`,
    validationStatus: 'PASS',
    liquidityImpactStatus: 'PRESENT',
    artifact: validation.artifact,
    estimatedImpactPercent: validation.artifact.estimatedImpactPercent,
    estimatedImpactBps: validation.artifact.estimatedImpactBps,
    costOwnership: validation.artifact.costOwnership,
    runtimeEligible: true,
    blockers: [],
    testFixtureRuntimeCredit: 0,
    naturalEvidenceCredit: 0,
    fullCostReady: false,
    safety: LIQUIDITY_IMPACT_EVIDENCE_FIREWALL_SAFETY,
  });
}


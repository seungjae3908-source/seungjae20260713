import { createHash } from 'node:crypto';

import type {
  PublicForwardPartialFillCalibrationObservation,
} from './public-forward-partial-fill-calibration-collector.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_V3_PROSPECTIVE_METHODOLOGY_VERSION =
  'public-forward-partial-fill-v3-prospective-methodology-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_V3_PROSPECTIVE_COHORT_VERSION =
  'public-forward-partial-fill-v3-prospective-cohort-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_V3_MODELED_OBSERVATION_VERSION =
  'public-forward-partial-fill-v3-modeled-observation-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY = Object.freeze({
  authorityIdentity: 'PUBLIC_FORWARD_PARTIAL_FILL_SUCCESSOR_V2_FROZEN_CAPACITY',
  authorityVersion: 'V2',
  sourceReference: 'https://github.com/seungjae3908-source/seungjae20260713/pull/873',
  policyDigest: '5d91ea09ac5a2982a26d00197433142455fa6634488fadc9201e4ddf1346ed6c',
  cohortDigest: '9b2853a361e17dc429288cec4499fc972189b0bc2427a6d8bb2a999eff847454',
  totalSlotN: 1024,
  trainSlotN: 512,
  validationSlotN: 256,
  oosSlotN: 256,
  perScopeEffectiveIndependentMinimum: 178,
  scopeCellCount: 4,
  mechanicalFloorEffectiveIndependent: 712,
  predecessorCriteriaMutationAllowed: false,
  priorEligibleBoundaryReuseAllowed: false,
} as const);

export const PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES = Object.freeze({
  businessTolerance: Object.freeze({
    identity: 'PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_V1',
    version: 'V1',
    digest: 'adef3bbf8f6647f0314a35ca5b0d48eebefed614a0e66ab28e93f6d3dc2a0f7c',
    sourceReference: 'https://github.com/seungjae3908-source/seungjae20260713/issues/838#issuecomment-5489589062',
  }),
  statisticalMethodology: Object.freeze({
    identity: 'PUBLIC_FORWARD_PARTIAL_FILL_STATISTICAL_METHODOLOGY_V1',
    version: 'V1',
    digest: '1b60b2f3719556b14d8d360a25f2043f5e45b0c24089c1636f3d66d784801308',
    sourceReference: 'https://github.com/seungjae3908-source/seungjae20260713/issues/838#issuecomment-5492123059',
  }),
  scopeUniverse: Object.freeze({
    identity: 'PUBLIC_FORWARD_PARTIAL_FILL_SCOPE_UNIVERSE_V1',
    version: 'V1',
    digest: '55bbbf79b89040bffe7485b48b97fa56d6175a0796d72dfb8985d1923d64e244',
    sourceReference: 'https://github.com/seungjae3908-source/seungjae20260713/issues/838#issuecomment-5492547947',
  }),
  numericMinimumArtifact: Object.freeze({
    identity: 'PUBLIC_FORWARD_PARTIAL_FILL_NUMERIC_MINIMUM_V1',
    version: 'V1',
    digest: '8c3ded9d0862b9c81f04a466fb6d4df03ee39185cc1f59bc08c41923231b8e29',
    sourceReference: 'https://github.com/seungjae3908-source/seungjae20260713/issues/838#issuecomment-5497188794',
    perScopeMinimumEffectiveIndependentN: 178,
    scopeCellCount: 4,
    aggregateEffectiveIndependentCellCreditFloor: 712,
  }),
} as const);

export const PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY = Object.freeze({
  publicOnly: true,
  predecessorV2MutationAllowed: false,
  predecessorEvidenceRewriteAllowed: false,
  retrospectiveCreditAllowed: false,
  replayCreditAllowed: false,
  backfillCreditAllowed: false,
  manualCreditAllowed: false,
  syntheticCreditAllowed: false,
  actualFillInferenceAllowed: false,
  queuePositionInferenceAllowed: false,
  modeledEvidenceMayBecomeActualEvidence: false,
  modeledEvidenceMaySatisfyActualFillGate: false,
  modeledEvidenceMaySatisfyQueuePositionGate: false,
  modeledEvidenceMaySatisfyActualCostGate: false,
  modeledEvidenceMaySatisfySettlementGate: false,
  existingNumericCriteriaRelaxationAllowed: false,
  economicCreditCreated: false,
  profitabilityCredit: 0,
  fullCostReady: false,
  evidenceComplete: 0,
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  realOrderEnabled: false,
});

export type PublicForwardPartialFillV3FrozenRef = Readonly<{
  identity: string;
  version: string;
  digest: string;
  frozenAtMs: number;
  status: 'FROZEN';
}>;

export type PublicForwardPartialFillV3PredecessorV2Authority =
  PublicForwardPartialFillV3FrozenRef & Readonly<{
    policyDigest: string;
    cohortDigest: string;
    totalSlotN: number;
    trainSlotN: number;
    validationSlotN: number;
    oosSlotN: number;
    perScopeEffectiveIndependentMinimum: number;
    scopeCellCount: number;
    mechanicalFloorEffectiveIndependent: number;
  }>;

export type PublicForwardPartialFillV3ModeledLanePolicy = Readonly<{
  evidenceClass: 'MODELED_PUBLIC_ONLY';
  modelIdentity: string;
  modelVersion: string;
  modelDigest: string;
  modelFrozenAtMs: number;
  conservativeOpportunityBoundOnly: true;
  actualExecutionSubstitutionAllowed: false;
  actualFillInferenceAllowed: false;
  queuePositionInferenceAllowed: false;
}>;

export type PublicForwardPartialFillV3ProspectiveMethodologyInput = Readonly<{
  methodologyIdentity: string;
  methodologyVersion: string;
  methodologyFrozenAtMs: number;
  predecessorV2: PublicForwardPartialFillV3PredecessorV2Authority;
  businessTolerance: PublicForwardPartialFillV3FrozenRef;
  statisticalMethodology: PublicForwardPartialFillV3FrozenRef;
  numericMinimumArtifact: PublicForwardPartialFillV3FrozenRef;
  scopeUniverse: PublicForwardPartialFillV3FrozenRef;
  modeledLane: PublicForwardPartialFillV3ModeledLanePolicy;
}>;

export type PublicForwardPartialFillV3ProspectiveMethodology = Readonly<{
  schemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_V3_PROSPECTIVE_METHODOLOGY_VERSION;
  kind: 'IMMUTABLE_PUBLIC_ONLY_PARTIAL_FILL_V3_METHODOLOGY';
  methodologyIdentity: string;
  methodologyVersion: string;
  methodologyFrozenAtMs: number;
  predecessorV2: PublicForwardPartialFillV3PredecessorV2Authority;
  businessTolerance: PublicForwardPartialFillV3FrozenRef;
  statisticalMethodology: PublicForwardPartialFillV3FrozenRef;
  numericMinimumArtifact: PublicForwardPartialFillV3FrozenRef;
  scopeUniverse: PublicForwardPartialFillV3FrozenRef;
  modeledLane: PublicForwardPartialFillV3ModeledLanePolicy;
  actualExecutionTruthRequirement: 'REMAINS_REQUIRED_FOR_ACTUAL_EXECUTION_GATES';
  modeledEvidenceAuthority: 'RESEARCH_ONLY_NON_ECONOMIC';
  predecessorV2MutationAllowed: false;
  existingNumericCriteriaRelaxed: false;
  profitabilityCredit: 0;
  evidenceComplete: 0;
  executionAuthority: 'NONE';
  methodologyDigest: string;
}>;

export type PublicForwardPartialFillV3ProspectiveCohortInput = Readonly<{
  cohortIdentity: string;
  cohortVersion: string;
  cohortFrozenAtMs: number;
  effectiveStartMs: number;
  methodology: PublicForwardPartialFillV3ProspectiveMethodology;
}>;

export type PublicForwardPartialFillV3ProspectiveCohort = Readonly<{
  schemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_V3_PROSPECTIVE_COHORT_VERSION;
  kind: 'IMMUTABLE_PROSPECTIVE_PUBLIC_ONLY_PARTIAL_FILL_V3_COHORT';
  cohortIdentity: string;
  cohortVersion: string;
  cohortFrozenAtMs: number;
  effectiveStartMs: number;
  methodologyIdentity: string;
  methodologyVersion: string;
  methodologyDigest: string;
  sourceClass: 'FORWARD_NATURAL_SAMPLE';
  predecessorV2MutationAllowed: false;
  retrospectiveCreditAllowed: false;
  replayCreditAllowed: false;
  backfillCreditAllowed: false;
  manualCreditAllowed: false;
  syntheticCreditAllowed: false;
  actualExecutionTruthStatus: 'UNKNOWN_UNTIL_OBSERVED';
  modeledEvidenceAuthority: 'RESEARCH_ONLY_NON_ECONOMIC';
  existingNumericCriteriaRelaxed: false;
  profitabilityCredit: 0;
  evidenceComplete: 0;
  executionAuthority: 'NONE';
  cohortDigest: string;
}>;

export type PublicForwardPartialFillV3ModeledObservation = Readonly<{
  schemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_V3_MODELED_OBSERVATION_VERSION;
  cohortIdentity: string;
  cohortDigest: string;
  methodologyIdentity: string;
  methodologyDigest: string;
  observationId: string;
  sourceObservationLineageDigest: string;
  market: 'CRYPTO_FUTURES';
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantityNotionalBucketIdentity: string;
  windowStartMs: number;
  observedAtMs: number;
  modeledPublicEvidence: Readonly<{
    evidenceClass: 'MODELED_PUBLIC_ONLY';
    modelIdentity: string;
    modelVersion: string;
    modelDigest: string;
    opportunityFillRatioUpperBound: number;
    eligiblePublicTouchQuantityUpperBound: number;
    passiveLimitPrice: number;
  }>;
  actualExecutionTruth: Readonly<{
    status: 'UNKNOWN_PUBLIC_ONLY';
    actualFillObserved: false;
    actualFillFraction: null;
    queuePositionKnown: false;
    partialFillCostPercent: null;
    actualAllInCostPresent: false;
    settlementEvidencePresent: false;
  }>;
  modeledEvidenceMayBecomeActualEvidence: false;
  modeledEvidenceMaySatisfyActualExecutionGates: false;
  prospectiveModeledObservationCredit: 1;
  actualExecutionEvidenceCredit: 0;
  economicCreditCreated: false;
  profitabilityCredit: 0;
  fullCostReady: false;
  evidenceComplete: 0;
  executionAuthority: 'NONE';
  recordDigest: string;
}>;

export type PublicForwardPartialFillV3ModeledObservationResult = Readonly<{
  status: 'ADMITTED_MODELED_ONLY' | 'BLOCKED_DATA';
  blockers: readonly string[];
  record: PublicForwardPartialFillV3ModeledObservation | null;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

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

function validateFrozenRef(
  name: string,
  value: PublicForwardPartialFillV3FrozenRef | undefined,
  methodologyFrozenAtMs: number,
): string[] {
  const blockers: string[] = [];
  if (!value || value.status !== 'FROZEN') blockers.push(`${name.toUpperCase()}_NOT_FROZEN`);
  if (!nonEmpty(value?.identity) || !nonEmpty(value?.version)) blockers.push(`${name.toUpperCase()}_IDENTITY_INVALID`);
  if (!exactDigest(value?.digest)) blockers.push(`${name.toUpperCase()}_DIGEST_INVALID`);
  if (!finitePositive(value?.frozenAtMs)) blockers.push(`${name.toUpperCase()}_FROZEN_AT_INVALID`);
  if (finitePositive(value?.frozenAtMs)
    && finitePositive(methodologyFrozenAtMs)
    && value.frozenAtMs > methodologyFrozenAtMs) {
    blockers.push(`${name.toUpperCase()}_FROZEN_AFTER_METHODOLOGY`);
  }
  return blockers;
}

function validateExactPredecessorV2Authority(
  value: PublicForwardPartialFillV3PredecessorV2Authority | undefined,
): string[] {
  const blockers: string[] = [];
  const authority = PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY;
  if (!value) return ['PREDECESSOR_V2_EXACT_AUTHORITY_REQUIRED'];
  if (value.identity !== authority.authorityIdentity
    || value.version !== authority.authorityVersion) {
    blockers.push('PREDECESSOR_V2_AUTHORITY_IDENTITY_MISMATCH');
  }
  if (value.digest !== authority.cohortDigest
    || value.cohortDigest !== authority.cohortDigest
    || value.policyDigest !== authority.policyDigest) {
    blockers.push('PREDECESSOR_V2_AUTHORITY_DIGEST_MISMATCH');
  }
  if (value.totalSlotN !== authority.totalSlotN
    || value.trainSlotN !== authority.trainSlotN
    || value.validationSlotN !== authority.validationSlotN
    || value.oosSlotN !== authority.oosSlotN
    || value.perScopeEffectiveIndependentMinimum !== authority.perScopeEffectiveIndependentMinimum
    || value.scopeCellCount !== authority.scopeCellCount
    || value.mechanicalFloorEffectiveIndependent !== authority.mechanicalFloorEffectiveIndependent) {
    blockers.push('PREDECESSOR_V2_NUMERIC_CRITERIA_MISMATCH');
  }
  if (value.trainSlotN + value.validationSlotN + value.oosSlotN !== value.totalSlotN
    || value.perScopeEffectiveIndependentMinimum * value.scopeCellCount
      !== value.mechanicalFloorEffectiveIndependent) {
    blockers.push('PREDECESSOR_V2_NUMERIC_CRITERIA_INTERNALLY_INCONSISTENT');
  }
  return blockers;
}

function validateExactFrozenComponent(
  name: keyof typeof PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES,
  value: PublicForwardPartialFillV3FrozenRef | undefined,
): string[] {
  const expected = PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES[name];
  if (!value
    || value.identity !== expected.identity
    || value.version !== expected.version
    || value.digest !== expected.digest) {
    return [`${name.toUpperCase()}_EXACT_FROZEN_AUTHORITY_MISMATCH`];
  }
  return [];
}

export function computePublicForwardPartialFillV3MethodologyDigest(
  methodology: Omit<PublicForwardPartialFillV3ProspectiveMethodology, 'methodologyDigest'>
    | PublicForwardPartialFillV3ProspectiveMethodology,
): string {
  const body = Object.fromEntries(
    Object.entries(methodology).filter(([key]) => key !== 'methodologyDigest'),
  );
  return digest(body);
}

export function buildPublicForwardPartialFillV3ProspectiveMethodology(
  input: PublicForwardPartialFillV3ProspectiveMethodologyInput,
): PublicForwardPartialFillV3ProspectiveMethodology {
  const blockers: string[] = [];
  if (!nonEmpty(input?.methodologyIdentity)) blockers.push('METHODOLOGY_IDENTITY_REQUIRED');
  if (!nonEmpty(input?.methodologyVersion)) blockers.push('METHODOLOGY_VERSION_REQUIRED');
  if (!finitePositive(input?.methodologyFrozenAtMs)) blockers.push('METHODOLOGY_FROZEN_AT_INVALID');

  blockers.push(...validateFrozenRef('predecessor_v2', input?.predecessorV2, input?.methodologyFrozenAtMs));
  blockers.push(...validateExactPredecessorV2Authority(input?.predecessorV2));
  blockers.push(...validateFrozenRef('business_tolerance', input?.businessTolerance, input?.methodologyFrozenAtMs));
  blockers.push(...validateExactFrozenComponent('businessTolerance', input?.businessTolerance));
  blockers.push(...validateFrozenRef('statistical_methodology', input?.statisticalMethodology, input?.methodologyFrozenAtMs));
  blockers.push(...validateExactFrozenComponent('statisticalMethodology', input?.statisticalMethodology));
  blockers.push(...validateFrozenRef('numeric_minimum_artifact', input?.numericMinimumArtifact, input?.methodologyFrozenAtMs));
  blockers.push(...validateExactFrozenComponent('numericMinimumArtifact', input?.numericMinimumArtifact));
  blockers.push(...validateFrozenRef('scope_universe', input?.scopeUniverse, input?.methodologyFrozenAtMs));
  blockers.push(...validateExactFrozenComponent('scopeUniverse', input?.scopeUniverse));

  const modeled = input?.modeledLane;
  if (modeled?.evidenceClass !== 'MODELED_PUBLIC_ONLY'
    || !nonEmpty(modeled?.modelIdentity)
    || !nonEmpty(modeled?.modelVersion)
    || !exactDigest(modeled?.modelDigest)
    || !finitePositive(modeled?.modelFrozenAtMs)
    || (finitePositive(modeled?.modelFrozenAtMs)
      && finitePositive(input?.methodologyFrozenAtMs)
      && modeled.modelFrozenAtMs > input.methodologyFrozenAtMs)
    || modeled?.conservativeOpportunityBoundOnly !== true
    || modeled?.actualExecutionSubstitutionAllowed !== false
    || modeled?.actualFillInferenceAllowed !== false
    || modeled?.queuePositionInferenceAllowed !== false) {
    blockers.push('MODELED_LANE_POLICY_INVALID');
  }

  if (blockers.length > 0) {
    throw new Error(`PUBLIC_ONLY_PARTIAL_FILL_V3_METHODOLOGY_BLOCKED:${[...new Set(blockers)].join(',')}`);
  }

  const body = Object.freeze({
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_V3_PROSPECTIVE_METHODOLOGY_VERSION,
    kind: 'IMMUTABLE_PUBLIC_ONLY_PARTIAL_FILL_V3_METHODOLOGY' as const,
    methodologyIdentity: input.methodologyIdentity.trim(),
    methodologyVersion: input.methodologyVersion.trim(),
    methodologyFrozenAtMs: input.methodologyFrozenAtMs,
    predecessorV2: Object.freeze({ ...input.predecessorV2 }),
    businessTolerance: Object.freeze({ ...input.businessTolerance }),
    statisticalMethodology: Object.freeze({ ...input.statisticalMethodology }),
    numericMinimumArtifact: Object.freeze({ ...input.numericMinimumArtifact }),
    scopeUniverse: Object.freeze({ ...input.scopeUniverse }),
    modeledLane: Object.freeze({ ...input.modeledLane }),
    actualExecutionTruthRequirement: 'REMAINS_REQUIRED_FOR_ACTUAL_EXECUTION_GATES' as const,
    modeledEvidenceAuthority: 'RESEARCH_ONLY_NON_ECONOMIC' as const,
    predecessorV2MutationAllowed: false as const,
    existingNumericCriteriaRelaxed: false as const,
    profitabilityCredit: 0 as const,
    evidenceComplete: 0 as const,
    executionAuthority: 'NONE' as const,
  });
  return Object.freeze({
    ...body,
    methodologyDigest: computePublicForwardPartialFillV3MethodologyDigest(body),
  });
}

export function computePublicForwardPartialFillV3CohortDigest(
  cohort: Omit<PublicForwardPartialFillV3ProspectiveCohort, 'cohortDigest'>
    | PublicForwardPartialFillV3ProspectiveCohort,
): string {
  return digest(Object.fromEntries(
    Object.entries(cohort).filter(([key]) => key !== 'cohortDigest'),
  ));
}

export function buildPublicForwardPartialFillV3ProspectiveCohort(
  input: PublicForwardPartialFillV3ProspectiveCohortInput,
): PublicForwardPartialFillV3ProspectiveCohort {
  const blockers: string[] = [];
  if (!nonEmpty(input?.cohortIdentity)) blockers.push('COHORT_IDENTITY_REQUIRED');
  if (!nonEmpty(input?.cohortVersion)) blockers.push('COHORT_VERSION_REQUIRED');
  if (!finitePositive(input?.cohortFrozenAtMs)) blockers.push('COHORT_FROZEN_AT_INVALID');
  if (!finitePositive(input?.effectiveStartMs)) blockers.push('COHORT_EFFECTIVE_START_INVALID');

  const methodology = input?.methodology;
  if (!methodology
    || methodology.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_V3_PROSPECTIVE_METHODOLOGY_VERSION
    || !exactDigest(methodology.methodologyDigest)
    || computePublicForwardPartialFillV3MethodologyDigest(methodology) !== methodology.methodologyDigest) {
    blockers.push('METHODOLOGY_BINDING_INVALID');
  }
  if (methodology && finitePositive(input?.cohortFrozenAtMs)
    && input.cohortFrozenAtMs < methodology.methodologyFrozenAtMs) {
    blockers.push('COHORT_FROZEN_BEFORE_METHODOLOGY');
  }
  if (finitePositive(input?.effectiveStartMs)
    && finitePositive(input?.cohortFrozenAtMs)
    && input.effectiveStartMs <= input.cohortFrozenAtMs) {
    blockers.push('COHORT_NOT_PROSPECTIVE');
  }

  if (blockers.length > 0) {
    throw new Error(`PUBLIC_ONLY_PARTIAL_FILL_V3_COHORT_BLOCKED:${[...new Set(blockers)].join(',')}`);
  }

  const body = Object.freeze({
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_V3_PROSPECTIVE_COHORT_VERSION,
    kind: 'IMMUTABLE_PROSPECTIVE_PUBLIC_ONLY_PARTIAL_FILL_V3_COHORT' as const,
    cohortIdentity: input.cohortIdentity.trim(),
    cohortVersion: input.cohortVersion.trim(),
    cohortFrozenAtMs: input.cohortFrozenAtMs,
    effectiveStartMs: input.effectiveStartMs,
    methodologyIdentity: methodology.methodologyIdentity,
    methodologyVersion: methodology.methodologyVersion,
    methodologyDigest: methodology.methodologyDigest,
    sourceClass: 'FORWARD_NATURAL_SAMPLE' as const,
    predecessorV2MutationAllowed: false as const,
    retrospectiveCreditAllowed: false as const,
    replayCreditAllowed: false as const,
    backfillCreditAllowed: false as const,
    manualCreditAllowed: false as const,
    syntheticCreditAllowed: false as const,
    actualExecutionTruthStatus: 'UNKNOWN_UNTIL_OBSERVED' as const,
    modeledEvidenceAuthority: 'RESEARCH_ONLY_NON_ECONOMIC' as const,
    existingNumericCriteriaRelaxed: false as const,
    profitabilityCredit: 0 as const,
    evidenceComplete: 0 as const,
    executionAuthority: 'NONE' as const,
  });
  return Object.freeze({
    ...body,
    cohortDigest: computePublicForwardPartialFillV3CohortDigest(body),
  });
}

function blocked(...codes: string[]): PublicForwardPartialFillV3ModeledObservationResult {
  return Object.freeze({
    status: 'BLOCKED_DATA' as const,
    blockers: Object.freeze([...new Set(codes)]),
    record: null,
  });
}

export function buildPublicForwardPartialFillV3ModeledObservation(input: Readonly<{
  observation: PublicForwardPartialFillCalibrationObservation;
  methodology: PublicForwardPartialFillV3ProspectiveMethodology;
  cohort: PublicForwardPartialFillV3ProspectiveCohort;
}>): PublicForwardPartialFillV3ModeledObservationResult {
  const observation = input?.observation;
  const methodology = input?.methodology;
  const cohort = input?.cohort;
  const blockers: string[] = [];

  if (!methodology
    || methodology.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_V3_PROSPECTIVE_METHODOLOGY_VERSION
    || !exactDigest(methodology.methodologyDigest)
    || computePublicForwardPartialFillV3MethodologyDigest(methodology) !== methodology.methodologyDigest) {
    blockers.push('METHODOLOGY_BINDING_INVALID');
  }
  if (!cohort
    || cohort.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_V3_PROSPECTIVE_COHORT_VERSION
    || !exactDigest(cohort.cohortDigest)
    || computePublicForwardPartialFillV3CohortDigest(cohort) !== cohort.cohortDigest
    || cohort.methodologyDigest !== methodology?.methodologyDigest) {
    blockers.push('COHORT_BINDING_INVALID');
  }
  if (!observation
    || observation.evidenceClass !== 'PUBLIC_FORWARD_SIMULATION_OBSERVATION'
    || observation.sourceType !== 'PUBLIC_FORWARD_SIMULATION'
    || observation.sampleClass !== 'FORWARD_NATURAL_SAMPLE') {
    blockers.push('GENUINE_FORWARD_PUBLIC_SAMPLE_REQUIRED');
  }
  if (observation && cohort
    && (observation.windowStartMs < cohort.effectiveStartMs
      || observation.observedAtMs < cohort.effectiveStartMs)) {
    blockers.push('PRE_COHORT_EVIDENCE_FORBIDDEN');
  }
  if (observation?.actualFillObserved !== false
    || observation?.actualFillFraction !== null
    || observation?.queuePositionKnown !== false
    || observation?.partialFillCostPercent !== null) {
    blockers.push('PUBLIC_ONLY_ACTUAL_EXECUTION_CLAIM_FORBIDDEN');
  }
  if (observation
    && (observation.forwardCalibrationSampleCredit !== 1
      || observation.historicalBackfillCredit !== 0
      || observation.testFixtureCredit !== 0
      || observation.naturalEntryCredit !== 0
      || observation.runtimeCostCredit !== 0
      || observation.calibrationArtifactProduced !== false
      || observation.calibrationSampleSufficient !== false
      || observation.partialFillStatus !== 'BLOCKED_DATA'
      || observation.fullCostReady !== false
      || observation.privateApiUsed !== false
      || observation.executionAuthority !== 'NONE'
      || observation.liveTrading !== false
      || observation.orderSubmitted !== false)) {
    blockers.push('SOURCE_ECONOMIC_OR_EXECUTION_CREDIT_FORBIDDEN');
  }
  if (!finiteNonNegative(observation?.opportunityFillRatioUpperBound)
    || Number(observation?.opportunityFillRatioUpperBound) > 1
    || !finiteNonNegative(observation?.eligiblePublicTouchQuantityUpperBound)
    || !finitePositive(observation?.passiveLimitPrice)) {
    blockers.push('MODELED_PUBLIC_BOUND_INVALID');
  }
  if (!nonEmpty(observation?.observationId) || !exactDigest(observation?.sourceObservationLineageDigest)) {
    blockers.push('SOURCE_PROVENANCE_INVALID');
  }

  if (blockers.length > 0) return blocked(...blockers);

  const body = Object.freeze({
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_V3_MODELED_OBSERVATION_VERSION,
    cohortIdentity: cohort.cohortIdentity,
    cohortDigest: cohort.cohortDigest,
    methodologyIdentity: methodology.methodologyIdentity,
    methodologyDigest: methodology.methodologyDigest,
    observationId: observation.observationId,
    sourceObservationLineageDigest: observation.sourceObservationLineageDigest,
    market: observation.market,
    symbol: observation.symbol,
    side: observation.side,
    quantityNotionalBucketIdentity: observation.quantityNotionalBucketIdentity,
    windowStartMs: observation.windowStartMs,
    observedAtMs: observation.observedAtMs,
    modeledPublicEvidence: Object.freeze({
      evidenceClass: 'MODELED_PUBLIC_ONLY' as const,
      modelIdentity: methodology.modeledLane.modelIdentity,
      modelVersion: methodology.modeledLane.modelVersion,
      modelDigest: methodology.modeledLane.modelDigest,
      opportunityFillRatioUpperBound: observation.opportunityFillRatioUpperBound,
      eligiblePublicTouchQuantityUpperBound: observation.eligiblePublicTouchQuantityUpperBound,
      passiveLimitPrice: observation.passiveLimitPrice,
    }),
    actualExecutionTruth: Object.freeze({
      status: 'UNKNOWN_PUBLIC_ONLY' as const,
      actualFillObserved: false as const,
      actualFillFraction: null,
      queuePositionKnown: false as const,
      partialFillCostPercent: null,
      actualAllInCostPresent: false as const,
      settlementEvidencePresent: false as const,
    }),
    modeledEvidenceMayBecomeActualEvidence: false as const,
    modeledEvidenceMaySatisfyActualExecutionGates: false as const,
    prospectiveModeledObservationCredit: 1 as const,
    actualExecutionEvidenceCredit: 0 as const,
    economicCreditCreated: false as const,
    profitabilityCredit: 0 as const,
    fullCostReady: false as const,
    evidenceComplete: 0 as const,
    executionAuthority: 'NONE' as const,
  });
  const record = Object.freeze({ ...body, recordDigest: digest(body) });
  return Object.freeze({
    status: 'ADMITTED_MODELED_ONLY' as const,
    blockers: Object.freeze([]),
    record,
  });
}

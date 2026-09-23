import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
  type PublicForwardPartialFillCalibrationObservation,
} from './public-forward-partial-fill-calibration-collector.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY,
  PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES,
  PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY,
  buildPublicForwardPartialFillV3ModeledObservation,
  buildPublicForwardPartialFillV3ProspectiveCohort,
  buildPublicForwardPartialFillV3ProspectiveMethodology,
  computePublicForwardPartialFillV3CohortDigest,
  computePublicForwardPartialFillV3MethodologyDigest,
  type PublicForwardPartialFillV3FrozenRef,
} from './public-forward-partial-fill-v3-prospective-methodology.service';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const METHODOLOGY_FROZEN_AT = 10_000;
const COHORT_FROZEN_AT = 11_000;
const EFFECTIVE_START = 12_000;

function frozenRef(identity: string, frozenAtMs = 1_000): PublicForwardPartialFillV3FrozenRef {
  return Object.freeze({
    identity,
    version: 'v1',
    digest: sha256(identity),
    frozenAtMs,
    status: 'FROZEN' as const,
  });
}

function exactComponentRef(
  name: keyof typeof PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES,
  frozenAtMs = 1_000,
): PublicForwardPartialFillV3FrozenRef {
  const authority = PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES[name];
  return Object.freeze({
    identity: authority.identity,
    version: authority.version,
    digest: authority.digest,
    frozenAtMs,
    status: 'FROZEN' as const,
  });
}

function predecessorV2(frozenAtMs = 1_000) {
  const authority = PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY;
  return Object.freeze({
    identity: authority.authorityIdentity,
    version: authority.authorityVersion,
    digest: authority.cohortDigest,
    frozenAtMs,
    status: 'FROZEN' as const,
    policyDigest: authority.policyDigest,
    cohortDigest: authority.cohortDigest,
    totalSlotN: authority.totalSlotN,
    trainSlotN: authority.trainSlotN,
    validationSlotN: authority.validationSlotN,
    oosSlotN: authority.oosSlotN,
    perScopeEffectiveIndependentMinimum: authority.perScopeEffectiveIndependentMinimum,
    scopeCellCount: authority.scopeCellCount,
    mechanicalFloorEffectiveIndependent: authority.mechanicalFloorEffectiveIndependent,
  });
}

function methodology() {
  return buildPublicForwardPartialFillV3ProspectiveMethodology({
    methodologyIdentity: 'TEST_ONLY_PUBLIC_ONLY_PARTIAL_FILL_V3',
    methodologyVersion: 'v3-test',
    methodologyFrozenAtMs: METHODOLOGY_FROZEN_AT,
    predecessorV2: predecessorV2(),
    businessTolerance: exactComponentRef('businessTolerance'),
    statisticalMethodology: exactComponentRef('statisticalMethodology'),
    numericMinimumArtifact: exactComponentRef('numericMinimumArtifact'),
    scopeUniverse: exactComponentRef('scopeUniverse'),
    modeledLane: {
      evidenceClass: 'MODELED_PUBLIC_ONLY',
      modelIdentity: 'TEST_ONLY_OPPORTUNITY_BOUND_MODEL',
      modelVersion: 'v1',
      modelDigest: sha256('TEST_ONLY_OPPORTUNITY_BOUND_MODEL'),
      modelFrozenAtMs: 9_000,
      conservativeOpportunityBoundOnly: true,
      actualExecutionSubstitutionAllowed: false,
      actualFillInferenceAllowed: false,
      queuePositionInferenceAllowed: false,
    },
  });
}

function cohort() {
  return buildPublicForwardPartialFillV3ProspectiveCohort({
    cohortIdentity: 'TEST_ONLY_PUBLIC_ONLY_PARTIAL_FILL_V3_COHORT',
    cohortVersion: 'v1',
    cohortFrozenAtMs: COHORT_FROZEN_AT,
    effectiveStartMs: EFFECTIVE_START,
    methodology: methodology(),
  });
}

function observation(
  overrides: Partial<PublicForwardPartialFillCalibrationObservation> = {},
): PublicForwardPartialFillCalibrationObservation {
  return {
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_SIMULATION_OBSERVATION',
    sourceType: 'PUBLIC_FORWARD_SIMULATION',
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    observationId: 'partial-fill-v3-observation-1',
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantityNotionalBucketIdentity: 'BTCUSDT-LONG-QTY-2',
    collectorCodeSha: 'a'.repeat(40),
    windowStartMs: EFFECTIVE_START + 1_000,
    windowEndMs: EFFECTIVE_START + 1_100,
    observedAtMs: EFFECTIVE_START + 1_200,
    passiveLimitPrice: 100,
    requestedQuantity: 2,
    eligiblePublicTouchQuantityUpperBound: 1,
    opportunityFillRatioUpperBound: 0.5,
    eligiblePublicExecutionIds: ['exec-1'],
    actualFillFraction: null,
    actualFillObserved: false,
    queuePositionKnown: false,
    partialFillCostPercent: null,
    sourceIdentity: 'BITGET_PUBLIC_FORWARD_PASSIVE_QUEUE_OPPORTUNITY_V1',
    sourceDigest: sha256('source-1'),
    sourceObservationLineageId: 'lineage-1',
    sourceObservationLineageDigest: sha256('lineage-1'),
    preEventBookDigest: sha256('pre-1'),
    forwardPublicFillsDigest: sha256('fills-1'),
    postEventBookDigest: sha256('post-1'),
    endpoints: ['/api/v3/market/orderbook', '/api/v3/market/fills'],
    forwardCalibrationSampleCredit: 1,
    historicalBackfillCredit: 0,
    testFixtureCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    calibrationArtifactProduced: false,
    durablePersistencePerformed: false,
    calibrationSampleSufficient: false,
    partialFillStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    privateApiUsed: false,
    executionAuthority: 'NONE',
    liveTrading: false,
    orderSubmitted: false,
    ...overrides,
  };
}

test('builds immutable V3 methodology by reference without relaxing predecessor criteria', () => {
  const value = methodology();
  assert.equal(value.predecessorV2MutationAllowed, false);
  assert.equal(value.existingNumericCriteriaRelaxed, false);
  assert.equal(value.modeledEvidenceAuthority, 'RESEARCH_ONLY_NON_ECONOMIC');
  assert.equal(value.actualExecutionTruthRequirement, 'REMAINS_REQUIRED_FOR_ACTUAL_EXECUTION_GATES');
  assert.equal(value.profitabilityCredit, 0);
  assert.equal(value.evidenceComplete, 0);
  assert.equal(value.executionAuthority, 'NONE');
  assert.equal(value.methodologyDigest, computePublicForwardPartialFillV3MethodologyDigest(value));
  assert.equal(Object.isFrozen(value), true);
});

test('rejects any predecessor V2 digest or numeric-criteria drift', () => {
  const base = predecessorV2();
  assert.throws(() => buildPublicForwardPartialFillV3ProspectiveMethodology({
    methodologyIdentity: 'TEST_ONLY_PUBLIC_ONLY_PARTIAL_FILL_V3',
    methodologyVersion: 'v3-test',
    methodologyFrozenAtMs: METHODOLOGY_FROZEN_AT,
    predecessorV2: {
      ...base,
      policyDigest: sha256('tampered-v2-policy'),
      totalSlotN: 1025,
    },
    businessTolerance: exactComponentRef('businessTolerance'),
    statisticalMethodology: exactComponentRef('statisticalMethodology'),
    numericMinimumArtifact: exactComponentRef('numericMinimumArtifact'),
    scopeUniverse: exactComponentRef('scopeUniverse'),
    modeledLane: {
      evidenceClass: 'MODELED_PUBLIC_ONLY',
      modelIdentity: 'TEST_ONLY_OPPORTUNITY_BOUND_MODEL',
      modelVersion: 'v1',
      modelDigest: sha256('TEST_ONLY_OPPORTUNITY_BOUND_MODEL'),
      modelFrozenAtMs: 9_000,
      conservativeOpportunityBoundOnly: true,
      actualExecutionSubstitutionAllowed: false,
      actualFillInferenceAllowed: false,
      queuePositionInferenceAllowed: false,
    },
  }), /PREDECESSOR_V2_AUTHORITY_DIGEST_MISMATCH.*PREDECESSOR_V2_NUMERIC_CRITERIA_MISMATCH/);
});

test('rejects frozen component identity or digest substitution', () => {
  assert.throws(() => buildPublicForwardPartialFillV3ProspectiveMethodology({
    methodologyIdentity: 'TEST_ONLY_PUBLIC_ONLY_PARTIAL_FILL_V3',
    methodologyVersion: 'v3-test',
    methodologyFrozenAtMs: METHODOLOGY_FROZEN_AT,
    predecessorV2: predecessorV2(),
    businessTolerance: {
      ...exactComponentRef('businessTolerance'),
      digest: sha256('tampered-business-tolerance'),
    },
    statisticalMethodology: exactComponentRef('statisticalMethodology'),
    numericMinimumArtifact: exactComponentRef('numericMinimumArtifact'),
    scopeUniverse: exactComponentRef('scopeUniverse'),
    modeledLane: {
      evidenceClass: 'MODELED_PUBLIC_ONLY',
      modelIdentity: 'TEST_ONLY_OPPORTUNITY_BOUND_MODEL',
      modelVersion: 'v1',
      modelDigest: sha256('TEST_ONLY_OPPORTUNITY_BOUND_MODEL'),
      modelFrozenAtMs: 9_000,
      conservativeOpportunityBoundOnly: true,
      actualExecutionSubstitutionAllowed: false,
      actualFillInferenceAllowed: false,
      queuePositionInferenceAllowed: false,
    },
  }), /BUSINESSTOLERANCE_EXACT_FROZEN_AUTHORITY_MISMATCH/);
});

test('rejects V3 methodology when a frozen authority is newer than methodology freeze', () => {
  assert.throws(() => buildPublicForwardPartialFillV3ProspectiveMethodology({
    methodologyIdentity: 'TEST_ONLY_PUBLIC_ONLY_PARTIAL_FILL_V3',
    methodologyVersion: 'v3-test',
    methodologyFrozenAtMs: METHODOLOGY_FROZEN_AT,
    predecessorV2: predecessorV2(),
    businessTolerance: exactComponentRef('businessTolerance'),
    statisticalMethodology: exactComponentRef('statisticalMethodology'),
    numericMinimumArtifact: exactComponentRef('numericMinimumArtifact', METHODOLOGY_FROZEN_AT + 1),
    scopeUniverse: exactComponentRef('scopeUniverse'),
    modeledLane: {
      evidenceClass: 'MODELED_PUBLIC_ONLY',
      modelIdentity: 'TEST_ONLY_OPPORTUNITY_BOUND_MODEL',
      modelVersion: 'v1',
      modelDigest: sha256('TEST_ONLY_OPPORTUNITY_BOUND_MODEL'),
      modelFrozenAtMs: 9_000,
      conservativeOpportunityBoundOnly: true,
      actualExecutionSubstitutionAllowed: false,
      actualFillInferenceAllowed: false,
      queuePositionInferenceAllowed: false,
    },
  }), /NUMERIC_MINIMUM_ARTIFACT_FROZEN_AFTER_METHODOLOGY/);
});

test('rejects modeled lane that attempts to infer actual fill or queue position', () => {
  assert.throws(() => buildPublicForwardPartialFillV3ProspectiveMethodology({
    methodologyIdentity: 'TEST_ONLY_PUBLIC_ONLY_PARTIAL_FILL_V3',
    methodologyVersion: 'v3-test',
    methodologyFrozenAtMs: METHODOLOGY_FROZEN_AT,
    predecessorV2: predecessorV2(),
    businessTolerance: exactComponentRef('businessTolerance'),
    statisticalMethodology: exactComponentRef('statisticalMethodology'),
    numericMinimumArtifact: exactComponentRef('numericMinimumArtifact'),
    scopeUniverse: exactComponentRef('scopeUniverse'),
    modeledLane: {
      evidenceClass: 'MODELED_PUBLIC_ONLY',
      modelIdentity: 'TEST_ONLY_OPPORTUNITY_BOUND_MODEL',
      modelVersion: 'v1',
      modelDigest: sha256('TEST_ONLY_OPPORTUNITY_BOUND_MODEL'),
      modelFrozenAtMs: 9_000,
      conservativeOpportunityBoundOnly: true,
      actualExecutionSubstitutionAllowed: false,
      actualFillInferenceAllowed: true,
      queuePositionInferenceAllowed: false,
    } as never,
  }), /MODELED_LANE_POLICY_INVALID/);
});

test('builds a strictly prospective cohort and preserves zero economic authority', () => {
  const value = cohort();
  assert.equal(value.sourceClass, 'FORWARD_NATURAL_SAMPLE');
  assert.equal(value.predecessorV2MutationAllowed, false);
  assert.equal(value.retrospectiveCreditAllowed, false);
  assert.equal(value.replayCreditAllowed, false);
  assert.equal(value.backfillCreditAllowed, false);
  assert.equal(value.manualCreditAllowed, false);
  assert.equal(value.syntheticCreditAllowed, false);
  assert.equal(value.actualExecutionTruthStatus, 'UNKNOWN_UNTIL_OBSERVED');
  assert.equal(value.modeledEvidenceAuthority, 'RESEARCH_ONLY_NON_ECONOMIC');
  assert.equal(value.existingNumericCriteriaRelaxed, false);
  assert.equal(value.profitabilityCredit, 0);
  assert.equal(value.evidenceComplete, 0);
  assert.equal(value.executionAuthority, 'NONE');
  assert.equal(value.cohortDigest, computePublicForwardPartialFillV3CohortDigest(value));
});

test('rejects cohort start at or before the freeze boundary', () => {
  assert.throws(() => buildPublicForwardPartialFillV3ProspectiveCohort({
    cohortIdentity: 'TEST_ONLY_PUBLIC_ONLY_PARTIAL_FILL_V3_COHORT',
    cohortVersion: 'v1',
    cohortFrozenAtMs: COHORT_FROZEN_AT,
    effectiveStartMs: COHORT_FROZEN_AT,
    methodology: methodology(),
  }), /COHORT_NOT_PROSPECTIVE/);
});

test('admits genuine future public observation only to modeled research lane', () => {
  const result = buildPublicForwardPartialFillV3ModeledObservation({
    observation: observation(),
    methodology: methodology(),
    cohort: cohort(),
  });
  assert.equal(result.status, 'ADMITTED_MODELED_ONLY');
  assert.deepEqual(result.blockers, []);
  assert.ok(result.record);
  assert.equal(result.record.modeledPublicEvidence.evidenceClass, 'MODELED_PUBLIC_ONLY');
  assert.equal(result.record.modeledPublicEvidence.opportunityFillRatioUpperBound, 0.5);
  assert.equal(result.record.actualExecutionTruth.status, 'UNKNOWN_PUBLIC_ONLY');
  assert.equal(result.record.actualExecutionTruth.actualFillObserved, false);
  assert.equal(result.record.actualExecutionTruth.actualFillFraction, null);
  assert.equal(result.record.actualExecutionTruth.queuePositionKnown, false);
  assert.equal(result.record.actualExecutionTruth.partialFillCostPercent, null);
  assert.equal(result.record.actualExecutionTruth.actualAllInCostPresent, false);
  assert.equal(result.record.actualExecutionTruth.settlementEvidencePresent, false);
  assert.equal(result.record.modeledEvidenceMayBecomeActualEvidence, false);
  assert.equal(result.record.modeledEvidenceMaySatisfyActualExecutionGates, false);
  assert.equal(result.record.prospectiveModeledObservationCredit, 1);
  assert.equal(result.record.actualExecutionEvidenceCredit, 0);
  assert.equal(result.record.economicCreditCreated, false);
  assert.equal(result.record.profitabilityCredit, 0);
  assert.equal(result.record.fullCostReady, false);
  assert.equal(result.record.evidenceComplete, 0);
  assert.equal(result.record.executionAuthority, 'NONE');
  assert.match(result.record.recordDigest, /^[a-f0-9]{64}$/);
});

test('pre-cohort public observations never receive V3 modeled credit', () => {
  const result = buildPublicForwardPartialFillV3ModeledObservation({
    observation: observation({
      windowStartMs: EFFECTIVE_START - 1,
      windowEndMs: EFFECTIVE_START + 50,
      observedAtMs: EFFECTIVE_START + 100,
    }),
    methodology: methodology(),
    cohort: cohort(),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.record, null);
  assert.ok(result.blockers.includes('PRE_COHORT_EVIDENCE_FORBIDDEN'));
});

test('public-only V3 refuses attempted actual fill, queue or partial-fill-cost promotion', () => {
  const cases: Array<Partial<PublicForwardPartialFillCalibrationObservation>> = [
    { actualFillObserved: true as never, actualFillFraction: 0.5 as never },
    { queuePositionKnown: true as never },
    { partialFillCostPercent: 0 as never },
  ];
  for (const mutation of cases) {
    const result = buildPublicForwardPartialFillV3ModeledObservation({
      observation: observation(mutation),
      methodology: methodology(),
      cohort: cohort(),
    });
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.ok(result.blockers.includes('PUBLIC_ONLY_ACTUAL_EXECUTION_CLAIM_FORBIDDEN'));
    assert.equal(result.record, null);
  }
});

test('non-natural, replay-like sample class cannot enter the prospective V3 lane', () => {
  const result = buildPublicForwardPartialFillV3ModeledObservation({
    observation: observation({ sampleClass: 'CALIBRATION_RESEARCH_SAMPLE' }),
    methodology: methodology(),
    cohort: cohort(),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('GENUINE_FORWARD_PUBLIC_SAMPLE_REQUIRED'));
});

test('safety contract forbids V2 mutation, evidence promotion and economic authority', () => {
  assert.equal(
    PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES.businessTolerance.digest,
    'adef3bbf8f6647f0314a35ca5b0d48eebefed614a0e66ab28e93f6d3dc2a0f7c',
  );
  assert.equal(
    PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES.statisticalMethodology.digest,
    '1b60b2f3719556b14d8d360a25f2043f5e45b0c24089c1636f3d66d784801308',
  );
  assert.equal(
    PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES.scopeUniverse.digest,
    '55bbbf79b89040bffe7485b48b97fa56d6175a0796d72dfb8985d1923d64e244',
  );
  assert.equal(
    PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES.numericMinimumArtifact.digest,
    '8c3ded9d0862b9c81f04a466fb6d4df03ee39185cc1f59bc08c41923231b8e29',
  );
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.totalSlotN, 1024);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.trainSlotN, 512);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.validationSlotN, 256);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.oosSlotN, 256);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.perScopeEffectiveIndependentMinimum, 178);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.scopeCellCount, 4);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.mechanicalFloorEffectiveIndependent, 712);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.publicOnly, true);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.predecessorV2MutationAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.predecessorEvidenceRewriteAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.actualFillInferenceAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.queuePositionInferenceAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.modeledEvidenceMayBecomeActualEvidence, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.existingNumericCriteriaRelaxationAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.profitabilityCredit, 0);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.fullCostReady, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.evidenceComplete, 0);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.privateApiAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.liveTrading, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_V3_SAFETY.realOrderEnabled, false);
});

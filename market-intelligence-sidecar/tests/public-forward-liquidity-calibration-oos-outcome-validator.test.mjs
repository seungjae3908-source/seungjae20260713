import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
} from '../src/public-forward-liquidity-calibration.mjs';
import { PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_VERSION } from '../src/public-forward-liquidity-calibration-split-audit.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_AUDIT_VERSION,
} from '../src/public-forward-liquidity-multi-source-split-audit.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_OOS_VALIDATION_VERSION,
  PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY,
  computePublicForwardLiquidityOosMethodologyDigest,
  validatePublicForwardLiquidityOosOutcomes,
} from '../src/public-forward-liquidity-calibration-oos-outcome-validator.mjs';

const hex = (value) => value.repeat(64).slice(0, 64);
const PRODUCER_SHA = 'a'.repeat(40);
const COLLECTOR_A_SHA = 'b'.repeat(40);
const COLLECTOR_B_SHA = 'c'.repeat(40);

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

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function legacyAssignment(id, split, eventTimestampMs, digit) {
  return {
    observationId: id,
    sourceDigest: hex(digit),
    publicExecutionId: `exec-${id}`,
    eventTimestampMs,
    split,
    scopeKey: 'CRYPTO_FUTURES|BTCUSDT|BUY|bucket-1|VOL_NORMAL|LIQ_NORMAL',
    quantityNotionalBucketIdentity: 'bucket-1',
    scopeEvidenceIdentity: `scope-${id}`,
    scopeEvidenceDigest: hex(String(Number(digit) + 3)),
    volatilityRegimeIdentity: 'VOL_NORMAL',
    liquidityRegimeIdentity: 'LIQ_NORMAL',
    regimeEvidenceIdentity: `regime-${id}`,
    regimeEvidenceDigest: hex(String(Number(digit) + 6)),
  };
}

function legacySplitAudit(overrides = {}) {
  const assignments = [
    legacyAssignment('obs-train', 'TRAIN', 1_000, '1'),
    legacyAssignment('obs-validation', 'VALIDATION', 2_000, '2'),
    legacyAssignment('obs-oos', 'OOS', 3_000, '3'),
  ];
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_VERSION,
    datasetContract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    datasetStoreContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    datasetDigest: hex('d'),
    collectorCodeSha: COLLECTOR_A_SHA,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    splitPolicyIdentity: 'liquidity-forward-split-policy-v1',
    splitPolicyVersion: 'v1',
    splitPolicyDigest: hex('e'),
    splitPolicyFrozenAtMs: 900,
    scopeOwnerIdentity: 'canonical-liquidity-scope-owner',
    scopePolicyIdentity: 'canonical-liquidity-scope-policy-v1',
    scopePolicyDigest: hex('f'),
    regimeOwnerIdentity: 'canonical-regime-owner',
    regimePolicyIdentity: 'canonical-regime-policy-v1',
    regimePolicyDigest: hex('c'),
    totalObservationCount: 3,
    counts: { train: 1, validation: 1, oos: 1 },
    assignments,
    assignmentDigest: sha256(assignments),
    scopeCounts: [],
    sampleDeficits: [],
    regimeScopeComplete: true,
    splitAssignmentComplete: true,
    calibrationSampleSufficient: true,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    fullCostReady: false,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    ...overrides,
  };
  if (overrides.assignments) body.assignmentDigest = sha256(body.assignments);
  return { ...body, auditDigest: sha256(body) };
}

function upstreamSource({ key, collectorCodeSha, digit }) {
  return {
    sourceIdentity: `bound-source:${key}`,
    producerCodeSha: PRODUCER_SHA,
    collectorCodeSha,
    collectorImplementationPath: 'market-intelligence-sidecar/src/public-forward-liquidity-calibration.mjs',
    collectorImplementationBlobSha: String(digit).repeat(40),
    datasetDigest: hex(String(digit)),
    datasetRelativePath: `forward/liquidity/${key}/dataset.json`,
    receiptDigest: hex(String(Number(digit) + 1)),
    artifactId: String(1000 + Number(digit)),
    artifactDigest: hex(String(Number(digit) + 2)),
    rawBatchDigest: hex(String(Number(digit) + 3)),
  };
}

function multiAssignment({ id, split, eventTimestampMs, digit, source }) {
  return {
    observationId: `bound-${id}`,
    sourceObservationId: id,
    sourceIdentity: source.sourceIdentity,
    sourceDatasetDigest: source.datasetDigest,
    sourceReceiptDigest: source.receiptDigest,
    sourceCollectorCodeSha: source.collectorCodeSha,
    sourceDigest: hex(String(Number(digit) + 4)),
    eventIdentity: `public-event:${id}`,
    sourceFrameIdentity: `source-frame:${id}`,
    publicExecutionId: `exec-${id}`,
    eventTimestampMs,
    split,
    scopeKey: 'CRYPTO_FUTURES|BTCUSDT|BUY|bucket-1|VOL_NORMAL|LIQ_NORMAL',
    quantityNotionalBucketIdentity: 'bucket-1',
    scopeEvidenceIdentity: `scope-${id}`,
    scopeEvidenceDigest: hex(String(Number(digit) + 5)),
    volatilityRegimeIdentity: 'VOL_NORMAL',
    liquidityRegimeIdentity: 'LIQ_NORMAL',
    regimeEvidenceIdentity: `regime-${id}`,
    regimeEvidenceDigest: hex(String(Number(digit) + 6)),
  };
}

function multiSourceSplitAudit(overrides = {}) {
  const sourceA = upstreamSource({ key: 'a', collectorCodeSha: COLLECTOR_A_SHA, digit: 1 });
  const sourceB = upstreamSource({ key: 'b', collectorCodeSha: COLLECTOR_B_SHA, digit: 7 });
  const upstreamSources = [sourceA, sourceB].sort((left, right) => left.sourceIdentity.localeCompare(right.sourceIdentity));
  const assignments = [
    multiAssignment({ id: 'obs-train', split: 'TRAIN', eventTimestampMs: 1_000, digit: 1, source: sourceA }),
    multiAssignment({ id: 'obs-validation', split: 'VALIDATION', eventTimestampMs: 2_000, digit: 2, source: sourceA }),
    multiAssignment({ id: 'obs-oos', split: 'OOS', eventTimestampMs: 3_000, digit: 3, source: sourceB }),
  ];
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_AUDIT_VERSION,
    independentSplitSourceVersion: 'public-forward-liquidity-independent-split-source-v1',
    independentSplitSourceDigest: hex('a'),
    independenceAuditDigest: hex('b'),
    producerCodeSha: PRODUCER_SHA,
    datasetContract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    datasetStoreContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    upstreamSources,
    upstreamLineageDigest: sha256(upstreamSources),
    datasetDigests: upstreamSources.map((source) => source.datasetDigest),
    receiptDigests: upstreamSources.map((source) => source.receiptDigest),
    collectorCodeShas: [...new Set(upstreamSources.map((source) => source.collectorCodeSha))].sort(),
    splitPolicyIdentity: 'liquidity-forward-multi-source-split-policy-v2',
    splitPolicyVersion: 'v2',
    splitPolicyDigest: hex('e'),
    splitPolicyFrozenAtMs: 900,
    scopeOwnerIdentity: 'canonical-liquidity-scope-owner',
    scopePolicyIdentity: 'canonical-liquidity-scope-policy-v1',
    scopePolicyDigest: hex('f'),
    regimeOwnerIdentity: 'canonical-regime-owner',
    regimePolicyIdentity: 'canonical-regime-policy-v1',
    regimePolicyDigest: hex('c'),
    totalObservationCount: 3,
    counts: { train: 1, validation: 1, oos: 1 },
    assignments,
    assignmentDigest: sha256(assignments),
    scopeCounts: [],
    sampleDeficits: [],
    regimeScopeComplete: true,
    splitAssignmentComplete: true,
    calibrationSampleSufficient: true,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    evidenceCompleteCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    fullCostReady: false,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    ...overrides,
  };
  if (overrides.upstreamSources) {
    const ordered = [...body.upstreamSources].sort((left, right) => left.sourceIdentity.localeCompare(right.sourceIdentity));
    body.upstreamSources = ordered;
    body.upstreamLineageDigest = sha256(ordered);
    body.datasetDigests = ordered.map((source) => source.datasetDigest);
    body.receiptDigests = ordered.map((source) => source.receiptDigest);
    body.collectorCodeShas = [...new Set(ordered.map((source) => source.collectorCodeSha))].sort();
  }
  if (overrides.assignments) body.assignmentDigest = sha256(body.assignments);
  return { ...body, auditDigest: sha256(body) };
}

function methodology(overrides = {}) {
  const body = {
    methodologyIdentity: 'liquidity-oos-public-market-outcome-v1',
    methodologyDigest: null,
    methodologyFrozenAtMs: 2_500,
    oosDataAccessBeforeFreeze: false,
    allowedCalibrationSplits: ['TRAIN', 'VALIDATION'],
    outcomeHorizonIdentity: 'PUBLIC_FORWARD_HORIZON_DECLARED_EXTERNALLY',
    ...overrides,
  };
  body.methodologyDigest = computePublicForwardLiquidityOosMethodologyDigest(body);
  return body;
}

function outcome(audit, method, overrides = {}) {
  const oos = audit.assignments.find((item) => item.split === 'OOS');
  const lineage = audit.schemaVersion === PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_AUDIT_VERSION
    ? {
      sourceIdentity: oos.sourceIdentity,
      sourceObservationId: oos.sourceObservationId,
      sourceDatasetDigest: oos.sourceDatasetDigest,
      sourceReceiptDigest: oos.sourceReceiptDigest,
      sourceCollectorCodeSha: oos.sourceCollectorCodeSha,
      upstreamLineageDigest: audit.upstreamLineageDigest,
      independenceAuditDigest: audit.independenceAuditDigest,
      independentSplitSourceDigest: audit.independentSplitSourceDigest,
    }
    : { datasetDigest: audit.datasetDigest };
  return {
    outcomeId: 'outcome-obs-oos',
    observationId: oos.observationId,
    referenceSourceDigest: oos.sourceDigest,
    publicExecutionId: oos.publicExecutionId,
    splitAuditDigest: audit.auditDigest,
    ...lineage,
    splitPolicyDigest: audit.splitPolicyDigest,
    scopeKey: oos.scopeKey,
    referenceEventTimestampMs: oos.eventTimestampMs,
    observedAtMs: 3_500,
    sourceType: 'PUBLIC_FORWARD_MARKET_DATA',
    publicDataSource: 'BITGET_PUBLIC_UTA_V3',
    outcomeSourceIdentity: 'bitget-public-forward-outcome-obs-oos',
    outcomeSourceDigest: hex('9'),
    outcomeProducerCodeSha: PRODUCER_SHA,
    observedPublicMidPrice: 101.25,
    methodologyIdentity: method.methodologyIdentity,
    methodologyDigest: method.methodologyDigest,
    methodologyFrozenAtMs: method.methodologyFrozenAtMs,
    outcomeHorizonIdentity: method.outcomeHorizonIdentity,
    heldOut: true,
    contaminationFree: true,
    causalMarketImpactClaim: false,
    executionCostEligible: false,
    liquidityImpactCoefficient: null,
    historicalBackfillCredit: 0,
    testFixtureCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    ...overrides,
  };
}

function validate({ audit = legacySplitAudit(), method = methodology(), outcomes } = {}) {
  return validatePublicForwardLiquidityOosOutcomes({
    splitAudit: audit,
    methodology: method,
    expectedOutcomeProducerCodeSha: PRODUCER_SHA,
    outcomes: outcomes ?? [outcome(audit, method)],
  });
}

test('legacy single-source held-out outcome remains accepted without producing liquidity cost', () => {
  const result = validate();
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.validation.oosValidationComplete, true);
  assert.equal(result.validation.liquidityImpactPresent, false);
  assert.equal(result.validation.liquidityImpactStatus, 'BLOCKED_DATA');
  assert.equal(result.validation.fullCostReady, false);
});

test('multi-source frozen split validates while preserving full source lineage', () => {
  const audit = multiSourceSplitAudit();
  const method = methodology();
  const result = validate({ audit, method, outcomes: [outcome(audit, method)] });
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.validation.schemaVersion, PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_OOS_VALIDATION_VERSION);
  assert.equal(result.validation.upstreamLineageDigest, audit.upstreamLineageDigest);
  assert.deepEqual(result.validation.datasetDigests, audit.datasetDigests);
  assert.deepEqual(result.validation.receiptDigests, audit.receiptDigests);
  assert.deepEqual(result.validation.collectorCodeShas, audit.collectorCodeShas);
  assert.equal(Object.hasOwn(result.validation, 'datasetDigest'), false);
  assert.equal(Object.hasOwn(result.validation, 'collectorCodeSha'), false);
  assert.equal(result.validation.syntheticAggregateDataset, false);
  assert.equal(result.validation.syntheticSingleCollector, false);
  assert.equal(result.validation.fullCostReady, false);
});

test('multi-source lineage tampering fails closed before OOS credit', () => {
  const audit = multiSourceSplitAudit();
  audit.datasetDigests = [hex('f')];
  audit.auditDigest = sha256(Object.fromEntries(Object.entries(audit).filter(([key]) => key !== 'auditDigest')));
  const method = methodology();
  const result = validate({ audit, method, outcomes: [outcome(audit, method)] });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('UPSTREAM_DATASET_DIGESTS_MISMATCH'));
});

test('multi-source outcome cannot smuggle a synthetic aggregate dataset digest', () => {
  const audit = multiSourceSplitAudit();
  const method = methodology();
  const invalid = outcome(audit, method, { datasetDigest: hex('f') });
  const result = validate({ audit, method, outcomes: [invalid] });
  assert.ok(result.blockers.includes('OOS_SYNTHETIC_AGGREGATE_DATASET_FORBIDDEN'));
});

test('multi-source assignment provenance must bind an authenticated upstream source', () => {
  const audit = multiSourceSplitAudit();
  audit.assignments = audit.assignments.map((item) => item.split === 'OOS'
    ? { ...item, sourceReceiptDigest: hex('f') }
    : item);
  audit.assignmentDigest = sha256(audit.assignments);
  audit.auditDigest = sha256(Object.fromEntries(Object.entries(audit).filter(([key]) => key !== 'auditDigest')));
  const method = methodology();
  const result = validate({ audit, method, outcomes: [outcome(audit, method)] });
  assert.ok(result.blockers.includes('OOS_ASSIGNMENT_SOURCE_LINEAGE_MISMATCH'));
});

test('tampered frozen assignment digest is rejected before OOS outcome credit', () => {
  const audit = legacySplitAudit();
  audit.assignments[2] = { ...audit.assignments[2], scopeKey: 'tampered-scope' };
  const method = methodology();
  const result = validate({ audit, method, outcomes: [outcome(audit, method)] });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('SPLIT_ASSIGNMENT_DIGEST_MISMATCH'));
  assert.ok(result.blockers.includes('SPLIT_AUDIT_DIGEST_MISMATCH'));
});

test('methodology must be frozen before OOS and forbid pre-freeze OOS access', () => {
  const late = methodology({ methodologyFrozenAtMs: 3_001 });
  assert.ok(validate({ method: late }).blockers.includes('OOS_METHODOLOGY_NOT_FROZEN_BEFORE_OOS'));
  const leaked = methodology({ oosDataAccessBeforeFreeze: true });
  assert.ok(validate({ method: leaked }).blockers.includes('OOS_PRE_FREEZE_DATA_ACCESS_FORBIDDEN'));
});

test('historical, causal-impact, cost, and coefficient authority all fail closed', () => {
  const audit = legacySplitAudit();
  const method = methodology();
  const invalid = outcome(audit, method, {
    sourceType: 'HISTORICAL_REPLAY',
    causalMarketImpactClaim: true,
    executionCostEligible: true,
    liquidityImpactCoefficient: 0.01,
    historicalBackfillCredit: 1,
    testFixtureCredit: 1,
    runtimeCostCredit: 1,
  });
  const result = validate({ audit, method, outcomes: [invalid] });
  for (const blocker of [
    'OOS_SOURCE_TYPE_INVALID',
    'OOS_CAUSAL_MARKET_IMPACT_CLAIM_FORBIDDEN',
    'OOS_EXECUTION_COST_CREDIT_FORBIDDEN',
    'OOS_LIQUIDITY_COEFFICIENT_FORBIDDEN',
    'OOS_NON_FORWARD_CREDIT_FORBIDDEN',
    'OOS_RUNTIME_CREDIT_FORBIDDEN',
  ]) assert.ok(result.blockers.includes(blocker));
});

test('only exact OOS assignment coverage is accepted', () => {
  const audit = legacySplitAudit({
    assignments: [
      legacyAssignment('obs-train', 'TRAIN', 1_000, '1'),
      legacyAssignment('obs-validation', 'VALIDATION', 2_000, '2'),
      legacyAssignment('obs-oos-1', 'OOS', 3_000, '3'),
      legacyAssignment('obs-oos-2', 'OOS', 4_000, '4'),
    ],
    totalObservationCount: 4,
    counts: { train: 1, validation: 1, oos: 2 },
  });
  const method = methodology();
  const one = outcome(audit, method, { outcomeId: 'outcome-one' });
  const result = validate({ audit, method, outcomes: [one] });
  assert.ok(result.blockers.includes('OOS_OUTCOME_MISSING'));
  assert.ok(result.blockers.includes('OOS_EXACT_COVERAGE_MISMATCH'));
});

test('safety contract keeps OOS validation evidence-only and rejects synthetic aggregation', () => {
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY.verifiedFrozenSplitAuditRequired, true);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY.multiSourceLineageRequired, true);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY.syntheticAggregateDatasetAllowed, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY.syntheticSingleCollectorAllowed, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY.privateApiAllowed, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY.liveTrading, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY.fullCostReady, false);
});

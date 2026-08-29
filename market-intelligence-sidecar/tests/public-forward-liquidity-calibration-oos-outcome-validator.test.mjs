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
  PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY,
  computePublicForwardLiquidityOosMethodologyDigest,
  validatePublicForwardLiquidityOosOutcomes,
} from '../src/public-forward-liquidity-calibration-oos-outcome-validator.mjs';

const hex = (value) => value.repeat(64).slice(0, 64);
const PRODUCER_SHA = 'a'.repeat(40);
const COLLECTOR_SHA = 'b'.repeat(40);

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

function assignment(id, split, eventTimestampMs, digit) {
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

function splitAudit(overrides = {}) {
  const assignments = [
    assignment('obs-train', 'TRAIN', 1_000, '1'),
    assignment('obs-validation', 'VALIDATION', 2_000, '2'),
    assignment('obs-oos', 'OOS', 3_000, '3'),
  ];
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_VERSION,
    datasetContract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    datasetStoreContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    datasetDigest: hex('d'),
    collectorCodeSha: COLLECTOR_SHA,
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
  return {
    outcomeId: 'outcome-obs-oos',
    observationId: oos.observationId,
    referenceSourceDigest: oos.sourceDigest,
    publicExecutionId: oos.publicExecutionId,
    splitAuditDigest: audit.auditDigest,
    datasetDigest: audit.datasetDigest,
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

function validate({ audit = splitAudit(), method = methodology(), outcomes } = {}) {
  return validatePublicForwardLiquidityOosOutcomes({
    splitAudit: audit,
    methodology: method,
    expectedOutcomeProducerCodeSha: PRODUCER_SHA,
    outcomes: outcomes ?? [outcome(audit, method)],
  });
}

test('genuine held-out PUBLIC_FORWARD_MARKET_DATA outcome validates without producing liquidity cost', () => {
  const result = validate();
  assert.equal(result.status, 'PRESENT');
  assert.deepEqual(result.blockers, []);
  assert.equal(result.validation.exactOosCoverage, true);
  assert.equal(result.validation.heldOut, true);
  assert.equal(result.validation.contaminationFree, true);
  assert.equal(result.validation.genuinePublicForwardMarketData, true);
  assert.equal(result.validation.oosValidationComplete, true);
  assert.equal(result.validation.calibrationArtifactProduced, false);
  assert.equal(result.validation.liquidityImpactPresent, false);
  assert.equal(result.validation.liquidityImpactStatus, 'BLOCKED_DATA');
  assert.equal(result.validation.naturalEntryCredit, 0);
  assert.equal(result.validation.runtimeCostCredit, 0);
  assert.equal(result.validation.fullCostReady, false);
});

test('tampered frozen split audit is rejected before OOS outcome credit', () => {
  const audit = splitAudit();
  audit.assignments[2] = { ...audit.assignments[2], scopeKey: 'tampered-scope' };
  const method = methodology();
  const result = validate({ audit, method, outcomes: [outcome(audit, method)] });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('SPLIT_ASSIGNMENT_DIGEST_MISMATCH'));
  assert.ok(result.blockers.includes('SPLIT_AUDIT_DIGEST_MISMATCH'));
});

test('methodology must be frozen before OOS and must declare no pre-freeze OOS access', () => {
  const late = methodology({ methodologyFrozenAtMs: 3_001 });
  const lateResult = validate({ method: late });
  assert.ok(lateResult.blockers.includes('OOS_METHODOLOGY_NOT_FROZEN_BEFORE_OOS'));

  const leaked = methodology({ oosDataAccessBeforeFreeze: true });
  const leakedResult = validate({ method: leaked });
  assert.ok(leakedResult.blockers.includes('OOS_PRE_FREEZE_DATA_ACCESS_FORBIDDEN'));
});

test('methodology calibration inputs are restricted to TRAIN and VALIDATION', () => {
  const method = methodology({ allowedCalibrationSplits: ['TRAIN', 'VALIDATION', 'OOS'] });
  const result = validate({ method });
  assert.ok(result.blockers.includes('OOS_CALIBRATION_SPLITS_INVALID'));
});

test('outcome must be observed after the credited public forward event', () => {
  const audit = splitAudit();
  const method = methodology();
  const result = validate({
    audit,
    method,
    outcomes: [outcome(audit, method, { observedAtMs: 3_000 })],
  });
  assert.ok(result.blockers.includes('OOS_OUTCOME_NOT_OBSERVED_AFTER_EVENT'));
});

test('historical, synthetic, causal-impact, cost, and coefficient authority all fail closed', () => {
  const audit = splitAudit();
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
  assert.ok(result.blockers.includes('OOS_SOURCE_TYPE_INVALID'));
  assert.ok(result.blockers.includes('OOS_CAUSAL_MARKET_IMPACT_CLAIM_FORBIDDEN'));
  assert.ok(result.blockers.includes('OOS_EXECUTION_COST_CREDIT_FORBIDDEN'));
  assert.ok(result.blockers.includes('OOS_LIQUIDITY_COEFFICIENT_FORBIDDEN'));
  assert.ok(result.blockers.includes('OOS_NON_FORWARD_CREDIT_FORBIDDEN'));
  assert.ok(result.blockers.includes('OOS_RUNTIME_CREDIT_FORBIDDEN'));
});

test('only exact OOS assignment coverage is accepted', () => {
  const audit = splitAudit({
    assignments: [
      assignment('obs-train', 'TRAIN', 1_000, '1'),
      assignment('obs-validation', 'VALIDATION', 2_000, '2'),
      assignment('obs-oos-1', 'OOS', 3_000, '3'),
      assignment('obs-oos-2', 'OOS', 4_000, '4'),
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

test('orphan and duplicate outcome source evidence cannot be cherry-picked into OOS', () => {
  const audit = splitAudit();
  const method = methodology();
  const valid = outcome(audit, method);
  const orphan = { ...valid, outcomeId: 'outcome-orphan', observationId: 'not-an-oos-observation' };
  const result = validate({ audit, method, outcomes: [valid, orphan] });
  assert.ok(result.blockers.includes('OOS_OUTCOME_ORPHAN'));
  assert.ok(result.blockers.includes('OOS_OUTCOME_SOURCE_DIGEST_REUSED'));
  assert.ok(result.blockers.includes('OOS_EXACT_COVERAGE_MISMATCH'));
});

test('safety contract keeps OOS validation evidence-only and execution disabled', () => {
  assert.deepEqual(PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_SAFETY, {
    verifiedFrozenSplitAuditRequired: true,
    exactOosCoverageRequired: true,
    genuinePublicForwardMarketDataRequired: true,
    methodologyFrozenBeforeOosRequired: true,
    oosDataAccessBeforeFreezeAllowed: false,
    historicalBackfillCreditAllowed: false,
    testFixtureRuntimeCreditAllowed: false,
    causalMarketImpactClaimAllowed: false,
    outcomeExecutionCostEligible: false,
    calibrationArtifactProduced: false,
    liquidityImpactProduced: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    orderSubmissionAllowed: false,
    fullCostReady: false,
  });
});

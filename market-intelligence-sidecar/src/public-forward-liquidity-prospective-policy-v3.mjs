import { createHash } from 'node:crypto';

import {
  CAPTURE_SELECTION_POLICY,
  CAPTURE_TRIGGER_TYPE,
  OOS_SELECTION_POLICY,
  buildProspectiveLiquidityPolicyArtifact as buildV2ProspectiveLiquidityPolicyArtifact,
} from './public-forward-liquidity-prospective-policy.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_V3_VERSION =
  'public-forward-liquidity-prospective-policy-v3';
export const PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_ARTIFACT_V3_VERSION =
  'public-forward-liquidity-prospective-policy-artifact-v3';
export const V3_COHORT_START_DELAY_MS = 24 * 60 * 60 * 1000;

const SHA256 = /^[a-f0-9]{64}$/u;
const SIDES = Object.freeze(['BUY', 'SELL']);
const SPLITS = Object.freeze(['train', 'validation', 'oos']);
const EXPECTED_OVERALL_MINIMUMS = Object.freeze({ train: 18, validation: 6, oos: 6 });
const EXPECTED_SIDE_MINIMUMS = Object.freeze({ train: 9, validation: 3, oos: 3 });
const EXPECTED_WINDOWS_MS = Object.freeze({
  train: 12 * 60 * 60 * 1000,
  validation: 6 * 60 * 60 * 1000,
  oos: 6 * 60 * 60 * 1000,
});
const EXPECTED_CAPTURE_INTERVAL_MS = 30 * 60 * 1000;
const EXPECTED_OUTCOME_HORIZON_MS = 60 * 1000;
const EXPECTED_REGIME_MAX_AGE_MS = 15 * 60 * 1000;

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

export function canonicalJsonV3(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256V3(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash('sha256').update(input).digest('hex');
}

function digestOf(value) {
  return sha256V3(canonicalJsonV3(value));
}

function exactSha(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) throw new Error('EXACT_HEAD_SHA_INVALID');
  return normalized;
}

function positiveTimestamp(value) {
  if (!Number.isInteger(value) || value <= 0) throw new Error('POLICY_FROZEN_AT_INVALID');
  return value;
}

function withoutDigest(value, digestField) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== digestField));
}

function stableEqual(left, right) {
  return canonicalJsonV3(left) === canonicalJsonV3(right);
}

export function buildProspectiveLiquidityPolicyV3Artifact({
  exactHeadSha,
  policyFrozenAtMs,
  symbol = 'BTCUSDT',
  cohortStartDelayMs = V3_COHORT_START_DELAY_MS,
} = {}) {
  const headSha = exactSha(exactHeadSha);
  const frozenAtMs = positiveTimestamp(policyFrozenAtMs);
  if (cohortStartDelayMs !== V3_COHORT_START_DELAY_MS) {
    throw new Error('V3_COHORT_START_DELAY_MUST_REMAIN_24H');
  }

  const carried = buildV2ProspectiveLiquidityPolicyArtifact({
    exactHeadSha: headSha,
    policyFrozenAtMs: frozenAtMs,
    symbol,
    cohortStartDelayMs,
    trainWindowMs: EXPECTED_WINDOWS_MS.train,
    validationWindowMs: EXPECTED_WINDOWS_MS.validation,
    oosWindowMs: EXPECTED_WINDOWS_MS.oos,
    outcomeHorizonMs: EXPECTED_OUTCOME_HORIZON_MS,
    maxRegimeEvidenceAgeMs: EXPECTED_REGIME_MAX_AGE_MS,
    captureIntervalMs: EXPECTED_CAPTURE_INTERVAL_MS,
    overallMinimums: EXPECTED_OVERALL_MINIMUMS,
    perSideMinimums: EXPECTED_SIDE_MINIMUMS,
  });

  const policyBody = {
    ...withoutDigest(carried.policy, 'policyDigest'),
    policyIdentity: `PUBLIC_FORWARD_LIQUIDITY_SPLIT_POLICY_V3:${headSha}`,
    policyVersion: '3',
  };
  const policy = Object.freeze({ ...policyBody, policyDigest: digestOf(policyBody) });

  const cohortBody = {
    ...withoutDigest(carried.cohort, 'cohortDigest'),
    schemaVersion: 'public-forward-liquidity-prospective-cohort-v3',
    cohortIdentity: `PUBLIC_FORWARD_LIQUIDITY_NEW_PROSPECTIVE_COHORT_V3:${headSha}`,
    policyVersion: '3',
    policyDigest: policy.policyDigest,
  };
  const cohort = Object.freeze({ ...cohortBody, cohortDigest: digestOf(cohortBody) });

  const artifactWithoutDigest = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_ARTIFACT_V3_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_FREEZE',
    contractVersion: PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_V3_VERSION,
    exactPolicyHeadSha: headSha,
    supersedes: Object.freeze({
      policyVersion: '2',
      reason: 'SUPERSEDED_BEFORE_FIRST_GENUINE_SAMPLE_SCHEDULE_SEAM_UNAVAILABLE',
      supersededBeforeFirstGenuineSample: true,
      priorProspectiveSampleCredit: 0,
    }),
    policy,
    scopePolicy: carried.scopePolicy,
    regimePolicy: carried.regimePolicy,
    captureSelectionPolicy: carried.captureSelectionPolicy,
    outcomeMethodology: carried.outcomeMethodology,
    cohort,
    carryForward: Object.freeze({
      sourcePolicyVersion: '2',
      sourceValuesChangedForObservedOutcome: false,
      overallMinimums: EXPECTED_OVERALL_MINIMUMS,
      perSideMinimums: EXPECTED_SIDE_MINIMUMS,
      trainWindowMs: EXPECTED_WINDOWS_MS.train,
      validationWindowMs: EXPECTED_WINDOWS_MS.validation,
      oosWindowMs: EXPECTED_WINDOWS_MS.oos,
      captureIntervalMs: EXPECTED_CAPTURE_INTERVAL_MS,
      outcomeHorizonMs: EXPECTED_OUTCOME_HORIZON_MS,
      maxRegimeEvidenceAgeMs: EXPECTED_REGIME_MAX_AGE_MS,
      market: 'CRYPTO_FUTURES',
      symbol: String(symbol).trim().toUpperCase(),
      quantityNotionalBucketIdentity: 'ALL_POSITIVE_PUBLIC_TRADE_NOTIONAL_V1',
      volatilityRegimeIdentity: 'PREDECLARED_BASELINE_VOLATILITY_V1',
      liquidityRegimeIdentity: 'PREDECLARED_BASELINE_LIQUIDITY_V1',
      captureSelectionPolicy: CAPTURE_SELECTION_POLICY,
      captureTriggerType: CAPTURE_TRIGGER_TYPE,
      outcomeSelectionPolicy: OOS_SELECTION_POLICY,
    }),
    rationale: Object.freeze({
      ...carried.rationale,
      carryForwardFromPolicyVersion: '2',
      v2ProspectiveOutcomesUsedToChooseValues: false,
      v2ProspectiveSampleCreditAtSupersession: 0,
      cohortStartDelayBasis: '24_HOUR_FUTURE_BUFFER_ONLY_AFTER_PRE_SAMPLE_V2_SUPERSESSION',
    }),
    readiness: Object.freeze({
      PROSPECTIVE_POLICY_DEFINED: true,
      PROSPECTIVE_POLICY_FROZEN: true,
      CAPTURE_SELECTION_POLICY_PRESENT: true,
      CAPTURE_SCHEDULE_ACTIVATED: false,
      NEW_PROSPECTIVE_SAMPLE_N: 0,
      HISTORICAL_COHORT_CREDIT_ALLOWED: false,
      V3_SPLIT_RECEIPT_PRESENT: false,
      OOS_INPUT_READY: false,
      GENUINE_OOS_OUTCOME_N: 0,
      CALIBRATION_SAMPLE_SUFFICIENT: false,
      FULL_COST_READY: false,
      EVIDENCE_COMPLETE: 0,
    }),
    safety: Object.freeze({
      publicDataOnly: true,
      executionAuthority: 'NONE',
      privateApiUsed: false,
      liveTrading: false,
      orderSubmitted: false,
      financialMutationPerformed: false,
      retrospectivePolicyApplicationAllowed: false,
      scheduleActivationPerformed: false,
    }),
  };

  return Object.freeze({
    ...artifactWithoutDigest,
    artifactDigest: digestOf(artifactWithoutDigest),
  });
}

export function verifyProspectiveLiquidityPolicyV3Artifact(artifact) {
  const blockers = [];
  const add = (code) => { if (!blockers.includes(code)) blockers.push(code); };
  if (!object(artifact)) return Object.freeze({ valid: false, blockers: Object.freeze(['ARTIFACT_REQUIRED']) });

  if (artifact.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_ARTIFACT_V3_VERSION) add('ARTIFACT_VERSION_INVALID');
  if (artifact.contractVersion !== PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_V3_VERSION) add('POLICY_CONTRACT_VERSION_INVALID');
  if (!/^[a-f0-9]{40}$/u.test(String(artifact.exactPolicyHeadSha ?? ''))) add('EXACT_HEAD_SHA_INVALID');
  if (!SHA256.test(String(artifact.artifactDigest ?? ''))) add('ARTIFACT_DIGEST_INVALID');
  else if (artifact.artifactDigest !== digestOf(withoutDigest(artifact, 'artifactDigest'))) add('ARTIFACT_DIGEST_MISMATCH');

  if (artifact.supersedes?.policyVersion !== '2'
    || artifact.supersedes?.reason !== 'SUPERSEDED_BEFORE_FIRST_GENUINE_SAMPLE_SCHEDULE_SEAM_UNAVAILABLE'
    || artifact.supersedes?.supersededBeforeFirstGenuineSample !== true
    || artifact.supersedes?.priorProspectiveSampleCredit !== 0) add('V2_SUPERSEDE_BOUNDARY_INVALID');

  const policy = artifact.policy;
  if (!object(policy)) add('POLICY_REQUIRED');
  else {
    if (policy.policyVersion !== '3') add('POLICY_VERSION_INVALID');
    if (!SHA256.test(String(policy.policyDigest ?? ''))
      || policy.policyDigest !== digestOf(withoutDigest(policy, 'policyDigest'))) add('POLICY_DIGEST_INVALID');
    if (!stableEqual(policy.overallMinimums, EXPECTED_OVERALL_MINIMUMS)) add('OVERALL_MINIMUMS_CHANGED');
    if (policy.maxRegimeEvidenceAgeMs !== EXPECTED_REGIME_MAX_AGE_MS) add('REGIME_MAX_AGE_CHANGED');
    for (const split of SPLITS) {
      const splitWindow = policy.windows?.[split];
      const duration = splitWindow?.endExclusiveMs - splitWindow?.startInclusiveMs;
      if (duration !== EXPECTED_WINDOWS_MS[split]) add(`${split.toUpperCase()}_WINDOW_CHANGED`);
    }
    const scopeBySide = new Map((policy.scopeMinimums ?? []).map((entry) => [entry?.aggressiveSide, entry]));
    for (const side of SIDES) {
      const scope = scopeBySide.get(side);
      if (!scope) add(`SIDE_${side}_MISSING`);
      else if (!stableEqual(scope.minimums, EXPECTED_SIDE_MINIMUMS)) add(`SIDE_${side}_MINIMUMS_CHANGED`);
    }
  }

  const capture = artifact.captureSelectionPolicy;
  if (capture?.selectionPolicy !== CAPTURE_SELECTION_POLICY) add('CAPTURE_SELECTION_POLICY_CHANGED');
  if (capture?.triggerType !== CAPTURE_TRIGGER_TYPE) add('CAPTURE_TRIGGER_TYPE_CHANGED');
  if (capture?.slotIntervalMs !== EXPECTED_CAPTURE_INTERVAL_MS) add('CAPTURE_INTERVAL_CHANGED');
  if (!stableEqual(capture?.slotCounts, { train: 24, validation: 12, oos: 12 })) add('CAPTURE_SLOT_COUNTS_CHANGED');
  if (capture?.exactlyOneCanonicalCaptureAttemptPerSlot !== true) add('CAPTURE_ONE_ATTEMPT_PER_SLOT_REQUIRED');
  if (capture?.completeWindowAttemptLogRequired !== true) add('CAPTURE_COMPLETE_WINDOW_LOG_REQUIRED');
  if (capture?.missingScheduledSlotFailsSelectionCompleteness !== true) add('CAPTURE_MISSING_SLOT_FAIL_CLOSED_REQUIRED');
  if (capture?.manualDispatchCredit !== 0 || capture?.operatorSelectedDispatchCredit !== 0
    || capture?.replaySlotCredit !== 0 || capture?.backfillSlotCredit !== 0) add('NON_SCHEDULED_CREDIT_NONZERO');
  if (capture?.scheduleActivationRequired !== true) add('SCHEDULE_ACTIVATION_REQUIRED');

  if (artifact.scopePolicy?.market !== 'CRYPTO_FUTURES' || artifact.scopePolicy?.symbol !== 'BTCUSDT') add('SCOPE_CHANGED');
  if (!stableEqual(artifact.scopePolicy?.allowedAggressiveSides, SIDES)) add('SIDE_SCOPE_CHANGED');
  if (artifact.scopePolicy?.quantityNotionalBucketIdentity !== 'ALL_POSITIVE_PUBLIC_TRADE_NOTIONAL_V1') add('NOTIONAL_SCOPE_CHANGED');
  if (artifact.regimePolicy?.volatilityRegimeIdentity !== 'PREDECLARED_BASELINE_VOLATILITY_V1'
    || artifact.regimePolicy?.liquidityRegimeIdentity !== 'PREDECLARED_BASELINE_LIQUIDITY_V1'
    || artifact.regimePolicy?.maxRegimeEvidenceAgeMs !== EXPECTED_REGIME_MAX_AGE_MS) add('REGIME_SCOPE_CHANGED');
  if (artifact.outcomeMethodology?.outcomeHorizonMs !== EXPECTED_OUTCOME_HORIZON_MS
    || artifact.outcomeMethodology?.outcomeSelectionPolicy !== OOS_SELECTION_POLICY) add('OOS_HORIZON_CHANGED');

  const cohort = artifact.cohort;
  if (!object(cohort)) add('COHORT_REQUIRED');
  else {
    if (cohort.policyVersion !== '3') add('COHORT_POLICY_VERSION_INVALID');
    if (cohort.policyDigest !== policy?.policyDigest) add('COHORT_POLICY_DIGEST_MISMATCH');
    if (cohort.captureSelectionPolicyDigest !== capture?.captureSelectionPolicyDigest) add('COHORT_CAPTURE_POLICY_DIGEST_MISMATCH');
    if (cohort.cohortEligibleAfterMs - cohort.policyFrozenAtMs !== V3_COHORT_START_DELAY_MS) add('V3_FUTURE_BUFFER_CHANGED');
    if (capture?.anchorMs !== cohort.cohortEligibleAfterMs) add('CAPTURE_ANCHOR_MISMATCH');
    if (cohort.historicalObservationCredit !== 0 || cohort.replayCredit !== 0
      || cohort.backfillCredit !== 0 || cohort.duplicateCredit !== 0
      || cohort.manualDispatchCredit !== 0) add('COHORT_NON_GENUINE_CREDIT_NONZERO');
    if (!SHA256.test(String(cohort.cohortDigest ?? ''))
      || cohort.cohortDigest !== digestOf(withoutDigest(cohort, 'cohortDigest'))) add('COHORT_DIGEST_INVALID');
  }

  if (artifact.carryForward?.sourceValuesChangedForObservedOutcome !== false
    || artifact.rationale?.observedLegacyCohortUsedToChooseValues !== false
    || artifact.rationale?.v1ProspectiveOutcomesUsedToChooseValues !== false
    || artifact.rationale?.v2ProspectiveOutcomesUsedToChooseValues !== false
    || artifact.rationale?.v2ProspectiveSampleCreditAtSupersession !== 0) add('OUTCOME_DERIVED_RETUNING_FORBIDDEN');

  if (artifact.readiness?.CAPTURE_SCHEDULE_ACTIVATED !== false
    || artifact.readiness?.NEW_PROSPECTIVE_SAMPLE_N !== 0
    || artifact.readiness?.FULL_COST_READY !== false
    || artifact.readiness?.EVIDENCE_COMPLETE !== 0) add('READINESS_TRUTH_INVALID');
  if (artifact.safety?.publicDataOnly !== true
    || artifact.safety?.executionAuthority !== 'NONE'
    || artifact.safety?.privateApiUsed !== false
    || artifact.safety?.liveTrading !== false
    || artifact.safety?.orderSubmitted !== false
    || artifact.safety?.financialMutationPerformed !== false
    || artifact.safety?.scheduleActivationPerformed !== false) add('SAFETY_INVALID');

  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(blockers) });
}

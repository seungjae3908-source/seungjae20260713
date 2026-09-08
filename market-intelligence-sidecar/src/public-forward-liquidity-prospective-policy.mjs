import { createHash } from 'node:crypto';

export const PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_VERSION =
  'public-forward-liquidity-prospective-policy-v2';
export const PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_ARTIFACT_VERSION =
  'public-forward-liquidity-prospective-policy-artifact-v2';
export const OOS_SELECTION_POLICY = 'FIRST_PUBLIC_OBSERVATION_AT_OR_AFTER_HORIZON';
export const CAPTURE_SELECTION_POLICY = 'DETERMINISTIC_30_MINUTE_COMPLETE_WINDOW_V1';
export const CAPTURE_TRIGGER_TYPE = 'GITHUB_ACTIONS_SCHEDULED_CANONICAL_PUBLIC_CAPTURE';

const SHA256 = /^[a-f0-9]{64}$/u;
const SIDES = Object.freeze(['BUY', 'SELL']);
const SPLITS = Object.freeze(['train', 'validation', 'oos']);

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

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash('sha256').update(input).digest('hex');
}

function text(value, code) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 320) throw new Error(code);
  return normalized;
}

function positiveInteger(value, code) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function timestamp(value, code) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function exactSha(value, code = 'EXACT_HEAD_SHA_INVALID') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function digestOf(body) {
  return sha256(canonicalJson(body));
}

function window(startInclusiveMs, durationMs) {
  return Object.freeze({
    startInclusiveMs,
    endExclusiveMs: startInclusiveMs + durationMs,
  });
}

function minimums(train, validation, oos) {
  return Object.freeze({
    train: positiveInteger(train, 'TRAIN_MINIMUM_INVALID'),
    validation: positiveInteger(validation, 'VALIDATION_MINIMUM_INVALID'),
    oos: positiveInteger(oos, 'OOS_MINIMUM_INVALID'),
  });
}

function validateStoredDigest(value, digestField, code, blockers) {
  if (!object(value) || !SHA256.test(String(value[digestField] ?? ''))) {
    blockers.push(`${code}_DIGEST_INVALID`);
    return;
  }
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== digestField));
  if (value[digestField] !== digestOf(body)) blockers.push(`${code}_DIGEST_MISMATCH`);
}

function slotCount(splitWindow, intervalMs, code) {
  const duration = splitWindow.endExclusiveMs - splitWindow.startInclusiveMs;
  if (duration <= 0 || duration % intervalMs !== 0) throw new Error(code);
  return duration / intervalMs;
}

export function buildProspectiveLiquidityPolicyArtifact({
  exactHeadSha,
  policyFrozenAtMs,
  symbol = 'BTCUSDT',
  cohortStartDelayMs = 30 * 60 * 1000,
  trainWindowMs = 12 * 60 * 60 * 1000,
  validationWindowMs = 6 * 60 * 60 * 1000,
  oosWindowMs = 6 * 60 * 60 * 1000,
  outcomeHorizonMs = 60 * 1000,
  maxRegimeEvidenceAgeMs = 15 * 60 * 1000,
  captureIntervalMs = 30 * 60 * 1000,
  overallMinimums = { train: 18, validation: 6, oos: 6 },
  perSideMinimums = { train: 9, validation: 3, oos: 3 },
  quantityNotionalBucketIdentity = 'ALL_POSITIVE_PUBLIC_TRADE_NOTIONAL_V1',
  volatilityRegimeIdentity = 'PREDECLARED_BASELINE_VOLATILITY_V1',
  liquidityRegimeIdentity = 'PREDECLARED_BASELINE_LIQUIDITY_V1',
} = {}) {
  const headSha = exactSha(exactHeadSha);
  const frozenAtMs = timestamp(policyFrozenAtMs, 'POLICY_FROZEN_AT_INVALID');
  const normalizedSymbol = text(symbol, 'SYMBOL_INVALID').toUpperCase();
  if (!/^[A-Z0-9]{4,30}$/u.test(normalizedSymbol)) throw new Error('SYMBOL_INVALID');

  const delayMs = positiveInteger(cohortStartDelayMs, 'COHORT_START_DELAY_INVALID');
  const trainMs = positiveInteger(trainWindowMs, 'TRAIN_WINDOW_DURATION_INVALID');
  const validationMs = positiveInteger(validationWindowMs, 'VALIDATION_WINDOW_DURATION_INVALID');
  const oosMs = positiveInteger(oosWindowMs, 'OOS_WINDOW_DURATION_INVALID');
  const horizonMs = positiveInteger(outcomeHorizonMs, 'OUTCOME_HORIZON_INVALID');
  const regimeAgeMs = positiveInteger(maxRegimeEvidenceAgeMs, 'REGIME_MAX_AGE_INVALID');
  const intervalMs = positiveInteger(captureIntervalMs, 'CAPTURE_INTERVAL_INVALID');
  if (horizonMs >= oosMs) throw new Error('OUTCOME_HORIZON_NOT_WITHIN_OOS_WINDOW');
  if (intervalMs <= horizonMs) throw new Error('CAPTURE_INTERVAL_MUST_EXCEED_OUTCOME_HORIZON');

  const overall = minimums(
    overallMinimums?.train,
    overallMinimums?.validation,
    overallMinimums?.oos,
  );
  const side = minimums(
    perSideMinimums?.train,
    perSideMinimums?.validation,
    perSideMinimums?.oos,
  );
  for (const split of SPLITS) {
    if (side[split] * SIDES.length > overall[split]) {
      throw new Error(`SIDE_MINIMUM_EXCEEDS_OVERALL_${split.toUpperCase()}`);
    }
  }

  const bucketIdentity = text(quantityNotionalBucketIdentity, 'BUCKET_IDENTITY_INVALID');
  const volatilityIdentity = text(volatilityRegimeIdentity, 'VOLATILITY_REGIME_IDENTITY_INVALID');
  const liquidityIdentity = text(liquidityRegimeIdentity, 'LIQUIDITY_REGIME_IDENTITY_INVALID');

  const cohortEligibleAfterMs = frozenAtMs + delayMs;
  const train = window(cohortEligibleAfterMs, trainMs);
  const validation = window(train.endExclusiveMs, validationMs);
  const oos = window(validation.endExclusiveMs, oosMs);
  const windows = Object.freeze({ train, validation, oos });
  const slotCounts = Object.freeze({
    train: slotCount(train, intervalMs, 'TRAIN_CAPTURE_INTERVAL_NOT_DIVISIBLE'),
    validation: slotCount(validation, intervalMs, 'VALIDATION_CAPTURE_INTERVAL_NOT_DIVISIBLE'),
    oos: slotCount(oos, intervalMs, 'OOS_CAPTURE_INTERVAL_NOT_DIVISIBLE'),
  });
  for (const split of SPLITS) {
    if (slotCounts[split] < overall[split]) throw new Error(`CAPTURE_SLOTS_BELOW_MINIMUM_${split.toUpperCase()}`);
  }

  const scopePolicyBody = Object.freeze({
    schemaVersion: 'public-forward-liquidity-scope-policy-v2',
    ownerIdentity: 'PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_OWNER_V2',
    policyIdentity: 'PUBLIC_FORWARD_LIQUIDITY_SCOPE_POLICY_V2',
    policyFrozenAtMs: frozenAtMs,
    market: 'CRYPTO_FUTURES',
    symbol: normalizedSymbol,
    crossSymbolGeneralizationAllowed: false,
    allowedAggressiveSides: SIDES,
    quantityNotionalBucketIdentity: bucketIdentity,
    bucketRule: 'ALL_POSITIVE_PUBLIC_TRADE_NOTIONAL',
    crossBucketGeneralizationAllowed: false,
    outcomeInspectionUsed: false,
  });
  const scopePolicyDigest = digestOf(scopePolicyBody);

  const regimePolicyBody = Object.freeze({
    schemaVersion: 'public-forward-liquidity-regime-policy-v2',
    ownerIdentity: 'PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_OWNER_V2',
    policyIdentity: 'PUBLIC_FORWARD_LIQUIDITY_REGIME_POLICY_V2',
    policyFrozenAtMs: frozenAtMs,
    market: 'CRYPTO_FUTURES',
    symbol: normalizedSymbol,
    volatilityRegimeIdentity: volatilityIdentity,
    liquidityRegimeIdentity: liquidityIdentity,
    regimeRule: 'PREDECLARED_BASELINE_ONLY_NO_POST_EVENT_BUCKETING',
    crossRegimeGeneralizationAllowed: false,
    maxRegimeEvidenceAgeMs: regimeAgeMs,
    outcomeInspectionUsed: false,
  });
  const regimePolicyDigest = digestOf(regimePolicyBody);

  const captureSelectionBody = Object.freeze({
    schemaVersion: 'public-forward-liquidity-capture-selection-policy-v1',
    policyIdentity: `PUBLIC_FORWARD_LIQUIDITY_CAPTURE_SELECTION_POLICY_V1:${headSha}`,
    policyFrozenAtMs: frozenAtMs,
    selectionPolicy: CAPTURE_SELECTION_POLICY,
    triggerType: CAPTURE_TRIGGER_TYPE,
    anchorMs: cohortEligibleAfterMs,
    slotIntervalMs: intervalMs,
    slotCounts,
    exactlyOneCanonicalCaptureAttemptPerSlot: true,
    completeWindowAttemptLogRequired: true,
    firstValidCaptureAttemptPerSlotCreditOnly: true,
    missingScheduledSlotFailsSelectionCompleteness: true,
    manualDispatchCredit: 0,
    operatorSelectedDispatchCredit: 0,
    replaySlotCredit: 0,
    backfillSlotCredit: 0,
    scheduleActivationRequired: true,
    outcomeInspectionUsed: false,
  });
  const captureSelectionPolicy = Object.freeze({
    ...captureSelectionBody,
    captureSelectionPolicyDigest: digestOf(captureSelectionBody),
  });

  const policyIdentity = `PUBLIC_FORWARD_LIQUIDITY_SPLIT_POLICY_V2:${headSha}`;
  const policyWithoutDigest = {
    policyIdentity,
    policyVersion: '2',
    policyFrozenAtMs: frozenAtMs,
    expectedScopeOwnerIdentity: scopePolicyBody.ownerIdentity,
    expectedScopePolicyIdentity: scopePolicyBody.policyIdentity,
    expectedScopePolicyDigest: scopePolicyDigest,
    expectedRegimeOwnerIdentity: regimePolicyBody.ownerIdentity,
    expectedRegimePolicyIdentity: regimePolicyBody.policyIdentity,
    expectedRegimePolicyDigest: regimePolicyDigest,
    expectedCaptureSelectionPolicyIdentity: captureSelectionPolicy.policyIdentity,
    expectedCaptureSelectionPolicyDigest: captureSelectionPolicy.captureSelectionPolicyDigest,
    maxRegimeEvidenceAgeMs: regimeAgeMs,
    windows,
    overallMinimums: overall,
    scopeMinimums: Object.freeze(SIDES.map((aggressiveSide) => Object.freeze({
      market: 'CRYPTO_FUTURES',
      symbol: normalizedSymbol,
      aggressiveSide,
      quantityNotionalBucketIdentity: bucketIdentity,
      volatilityRegimeIdentity: volatilityIdentity,
      liquidityRegimeIdentity: liquidityIdentity,
      minimums: side,
    }))),
  };
  const policy = Object.freeze({
    ...policyWithoutDigest,
    policyDigest: digestOf(policyWithoutDigest),
  });

  const outcomeMethodologyBody = Object.freeze({
    schemaVersion: 'public-forward-liquidity-oos-methodology-v1',
    methodologyIdentity: `PUBLIC_FORWARD_LIQUIDITY_OOS_METHODOLOGY_V2:${headSha}`,
    methodologyFrozenAtMs: frozenAtMs,
    outcomeHorizonIdentity: `PUBLIC_FORWARD_LIQUIDITY_OOS_HORIZON_60S_V2:${headSha}`,
    outcomeHorizonMs: horizonMs,
    outcomeSelectionPolicy: OOS_SELECTION_POLICY,
    allowedCalibrationSplits: Object.freeze(['TRAIN', 'VALIDATION']),
    oosDataAccessBeforeFreeze: false,
    priceSource: 'PUBLIC_ORDER_BOOK_MID',
    outcomeInspectionUsed: false,
  });
  const outcomeMethodology = Object.freeze({
    ...outcomeMethodologyBody,
    methodologyDigest: digestOf(outcomeMethodologyBody),
  });

  const cohortBody = Object.freeze({
    schemaVersion: 'public-forward-liquidity-prospective-cohort-v2',
    cohortIdentity: `PUBLIC_FORWARD_LIQUIDITY_NEW_PROSPECTIVE_COHORT_V2:${headSha}`,
    exactPolicyHeadSha: headSha,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    market: 'CRYPTO_FUTURES',
    symbol: normalizedSymbol,
    policyVersion: '2',
    policyDigest: policy.policyDigest,
    captureSelectionPolicyDigest: captureSelectionPolicy.captureSelectionPolicyDigest,
    policyFrozenAtMs: frozenAtMs,
    cohortEligibleAfterMs,
    cohortEndExclusiveMs: oos.endExclusiveMs,
    historicalObservationCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    duplicateCredit: 0,
    manualDispatchCredit: 0,
    retrospectivePolicyApplicationAllowed: false,
    requiresBothAggressiveSides: true,
    completeCaptureWindowRequired: true,
  });
  const cohort = Object.freeze({ ...cohortBody, cohortDigest: digestOf(cohortBody) });

  const artifactWithoutDigest = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_ARTIFACT_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_FREEZE',
    contractVersion: PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_VERSION,
    exactPolicyHeadSha: headSha,
    supersedes: Object.freeze({
      policyVersion: '1',
      reason: 'CAPTURE_SELECTION_POLICY_MISSING',
      supersededBeforeFirstSample: true,
      priorProspectiveSampleCredit: 0,
    }),
    policy,
    scopePolicy: Object.freeze({ ...scopePolicyBody, scopePolicyDigest }),
    regimePolicy: Object.freeze({ ...regimePolicyBody, regimePolicyDigest }),
    captureSelectionPolicy,
    outcomeMethodology,
    cohort,
    rationale: Object.freeze({
      minimumBasis: 'PREDECLARED_SYMMETRIC_EFFECTIVE_INDEPENDENT_N30_UNCHANGED_FROM_V1',
      splitBasis: 'CHRONOLOGICAL_60_20_20_EFFECTIVE_INDEPENDENT_TARGET_UNCHANGED_FROM_V1',
      sideCoverageBasis: 'BUY_AND_SELL_SYMMETRIC_REQUIRED_UNCHANGED_FROM_V1',
      horizonBasis: 'PREDECLARED_60_SECOND_PUBLIC_MID_DRIFT_UNCHANGED_FROM_V1',
      captureSelectionBasis: 'FIXED_30_MINUTE_COMPLETE_WINDOW_WITH_SCHEDULED_TRIGGER_NO_OPERATOR_TIMING_SELECTION',
      observedLegacyCohortUsedToChooseValues: false,
      v1ProspectiveOutcomesUsedToChooseValues: false,
    }),
    readiness: Object.freeze({
      PROSPECTIVE_POLICY_DEFINED: true,
      PROSPECTIVE_POLICY_FROZEN: true,
      CAPTURE_SELECTION_POLICY_PRESENT: true,
      CAPTURE_SCHEDULE_ACTIVATED: false,
      NEW_PROSPECTIVE_SAMPLE_N: 0,
      HISTORICAL_COHORT_CREDIT_ALLOWED: false,
      V2_SPLIT_RECEIPT_PRESENT: false,
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

export function verifyProspectiveLiquidityPolicyArtifact(artifact) {
  const blockers = [];
  const add = (code) => { if (!blockers.includes(code)) blockers.push(code); };
  if (!object(artifact)) return Object.freeze({ valid: false, blockers: ['ARTIFACT_REQUIRED'] });
  if (artifact.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_ARTIFACT_VERSION) add('ARTIFACT_VERSION_INVALID');
  if (artifact.contractVersion !== PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_VERSION) add('POLICY_CONTRACT_VERSION_INVALID');
  if (!SHA256.test(String(artifact.artifactDigest ?? ''))) add('ARTIFACT_DIGEST_INVALID');
  else {
    const { artifactDigest: _ignored, ...body } = artifact;
    if (artifact.artifactDigest !== digestOf(body)) add('ARTIFACT_DIGEST_MISMATCH');
  }

  const policy = object(artifact.policy);
  if (!policy) add('POLICY_REQUIRED');
  else {
    validateStoredDigest(policy, 'policyDigest', 'POLICY', blockers);
    if (policy.policyVersion !== '2') add('POLICY_VERSION_INVALID');
    if (!(policy.policyFrozenAtMs < policy.windows?.train?.startInclusiveMs)) add('POLICY_NOT_FROZEN_BEFORE_TRAIN');
    if (!(policy.windows?.train?.endExclusiveMs <= policy.windows?.validation?.startInclusiveMs)) add('TRAIN_VALIDATION_OVERLAP');
    if (!(policy.windows?.validation?.endExclusiveMs <= policy.windows?.oos?.startInclusiveMs)) add('VALIDATION_OOS_OVERLAP');
    const sides = new Set((policy.scopeMinimums ?? []).map((entry) => entry?.aggressiveSide));
    if (!SIDES.every((sideName) => sides.has(sideName))) add('BUY_SELL_SCOPE_COVERAGE_MISSING');
  }

  validateStoredDigest(artifact.scopePolicy, 'scopePolicyDigest', 'SCOPE_POLICY', blockers);
  validateStoredDigest(artifact.regimePolicy, 'regimePolicyDigest', 'REGIME_POLICY', blockers);
  validateStoredDigest(artifact.captureSelectionPolicy, 'captureSelectionPolicyDigest', 'CAPTURE_SELECTION_POLICY', blockers);
  validateStoredDigest(artifact.outcomeMethodology, 'methodologyDigest', 'OOS_METHODOLOGY', blockers);
  validateStoredDigest(artifact.cohort, 'cohortDigest', 'COHORT', blockers);

  if (policy && artifact.scopePolicy?.scopePolicyDigest !== policy.expectedScopePolicyDigest) add('SCOPE_POLICY_BINDING_MISMATCH');
  if (policy && artifact.regimePolicy?.regimePolicyDigest !== policy.expectedRegimePolicyDigest) add('REGIME_POLICY_BINDING_MISMATCH');
  if (policy && artifact.captureSelectionPolicy?.captureSelectionPolicyDigest !== policy.expectedCaptureSelectionPolicyDigest) add('CAPTURE_SELECTION_POLICY_BINDING_MISMATCH');
  if (artifact.cohort?.policyDigest !== policy?.policyDigest) add('COHORT_POLICY_DIGEST_MISMATCH');
  if (artifact.cohort?.captureSelectionPolicyDigest !== artifact.captureSelectionPolicy?.captureSelectionPolicyDigest) add('COHORT_CAPTURE_SELECTION_DIGEST_MISMATCH');

  const capture = artifact.captureSelectionPolicy;
  if (capture?.selectionPolicy !== CAPTURE_SELECTION_POLICY) add('CAPTURE_SELECTION_POLICY_INVALID');
  if (capture?.triggerType !== CAPTURE_TRIGGER_TYPE) add('CAPTURE_TRIGGER_TYPE_INVALID');
  if (capture?.exactlyOneCanonicalCaptureAttemptPerSlot !== true) add('CAPTURE_ONE_ATTEMPT_PER_SLOT_REQUIRED');
  if (capture?.completeWindowAttemptLogRequired !== true) add('CAPTURE_COMPLETE_WINDOW_LOG_REQUIRED');
  if (capture?.missingScheduledSlotFailsSelectionCompleteness !== true) add('CAPTURE_MISSING_SLOT_FAIL_CLOSED_REQUIRED');
  if (capture?.manualDispatchCredit !== 0 || capture?.operatorSelectedDispatchCredit !== 0
    || capture?.replaySlotCredit !== 0 || capture?.backfillSlotCredit !== 0) add('CAPTURE_NON_SCHEDULED_CREDIT_NONZERO');
  if (capture?.scheduleActivationRequired !== true) add('CAPTURE_SCHEDULE_ACTIVATION_BOUNDARY_MISSING');
  if (!Number.isInteger(capture?.slotIntervalMs) || capture.slotIntervalMs <= 0) add('CAPTURE_INTERVAL_INVALID');
  if (capture?.anchorMs !== artifact.cohort?.cohortEligibleAfterMs) add('CAPTURE_ANCHOR_MISMATCH');
  for (const split of SPLITS) {
    const splitWindow = policy?.windows?.[split];
    const count = capture?.slotCounts?.[split];
    if (!splitWindow || !Number.isInteger(count) || count <= 0) add(`CAPTURE_SLOT_COUNT_${split.toUpperCase()}_INVALID`);
    else if ((splitWindow.endExclusiveMs - splitWindow.startInclusiveMs) / capture.slotIntervalMs !== count) {
      add(`CAPTURE_SLOT_COUNT_${split.toUpperCase()}_MISMATCH`);
    }
    if (policy?.overallMinimums?.[split] > count) add(`CAPTURE_SLOT_COUNT_${split.toUpperCase()}_BELOW_MINIMUM`);
  }

  if (artifact.cohort?.retrospectivePolicyApplicationAllowed !== false) add('RETROSPECTIVE_POLICY_FIREWALL_MISSING');
  if (artifact.cohort?.historicalObservationCredit !== 0
    || artifact.cohort?.replayCredit !== 0
    || artifact.cohort?.backfillCredit !== 0
    || artifact.cohort?.duplicateCredit !== 0
    || artifact.cohort?.manualDispatchCredit !== 0) add('NON_GENUINE_CREDIT_NONZERO');
  if (artifact.outcomeMethodology?.outcomeSelectionPolicy !== OOS_SELECTION_POLICY) add('OOS_SELECTION_POLICY_INVALID');
  if (!Number.isInteger(artifact.outcomeMethodology?.outcomeHorizonMs) || artifact.outcomeMethodology.outcomeHorizonMs <= 0) add('OUTCOME_HORIZON_INVALID');
  if (artifact.outcomeMethodology?.oosDataAccessBeforeFreeze !== false) add('OOS_PRE_FREEZE_DATA_ACCESS_FORBIDDEN');
  if (JSON.stringify(artifact.outcomeMethodology?.allowedCalibrationSplits) !== JSON.stringify(['TRAIN', 'VALIDATION'])) add('OOS_CALIBRATION_SPLITS_INVALID');
  if (!artifact.outcomeMethodology?.outcomeHorizonIdentity) add('OOS_HORIZON_IDENTITY_INVALID');
  if (artifact.supersedes?.policyVersion !== '1' || artifact.supersedes?.reason !== 'CAPTURE_SELECTION_POLICY_MISSING'
    || artifact.supersedes?.supersededBeforeFirstSample !== true || artifact.supersedes?.priorProspectiveSampleCredit !== 0) {
    add('V1_SUPERSEDE_BOUNDARY_INVALID');
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(blockers) });
}

export function resolveProspectiveCaptureSlot({ artifact, eventTimestampMs } = {}) {
  const verification = verifyProspectiveLiquidityPolicyArtifact(artifact);
  if (!verification.valid) return Object.freeze({ valid: false, blockers: verification.blockers });
  const timestampMs = Number(eventTimestampMs);
  if (!Number.isFinite(timestampMs)) return Object.freeze({ valid: false, blockers: ['EVENT_TIMESTAMP_INVALID'] });
  const start = artifact.cohort.cohortEligibleAfterMs;
  const end = artifact.cohort.cohortEndExclusiveMs;
  if (timestampMs < start) return Object.freeze({ valid: false, blockers: ['EVENT_PREDATES_PROSPECTIVE_COHORT'] });
  if (timestampMs >= end) return Object.freeze({ valid: false, blockers: ['EVENT_AFTER_COHORT_WINDOW'] });
  const intervalMs = artifact.captureSelectionPolicy.slotIntervalMs;
  const slotIndex = Math.floor((timestampMs - start) / intervalMs);
  const slotStartMs = start + slotIndex * intervalMs;
  const slotEndExclusiveMs = slotStartMs + intervalMs;
  let split = null;
  for (const splitName of SPLITS) {
    const splitWindow = artifact.policy.windows[splitName];
    if (timestampMs >= splitWindow.startInclusiveMs && timestampMs < splitWindow.endExclusiveMs) {
      split = splitName.toUpperCase();
      break;
    }
  }
  if (!split) return Object.freeze({ valid: false, blockers: ['CAPTURE_SPLIT_NOT_RESOLVED'] });
  return Object.freeze({
    valid: true,
    blockers: Object.freeze([]),
    split,
    slotIndex,
    slotStartMs,
    slotEndExclusiveMs,
  });
}

export function assessProspectiveObservationEligibility({ artifact, observation, captureContext } = {}) {
  const verification = verifyProspectiveLiquidityPolicyArtifact(artifact);
  if (!verification.valid) return Object.freeze({ eligible: false, blockers: verification.blockers });
  const blockers = [];
  const eventTimestampMs = Number(observation?.eventTimestampMs);
  const slot = resolveProspectiveCaptureSlot({ artifact, eventTimestampMs });
  if (!slot.valid) blockers.push(...slot.blockers);
  if (observation?.sampleClass !== 'FORWARD_NATURAL_SAMPLE') blockers.push('FORWARD_NATURAL_SAMPLE_REQUIRED');
  if (observation?.market !== artifact.cohort.market) blockers.push('MARKET_MISMATCH');
  if (observation?.symbol !== artifact.cohort.symbol) blockers.push('SYMBOL_MISMATCH');
  if (!SIDES.includes(observation?.aggressiveSide)) blockers.push('AGGRESSIVE_SIDE_INVALID');

  if (!object(captureContext)) blockers.push('CAPTURE_CONTEXT_REQUIRED');
  else {
    if (captureContext.triggerType !== CAPTURE_TRIGGER_TYPE) blockers.push('SCHEDULED_CAPTURE_TRIGGER_REQUIRED');
    if (captureContext.captureSelectionPolicyDigest !== artifact.captureSelectionPolicy.captureSelectionPolicyDigest) blockers.push('CAPTURE_SELECTION_POLICY_DIGEST_MISMATCH');
    if (captureContext.cohortIdentity !== artifact.cohort.cohortIdentity) blockers.push('CAPTURE_COHORT_IDENTITY_MISMATCH');
    if (captureContext.operatorSelected !== false) blockers.push('OPERATOR_SELECTED_CAPTURE_FORBIDDEN');
    if (captureContext.replay !== false) blockers.push('REPLAY_CAPTURE_FORBIDDEN');
    if (captureContext.backfill !== false) blockers.push('BACKFILL_CAPTURE_FORBIDDEN');
    if (captureContext.captureAttemptOrdinal !== 1) blockers.push('CAPTURE_ATTEMPT_ORDINAL_INVALID');
    if (slot.valid) {
      if (captureContext.slotIndex !== slot.slotIndex) blockers.push('CAPTURE_SLOT_INDEX_MISMATCH');
      if (captureContext.slotStartMs !== slot.slotStartMs) blockers.push('CAPTURE_SLOT_START_MISMATCH');
      if (captureContext.slotEndExclusiveMs !== slot.slotEndExclusiveMs) blockers.push('CAPTURE_SLOT_END_MISMATCH');
      const attemptedAtMs = Number(captureContext.captureAttemptedAtMs);
      if (!Number.isFinite(attemptedAtMs)
        || attemptedAtMs < slot.slotStartMs || attemptedAtMs >= slot.slotEndExclusiveMs) {
        blockers.push('CAPTURE_ATTEMPT_OUTSIDE_SLOT');
      }
    }
  }
  return Object.freeze({ eligible: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]), slot: slot.valid ? slot : null });
}

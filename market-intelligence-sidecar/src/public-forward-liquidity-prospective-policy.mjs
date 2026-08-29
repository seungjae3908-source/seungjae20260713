import { createHash } from 'node:crypto';

export const PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_VERSION =
  'public-forward-liquidity-prospective-policy-v1';
export const PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_ARTIFACT_VERSION =
  'public-forward-liquidity-prospective-policy-artifact-v1';
export const OOS_SELECTION_POLICY = 'FIRST_PUBLIC_OBSERVATION_AT_OR_AFTER_HORIZON';

const SHA256 = /^[a-f0-9]{64}$/u;
const SIDES = Object.freeze(['BUY', 'SELL']);

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
  if (!normalized || normalized.length > 240) throw new Error(code);
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

function policyDigest(policyWithoutDigest) {
  return digestOf(policyWithoutDigest);
}

function artifactDigest(artifactWithoutDigest) {
  return digestOf(artifactWithoutDigest);
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
  if (horizonMs >= oosMs) throw new Error('OUTCOME_HORIZON_NOT_WITHIN_OOS_WINDOW');

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
  for (const split of ['train', 'validation', 'oos']) {
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

  const scopePolicyBody = Object.freeze({
    schemaVersion: 'public-forward-liquidity-scope-policy-v1',
    ownerIdentity: 'PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_OWNER_V1',
    policyIdentity: 'PUBLIC_FORWARD_LIQUIDITY_SCOPE_POLICY_V1',
    policyFrozenAtMs: frozenAtMs,
    market: 'CRYPTO_FUTURES',
    symbol: normalizedSymbol,
    allowedAggressiveSides: SIDES,
    quantityNotionalBucketIdentity: bucketIdentity,
    bucketRule: 'ALL_POSITIVE_PUBLIC_TRADE_NOTIONAL',
    outcomeInspectionUsed: false,
  });
  const scopePolicyDigest = digestOf(scopePolicyBody);

  const regimePolicyBody = Object.freeze({
    schemaVersion: 'public-forward-liquidity-regime-policy-v1',
    ownerIdentity: 'PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_OWNER_V1',
    policyIdentity: 'PUBLIC_FORWARD_LIQUIDITY_REGIME_POLICY_V1',
    policyFrozenAtMs: frozenAtMs,
    market: 'CRYPTO_FUTURES',
    symbol: normalizedSymbol,
    volatilityRegimeIdentity: volatilityIdentity,
    liquidityRegimeIdentity: liquidityIdentity,
    regimeRule: 'PREDECLARED_BASELINE_ONLY_NO_POST_EVENT_BUCKETING',
    maxRegimeEvidenceAgeMs: regimeAgeMs,
    outcomeInspectionUsed: false,
  });
  const regimePolicyDigest = digestOf(regimePolicyBody);

  const policyIdentity = `PUBLIC_FORWARD_LIQUIDITY_SPLIT_POLICY_V1:${headSha}`;
  const policyWithoutDigest = {
    policyIdentity,
    policyVersion: '1',
    policyFrozenAtMs: frozenAtMs,
    expectedScopeOwnerIdentity: scopePolicyBody.ownerIdentity,
    expectedScopePolicyIdentity: scopePolicyBody.policyIdentity,
    expectedScopePolicyDigest: scopePolicyDigest,
    expectedRegimeOwnerIdentity: regimePolicyBody.ownerIdentity,
    expectedRegimePolicyIdentity: regimePolicyBody.policyIdentity,
    expectedRegimePolicyDigest: regimePolicyDigest,
    maxRegimeEvidenceAgeMs: regimeAgeMs,
    windows: Object.freeze({ train, validation, oos }),
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
    policyDigest: policyDigest(policyWithoutDigest),
  });

  const outcomeMethodologyBody = Object.freeze({
    schemaVersion: 'public-forward-liquidity-oos-methodology-v1',
    methodologyIdentity: `PUBLIC_FORWARD_LIQUIDITY_OOS_METHODOLOGY_V1:${headSha}`,
    methodologyFrozenAtMs: frozenAtMs,
    outcomeHorizonIdentity: `PUBLIC_FORWARD_LIQUIDITY_OOS_HORIZON_60S_V1:${headSha}`,
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
    schemaVersion: 'public-forward-liquidity-prospective-cohort-v1',
    cohortIdentity: `PUBLIC_FORWARD_LIQUIDITY_NEW_PROSPECTIVE_COHORT_V1:${headSha}`,
    exactPolicyHeadSha: headSha,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    market: 'CRYPTO_FUTURES',
    symbol: normalizedSymbol,
    policyFrozenAtMs: frozenAtMs,
    cohortEligibleAfterMs,
    cohortEndExclusiveMs: oos.endExclusiveMs,
    historicalObservationCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    duplicateCredit: 0,
    retrospectivePolicyApplicationAllowed: false,
    requiresBothAggressiveSides: true,
  });
  const cohort = Object.freeze({ ...cohortBody, cohortDigest: digestOf(cohortBody) });

  const artifactWithoutDigest = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_ARTIFACT_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_FREEZE',
    contractVersion: PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_POLICY_VERSION,
    exactPolicyHeadSha: headSha,
    policy,
    scopePolicy: Object.freeze({ ...scopePolicyBody, scopePolicyDigest }),
    regimePolicy: Object.freeze({ ...regimePolicyBody, regimePolicyDigest }),
    outcomeMethodology,
    cohort,
    rationale: Object.freeze({
      minimumBasis: 'PREDECLARED_SYMMETRIC_EFFECTIVE_INDEPENDENT_N30',
      splitBasis: 'CHRONOLOGICAL_60_20_20_EFFECTIVE_INDEPENDENT_TARGET',
      sideCoverageBasis: 'BUY_AND_SELL_SYMMETRIC_REQUIRED',
      horizonBasis: 'PREDECLARED_60_SECOND_PUBLIC_MID_DRIFT',
      observedLegacyCohortUsedToChooseValues: false,
    }),
    readiness: Object.freeze({
      PROSPECTIVE_POLICY_DEFINED: true,
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
    }),
  };
  return Object.freeze({
    ...artifactWithoutDigest,
    artifactDigest: artifactDigest(artifactWithoutDigest),
  });
}

export function verifyProspectiveLiquidityPolicyArtifact(artifact) {
  const blockers = [];
  const add = (code) => { if (!blockers.includes(code)) blockers.push(code); };
  if (!object(artifact)) return Object.freeze({ valid: false, blockers: ['ARTIFACT_REQUIRED'] });
  if (artifact.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_PROSPECTIVE_ARTIFACT_VERSION) add('ARTIFACT_VERSION_INVALID');
  if (!SHA256.test(String(artifact.artifactDigest ?? ''))) add('ARTIFACT_DIGEST_INVALID');
  else {
    const { artifactDigest: _ignored, ...body } = artifact;
    if (artifact.artifactDigest !== digestOf(body)) add('ARTIFACT_DIGEST_MISMATCH');
  }
  const policy = object(artifact.policy);
  if (!policy) add('POLICY_REQUIRED');
  else {
    if (!SHA256.test(String(policy.policyDigest ?? ''))) add('POLICY_DIGEST_INVALID');
    else {
      const { policyDigest: _ignored, ...body } = policy;
      if (policy.policyDigest !== digestOf(body)) add('POLICY_DIGEST_MISMATCH');
    }
    if (!(policy.policyFrozenAtMs < policy.windows?.train?.startInclusiveMs)) add('POLICY_NOT_FROZEN_BEFORE_TRAIN');
    if (!(policy.windows?.train?.endExclusiveMs <= policy.windows?.validation?.startInclusiveMs)) add('TRAIN_VALIDATION_OVERLAP');
    if (!(policy.windows?.validation?.endExclusiveMs <= policy.windows?.oos?.startInclusiveMs)) add('VALIDATION_OOS_OVERLAP');
    const sides = new Set((policy.scopeMinimums ?? []).map((entry) => entry?.aggressiveSide));
    if (!SIDES.every((side) => sides.has(side))) add('BUY_SELL_SCOPE_COVERAGE_MISSING');
  }
  if (artifact.cohort?.retrospectivePolicyApplicationAllowed !== false) add('RETROSPECTIVE_POLICY_FIREWALL_MISSING');
  if (artifact.cohort?.historicalObservationCredit !== 0
    || artifact.cohort?.replayCredit !== 0
    || artifact.cohort?.backfillCredit !== 0
    || artifact.cohort?.duplicateCredit !== 0) add('NON_GENUINE_CREDIT_NONZERO');
  if (artifact.outcomeMethodology?.outcomeSelectionPolicy !== OOS_SELECTION_POLICY) add('OOS_SELECTION_POLICY_INVALID');
  if (!Number.isInteger(artifact.outcomeMethodology?.outcomeHorizonMs) || artifact.outcomeMethodology.outcomeHorizonMs <= 0) add('OUTCOME_HORIZON_INVALID');
  if (artifact.outcomeMethodology?.oosDataAccessBeforeFreeze !== false) add('OOS_PRE_FREEZE_DATA_ACCESS_FORBIDDEN');
  if (JSON.stringify(artifact.outcomeMethodology?.allowedCalibrationSplits) !== JSON.stringify(['TRAIN', 'VALIDATION'])) add('OOS_CALIBRATION_SPLITS_INVALID');
  if (!artifact.outcomeMethodology?.outcomeHorizonIdentity) add('OOS_HORIZON_IDENTITY_INVALID');
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(blockers) });
}

export function assessProspectiveObservationEligibility({ artifact, observation } = {}) {
  const verification = verifyProspectiveLiquidityPolicyArtifact(artifact);
  if (!verification.valid) return Object.freeze({ eligible: false, blockers: verification.blockers });
  const blockers = [];
  const eventTimestampMs = Number(observation?.eventTimestampMs);
  if (!Number.isFinite(eventTimestampMs)) blockers.push('EVENT_TIMESTAMP_INVALID');
  else {
    if (eventTimestampMs < artifact.cohort.cohortEligibleAfterMs) blockers.push('EVENT_PREDATES_PROSPECTIVE_COHORT');
    if (eventTimestampMs >= artifact.cohort.cohortEndExclusiveMs) blockers.push('EVENT_AFTER_COHORT_WINDOW');
  }
  if (observation?.sampleClass !== 'FORWARD_NATURAL_SAMPLE') blockers.push('FORWARD_NATURAL_SAMPLE_REQUIRED');
  if (observation?.market !== artifact.cohort.market) blockers.push('MARKET_MISMATCH');
  if (observation?.symbol !== artifact.cohort.symbol) blockers.push('SYMBOL_MISMATCH');
  if (!SIDES.includes(observation?.aggressiveSide)) blockers.push('AGGRESSIVE_SIDE_INVALID');
  return Object.freeze({ eligible: blockers.length === 0, blockers: Object.freeze(blockers) });
}

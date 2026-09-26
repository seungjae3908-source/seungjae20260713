import { createHash } from 'node:crypto';

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
  verifyLiquidityCalibrationDataset,
} from './public-forward-liquidity-calibration.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_VERSION =
  'public-forward-liquidity-calibration-split-audit-v1';

export const PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_SAFETY = Object.freeze({
  verifiedForwardDatasetRequired: true,
  externalScopeEvidenceRequired: true,
  externalRegimeEvidenceRequired: true,
  bucketComputationOwned: false,
  regimeComputationOwned: false,
  defaultSampleThresholdAllowed: false,
  randomSplitAllowed: false,
  chronologicalSplitRequired: true,
  oosOutcomeEvaluationAllowed: false,
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

const SHA256 = /^[a-f0-9]{64}$/u;
const SPLITS = Object.freeze(['TRAIN', 'VALIDATION', 'OOS']);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 && normalized.length <= 240 ? normalized : null;
}

function digest(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && SHA256.test(normalized) ? normalized : null;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function positiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function sameNumber(left, right) {
  return typeof left === 'number' && Number.isFinite(left)
    && typeof right === 'number' && Number.isFinite(right)
    && left === right;
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

function withoutKey(value, omittedKey) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== omittedKey));
}

export function computePublicForwardLiquiditySplitPolicyDigest(policy) {
  if (!object(policy)) throw new TypeError('SPLIT_POLICY_REQUIRED');
  return sha256(withoutKey(policy, 'policyDigest'));
}

function add(list, code) {
  if (!list.includes(code)) list.push(code);
}

function validateWindow(window) {
  return object(window)
    && positiveFinite(window.startInclusiveMs)
    && positiveFinite(window.endExclusiveMs)
    && window.startInclusiveMs < window.endExclusiveMs;
}

function validateMinimums(value, prefix, blockers) {
  const minimums = object(value);
  if (!minimums) {
    add(blockers, `${prefix}_MINIMUMS_REQUIRED`);
    return false;
  }
  let valid = true;
  for (const split of ['train', 'validation', 'oos']) {
    if (!positiveInteger(minimums[split])) {
      add(blockers, `${prefix}_${split.toUpperCase()}_MINIMUM_INVALID`);
      valid = false;
    }
  }
  return valid;
}

function scopeKey(value) {
  return [
    value.market,
    value.symbol,
    value.aggressiveSide,
    value.quantityNotionalBucketIdentity,
    value.volatilityRegimeIdentity,
    value.liquidityRegimeIdentity,
  ].join('|');
}

function validatePolicy(policy) {
  const blockers = [];
  if (!object(policy)) return ['SPLIT_POLICY_REQUIRED'];
  if (!text(policy.policyIdentity)) add(blockers, 'SPLIT_POLICY_IDENTITY_INVALID');
  if (!text(policy.policyVersion)) add(blockers, 'SPLIT_POLICY_VERSION_INVALID');
  if (!digest(policy.policyDigest)) add(blockers, 'SPLIT_POLICY_DIGEST_INVALID');
  else if (policy.policyDigest !== computePublicForwardLiquiditySplitPolicyDigest(policy)) {
    add(blockers, 'SPLIT_POLICY_DIGEST_MISMATCH');
  }
  if (!positiveFinite(policy.policyFrozenAtMs)) add(blockers, 'SPLIT_POLICY_FROZEN_AT_INVALID');
  if (!text(policy.expectedScopeOwnerIdentity)) add(blockers, 'SCOPE_OWNER_IDENTITY_INVALID');
  if (!text(policy.expectedScopePolicyIdentity)) add(blockers, 'SCOPE_POLICY_IDENTITY_INVALID');
  if (!digest(policy.expectedScopePolicyDigest)) add(blockers, 'SCOPE_POLICY_DIGEST_INVALID');
  if (!text(policy.expectedRegimeOwnerIdentity)) add(blockers, 'REGIME_OWNER_IDENTITY_INVALID');
  if (!text(policy.expectedRegimePolicyIdentity)) add(blockers, 'REGIME_POLICY_IDENTITY_INVALID');
  if (!digest(policy.expectedRegimePolicyDigest)) add(blockers, 'REGIME_POLICY_DIGEST_INVALID');
  if (!positiveInteger(policy.maxRegimeEvidenceAgeMs)) add(blockers, 'REGIME_MAX_AGE_INVALID');

  const windows = object(policy.windows);
  if (!windows) {
    add(blockers, 'SPLIT_WINDOWS_REQUIRED');
  } else {
    if (!validateWindow(windows.train)) add(blockers, 'TRAIN_WINDOW_INVALID');
    if (!validateWindow(windows.validation)) add(blockers, 'VALIDATION_WINDOW_INVALID');
    if (!validateWindow(windows.oos)) add(blockers, 'OOS_WINDOW_INVALID');
    if (validateWindow(windows.train) && validateWindow(windows.validation)
      && windows.train.endExclusiveMs > windows.validation.startInclusiveMs) {
      add(blockers, 'TRAIN_VALIDATION_WINDOW_OVERLAP');
    }
    if (validateWindow(windows.validation) && validateWindow(windows.oos)
      && windows.validation.endExclusiveMs > windows.oos.startInclusiveMs) {
      add(blockers, 'VALIDATION_OOS_WINDOW_OVERLAP');
    }
    if (positiveFinite(policy.policyFrozenAtMs) && validateWindow(windows.validation)
      && policy.policyFrozenAtMs > windows.validation.startInclusiveMs) {
      add(blockers, 'SPLIT_POLICY_NOT_FROZEN_BEFORE_VALIDATION');
    }
  }

  validateMinimums(policy.overallMinimums, 'OVERALL', blockers);
  if (!Array.isArray(policy.scopeMinimums) || policy.scopeMinimums.length === 0) {
    add(blockers, 'SCOPE_MINIMUMS_REQUIRED');
  } else {
    const keys = new Set();
    for (const minimum of policy.scopeMinimums) {
      if (!object(minimum)) {
        add(blockers, 'SCOPE_MINIMUM_INVALID');
        continue;
      }
      if (minimum.market !== 'CRYPTO_FUTURES') add(blockers, 'SCOPE_MARKET_INVALID');
      if (!text(minimum.symbol)) add(blockers, 'SCOPE_SYMBOL_INVALID');
      if (!['BUY', 'SELL'].includes(minimum.aggressiveSide)) add(blockers, 'SCOPE_SIDE_INVALID');
      if (!text(minimum.quantityNotionalBucketIdentity)) add(blockers, 'SCOPE_BUCKET_INVALID');
      if (!text(minimum.volatilityRegimeIdentity)) add(blockers, 'SCOPE_VOLATILITY_REGIME_INVALID');
      if (!text(minimum.liquidityRegimeIdentity)) add(blockers, 'SCOPE_LIQUIDITY_REGIME_INVALID');
      validateMinimums(minimum.minimums, 'SCOPE', blockers);
      const key = scopeKey(minimum);
      if (keys.has(key)) add(blockers, 'SCOPE_MINIMUM_DUPLICATE');
      keys.add(key);
    }
  }
  return blockers;
}

function splitForTimestamp(timestampMs, windows) {
  if (timestampMs >= windows.train.startInclusiveMs && timestampMs < windows.train.endExclusiveMs) return 'TRAIN';
  if (timestampMs >= windows.validation.startInclusiveMs && timestampMs < windows.validation.endExclusiveMs) return 'VALIDATION';
  if (timestampMs >= windows.oos.startInclusiveMs && timestampMs < windows.oos.endExclusiveMs) return 'OOS';
  return null;
}

function validateScopeBinding(binding, observation, policy) {
  const blockers = [];
  if (!object(binding)) return ['SCOPE_BINDING_MISSING'];
  if (binding.observationId !== observation.observationId) add(blockers, 'SCOPE_BINDING_OBSERVATION_ID_MISMATCH');
  if (binding.sourceDigest !== observation.sourceDigest) add(blockers, 'SCOPE_BINDING_SOURCE_DIGEST_MISMATCH');
  if (binding.market !== observation.market) add(blockers, 'SCOPE_BINDING_MARKET_MISMATCH');
  if (binding.symbol !== observation.symbol) add(blockers, 'SCOPE_BINDING_SYMBOL_MISMATCH');
  if (binding.aggressiveSide !== observation.aggressiveSide) add(blockers, 'SCOPE_BINDING_SIDE_MISMATCH');
  if (!sameNumber(binding.tradeFlowQuantity, observation.tradeFlowQuantity)) add(blockers, 'SCOPE_BINDING_QUANTITY_MISMATCH');
  if (!sameNumber(binding.tradeFlowNotional, observation.tradeFlowNotional)) add(blockers, 'SCOPE_BINDING_NOTIONAL_MISMATCH');
  if (!text(binding.quantityNotionalBucketIdentity)) add(blockers, 'SCOPE_BINDING_BUCKET_INVALID');
  if (binding.scopeOwnerIdentity !== policy.expectedScopeOwnerIdentity) add(blockers, 'SCOPE_OWNER_IDENTITY_MISMATCH');
  if (binding.scopePolicyIdentity !== policy.expectedScopePolicyIdentity) add(blockers, 'SCOPE_POLICY_IDENTITY_MISMATCH');
  if (binding.scopePolicyDigest !== policy.expectedScopePolicyDigest) add(blockers, 'SCOPE_POLICY_DIGEST_MISMATCH');
  if (!text(binding.scopeEvidenceIdentity)) add(blockers, 'SCOPE_EVIDENCE_IDENTITY_INVALID');
  if (!digest(binding.scopeEvidenceDigest)) add(blockers, 'SCOPE_EVIDENCE_DIGEST_INVALID');
  if (!positiveFinite(binding.scopePolicyFrozenAtMs)
    || binding.scopePolicyFrozenAtMs > observation.eventTimestampMs) {
    add(blockers, 'SCOPE_POLICY_NOT_FROZEN_BEFORE_EVENT');
  }
  return blockers;
}

function validateRegimeBinding(binding, observation, policy) {
  const blockers = [];
  if (!object(binding)) return ['REGIME_BINDING_MISSING'];
  if (binding.observationId !== observation.observationId) add(blockers, 'REGIME_BINDING_OBSERVATION_ID_MISMATCH');
  if (binding.sourceDigest !== observation.sourceDigest) add(blockers, 'REGIME_BINDING_SOURCE_DIGEST_MISMATCH');
  if (binding.market !== observation.market) add(blockers, 'REGIME_BINDING_MARKET_MISMATCH');
  if (binding.symbol !== observation.symbol) add(blockers, 'REGIME_BINDING_SYMBOL_MISMATCH');
  if (binding.aggressiveSide !== observation.aggressiveSide) add(blockers, 'REGIME_BINDING_SIDE_MISMATCH');
  if (binding.regimeOwnerIdentity !== policy.expectedRegimeOwnerIdentity) add(blockers, 'REGIME_OWNER_IDENTITY_MISMATCH');
  if (binding.regimePolicyIdentity !== policy.expectedRegimePolicyIdentity) add(blockers, 'REGIME_POLICY_IDENTITY_MISMATCH');
  if (binding.regimePolicyDigest !== policy.expectedRegimePolicyDigest) add(blockers, 'REGIME_POLICY_DIGEST_MISMATCH');
  if (!text(binding.regimeEvidenceIdentity)) add(blockers, 'REGIME_EVIDENCE_IDENTITY_INVALID');
  if (!digest(binding.regimeEvidenceDigest)) add(blockers, 'REGIME_EVIDENCE_DIGEST_INVALID');
  if (!text(binding.volatilityRegimeIdentity)) add(blockers, 'VOLATILITY_REGIME_IDENTITY_INVALID');
  if (!text(binding.liquidityRegimeIdentity)) add(blockers, 'LIQUIDITY_REGIME_IDENTITY_INVALID');
  if (!positiveFinite(binding.observedAtMs)) add(blockers, 'REGIME_EVIDENCE_TIMESTAMP_INVALID');
  if (positiveFinite(binding.observedAtMs) && binding.observedAtMs > observation.eventTimestampMs) {
    add(blockers, 'REGIME_EVIDENCE_AFTER_EVENT');
  }
  if (positiveFinite(binding.observedAtMs)
    && observation.eventTimestampMs - binding.observedAtMs > policy.maxRegimeEvidenceAgeMs) {
    add(blockers, 'REGIME_EVIDENCE_STALE');
  }
  return blockers;
}

function blocked(blockers, audit = null) {
  return Object.freeze({
    status: 'BLOCKED_DATA',
    blockers: Object.freeze([...new Set(blockers)]),
    audit,
    safety: PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_SAFETY,
  });
}

function minimumDeficits(counts, required, prefix) {
  const deficits = [];
  for (const split of ['train', 'validation', 'oos']) {
    if (counts[split] < required[split]) {
      deficits.push(`${prefix}:${split.toUpperCase()}:${counts[split]}<${required[split]}`);
    }
  }
  return deficits;
}

export function auditPublicForwardLiquidityCalibrationSplits({
  dataset,
  scopeBindings = [],
  regimeBindings = [],
  policy,
} = {}) {
  const datasetVerification = verifyLiquidityCalibrationDataset(dataset);
  if (!datasetVerification.valid) return blocked(['DATASET_INVALID', datasetVerification.reason]);
  if (dataset.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT
    || dataset.storeContract !== PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT) {
    return blocked(['DATASET_CONTRACT_INVALID']);
  }
  if (dataset.sampleClass !== FORWARD_NATURAL_SAMPLE) return blocked(['FORWARD_NATURAL_DATASET_REQUIRED']);
  if (!Array.isArray(dataset.observations) || dataset.observations.length === 0) return blocked(['FORWARD_DATASET_EMPTY']);

  const policyBlockers = validatePolicy(policy);
  if (policyBlockers.length > 0) return blocked(policyBlockers);

  const scopeByObservation = new Map();
  for (const binding of scopeBindings) {
    if (scopeByObservation.has(binding?.observationId)) return blocked(['SCOPE_BINDING_DUPLICATE_OBSERVATION_ID']);
    scopeByObservation.set(binding?.observationId, binding);
  }
  const regimeByObservation = new Map();
  for (const binding of regimeBindings) {
    if (regimeByObservation.has(binding?.observationId)) return blocked(['REGIME_BINDING_DUPLICATE_OBSERVATION_ID']);
    regimeByObservation.set(binding?.observationId, binding);
  }
  const observationIds = new Set(dataset.observations.map((observation) => observation.observationId));
  if (scopeBindings.some((binding) => !observationIds.has(binding?.observationId))) return blocked(['SCOPE_BINDING_ORPHAN']);
  if (regimeBindings.some((binding) => !observationIds.has(binding?.observationId))) return blocked(['REGIME_BINDING_ORPHAN']);

  const policyByScope = new Map(policy.scopeMinimums.map((minimum) => [scopeKey(minimum), minimum]));
  const structuralBlockers = [];
  const assignments = [];
  const publicExecutionIds = new Set();
  const sourceDigests = new Set();
  const scopeEvidenceIds = new Set();
  const scopeEvidenceDigests = new Set();
  const regimeEvidenceIds = new Set();
  const regimeEvidenceDigests = new Set();

  for (const observation of dataset.observations) {
    if (observation.sampleClass !== FORWARD_NATURAL_SAMPLE
      || observation.forwardCalibrationSampleCredit !== 1
      || observation.historicalBackfillForwardCredit !== 0) {
      add(structuralBlockers, 'NON_FORWARD_OBSERVATION_CREDIT_FORBIDDEN');
    }
    if (observation.executionCostEligible !== false
      || observation.liquidityImpactCoefficient !== null
      || observation.causalMarketImpactClaim !== false
      || observation.paperOrderSourceAllowed !== false) {
      add(structuralBlockers, 'OBSERVATION_AUTHORITY_ESCALATION');
    }
    if (observation.instantaneousVisibleDepthBookWalk?.ownership !== 'SLIPPAGE_VISIBLE_L2_BOOK_WALK_ONLY'
      || observation.instantaneousVisibleDepthBookWalk?.liquidityImpactCoefficient !== null) {
      add(structuralBlockers, 'BOOK_WALK_OWNERSHIP_BOUNDARY_INVALID');
    }
    if ((observation.subsequentPublicPriceDrift ?? []).some((item) => item.executionCostEligible !== false)) {
      add(structuralBlockers, 'POST_EVENT_DRIFT_EXECUTION_COST_FORBIDDEN');
    }

    const publicExecutionId = text(observation.rawSourceProvenance?.publicTrade?.publicExecutionId);
    if (!publicExecutionId) add(structuralBlockers, 'PUBLIC_EXECUTION_ID_MISSING');
    else if (publicExecutionIds.has(publicExecutionId)) add(structuralBlockers, 'DUPLICATE_PUBLIC_EXECUTION_CREDIT_FORBIDDEN');
    else publicExecutionIds.add(publicExecutionId);
    if (!digest(observation.sourceDigest)) add(structuralBlockers, 'OBSERVATION_SOURCE_DIGEST_INVALID');
    else if (sourceDigests.has(observation.sourceDigest)) add(structuralBlockers, 'DUPLICATE_SOURCE_DIGEST_CREDIT_FORBIDDEN');
    else sourceDigests.add(observation.sourceDigest);

    const scopeBinding = scopeByObservation.get(observation.observationId);
    const regimeBinding = regimeByObservation.get(observation.observationId);
    validateScopeBinding(scopeBinding, observation, policy).forEach((code) => add(structuralBlockers, code));
    validateRegimeBinding(regimeBinding, observation, policy).forEach((code) => add(structuralBlockers, code));
    if (!scopeBinding || !regimeBinding) continue;

    if (scopeEvidenceIds.has(scopeBinding.scopeEvidenceIdentity)) add(structuralBlockers, 'SCOPE_EVIDENCE_IDENTITY_REUSED');
    else scopeEvidenceIds.add(scopeBinding.scopeEvidenceIdentity);
    if (scopeEvidenceDigests.has(scopeBinding.scopeEvidenceDigest)) add(structuralBlockers, 'SCOPE_EVIDENCE_DIGEST_REUSED');
    else scopeEvidenceDigests.add(scopeBinding.scopeEvidenceDigest);
    if (regimeEvidenceIds.has(regimeBinding.regimeEvidenceIdentity)) add(structuralBlockers, 'REGIME_EVIDENCE_IDENTITY_REUSED');
    else regimeEvidenceIds.add(regimeBinding.regimeEvidenceIdentity);
    if (regimeEvidenceDigests.has(regimeBinding.regimeEvidenceDigest)) add(structuralBlockers, 'REGIME_EVIDENCE_DIGEST_REUSED');
    else regimeEvidenceDigests.add(regimeBinding.regimeEvidenceDigest);

    const split = splitForTimestamp(observation.eventTimestampMs, policy.windows);
    if (!split) {
      add(structuralBlockers, 'OBSERVATION_OUTSIDE_FROZEN_SPLIT_WINDOWS');
      continue;
    }
    const key = scopeKey({
      market: observation.market,
      symbol: observation.symbol,
      aggressiveSide: observation.aggressiveSide,
      quantityNotionalBucketIdentity: scopeBinding.quantityNotionalBucketIdentity,
      volatilityRegimeIdentity: regimeBinding.volatilityRegimeIdentity,
      liquidityRegimeIdentity: regimeBinding.liquidityRegimeIdentity,
    });
    if (!policyByScope.has(key)) {
      add(structuralBlockers, 'UNPOLICIED_SCOPE_PRESENT');
      continue;
    }
    assignments.push(Object.freeze({
      observationId: observation.observationId,
      sourceDigest: observation.sourceDigest,
      publicExecutionId,
      eventTimestampMs: observation.eventTimestampMs,
      split,
      scopeKey: key,
      quantityNotionalBucketIdentity: scopeBinding.quantityNotionalBucketIdentity,
      scopeEvidenceIdentity: scopeBinding.scopeEvidenceIdentity,
      scopeEvidenceDigest: scopeBinding.scopeEvidenceDigest,
      volatilityRegimeIdentity: regimeBinding.volatilityRegimeIdentity,
      liquidityRegimeIdentity: regimeBinding.liquidityRegimeIdentity,
      regimeEvidenceIdentity: regimeBinding.regimeEvidenceIdentity,
      regimeEvidenceDigest: regimeBinding.regimeEvidenceDigest,
    }));
  }

  if (structuralBlockers.length > 0) return blocked(structuralBlockers);
  if (assignments.length !== dataset.observations.length) return blocked(['SPLIT_ASSIGNMENT_INCOMPLETE']);

  const counts = { train: 0, validation: 0, oos: 0 };
  for (const assignment of assignments) counts[assignment.split.toLowerCase()] += 1;
  const scopeCounts = [];
  const sampleDeficits = minimumDeficits(counts, policy.overallMinimums, 'OVERALL');
  for (const [key, minimum] of policyByScope) {
    const scoped = assignments.filter((assignment) => assignment.scopeKey === key);
    const scopedCounts = { train: 0, validation: 0, oos: 0 };
    for (const assignment of scoped) scopedCounts[assignment.split.toLowerCase()] += 1;
    minimumDeficits(scopedCounts, minimum.minimums, key).forEach((item) => sampleDeficits.push(item));
    scopeCounts.push(Object.freeze({
      scopeKey: key,
      market: minimum.market,
      symbol: minimum.symbol,
      aggressiveSide: minimum.aggressiveSide,
      quantityNotionalBucketIdentity: minimum.quantityNotionalBucketIdentity,
      volatilityRegimeIdentity: minimum.volatilityRegimeIdentity,
      liquidityRegimeIdentity: minimum.liquidityRegimeIdentity,
      counts: Object.freeze(scopedCounts),
      required: Object.freeze({ ...minimum.minimums }),
    }));
  }

  const assignmentDigest = sha256(assignments);
  const auditBody = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_VERSION,
    datasetContract: dataset.contract,
    datasetStoreContract: dataset.storeContract,
    datasetDigest: dataset.datasetDigest,
    collectorCodeSha: dataset.collectorCodeSha,
    sampleClass: dataset.sampleClass,
    splitPolicyIdentity: policy.policyIdentity,
    splitPolicyVersion: policy.policyVersion,
    splitPolicyDigest: policy.policyDigest,
    splitPolicyFrozenAtMs: policy.policyFrozenAtMs,
    scopeOwnerIdentity: policy.expectedScopeOwnerIdentity,
    scopePolicyIdentity: policy.expectedScopePolicyIdentity,
    scopePolicyDigest: policy.expectedScopePolicyDigest,
    regimeOwnerIdentity: policy.expectedRegimeOwnerIdentity,
    regimePolicyIdentity: policy.expectedRegimePolicyIdentity,
    regimePolicyDigest: policy.expectedRegimePolicyDigest,
    totalObservationCount: dataset.observations.length,
    counts: Object.freeze(counts),
    assignments: Object.freeze(assignments),
    assignmentDigest,
    scopeCounts: Object.freeze(scopeCounts),
    sampleDeficits: Object.freeze(sampleDeficits),
    regimeScopeComplete: true,
    splitAssignmentComplete: true,
    calibrationSampleSufficient: sampleDeficits.length === 0,
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
  };
  const audit = Object.freeze({ ...auditBody, auditDigest: sha256(auditBody) });
  if (sampleDeficits.length > 0) return blocked(['CALIBRATION_SAMPLE_INSUFFICIENT'], audit);
  return Object.freeze({
    status: 'PRESENT',
    blockers: Object.freeze([]),
    audit,
    safety: PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_SAFETY,
  });
}

export const PUBLIC_FORWARD_LIQUIDITY_SPLITS = SPLITS;

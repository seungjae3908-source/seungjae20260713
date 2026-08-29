import { createHash } from 'node:crypto';

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
} from './public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_INDEPENDENT_SPLIT_SOURCE_VERSION,
} from './public-forward-liquidity-independence-audit.mjs';
import {
  computePublicForwardLiquiditySplitPolicyDigest,
} from './public-forward-liquidity-calibration-split-audit.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_AUDIT_VERSION =
  'public-forward-liquidity-calibration-multi-source-split-audit-v2';

export const PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_SAFETY = Object.freeze({
  independentSplitSourceRequired: true,
  upstreamSourceLineageRequired: true,
  syntheticAggregateDatasetAllowed: false,
  syntheticSingleCollectorAllowed: false,
  externalScopeEvidenceRequired: true,
  externalRegimeEvidenceRequired: true,
  defaultSampleThresholdAllowed: false,
  randomSplitAllowed: false,
  chronologicalSplitRequired: true,
  splitPolicyFrozenBeforeValidationRequired: true,
  oosOutcomeEvaluationAllowed: false,
  calibrationArtifactProduced: false,
  liquidityImpactProduced: false,
  evidenceCompleteCredit: 0,
  naturalEntryCredit: 0,
  runtimeCostCredit: 0,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
  fullCostReady: false,
});

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const SPLITS = Object.freeze(['TRAIN', 'VALIDATION', 'OOS']);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 && normalized.length <= 320 ? normalized : null;
}

function exactDigest(value) {
  const normalized = text(value)?.replace(/^sha256:/u, '').toLowerCase() ?? null;
  return normalized && SHA256.test(normalized) ? normalized : null;
}

function exactCommitSha(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && COMMIT_SHA.test(normalized) ? normalized : null;
}

function positiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
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

function add(list, code) {
  if (!list.includes(code)) list.push(code);
}

function blocked(blockers, audit = null) {
  return Object.freeze({
    status: 'BLOCKED_DATA',
    blockers: Object.freeze([...new Set(blockers)]),
    audit,
    safety: PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_SAFETY,
  });
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
    return;
  }
  for (const split of ['train', 'validation', 'oos']) {
    if (!positiveInteger(minimums[split])) add(blockers, `${prefix}_${split.toUpperCase()}_MINIMUM_INVALID`);
  }
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
  if (!exactDigest(policy.policyDigest)) add(blockers, 'SPLIT_POLICY_DIGEST_INVALID');
  else if (policy.policyDigest !== computePublicForwardLiquiditySplitPolicyDigest(policy)) {
    add(blockers, 'SPLIT_POLICY_DIGEST_MISMATCH');
  }
  if (!positiveFinite(policy.policyFrozenAtMs)) add(blockers, 'SPLIT_POLICY_FROZEN_AT_INVALID');
  if (!text(policy.expectedScopeOwnerIdentity)) add(blockers, 'SCOPE_OWNER_IDENTITY_INVALID');
  if (!text(policy.expectedScopePolicyIdentity)) add(blockers, 'SCOPE_POLICY_IDENTITY_INVALID');
  if (!exactDigest(policy.expectedScopePolicyDigest)) add(blockers, 'SCOPE_POLICY_DIGEST_INVALID');
  if (!text(policy.expectedRegimeOwnerIdentity)) add(blockers, 'REGIME_OWNER_IDENTITY_INVALID');
  if (!text(policy.expectedRegimePolicyIdentity)) add(blockers, 'REGIME_POLICY_IDENTITY_INVALID');
  if (!exactDigest(policy.expectedRegimePolicyDigest)) add(blockers, 'REGIME_POLICY_DIGEST_INVALID');
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

function validateSource(source) {
  const blockers = [];
  if (!object(source)) return ['UPSTREAM_SOURCE_INVALID'];
  if (!text(source.sourceIdentity)) add(blockers, 'UPSTREAM_SOURCE_IDENTITY_INVALID');
  if (!exactCommitSha(source.producerCodeSha)) add(blockers, 'UPSTREAM_PRODUCER_SHA_INVALID');
  if (!exactCommitSha(source.collectorCodeSha)) add(blockers, 'UPSTREAM_COLLECTOR_SHA_INVALID');
  if (!text(source.collectorImplementationPath)) add(blockers, 'UPSTREAM_COLLECTOR_PATH_INVALID');
  if (!exactCommitSha(source.collectorImplementationBlobSha)) add(blockers, 'UPSTREAM_COLLECTOR_BLOB_INVALID');
  if (!exactDigest(source.datasetDigest)) add(blockers, 'UPSTREAM_DATASET_DIGEST_INVALID');
  if (!text(source.datasetRelativePath)) add(blockers, 'UPSTREAM_DATASET_PATH_INVALID');
  if (!exactDigest(source.receiptDigest)) add(blockers, 'UPSTREAM_RECEIPT_DIGEST_INVALID');
  if (!text(source.artifactId)) add(blockers, 'UPSTREAM_ARTIFACT_ID_INVALID');
  if (!exactDigest(source.artifactDigest)) add(blockers, 'UPSTREAM_ARTIFACT_DIGEST_INVALID');
  if (!exactDigest(source.rawBatchDigest)) add(blockers, 'UPSTREAM_RAW_BATCH_DIGEST_INVALID');
  return blockers;
}

function validateSplitSource(splitSource) {
  const blockers = [];
  if (!object(splitSource)) return ['INDEPENDENT_SPLIT_SOURCE_REQUIRED'];
  if (splitSource.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_INDEPENDENT_SPLIT_SOURCE_VERSION) {
    add(blockers, 'INDEPENDENT_SPLIT_SOURCE_VERSION_INVALID');
  }
  if (splitSource.kind !== 'public-forward-liquidity-independent-split-source') {
    add(blockers, 'INDEPENDENT_SPLIT_SOURCE_KIND_INVALID');
  }
  if (!exactCommitSha(splitSource.producerCodeSha)) add(blockers, 'INDEPENDENT_SPLIT_PRODUCER_SHA_INVALID');
  if (!exactDigest(splitSource.independenceAuditDigest)) add(blockers, 'INDEPENDENCE_AUDIT_DIGEST_INVALID');
  if (!exactDigest(splitSource.splitSourceDigest)) add(blockers, 'INDEPENDENT_SPLIT_SOURCE_DIGEST_INVALID');
  else if (splitSource.splitSourceDigest !== sha256(withoutKey(splitSource, 'splitSourceDigest'))) {
    add(blockers, 'INDEPENDENT_SPLIT_SOURCE_DIGEST_MISMATCH');
  }
  if (!Array.isArray(splitSource.upstreamSources) || splitSource.upstreamSources.length === 0) {
    add(blockers, 'UPSTREAM_SOURCES_REQUIRED');
  } else {
    const keys = ['sourceIdentity', 'datasetDigest', 'receiptDigest', 'artifactId'];
    for (const source of splitSource.upstreamSources) {
      validateSource(source).forEach((code) => add(blockers, code));
    }
    for (const key of keys) {
      const values = splitSource.upstreamSources.map((source) => source?.[key]);
      if (new Set(values).size !== values.length) add(blockers, `UPSTREAM_SOURCE_DUPLICATE:${key}`);
    }
  }
  if (!Array.isArray(splitSource.observations) || splitSource.observations.length === 0) {
    add(blockers, 'INDEPENDENT_OBSERVATIONS_REQUIRED');
  }
  if (splitSource.splitAssignmentPerformed !== false) add(blockers, 'UPSTREAM_SPLIT_ALREADY_ASSIGNED');
  if (splitSource.oosValidationComplete !== false) add(blockers, 'UPSTREAM_OOS_STATE_INVALID');
  if (splitSource.calibrationArtifactProduced !== false) add(blockers, 'UPSTREAM_ARTIFACT_STATE_INVALID');
  if (splitSource.liquidityImpactStatus !== 'BLOCKED_DATA' || splitSource.fullCostReady !== false) {
    add(blockers, 'UPSTREAM_FULL_COST_BOUNDARY_INVALID');
  }
  if (splitSource.evidenceCompleteCredit !== 0 || splitSource.executionAuthority !== 'NONE'
    || splitSource.privateApiUsed !== false || splitSource.liveTrading !== false
    || splitSource.orderSubmitted !== false) {
    add(blockers, 'UPSTREAM_EXECUTION_BOUNDARY_INVALID');
  }
  return blockers;
}

function resolveBinding(map, entry) {
  return map.get(entry.observationId) ?? map.get(entry.sourceObservationId) ?? null;
}

function validateScopeBinding(binding, entry, observation, policy) {
  const blockers = [];
  if (!object(binding)) return ['SCOPE_BINDING_MISSING'];
  if (![entry.observationId, entry.sourceObservationId].includes(binding.observationId)) {
    add(blockers, 'SCOPE_BINDING_OBSERVATION_ID_MISMATCH');
  }
  if (binding.sourceObservationId !== undefined && binding.sourceObservationId !== entry.sourceObservationId) {
    add(blockers, 'SCOPE_BINDING_SOURCE_OBSERVATION_ID_MISMATCH');
  }
  if (binding.sourceIdentity !== undefined && binding.sourceIdentity !== entry.sourceIdentity) {
    add(blockers, 'SCOPE_BINDING_SOURCE_IDENTITY_MISMATCH');
  }
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
  if (!exactDigest(binding.scopeEvidenceDigest)) add(blockers, 'SCOPE_EVIDENCE_DIGEST_INVALID');
  if (!positiveFinite(binding.scopePolicyFrozenAtMs)
    || binding.scopePolicyFrozenAtMs > observation.eventTimestampMs) {
    add(blockers, 'SCOPE_POLICY_NOT_FROZEN_BEFORE_EVENT');
  }
  return blockers;
}

function validateRegimeBinding(binding, entry, observation, policy) {
  const blockers = [];
  if (!object(binding)) return ['REGIME_BINDING_MISSING'];
  if (![entry.observationId, entry.sourceObservationId].includes(binding.observationId)) {
    add(blockers, 'REGIME_BINDING_OBSERVATION_ID_MISMATCH');
  }
  if (binding.sourceObservationId !== undefined && binding.sourceObservationId !== entry.sourceObservationId) {
    add(blockers, 'REGIME_BINDING_SOURCE_OBSERVATION_ID_MISMATCH');
  }
  if (binding.sourceIdentity !== undefined && binding.sourceIdentity !== entry.sourceIdentity) {
    add(blockers, 'REGIME_BINDING_SOURCE_IDENTITY_MISMATCH');
  }
  if (binding.sourceDigest !== observation.sourceDigest) add(blockers, 'REGIME_BINDING_SOURCE_DIGEST_MISMATCH');
  if (binding.market !== observation.market) add(blockers, 'REGIME_BINDING_MARKET_MISMATCH');
  if (binding.symbol !== observation.symbol) add(blockers, 'REGIME_BINDING_SYMBOL_MISMATCH');
  if (binding.aggressiveSide !== observation.aggressiveSide) add(blockers, 'REGIME_BINDING_SIDE_MISMATCH');
  if (binding.regimeOwnerIdentity !== policy.expectedRegimeOwnerIdentity) add(blockers, 'REGIME_OWNER_IDENTITY_MISMATCH');
  if (binding.regimePolicyIdentity !== policy.expectedRegimePolicyIdentity) add(blockers, 'REGIME_POLICY_IDENTITY_MISMATCH');
  if (binding.regimePolicyDigest !== policy.expectedRegimePolicyDigest) add(blockers, 'REGIME_POLICY_DIGEST_MISMATCH');
  if (!text(binding.regimeEvidenceIdentity)) add(blockers, 'REGIME_EVIDENCE_IDENTITY_INVALID');
  if (!exactDigest(binding.regimeEvidenceDigest)) add(blockers, 'REGIME_EVIDENCE_DIGEST_INVALID');
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

function minimumDeficits(counts, required, prefix) {
  const deficits = [];
  for (const split of ['train', 'validation', 'oos']) {
    if (counts[split] < required[split]) deficits.push(`${prefix}:${split.toUpperCase()}:${counts[split]}<${required[split]}`);
  }
  return deficits;
}

export function auditPublicForwardLiquidityIndependentSplits({
  splitSource,
  scopeBindings = [],
  regimeBindings = [],
  policy,
} = {}) {
  const sourceBlockers = validateSplitSource(splitSource);
  if (sourceBlockers.length > 0) return blocked(sourceBlockers);
  const policyBlockers = validatePolicy(policy);
  if (policyBlockers.length > 0) return blocked(policyBlockers);

  const sourceByIdentity = new Map(splitSource.upstreamSources.map((source) => [source.sourceIdentity, source]));
  const entryIds = new Set();
  const sourceObservationIds = new Set();
  const eventIds = new Set();
  const scopeMap = new Map();
  const regimeMap = new Map();
  const structuralBlockers = [];

  for (const binding of scopeBindings) {
    if (!text(binding?.observationId)) {
      add(structuralBlockers, 'SCOPE_BINDING_OBSERVATION_ID_INVALID');
      continue;
    }
    if (scopeMap.has(binding.observationId)) add(structuralBlockers, 'SCOPE_BINDING_DUPLICATE_OBSERVATION_ID');
    scopeMap.set(binding.observationId, binding);
  }
  for (const binding of regimeBindings) {
    if (!text(binding?.observationId)) {
      add(structuralBlockers, 'REGIME_BINDING_OBSERVATION_ID_INVALID');
      continue;
    }
    if (regimeMap.has(binding.observationId)) add(structuralBlockers, 'REGIME_BINDING_DUPLICATE_OBSERVATION_ID');
    regimeMap.set(binding.observationId, binding);
  }

  const policyByScope = new Map(policy.scopeMinimums.map((minimum) => [scopeKey(minimum), minimum]));
  const assignments = [];
  const usedScopeEvidenceIds = new Set();
  const usedScopeEvidenceDigests = new Set();
  const usedRegimeEvidenceIds = new Set();
  const usedRegimeEvidenceDigests = new Set();
  const usedPublicExecutionIds = new Set();
  const usedSourceDigests = new Set();

  const orderedEntries = [...splitSource.observations].sort((left, right) => {
    const leftTs = Number(left?.observation?.eventTimestampMs ?? 0);
    const rightTs = Number(right?.observation?.eventTimestampMs ?? 0);
    return leftTs - rightTs || String(left?.observationId ?? '').localeCompare(String(right?.observationId ?? ''));
  });

  for (const entry of orderedEntries) {
    if (!object(entry) || !object(entry.observation)) {
      add(structuralBlockers, 'INDEPENDENT_ENTRY_INVALID');
      continue;
    }
    const observation = entry.observation;
    const upstream = sourceByIdentity.get(entry.sourceIdentity);
    if (!upstream) add(structuralBlockers, 'INDEPENDENT_ENTRY_SOURCE_ORPHAN');
    if (!text(entry.observationId) || entryIds.has(entry.observationId)) add(structuralBlockers, 'INDEPENDENT_ENTRY_ID_DUPLICATE_OR_INVALID');
    entryIds.add(entry.observationId);
    if (!text(entry.sourceObservationId) || sourceObservationIds.has(entry.sourceObservationId)) {
      add(structuralBlockers, 'SOURCE_OBSERVATION_ID_DUPLICATE_OR_INVALID');
    }
    sourceObservationIds.add(entry.sourceObservationId);
    if (!text(entry.eventIdentity) || eventIds.has(entry.eventIdentity)) add(structuralBlockers, 'PUBLIC_EVENT_DUPLICATE_AFTER_INDEPENDENCE');
    eventIds.add(entry.eventIdentity);
    if (!text(entry.sourceFrameIdentity)) add(structuralBlockers, 'SOURCE_FRAME_IDENTITY_INVALID');
    if (observation.observationId !== entry.sourceObservationId) add(structuralBlockers, 'SOURCE_OBSERVATION_ID_MISMATCH');
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
    if (upstream && observation.collectorCodeSha !== upstream.collectorCodeSha) {
      add(structuralBlockers, 'OBSERVATION_COLLECTOR_LINEAGE_MISMATCH');
    }
    const publicExecutionId = text(observation.rawSourceProvenance?.publicTrade?.publicExecutionId);
    if (!publicExecutionId) add(structuralBlockers, 'PUBLIC_EXECUTION_ID_INVALID');
    else if (usedPublicExecutionIds.has(publicExecutionId)) add(structuralBlockers, 'PUBLIC_EXECUTION_ID_DUPLICATE');
    usedPublicExecutionIds.add(publicExecutionId);
    if (!exactDigest(observation.sourceDigest)) add(structuralBlockers, 'OBSERVATION_SOURCE_DIGEST_INVALID');
    else if (usedSourceDigests.has(observation.sourceDigest)) add(structuralBlockers, 'OBSERVATION_SOURCE_DIGEST_DUPLICATE');
    usedSourceDigests.add(observation.sourceDigest);
    if (!positiveFinite(observation.eventTimestampMs)) add(structuralBlockers, 'OBSERVATION_EVENT_TIMESTAMP_INVALID');

    const split = positiveFinite(observation.eventTimestampMs)
      ? splitForTimestamp(observation.eventTimestampMs, policy.windows)
      : null;
    if (!split) {
      add(structuralBlockers, 'OBSERVATION_OUTSIDE_FROZEN_SPLIT_WINDOWS');
      continue;
    }
    const scopeBinding = resolveBinding(scopeMap, entry);
    const regimeBinding = resolveBinding(regimeMap, entry);
    validateScopeBinding(scopeBinding, entry, observation, policy).forEach((code) => add(structuralBlockers, code));
    validateRegimeBinding(regimeBinding, entry, observation, policy).forEach((code) => add(structuralBlockers, code));
    if (!object(scopeBinding) || !object(regimeBinding)) continue;

    for (const [identity, digestValue, duplicateIdentityCode, duplicateDigestCode] of [
      [scopeBinding.scopeEvidenceIdentity, scopeBinding.scopeEvidenceDigest, 'SCOPE_EVIDENCE_ID_DUPLICATE', 'SCOPE_EVIDENCE_DIGEST_DUPLICATE'],
      [regimeBinding.regimeEvidenceIdentity, regimeBinding.regimeEvidenceDigest, 'REGIME_EVIDENCE_ID_DUPLICATE', 'REGIME_EVIDENCE_DIGEST_DUPLICATE'],
    ]) {
      if (identity === scopeBinding.scopeEvidenceIdentity) {
        if (usedScopeEvidenceIds.has(identity)) add(structuralBlockers, duplicateIdentityCode);
        if (usedScopeEvidenceDigests.has(digestValue)) add(structuralBlockers, duplicateDigestCode);
        usedScopeEvidenceIds.add(identity);
        usedScopeEvidenceDigests.add(digestValue);
      } else {
        if (usedRegimeEvidenceIds.has(identity)) add(structuralBlockers, duplicateIdentityCode);
        if (usedRegimeEvidenceDigests.has(digestValue)) add(structuralBlockers, duplicateDigestCode);
        usedRegimeEvidenceIds.add(identity);
        usedRegimeEvidenceDigests.add(digestValue);
      }
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
      observationId: entry.observationId,
      sourceObservationId: entry.sourceObservationId,
      sourceIdentity: entry.sourceIdentity,
      sourceDatasetDigest: upstream?.datasetDigest ?? null,
      sourceReceiptDigest: upstream?.receiptDigest ?? null,
      sourceCollectorCodeSha: upstream?.collectorCodeSha ?? null,
      sourceDigest: observation.sourceDigest,
      eventIdentity: entry.eventIdentity,
      sourceFrameIdentity: entry.sourceFrameIdentity,
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
  if (assignments.length !== orderedEntries.length) return blocked(['SPLIT_ASSIGNMENT_INCOMPLETE']);

  const counts = { train: 0, validation: 0, oos: 0 };
  for (const assignment of assignments) counts[assignment.split.toLowerCase()] += 1;
  const sampleDeficits = minimumDeficits(counts, policy.overallMinimums, 'OVERALL');
  const scopeCounts = [];
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

  const upstreamSources = Object.freeze([...splitSource.upstreamSources]
    .sort((left, right) => left.sourceIdentity.localeCompare(right.sourceIdentity)));
  const upstreamLineageDigest = sha256(upstreamSources);
  const collectorCodeShas = Object.freeze([...new Set(upstreamSources.map((source) => source.collectorCodeSha))].sort());
  const datasetDigests = Object.freeze(upstreamSources.map((source) => source.datasetDigest));
  const receiptDigests = Object.freeze(upstreamSources.map((source) => source.receiptDigest));
  const assignmentDigest = sha256(assignments);
  const auditBody = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_AUDIT_VERSION,
    independentSplitSourceVersion: splitSource.schemaVersion,
    independentSplitSourceDigest: splitSource.splitSourceDigest,
    independenceAuditDigest: splitSource.independenceAuditDigest,
    producerCodeSha: splitSource.producerCodeSha,
    datasetContract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    datasetStoreContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    upstreamSources,
    upstreamLineageDigest,
    datasetDigests,
    receiptDigests,
    collectorCodeShas,
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
    totalObservationCount: assignments.length,
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
    evidenceCompleteCredit: 0,
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
    safety: PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_SAFETY,
  });
}

export const PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLITS = SPLITS;
